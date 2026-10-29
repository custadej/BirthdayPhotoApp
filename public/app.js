'use strict';

// Labels and UploadCore (shared modules) are loaded before this file.

let PHOTO_LIMIT = 15;

// ── Session ───────────────────────────────────────────────────────────────────
const SESSION_KEY = 'guest_session';
const FIRST_CAPTION = 'Moja prva slika';
const USED_TASKS_KEY = 'used_tasks';
const CUR_TASK_KEY   = 'current_task';

function saveSession(token, displayName) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify({ token, displayName })); } catch {}
}

function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
}

function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch {}
  document.cookie = 'gid=; Max-Age=0; path=/';
}

async function authFetch(url, opts = {}) {
  const session = loadSession();
  const headers = { ...(opts.headers || {}) };
  if (session?.token) headers['X-Guest-Token'] = session.token;
  return fetch(url, { ...opts, headers });
}

// ── Slovenian plurals ─────────────────────────────────────────────────────────
function remainingText(n) {
  if (n === 1) return 'Še 1 slika';
  if (n === 2) return 'Še 2 sliki';
  if (n === 3 || n === 4) return `Še ${n} slike`;
  return `Še ${n} slik`;
}

// ── Tasks (fetched from the server; no repeats until all are used) ──────────────
let tasks = [];
let currentTask = null;

function lsGet(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

async function loadTasks() {
  try {
    const resp = await authFetch('/api/tasks');
    if (resp.ok) tasks = await resp.json();
  } catch {}
  // keep the task shown before a reload, if it is still active
  const cur = lsGet(CUR_TASK_KEY, null);
  currentTask = availableTasks().find(t => t.id === cur) || null;
  if (!currentTask) nextTask();
}

// Tasks the guest can still earn a bonus with: not completed, not already queued.
function availableTasks() {
  const queued = new Set(queue.map(i => Number(i.taskId)).filter(n => !Number.isNaN(n)));
  return tasks.filter(t => !completedIds.includes(t.id) && !queued.has(t.id));
}

function nextTask() {
  const avail = availableTasks();
  if (!avail.length) { currentTask = null; lsSet(CUR_TASK_KEY, null); return null; }
  let used = lsGet(USED_TASKS_KEY, []).filter(id => avail.some(t => t.id === id));
  let pool = avail.filter(t => !used.includes(t.id));
  if (!pool.length) {            // all shown: start over, but not with the task just shown
    used = [];
    pool = avail.filter(t => avail.length === 1 || !currentTask || t.id !== currentTask.id);
  }
  currentTask = pool[Math.floor(Math.random() * pool.length)];
  used.push(currentTask.id);
  lsSet(USED_TASKS_KEY, used);
  lsSet(CUR_TASK_KEY, currentTask.id);
  return currentTask;
}

// ── State ─────────────────────────────────────────────────────────────────────
let guestName      = null;
let remaining      = 0;
let bonus          = 0;
let completedIds   = [];   // task ids the guest has completed (each gave +1 photo)
let photosTaken    = false;
let capture        = null;   // { file, url, taskId } while on the preview screen
let captureMode    = 'any';  // 'task' | 'any' for the next file chosen
let albumOpenNow   = false;
let albumAllowed   = false;   // album open AND at least one stored photo
let btnAlbum       = null;    // only exists in the DOM while albumAllowed

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const screens = ['screen-login', 'screen-choose', 'screen-main', 'screen-preview'];

const nameInput      = $('name-input');
const nameError      = $('name-error');
const btnLogin       = $('btn-login');
const candidatesList = $('candidates-list');
const btnNewPerson   = $('btn-new-person');
const greeting       = $('greeting');
const counter        = $('counter');
const firstBlock     = $('first-block');
const afterFirst     = $('after-first');
const thumbsSection  = $('thumbs-section');
const taskTextEl     = $('task-text');
const fileInput      = $('file-input');
const btnCamera      = $('btn-camera');
const uploadStatus   = $('upload-status');
const pendingList    = $('pending-list');
const successCard    = $('success-card');
const finishedMsg    = $('finished-msg');
const thumbStrip     = $('thumb-strip');
const btnLogout      = $('btn-logout');
const previewImg     = $('preview-img');
const captionInput   = $('caption-input');
const previewStatus  = $('preview-status');
const btnSend        = $('btn-send');
const btnDiscard     = $('btn-discard');

function showScreen(id) {
  for (const s of screens) $(s).classList.toggle('active', s === id);
  window.scrollTo(0, 0);
}

// ── Login flow ────────────────────────────────────────────────────────────────
let pendingName = '';

async function doLogin(name) {
  nameError.style.display = 'none';
  btnLogin.disabled = true;
  btnLogin.textContent = '...';

  try {
    const resp = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await resp.json();

    if (!resp.ok) {
      showNameError(data.error || 'Napaka pri prijavi');
      return;
    }
    if (data.status === 'ok') {
      handleLoginSuccess(data);
    } else if (data.status === 'choose') {
      pendingName = name;
      showChooseScreen(data.candidates);
    }
  } catch {
    showNameError('Napaka omrežja. Poskusi znova.');
  } finally {
    btnLogin.disabled = false;
    btnLogin.textContent = 'Naprej';
  }
}

function showNameError(msg) {
  nameError.textContent = msg;
  nameError.style.display = 'block';
}

function showChooseScreen(candidates) {
  candidatesList.replaceChildren();
  for (const c of candidates) {
    const btn = document.createElement('button');
    btn.className = 'btn-candidate';
    btn.textContent = `Sem ${c.displayName}`;
    btn.addEventListener('click', () => confirmGuest(c.id));
    candidatesList.appendChild(btn);
  }
  showScreen('screen-choose');
}

async function confirmGuest(guestIdToConfirm) {
  try {
    const resp = await fetch('/api/login/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guestId: guestIdToConfirm }),
    });
    const data = await resp.json();
    if (data.status === 'ok') handleLoginSuccess(data);
  } catch {
    alert('Napaka. Poskusi znova.');
  }
}

