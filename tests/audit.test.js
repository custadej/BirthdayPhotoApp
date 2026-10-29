'use strict';

/**
 * Regression: guests created by older versions, plus the http:// crash.
 *  - builds a DB with legacy-shaped guests/photos (blank normalized_name, NULL ordinal, missing thumb)
 *  - every guest must still log in, load /api/me, get tasks, upload, open the album
 *  - the audit script must report no problems on healthy data and flag the broken rows
 *  - http:// visitors are redirected to https; the client no longer needs crypto.randomUUID
 */

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const sharp = require('sharp');
const Database = require('better-sqlite3');

const http = require('http');
const ROOT = path.join(__dirname, '..');

// fetch() cannot override the Host header, http.request can
function rawGet(p, headers) {
  return new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port: PORT, path: p, headers }, res => { res.resume(); resolve({ status: res.statusCode, location: res.headers.location }); }).on('error', reject);
  });
}
const PORT = parseInt(process.env.SMOKE_PORT || '19977') + 7;
const BASE = `http://localhost:${PORT}`;
let pass = 0, fail = 0;
function assert(c, label) {
  if (c) { console.log(`  PASS  ${label}`); pass++; } else { console.error(`  FAIL  ${label}`); fail++; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpalegacy-'));
  fs.mkdirSync(path.join(dir, 'photos', 'g1'), { recursive: true });
  const jpg = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#556677' } }).jpeg().toBuffer();
  fs.writeFileSync(path.join(dir, 'photos', 'g1', 'p1.jpg'), jpg);
  fs.writeFileSync(path.join(dir, 'photos', 'g1', 'p1_thumb.jpg'), jpg);
  fs.writeFileSync(path.join(dir, 'photos', 'g1', 'p2.jpg'), jpg);       // p2: thumb missing
  // legacy shape: the very first schema, without any later column
  const db = new Database(path.join(dir, 'party.db'));
  db.exec(`CREATE TABLE guests (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, normalized_name TEXT NOT NULL, token TEXT NOT NULL UNIQUE, photo_limit INTEGER NOT NULL DEFAULT 10, created_at INTEGER NOT NULL);
    CREATE TABLE photos (id TEXT PRIMARY KEY, guest_id TEXT NOT NULL, client_id TEXT NOT NULL UNIQUE, task_id TEXT, created_at INTEGER NOT NULL);
    INSERT INTO guests VALUES ('g1','Stara Gostja','','tok1',10,1000);
    INSERT INTO guests VALUES ('g2','Janez Novak','janez novak','tok2',3,2000);
    INSERT INTO photos VALUES ('p1','g1','c1','t05',1500);
    INSERT INTO photos VALUES ('p2','g1','c2',NULL,1600);`);
  db.close();

  const server = spawn('node', [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dir, ADMIN_KEY: 'auditadmin', ALBUM_CODE: 'x', PHOTO_LIMIT: '15' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    for (let i = 0; i < 40; i++) { try { await fetch(`${BASE}/api/config`); break; } catch { await sleep(250); } }
    const post = (p, body, h = {}) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) });

    let r = await (await post('/api/login', { name: 'Stara Gostja' })).json();
    assert(r.status === 'ok' && r.guest.id === 'g1', 'legacy guest with blank normalized_name logs in (and was repaired)');
    const gh = { 'X-Guest-Token': 'tok1' };
    const me = await (await fetch(`${BASE}/api/me`, { headers: gh })).json();
    assert(me.limit === 15 && me.items.length === 2 && me.items.every(i => i.ordinal >= 1), 'legacy guest /api/me: limit raised, ordinals backfilled');
    assert(me.items.map(i => i.ordinal).join() === '1,2', 'ordinals are 1,2 in time order');
    const th = await fetch(`${BASE}/thumb/p2`, { headers: gh });
    assert(th.status === 200, 'missing thumb is regenerated instead of failing');
    await th.arrayBuffer();
    r = await (await post('/api/login', { name: 'Janez Novak' })).json();
    assert(r.status === 'ok' && r.guest.id === 'g2', 'second legacy guest logs in');
    assert((await fetch(`${BASE}/api/tasks`, { headers: { 'X-Guest-Token': 'tok2' } })).status === 200, 'legacy guest can fetch tasks');
    const fd = new FormData();
    fd.append('photo', new Blob([jpg]), 'p.jpg'); fd.append('clientId', 'legacy-upload-1');
    const up = await fetch(`${BASE}/api/upload`, { method: 'POST', headers: { 'X-Guest-Token': 'tok2' }, body: fd });
    assert(up.status === 200, 'legacy guest can upload');

    // http:// visitors (typed the address without https) are sent to https
    r = await rawGet('/', { Host: 'photos.example.com', 'X-Forwarded-Proto': 'http' });
    assert(r.status === 301 && r.location === 'https://photos.example.com/', 'x-forwarded-proto http -> 301 to https');
    r = await rawGet('/album?code=a', { Host: 'photos.example.com', 'CF-Visitor': '{"scheme":"http"}' });
    assert(r.status === 301 && r.location === 'https://photos.example.com/album?code=a', 'cf-visitor http -> 301, query kept');
    r = await rawGet('/', { Host: 'photos.example.com', 'X-Forwarded-Proto': 'https' });
    assert(r.status === 200, 'https visitors are not redirected');
    r = await fetch(`${BASE}/`, { redirect: 'manual' });
    assert(r.status === 200, 'plain localhost is not redirected');
  } finally {
    server.kill();
  }

  fs.rmSync(path.join(dir, 'photos', 'g1', 'p2_thumb.jpg'), { force: true });
  // the audit script on the (now migrated) copy: exits 0 when everything works
  const a = spawnSync('node', [path.join(ROOT, 'scripts', 'audit-guests.js'), dir], { encoding: 'utf8' });
  assert(a.status === 1 && /thumb file missing/.test(a.stdout) && /gapped ordinals|duplicate/.test(a.stdout) === false, 'audit script flags the missing thumb and nothing else');
  assert(/Stara Gostja: login, \/api\/me, tasks, upload, album-session/.test(a.stdout), 'audit script exercises every guest');

  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  assert(/clientId: newClientId\(\)/.test(app) && !/clientId: crypto\.randomUUID\(\)/.test(app) && /getRandomValues/.test(app), 'client id no longer depends on crypto.randomUUID (https-only)');
  assert(/err\.name \|\| 'Error'/.test(app), 'client error reports include name and message');

  console.log(`\nAudit results: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
