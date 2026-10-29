'use strict';

/** Unit tests: upload sizing/retry logic, JPEG header parsing, thumbnail queue. */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const Core = require('../lib/upload-core');
const { createQueue, createThumbService } = require('../lib/thumbs');

let n = 0;
async function t(name, fn) { await fn(); n++; console.log(`  PASS  ${name}`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await t('fitSize: long edge max 1600, keeps aspect, never enlarges', () => {
    assert.deepStrictEqual(Core.fitSize(4000, 3000), { width: 1600, height: 1200 });
    assert.deepStrictEqual(Core.fitSize(3000, 4000), { width: 1200, height: 1600 });
    assert.deepStrictEqual(Core.fitSize(800, 600), { width: 800, height: 600 });
    assert.deepStrictEqual(Core.fitSize(1600, 1600), { width: 1600, height: 1600 });
  });

  await t('quality ladder: 0.8 first, then 0.7, 0.6, floor 0.5', async () => {
    assert.deepStrictEqual(Core.QUALITIES, [0.8, 0.7, 0.6, 0.5]);
    const tried = [];
    const small = await Core.encodeAdaptive(async q => { tried.push(q); return { size: 300 * 1024 }; });
    assert.deepStrictEqual(tried, [0.8]); assert.strictEqual(small.size, 300 * 1024);
    tried.length = 0;
    await Core.encodeAdaptive(async q => { tried.push(q); return { size: q > 0.75 ? 800 * 1024 : 300 * 1024 }; });
    assert.deepStrictEqual(tried, [0.8, 0.7]);
    tried.length = 0;
    const last = await Core.encodeAdaptive(async q => { tried.push(q); return { size: 2000 * 1024, q }; });
    assert.deepStrictEqual(tried, [0.8, 0.7, 0.6, 0.5]); assert.strictEqual(last.q, 0.5);
  });

  await t('backoff: 2, 4, 8, 15, 30 s, then every 30 s', () => {
    assert.deepStrictEqual([1, 2, 3, 4, 5, 6, 7, 20].map(Core.backoffDelay), [2000, 4000, 8000, 15000, 30000, 30000, 30000, 30000]);
    assert.strictEqual(Core.ERROR_ROUNDS, 6);
  });

  await t('stall: only after 30 s without progress; no total timeout', () => {
    assert.strictEqual(Core.isStalled(1000, 1000 + 29000), false);
    assert.strictEqual(Core.isStalled(1000, 1000 + 31000), true);
    assert.strictEqual(Core.isStalled(Date.now(), Date.now() + 10 * 60 * 1000 - 1000, 30000), true);
  });

  await t('permanent statuses: 4xx except 408/429', () => {
    for (const s of [400, 401, 403, 413]) assert.strictEqual(Core.isPermanentStatus(s), true);
    for (const s of [408, 429, 500, 502, 504, 0, undefined]) assert.strictEqual(Core.isPermanentStatus(s), false);
  });

  await t('counter = server remaining minus pending, never negative', () => {
    assert.strictEqual(Core.effectiveRemaining(5, 2), 3);
    assert.strictEqual(Core.effectiveRemaining(2, 2), 0);
    assert.strictEqual(Core.effectiveRemaining(1, 3), 0);
  });

  await t('progress text', () => {
    assert.strictEqual(Core.progressText(43), 'Pošiljam… 43 %');
    assert.strictEqual(Core.progressText(43, 12), 'Pošiljam… 43 % · še 12 s');
    assert.strictEqual(Core.progressText(100, 0), 'Končujem…');
    assert.strictEqual(Core.etaText(75), 'še 1 min 15 s');
    // 100 KB of 400 KB in 5 s -> 20 KB/s -> 15 s left
    assert.strictEqual(Core.etaSeconds(100 * 1024, 400 * 1024, 5000), 15);
    assert.strictEqual(Core.etaSeconds(0, 400, 5000), null);
    assert.strictEqual(Core.etaSeconds(100, 400, 100), null);
    assert.strictEqual(Core.etaSeconds(399, 400, 10000), 1);
    assert.strictEqual(Core.percent(43, 100), 43);
    assert.strictEqual(Core.percent(5, 0), 0);
    assert.strictEqual(Core.percent(300, 100), 100);
  });

  await t('parseJpegInfo: size and EXIF orientation', async () => {
    const plain = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#789' } }).jpeg().toBuffer();
    assert.deepStrictEqual(Core.parseJpegInfo(new Uint8Array(plain)), { width: 640, height: 480, orientation: 1 });
    const rotated = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#789' } })
      .jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const info = Core.parseJpegInfo(new Uint8Array(rotated));
    assert.strictEqual(info.orientation, 6);
    assert.deepStrictEqual(Core.displaySize(info), { width: 480, height: 640 });
    assert.strictEqual(Core.parseJpegInfo(new Uint8Array([1, 2, 3, 4])), null);
    assert.strictEqual(Core.parseJpegInfo(new Uint8Array(plain.subarray(0, 12))), null);
  });

  await t('thumb queue: at most 2 jobs at once, the rest wait, priority jumps ahead', async () => {
    const q = createQueue(2);
    let running = 0, peak = 0;
    const order = [];
    const job = (id, ms = 30) => () => { running++; peak = Math.max(peak, running); order.push(id); return sleep(ms).then(() => { running--; }); };
    const all = [1, 2, 3, 4].map(i => q.run(job(i)));
    all.push(q.run(job('urgent'), { priority: true }));
    assert.strictEqual(q.active, 2); assert.strictEqual(q.waiting, 3);
    await Promise.all(all);
    assert.strictEqual(peak, 2);
    assert.deepStrictEqual(order.slice(0, 3), [1, 2, 'urgent']);
  });

  await t('thumb service: 900px thumb, 1280px medium, deduplicated, bad input rejects', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumbs-unit-'));
    try {
      const src = path.join(dir, 'a.jpg');
      await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#c90' } }).jpeg().toFile(src);
      const svc = createThumbService({ sharp, concurrency: 2 });
      const th = path.join(dir, 'a_thumb.jpg'), md = path.join(dir, 'm', 'a.jpg');
      const [p1, p2] = [svc.thumb(src, th), svc.thumb(src, th)];
      assert.strictEqual(p1, p2, 'same destination shares one job');
      await Promise.all([p1, svc.medium(src, md)]);
      assert.deepStrictEqual((({ width, height }) => ({ width, height }))(await sharp(th).metadata()), { width: 900, height: 600 });
      assert.deepStrictEqual((({ width, height }) => ({ width, height }))(await sharp(md).metadata()), { width: 1280, height: 853 });
      assert.deepStrictEqual(fs.readdirSync(dir).filter(f => f.endsWith('.tmp')), []);
      const bad = path.join(dir, 'bad.jpg'); fs.writeFileSync(bad, Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]));
      await assert.rejects(svc.thumb(bad, path.join(dir, 'bad_thumb.jpg')));
      assert.ok(!fs.existsSync(path.join(dir, 'bad_thumb.jpg')));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  console.log(`\nUpload core: ${n} passed`);
})().catch(e => { console.error('  FAIL ', e); process.exit(1); });
