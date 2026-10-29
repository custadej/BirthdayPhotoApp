'use strict';

/** Hearts, leaderboard, album order and the album page code. */

const { spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { randomUUID } = require('crypto');
const sharp = require('sharp');

const PORT = parseInt(process.env.SMOKE_PORT || '19977') + 9;
const BASE = `http://localhost:${PORT}`;
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function assert(c, label) {
  if (c) { console.log(`  PASS  ${label}`); pass++; } else { console.error(`  FAIL  ${label}`); fail++; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ADMIN = { 'X-Admin-Key': 'heartadmin' };
const jf = (p, o = {}) => fetch(BASE + p, { redirect: 'manual', ...o });

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpahearts-'));
  const server = spawn('node', [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), ADMIN_KEY: 'heartadmin', ALBUM_CODE: 'koda', DATA_DIR: dataDir, PHOTO_LIMIT: '10' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    for (let i = 0; i < 40; i++) { try { await jf('/api/config'); break; } catch { await sleep(250); } }
    const img = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#a66' } }).jpeg().toBuffer();
    const login = async name => { const r = await (await jf('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })).json(); return { id: r.guest.id, h: { 'X-Guest-Token': r.token } }; };
    const upload = async (g, caption) => {
      const fd = new FormData();
      fd.append('photo', new Blob([img]), 'p.jpg'); fd.append('clientId', randomUUID()); if (caption) fd.append('caption', caption);
      await sleep(5);   // distinct created_at
      return (await (await jf('/api/upload', { method: 'POST', headers: g.h, body: fd })).json()).photoId;
    };
    const viewer = async () => {            // a person who opened the album with the code link
      const r = await jf('/album?code=koda');
      const cookies = r.headers.getSetCookie().map(c => c.split(';')[0]);
      return { h: { Cookie: cookies.join('; ') }, cookies, raw: r.headers.getSetCookie() };
    };
    const heart = (who, photoId) => jf('/album/api/heart', { method: 'POST', headers: { 'Content-Type': 'application/json', ...who.h }, body: JSON.stringify({ photoId }) });
    const hearts = who => jf('/album/api/hearts', { headers: who.h }).then(r => r.json());

    const X = await login('Ana Xi'), Y = await login('Bor Yi'), V = await login('Cene Vi'), Z = await login('Dana Zi'), W = await login('Eva Wi');
    const x1 = await upload(X, 'prva'), x2 = await upload(X, 'druga');
    const y1 = await upload(Y), v1 = await upload(V), z1 = await upload(Z), w1 = await upload(W);

    // ── access rules ────────────────────────────────────────────────────────
    let r = await heart(Y, x1);
    assert(r.status === 401, 'no album cookie (password ON): rejected');
    const v = await viewer();
    assert(v.raw.some(c => /^viewer=[a-f0-9]{32}/.test(c) && /HttpOnly/i.test(c) && /SameSite=Lax/i.test(c) && /Max-Age=1209600/.test(c)), 'album code login also sets the viewer cookie');
    r = await heart(v, x1);
    assert(r.status === 403, 'closed album: rejected');
    await jf('/api/admin/album/toggle', { method: 'POST', headers: ADMIN });   // open

    // ── toggling ────────────────────────────────────────────────────────────
    const Yv = { h: { ...Y.h, Cookie: v.h.Cookie } };           // guest session + album cookie
    r = await (await heart(Yv, x1)).json();
    assert(r.hearted === true && r.count === 1, 'heart on');
    r = await (await heart(Yv, x1)).json();
    assert(r.hearted === false && r.count === 0, 'heart off (toggle)');
    r = await (await heart(Yv, x1)).json();
    assert(r.count === 1, 'heart on again');
    const state = await hearts(Yv);
    assert(state.counts[x1] === 1 && state.mine.join() === x1 && state.me === Y.id, 'hearts: counts, mine, me');

    // one heart per voter, two voters count 2
    r = await (await heart(Yv, x1)).json();   // toggles off again
    await heart(Yv, x1);                       // back on: still exactly one
    assert((await hearts(Yv)).counts[x1] === 1, 'one heart per voter per photo');
    const Vw = await viewer();
    r = await (await heart(Vw, x1)).json();
    assert(r.hearted && r.count === 2, 'a second voter (viewer cookie) makes it 2');
    assert((await hearts(Vw)).mine.join() === x1 && (await hearts(Vw)).me === null, 'viewer sees own hearts, has no guest id');

    // own photos
    r = await heart({ h: { ...X.h, Cookie: v.h.Cookie } }, x1);
    assert(r.status === 403, 'a guest cannot heart their own photo');
    assert((await heart(Yv, 'neobstaja')).status === 404, 'unknown photo -> 404');

    // password OFF: no album cookie needed, viewer cookie created on demand
    await jf('/api/admin/album/password', { method: 'POST', headers: ADMIN });
    r = await heart({ h: {} }, z1);
    assert(r.status === 200 && r.headers.getSetCookie().some(c => c.startsWith('viewer=')), 'password OFF: works without album cookie, creates a viewer id');
    await jf('/api/admin/album/password', { method: 'POST', headers: ADMIN });   // back ON

    // ── leaderboard ─────────────────────────────────────────────────────────
    // so far: x1 has 2 (Yv + Vw), z1 has 1 (anonymous)
    const voters = [];
    for (let i = 0; i < 4; i++) voters.push(await viewer());
    // Ana: x1(2) + x2(0)  -> add 0; Bor y1 -> 2 ; Cene v1 -> 2; Dana z1 -> 1 (+0); Eva 0
    await heart(voters[0], y1); await heart(voters[1], y1);
    await heart(voters[0], v1); await heart(voters[1], v1);
    let lb = (await hearts(voters[0])).leaderboard;
    assert(lb.map(e => e.name).join() === 'Ana Xi,Bor Yi,Cene Vi', 'leaderboard: ties -> more photos first, then name');
    assert(lb[0].hearts === 2 && lb[0].photos === 2 && lb[1].hearts === 2 && lb[1].photos === 1, 'leaderboard numbers');
    assert(lb.length === 3 && !lb.some(e => e.name === 'Eva Wi' || e.name === 'Dana Zi'), 'top 3 only, and only guests with hearts');
    await heart(voters[2], z1); await heart(voters[3], z1); await heart(voters[2], z1); await heart(voters[2], z1);
    lb = (await hearts(voters[0])).leaderboard;
    assert(lb[0].name === 'Dana Zi' && lb[0].hearts === 3, 'more hearts move a guest to the top');

    // ── removal with photos / guests ────────────────────────────────────────
    await jf(`/api/admin/photos/${z1}`, { method: 'DELETE', headers: ADMIN });
    let s2 = await hearts(voters[0]);
    assert(s2.counts[z1] === undefined && !s2.leaderboard.some(e => e.name === 'Dana Zi'), 'hearts are removed with the photo');
    await jf(`/api/admin/guests/${V.id}/reset`, { method: 'POST', headers: ADMIN });
    s2 = await hearts(voters[0]);
    assert(s2.counts[v1] === undefined, 'hearts are removed when a guest\'s photos are reset');
    await jf(`/api/admin/guests/${Y.id}`, { method: 'DELETE', headers: ADMIN });
    s2 = await hearts(voters[0]);
    assert(s2.counts[y1] === undefined && s2.counts[x1] === 1, 'guest deletion removes the photo hearts and the guest\'s own votes (x1 2 -> 1)');

    // ── admin views ─────────────────────────────────────────────────────────
    const ag = await (await jf('/api/admin/guests', { headers: ADMIN })).json();
    assert(ag.find(g => g.id === X.id).hearts === 1, 'admin guest table: hearts received');
    const ap = await (await jf(`/api/admin/guests/${X.id}/photos`, { headers: ADMIN })).json();
    assert(ap.find(p => p.id === x1).hearts === 1 && ap.find(p => p.id === x2).hearts === 0, 'admin photo grid: hearts per photo');
    const adminHtml = await (await jf('/admin', { headers: ADMIN })).text();
    assert(adminHtml.includes('<th>♥</th>') && adminHtml.includes("'♥ ' + (p.hearts || 0)"), 'admin page renders the heart column and counts');

    // ── rate limit: 120 per minute per voter ────────────────────────────────
    const rl = await viewer();
    let last = 0;
    for (let i = 0; i < 125; i++) last = (await jf('/album/api/hearts', { headers: rl.h })).status;
    assert(last === 429, 'rate limit: 121st request within a minute -> 429');
    assert((await jf('/album/api/hearts', { headers: voters[0].h })).status === 200, 'other voters are not affected');

    // ── album order (API newest first) + page code ──────────────────────────
    const list = await (await jf('/api/album/photos', { headers: voters[0].h })).json();
    assert(list.photos.every((p, i, a) => !i || a[i - 1].createdAt >= p.createdAt), 'album API: newest first');
    const page = fs.readFileSync(path.join(ROOT, 'views', 'album.html'), 'utf8');
    const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
    assert(['Najnovejše', 'Najstarejše', 'Najbolj všečne'].every(t => page.includes(`>${t}</option>`)) && /<option value="new">/.test(page), 'sort selector with the three options, "Najnovejše" first');
    assert(/let sortMode = 'new';/.test(page) && /sessionStorage\.getItem\('album_sort'\)/.test(page) && /try \{ sessionStorage\.setItem\('album_sort'/.test(page), 'default newest; choice kept in sessionStorage with try/catch');
    assert(/\(counts\[b\.id\] \|\| 0\) - \(counts\[a\.id\] \|\| 0\) \|\| newer\(a, b\)/.test(page), 'hearts sort: hearts DESC then newest');
    assert(!page.includes('Najbolj všečno večera') && !page.includes('Pokaži najbolj všečne slike') && !page.includes('top-card') && !page.includes('show-top'), 'the "Najbolj všečno večera" card is gone from the album');
    assert(page.includes('<option value="hearts">Najbolj všečne</option>'), 'sorting by hearts is still available');
    assert(/setInterval\(\(\) => \{ if \(!document\.hidden\) refreshHearts\(\); \}, 30000\)/.test(page), 'counts refresh every 30 s');
    assert(/stopPropagation/.test(page) && /'touchstart', 'touchend', 'click'/.test(page), 'heart button does not trigger swipe/close');
    assert(/touch-action: manipulation/.test(css) && /min-height: 56px; height: 56px/.test(css) && /function likesText/.test(page) && /'všečki'/.test(page) && /likesText\(n\) : 'Všečkaj'/.test(page) && /\.lightbox \.lb-heart \{ position: absolute; right: 8px; bottom: 8px/.test(css), '56px heart button at the bottom right with the count inside ("4 všečki")');
    assert(page.includes('Svoje slike ne moreš všečkati') && /\$\('lb-heart'\)\.disabled = own/.test(page), 'own photos: disabled with a hint');
    assert(/badge\.hidden = n === 0/.test(page) && /\.card-heart \{ position: absolute; right: 8px; bottom: 8px/.test(css), 'grid cards: count in the bottom-right corner only when > 0');
    assert(/rollback|roll back/.test(page) && /counts\[p\.id\] = wasCount/.test(page), 'optimistic toggle with rollback');
    assert(!page.includes('innerHTML'), 'album page has no innerHTML');
    assert(/fill: #E0343F/.test(css) && /\.card-heart svg \{ fill: #E0343F/.test(css), 'hearts are red (#E0343F), filled when hearted and on the grid cards');
  } finally {
    server.kill();
  }
  console.log(`\nHearts results: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
