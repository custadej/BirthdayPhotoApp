'use strict';

/**
 * Smoke test: starts a real server, exercises the full guest + limit flow.
 * Run with: node tests/smoke.test.js
 *
 * Uses PHOTO_LIMIT=3 so we only need 4 uploads to hit the limit.
 */

const { spawn }     = require('child_process');
const path          = require('path');
const fs            = require('fs');
const os            = require('os');
const { randomUUID } = require('crypto');

// ── Tiny valid JPEG (1×1 white pixel) ─────────────────────────────────────────
// Passes the magic-bytes check (FF D8 FF) and is a valid JFIF container.
const TINY_JPEG = Buffer.from(
  'ffd8ffe000104a46494600010100000100010000' +
  'ffdb004300080606070605080707070909080a0c' +
  '140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c2' +
  '0242e2720222c231c1c2837292c30313434341f' +
  '27393d38323c2e33343200ffc0000b08000100010' +
  '10111'  +
  '00ffc4001f000001050101010101010000000000' +
  '000001020304050607080'  +
  '90a0bffc400b510000201030302040305050404' +
  '0000017d01020300041105122131410613516107' +
  '227114328191a1082342b1c11552d1f02433627' +
  '282090a161718191a2526272829'  +
  '2a343536373839'  +
  '3a434445464748494a535455565758595a636465' +
  '666768696a737475767778797a838485868788' +
  '898a929394959697989990a2a3a4a5a6a7a8a9' +
  'aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9ca' +
  'd2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9ea' +
  'f1f2f3f4f5f6f7f8f9faffda0008010100003f' +
  '00fbd4ffd9',
  'hex',
);

// Simpler fallback: just make sure first 3 bytes are FF D8 FF
const SIMPLE_JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10,
  0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9]);

// Use whichever is cleanly parseable; both pass magic bytes
const JPEG_BUF = SIMPLE_JPEG;

// ── Helpers ───────────────────────────────────────────────────────────────────
let passCount = 0;
let failCount = 0;

