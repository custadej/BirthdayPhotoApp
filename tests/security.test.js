'use strict';

/** Admin login, album code, rate limiting, caching, upload status + failure log. */

const { spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { randomUUID } = require('crypto');
const sharp = require('sharp');

const PORT = parseInt(process.env.SMOKE_PORT || '19977') + 2;
const BASE = `http://localhost:${PORT}`;
const TITLE = 'Party Anna and Bob';
let pass = 0, fail = 0;
function assert(c, label) {
  if (c) { console.log(`  PASS  ${label}`); pass++; } else { console.error(`  FAIL  ${label}`); fail++; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ipH = ip => ({ 'cf-connecting-ip': ip });
const TOO_MANY = 'Preveč poskusov. Poskusi čez nekaj minut.';

function get(p, headers = {}) { return fetch(BASE + p, { redirect: 'manual', headers }); }
function login(password, headers = {}) {
  return fetch(BASE + '/admin/login', {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ password }),
  });
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpasec-'));
  const server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), ADMIN_KEY: 'testadminpw', ALBUM_CODE: 'testalbumcode', DATA_DIR: dataDir, EVENT_TITLE: TITLE, EVENT_BADGE: '', PHOTO_LIMIT: '5' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    for (let i = 0; i < 40; i++) { try { await get('/api/config'); break; } catch { await sleep(250); } }

    // ── title + version + caching ───────────────────────────────────────────
    const home = await get('/');
    const homeHtml = await home.text();
    assert(homeHtml.includes(`<title>${TITLE}</title>`) && homeHtml.includes('<span class="t-main">Party</span>') && homeHtml.includes('<span class="t-sub">Anna and Bob</span>'), 'guest page uses EVENT_TITLE (Party / Anna and Bob)');
    const ver = await (await get('/api/version')).json();
    assert(/^v\d+$/.test(ver.version), '/api/version returns the version');
    assert(!homeHtml.includes(`>${ver.version}<`), 'version is no longer printed on the page');
    assert(!homeHtml.includes('class="fifty"'), 'no badge unless EVENT_BADGE is set');
    assert(!/serviceWorker\.register/.test(homeHtml) && homeHtml.includes('getRegistrations'), 'service workers are unregistered, never registered');
    for (const p of ['/', '/app.js', '/style.css', '/config.js', '/album', '/admin']) {
      const r = await get(p);
      assert((r.headers.get('cache-control') || '').includes('no-cache'), `Cache-Control: no-cache on ${p}`);
    }
    const css = await (await get('/style.css')).text();
    assert(css.includes('.counter:empty'), 'empty counter pill is hidden');

    // ── admin login ─────────────────────────────────────────────────────────
    const lp = await (await get('/admin')).text();
    assert(/type="password"/.test(lp) && /autocapitalize="off"/.test(lp) && /autocorrect="off"/.test(lp), 'admin login page has password input');
    assert((await get('/api/admin/guests')).status === 403, 'admin API rejects anonymous');
    assert((await get('/api/admin/guests', { 'X-Admin-Key': 'TESTADMINPW' })).status === 403, 'admin key is case-sensitive');

    let r = await login('wrong');
    assert(r.status === 401, 'wrong password -> 401');
    r = await login('testadminpw');
    const sc = r.headers.get('set-cookie') || '';
    assert(r.status === 302 && r.headers.get('location') === '/admin', 'correct password redirects to /admin');
    assert(/HttpOnly/i.test(sc) && /SameSite=Lax/i.test(sc) && /Max-Age=604800/.test(sc), 'admin cookie flags');
    const ck = { Cookie: sc.split(';')[0] };
    const adminPage = await (await get('/admin', ck)).text();
    assert(adminPage.includes(`Admin – ${TITLE}`), 'admin page with cookie shows event title');
    assert((await get('/api/admin/guests', ck)).status === 200, 'admin API accepts cookie');

    r = await get('/admin?key=testadminpw');
    assert(r.status === 302 && r.headers.get('location') === '/admin' && /admin=/.test(r.headers.get('set-cookie') || ''), '?key= sets cookie and redirects');
    r = await get('/admin?key=TESTADMINPW');
    assert(r.status === 403, '?key= is case-sensitive');

    // ── album code ──────────────────────────────────────────────────────────
    r = await get('/album?code=%20TestAlbumCode%20');
    assert(r.status === 302 && /album=/.test(r.headers.get('set-cookie') || ''), 'album code: trimmed and case-insensitive');

    // ── rate limiting ───────────────────────────────────────────────────────
    for (let i = 0; i < 5; i++) assert((await get('/album?code=nope', ipH('1.1.1.1'))).status === 403, `album wrong code #${i + 1} -> 403`);
    r = await get('/album?code=testalbumcode', ipH('1.1.1.1'));
    assert(r.status === 429 && (await r.text()).includes(TOO_MANY), 'album: 6th attempt -> 429 with message');
    assert((await get('/album?code=testalbumcode', ipH('2.2.2.2'))).status === 302, 'album: other IP unaffected');
    for (let i = 0; i < 10; i++) await get('/album?code=testalbumcode', ipH('3.3.3.3'));
    assert((await get('/album?code=testalbumcode', ipH('3.3.3.3'))).status === 302, 'correct codes never count as failures');

    for (let i = 0; i < 5; i++) await login('bad', ipH('4.4.4.4'));
    r = await login('testadminpw', ipH('4.4.4.4'));
    assert(r.status === 429 && (await r.text()).includes(TOO_MANY), 'admin login: blocked after 5 failures');
    r = await get('/admin?key=testadminpw', ipH('4.4.4.4'));
    assert(r.status === 429, 'admin ?key= shares the same block');
    r = await get('/api/admin/guests', { ...ipH('4.4.4.4'), 'X-Admin-Key': 'testadminpw' });
    assert(r.status === 429 && (await r.json()).error === TOO_MANY, 'admin API: 429 while blocked');
    for (let i = 0; i < 5; i++) await get('/admin?key=bad', ipH('5.5.5.5'));
    assert((await get('/admin?key=testadminpw', ipH('5.5.5.5'))).status === 429, '?key= failures count toward the limit');

    // ── upload status + failure log ─────────────────────────────────────────
    const jpg = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#aaa' } }).jpeg().toBuffer();
    const mk = async name => (await (await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })).json());
    const g1 = await mk('Ana Novak'), g2 = await mk('Boris Kralj');
    const h1 = { 'X-Guest-Token': g1.token }, h2 = { 'X-Guest-Token': g2.token };
    const cid = randomUUID();
    const fd = new FormData();
    fd.append('photo', new Blob([jpg]), 'p.jpg'); fd.append('thumb', new Blob([jpg]), 't.jpg'); fd.append('clientId', cid);
    let st = await (await fetch(`${BASE}/api/upload/status/${cid}`, { headers: h1 })).json();
    assert(st.stored === false, 'status: not stored before upload');
    await fetch(`${BASE}/api/upload`, { method: 'POST', headers: h1, body: fd });
    st = await (await fetch(`${BASE}/api/upload/status/${cid}`, { headers: h1 })).json();
    assert(st.stored === true && st.remaining === 4 && st.ordinal === 1, 'status: stored after upload');
    st = await (await fetch(`${BASE}/api/upload/status/${cid}`, { headers: h2 })).json();
    assert(st.stored === false, 'status: other guest never sees it');
    assert((await fetch(`${BASE}/api/upload/status/${cid}`)).status === 401, 'status needs a guest session');

    const bad = new FormData();
    bad.append('photo', new Blob([Buffer.from('not a jpeg')]), 'p.jpg'); bad.append('thumb', new Blob([jpg]), 't.jpg'); bad.append('clientId', randomUUID());
    const br = await fetch(`${BASE}/api/upload`, { method: 'POST', headers: h1, body: bad });
    await sleep(300);
    const logPath = path.join(dataDir, 'upload-errors.log');
    const lines = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse) : [];
    const last = lines[lines.length - 1] || {};
    assert(br.status === 400 && last.status === 400 && last.guestId && last.error && last.bytes > 0 && last.time, 'failed upload is logged (time, guest, status, error, size)');
  } finally {
    server.kill();
  }
  console.log(`\nSecurity results: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