async function confirmNewPerson() {
  if (!pendingName) { showScreen('screen-login'); return; }
  try {
    const resp = await fetch('/api/login/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newName: true, name: pendingName }),
    });
    const data = await resp.json();
    if (data.status === 'ok') {
      handleLoginSuccess(data);
    } else {
      showScreen('screen-login');
      showNameError(data.error || 'Napaka');
    }
  } catch {
    alert('Napaka. Poskusi znova.');
  }
}

function handleLoginSuccess(data) {
  meLoaded = false;
  saveSession(data.token, data.guest.displayName);
  guestName = data.guest.displayName;
  loadMainScreen();
}

// ── Main screen ───────────────────────────────────────────────────────────────
const itemsById = new Map();

let meLoaded = false;
let meRetryTimer = null;

async function loadMainScreen() {
  showScreen('screen-main');
  $('offline-note').style.display = 'none';
  thumbStrip.replaceChildren();
  itemsById.clear();

  try {
    const resp = await authFetch('/api/me');
    if (resp.status === 401) { logout(); return; }   // only a rejected session logs out
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const me = await resp.json();
    meLoaded = true;
    guestName = me.name;
    remaining = me.remaining;
    bonus = me.bonus || 0;
    completedIds = me.completedTaskIds || [];
    albumAllowed = !!me.albumAllowed;
    albumOpenNow = !!me.albumOpen;

    greeting.textContent = `Živjo, ${me.name.split(' ')[0]}!`;
    btnLogout.textContent = `Odjava - nisem ${me.name}`;
    updateCounter();

    photosTaken = me.items.length > 0;
    for (const item of me.items) addThumb(item);
    for (const it of queue) if (it.el) thumbStrip.prepend(it.el);   // photos still on their way
    await loadTasks();
    updateMainLayout();
    await restoreQueue();
  } catch {
    // Network problem on load (e.g. after a refresh on a bad connection): the guest stays
    // logged in, unsent photos are restored from the phone and sending resumes by itself.
    const saved = loadSession();
    if (saved?.displayName && !guestName) guestName = saved.displayName;
    if (guestName) {
      greeting.textContent = `Živjo, ${guestName.split(' ')[0]}!`;
      btnLogout.textContent = `Odjava - nisem ${guestName}`;
    }
    $('offline-note').style.display = '';
    await restoreQueue();
    clearTimeout(meRetryTimer);
    meRetryTimer = setTimeout(() => { if (!meLoaded) loadMainScreen(); }, 5000);
  }
}

function updateCounter() {
  const left = effectiveRemaining();   // server's number minus photos still on their way
  counter.textContent = left <= 0 ? 'Nič slik' : remainingText(left);
  counter.classList.toggle('empty', left <= 0);
}

