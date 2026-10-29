'use strict';

require('dotenv').config();

const express      = require('express');
const cookieParser = require('cookie-parser');
const multer       = require('multer');
const path         = require('path');
const fs           = require('fs');
const crypto       = require('crypto');
const { randomUUID, randomBytes } = crypto;
const archiver     = require('archiver');

const sharp        = require('sharp');
const { createThumbService } = require('./lib/thumbs');

const db           = require('./lib/db');
const { normalize, namesMatch, validateName } = require('./lib/names');
const Labels       = require('./lib/labels');
const Quota        = require('./lib/quota');
const { EVENT_TITLE, EVENT_BADGE, escapeHtml } = require('./lib/event');
const { createLimiter } = require('./lib/ratelimit');

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT         = parseInt(process.env.PORT  || '3000');
const ADMIN_KEY    = process.env.ADMIN_KEY       || 'changeme';
const PHOTO_LIMIT  = parseInt(process.env.PHOTO_LIMIT || '15');
const DATA_DIR     = path.resolve(process.env.DATA_DIR || './data');
const APP_VERSION = 'v17';
const TOO_MANY     = 'Preveč poskusov. Poskusi čez nekaj minut.';
const PUBLIC_URL   = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');

// Initialize database
db.init(DATA_DIR, PHOTO_LIMIT);

// Album code: .env wins, otherwise generated once and kept in the DB.
let ALBUM_CODE = process.env.ALBUM_CODE;
if (!ALBUM_CODE) {
  ALBUM_CODE = db.getSetting('album_code');
  if (!ALBUM_CODE) {
    ALBUM_CODE = randomBytes(9).toString('base64url');
    db.setSetting('album_code', ALBUM_CODE);
    console.log(`[album] Generated ALBUM_CODE: ${ALBUM_CODE}`);
  }
}
const sha = str => crypto.createHash('sha256').update(str).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(String(a)), sha(String(b)));
// Album code is compared trimmed and case-insensitively (phones autocapitalize).
const normCode = c => String(c).trim().toLowerCase();
const ALBUM_COOKIE_VALUE = sha(`album:${normCode(ALBUM_CODE)}`).toString('hex');
const ADMIN_COOKIE_VALUE = sha(`admin:${ADMIN_KEY}`).toString('hex');
const adminLimiter = createLimiter();
const albumLimiter = createLimiter();
const clientIp = req => req.headers['cf-connecting-ip'] || req.ip;
const CARDS_DIR  = path.join(DATA_DIR, 'cards');
const MEDIUM_DIR = path.join(DATA_DIR, 'medium');
fs.mkdirSync(CARDS_DIR,  { recursive: true });
fs.mkdirSync(MEDIUM_DIR, { recursive: true });

// ─── App setup ────────────────────────────────────────────────────────────────

const app = express();
app.set('trust proxy', 1); // behind Cloudflare Tunnel / nginx

// Guests who type the address without https land on http://. There the browser hides
// secure-context APIs (crypto.randomUUID, share) and uploads crash, so send them to https.
app.use((req, res, next) => {
  let scheme = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  try { scheme = JSON.parse(req.headers['cf-visitor'] || '{}').scheme || scheme; } catch {}
  if (scheme !== 'http') return next();
  const host = (req.headers.host || '').split(':')[0];
  if (!host || host === 'localhost' || host === '127.0.0.1') return next();
  res.redirect(req.method === 'GET' || req.method === 'HEAD' ? 301 : 308, `https://${req.headers.host}${req.originalUrl}`);
});
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: false, limit: '12mb' }));
app.use(cookieParser());

