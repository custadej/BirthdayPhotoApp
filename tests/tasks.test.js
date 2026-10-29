'use strict';

/** Tasks in the DB, admin task editor API, label rules end to end, medium images, guest page markup. */

const { spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { randomUUID } = require('crypto');
const sharp = require('sharp');

const PORT = parseInt(process.env.SMOKE_PORT || '19977') + 3;
const BASE = `http://localhost:${PORT}`;
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function assert(c, label) {
  if (c) { console.log(`  PASS  ${label}`); pass++; } else { console.error(`  FAIL  ${label}`); fail++; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ADMIN = { 'X-Admin-Key': 'tasksadmin' };
const jsonH = { ...ADMIN, 'Content-Type': 'application/json' };

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpatasks-'));
  const server = spawn('node', [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), ADMIN_KEY: 'tasksadmin', ALBUM_CODE: 'kodaza', DATA_DIR: dataDir, PHOTO_LIMIT: '', EVENT_TITLE: 'Party Anna and Bob' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    for (let i = 0; i < 40; i++) { try { await fetch(`${BASE}/api/config`); break; } catch { await sleep(250); } }

    // ── limit ───────────────────────────────────────────────────────────────
    const cfg = await (await fetch(`${BASE}/api/config`)).json();
    assert(cfg.photoLimit === 15, 'default PHOTO_LIMIT is 15');

    const login = await (await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Jana Novak' }) })).json();
    const gh = { 'X-Guest-Token': login.token };
    const me0 = await (await fetch(`${BASE}/api/me`, { headers: gh })).json();
    assert(me0.limit === 15 && me0.remaining === 15, 'new guest gets 15 photos');

    // ── /api/tasks ──────────────────────────────────────────────────────────
    assert((await fetch(`${BASE}/api/tasks`)).status === 401, '/api/tasks needs a guest session');
    let tasks = await (await fetch(`${BASE}/api/tasks`, { headers: gh })).json();
    assert(tasks.length === 37, 'seeded with 37 active tasks');
    assert(tasks.every(t => t.id && t.text && t.label), 'tasks have id, text, label');
    const dance = tasks.find(t => t.text === 'Slikaj nekoga, ki pleše');
    assert(dance && dance.label === 'Slika nekoga, ki pleše', 'seed label present');

    // ── upload with taskId ──────────────────────────────────────────────────
    const img = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: '#7799bb' } }).jpeg().toBuffer();
    const upload = async (extra = {}) => {
      const fd = new FormData();
      fd.append('photo', new Blob([img]), 'p.jpg'); fd.append('thumb', new Blob([img]), 't.jpg'); fd.append('clientId', randomUUID());
      for (const [k, v] of Object.entries(extra)) fd.append(k, v);
      return (await fetch(`${BASE}/api/upload`, { method: 'POST', headers: gh, body: fd })).json();
    };
    let r = await upload({ taskId: dance.id });
    assert(r.ok && r.taskText === dance.text && r.taskLabel === dance.label, 'upload by taskId snapshots text + label');
    const idDance = r.photoId;
    r = await upload({ taskText: 'Slikaj torto ali sladico' });
    assert(r.taskLabel === 'Slika torte ali sladice', 'taskText still accepted (matched by text)');
    r = await upload({ taskText: 'neobstoječa naloga', taskId: 'abc' });
    assert(r.taskText === null && r.taskLabel === null, 'unknown task is dropped');
    r = await upload({ taskId: dance.id, caption: 'Moj opis' });
    const idCaption = r.photoId;
    const meN = await (await fetch(`${BASE}/api/me`, { headers: gh })).json();
    assert(meN.items[0].taskLabel === dance.label && meN.items[0].taskText === dance.text, '/api/me items carry task text + label');

    // ── admin task API ──────────────────────────────────────────────────────
    assert((await fetch(`${BASE}/api/admin/tasks`)).status === 403, 'admin tasks: anonymous rejected');
    assert((await fetch(`${BASE}/api/admin/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status === 403, 'admin tasks POST: anonymous rejected');
    assert((await fetch(`${BASE}/api/admin/tasks`, { headers: gh })).status === 403, 'admin tasks: guests rejected');
    const list = await (await fetch(`${BASE}/api/admin/tasks`, { headers: ADMIN })).json();
    assert(list.length === 37 && list[0].active === true, 'admin lists all tasks');

    r = await fetch(`${BASE}/api/admin/tasks`, { method: 'POST', headers: jsonH, body: JSON.stringify({ text: '  ', label: 'x' }) });
    assert(r.status === 400, 'empty task text rejected');
    r = await fetch(`${BASE}/api/admin/tasks`, { method: 'POST', headers: jsonH, body: JSON.stringify({ text: 'x'.repeat(201) }) });
    assert(r.status === 400, 'task text over 200 chars rejected');
    r = await (await fetch(`${BASE}/api/admin/tasks`, { method: 'POST', headers: jsonH, body: JSON.stringify({ text: 'Slikaj mačko', label: '' }) })).json();
    assert(r.text === 'Slikaj mačko' && r.label === 'Slikaj mačko' && r.active === true, 'empty Naziv falls back to the task text');
    const cat = r;
    r = await (await fetch(`${BASE}/api/admin/tasks/${cat.id}`, { method: 'PUT', headers: jsonH, body: JSON.stringify({ text: 'Slikaj mačko', label: 'Slika mačke', active: true }) })).json();
    assert(r.label === 'Slika mačke', 'update saves Naziv');
    r = await (await fetch(`${BASE}/api/admin/tasks/${cat.id}`, { method: 'PUT', headers: jsonH, body: JSON.stringify({ text: 'Slikaj mačko', label: '   ', active: true }) })).json();
    assert(r.label === 'Slikaj mačko', 'update with empty Naziv falls back to text');
    tasks = await (await fetch(`${BASE}/api/tasks`, { headers: gh })).json();
    assert(tasks.length === 38 && tasks.some(t => t.id === cat.id), 'new active task appears for guests');

    // inactive: hidden from guests, still accepted on upload
    await fetch(`${BASE}/api/admin/tasks/${cat.id}`, { method: 'PUT', headers: jsonH, body: JSON.stringify({ text: 'Slikaj mačko', label: 'Slika mačke', active: false }) });
    tasks = await (await fetch(`${BASE}/api/tasks`, { headers: gh })).json();
    assert(!tasks.some(t => t.id === cat.id), 'inactive task hidden from guests');
    r = await upload({ taskId: cat.id });
    assert(r.taskLabel === 'Slika mačke', 'inactive task still accepted on upload');

    // editing the task later does not rewrite old photos (snapshot)
    await fetch(`${BASE}/api/admin/tasks/${dance.id}`, { method: 'PUT', headers: jsonH, body: JSON.stringify({ text: 'Slikaj plesalce', label: 'Slika plesalcev', active: true }) });

    // soft delete
    r = await fetch(`${BASE}/api/admin/tasks/${cat.id}`, { method: 'DELETE', headers: ADMIN });
    assert(r.status === 200, 'delete task');
    assert((await fetch(`${BASE}/api/admin/tasks/${cat.id}`, { method: 'DELETE', headers: ADMIN })).status === 404, 'delete again -> 404');
    const adminList = await (await fetch(`${BASE}/api/admin/tasks`, { headers: ADMIN })).json();
    assert(!adminList.some(t => t.id === cat.id), 'deleted task gone from admin list');
    r = await upload({ taskId: cat.id });
    assert(r.ok && r.taskLabel === 'Slika mačke', 'soft-deleted task is still accepted on upload');
    assert((await fetch(`${BASE}/api/admin/tasks/${cat.id}`, { method: 'PUT', headers: jsonH, body: JSON.stringify({ text: 'x', label: 'y', active: true }) })).status === 404, 'deleted task cannot be edited');

    // ── labels end to end (album API) ───────────────────────────────────────
    await fetch(`${BASE}/api/admin/album/toggle`, { method: 'POST', headers: ADMIN });
    const album = await (await fetch(`${BASE}/api/album/photos`, { headers: ADMIN })).json();
    const byId = Object.fromEntries(album.photos.map(p => [p.id, p]));
    assert(byId[idDance].label === 'Slika nekoga, ki pleše - Jana Novak' && byId[idDance].task === '', 'task photo: task label as title, no second line (snapshot survives edit)');
    assert(byId[idCaption].label === 'Moj opis - Jana Novak' && byId[idCaption].task === 'Naloga: Slikaj nekoga, ki pleše', 'caption + task: second line with task text');
    const adminPhotos = await (await fetch(`${BASE}/api/admin/guests/${login.guest.id}/photos`, { headers: ADMIN })).json();
    assert(adminPhotos.find(p => p.id === idDance).label === 'Slika nekoga, ki pleše - Jana Novak', 'admin grid uses the same label rules');

    // ── medium images ───────────────────────────────────────────────────────
    const cookieResp = await fetch(`${BASE}/album?code=kodaza`, { redirect: 'manual' });
    const ck = { Cookie: (cookieResp.headers.get('set-cookie') || '').split(';')[0] };
    assert((await fetch(`${BASE}/album/medium/${idDance}`)).status === 401, 'medium needs the album cookie');
    const med = await fetch(`${BASE}/album/medium/${idDance}`, { headers: ck });
    const mm = await sharp(Buffer.from(await med.arrayBuffer())).metadata();
    assert(med.status === 200 && mm.format === 'jpeg' && mm.width === 1280 && mm.height === 853, 'medium is a 1280px JPEG');
    assert(fs.existsSync(path.join(dataDir, 'medium', `${idDance}.jpg`)), 'medium cached in DATA_DIR/medium');
    assert(/medium/.test(fs.readFileSync(path.join(ROOT, 'views', 'album.html'), 'utf8')), 'album grid uses /album/medium');
    await fetch(`${BASE}/api/admin/album/toggle`, { method: 'POST', headers: ADMIN }); // close
    assert((await fetch(`${BASE}/album/medium/${idDance}`, { headers: ck })).status === 403, 'medium blocked while album is closed');
    await fetch(`${BASE}/api/admin/photos/${idDance}`, { method: 'DELETE', headers: ADMIN });
    assert(!fs.existsSync(path.join(dataDir, 'medium', `${idDance}.jpg`)), 'deleting a photo removes its medium image');

    // ── guest page markup ───────────────────────────────────────────────────
    const home = await (await fetch(`${BASE}/`)).text();
    const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    assert(!/camtest|Preizkusi kamero|camera_step/.test(home + app), 'Android camera test step is gone');
    assert(!app.includes('Slikaj nekoga') && !app.includes('ALL_TASKS'), 'no hardcoded tasks in the client');
    assert(app.includes('/api/tasks') && app.includes('used_tasks'), 'client fetches tasks and remembers used ones');
    for (const text of ['Pozdravljen!', 'Imel boš <span id="limit-display">15</span> slik za cel večer.', 'Vsako sliko lahko na kratko opišeš. Lahko pa rešuješ tudi naloge, ki ti jih bomo ponudili.', 'Vse slike bodo v skupnem albumu za gosta'.replace('gosta', 'goste'), 'Naredi tvojo prvo sliko', 'Naslednja naloga', '📷 Slikaj nalogo', '📷 Slikaj karkoli', 'Moje slike:']) {
      assert(home.includes(text), `guest page text: ${text.slice(0, 40)}`);
    }
    assert(home.indexOf('login-foot') > home.indexOf('btn-login') && home.includes('Ime si zapomnimo na tem telefonu'), 'remember-name line is at the very bottom of the welcome screen');
    assert(home.indexOf('btn-task-photo') < home.indexOf('btn-next-task') && home.indexOf('btn-next-task') < home.indexOf('btn-any-photo'), 'task buttons in the right order');
    const footerAt = home.indexOf('class="footer"');
    assert(footerAt > home.indexOf('thumb-strip') && home.slice(footerAt).indexOf('btn-logout') < 80 && !/<button/.test(home.slice(home.indexOf('btn-logout') + 40, home.indexOf('<!-- Preview -->'))), 'logout is the last element of the main screen');
    assert((home.match(/class="balloon /g) || []).length >= 4, 'balloons present');
    assert(!/https?:\/\/(?!localhost)/.test(home.replace(/http:\/\/www\.w3\.org[^"']*/g, '')), 'no external URLs on the guest page');

    const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
    assert(css.includes('prefers-reduced-motion') && css.includes('pointer-events: none') && css.includes('background-clip: text'), 'css: reduced motion, no-tap deco, gold gradient 50');
    assert(/min-height:\s*100dvh/.test(css) && /\.footer \{[^}]*margin-top: auto/.test(css), 'css: logout pinned to the bottom');
    assert(/\.btn-task-photo \{ min-height: 72px/.test(css) && /\.btn-next-task +\{ min-height: 52px/.test(css) && /\.btn-any-photo +\{ min-height: 72px/.test(css), 'css: task button heights 72/52/72');
    assert(!/\.album-card \.cap \{[^}]*min-height/.test(css), 'album caption block has no min-height');

    // ── fonts ───────────────────────────────────────────────────────────────
    const fonts = await (await fetch(`${BASE}/fonts/fonts.css`)).text();
    assert(fonts.includes("local('Cavolini')") && fonts.includes('Cavolini-Regular.woff2') && fonts.includes('unicode-range') && fonts.includes('latin-ext'), 'fonts.css: Cavolini local(), unicode-range, latin-ext');
    const fontFiles = [...fonts.matchAll(/url\((\/fonts\/[^)]+\.woff2)\)/g)].map(m => m[1]).filter(f => !f.includes('Cavolini'));
    let allOk = fontFiles.length >= 12;
    for (const f of fontFiles) if ((await fetch(BASE + f)).status !== 200) allOk = false;
    assert(allOk, 'all local font files are served');
    assert(/Cormorant Garamond/.test(css) && /'Lora'/.test(css) && /'Cavolini'/.test(css), 'css font stacks');
    const admin = await (await fetch(`${BASE}/admin`, { headers: ADMIN })).text();
    for (const t of ['Naloge', 'Dodaj nalogo', 'Besedilo naloge', 'Naziv slike', 'Aktivna']) assert(admin.includes(t), `admin task editor: ${t}`);
    assert(!admin.includes('innerHTML'), 'admin page still has no innerHTML');
    assert((await (await fetch(`${BASE}/admin`)).text()).includes('fonts.css'), 'admin login page loads the fonts');
  } finally {
    server.kill();
  }
  console.log(`\nTasks results: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