// One place decides what the main screen shows.
function updateMainLayout() {
  const finished = remaining <= 0;             // the server is the source of truth
  const started = photosTaken || queue.length > 0;
  const noneLeft = effectiveRemaining() <= 0;  // everything left is already queued
  const hasTask = !!currentTask;
  // With 0 photos left a photo for a NEW task is still accepted (it gives its slot back),
  // so only "Slikaj nalogo" stays usable; "Slikaj karkoli" is switched off.
  btnCamera.disabled = noneLeft;
  $('btn-any-photo').disabled = noneLeft;
  $('btn-any-photo').style.display = noneLeft ? 'none' : '';
  $('btn-task-photo').disabled = noneLeft && !hasTask;
  firstBlock.style.display = !started && !finished ? '' : 'none';   // big SLIKAJ: first photo only
  afterFirst.style.display = started && (!finished || hasTask) ? '' : 'none';
  $('task-card').style.display = hasTask ? '' : 'none';
  for (const el of document.querySelectorAll('.task-only')) el.style.display = hasTask ? '' : 'none';
  if (hasTask) taskTextEl.textContent = currentTask.text;
  $('task-bonus').style.display = hasTask ? '' : 'none';
  finishedMsg.textContent = hasTask
    ? 'Porabil/a si vse slike. Najprej reši kakšno nalogo: slikaj nalogo in dobiš sliko nazaj!'
    : 'Porabil/a si vse slike. Hvala, da si del večera!\nSlike boš videl/a jutri. 🎉';
  finishedMsg.style.display = finished ? '' : 'none';
  thumbsSection.style.display = thumbStrip.children.length ? '' : 'none';
  renderAlbumButton();
}

// The album button is created only when allowed, never rendered with 0 photos.
function renderAlbumButton() {
  if (!albumAllowed) {
    if (btnAlbum) { btnAlbum.remove(); btnAlbum = null; }
    return;
  }
  if (btnAlbum) return;
  btnAlbum = document.createElement('button');
  btnAlbum.id = 'btn-album';
  btnAlbum.className = 'btn-album';
  btnAlbum.textContent = 'Poglej si celoten album';
  btnAlbum.addEventListener('click', openAlbum);
  $('screen-main').insertBefore(btnAlbum, document.querySelector('#screen-main .footer'));
}

async function openAlbum() {
  btnAlbum.disabled = true;
  try {
    const resp = await fetch('/api/album-session', { method: 'POST', headers: authHeaders() });
    if (resp.ok) { location.href = '/album'; return; }
    if (resp.status === 403) { albumAllowed = false; albumOpenNow = false; updateMainLayout(); return; }
  } catch {}
  btnAlbum.disabled = false;
}

// ── Image processing ──────────────────────────────────────────────────────────
// Output: one JPEG, long edge <= 1600 px, under ~400 KB when possible. Drawing
// through a canvas strips EXIF and bakes in the orientation.
async function decodeViaImage(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error('Image load failed'));
    img.src = url;
  });
  const size = UploadCore.fitSize(img.naturalWidth, img.naturalHeight);
  return { source: img, ...size, close: () => URL.revokeObjectURL(url) };
}

// createImageBitmap can decode straight to the small size (much less memory
// than a full 12 MP bitmap). Anything unexpected falls back to Image + canvas.
async function decodeScaled(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const head = new Uint8Array(await file.slice(0, 262144).arrayBuffer());
      const disp = UploadCore.displaySize(UploadCore.parseJpegInfo(head));
      if (disp) {
        const t = UploadCore.fitSize(disp.width, disp.height);
        const bmp = await createImageBitmap(file, {
          resizeWidth: t.width, resizeHeight: t.height, resizeQuality: 'medium', imageOrientation: 'from-image',
        });
        // wrong aspect = the browser ignored orientation or resize: use the safe path
        if (Math.abs(bmp.width / bmp.height - disp.width / disp.height) < 0.02) {
          return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
        }
        bmp.close();
      }
    } catch {}
  }
  return decodeViaImage(file);
}

async function processFile(file, decoder = decodeScaled) {
  const dec = await decoder(file);
  const canvas = document.createElement('canvas');
  try {
    canvas.width = dec.width;
    canvas.height = dec.height;
    canvas.getContext('2d').drawImage(dec.source, 0, 0, dec.width, dec.height);
    return await UploadCore.encodeAdaptive(q => new Promise((resolve, reject) => {
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/jpeg', q);
    }));
  } finally {
    dec.close();
    canvas.width = canvas.height = 0;
  }
}

// ── Upload queue ──────────────────────────────────────────────────────────────
// Items: { clientId, caption, taskId, blob, state, progress, rounds, nextAt, ... }
// state: processing | queued | uploading | retrying | failed. One upload at a
// time (parallel uploads only slow each other down on a weak link). The same
// clientId is used on every attempt, so the server never stores a photo twice.
let queue     = [];
let uploading = null;
let pumpTimer = null;

