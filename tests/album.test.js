'use strict';

/**
 * Integration test for captions, tasks, album access and cards.
 * Starts a real server on SMOKE_PORT+1 with a real (sharp-made) JPEG.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { randomUUID } = require('crypto');
const sharp = require('sharp');

const PORT = parseInt(process.env.SMOKE_PORT || '19977') + 1;
const BASE = `http://localhost:${PORT}`;
const ADMIN = 'albumadmin';
const CODE = 'tajnakoda';
const TASK = 'Slikaj torto ali sladico';

let pass = 0, fail = 0;
function assert(c, label) {
  if (c) { console.log(`  PASS  ${label}`); pass++; } else { console.error(`  FAIL  ${label}`); fail++; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function jpeg(w, h) {
  return sharp({ create: { width: w, height: h, channels: 3, background: '#88aacc' } }).jpeg().toBuffer();
}

function form(buf, clientId, extra = {}) {
  const fd = new FormData();
  fd.append('photo', new Blob([buf], { type: 'image/jpeg' }), 'photo.jpg');
  fd.append('thumb', new Blob([buf], { type: 'image/jpeg' }), 'thumb.jpg');
  fd.append('clientId', clientId);
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  return fd;
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpaalbum-'));
  const server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), ADMIN_KEY: ADMIN, ALBUM_CODE: CODE, DATA_DIR: dataDir, PHOTO_LIMIT: '5', PUBLIC_URL: 'https://example.test' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    for (let i = 0; i < 40; i++) { try { await fetch(`${BASE}/api/config`); break; } catch { await sleep(250); } }

    const adminH = { 'X-Admin-Key': ADMIN };
    const big = await jpeg(1200, 800);

    // login
    const login = await (await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Čaja Šmid' }) })).json();
    const gh = { 'X-Guest-Token': login.token };

    // ── uploads ────────────────────────────────────────────────────────────
    const longCaption = '  ' + 'ž'.repeat(200) + '  ';
    let r = await (await fetch(`${BASE}/api/upload`, { method: 'POST', headers: gh, body: form(big, randomUUID(), { caption: longCaption, taskText: TASK }) })).json();
    assert(r.ok && r.ordinal === 1, 'first upload has ordinal 1');
    assert(Array.from(r.caption).length === 140, 'caption trimmed to 140 chars');
    assert(r.taskText === TASK, 'known taskText stored');
    const id1 = r.photoId;

    r = await (await fetch(`${BASE}/api/upload`, { method: 'POST', headers: gh, body: form(big, randomUUID(), { caption: '<img src=x onerror=alert(1)>', taskText: 'izmišljena naloga' }) })).json();
    assert(r.ordinal === 2, 'second upload has ordinal 2');
    assert(r.taskText === null, 'unknown taskText is dropped');
    const id2 = r.photoId;

    r = await (await fetch(`${BASE}/api/upload`, { method: 'POST', headers: gh, body: form(big, randomUUID()) })).json();
    assert(r.caption === null && r.taskText === null && r.ordinal === 3, 'no caption/task -> null');
    const id3 = r.photoId;

    const me = await (await fetch(`${BASE}/api/me`, { headers: gh })).json();
    assert(me.items.length === 3 && me.items[0].ordinal === 1 && me.items[0].taskText === TASK, '/api/me returns items');

    const huge = form(Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF]), Buffer.alloc(13 * 1024 * 1024)]), randomUUID());
    const hr = await fetch(`${BASE}/api/upload`, { method: 'POST', headers: gh, body: huge });
    assert(hr.status === 413, 'upload over 12 MB is rejected with 413');
    const ok11 = form(Buffer.concat([big, Buffer.alloc(11 * 1024 * 1024)]), randomUUID());
    const hr2 = await fetch(`${BASE}/api/upload`, { method: 'POST', headers: gh, body: ok11 });
    assert(hr2.status === 200, 'upload of ~11 MB is accepted');

    // ── album access ───────────────────────────────────────────────────────
    let page = await fetch(`${BASE}/album`);
    assert((await page.text()).includes('Album je zaklenjen'), 'no cookie -> locked page');
    page = await fetch(`${BASE}/album?code=napacna`);
    assert(page.status === 403 && (await page.text()).includes('Album je zaklenjen'), 'wrong code -> locked page');

    const p401 = await fetch(`${BASE}/album/thumb/${id1}`);
    assert(p401.status === 401, 'album thumb without cookie -> 401');

    const ok = await fetch(`${BASE}/album?code=${CODE}`, { redirect: 'manual' });
    const sc = ok.headers.get('set-cookie') || '';
    assert(ok.status === 302 && ok.headers.get('location') === '/album', 'right code redirects to /album');
    assert(/album=/.test(sc) && /HttpOnly/i.test(sc) && /SameSite=Lax/i.test(sc) && /Max-Age=1209600/.test(sc), 'album cookie flags');
    const ck = { Cookie: sc.split(';')[0] };

    page = await fetch(`${BASE}/album`, { headers: ck });
    assert((await page.text()).includes('Album bo odprt jutri'), 'closed album shows tomorrow page');
    assert((await fetch(`${BASE}/album/photo/${id1}`, { headers: ck })).status === 403, 'closed album blocks photos');

    const state0 = await (await fetch(`${BASE}/api/admin/album`, { headers: adminH })).json();
    assert(state0.open === false && state0.link === `https://example.test/album?code=${CODE}`, 'admin album state default closed + link');
    page = await fetch(`${BASE}/album`, { headers: adminH });
    assert((await page.text()).includes('Spomini večera'), 'admin sees album while closed');
    assert((await fetch(`${BASE}/api/admin/album/toggle`, { method: 'POST' })).status === 403, 'toggle needs admin');
    const t1 = await (await fetch(`${BASE}/api/admin/album/toggle`, { method: 'POST', headers: adminH })).json();
    assert(t1.open === true, 'admin toggle opens album');

    page = await fetch(`${BASE}/album`, { headers: ck });
    const html = await page.text();
    assert(html.includes('Spomini večera'), 'open album shows page');
    assert(!html.includes('innerHTML'), 'album page never uses innerHTML');

    const list = await (await fetch(`${BASE}/api/album/photos`, { headers: ck })).json();
    assert(list.photos.length === 4, 'album lists all photos');
    assert(list.photos[3].label === 'ž'.repeat(140) + ' - Čaja Šmid', 'label uses caption + name');
    assert(list.photos[3].task === `Naloga: ${TASK}`, 'task line in album data');
    assert(list.photos[2].label === '<img src=x onerror=alert(1)> - Čaja Šmid', 'caption returned as plain data');
    assert(list.photos[1].label === 'Tretja slika - Čaja Šmid', 'ordinal label');
    assert(list.photos.every((p, i, a) => !i || a[i - 1].createdAt >= p.createdAt), 'album API: newest first');

    assert((await fetch(`${BASE}/album/photo/${id1}`, { headers: ck })).status === 200, 'album photo 200');
    assert((await fetch(`${BASE}/album/thumb/${id1}`, { headers: ck })).status === 200, 'album thumb 200');
    assert((await fetch(`${BASE}/photo/${id1}`, { headers: ck })).status === 403, 'guest-only /photo stays guest-only');

    // ── cards ──────────────────────────────────────────────────────────────
    const card = await fetch(`${BASE}/album/card/${id1}.jpg`, { headers: ck });
    const cardBuf = Buffer.from(await card.arrayBuffer());
    const meta = await sharp(cardBuf).metadata();
    assert(card.status === 200 && meta.format === 'jpeg', 'card is a JPEG');
    assert(meta.width === 2120 && meta.height > 1333 + 200, 'card is 2000px photo + margins, with caption area');
    assert(fs.existsSync(path.join(dataDir, 'cards', `${id1}.jpg`)), 'card cached in DATA_DIR/cards');
    const dl = await fetch(`${BASE}/album/card/${id2}.jpg?dl=1`, { headers: ck });
    assert(/attachment; filename="Caja_Smid_002\.jpg"; filename\*=UTF-8''%C4%8Caja_%C5%A0mid_002\.jpg/.test(dl.headers.get('content-disposition') || ''), 'card download filename (ASCII + UTF-8)');
    assert((await fetch(`${BASE}/album/card/${id1}.jpg`)).status === 401, 'card needs cookie');

    // ── zips ───────────────────────────────────────────────────────────────
    const zipAlbum = Buffer.from(await (await fetch(`${BASE}/album/zip`, { headers: { ...ck, ...adminH } })).arrayBuffer());
    assert(zipAlbum.includes('_001.jpg') && zipAlbum.includes('_003.jpg'), 'album zip has Name_001.jpg style entries');
    const zipAdmin = Buffer.from(await (await fetch(`${BASE}/api/admin/download-zip`, { headers: adminH })).arrayBuffer());
    assert(zipAdmin.includes('originali/') && zipAdmin.includes('z-opisi/'), 'admin zip has originali/ and z-opisi/');

    // ── admin ──────────────────────────────────────────────────────────────
    const admin = await (await fetch(`${BASE}/admin`, { headers: adminH })).text();
    assert(!admin.includes('innerHTML'), 'admin page never uses innerHTML');
    const gid = (await (await fetch(`${BASE}/api/admin/guests`, { headers: adminH })).json())[0].id;
    const aph = await (await fetch(`${BASE}/api/admin/guests/${gid}/photos`, { headers: adminH })).json();
    assert(aph[0].label.startsWith('ž') && aph[0].task === `Naloga: ${TASK}` && aph[2].label === 'Tretja slika - Čaja Šmid', 'admin photo list has label + task');

    // deleting removes cached card
    await fetch(`${BASE}/api/admin/photos/${id1}`, { method: 'DELETE', headers: adminH });
    assert(!fs.existsSync(path.join(dataDir, 'cards', `${id1}.jpg`)), 'deleting a photo removes its card');

    // closing again
    const t2 = await (await fetch(`${BASE}/api/admin/album/toggle`, { method: 'POST', headers: adminH })).json();
    assert(t2.open === false, 'toggle closes album again');
    void id3;
  } finally {
    server.kill();
  }
  console.log(`\nAlbum results: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