// Phones kept stale html/js/css: always revalidate (ETag), except big photo files.
app.use((req, res, next) => {
  if (!/^\/(photo|thumb|album\/(photo|thumb|card))\//.test(req.path)) res.set('Cache-Control', 'no-cache');
  next();
});

function renderView(file, extra = {}) {
  const [first, ...rest] = EVENT_TITLE.split(' ');
  const vars = {
    EVENT_TITLE: escapeHtml(EVENT_TITLE),
    TITLE_MAIN:  escapeHtml(first),
    TITLE_SUB:   escapeHtml(rest.join(' ')),
    EVENT_BADGE_HTML: EVENT_BADGE ? `<div class="fifty" aria-hidden="true">${escapeHtml(EVENT_BADGE)}</div>` : '',
    APP_VERSION,
    ...extra,
  };
  return fs.readFileSync(path.join(__dirname, 'views', file), 'utf8')
    .replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

app.get(['/', '/index.html'], (req, res) => res.type('html').send(renderView('guest.html')));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Shared modules (also used by the browser)
app.get('/lib/labels.js', (req, res) => res.sendFile(path.join(__dirname, 'lib', 'labels.js')));
app.get('/lib/upload-core.js', (req, res) => res.sendFile(path.join(__dirname, 'lib', 'upload-core.js')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setGuestCookie(res, req, token) {
  const secure = req.protocol === 'https';
  res.cookie('gid', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 2 * 24 * 60 * 60 * 1000,
    secure,
  });
}

function getGuestFromRequest(req) {
  const token = req.cookies.gid || req.headers['x-guest-token'];
  if (!token) return null;
  return db.getGuestByToken(token);
}

function requireGuest(req, res, next) {
  const guest = getGuestFromRequest(req);
  if (!guest) return res.status(401).json({ error: 'Niste prijavljeni' });
  req.guest = guest;
  next();
}

/**
 * Admin check. Valid cookie, or a key in X-Admin-Key / ?key= (rate limited:
 * wrong keys count as failures, correct ones never do). Memoized per request.
 */
function isAdmin(req) {
  if (req._isAdmin !== undefined) return req._isAdmin;
  const cookie = req.cookies.admin;
  if (typeof cookie === 'string' && safeEq(cookie, ADMIN_COOKIE_VALUE)) return (req._isAdmin = true);
  const key = req.headers['x-admin-key'] ?? req.query.key;
  if (key === undefined) return (req._isAdmin = false);
  const ip = clientIp(req);
  if (adminLimiter.isBlocked(ip)) { req._blocked = true; return (req._isAdmin = false); }
  if (safeEq(key, ADMIN_KEY)) return (req._isAdmin = true);
  adminLimiter.fail(ip);
  return (req._isAdmin = false);
}

function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  if (req._blocked) return res.status(429).json({ error: TOO_MANY });
  return res.status(403).json({ error: 'Forbidden' });
}

function setAdminCookie(req, res) {
  res.cookie('admin', ADMIN_COOKIE_VALUE, {
    httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600_000, secure: req.protocol === 'https',
  });
}

function albumOpen() {
  return db.getSetting('album_open') === '1';
}

function albumDownloadAll() {
  return db.getSetting('album_download_all') === '1'; // default: OFF
}

function albumPasswordOn() {
  return db.getSetting('album_password') !== '0'; // default: ON
}

function setViewerCookie(req, res, id) {
  res.cookie('viewer', id, {
    httpOnly: true, sameSite: 'lax', maxAge: 14 * 24 * 3600_000, secure: req.protocol === 'https',
  });
}

const VIEWER_RE = /^[a-f0-9]{32}$/;

function setAlbumCookie(req, res) {
  res.cookie('album', ALBUM_COOKIE_VALUE, {
    httpOnly: true, sameSite: 'lax', maxAge: 14 * 24 * 3600_000, secure: req.protocol === 'https',
  });
  // anonymous voter identity for hearts (people who open the album with the code link)
  if (!VIEWER_RE.test(req.cookies.viewer || '')) setViewerCookie(req, res, randomBytes(16).toString('hex'));
}

/** Who is voting: a guest session, else the random viewer cookie (created when missing). */
function voterOf(req, res) {
  const guest = getGuestFromRequest(req);
  if (guest) return { key: 'g:' + guest.id, guestId: guest.id };
  let v = req.cookies.viewer;
  if (!VIEWER_RE.test(v || '')) { v = randomBytes(16).toString('hex'); setViewerCookie(req, res, v); }
  return { key: 'v:' + v, guestId: null };
}

/** { photoId: n } and hearts received per guest. */
function heartsByGuest(counts) {
  const out = {};
  for (const p of db.getAllPhotos()) out[p.guest_id] = (out[p.guest_id] || 0) + (counts[p.id] || 0);
  return out;
}

/** Admin, or password switched off, or a valid album cookie. */
function hasAlbumAccess(req) {
  return isAdmin(req) || !albumPasswordOn() || hasAlbumCookie(req);
}

function hasAlbumCookie(req) {
  const c = req.cookies.album;
  return typeof c === 'string' && safeEq(c, ALBUM_COOKIE_VALUE);
}

function codeMatches(code) {
  return typeof code === 'string' && safeEq(normCode(code), normCode(ALBUM_CODE));
}

/** Album API access: admin always, otherwise valid cookie AND album open. */
function requireAlbum(req, res, next) {
  if (isAdmin(req)) return next();
  if (!hasAlbumAccess(req)) return res.status(401).json({ error: 'Album je zaklenjen' });
  if (!albumOpen()) return res.status(403).json({ error: 'Album še ni odprt' });
  next();
}

function photoFiles(photo) {
  const dir = path.join(DATA_DIR, 'photos', photo.guest_id);
  return { full: path.join(dir, `${photo.id}.jpg`), thumb: path.join(dir, `${photo.id}_thumb.jpg`) };
}

// Thumb (900px) and medium (1280px) are made by the server, not the phone:
// asynchronously after the upload response, and lazily when first requested.
const thumbs = createThumbService({ sharp, concurrency: 2 });

function mediumPath(photo) { return path.join(MEDIUM_DIR, `${photo.id}.jpg`); }

/** Path of a servable thumb: generated on demand, the original if that fails. */
async function getThumb(photo) {
  const f = photoFiles(photo);
  if (fs.existsSync(f.thumb)) return f.thumb;
  try {
    return await thumbs.thumb(f.full, f.thumb, { priority: true });
  } catch (err) {
    console.error('[thumb]', photo.id, String(err.message).split('\n')[0]);
    return f.full;
  }
}

/** Background generation after the response; skipped if the photo is gone meanwhile. */
function queueDerivatives(photo) {
  const f = photoFiles(photo);
  const still = () => !!db.getPhoto(photo.id);
  const run = (make, src, dest) => {
    if (fs.existsSync(dest)) return;
    make(src, dest).then(() => { if (!still()) { try { fs.unlinkSync(dest); } catch {} } })
      .catch(err => console.error('[derive]', photo.id, String(err.message).split('\n')[0]));
  };
  run(thumbs.thumb, f.full, f.thumb);
  run(thumbs.medium, f.full, mediumPath(photo));
}

function removePhotoFiles(photo) {
  const f = photoFiles(photo);
  for (const file of [f.full, f.thumb, path.join(CARDS_DIR, `${photo.id}.jpg`), path.join(MEDIUM_DIR, `${photo.id}.jpg`)]) {
    try { fs.unlinkSync(file); } catch {}
  }
}

/** { label, task } for a photo row, per the shared label rules. */
function describePhoto(p, name) {
  return Labels.describe({
    caption: p.caption, ordinal: p.ordinal, name, taskText: p.task_text, taskLabel: p.task_label,
  });
}

function photoItem(p) {
  return { id: p.id, ordinal: Number.isInteger(p.ordinal) && p.ordinal > 0 ? p.ordinal : 1, caption: p.caption, taskText: p.task_text, taskLabel: p.task_label };
}

/** Task for an upload: by id (also soft-deleted/inactive), else by exact text (old clients). */
function resolveTask(body) {
  let t = null;
  if (body.taskId !== undefined && /^\d+$/.test(String(body.taskId))) t = db.getTask(Number(body.taskId));
  if (!t && typeof body.taskText === 'string' && body.taskText.trim()) t = db.getTaskByText(body.taskText.trim());
  return t;
}

function canAccessPhoto(req, photo) {
  if (isAdmin(req)) return true;
  const guest = getGuestFromRequest(req);
  return !!(guest && photo.guest_id === guest.id);
}

/** Unique display name: if "Name" exists already, return "Name (2)", etc. */
function uniqueDisplayName(rawName) {
  const existing = db.getAllGuests().map(g => g.display_name);
  if (!existing.includes(rawName)) return rawName;
  let n = 2;
  while (existing.includes(`${rawName} (${n})`)) n++;
  return `${rawName} (${n})`;
}

/** Find matching guests for a normalized input name */
function findCandidates(normInput) {
  // a row with a missing normalized_name must not break everybody's login
  return db.getAllGuests().filter(g => namesMatch(normInput, g.normalized_name || normalize(g.display_name || '')));
}

// ─── Guest routes ─────────────────────────────────────────────────────────────

app.post('/api/login', (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Manjka ime' });
  }

  if (!validateName(name)) {
    return res.status(400).json({
      error: 'Vpiši ime in priimek (priimek je lahko samo začetnica)',
    });
  }

  const normInput = normalize(name);
  const candidates = findCandidates(normInput);

  if (candidates.length === 0) {
    // Create a new guest
    const displayName = uniqueDisplayName(name.trim());
    const normName    = normalize(displayName);
    const token       = randomBytes(16).toString('hex');
    const guest       = db.createGuest({
      id: randomUUID(),
      displayName,
      normalizedName: normName,
      token,
      photoLimit: PHOTO_LIMIT,
    });
    setGuestCookie(res, req, token);
    return res.json({
      status: 'ok',
      token,
      guest: { id: guest.id, displayName: guest.display_name },
    });
  }

  // Exactly one match AND the normalized strings are identical → auto-login
  if (candidates.length === 1 && candidates[0].normalized_name === normInput) {
    const guest = candidates[0];
    setGuestCookie(res, req, guest.token);
    return res.json({
      status: 'ok',
      token: guest.token,
      guest: { id: guest.id, displayName: guest.display_name },
    });
  }

  // Otherwise show candidate picker
  return res.json({
    status: 'choose',
    candidates: candidates.map(g => ({ id: g.id, displayName: g.display_name })),
  });
});

app.post('/api/login/confirm', (req, res) => {
  const { guestId, newName, name } = req.body;

  if (newName === true) {
    // User confirmed they are new
    if (!name || !validateName(name)) {
      return res.status(400).json({
        error: 'Vpiši ime in priimek (priimek je lahko samo začetnica)',
      });
    }
    const displayName = uniqueDisplayName(name.trim());
    const token       = randomBytes(16).toString('hex');
    const guest       = db.createGuest({
      id: randomUUID(),
      displayName,
      normalizedName: normalize(displayName),
      token,
      photoLimit: PHOTO_LIMIT,
    });
    setGuestCookie(res, req, token);
    return res.json({
      status: 'ok',
      token,
      guest: { id: guest.id, displayName: guest.display_name },
    });
  }

  if (!guestId) return res.status(400).json({ error: 'Manjka guestId' });
  const guest = db.getGuest(guestId);
  if (!guest) return res.status(404).json({ error: 'Gost ne obstaja' });

  setGuestCookie(res, req, guest.token);
  return res.json({
    status: 'ok',
    token: guest.token,
    guest: { id: guest.id, displayName: guest.display_name },
  });
});

app.get('/api/me', requireGuest, (req, res) => {
  const g = req.guest;
  const photos = db.getPhotosByGuest(g.id);
  const q = db.getQuota(g.id);
  res.json({
    name:      g.display_name,
    remaining: q.remaining,            // limit + bonus - used
    limit:     g.photo_limit,
    bonus:     q.bonus,
    completedTaskIds: q.completedTaskIds,
    photos:    photos.map(p => p.id),
    items:     photos.map(photoItem),
    albumOpen: albumOpen(),
    albumAllowed: albumOpen() && photos.length > 0, // album button: open AND at least 1 stored photo
  });
});

app.get('/api/config', (req, res) => {
  res.json({ photoLimit: PHOTO_LIMIT });
});

app.get('/api/version', (req, res) => res.json({ version: APP_VERSION }));

app.get('/api/tasks', requireGuest, (req, res) => {
  res.json(db.getTasks({ activeOnly: true }).map(t => ({ id: t.id, text: t.text, label: t.label })));
});

// Append-only log of failed uploads: time, guest, status, error, request size.
const UPLOAD_LOG = path.join(DATA_DIR, 'upload-errors.log');
function logUploadFailure(req, res, status = res.statusCode) {
  const line = JSON.stringify({
    time:    new Date().toISOString(),
    guestId: req.guest ? req.guest.id : null,
    status,
    error:   res.locals.uploadError || null,
    bytes:   parseInt(req.headers['content-length'] || '0') || null,
  }) + '\n';
  fs.appendFile(UPLOAD_LOG, line, () => {});
}

// Append-only log of successful uploads: time, guest, bytes, server-side duration.
const UPLOAD_OK_LOG = path.join(DATA_DIR, 'upload.log');
function logUploadSuccess(req, bytes, startedAt, extra = {}) {
  const line = JSON.stringify({
    time:    new Date().toISOString(),
    guestId: req.guest ? req.guest.id : null,
    bytes,
    ms:      Date.now() - startedAt,
    ...extra,
  }) + '\n';
  fs.appendFile(UPLOAD_OK_LOG, line, () => {});
}

function uploadErrorLogger(req, res, next) {
  req._uploadStart = Date.now(); // before the body is received, so ms covers a slow upload
  const json = res.json.bind(res);
  res.json = body => {
    if (body && body.error) res.locals.uploadError = body.error;
    return json(body);
  };
  res.on('finish', () => { if (res.statusCode >= 400) logUploadFailure(req, res); });
  res.on('close', () => {
    if (!res.writableFinished) {
      res.locals.uploadError = res.locals.uploadError || 'connection closed before response';
      logUploadFailure(req, res, 0);
    }
  });
  next();
}

// Client-side problems (decode/resize failures, JS errors) so odd phones can be diagnosed.
let clientLogCount = 0;
app.post('/api/client-log', requireGuest, (req, res) => {
  if (clientLogCount++ > 500) return res.json({ ok: true });
  const b = req.body || {};
  const cut = (v, n) => (v == null ? null : String(v).slice(0, n));
  const line = JSON.stringify({
    time: new Date().toISOString(), guestId: req.guest.id, stage: cut(b.stage, 60),
    message: cut(b.message, 600), ua: cut(b.ua, 300), type: cut(b.type, 60), size: Number(b.size) || null,
  }) + '\n';
  fs.appendFile(path.join(DATA_DIR, 'client-errors.log'), line, () => {});
  res.json({ ok: true });
});

// Lets the client check whether an upload whose response got lost was stored.
/** True when this photo was the first one that completed its task (it gave the bonus). */
function bonusGrantedFor(photo) {
  const key = Quota.photoKey(photo);
  if (key === null) return false;
  const first = db.getPhotosByGuest(photo.guest_id).find(p => Quota.photoKey(p) === key);
  return !!first && first.id === photo.id;
}

app.get('/api/upload/status/:clientId', requireGuest, (req, res) => {
  const photo = db.getPhotoByClientId(req.params.clientId);
  if (!photo || photo.guest_id !== req.guest.id) return res.json({ stored: false });
  const q = db.getQuota(req.guest.id);
  res.json({
    stored: true, remaining: q.remaining, bonus: q.bonus, completedTaskIds: q.completedTaskIds,
    bonusGranted: bonusGrantedFor(photo), photoId: photo.id,
    ...photoItem(photo),
  });
});

app.post('/api/upload',
  uploadErrorLogger,
  requireGuest,
  upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'thumb', maxCount: 1 }]), // thumb: old clients only
  (req, res) => {
    const { clientId } = req.body;
    const task    = resolveTask(req.body); // snapshotted into the photo row
    const caption = task ? Labels.captionForTask(req.body.caption, task.label) : Labels.cleanCaption(req.body.caption);
    const taskText  = task ? task.text  : null;
    const taskLabel = task ? task.label : null;
    const photoFile = req.files?.photo?.[0];
    const thumbFile = req.files?.thumb?.[0];

    if (!photoFile) {
      return res.status(400).json({ error: 'Manjka slika' });
    }
    if (!clientId) {
      return res.status(400).json({ error: 'Manjka clientId' });
    }

    // Verify JPEG magic bytes: FF D8 FF
    const buf = photoFile.buffer;
    if (buf.length < 3 || buf[0] !== 0xFF || buf[1] !== 0xD8 || buf[2] !== 0xFF) {
      return res.status(400).json({ error: 'Neveljavna slika (mora biti JPEG)' });
    }

    // Idempotency: if clientId already stored, return success without consuming a slot
    const existing = db.getPhotoByClientId(clientId);
    if (existing) {
      const q = db.getQuota(req.guest.id);
      logUploadSuccess(req, photoFile.size, req._uploadStart, { duplicate: true });
      return res.json({
        ok: true, remaining: q.remaining, bonus: q.bonus, completedTaskIds: q.completedTaskIds,
        bonusGranted: bonusGrantedFor(existing), photoId: existing.id, ...photoItem(existing),
      });
    }

    const photoId  = randomUUID();
    const guestDir = path.join(DATA_DIR, 'photos', req.guest.id);
    fs.mkdirSync(guestDir, { recursive: true });

    let result;
    try {
      result = db.createPhoto(
        {
          id:        photoId,
          guestId:   req.guest.id,
          clientId,
          taskId:    task ? String(task.id) : null,
          caption,
          taskText,
          taskLabel,
          createdAt: Date.now(),
        },
        req.guest.photo_limit,
      );
    } catch (err) {
      if (err.code === 'PHOTO_LIMIT_EXCEEDED') {
        return res.status(400).json({
          error: 'Porabili ste vse slike za večer',
          code:  'LIMIT_EXCEEDED',
        });
      }
      throw err;
    }

    // Write files after the DB insert; if that fails, roll the row back so
    // "stored" never refers to a photo without files.
    try {
      fs.writeFileSync(path.join(guestDir, `${photoId}.jpg`),       photoFile.buffer);
      if (thumbFile) fs.writeFileSync(path.join(guestDir, `${photoId}_thumb.jpg`), thumbFile.buffer);
    } catch (err) {
      db.deletePhoto(photoId);
      removePhotoFiles({ id: photoId, guest_id: req.guest.id });
      throw err;
    }

    res.json({
      ok: true, remaining: result.remaining, bonus: result.bonus, completedTaskIds: result.completedTaskIds,
      bonusGranted: result.bonusGranted, photoId,
      ordinal: result.ordinal, caption, taskText, taskLabel,
    });
    logUploadSuccess(req, photoFile.size, req._uploadStart);
    // after the response, so the phone is never kept waiting for sharp
    res.on('finish', () => queueDerivatives({ id: photoId, guest_id: req.guest.id }));
  },
);