function authHeaders() {
  const session = loadSession();
  return session?.token ? { 'X-Guest-Token': session.token } : {};
}

// The response may have been lost although the server stored the photo.
async function checkStored(clientId) {
  try {
    const resp = await fetch(`/api/upload/status/${encodeURIComponent(clientId)}`, {
      headers: authHeaders(), cache: 'no-store',
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.stored ? { ok: true, ...data } : null;
  } catch {
    return null;
  }
}

// XMLHttpRequest for real upload progress. No total timeout: it is aborted only
// when nothing moved for STALL_MS.
function uploadXhr(it) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('photo', it.blob, 'photo.jpg');
    fd.append('clientId', it.clientId);
    if (it.caption) fd.append('caption', it.caption);
    if (it.taskId)  fd.append('taskId', String(it.taskId));

    const xhr = new XMLHttpRequest();
    it.xhr = xhr;
    xhr.open('POST', '/api/upload');
    for (const [k, v] of Object.entries(authHeaders())) xhr.setRequestHeader(k, v);

    let lastProgress = Date.now();
    let stalled = false;
    const touch = () => { lastProgress = Date.now(); };
    const timer = setInterval(() => {
      if (UploadCore.isStalled(lastProgress, Date.now())) { stalled = true; xhr.abort(); }
    }, 2000);
    const done = () => { clearInterval(timer); it.xhr = null; };

    const startedAt = Date.now();
    xhr.upload.onprogress = e => {
      touch();
      if (e.lengthComputable) {
        it.progress = UploadCore.percent(e.loaded, e.total);
        it.eta = UploadCore.etaSeconds(e.loaded, e.total, Date.now() - startedAt);
        renderItem(it);
      }
    };
    xhr.upload.onload = touch;
    xhr.onprogress = touch;
    xhr.onload = () => {
      done();
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && data.ok !== false) return resolve(data);
      if (data.code === 'LIMIT_EXCEEDED') return reject(Object.assign(new Error('LIMIT_EXCEEDED'), { code: 'LIMIT_EXCEEDED' }));
      reject(Object.assign(new Error(data.error || `HTTP ${xhr.status}`), { status: xhr.status }));
    };
    xhr.onerror   = () => { done(); reject(new Error('network')); };
    xhr.onabort   = () => { done(); reject(Object.assign(new Error(stalled ? 'stalled' : 'aborted'), { aborted: !stalled })); };
    xhr.send(fd);
  });
}

