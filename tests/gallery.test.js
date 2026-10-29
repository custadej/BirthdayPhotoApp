'use strict';

/** Album button after the first photo, first-photo caption, "Prenesi vse" switch, share-to-gallery code. */

const { spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { randomUUID } = require('crypto');
const sharp = require('sharp');

const PORT = parseInt(process.env.SMOKE_PORT || '19977') + 5;
const BASE = `http://localhost:${PORT}`;
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function assert(c, label) {
  if (c) { console.log(`  PASS  ${label}`); pass++; } else { console.error(`  FAIL  ${label}`); fail++; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ADMIN = { 'X-Admin-Key': 'galleryadmin' };
const get = (p, h = {}) => fetch(BASE + p, { redirect: 'manual', headers: h });
const post = (p, h = {}) => fetch(BASE + p, { method: 'POST', redirect: 'manual', headers: h });
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpagallery-'));
  const server = spawn('node', [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), ADMIN_KEY: 'galleryadmin', ALBUM_CODE: 'kodaza', DATA_DIR: dataDir, PHOTO_LIMIT: '15' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    for (let i = 0; i < 40; i++) { try { await get('/api/config'); break; } catch { await sleep(250); } }

    const login = async name => (await (await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })).json());
    const g = await login('Jana Novak');
    const gh = { 'X-Guest-Token': g.token };
    const img = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#aa9977' } }).jpeg().toBuffer();
    const upload = async (extra = {}) => {
      const fd = new FormData();
      fd.append('photo', new Blob([img]), 'p.jpg'); fd.append('thumb', new Blob([img]), 't.jpg'); fd.append('clientId', randomUUID());
      for (const [k, v] of Object.entries(extra)) fd.append(k, v);
      return (await fetch(`${BASE}/api/upload`, { method: 'POST', headers: gh, body: fd })).json();
    };

    // ── 1. albumAllowed / album-session ─────────────────────────────────────
    let me = await (await get('/api/me', gh)).json();
    assert(me.albumAllowed === false, 'closed + 0 photos: albumAllowed false');
    await post('/api/admin/album/toggle', ADMIN); // open
    me = await (await get('/api/me', gh)).json();
    assert(me.albumOpen === true && me.albumAllowed === false, 'open + 0 photos: albumAllowed false');
    let r = await post('/api/album-session', gh);
    const body0 = await r.json();
    assert(r.status === 403 && /prvo sliko/.test(body0.error) && !(r.headers.get('set-cookie') || '').includes('album='), '0 photos: album-session 403 with a clear message, no cookie');

    // ── 2. first photo caption stored like any caption ──────────────────────
    const first = await upload({ caption: 'Moja prva slika' });
    me = await (await get('/api/me', gh)).json();
    assert(me.albumAllowed === true, 'open + 1 photo: albumAllowed true');
    r = await post('/api/album-session', gh);
    assert(r.status === 200 && /album=/.test(r.headers.get('set-cookie') || ''), '1 photo + open: album-session ok, cookie set');
    const ck = { Cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
    const second = await upload({ caption: '' });
    const list = await (await get('/api/album/photos', ck)).json();
    const by = Object.fromEntries(list.photos.map(p => [p.id, p]));
    assert(by[first.photoId].label === 'Moja prva slika - Jana Novak', 'untouched first caption: "Moja prva slika - {Name}"');
    assert(by[second.photoId].label === 'Druga slika - Jana Novak', 'cleared caption: ordinal label');

    await post('/api/admin/album/toggle', ADMIN); // close
    me = await (await get('/api/me', gh)).json();
    assert(me.albumAllowed === false, 'closed + 1 photo: albumAllowed false');
    r = await post('/api/album-session', gh);
    assert(r.status === 403, '1 photo + closed: album-session 403');
    await post('/api/admin/album/toggle', ADMIN); // open again

    // ── 3. "Prenesi vse" switch ─────────────────────────────────────────────
    const st = await (await get('/api/admin/album', ADMIN)).json();
    assert(st.downloadAll === false, 'download-all is OFF by default');
    assert((await post('/api/admin/album/download')).status === 403, 'download-all toggle needs admin');
    let page = await (await get('/album', ck)).text();
    assert(page.includes('Spomini večera') && !page.includes('id="zip-all"') && !page.includes('Prenesi vse'), 'OFF: album page has no "Prenesi vse" button');
    r = await get('/album/zip', ck);
    assert(r.status === 403, 'OFF: guest album zip returns 403');
    r = await get('/album/zip', ADMIN);
    assert(r.status === 200, 'OFF: admin can still download the album zip');
    await r.arrayBuffer();
    r = await get('/api/admin/download-zip', ADMIN);
    assert(r.status === 200, 'OFF: admin zip unchanged');
    await r.arrayBuffer();

    const on = await (await post('/api/admin/album/download', ADMIN)).json();
    assert(on.downloadAll === true, 'admin switches download-all ON');
    page = await (await get('/album', ck)).text();
    assert(page.includes('id="zip-all"') && page.includes('>Prenesi vse<'), 'ON: "Prenesi vse" button is back');
    r = await get('/album/zip', ck);
    const zip = Buffer.from(await r.arrayBuffer());
    assert(r.status === 200 && zip.includes('Jana_Novak_001.jpg'), 'ON: guest zip works');
    await post('/api/admin/album/download', ADMIN);
    assert((await get('/album/zip', ck)).status === 403, 'switched OFF again: 403');
    const admin = await (await get('/admin', ADMIN)).text();
    assert(admin.includes('Prenos celotnega albuma') && admin.includes('IZKLOPLJEN') && !admin.includes('innerHTML'), 'admin toggle text');

    // ── client code (static checks: no browser in the test env) ─────────────
    const app = read('public/app.js');
    const css = read('public/style.css');
    assert(app.includes("const FIRST_CAPTION = 'Moja prva slika'") && /const firstPhoto = !photosTaken && !queue.length && !useTask/.test(app), 'first photo (0 stored) prefills "Moja prva slika"; later photos do not');
    assert(/classList\.toggle\('prefill-gray', firstPhoto\)/.test(app) && /\.caption-input\.prefill-gray \{ color: #9A968C; \}/.test(css), 'prefill is light gray #9A968C');
    assert(/addEventListener\('focus'[\s\S]{0,200}\.select\(\)/.test(app), 'focus selects all prefilled text');
    assert(/addEventListener\('input', \(\) => captionInput\.classList\.remove\('prefill-gray'\)\)/.test(app), 'first input switches to the dark color');
    assert(app.includes("btnAlbum = document.createElement('button')") && !read('views/guest.html').includes('Poglej si celoten album'), 'album button is not in the markup');
    assert(app.includes('albumAllowed = !!me.albumAllowed'), 'client uses albumAllowed');

    const album = read('views/album.html');
    assert(/iPhone\|iPad\|iPod\|Android/.test(album) && /maxTouchPoints > 1 && navigator\.platform === 'MacIntel'/.test(album), 'phone detection incl. iPadOS');
    assert(album.includes('`photo-${id}.jpg`') && album.includes("type: 'image/jpeg'"), 'card File is ASCII-named image/jpeg');
    assert(/navigator\.canShare && navigator\.canShare\(\{ files: \[file\] \}\)/.test(album) && album.includes('navigator.share({ files: [file] })'), 'uses navigator.share with files when canShare');
    assert(/prefetchCard\(p\);/.test(album) && /function dropCard/.test(album) && /dropCard\(\); \}/.test(album), 'card prefetched for the current photo only and dropped on moving on / closing');
    assert(album.includes('Pripravljam…') && /await cardPromise/.test(album), '"Pripravljam…" while the blob is not ready, then share anyway');
    assert(/err\.name === 'AbortError'\) return;/.test(album), 'AbortError ignored silently');
    assert(/downloadFile\(file\);/.test(album) && /a\.download = file\.name/.test(album), 'falls back to a temporary <a download>');
    assert(album.includes('id="lb-hint"') && album.includes('Nato tapni Shrani sliko') && album.includes('$(\'lb-hint\').hidden = !IS_IOS'), 'iOS-only hint under the button');
    assert(album.includes('Prenesi sliko z opisom') && album.includes('/album/card/${p.id}.jpg?dl=1') && /if \(!IS_PHONE\) return;/.test(album), 'desktop keeps the normal download link');
    assert(!album.includes('innerHTML'), 'album page has no innerHTML');
    assert(read('README.md').includes('Browsers cannot write to a phone\'s gallery directly'), 'README note on gallery saving');
    assert((await (await get('/api/version')).json()).version === 'v17', 'APP_VERSION is v17');
  } finally {
    server.kill();
  }
  console.log(`\nGallery results: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
