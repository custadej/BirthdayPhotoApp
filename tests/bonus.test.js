'use strict';

/** Task bonus photos, end to end. */

const { spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { randomUUID } = require('crypto');
const sharp = require('sharp');

const PORT = parseInt(process.env.SMOKE_PORT || '19977') + 8;
const BASE = `http://localhost:${PORT}`;
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function assert(c, label) {
  if (c) { console.log(`  PASS  ${label}`); pass++; } else { console.error(`  FAIL  ${label}`); fail++; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ADMIN = { 'X-Admin-Key': 'bonusadmin' };
const jsonH = { ...ADMIN, 'Content-Type': 'application/json' };

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpabonus-'));
  const server = spawn('node', [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), ADMIN_KEY: 'bonusadmin', ALBUM_CODE: 'x', DATA_DIR: dataDir, PHOTO_LIMIT: '2' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    for (let i = 0; i < 40; i++) { try { await fetch(`${BASE}/api/config`); break; } catch { await sleep(250); } }
    const img = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#668' } }).jpeg().toBuffer();
    const login = async name => { const r = await (await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })).json(); return { id: r.guest.id, h: { 'X-Guest-Token': r.token } }; };
    const upload = async (g, extra = {}, clientId = randomUUID()) => {
      const fd = new FormData();
      fd.append('photo', new Blob([img]), 'p.jpg'); fd.append('clientId', clientId);
      for (const [k, v] of Object.entries(extra)) fd.append(k, v);
      const r = await fetch(`${BASE}/api/upload`, { method: 'POST', headers: g.h, body: fd });
      return { status: r.status, ...(await r.json()) };
    };
    const me = async g => (await fetch(`${BASE}/api/me`, { headers: g.h })).json();
    const tasks = await (await fetch(`${BASE}/api/tasks`, { headers: (await login('Prva Gostja')).h })).json();
    const [T1, T2, T3] = tasks;

    // ── first task, same task, second task ──────────────────────────────────
    const a = await login('Ana Bonus');
    let r = await upload(a, { taskId: T1.id });
    assert(r.ok && r.bonusGranted === true && r.bonus === 1 && r.remaining === 2 && r.completedTaskIds.join() === String(T1.id), 'first task photo: +1 bonus, remaining unchanged (net free)');
    r = await upload(a, { taskId: T1.id });
    assert(r.ok && r.bonusGranted === false && r.bonus === 1 && r.remaining === 1, 'same task twice: no extra bonus');
    r = await upload(a, { taskId: T2.id });
    assert(r.ok && r.bonusGranted === true && r.bonus === 2 && r.remaining === 1, 'second different task: +2 in total');
    let m = await me(a);
    assert(m.remaining === 1 && m.bonus === 2 && m.limit === 2 && m.completedTaskIds.length === 2, '/api/me: remaining, bonus, completedTaskIds, base limit');

    // ── 0 slots left ────────────────────────────────────────────────────────
    const b = await login('Bor Brez');
    await upload(b); await upload(b);
    r = await upload(b);
    assert(r.status === 400 && r.code === 'LIMIT_EXCEEDED', 'guest with 0 slots: a plain photo is rejected');
    r = await upload(b, { taskId: T3.id });
    assert(r.ok && r.bonusGranted && r.remaining === 0 && r.bonus === 1, 'guest with 0 slots: a photo for a new task is accepted (net free, still 0 left)');
    r = await upload(b, { taskId: T3.id });
    assert(r.status === 400 && r.code === 'LIMIT_EXCEEDED', 'the same task again at 0 is rejected');
    r = await upload(b, { taskId: T2.id });
    assert(r.ok && r.bonus === 2 && r.remaining === 0, 'another new task at 0 works too');
    m = await me(b);
    assert(m.remaining === 0 && m.bonus === 2 && m.items.length === 4, 'photos taken, 0 left, bonus 2');

    // ── idempotent retry ────────────────────────────────────────────────────
    const c = await login('Cene Retry');
    const cid = randomUUID();
    const first = await upload(c, { taskId: T1.id }, cid);
    const again = await upload(c, { taskId: T1.id }, cid);
    assert(first.bonus === 1 && again.bonus === 1 && again.remaining === first.remaining && again.photoId === first.photoId, 'idempotent retry never double counts');
    assert(again.bonusGranted === true, 'a retried first-task upload still reports the bonus');
    const st = await (await fetch(`${BASE}/api/upload/status/${cid}`, { headers: c.h })).json();
    assert(st.stored && st.bonus === 1 && st.bonusGranted === true && st.remaining === first.remaining, 'upload status reports bonus too');
    assert((await me(c)).items.length === 1, 'still one photo after the retry');

    // ── soft-deleted tasks still count ──────────────────────────────────────
    const d = await login('Dana Brisana');
    await upload(d, { taskId: T1.id });
    await fetch(`${BASE}/api/admin/tasks/${T1.id}`, { method: 'DELETE', headers: ADMIN });
    m = await me(d);
    assert(m.bonus === 1 && m.completedTaskIds.includes(T1.id), 'deleting the task afterwards keeps the bonus');
    r = await upload(d, { taskId: T1.id });
    assert(r.ok && r.bonusGranted === false && r.bonus === 1, 'uploading to a soft-deleted task is accepted, no second bonus');
    await fetch(`${BASE}/api/admin/tasks/${T2.id}`, { method: 'DELETE', headers: ADMIN });
    r = await upload(d, { taskId: T2.id });
    assert(r.ok && r.bonusGranted === true && r.bonus === 2, 'a task deleted BEFORE the photo still gives a bonus');

    // ── caption-only photos never give a bonus ──────────────────────────────
    const e = await login('Eva Opis');
    r = await upload(e, { caption: 'brez naloge' });
    assert(r.bonus === 0 && r.bonusGranted === false && r.remaining === 1, 'no task, no bonus');

    // ── admin ───────────────────────────────────────────────────────────────
    const adminGuests = await (await fetch(`${BASE}/api/admin/guests`, { headers: ADMIN })).json();
    const ga = adminGuests.find(g => g.id === a.id);
    assert(ga.used === 3 && ga.limit === 2 && ga.bonus === 2, 'admin guest list: used, base limit, bonus');
    await fetch(`${BASE}/api/admin/guests/${a.id}/addlimit`, { method: 'POST', headers: ADMIN });
    const ga2 = (await (await fetch(`${BASE}/api/admin/guests`, { headers: ADMIN })).json()).find(g => g.id === a.id);
    assert(ga2.limit === 7 && ga2.bonus === 2, '"+5 slik" raises the base limit only');
    assert((await me(a)).remaining === 7 + 2 - 3, 'remaining = limit + bonus - used');
    const admin = await (await fetch(`${BASE}/admin`, { headers: ADMIN })).text();
    assert(admin.includes("' bonus)'") && admin.includes("g.used + ' / ' + g.limit + ' (+' + g.bonus"), 'admin table renders "{used} / {limit} (+{bonus} bonus)"');

    // ── client code ─────────────────────────────────────────────────────────
    const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    const home = await (await fetch(`${BASE}/`)).text();
    assert(/availableTasks\(\)/.test(app) && /!completedIds\.includes\(t\.id\)/.test(app), 'task picker skips completed tasks');
    assert(/if \(!avail\.length\) \{ currentTask = null;/.test(app), 'all tasks completed -> no task, only "Slikaj karkoli"');
    assert(home.includes('id="task-bonus"') && home.includes('+1 slika bonus'), 'task card shows "+1 slika bonus"');
    assert(app.includes('Slika poslana ✓ Naloga opravljena, dobiš +1 sliko!') && /setTimeout\(hideSuccess, 10000\)/.test(app), 'bonus notice, still fades after 10 s');
    assert(home.includes('Lahko pa rešuješ tudi naloge, ki ti jih bomo ponudili. Za vsako rešeno nalogo dobiš eno sliko več.'), 'welcome text mentions the bonus');
    assert(/UploadCore\.pendingCost\(queue, completedIds\)/.test(app), 'camera check nets queued task photos to zero');
    assert(/const taskIsFree = mode === 'task' && !!currentTask;/.test(app) && /effectiveRemaining\(\) <= 0 && !taskIsFree/.test(app), 'camera: "Slikaj nalogo" works at 0 left');
    assert(app.includes('Porabil/a si vse slike. Najprej reši kakšno nalogo: slikaj nalogo in dobiš sliko nazaj!'), 'message at 0 tells the guest to solve a task first');
    assert(/\$\('btn-any-photo'\)\.style\.display = noneLeft \? 'none' : ''/.test(app) && /\$\('btn-task-photo'\)\.disabled = noneLeft && !hasTask/.test(app), 'at 0 only "Slikaj nalogo" stays; "Slikaj karkoli" is hidden');
    assert(!app.includes('innerHTML'), 'no innerHTML in the guest app');
  } finally {
    server.kill();
  }
  console.log(`\nBonus results: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