// IndexedDB keeps unsent photos across a reload or a killed browser.
// If it is unavailable the in-memory queue still works.
let idbPromise = null;
function openIdb() {
  if (!idbPromise) {
    idbPromise = new Promise(resolve => {
      try {
        const req = indexedDB.open('photo-uploads', 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains('pending')) req.result.createObjectStore('pending', { keyPath: 'clientId' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = req.onblocked = () => resolve(null);
      } catch { resolve(null); }
    });
  }
  return idbPromise;
}

async function idbDo(mode, fn) {
  try {
    const db = await openIdb();
    if (!db) return undefined;
    return await new Promise(resolve => {
      const tx = db.transaction('pending', mode);
      const r = fn(tx.objectStore('pending'));
      tx.oncomplete = () => resolve(r && r.result);
      tx.onerror = tx.onabort = () => resolve(undefined);
    });
  } catch { return undefined; }
}

const idbPut    = it => idbDo('readwrite', s => s.put({
  clientId: it.clientId, token: loadSession()?.token || null,
  blob: it.blob, caption: it.caption, taskId: it.taskId, createdAt: it.createdAt,
}));
const idbDelete = id => idbDo('readwrite', s => s.delete(id));
const idbAll    = () => idbDo('readonly', s => s.getAll());

function pendingCount() { return UploadCore.pendingCost(queue, completedIds); }

function effectiveRemaining() { return UploadCore.effectiveRemaining(remaining, pendingCount()); }

function itemBadgeText(it) {
  if (it.state === 'processing') return 'Obdelujem…';
  if (it.state === 'uploading')  return UploadCore.progressText(it.progress, it.eta);
  if (it.state === 'retrying' || it.state === 'failed') return 'Čakam na povezavo…';
  return 'Čaka…';
}

function renderItem(it) {
  if (!queue.includes(it)) return; // late progress event of a finished/removed item
  if (!it.el) {
    const el = document.createElement('div');
    el.className = 'thumb-pending';
    it.img = document.createElement('img');
    it.img.alt = 'Slika se pošilja';
    it.badge = document.createElement('div');
    it.badge.className = 'badge';
    const bar = document.createElement('div');
    bar.className = 'bar';
    it.barFill = document.createElement('span');
    bar.appendChild(it.barFill);
    el.append(it.img, it.badge, bar);
    thumbStrip.prepend(el);
    it.el = el;
  }
  if (it.blob && !it.url) { it.url = URL.createObjectURL(it.blob); it.img.src = it.url; }
  it.badge.textContent = itemBadgeText(it);
  it.barFill.style.width = (it.state === 'uploading' ? it.progress : 0) + '%';
  renderErrorBox(it);
  renderQueueStatus();
}

// Red box only after ERROR_ROUNDS failed rounds (or a permanent server refusal).
function renderErrorBox(it) {
  const show = it.rounds >= UploadCore.ERROR_ROUNDS;
  if (show && !it.errEl) {
    const div = document.createElement('div');
    div.className = 'pending-item';
    const msg = document.createElement('p');
    msg.textContent = '⚠️ Slika ni bila poslana. Ne zapri tega okna!';
    const btn = document.createElement('button');
    btn.className = 'btn-retry';
    btn.addEventListener('click', () => retryNow(it));
    div.append(msg, btn);
    pendingList.appendChild(div);
    it.errEl = div;
    it.retryBtn = btn;
  }
  if (!show && it.errEl) { it.errEl.remove(); it.errEl = it.retryBtn = null; }
  if (it.retryBtn) {
    it.retryBtn.disabled = it.state === 'uploading';
    it.retryBtn.textContent = it.state === 'uploading' ? UploadCore.progressText(it.progress, it.eta) : 'Poskusi znova';
  }
}

function renderQueueStatus() {
  document.getElementById('pending-bar').style.display = queue.length ? '' : 'none';
  const active = uploading;
  const preparing = !active && queue.find(i => i.state === 'processing');
  const el = $('upload-status-text');
  uploadStatus.style.display = active || preparing ? '' : 'none';
  if (active) {
    el.textContent = UploadCore.progressText(active.progress, active.eta);
    $('upload-status-bar').style.width = active.progress + '%';
  } else if (preparing) {
    el.textContent = 'Pripravljam sliko…';
    $('upload-status-bar').style.width = '0%';
  }
}

function removeItem(it) {
  if (it.xhr) it.xhr.abort();
  queue = queue.filter(q => q !== it);
  if (it.el) it.el.remove();
  if (it.errEl) it.errEl.remove();
  if (it.url) URL.revokeObjectURL(it.url);
  it.el = it.errEl = null;
  idbDelete(it.clientId);
}

function schedulePump() {
  clearTimeout(pumpTimer);
  const waits = queue.filter(i => i.state === 'retrying').map(i => i.nextAt);
  if (!waits.length) return;
  pumpTimer = setTimeout(pump, Math.max(0, Math.min(...waits) - Date.now()));
}

function pump() {
  if (uploading) return;
  const now = Date.now();
  const it = queue.find(i => i.blob && (i.state === 'queued' || i.state === 'retrying') && i.nextAt <= now);
  if (!it) { schedulePump(); return; }
  runItem(it);
}

async function runItem(it) {
  uploading = it;
  it.state = 'uploading';
  it.progress = 0;
  it.eta = null;
  renderItem(it);
  try {
    const result = await uploadXhr(it);
    finishItem(it, result);
  } catch (err) {
    if (!queue.includes(it)) { /* removed meanwhile (logout) */ }
    else if (err.code === 'LIMIT_EXCEEDED') {
      removeItem(it);
      remaining = 0;
      refreshCounter();
    } else {
      const stored = await checkStored(it.clientId); // before any error: maybe it arrived
      if (stored) finishItem(it, stored);
      else failRound(it, err);
    }
  } finally {
    uploading = null;
    renderQueueStatus();
    refreshCounter();
    pump();
  }
}

function failRound(it, err) {
  if (err && UploadCore.isPermanentStatus(err.status)) {
    it.rounds = UploadCore.ERROR_ROUNDS;      // retrying cannot help; wait for the button
    it.state = 'failed';
    it.nextAt = Infinity;
  } else {
    it.rounds++;
    it.state = 'retrying';
    it.nextAt = Date.now() + UploadCore.backoffDelay(it.rounds);
  }
  renderItem(it);
  schedulePump();
}

function retryNow(it) {
  it.rounds = 0;
  it.state = 'queued';
  it.nextAt = 0;
  renderItem(it);
  pump();
}

function finishItem(it, result) {
  removeItem(it);
  onUploaded(result, it);
}

function retryAllNow() {
  for (const it of queue) if (it.state === 'retrying') it.nextAt = 0;
  pump();
}

function enqueue(it) {
  queue.push(it);
  renderItem(it);
  refreshCounter();
}

// Item whose processing may still be running; uploads as soon as the blob exists.
async function enqueueCapture(cap, caption) {
  const it = {
    clientId: newClientId(), caption, taskId: cap.taskId, blob: null, createdAt: Date.now(),
    state: 'processing', progress: 0, rounds: 0, nextAt: 0,
  };
  enqueue(it);
  try {
    it.blob = await cap.processing;
  } catch {
    removeItem(it);
    refreshCounter();
    reportClientError('enqueue-process', 'processing rejected', null);
    flashMainError('Slike ni bilo mogoče obdelati. Poskusi še enkrat.');
    return;
  }
  if (!queue.includes(it)) return; // logged out meanwhile
  it.state = 'queued';
  renderItem(it);
  idbPut(it);
  pump();
}

async function restoreQueue() {
  const token = loadSession()?.token;
  const records = (await idbAll()) || [];
  let restored = 0;
  for (const rec of records) {
    if (!token || rec.token !== token || queue.some(q => q.clientId === rec.clientId)) continue;
    if (await checkStored(rec.clientId)) { idbDelete(rec.clientId); continue; }
    restored++;
    enqueue({
      clientId: rec.clientId, caption: rec.caption, taskId: rec.taskId, blob: rec.blob, createdAt: rec.createdAt,
      state: 'queued', progress: 0, rounds: 0, nextAt: 0,
    });
  }
  if (restored) $('pending-bar').textContent = 'Neposlana slika je shranjena na telefonu in se zdaj pošilja. Počakaj, da se konča.';
  updateMainLayout();
  pump();
}

// ── Capture → preview → send ──────────────────────────────────────────────────
// While the camera app is open (or just closed) the page must never reload itself,
// or the chosen photo is lost and the guest lands back on "SLIKAJ".
let cameraOpenUntil = 0;

function startCapture(mode) {
  const taskIsFree = mode === 'task' && !!currentTask;   // accepted at 0 too: gives the slot back
  if (effectiveRemaining() <= 0 && !taskIsFree) return;
  captureMode = mode;
  cameraOpenUntil = Date.now() + 5 * 60 * 1000;
  fileInput.click();
}

// Several fallbacks so a phone that cannot use the fast path still sends something;
// every failure is reported to the server (client-errors.log) so it can be diagnosed.
async function processRobust(file) {
  try {
    return await processFile(file);
  } catch (e1) {
    reportClientError('process', e1, file);
    try {
      return await processFile(file, decodeViaImage);
    } catch (e2) {
      reportClientError('process-fallback', e2, file);
      if (/jpe?g/i.test(file.type) && file.size <= 12 * 1024 * 1024) return file; // send the original
      throw e2;
    }
  }
}

// crypto.randomUUID() exists only in secure contexts (https). A guest who opens the
// plain http:// address would crash here, so build the id from getRandomValues instead.
function newClientId() {
  try { if (typeof crypto.randomUUID === 'function') return crypto.randomUUID(); } catch {}
  const b = new Uint8Array(16);
  try { crypto.getRandomValues(b); } catch { for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256); }
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

let clientErrorsSent = 0;
// Safari's stack has no message, so put name and message first.
function describeError(err) {
  if (err && typeof err === 'object') return `${err.name || 'Error'}: ${err.message || ''}\n${err.stack || ''}`;
  return String(err);
}

function reportClientError(stage, err, file) {
  if (clientErrorsSent++ >= 8) return;
  try {
    fetch('/api/client-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        stage, message: describeError(err).slice(0, 600),
        ua: navigator.userAgent, type: file && file.type, size: file && file.size,
      }),
    }).catch(() => {});
  } catch {}
}
window.addEventListener('error', e => reportClientError('window-error', e.error || e.message));
window.addEventListener('unhandledrejection', e => reportClientError('unhandled-rejection', e.reason));

