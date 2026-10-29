'use strict';

/**
 * Database layer. Tries better-sqlite3 first; falls back to a JSON file
 * with synchronous atomic writes (temp file + rename).
 *
 * Call db.init(dataDir, defaultPhotoLimit) once at startup before any other call.
 */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { SEED_TASKS } = require('./seed-tasks');

const { normalize } = require('./names');
const Quota = require('./quota');

const BASE_LIMIT = 15;   // everybody's base limit; more photos come from solving tasks

let _impl = null; // set by init()

// ─── SQLite implementation ────────────────────────────────────────────────────

function makeSqliteImpl(dataDir) {
  const Database = require('better-sqlite3');
  const dbPath = path.join(dataDir, 'party.db');
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS guests (
      id            TEXT PRIMARY KEY,
      display_name  TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      token         TEXT NOT NULL UNIQUE,
      photo_limit   INTEGER NOT NULL DEFAULT 10,
      created_at    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS photos (
      id         TEXT PRIMARY KEY,
      guest_id   TEXT NOT NULL,
      client_id  TEXT NOT NULL UNIQUE,
      task_id    TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (guest_id) REFERENCES guests(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      text       TEXT NOT NULL,
      label      TEXT NOT NULL,
      active     INTEGER NOT NULL DEFAULT 1,
      deleted    INTEGER NOT NULL DEFAULT 0,
      sort       INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hearts (
      photo_id   TEXT NOT NULL,
      voter_key  TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (photo_id, voter_key)
    );
    CREATE INDEX IF NOT EXISTS idx_hearts_photo ON hearts (photo_id);
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Idempotent migration: add new photo columns, backfill ordinals.
  const cols = db.prepare('PRAGMA table_info(photos)').all().map(c => c.name);
  if (!cols.includes('ordinal'))   db.exec('ALTER TABLE photos ADD COLUMN ordinal INTEGER');
  if (!cols.includes('caption'))   db.exec('ALTER TABLE photos ADD COLUMN caption TEXT');
  if (!cols.includes('task_text')) db.exec('ALTER TABLE photos ADD COLUMN task_text TEXT');
  if (!cols.includes('task_label')) db.exec('ALTER TABLE photos ADD COLUMN task_label TEXT');

  const getSet = db.prepare('SELECT value FROM settings WHERE key = ?');
  const putSet = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  db.transaction(() => {
    // Seed tasks once; later edits/deletes in the admin are never undone.
    if (!getSet.get('tasks_seeded')) {
      const ins = db.prepare('INSERT INTO tasks (text, label, active, deleted, sort, created_at) VALUES (?, ?, 1, 0, ?, ?)');
      SEED_TASKS.forEach((t, i) => ins.run(t.text, t.label, (i + 1) * 10, Date.now()));
      putSet.run('tasks_seeded', '1');
    }
    // Existing photos with a task get the label from the seed list (exact text match).
    const setLabel = db.prepare('UPDATE photos SET task_label = ? WHERE task_text = ? AND task_label IS NULL');
    for (const t of SEED_TASKS) setLabel.run(t.label, t.text);
    // Photos with a task get task_id from the tasks table (text, then label). Where nothing
    // matches the bonus falls back to COALESCE(task_id, task_text), so nothing is lost.
    const matchTask = db.prepare(`SELECT id FROM tasks WHERE text = ? ORDER BY deleted, id LIMIT 1`);
    const matchLabel = db.prepare(`SELECT id FROM tasks WHERE label = ? ORDER BY deleted, id LIMIT 1`);
    const setTaskId = db.prepare('UPDATE photos SET task_id = ? WHERE id = ?');
    for (const p of db.prepare("SELECT id, task_text, task_label FROM photos WHERE (task_text IS NOT NULL OR task_label IS NOT NULL) AND (task_id IS NULL OR task_id NOT GLOB '[0-9]*')").all()) {
      const m = (p.task_text && matchTask.get(p.task_text)) || (p.task_label && matchLabel.get(p.task_label));
      if (m) setTaskId.run(String(m.id), p.id);
    }
    // Repair: a guest row without a usable normalized_name would break fuzzy login for everybody.
    const fixName = db.prepare('UPDATE guests SET normalized_name = ? WHERE id = ?');
    for (const g of db.prepare("SELECT id, display_name FROM guests WHERE normalized_name IS NULL OR normalized_name = ''").all()) {
      fixName.run(normalize(g.display_name), g.id);
    }
    // One-time: raise guests below the new default limit.
    // One-time: base limit 15 for everybody. Photos already taken stay; guests who took more
    // simply have 0 left until they solve tasks (allowed = limit + completed tasks).
    if (!getSet.get('limit_base_15')) {
      db.prepare('UPDATE guests SET photo_limit = ?').run(BASE_LIMIT);
      putSet.run('limit_base_15', '1');
    }
  })();
  db.transaction(() => {
    const guestIds = db.prepare('SELECT DISTINCT guest_id FROM photos WHERE ordinal IS NULL').all();
    const rows = db.prepare('SELECT id FROM photos WHERE guest_id = ? ORDER BY created_at, rowid');
    const set  = db.prepare('UPDATE photos SET ordinal = ? WHERE id = ?');
    for (const { guest_id } of guestIds) {
      rows.all(guest_id).forEach((r, i) => set.run(i + 1, r.id));
    }
  })();

  const stmts = {
    allGuests:        db.prepare('SELECT * FROM guests ORDER BY created_at'),
    guestById:        db.prepare('SELECT * FROM guests WHERE id = ?'),
    guestByToken:     db.prepare('SELECT * FROM guests WHERE token = ?'),
    insertGuest:      db.prepare('INSERT INTO guests (id, display_name, normalized_name, token, photo_limit, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    updateLimit:      db.prepare('UPDATE guests SET photo_limit = photo_limit + ? WHERE id = ?'),
    setLimit:         db.prepare('UPDATE guests SET photo_limit = ? WHERE id = ?'),
    deleteGuest:      db.prepare('DELETE FROM guests WHERE id = ?'),

    photoById:        db.prepare('SELECT * FROM photos WHERE id = ?'),
    photoByClientId:  db.prepare('SELECT * FROM photos WHERE client_id = ?'),
    photosByGuest:    db.prepare('SELECT * FROM photos WHERE guest_id = ? ORDER BY created_at'),
    allPhotos:        db.prepare(`
      SELECT p.*, g.display_name AS guest_display_name
      FROM photos p JOIN guests g ON g.id = p.guest_id
      ORDER BY p.created_at
    `),
    photoCount:       db.prepare('SELECT COUNT(*) AS cnt FROM photos WHERE guest_id = ?'),
    insertPhoto:      db.prepare('INSERT INTO photos (id, guest_id, client_id, task_id, created_at, ordinal, caption, task_text, task_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    maxOrdinal:       db.prepare('SELECT COALESCE(MAX(ordinal), 0) AS m FROM photos WHERE guest_id = ?'),
    getSetting:       db.prepare('SELECT value FROM settings WHERE key = ?'),
    putSetting:       db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    deletePhoto:      db.prepare('DELETE FROM photos WHERE id = ?'),
    deleteGuestPhotos:db.prepare('DELETE FROM photos WHERE guest_id = ?'),
  };

  const createPhotoTx = db.transaction((photoObj, limit) => {
    const existing = stmts.photosByGuest.all(photoObj.guestId);
    const verdict = Quota.evaluateUpload({
      limit, photos: existing, photo: { task_id: photoObj.taskId, task_text: photoObj.taskText },
    });
    if (!verdict.accepted) throw Object.assign(new Error('PHOTO_LIMIT_EXCEEDED'), { code: 'PHOTO_LIMIT_EXCEEDED' });
    const ordinal = stmts.maxOrdinal.get(photoObj.guestId).m + 1;
    stmts.insertPhoto.run(
      photoObj.id, photoObj.guestId, photoObj.clientId, photoObj.taskId ?? null, photoObj.createdAt,
      ordinal, photoObj.caption ?? null, photoObj.taskText ?? null, photoObj.taskLabel ?? null,
    );
    const { accepted, ...rest } = verdict;
    return { ...rest, ordinal };
  });

  return {
    getAllGuests: () => stmts.allGuests.all(),
    getGuest: id => stmts.guestById.get(id) ?? null,
    getGuestByToken: token => stmts.guestByToken.get(token) ?? null,

    createGuest({ id, displayName, normalizedName, token, photoLimit }) {
      stmts.insertGuest.run(id, displayName, normalizedName, token, photoLimit, Date.now());
      return stmts.guestById.get(id);
    },

    addGuestLimit(id, delta) {
      stmts.updateLimit.run(delta, id);
    },

    setGuestLimit(id, limit) {
      stmts.setLimit.run(limit, id);
    },

    deleteGuest(id) {
      db.prepare('DELETE FROM hearts WHERE photo_id IN (SELECT id FROM photos WHERE guest_id = ?) OR voter_key = ?').run(id, 'g:' + id);
      stmts.deleteGuest.run(id);
    },

    getPhoto: id => stmts.photoById.get(id) ?? null,
    getPhotoByClientId: clientId => stmts.photoByClientId.get(clientId) ?? null,
    getPhotosByGuest: guestId => stmts.photosByGuest.all(guestId),
    getAllPhotos: () => stmts.allPhotos.all(),
    getPhotoCount: guestId => stmts.photoCount.get(guestId).cnt,

    createPhoto(photoObj, limit) {
      return createPhotoTx(photoObj, limit);
    },

    getQuota(guestId) {
      const g = stmts.guestById.get(guestId);
      const photos = stmts.photosByGuest.all(guestId);
      return Quota.computeQuota({ limit: g ? g.photo_limit : 0, used: photos.length, keys: Quota.keysOf(photos) });
    },

    // hearts
    toggleHeart(photoId, voterKey) {
      const tx = db.transaction(() => {
        const del = db.prepare('DELETE FROM hearts WHERE photo_id = ? AND voter_key = ?').run(photoId, voterKey);
        if (!del.changes) db.prepare('INSERT INTO hearts (photo_id, voter_key, created_at) VALUES (?, ?, ?)').run(photoId, voterKey, Date.now());
        return {
          hearted: !del.changes,
          count: db.prepare('SELECT COUNT(*) AS c FROM hearts WHERE photo_id = ?').get(photoId).c,
        };
      });
      return tx();
    },
    getHeartCounts() {
      const out = {};
      for (const r of db.prepare('SELECT photo_id, COUNT(*) AS c FROM hearts GROUP BY photo_id').all()) out[r.photo_id] = r.c;
      return out;
    },
    getVoterHearts: voterKey => db.prepare('SELECT photo_id FROM hearts WHERE voter_key = ?').all(voterKey).map(r => r.photo_id),

    deletePhoto(id) {
      db.prepare('DELETE FROM hearts WHERE photo_id = ?').run(id);
      stmts.deletePhoto.run(id);
    },

    getSetting: key => stmts.getSetting.get(key)?.value ?? null,
    setSetting(key, value) {
      stmts.putSetting.run(key, String(value));
    },

    // Tasks are never hard-deleted: photos snapshot text/label, and old clients may still send the id.
    getTasks: ({ activeOnly = false } = {}) => db.prepare(
      `SELECT * FROM tasks WHERE deleted = 0 ${activeOnly ? 'AND active = 1' : ''} ORDER BY sort, id`).all(),
    getTask: id => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) ?? null,
    getTaskByText: text => db.prepare('SELECT * FROM tasks WHERE text = ? ORDER BY deleted, id').get(text) ?? null,
    createTask({ text, label, active = true }) {
      const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 10 AS s FROM tasks').get().s;
      const r = db.prepare('INSERT INTO tasks (text, label, active, deleted, sort, created_at) VALUES (?, ?, ?, 0, ?, ?)')
        .run(text, label, active ? 1 : 0, sort, Date.now());
      return db.prepare('SELECT * FROM tasks WHERE id = ?').get(r.lastInsertRowid);
    },
    updateTask(id, { text, label, active }) {
      db.prepare('UPDATE tasks SET text = ?, label = ?, active = ? WHERE id = ? AND deleted = 0')
        .run(text, label, active ? 1 : 0, id);
      return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) ?? null;
    },
    deleteTask(id) {
      db.prepare('UPDATE tasks SET deleted = 1, active = 0 WHERE id = ?').run(id);
    },

    deleteGuestPhotos(guestId) {
      db.prepare('DELETE FROM hearts WHERE photo_id IN (SELECT id FROM photos WHERE guest_id = ?)').run(guestId);
      stmts.deleteGuestPhotos.run(guestId);
    },

    close() {
      db.close();
    },
  };
}

// ─── JSON-file fallback ───────────────────────────────────────────────────────

function makeJsonImpl(dataDir) {
  const jsonPath = path.join(dataDir, 'party.json');
  const tmpPath  = jsonPath + '.tmp';

  function read() {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch {
      data = { guests: [], photos: [] };
    }
    return migrate(data);
  }

  // Idempotent: fill in fields added after the first release.
  function migrate(data) {
    data.settings = data.settings || {};
    data.tasks = data.tasks || [];
    data.hearts = data.hearts || [];
    if (!data.settings.tasks_seeded) {
      SEED_TASKS.forEach((t, i) => data.tasks.push({
        id: i + 1, text: t.text, label: t.label, active: 1, deleted: 0, sort: (i + 1) * 10, created_at: 0,
      }));
      data.settings.tasks_seeded = '1';
    }
    for (const g of data.guests) if (!g.normalized_name) g.normalized_name = normalize(g.display_name || '');
    if (!data.settings.limit_base_15) {
      for (const g of data.guests) g.photo_limit = BASE_LIMIT;
      data.settings.limit_base_15 = '1';
    }
    const labels = new Map(SEED_TASKS.map(t => [t.text, t.label]));
    const seen = {};
    const sorted = [...data.photos].sort((a, b) => a.created_at - b.created_at);
    for (const p of sorted) {
      if (p.ordinal == null) p.ordinal = (seen[p.guest_id] = (seen[p.guest_id] || 0) + 1);
      else seen[p.guest_id] = Math.max(seen[p.guest_id] || 0, p.ordinal);
      if (p.caption === undefined)   p.caption = null;
      if (p.task_text === undefined) p.task_text = null;
      if (p.task_label === undefined) p.task_label = (p.task_text && labels.get(p.task_text)) || null;
      if ((p.task_text || p.task_label) && !/^\d/.test(String(p.task_id ?? ''))) {
        const ts = data.tasks.filter(t => t.text === p.task_text || (!p.task_text && t.label === p.task_label))
          .sort((a, b) => a.deleted - b.deleted || a.id - b.id);
        if (ts[0]) p.task_id = String(ts[0].id);
      }
    }
    return data;
  }

  function write(data) {
    // atomic: write to tmp then rename
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmpPath, jsonPath);
  }

  return {
    getAllGuests() {
      return read().guests;
    },

    getGuest(id) {
      return read().guests.find(g => g.id === id) ?? null;
    },

    getGuestByToken(token) {
      return read().guests.find(g => g.token === token) ?? null;
    },

    createGuest({ id, displayName, normalizedName, token, photoLimit }) {
      const data = read();
      const guest = {
        id,
        display_name: displayName,
        normalized_name: normalizedName,
        token,
        photo_limit: photoLimit,
        created_at: Date.now(),
      };
      data.guests.push(guest);
      write(data);
      return guest;
    },

    addGuestLimit(id, delta) {
      const data = read();
      const g = data.guests.find(x => x.id === id);
      if (g) g.photo_limit += delta;
      write(data);
    },

    setGuestLimit(id, limit) {
      const data = read();
      const g = data.guests.find(x => x.id === id);
      if (g) g.photo_limit = limit;
      write(data);
    },

    deleteGuest(id) {
      const data = read();
      const gone = new Set(data.photos.filter(p => p.guest_id === id).map(p => p.id));
      data.hearts  = data.hearts.filter(h => !gone.has(h.photo_id) && h.voter_key !== 'g:' + id);
      data.guests  = data.guests.filter(g => g.id !== id);
      data.photos  = data.photos.filter(p => p.guest_id !== id);
      write(data);
    },

    getPhoto(id) {
      return read().photos.find(p => p.id === id) ?? null;
    },

    getPhotoByClientId(clientId) {
      return read().photos.find(p => p.client_id === clientId) ?? null;
    },

    getPhotosByGuest(guestId) {
      return read().photos.filter(p => p.guest_id === guestId);
    },

    getAllPhotos() {
      const data = read();
      return data.photos.map(p => ({
        ...p,
        guest_display_name: (data.guests.find(g => g.id === p.guest_id) ?? {}).display_name ?? '?',
      }));
    },

    getPhotoCount(guestId) {
      return read().photos.filter(p => p.guest_id === guestId).length;
    },

    getQuota(guestId) {
      const data = read();
      const g = data.guests.find(x => x.id === guestId);
      const photos = data.photos.filter(p => p.guest_id === guestId);
      return Quota.computeQuota({ limit: g ? g.photo_limit : 0, used: photos.length, keys: Quota.keysOf(photos) });
    },

    toggleHeart(photoId, voterKey) {
      const data = read();
      const i = data.hearts.findIndex(h => h.photo_id === photoId && h.voter_key === voterKey);
      if (i >= 0) data.hearts.splice(i, 1);
      else data.hearts.push({ photo_id: photoId, voter_key: voterKey, created_at: Date.now() });
      write(data);
      return { hearted: i < 0, count: data.hearts.filter(h => h.photo_id === photoId).length };
    },
    getHeartCounts() {
      const out = {};
      for (const h of read().hearts) out[h.photo_id] = (out[h.photo_id] || 0) + 1;
      return out;
    },
    getVoterHearts: voterKey => read().hearts.filter(h => h.voter_key === voterKey).map(h => h.photo_id),

    // Must stay synchronous between count check and insert so Node's single
    // thread doesn't interleave concurrent requests.
    createPhoto(photoObj, limit) {
      const data = read();
      const mine = data.photos.filter(p => p.guest_id === photoObj.guestId);
      const verdict = Quota.evaluateUpload({
        limit, photos: mine, photo: { task_id: photoObj.taskId, task_text: photoObj.taskText },
      });
      if (!verdict.accepted) throw Object.assign(new Error('PHOTO_LIMIT_EXCEEDED'), { code: 'PHOTO_LIMIT_EXCEEDED' });
      const ordinal = data.photos
        .filter(p => p.guest_id === photoObj.guestId)
        .reduce((m, p) => Math.max(m, p.ordinal || 0), 0) + 1;
      const photo = {
        id:         photoObj.id,
        guest_id:   photoObj.guestId,
        client_id:  photoObj.clientId,
        task_id:    photoObj.taskId ?? null,
        created_at: photoObj.createdAt,
        ordinal,
        caption:    photoObj.caption ?? null,
        task_text:  photoObj.taskText ?? null,
        task_label: photoObj.taskLabel ?? null,
      };
      data.photos.push(photo);
      write(data);
      const { accepted, ...rest } = verdict;
      return { ...rest, ordinal };
    },

    deletePhoto(id) {
      const data = read();
      data.photos = data.photos.filter(p => p.id !== id);
      data.hearts = data.hearts.filter(h => h.photo_id !== id);
      write(data);
    },

    persist() { write(read()); },

    getTasks({ activeOnly = false } = {}) {
      return read().tasks
        .filter(t => !t.deleted && (!activeOnly || t.active))
        .sort((a, b) => a.sort - b.sort || a.id - b.id);
    },
    getTask: id => read().tasks.find(t => t.id === Number(id)) ?? null,
    getTaskByText(text) {
      const m = read().tasks.filter(t => t.text === text).sort((a, b) => a.deleted - b.deleted || a.id - b.id);
      return m[0] ?? null;
    },
    createTask({ text, label, active = true }) {
      const data = read();
      const task = {
        id: data.tasks.reduce((m, t) => Math.max(m, t.id), 0) + 1,
        text, label, active: active ? 1 : 0, deleted: 0,
        sort: data.tasks.reduce((m, t) => Math.max(m, t.sort), 0) + 10,
        created_at: Date.now(),
      };
      data.tasks.push(task);
      write(data);
      return task;
    },
    updateTask(id, { text, label, active }) {
      const data = read();
      const t = data.tasks.find(x => x.id === Number(id));
      if (t && !t.deleted) { t.text = text; t.label = label; t.active = active ? 1 : 0; write(data); }
      return t ?? null;
    },
    deleteTask(id) {
      const data = read();
      const t = data.tasks.find(x => x.id === Number(id));
      if (t) { t.deleted = 1; t.active = 0; write(data); }
    },

    getSetting: key => read().settings[key] ?? null,
    setSetting(key, value) {
      const data = read();
      data.settings[key] = String(value);
      write(data);
    },

    deleteGuestPhotos(guestId) {
      const data = read();
      const gone = new Set(data.photos.filter(p => p.guest_id === guestId).map(p => p.id));
      data.hearts = data.hearts.filter(h => !gone.has(h.photo_id));
      data.photos = data.photos.filter(p => p.guest_id !== guestId);
      write(data);
    },

    close() {},
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

let _usingSqlite = false;

function init(dataDir, defaultPhotoLimit) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'photos'), { recursive: true });

  try {
    if (process.env.FORCE_JSON_DB) throw new Error('FORCE_JSON_DB set');
    _impl = makeSqliteImpl(dataDir);
    _usingSqlite = true;
    console.log('[db] Using better-sqlite3');
  } catch (err) {
    console.warn('[db] better-sqlite3 unavailable, using JSON fallback:', err.message);
    _impl = makeJsonImpl(dataDir);
    _impl.persist(); // write the migrated shape back once
  }
}

function isUsingSqlite() {
  return _usingSqlite;
}

// Proxy every method through to the implementation so callers do db.getGuest() etc.
const handler = {
  get(_, prop) {
    if (prop === 'init') return init;
    if (prop === 'isUsingSqlite') return isUsingSqlite;
    if (!_impl) throw new Error('db.init() not called yet');
    const val = _impl[prop];
    return typeof val === 'function' ? val.bind(_impl) : val;
  },
};

module.exports = new Proxy({}, handler);
