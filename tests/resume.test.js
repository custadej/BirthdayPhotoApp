'use strict';

/** Refresh / bad connection behaviour of the guest app (static checks) + version meta served by the server. */

const { spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

const PORT = parseInt(process.env.SMOKE_PORT || '19977') + 6;
const BASE = `http://localhost:${PORT}`;
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function assert(c, label) {
  if (c) { console.log(`  PASS  ${label}`); pass++; } else { console.error(`  FAIL  ${label}`); fail++; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bparesume-'));
  const server = spawn('node', [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), ADMIN_KEY: 'x', ALBUM_CODE: 'y', DATA_DIR: dataDir },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    for (let i = 0; i < 40; i++) { try { await fetch(`${BASE}/api/config`); break; } catch { await sleep(250); } }
    const home = await (await fetch(`${BASE}/`)).text();
    const ver = await (await fetch(`${BASE}/api/version`)).json();
    assert(home.includes(`<meta name="app-version" content="${ver.version}">`), 'guest page carries its version in a meta tag');
    assert(home.includes('id="offline-note"') && home.includes('Tvoje slike so varno shranjene na telefonu'), 'offline note in the markup');

    const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    assert(/if \(resp\.status === 401\) \{ logout\(\); return; \}/.test(app), 'only a rejected session (401) logs the guest out');
    assert(!/clearSession\(\);\s*\}\s*\n\s*showScreen\('screen-login'\)/.test(app), 'init no longer clears the session on a network error');
    assert(/meRetryTimer = setTimeout\(\(\) => \{ if \(!meLoaded\) loadMainScreen\(\); \}, 5000\)/.test(app), 'retries loading the guest data every 5 s while offline');
    assert(/catch \{[\s\S]{0,700}await restoreQueue\(\)/.test(app), 'unsent photos are restored from the phone even when /api/me fails');
    assert(app.includes('Neposlana slika je shranjena na telefonu in se zdaj pošilja'), 'restored photos get a clear message');
    assert(/for \(const it of queue\) if \(it\.el\) thumbStrip\.prepend\(it\.el\)/.test(app), 'photos in the queue survive a reload of the guest data');
    assert(/setInterval\(checkVersion, 30000\)/.test(app) && /location\.reload\(\)/.test(app) && /queue\.length \|\| uploading \|\| capture/.test(app), 'stale open pages reload themselves when idle');
    assert(/cameraOpenUntil = Date\.now\(\) \+ 5 \* 60 \* 1000/.test(app) && /Date\.now\(\) < cameraOpenUntil\) return;/.test(app) && /Date\.now\(\) >= cameraOpenUntil\) location\.reload/.test(app), 'no self-reload while the camera app is open');
    assert(/e\.target\.value = '';\s*cameraOpenUntil = 0;/.test(app), 'camera guard released when the photo arrives');
    assert(/processing: processRobust\(file\)/.test(app) && /processFile\(file, decodeViaImage\)/.test(app) && /return file; \/\/ send the original/.test(app), 'processing has two fallbacks, last one sends the original JPEG');
    assert(/previewImg\.removeAttribute\('src'\)/.test(app) && /cap\.url = URL\.createObjectURL\(blob\)/.test(app) && !/previewImg\.src = URL\.createObjectURL\(file\)/.test(app), 'preview shows the small processed photo, not the full camera file');
    assert(/addEventListener\('unhandledrejection'/.test(app) && /\/api\/client-log/.test(app), 'client errors are reported to the server');
    assert(!app.includes('innerHTML'), 'no innerHTML');
    const g = await (await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Test Phone' }) })).json();
    const body = JSON.stringify({ stage: 'process', message: 'boom', ua: 'Android test', type: 'image/jpeg', size: 1234 });
    const anon = await fetch(`${BASE}/api/client-log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    assert(anon.status === 401, 'client-log needs a guest');
    const ok = await fetch(`${BASE}/api/client-log`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Guest-Token': g.token }, body });
    await sleep(200);
    const logFile = path.join(dataDir, 'client-errors.log');
    const rec = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, 'utf8').trim().split('\n').pop()) : {};
    assert(ok.status === 200 && rec.stage === 'process' && rec.message === 'boom' && rec.guestId === g.guest.id && rec.ua === 'Android test', 'client-log writes client-errors.log');
  } finally {
    server.kill();
  }
  console.log(`\nResume results: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