function showPreview(file) {
  const useTask = captureMode === 'task' && !!currentTask;
  capture = {
    file,
    url: null,
    useTask,
    taskId: useTask ? currentTask.id : null,
    processing: processRobust(file),   // starts now, while the guest writes the caption
  };
  capture.processing.catch(() => {}); // handled when "Pošlji" is pressed
  // The preview shows the small processed photo, not the full camera file: decoding a 12 MP
  // image next to the resize can run a phone out of memory and reload the page.
  const cap = capture;
  previewImg.removeAttribute('src');
  const showUrl = blob => {
    if (capture !== cap) return;
    cap.url = URL.createObjectURL(blob);
    previewImg.src = cap.url;
    setStatus('');
  };
  cap.processing.then(showUrl, () => showUrl(file));
  // "Slikaj nalogo": prefill the caption with the task label (editable).
  // Very first photo of the guest: prefill "Moja prva slika" in gray (real text, selected on focus).
  // Otherwise empty with the placeholder.
  const firstPhoto = !photosTaken && !queue.length && !useTask;
  captionInput.classList.toggle('prefill-gray', firstPhoto);
  captionInput.value = useTask ? (currentTask.label || currentTask.text || '').slice(0, 140)
                               : (firstPhoto ? FIRST_CAPTION : '');
  setStatus('Pripravljam sliko…');
  btnSend.disabled = false;
  btnDiscard.disabled = false;
  showScreen('screen-preview');
}