app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'Slika je prevelika (največ 12 MB)', code: 'TOO_LARGE' });
  }
  if (res.headersSent) return next(err);
  console.error('[error]', req.method, req.path, err);
  const status = err && err.status >= 400 && err.status < 600 ? err.status : 500;
  res.status(status).json({ error: err && err.message ? err.message : 'Napaka strežnika' });
});

// Photo serving — only owner or admin
app.get('/photo/:id', (req, res) => {
  const photo = db.getPhoto(req.params.id);
  if (!photo) return res.status(404).end();
  if (!canAccessPhoto(req, photo)) return res.status(403).end();
  const filePath = path.join(DATA_DIR, 'photos', photo.guest_id, `${photo.id}.jpg`);
  res.sendFile(filePath);
});

app.get('/thumb/:id', async (req, res) => {
  const photo = db.getPhoto(req.params.id);
  if (!photo) return res.status(404).end();
  if (!canAccessPhoto(req, photo)) return res.status(403).end();
  res.sendFile(await getThumb(photo));
});

// ─── Admin routes ─────────────────────────────────────────────────────────────

function adminLoginPage(error) {
  return PAGE_HEAD + `<h1>Admin</h1>
<form method="post" action="/admin/login">
<input class="name-input" type="password" name="password" autocomplete="current-password" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Geslo" autofocus>
${error ? `<div class="error-msg">${escapeHtml(error)}</div>` : ''}
<button class="btn-primary" type="submit">Prijava</button></form>` + PAGE_FOOT;
}