function assert(cond, label) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    passCount++;
  } else {
    console.error(`  FAIL  ${label}`);
    failCount++;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const BASE = `http://localhost:${process.env.SMOKE_PORT || 19977}`;
const ADMIN_KEY = 'smokeadmin';

async function api(method, path, body, headers = {}) {
  const opts = { method, headers: { ...headers } };
  if (body && typeof body === 'object' && !(body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (body instanceof FormData) {
    opts.body = body;
  }
  const resp = await fetch(`${BASE}${path}`, opts);
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: resp.status, data };
}

function makeJpegForm(clientId, taskId) {
  const fd = new FormData();
  fd.append('photo',    new Blob([JPEG_BUF], { type: 'image/jpeg' }), 'photo.jpg');
  fd.append('thumb',    new Blob([JPEG_BUF], { type: 'image/jpeg' }), 'thumb.jpg');
  fd.append('clientId', clientId);
  if (taskId) fd.append('taskId', taskId);
  return fd;
}

// ── Wait for server ───────────────────────────────────────────────────────────
async function waitForServer(retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      await fetch(`${BASE}/api/me`);
      return true;
    } catch {
      await sleep(300);
    }
  }
  return false;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpasmoke-'));
  const port    = parseInt(process.env.SMOKE_PORT || '19977');

  console.log(`\nStarting server on port ${port}, DATA_DIR=${dataDir}`);

  const server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT:        String(port),
      ADMIN_KEY,
      DATA_DIR:    dataDir,
      PHOTO_LIMIT: '3',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  server.stdout.on('data', d => process.stdout.write('[server] ' + d));
  server.stderr.on('data', d => process.stderr.write('[server] ' + d));
  server.on('error', err => { console.error('Server process error:', err); });

  const ready = await waitForServer();
  if (!ready) {
    console.error('Server did not start in time');
    server.kill();
    process.exitCode = 1;
    return;
  }

  console.log('\nServer ready. Running smoke tests...\n');

  try {
    await runTests();
  } finally {
    server.kill();
    // Cleanup temp dir
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Smoke results: ${passCount} passed, ${failCount} failed`);
  if (failCount > 0) {
    console.error('\nSome smoke tests FAILED');
    process.exitCode = 1;
  } else {
    console.log('\nAll smoke tests passed ✓');
  }
}

async function runTests() {
  // ── 1. Login as new guest ───────────────────────────────────────────────────
  console.log('── Login flow ──');
  const r1 = await api('POST', '/api/login', { name: 'Miha Novak' });
  assert(r1.status === 200 && r1.data.status === 'ok', 'Login as new guest Miha Novak');
  const token1 = r1.data.token;
  assert(typeof token1 === 'string' && token1.length >= 32, 'Got token (32+ chars)');
  const guestId1 = r1.data.guest.id;
  const authHeader1 = { 'X-Guest-Token': token1 };

  // ── 2. /api/me ──────────────────────────────────────────────────────────────
  const me1 = await api('GET', '/api/me', null, authHeader1);
  assert(me1.status === 200, '/api/me returns 200');
  assert(me1.data.remaining === 3, '/api/me remaining = 3 (PHOTO_LIMIT)');

  // ── 3. Fuzzy login flow ──────────────────────────────────────────────────────
  console.log('\n── Fuzzy login ──');

  // Case-insensitive: exact normalized match → auto-login
  const r_ci = await api('POST', '/api/login', { name: 'miha nOvak' });
  assert(r_ci.status === 200 && r_ci.data.status === 'ok', '"miha nOvak" auto-logins (exact normalized match)');
  assert(r_ci.data.guest.id === guestId1, 'Same guest returned');

  // "Novak Miha" → reversed, not equal normalized → choose
  const r_rev = await api('POST', '/api/login', { name: 'Novak Miha' });
  assert(r_rev.status === 200 && r_rev.data.status === 'choose', '"Novak Miha" returns choose');
  assert(Array.isArray(r_rev.data.candidates) && r_rev.data.candidates.length >= 1, 'Candidates array non-empty');
  assert(r_rev.data.candidates.some(c => c.id === guestId1), 'Miha Novak in candidates');

  // "Mihaa Novak" → typo → choose (not equal normalized)
  const r_typo = await api('POST', '/api/login', { name: 'Mihaa Novak' });
  assert(r_typo.status === 200 && r_typo.data.status === 'choose', '"Mihaa Novak" returns choose (typo)');

  // "Miha L" → initial → choose
  const r_init = await api('POST', '/api/login', { name: 'Miha N' });
  assert(r_init.status === 200 && r_init.data.status === 'choose', '"Miha N" returns choose (initial)');

  // "Šuštar Ana" + "Sustar Ana" diacritics
  const r_sust = await api('POST', '/api/login', { name: 'Sustar Ana' });
  assert(r_sust.status === 200 && r_sust.data.status === 'ok', 'Sustar Ana creates new guest');
  const guestId_sustar = r_sust.data.guest.id;

  // Šuštar Ana normalizes to the same string as Sustar Ana → auto-login
  const r_diac = await api('POST', '/api/login', { name: 'Šuštar Ana' });
  assert(r_diac.status === 200, '"Šuštar Ana" is recognized');
  assert(
    (r_diac.data.status === 'ok'     && r_diac.data.guest?.id === guestId_sustar) ||
    (r_diac.data.status === 'choose' && r_diac.data.candidates?.some(c => c.id === guestId_sustar)),
    '"Šuštar Ana" resolves to Sustar Ana (auto-login or choose)',
  );

  // "Ana K" must return choose (not auto-login) when "Ana Kos" exists
  const r_kos = await api('POST', '/api/login', { name: 'Ana Kos' });
  assert(r_kos.status === 200, 'Created Ana Kos');
  const r_anak = await api('POST', '/api/login', { name: 'Ana K' });
  assert(r_anak.status === 200 && r_anak.data.status === 'choose', '"Ana K" returns choose (not auto-login) when Ana Kos exists');

  // Confirm via /api/login/confirm
  const r_conf = await api('POST', '/api/login/confirm', { guestId: guestId1 });
  assert(r_conf.status === 200 && r_conf.data.status === 'ok', '/api/login/confirm works');
  assert(r_conf.data.guest.id === guestId1, 'Confirmed correct guest');

  // Single token → validation error
  const r_bad = await api('POST', '/api/login', { name: 'Miha' });
  assert(r_bad.status === 400, 'Single-token name returns 400');

  // ── 4. Upload photo ──────────────────────────────────────────────────────────
  console.log('\n── Upload ──');
  const clientId1 = randomUUID();
  const up1 = await api('POST', '/api/upload', makeJpegForm(clientId1), authHeader1);
  assert(up1.status === 200 && up1.data.ok === true, 'First upload succeeds');
  assert(up1.data.remaining === 2, 'Remaining = 2 after first upload');
  const photoId1 = up1.data.photoId;
  assert(typeof photoId1 === 'string', 'Got photoId');

  // ── 5. Idempotent upload ─────────────────────────────────────────────────────
  const up1b = await api('POST', '/api/upload', makeJpegForm(clientId1), authHeader1);
  assert(up1b.status === 200 && up1b.data.ok === true, 'Same clientId upload returns success');
  // Count must NOT increase: /api/me should still show remaining=2
  const me_idem = await api('GET', '/api/me', null, authHeader1);
  assert(me_idem.data.remaining === 2, 'Idempotent upload did not consume extra slot');
  assert(me_idem.data.photos.length === 1, 'Still 1 photo after duplicate upload');

  // ── 6. Fill up to limit ──────────────────────────────────────────────────────
  const up2 = await api('POST', '/api/upload', makeJpegForm(randomUUID()), authHeader1);
  assert(up2.status === 200 && up2.data.remaining === 1, 'Second unique upload, remaining=1');

  const up3 = await api('POST', '/api/upload', makeJpegForm(randomUUID()), authHeader1);
  assert(up3.status === 200 && up3.data.remaining === 0, 'Third unique upload, remaining=0');

  // ── 7. Reject at limit ───────────────────────────────────────────────────────
  const up4 = await api('POST', '/api/upload', makeJpegForm(randomUUID()), authHeader1);
  assert(up4.status === 400, 'Fourth upload (over limit) returns 400');
  assert(up4.data.code === 'LIMIT_EXCEEDED', 'Error code is LIMIT_EXCEEDED');

  // ── 8. Photo access control ──────────────────────────────────────────────────
  console.log('\n── Access control ──');

  // Owner can fetch their photo
  const own = await api('GET', `/photo/${photoId1}`, null, authHeader1);
  assert(own.status === 200, 'Owner can fetch their photo');

  // Another guest cannot fetch that photo
  const loginKos = await api('POST', '/api/login', { name: 'Tone Novak' });
  const token_kos = loginKos.data.token;
  const other = await api('GET', `/photo/${photoId1}`, null, { 'X-Guest-Token': token_kos });
  assert(other.status === 403, 'Different guest gets 403 for another guest\'s photo');

  // Unauthenticated gets 403
  const unauth = await api('GET', `/photo/${photoId1}`);
  assert(unauth.status === 403, 'Unauthenticated request gets 403');

  // ── 9. Admin ─────────────────────────────────────────────────────────────────
  console.log('\n── Admin ──');
  const adminH = { 'X-Admin-Key': ADMIN_KEY };

  const guests = await api('GET', '/api/admin/guests', null, adminH);
  assert(guests.status === 200 && Array.isArray(guests.data), 'Admin: get guests list');
  assert(guests.data.length >= 1, 'Admin: at least one guest');

  const mihaGuest = guests.data.find(g => g.id === guestId1);
  assert(mihaGuest !== undefined, 'Admin: Miha Novak in guest list');
  assert(mihaGuest.used === 3, `Admin: Miha has 3 photos used (got ${mihaGuest?.used})`);

  // Add 5 more to Miha's limit
  const addLim = await api('POST', `/api/admin/guests/${guestId1}/addlimit`, {}, adminH);
  assert(addLim.status === 200 && addLim.data.ok, 'Admin: +5 limit works');

  // Now Miha can upload again
  const up5 = await api('POST', '/api/upload', makeJpegForm(randomUUID()), authHeader1);
  assert(up5.status === 200, 'Miha can upload after admin raised limit');

  // Admin stats
  const stats = await api('GET', '/api/admin/stats', null, adminH);
  assert(stats.status === 200 && typeof stats.data.totalPhotos === 'number', 'Admin: stats endpoint works');

  // Wrong admin key returns 403
  const badAdmin = await api('GET', '/api/admin/guests', null, { 'X-Admin-Key': 'wrongkey' });
  assert(badAdmin.status === 403, 'Admin: wrong key returns 403');
}

main().catch(err => {
  console.error('\nSmoke test crashed:', err);
  process.exitCode = 1;
});