function leavePreview() {
  if (capture && capture.url) URL.revokeObjectURL(capture.url);
  previewImg.removeAttribute('src');
  capture = null;
}

// "Pošlji": the photo joins the queue and the guest is back on the main screen at once.
function sendCapture() {
  if (!capture) return;
  const cap = capture;
  const caption = Labels.cleanCaption(captionInput.value);
  hideSuccess();
  setStatus('');
  leavePreview();
  showScreen('screen-main');
  enqueueCapture(cap, caption);   // joins the queue at once (before its first await)
  if (cap.taskId) nextTask();     // so the queued task is no longer offered
  updateMainLayout();
}

let pendingBonusNote = false;   // a finished upload completed a task; shown when the queue is empty

function onUploaded(result, job) {
  remaining = result.remaining;
  if (typeof result.bonus === 'number') bonus = result.bonus;
  if (Array.isArray(result.completedTaskIds)) completedIds = result.completedTaskIds;
  if (result.bonusGranted) pendingBonusNote = true;
  if (currentTask && completedIds.includes(currentTask.id)) nextTask();
  photosTaken = true;
  albumAllowed = albumOpenNow; // now has a stored photo

  addThumb({
    id: result.photoId, ordinal: result.ordinal, caption: result.caption,
    taskText: result.taskText, taskLabel: result.taskLabel,
  });
  if (!queue.length) { showSuccess(pendingBonusNote); pendingBonusNote = false; }
  refreshCounter();
}

function refreshCounter() {
  updateCounter();
  updateMainLayout();
  renderQueueStatus();
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function setStatus(msg) {
  previewStatus.textContent = msg;
  previewStatus.style.display = msg ? '' : 'none';
}

// Short message in the main-screen status box (it also shows upload progress).
function flashMainError(msg) {
  $('upload-status-text').textContent = msg;
  $('upload-status-bar').style.width = '0%';
  uploadStatus.style.display = '';
  setTimeout(renderQueueStatus, 15000);
}

function addThumb(item, prepend = true) {
  if (itemsById.has(item.id)) return;
  itemsById.set(item.id, item);
  const img = document.createElement('img');
  img.src     = `/thumb/${item.id}`;
  img.alt     = 'Moja slika';
  img.loading = 'lazy';
  img.addEventListener('click', () => openViewer(item));
  if (prepend) {   // stored photos go after the ones still being sent
    const first = [...thumbStrip.children].find(c => !c.classList.contains('thumb-pending'));
    thumbStrip.insertBefore(img, first || null);
  } else thumbStrip.append(img);
}

// "Slika poslana ✓": fades out and disappears after 10 s; a new upload clears the timers.
let successTimers = [];
function hideSuccess() {
  successTimers.forEach(clearTimeout);
  successTimers = [];
  successCard.style.display = 'none';
  successCard.classList.remove('fade');
}

function showSuccess(bonusGranted) {
  hideSuccess();
  successCard.textContent = bonusGranted
    ? 'Slika poslana ✓ Naloga opravljena, dobiš +1 sliko!'
    : 'Slika poslana ✓';
  successCard.style.display = '';
  successTimers.push(setTimeout(() => successCard.classList.add('fade'), 9000));
  successTimers.push(setTimeout(hideSuccess, 10000));
}

// ── Fullscreen viewer ─────────────────────────────────────────────────────────
function openViewer(item) {
  $('viewer-img').src = `/photo/${item.id}`;
  const d = Labels.describe({ ...item, name: guestName });
  $('viewer-label').textContent = d.label;
  $('viewer-task').textContent  = d.task;
  $('viewer').hidden = false;
}

function closeViewer() {
  $('viewer').hidden = true;
  $('viewer-img').removeAttribute('src');
}

$('viewer-close').addEventListener('click', closeViewer);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeViewer(); });

