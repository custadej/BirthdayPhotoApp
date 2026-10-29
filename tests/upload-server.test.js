'use strict';

/** Server side of weak-connection uploads: single-file upload, async/lazy thumbnails, upload.log. */

const { spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { randomUUID } = require('crypto');
const sharp = require('sharp');

const PORT = parseInt(process.env.SMOKE_PORT || '19977') + 7;
const BASE = `http://localhost:${PORT}`;
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function assert(c, label) {
  if (c) { console.log(`  PASS  ${label}`); pass++; } else { console.error(`  FAIL  ${label}`); fail++; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(100); }
  return false;
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpaupl-'));
  const server = spawn('node', [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), ADMIN_KEY: 'upladmin', ALBUM_CODE: 'kodaza', DATA_DIR: dataDir, PHOTO_LIMIT: '10', PUBLIC_URL: 'https://example.test' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/config'); break; } catch { await sleep(200); } }

    const big = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: '#4a7' } }).jpeg().toBuffer();
    const login = await (await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Ana Novak' }) })).json();
    const H = { 'X-Guest-Token': login.token };
    const gid = login.guest.id;
    const send = async (fields, files) => {
      const fd = new FormData();
      for (const [k, v] of Object.entries(files)) fd.append(k, new Blob([v], { type: 'image/jpeg' }), k + '.jpg');
      for (const [k, v] of Object.entries(fields)) fd.append(k, v);
      return fetch(`${BASE}/api/upload`, { method: 'POST', headers: H, body: fd });
    };
    const album = { headers: { Cookie: '' } };
    await fetch(`${BASE}/api/admin/album/toggle`, { method: 'POST', headers: { 'X-Admin-Key': 'upladmin' } });

    // ── single-file upload ──────────────────────────────────────────────────
    console.log('── Single-file upload ──');
    const cid = randomUUID();
    const r = await send({ clientId: cid }, { photo: big });
    const j = await r.json();
    assert(r.status === 200 && j.ok && j.photoId, 'upload without thumb is accepted');
    const files = id => ({
      thumb: path.join(dataDir, 'photos', gid, `${id}_thumb.jpg`),
      full:  path.join(dataDir, 'photos', gid, `${id}.jpg`),
      medium: path.join(dataDir, 'medium', `${id}.jpg`),
    });
    let f = files(j.photoId);
    assert(fs.existsSync(f.full), 'main file stored');
    assert(await until(() => fs.existsSync(f.thumb) && fs.existsSync(f.medium)), 'thumb and medium are generated after the response');
    const tm = await sharp(f.thumb).metadata(), mm = await sharp(f.medium).metadata();
    assert(tm.width === 900 && tm.height === 600, `thumb is 900px (${tm.width}x${tm.height})`);
    assert(mm.width === 1280 && mm.height === 853, `medium is 1280px (${mm.width}x${mm.height})`);

    const miss = await send({ clientId: randomUUID() }, {});
    assert(miss.status === 400, 'upload without photo is still rejected');

    const albumCk = (await fetch(`${BASE}/api/album-session`, { method: 'POST', headers: H })).headers.get('set-cookie');
    album.headers.Cookie = (albumCk || '').split(';')[0];

    // ── lazy generation ─────────────────────────────────────────────────────
    console.log('\n── On-demand generation ──');
    fs.unlinkSync(f.thumb); fs.unlinkSync(f.medium);
    let g = await fetch(`${BASE}/thumb/${j.photoId}`, { headers: H });
    let gm = await sharp(Buffer.from(await g.arrayBuffer())).metadata();
    assert(g.status === 200 && gm.width === 900, '/thumb/:id regenerates a missing thumb');
    assert(fs.existsSync(f.thumb), 'regenerated thumb is stored');
    fs.unlinkSync(f.thumb);
    g = await fetch(`${BASE}/album/thumb/${j.photoId}`, album);
    gm = await sharp(Buffer.from(await g.arrayBuffer())).metadata();
    assert(g.status === 200 && gm.width === 900, '/album/thumb/:id generates on demand');
    g = await fetch(`${BASE}/album/medium/${j.photoId}`, album);
    gm = await sharp(Buffer.from(await g.arrayBuffer())).metadata();
    assert(g.status === 200 && gm.width === 1280, '/album/medium/:id generates on demand');
    const burst = await Promise.all(Array.from({ length: 6 }, () => { try { fs.unlinkSync(f.thumb); } catch {} return fetch(`${BASE}/thumb/${j.photoId}`, { headers: H }); }));
    assert(burst.every(x => x.status === 200), 'parallel requests for a missing thumb all succeed');
    assert((await fetch(`${BASE}/thumb/${j.photoId}`)).status === 403, '/thumb/:id still needs access');

    // ── old clients ─────────────────────────────────────────────────────────
    console.log('\n── Old client (sends a thumb) ──');
    const oldThumb = await sharp(big).resize(100).jpeg().toBuffer();
    const o = await (await send({ clientId: randomUUID() }, { photo: big, thumb: oldThumb })).json();
    const of = files(o.photoId);
    assert(o.ok && fs.readFileSync(of.thumb).equals(oldThumb), 'client thumb is stored and kept');

    // ── undecodable image: still served ─────────────────────────────────────
    const fake = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9]);
    const fk = await (await send({ clientId: randomUUID() }, { photo: fake })).json();
    const fg = await fetch(`${BASE}/thumb/${fk.photoId}`, { headers: H });
    assert(fk.ok && fg.status === 200, 'photo that sharp cannot decode: upload ok, /thumb falls back to the original');

    // ── upload.log ──────────────────────────────────────────────────────────
    console.log('\n── upload.log ──');
    await sleep(300);
    const lines = fs.readFileSync(path.join(dataDir, 'upload.log'), 'utf8').trim().split('\n').map(JSON.parse);
    const first = lines[0];
    assert(lines.length >= 3 && first.guestId === gid && first.bytes === big.length && Number.isFinite(first.ms) && first.ms >= 0 && !isNaN(Date.parse(first.time)),
      'successful uploads are logged (time, guest, bytes, ms)');
    await send({ clientId: cid }, { photo: big });
    await sleep(200);
    const again = fs.readFileSync(path.join(dataDir, 'upload.log'), 'utf8').trim().split('\n').map(JSON.parse).pop();
    assert(again.duplicate === true, 'repeat of a stored clientId is logged as duplicate');
    const err = path.join(dataDir, 'upload-errors.log');
    const bad = await send({ clientId: randomUUID() }, { photo: Buffer.from('nope') });
    await sleep(300);
    assert(bad.status === 400 && fs.readFileSync(err, 'utf8').includes('"status":400'), 'failures still go to upload-errors.log');

    // ── slow uploads are not killed ─────────────────────────────────────────
    console.log('\n── Slow upload / limits ──');
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert(/requestTimeout\s*=\s*5 \* 60 \* 1000/.test(src) && /headersTimeout/.test(src) && /server\.timeout\s*=\s*0/.test(src), 'server timeouts are generous (5 min request, no socket timeout)');
    assert(/express\.json\(\{ limit: '12mb' \}\)/.test(src), 'body parsers accept 12 MB');
    const v = await (await fetch(`${BASE}/api/version`)).json();
    assert(v.version === 'v17', 'APP_VERSION is v17');
    // dribble a multipart body in over ~2.5 s and make sure it still lands
    const boundary = '----slow' + Date.now();
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="clientId"\r\n\r\n${randomUUID()}\r\n--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="p.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, big, tail]);
    const http = require('http');
    const slow = await new Promise((resolve, reject) => {
      const req = http.request({ port: PORT, method: 'POST', path: '/api/upload', headers: { ...H, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length } }, res => {
        let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, data: d }));
      });
      req.on('error', reject);
      const chunk = Math.ceil(body.length / 5);
      (async () => { for (let i = 0; i < body.length; i += chunk) { req.write(body.subarray(i, i + chunk)); await sleep(500); } req.end(); })();
    });
    assert(slow.status === 200 && JSON.parse(slow.data).ok, 'a slowly dribbled upload completes');
    await sleep(300);
    const last = fs.readFileSync(path.join(dataDir, 'upload.log'), 'utf8').trim().split('\n').map(JSON.parse).pop();
    assert(last.ms >= 1500, `upload.log ms covers the slow receive (${last.ms} ms)`);

    // ── client wiring ───────────────────────────────────────────────────────
    console.log('\n── Client wiring ──');
    const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    const html = await (await fetch(BASE + '/')).text();
    assert(!/append\('thumb'/.test(app), 'client no longer sends a thumbnail');
    assert(/XMLHttpRequest/.test(app) && /upload\.onprogress/.test(app), 'client uploads with XMLHttpRequest progress');
    assert(!/AbortController|ATTEMPT_TIMEOUT/.test(app), 'no total upload timeout in the client');
    assert(/createImageBitmap/.test(app) && /resizeQuality: 'medium'/.test(app), 'client resizes with createImageBitmap when available');
    assert(/Slike se še pošiljajo\. Ne zapri strani, počakaj, da se konča\./.test(html), 'yellow pending bar text is in the page');
    assert((await fetch(BASE + '/lib/upload-core.js')).status === 200 && html.includes('/lib/upload-core.js'), 'upload-core.js is served and loaded');
  } finally {
    server.kill();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
  console.log(`\nUpload server results: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