function tooManyPage() {
  return PAGE_HEAD + `<h1>${escapeHtml(EVENT_TITLE)}</h1><p>${TOO_MANY}</p>` + PAGE_FOOT;
}

// Admin page. A valid ?key= sets the cookie and redirects so the key leaves the URL.
app.get('/admin', (req, res) => {
  if (req.query.key !== undefined) {
    if (isAdmin(req)) {
      setAdminCookie(req, res);
      return res.redirect('/admin');
    }
    if (req._blocked) return res.status(429).send(tooManyPage());
    return res.status(403).send(adminLoginPage('Napačno geslo.'));
  }
  if (!isAdmin(req)) return res.send(adminLoginPage());
  res.send(adminHtml());
});

app.post('/admin/login', (req, res) => {
  const ip = clientIp(req);
  if (adminLimiter.isBlocked(ip)) return res.status(429).send(tooManyPage());
  const password = req.body && req.body.password;
  if (typeof password === 'string' && safeEq(password, ADMIN_KEY)) {
    setAdminCookie(req, res);
    return res.redirect('/admin');
  }
  adminLimiter.fail(ip);
  res.status(401).send(adminLoginPage('Napačno geslo.'));
});

app.get('/api/admin/guests', requireAdmin, (req, res) => {
  const hearts = heartsByGuest(db.getHeartCounts());
  const guests = db.getAllGuests().map(g => {
    const q = db.getQuota(g.id);
    return {
      id:          g.id,
      displayName: g.display_name,
      used:        q.used,
      limit:       g.photo_limit,   // base limit; "+5 slik" raises it
      bonus:       q.bonus,
      hearts:      hearts[g.id] || 0,
    };
  });
  res.json(guests);
});

app.post('/api/admin/guests/:id/addlimit', requireAdmin, (req, res) => {
  const guest = db.getGuest(req.params.id);
  if (!guest) return res.status(404).json({ error: 'Not found' });
  db.addGuestLimit(req.params.id, 5);
  res.json({ ok: true });
});