// ── Logout ────────────────────────────────────────────────────────────────────
function logout() {
  meLoaded = false;
  clearSession();
  showScreen('screen-login');
  thumbStrip.replaceChildren();
  itemsById.clear();
  photosTaken    = false;
  for (const it of [...queue]) removeItem(it);
  uploading = null;
  pendingList.replaceChildren();
  renderQueueStatus();
  hideSuccess();
  finishedMsg.style.display = 'none';
  firstBlock.style.display  = 'none';
  afterFirst.style.display  = 'none';
  thumbsSection.style.display = 'none';
  counter.textContent = '';
  albumAllowed = false;
  albumOpenNow = false;
  renderAlbumButton();
  tasks = [];
  currentTask = null;
  bonus = 0;
  completedIds = [];
  pendingBonusNote = false;
  try { localStorage.removeItem(USED_TASKS_KEY); localStorage.removeItem(CUR_TASK_KEY); } catch {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Event listeners ───────────────────────────────────────────────────────────
btnLogin.addEventListener('click', () => {
  const name = nameInput.value.trim();
  if (!name) { showNameError('Vpiši svoje ime in priimek.'); return; }
  doLogin(name);
});

nameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') btnLogin.click();
});

btnNewPerson.addEventListener('click', confirmNewPerson);

btnCamera.addEventListener('click', () => startCapture('any'));
$('btn-any-photo').addEventListener('click', () => startCapture('any'));
$('btn-task-photo').addEventListener('click', () => startCapture('task'));

$('btn-next-task').addEventListener('click', () => {
  nextTask();
  taskTextEl.textContent = currentTask.text;
});

fileInput.addEventListener('change', e => {
  const file = e.target.files[0];
  e.target.value = '';
  cameraOpenUntil = 0;
  if (file) showPreview(file);
});

captionInput.addEventListener('focus', () => {
  if (captionInput.classList.contains('prefill-gray')) setTimeout(() => captionInput.select(), 0);
});
captionInput.addEventListener('input', () => captionInput.classList.remove('prefill-gray'));

btnSend.addEventListener('click', sendCapture);

window.addEventListener('online', retryAllNow);
setInterval(pump, 15000); // resume anything that is due (backoff is kept)
window.addEventListener('beforeunload', e => {
  if (!queue.length) return;
  e.preventDefault();
  e.returnValue = '';
});

btnDiscard.addEventListener('click', () => {
  const mode = captureMode;
  leavePreview();
  showScreen('screen-main');
  startCapture(mode);
});

btnLogout.addEventListener('click', () => {
  let msg = `Odjava - nisem ${guestName}.\n\nSi prepričan/a?`;
  if (queue.length > 0) {
    msg = 'Imaš neposlane slike, ki bodo izgubljene.\n\n' + msg;
  }
  if (confirm(msg)) logout();
});

// ── Session restore ───────────────────────────────────────────────────────────
async function init() {
  try {
    const cfg = await fetch('/api/config').then(r => r.json());
    PHOTO_LIMIT = cfg.photoLimit;
  } catch {}
  $('limit-display').textContent = PHOTO_LIMIT;

  const session = loadSession();
  if (session?.token) {
    guestName = session.displayName || null;
    // loadMainScreen decides: a rejected session (401) logs out, a network error does not
    loadMainScreen();
    return;
  }

  showScreen('screen-login');
}

init();

// ── Stale page check ──────────────────────────────────────────────────────────
// A page left open keeps running old code. When the server has a newer version and
// nothing is being sent or written, reload to pick it up.
const LOADED_VERSION = (document.querySelector('meta[name="app-version"]') || {}).content;
async function checkVersion() {
  if (!LOADED_VERSION || queue.length || uploading || capture || Date.now() < cameraOpenUntil) return;
  try {
    const v = await fetch('/api/version', { cache: 'no-store' }).then(r => r.json());
    if (v.version && v.version !== LOADED_VERSION && !queue.length && !uploading && !capture && Date.now() >= cameraOpenUntil) location.reload();
  } catch {}
}
setInterval(checkVersion, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkVersion(); });
window.addEventListener('online', checkVersion);
