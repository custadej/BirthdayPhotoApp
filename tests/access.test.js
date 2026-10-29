'use strict';

/** Task-label caption rule, guest album session, album password switch, success message. */

const { spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { randomUUID } = require('crypto');
const sharp = require('sharp');

const PORT = parseInt(process.env.SMOKE_PORT || '19977') + 4;
const BASE = `http://localhost:${PORT}`;
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function assert(c, label) {
  if (c) { console.log(`  PASS  ${label}`); pass++; } else { console.error(`  FAIL  ${label}`); fail++; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ADMIN = { 'X-Admin-Key': 'accessadmin' };
const get = (p, h = {}) => fetch(BASE + p, { redirect: 'manual', headers: h });
const post = (p, h = {}) => fetch(BASE + p, { method: 'POST', redirect: 'manual', headers: h });

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpaaccess-'));
  const server = spawn('node', [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), ADMIN_KEY: 'accessadmin', ALBUM_CODE: 'kodaza', DATA_DIR: dataDir, PHOTO_LIMIT: '15' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    for (let i = 0; i < 40; i++) { try { await get('/api/config'); break; } catch { await sleep(250); } }

    const login = await (await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Jana Novak' }) })).json();
    const gh = { 'X-Guest-Token': login.token };
    const tasks = await (await get('/api/tasks', gh)).json();
    const dance = tasks.find(t => t.text === 'Slikaj nekoga, ki pleše');

    const img = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#99aa77' } }).jpeg().toBuffer();
    const upload = async extra => {
      const fd = new FormData();
      fd.append('photo', new Blob([img]), 'p.jpg'); fd.append('thumb', new Blob([img]), 't.jpg'); fd.append('clientId', randomUUID());
      for (const [k, v] of Object.entries(extra)) fd.append(k, v);
      return (await fetch(`${BASE}/api/upload`, { method: 'POST', headers: gh, body: fd })).json();
    };

    // ── caption prefill rule ────────────────────────────────────────────────
    const same = await upload({ taskId: dance.id, caption: ` ${dance.label.toUpperCase()} ` });
    assert(same.caption === null && same.taskLabel === dance.label, 'caption equal to task label (case-insensitive) is stored as NULL');
    const changed = await upload({ taskId: dance.id, caption: 'Plesalci na odru' });
    assert(changed.caption === 'Plesalci na odru', 'edited caption is kept');
    const anyPhoto = await upload({ caption: dance.label });
    assert(anyPhoto.caption === dance.label, 'without a task the caption is never dropped');

    // ── /api/me albumOpen + album-session ───────────────────────────────────
    let me = await (await get('/api/me', gh)).json();
    assert(me.albumOpen === false && !('albumCode' in me) && !JSON.stringify(me).includes('kodaza'), '/api/me: albumOpen false, no album secrets');
    assert((await post('/api/album-session')).status === 401, 'album-session needs a guest');
    assert((await post('/api/album-session', gh)).status === 403, 'album-session rejected while album is closed');
    await post('/api/admin/album/toggle', ADMIN);
    me = await (await get('/api/me', gh)).json();
    assert(me.albumOpen === true, '/api/me: albumOpen true once opened');
    const sess = await post('/api/album-session', gh);
    const sc = sess.headers.get('set-cookie') || '';
    assert(sess.status === 200 && (await sess.json()).ok === true, 'album-session works when open');
    assert(/^album=/.test(sc) && /HttpOnly/i.test(sc) && /SameSite=Lax/i.test(sc) && /Max-Age=1209600/.test(sc), 'album-session cookie attributes');
    const ck = { Cookie: sc.split(';')[0] };
    const list = await (await get('/api/album/photos', ck)).json();
    const byId = Object.fromEntries(list.photos.map(p => [p.id, p]));
    assert(byId[same.photoId].label === 'Slika nekoga, ki pleše - Jana Novak' && byId[same.photoId].task === '', 'untouched prefill: "{task label} - {Name}", no Naloga line');
    assert(byId[changed.photoId].label === 'Plesalci na odru - Jana Novak' && byId[changed.photoId].task === 'Naloga: Slikaj nekoga, ki pleše', 'edited caption: keeps the Naloga line');
    assert((await get('/album/thumb/' + same.photoId, ck)).status === 200, 'cookie from album-session opens album photos');

    // ── album password switch ───────────────────────────────────────────────
    const state = await (await get('/api/admin/album', ADMIN)).json();
    assert(state.passwordOn === true, 'password is ON by default');
    assert((await post('/api/admin/album/password')).status === 403, 'password toggle needs admin');
    let page = await (await get('/album')).text();
    assert(page.includes('Album je zaklenjen'), 'password ON + no cookie: locked');
    assert((await get('/album/thumb/' + same.photoId)).status === 401, 'password ON + no cookie: photos 401');

    const off = await (await post('/api/admin/album/password', ADMIN)).json();
    assert(off.passwordOn === false, 'admin switches the password OFF');
    page = await (await get('/album')).text();
    assert(page.includes('Spomini večera'), 'password OFF + open: album works without cookie');
    for (const p of [`/api/album/photos`, `/album/photo/${same.photoId}`, `/album/thumb/${same.photoId}`, `/album/medium/${same.photoId}`, `/album/card/${same.photoId}.jpg`]) {
      const r = await get(p);
      assert(r.status === 200, `password OFF + open: ${p.replace(same.photoId, ':id')} -> 200`);
      await r.arrayBuffer();
    }
    assert((await get('/album/zip')).status === 403, 'password OFF + open: zip still needs the download-all switch');
    const adm = await (await get('/api/admin/album', ADMIN)).json();
    assert(/\/album$/.test(adm.plainLink) && !adm.plainLink.includes('code='), 'admin gets a plain album link');

    await post('/api/admin/album/toggle', ADMIN); // close
    page = await (await get('/album')).text();
    assert(page.includes('Album bo odprt jutri'), 'password OFF + closed: "tomorrow" page');
    assert((await get('/album/thumb/' + same.photoId)).status === 403, 'password OFF + closed: photos blocked');
    assert((await get('/album', ADMIN)).status === 200, 'admin still sees the album while closed');
    await post('/api/admin/album/password', ADMIN); // back ON
    page = await (await get('/album')).text();
    assert(page.includes('Album je zaklenjen'), 'password back ON: locked again');

    // ── static markup / client code ─────────────────────────────────────────
    const home = await (await get('/')).text();
    const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    assert(!/Shrani na telefon|Shrani sliko|share-area|config\.js/.test(home + app), 'save button / iOS hint / config.js removed');
    assert(!/navigator\.(share|canShare)|HIDE_SAVE_ON_ANDROID|shareOrDownload/.test(app), 'Web Share code removed');
    assert((await get('/config.js')).status === 404, 'config.js no longer served');
    assert(app.includes("classList.add('fade'), 9000)") && /setTimeout\(hideSuccess, 10000\)/.test(app), 'success message fades after 9 s and disappears at 10 s');
    assert(/function showSuccess\(bonusGranted\) \{\s*hideSuccess\(\)/.test(app) && /function sendCapture\(\) \{[^}]*?hideSuccess\(\)/.test(app), 'timers cleared when a new upload starts');
    assert(/captionInput\.value = useTask \?/.test(app), 'preview prefills the task label for "Slikaj nalogo" only');
    assert(!app.includes('innerHTML'), 'app.js has no innerHTML');
    assert(!home.includes('Poglej si celoten album') && /insertBefore\(btnAlbum, document\.querySelector\('#screen-main \.footer'\)\)/.test(app), 'album button is created in JS above the logout footer');
    assert(/\.btn-album \{ min-height: 56px/.test(fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8')), 'album button is at least 56px tall');
    assert(/album-session/.test(app) && /albumOpen/.test(app), 'client uses albumOpen + album-session');
    const albumHtml = fs.readFileSync(path.join(ROOT, 'views', 'album.html'), 'utf8');
    assert(albumHtml.includes('>Nazaj</a>') && albumHtml.includes("guest_session"), 'album page has a Nazaj link tied to the guest session');
    const admin = await (await get('/admin', ADMIN)).text();
    assert(admin.includes('Geslo za album') && admin.includes('VKLOPLJENO') && admin.includes('Pozor: ko je geslo izklopljeno, lahko album odpre vsak, ki ve naslov /album.'), 'admin password toggle + warning text');
    assert(!admin.includes('innerHTML'), 'admin has no innerHTML');
    const ver = await (await get('/api/version')).json();
    assert(ver.version === 'v17', 'APP_VERSION is v17');
  } finally {
    server.kill();
  }
  console.log(`\nAccess results: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