app.post('/api/admin/guests/:id/reset', requireAdmin, (req, res) => {
  const guest = db.getGuest(req.params.id);
  if (!guest) return res.status(404).json({ error: 'Not found' });

  // Delete photo files
  const photos = db.getPhotosByGuest(req.params.id);
  for (const p of photos) removePhotoFiles(p);
  db.deleteGuestPhotos(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/guests/:id', requireAdmin, (req, res) => {
  const guest = db.getGuest(req.params.id);
  if (!guest) return res.status(404).json({ error: 'Not found' });

  const photos = db.getPhotosByGuest(req.params.id);
  for (const p of photos) removePhotoFiles(p);
  db.deleteGuest(req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/guests/:id/photos', requireAdmin, (req, res) => {
  const photos = db.getPhotosByGuest(req.params.id);
  const guest = db.getGuest(req.params.id);
  const name  = guest ? guest.display_name : '?';
  const counts = db.getHeartCounts();
  res.json(photos.map(p => ({
    id: p.id, taskId: p.task_id, createdAt: p.created_at, hearts: counts[p.id] || 0, ...describePhoto(p, name),
  })));
});

app.delete('/api/admin/photos/:id', requireAdmin, (req, res) => {
  const photo = db.getPhoto(req.params.id);
  if (!photo) return res.status(404).json({ error: 'Not found' });
  removePhotoFiles(photo);
  db.deletePhoto(req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const photos = db.getAllPhotos();
  let diskBytes = 0;
  for (const p of photos) {
    const dir = path.join(DATA_DIR, 'photos', p.guest_id);
    for (const suffix of ['.jpg', '_thumb.jpg']) {
      try { diskBytes += fs.statSync(path.join(dir, `${p.id}${suffix}`)).size; } catch {}
    }
  }
  res.json({ totalPhotos: photos.length, diskBytes });
});

// ─── Admin: tasks ─────────────────────────────────────────────────────────────

function cleanTaskInput(body) {
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return { error: 'Besedilo naloge je obvezno' };
  if (text.length > 200) return { error: 'Besedilo naloge je predolgo (največ 200 znakov)' };
  let label = typeof body.label === 'string' ? body.label.trim() : '';
  if (label.length > 140) return { error: 'Naziv slike je predolg (največ 140 znakov)' };
  if (!label) label = text; // empty Naziv falls back to the task text
  return { text, label, active: body.active !== false && body.active !== 0 && body.active !== '0' };
}

const taskJson = t => ({ id: t.id, text: t.text, label: t.label, active: !!t.active, sort: t.sort });

app.get('/api/admin/tasks', requireAdmin, (req, res) => {
  res.json(db.getTasks().map(taskJson));
});

app.post('/api/admin/tasks', requireAdmin, (req, res) => {
  const v = cleanTaskInput(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  res.json(taskJson(db.createTask(v)));
});

app.put('/api/admin/tasks/:id', requireAdmin, (req, res) => {
  const t = db.getTask(req.params.id);
  if (!t || t.deleted) return res.status(404).json({ error: 'Not found' });
  const v = cleanTaskInput(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  res.json(taskJson(db.updateTask(t.id, v)));
});

app.delete('/api/admin/tasks/:id', requireAdmin, (req, res) => {
  const t = db.getTask(req.params.id);
  if (!t || t.deleted) return res.status(404).json({ error: 'Not found' });
  db.deleteTask(t.id); // soft delete: photos and old clients may still reference it
  res.json({ ok: true });
});

function safeFileName(displayName) {
  return displayName.replace(/[^a-zA-Z0-9\u00C0-\u024F ]/g, '_').replace(/\s+/g, '_');
}

// Stream a zip of all photos: originali/ (as uploaded) and z-opisi/ (cards with caption)
app.get('/api/admin/download-zip', requireAdmin, async (req, res) => {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="party-photos.zip"`);

  const archive = archiver('zip', { zlib: { level: 1 } });
  archive.on('error', err => { console.error('[zip]', err); res.destroy(); });
  archive.pipe(res);

  for (const guest of db.getAllGuests()) {
    const safeName = safeFileName(guest.display_name);
    const photos = db.getPhotosByGuest(guest.id);
    for (const [idx, p] of photos.entries()) {
      const filePath = photoFiles(p).full;
      if (!fs.existsSync(filePath)) continue;
      const fname = `${safeName}_${String(idx + 1).padStart(3, '0')}.jpg`;
      archive.file(filePath, { name: `originali/${fname}` });
      try {
        archive.append(await getCard(p, guest.display_name), { name: `z-opisi/${fname}` });
      } catch (err) {
        console.error('[zip] card failed', p.id, err.message);
      }
    }
  }
  archive.finalize();
});

app.get('/api/admin/album', requireAdmin, (req, res) => {
  res.json({
    open: albumOpen(), code: ALBUM_CODE, passwordOn: albumPasswordOn(),
    link: `${PUBLIC_URL}/album?code=${encodeURIComponent(ALBUM_CODE)}`,
    plainLink: `${PUBLIC_URL}/album`,
    downloadAll: albumDownloadAll(),
  });
});

app.post('/api/admin/album/download', requireAdmin, (req, res) => {
  const on = !albumDownloadAll();
  db.setSetting('album_download_all', on ? '1' : '0');
  res.json({ downloadAll: on });
});

app.post('/api/admin/album/password', requireAdmin, (req, res) => {
  const on = !albumPasswordOn();
  db.setSetting('album_password', on ? '1' : '0');
  res.json({ passwordOn: on });
});

// Guests logged in to the app get into the (open) album without typing the code.
app.post('/api/album-session', requireGuest, (req, res) => {
  if (!albumOpen()) return res.status(403).json({ error: 'Album še ni odprt' });
  if (db.getPhotoCount(req.guest.id) < 1) {
    return res.status(403).json({ error: 'Album se odpre, ko pošlješ prvo sliko.' });
  }
  setAlbumCookie(req, res);
  res.json({ ok: true });
});

app.post('/api/admin/album/toggle', requireAdmin, (req, res) => {
  const open = !albumOpen();
  db.setSetting('album_open', open ? '1' : '0');
  res.json({ open });
});

// ─── Album ────────────────────────────────────────────────────────────────────

const PAGE_HEAD = `<!DOCTYPE html>
<html lang="sl"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(EVENT_TITLE)}</title><link rel="stylesheet" href="/fonts/fonts.css"><link rel="stylesheet" href="/style.css">
<script>try{navigator.serviceWorker&&navigator.serviceWorker.getRegistrations().then(function(r){r.forEach(function(x){x.unregister()})})}catch(e){}</script>
</head>
<body class="album-body"><main class="card center-card">`;
const PAGE_FOOT = `</main></body></html>`;

function lockedPage(wrongCode) {
  return PAGE_HEAD + `<h1>Album je zaklenjen</h1>
<p>Vpiši kodo, ki si jo prejel/a.</p>
<form method="get" action="/album">
<input class="name-input" type="text" name="code" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Koda">
${wrongCode ? '<div class="error-msg">Napačna koda.</div>' : ''}
<button class="btn-primary" type="submit">Odpri album</button></form>` + PAGE_FOOT;
}

function closedPage() {
  return PAGE_HEAD + `<h1>${escapeHtml(EVENT_TITLE)}</h1>
<p>Album bo odprt jutri. Spomini večera so na poti.</p>` + PAGE_FOOT;
}

app.get('/album', (req, res) => {
  const code = req.query.code;
  if (code !== undefined) {
    const ip = clientIp(req);
    if (albumLimiter.isBlocked(ip)) return res.status(429).send(tooManyPage());
    if (codeMatches(String(code))) {
      setAlbumCookie(req, res);
      return res.redirect('/album');
    }
    albumLimiter.fail(ip);
    return res.status(403).send(lockedPage(true));
  }
  if (!hasAlbumAccess(req)) return res.send(lockedPage(false));
  if (!isAdmin(req) && !albumOpen()) return res.send(closedPage());
  const zipButton = albumDownloadAll()
    ? '<button id="zip-all" class="btn-outline" type="button">Prenesi vse</button>' : '';
  res.type('html').send(renderView('album.html', { ZIP_BUTTON: zipButton }));
});

app.get('/api/album/photos', requireAlbum, (req, res) => {
  const guests = new Map(db.getAllGuests().map(g => [g.id, g.display_name]));
  const photos = db.getAllPhotos().map(p => ({
    id: p.id,
    guestId: p.guest_id,
    guest: p.guest_display_name,
    ...describePhoto(p, p.guest_display_name),
    caption: p.caption,
    createdAt: p.created_at,
  }));
  // newest first (created_at DESC, id DESC); the album page can re-sort
  photos.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  res.json({ guests: [...guests.entries()].map(([id, name]) => ({ id, name })), photos });
});

// ─── Hearts ───────────────────────────────────────────────────────────────────
const heartLimiter = createLimiter({ max: 120, windowMs: 60_000 });

function heartGate(req, res) {
  const voter = voterOf(req, res);
  if (heartLimiter.isBlocked(voter.key)) { res.status(429).json({ error: 'Preveč zahtev. Počakaj trenutek.' }); return null; }
  heartLimiter.fail(voter.key); // counts every request: 120 per minute per voter
  return voter;
}

app.post('/album/api/heart', requireAlbum, (req, res) => {
  const voter = heartGate(req, res);
  if (!voter) return;
  const photoId = req.body && typeof req.body.photoId === 'string' ? req.body.photoId : '';
  const photo = photoId ? db.getPhoto(photoId) : null;
  if (!photo) return res.status(404).json({ error: 'Slika ne obstaja' });
  if (voter.guestId && photo.guest_id === voter.guestId) {
    return res.status(403).json({ error: 'Svoje slike ne moreš všečkati' });
  }
  res.json(db.toggleHeart(photo.id, voter.key));
});

app.get('/album/api/hearts', requireAlbum, (req, res) => {
  const voter = heartGate(req, res);
  if (!voter) return;
  const counts = db.getHeartCounts();
  const per = new Map(); // guestId -> { name, hearts, photos }
  for (const p of db.getAllPhotos()) {
    const e = per.get(p.guest_id) || { name: p.guest_display_name, hearts: 0, photos: 0 };
    e.hearts += counts[p.id] || 0;
    e.photos += 1;
    per.set(p.guest_id, e);
  }
  const leaderboard = [...per.values()].filter(e => e.hearts >= 1)
    .sort((a, b) => b.hearts - a.hearts || b.photos - a.photos || a.name.localeCompare(b.name, 'sl'))
    .slice(0, 3);
  res.json({ counts, mine: db.getVoterHearts(voter.key), me: voter.guestId, leaderboard });
});

app.get('/album/photo/:id', requireAlbum, (req, res) => {
  const photo = db.getPhoto(req.params.id);
  if (!photo) return res.status(404).end();
  res.sendFile(photoFiles(photo).full);
});

app.get('/album/thumb/:id', requireAlbum, async (req, res) => {
  const photo = db.getPhoto(req.params.id);
  if (!photo) return res.status(404).end();
  res.sendFile(await getThumb(photo));
});

// 1280px grid image: made after the upload, or on first request
app.get('/album/medium/:id', requireAlbum, async (req, res) => {
  const photo = db.getPhoto(req.params.id);
  if (!photo) return res.status(404).end();
  try {
    res.sendFile(await thumbs.medium(photoFiles(photo).full, mediumPath(photo), { priority: true }));
  } catch (err) {
    console.error('[medium]', err.message);
    res.sendFile(await getThumb(photo));
  }
});

app.get('/album/card/:id.jpg', requireAlbum, async (req, res) => {
  const photo = db.getPhoto(req.params.id);
  if (!photo) return res.status(404).end();
  try {
    const guest = db.getGuest(photo.guest_id);
    const buf = await getCard(photo, guest ? guest.display_name : '?');
    const idx = db.getPhotosByGuest(photo.guest_id).findIndex(p => p.id === photo.id);
    const fname = `${safeFileName(guest ? guest.display_name : 'slika')}_${String(idx + 1).padStart(3, '0')}.jpg`;
    res.setHeader('Content-Type', 'image/jpeg');
    const ascii = fname.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').replace(/[^A-Za-z0-9_.-]/g, '_');
    res.setHeader('Content-Disposition',
      `${req.query.dl ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fname)}`);
    res.send(buf);
  } catch (err) {
    console.error('[card]', err);
    res.status(500).json({ error: 'Napaka pri ustvarjanju kartice' });
  }
});

app.get('/album/zip', requireAlbum, async (req, res) => {
  if (!isAdmin(req) && !albumDownloadAll()) return res.status(403).json({ error: 'Prenos celotnega albuma ni omogočen' });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="album.zip"');
  const archive = archiver('zip', { zlib: { level: 1 } });
  archive.on('error', err => { console.error('[zip]', err); res.destroy(); });
  archive.pipe(res);
  for (const guest of db.getAllGuests()) {
    const safeName = safeFileName(guest.display_name);
    for (const [idx, p] of db.getPhotosByGuest(guest.id).entries()) {
      if (!fs.existsSync(photoFiles(p).full)) continue;
      try {
        archive.append(await getCard(p, guest.display_name),
          { name: `${safeName}_${String(idx + 1).padStart(3, '0')}.jpg` });
      } catch (err) {
        console.error('[zip] card failed', p.id, err.message);
      }
    }
  }
  archive.finalize();
});

// ─── Card rendering (sharp + Pango; DejaVu fonts cover č š ž đ) ───────────────

const CARD = { photoW: 2000, margin: 60, gold: '#B8924A', goldDark: '#8F6F2E', text: '#2A2A2A' };
const cardJobs = new Map();

function pangoEscape(t) {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function textImage(text, { font, color, width, rgbaAlign = 'centre' }) {
  const buf = await sharp({
    text: {
      text: `<span foreground="${color}">${pangoEscape(text)}</span>`,
      font, width, align: rgbaAlign, rgba: true, wrap: 'word-char',
    },
  }).png().toBuffer();
  const meta = await sharp(buf).metadata();
  return { input: buf, w: meta.width, h: meta.height };
}

async function renderCard({ photoPath, label, taskLine }) {
  const { photoW, margin, gold, goldDark, text } = CARD;
  const innerW = photoW;
  const width  = innerW + margin * 2;

  const photo = await sharp(photoPath).rotate().resize({ width: photoW }).jpeg({ quality: 92 }).toBuffer();
  const pm = await sharp(photo).metadata();

  const textW = innerW - 160;
  const labelImg = await textImage(label, { font: 'DejaVu Serif 64', color: text, width: textW });
  const taskImg  = taskLine
    ? await textImage(taskLine, { font: 'DejaVu Serif Italic 44', color: goldDark, width: textW })
    : null;
  const footImg  = await textImage(EVENT_TITLE, { font: 'DejaVu Serif 36', color: gold, width: textW });

  let y = margin;
  const layers = [{ input: photo, left: margin, top: y }];
  y += pm.height + 90;
  layers.push({ input: labelImg.input, left: Math.round((width - labelImg.w) / 2), top: y });
  y += labelImg.h + 40;
  if (taskImg) {
    layers.push({ input: taskImg.input, left: Math.round((width - taskImg.w) / 2), top: y });
    y += taskImg.h + 40;
  }
  y += 50;
  layers.push({ input: footImg.input, left: Math.round((width - footImg.w) / 2), top: y });
  y += footImg.h + margin;
  const height = y;

  const b = 22; // border inset
  const border = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect x="${b}" y="${b}" width="${width - 2 * b}" height="${height - 2 * b}" fill="none" stroke="${gold}" stroke-width="5"/></svg>`);
  layers.push({ input: border, left: 0, top: 0 });

  return sharp({ create: { width, height, channels: 3, background: '#ffffff' } })
    .composite(layers)
    .jpeg({ quality: 90 })
    .toBuffer();
}

/** Cached card for a photo; concurrent requests for the same photo share one render. */
function getCard(photo, guestName) {
  const cachePath = path.join(CARDS_DIR, `${photo.id}.jpg`);
  if (fs.existsSync(cachePath)) return fs.promises.readFile(cachePath);
  if (cardJobs.has(photo.id)) return cardJobs.get(photo.id);
  const d = describePhoto(photo, guestName);
  const job = renderCard({ photoPath: photoFiles(photo).full, label: d.label, taskLine: d.task }).then(async buf => {
    const tmp = `${cachePath}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, buf);
    await fs.promises.rename(tmp, cachePath);
    return buf;
  }).finally(() => cardJobs.delete(photo.id));
  cardJobs.set(photo.id, job);
  return job;
}

// ─── Admin HTML ───────────────────────────────────────────────────────────────

function adminHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin – ${escapeHtml(EVENT_TITLE)}</title>
<script>try{navigator.serviceWorker&&navigator.serviceWorker.getRegistrations().then(function(r){r.forEach(function(x){x.unregister()})})}catch(e){}</script>
<style>
  body { font-family: monospace; margin: 20px; background: #111; color: #eee; }
  h1 { color: #ff9; }
  button { cursor: pointer; margin: 2px; padding: 4px 8px; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 20px; }
  th, td { border: 1px solid #444; padding: 6px 10px; text-align: left; }
  th { background: #222; }
  tr:hover { background: #1a1a1a; }
  .photo-grid { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
  .photo-grid img { width: 120px; height: 90px; object-fit: cover; cursor: pointer; border: 2px solid transparent; }
  .photo-grid img:hover { border-color: #ff9; }
  .photo-wrap { position: relative; width: 140px; font-size: 12px; }
  .photo-label { margin-top: 2px; word-break: break-word; }
  .photo-hearts { color: #f88; }
  .photo-task { color: #ff9; font-style: italic; word-break: break-word; }
  h2 { color: #ff9; margin-top: 28px; }
  .task-add { margin: 12px 0; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  #tasks-table input[type=text], #tasks-table input:not([type]) { background: #222; color: #eee; border: 1px solid #555; padding: 4px; }
  .warn { color: #f55; font-size: 13px; }
  .album-box { margin: 10px 0 16px; padding: 10px; border: 1px solid #555; }
  .photo-wrap button { position: absolute; top: 2px; right: 2px; background: red; color: #fff; border: 0; padding: 2px 5px; font-size: 12px; }
  #modal { display:none; position:fixed; inset:0; background:rgba(0,0,0,.85); z-index:999; align-items:center; justify-content:center; }
  #modal.open { display:flex; }
  #modal img { max-width:90vw; max-height:90vh; }
  #modal button { position:fixed; top:16px; right:16px; font-size:24px; background:none; border:0; color:#fff; cursor:pointer; }
  .stat { color: #aaa; margin-bottom: 16px; }
  #guest-detail { margin-top: 20px; border: 1px solid #555; padding: 12px; }
</style>
</head>
<body>
<h1>Admin – ${escapeHtml(EVENT_TITLE)}</h1>
<p class="stat" id="stats">Nalagam...</p>
<div class="album-box">
  <button id="album-toggle"></button>
  <button id="pw-toggle"></button>
  <button id="dl-toggle"></button>
  <span id="pw-warning" class="warn" hidden>Pozor: ko je geslo izklopljeno, lahko album odpre vsak, ki ve naslov /album.</span>
  <div>Povezava do albuma: <input id="album-link" readonly size="60"> <button id="album-copy">Kopiraj</button></div>
  <div id="plain-row" hidden>Povezava brez kode: <input id="plain-link" readonly size="60"> <button id="plain-copy">Kopiraj</button></div>
</div>
<a href="/api/admin/download-zip" style="color:#9f9">📦 Prenesi vse (originali + z opisi)</a>
<br><br>
<table id="guests-table">
  <thead><tr><th>Ime</th><th>Slike</th><th>♥</th><th>Dejanja</th></tr></thead>
  <tbody id="guests-body"></tbody>
</table>
<div id="guest-detail" style="display:none">
  <b id="detail-name"></b>
  <button id="detail-close">✕ Zapri</button>
  <div id="photo-grid" class="photo-grid"></div>
</div>
<h2>Naloge</h2>
<table id="tasks-table">
  <thead><tr><th>Besedilo naloge</th><th>Naziv slike</th><th>Aktivna</th><th></th></tr></thead>
  <tbody id="tasks-body"></tbody>
</table>
<form id="task-add" class="task-add">
  <b>Dodaj nalogo</b>
  <input id="new-text" placeholder="Besedilo naloge" maxlength="200" size="40">
  <input id="new-label" placeholder="Naziv slike" maxlength="140" size="40">
  <label><input id="new-active" type="checkbox" checked> Aktivna</label>
  <button type="submit">Dodaj nalogo</button>
  <span id="task-msg"></span>
</form>
<div id="modal">
  <button id="modal-close">✕</button>
  <img id="modal-img" src="" alt="">
</div>
<script>
function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  Object.assign(e, props || {});
  for (const k of kids) e.append(k);
  return e;
}
function btn(text, onclick) { return el('button', { textContent: text, onclick }); }

async function load() {
  const [guests, stats] = await Promise.all([
    fetch('/api/admin/guests').then(r => r.json()),
    fetch('/api/admin/stats').then(r => r.json()),
  ]);
  document.getElementById('stats').textContent =
    'Skupaj slik: ' + stats.totalPhotos + ' | Disk: ' + (stats.diskBytes / 1024 / 1024).toFixed(1) + ' MB';
  const tbody = document.getElementById('guests-body');
  tbody.replaceChildren();
  for (const g of guests) {
    const link = el('a', { href: '#', textContent: g.displayName, onclick: e => { e.preventDefault(); loadGuest(g.id, g.displayName); } });
    tbody.append(el('tr', null,
      el('td', null, link),
      el('td', { textContent: g.used + ' / ' + g.limit + ' (+' + g.bonus + ' bonus)' }),
      el('td', { textContent: String(g.hearts) }),
      el('td', null,
        btn('+5 slik', () => addLimit(g.id)),
        btn('Ponastavi', () => resetGuest(g.id)),
        btn('🗑', () => deleteGuest(g.id, g.displayName)))));
  }
  loadAlbum();
}

// ── Tasks ──
const taskMsg = t => { document.getElementById('task-msg').textContent = t; };

async function loadTasks() {
  const tasks = await fetch('/api/admin/tasks').then(r => r.json());
  const tbody = document.getElementById('tasks-body');
  tbody.replaceChildren();
  for (const t of tasks) {
    const text = el('input', { value: t.text, maxLength: 200, size: 40 });
    const label = el('input', { value: t.label, maxLength: 140, size: 40 });
    const active = el('input', { type: 'checkbox', checked: t.active });
    const save = btn('Shrani', async () => {
      const r = await fetch('/api/admin/tasks/' + t.id, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.value, label: label.value, active: active.checked }),
      });
      const data = await r.json();
      if (!r.ok) { taskMsg(data.error || 'Napaka'); return; }
      label.value = data.label;
      taskMsg('Shranjeno ✓');
    });
    const del = btn('🗑', async () => {
      if (!confirm('Izbriši nalogo "' + t.text + '"?')) return;
      await fetch('/api/admin/tasks/' + t.id, { method: 'DELETE' });
      loadTasks();
    });
    tbody.append(el('tr', null, el('td', null, text), el('td', null, label), el('td', null, active), el('td', null, save, del)));
  }
}

// Naziv suggestion: "Slikaj nekoga ..." -> "Slika nekoga ..." while Naziv is empty or still the suggestion
let suggested = '';
document.getElementById('new-text').addEventListener('input', e => {
  const label = document.getElementById('new-label');
  if (label.value !== '' && label.value !== suggested) return;
  const m = /^Slikaj (.+)/.exec(e.target.value);
  suggested = m ? 'Slika ' + m[1] : '';
  label.value = suggested;
});
document.getElementById('task-add').addEventListener('submit', async e => {
  e.preventDefault();
  const r = await fetch('/api/admin/tasks', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: document.getElementById('new-text').value,
      label: document.getElementById('new-label').value,
      active: document.getElementById('new-active').checked,
    }),
  });
  const data = await r.json();
  if (!r.ok) { taskMsg(data.error || 'Napaka'); return; }
  document.getElementById('new-text').value = '';
  document.getElementById('new-label').value = '';
  suggested = '';
  taskMsg('Dodano ✓');
  loadTasks();
});

async function loadAlbum() {
  const a = await fetch('/api/admin/album').then(r => r.json());
  document.getElementById('album-toggle').textContent = 'Album: ' + (a.open ? 'ODPRT' : 'ZAPRT');
  document.getElementById('album-link').value = a.link;
  document.getElementById('pw-toggle').textContent = 'Geslo za album: ' + (a.passwordOn ? 'VKLOPLJENO' : 'IZKLOPLJENO');
  document.getElementById('dl-toggle').textContent = 'Prenos celotnega albuma: ' + (a.downloadAll ? 'VKLOPLJEN' : 'IZKLOPLJEN');
  document.getElementById('pw-warning').hidden = a.passwordOn;
  document.getElementById('plain-row').hidden = a.passwordOn;
  document.getElementById('plain-link').value = a.plainLink;
}
document.getElementById('dl-toggle').onclick = async () => {
  await fetch('/api/admin/album/download', { method: 'POST' });
  loadAlbum();
};
document.getElementById('pw-toggle').onclick = async () => {
  await fetch('/api/admin/album/password', { method: 'POST' });
  loadAlbum();
};
document.getElementById('plain-copy').onclick = async () => {
  const input = document.getElementById('plain-link');
  input.select();
  try { await navigator.clipboard.writeText(input.value); } catch { document.execCommand('copy'); }
};
document.getElementById('album-toggle').onclick = async () => {
  await fetch('/api/admin/album/toggle', { method: 'POST' });
  loadAlbum();
};
document.getElementById('album-copy').onclick = async () => {
  const input = document.getElementById('album-link');
  input.select();
  try { await navigator.clipboard.writeText(input.value); } catch { document.execCommand('copy'); }
};

async function addLimit(id) {
  await fetch('/api/admin/guests/' + id + '/addlimit', {method:'POST'});
  load();
}
async function resetGuest(id) {
  if (!confirm('Izbriši vse slike tega gosta?')) return;
  await fetch('/api/admin/guests/' + id + '/reset', {method:'POST'});
  load();
  closeDetail();
}
async function deleteGuest(id, name) {
  if (!confirm('Izbriši gosta ' + name + ' in vse njegove slike?')) return;
  await fetch('/api/admin/guests/' + id, {method:'DELETE'});
  load();
  closeDetail();
}
async function loadGuest(id, name) {
  const photos = await fetch('/api/admin/guests/' + id + '/photos').then(r => r.json());
  document.getElementById('detail-name').textContent = name;
  document.getElementById('guest-detail').style.display = '';
  const grid = document.getElementById('photo-grid');
  grid.replaceChildren();
  for (const p of photos) {
    const wrap = el('div', { className: 'photo-wrap' },
      el('img', { src: '/thumb/' + p.id, loading: 'lazy', onclick: () => openModal('/photo/' + p.id) }),
      el('button', { textContent: '✕', onclick: () => deletePhoto(p.id, wrap) }),
      el('div', { className: 'photo-label', textContent: p.label }));
    if (p.task) wrap.append(el('div', { className: 'photo-task', textContent: p.task }));
    wrap.append(el('div', { className: 'photo-hearts', textContent: '♥ ' + (p.hearts || 0) }));
    grid.append(wrap);
  }
}
async function deletePhoto(id, wrap) {
  if (!confirm('Izbriši sliko?')) return;
  await fetch('/api/admin/photos/' + id, {method:'DELETE'});
  wrap.remove();
  load();
}
function openModal(src) {
  document.getElementById('modal-img').src = src;
  document.getElementById('modal').classList.add('open');
}
function closeModal() {
  document.getElementById('modal').classList.remove('open');
  document.getElementById('modal-img').src = '';
}
function closeDetail() {
  document.getElementById('guest-detail').style.display = 'none';
}
document.getElementById('detail-close').onclick = closeDetail;
document.getElementById('modal-close').onclick = closeModal;
load();
loadTasks();
</script>
</body>
</html>`;
}

// ─── Start ────────────────────────────────────────────────────────────────────

fs.mkdirSync(path.join(DATA_DIR, 'photos'), { recursive: true });

const server = app.listen(PORT, () => {
  console.log(`[startup] ready in ${Math.round(process.uptime() * 1000)} ms`);
  console.log(`\n🎉  ${EVENT_TITLE} — server running`);
  console.log(`   Local:  http://localhost:${PORT}`);
  console.log(`   Admin:  http://localhost:${PORT}/admin`);
  console.log(`   Album:  ${PUBLIC_URL}/album?code=${ALBUM_CODE}`);
  console.log(`\n   To expose publicly with cloudflared:`);
  console.log(`   cloudflared tunnel --url http://localhost:${PORT}`);
  console.log(`\n   Set ADMIN_KEY in .env before deploying!\n`);
});

// Slow mobile uploads must not be cut off by node: no socket timeout, generous request limits.
server.timeout = 0;
server.requestTimeout = 5 * 60 * 1000;
server.headersTimeout = 2 * 60 * 1000;
server.keepAliveTimeout = 65 * 1000;

module.exports = app; // for testing
