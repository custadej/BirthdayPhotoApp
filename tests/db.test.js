'use strict';

/** Migration + new photo fields, for both the SQLite and the JSON backend. */

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { spawnSync } = require('child_process');

const child = `
const fs = require('fs'), path = require('path'), assert = require('assert');
const dir = process.argv[1], mode = process.argv[2];
const db = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'db'))});

if (mode === 'seed-old') {
  // Pre-migration shape: no ordinal/caption/task_text
  if (process.env.FORCE_JSON_DB) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'party.json'), JSON.stringify({
      guests: [{ id: 'g1', display_name: 'A B', normalized_name: 'a b', token: 't', photo_limit: 10, created_at: 1 }],
      photos: [
        { id: 'p2', guest_id: 'g1', client_id: 'c2', task_id: null, created_at: 20, task_text: 'Slikaj nekoga, ki pleše' },
        { id: 'p1', guest_id: 'g1', client_id: 'c1', task_id: null, created_at: 10 },
      ],
    }));
  } else {
    fs.mkdirSync(dir, { recursive: true });
    const D = require('better-sqlite3');
    const x = new D(path.join(dir, 'party.db'));
    x.exec(\`CREATE TABLE guests (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, normalized_name TEXT NOT NULL, token TEXT NOT NULL UNIQUE, photo_limit INTEGER NOT NULL DEFAULT 10, created_at INTEGER NOT NULL);
      CREATE TABLE photos (id TEXT PRIMARY KEY, guest_id TEXT NOT NULL, client_id TEXT NOT NULL UNIQUE, task_id TEXT, created_at INTEGER NOT NULL, task_text TEXT);
      INSERT INTO guests VALUES ('g1','A B','a b','t',10,1);
      INSERT INTO photos VALUES ('p2','g1','c2',NULL,20,'Slikaj nekoga, ki pleše');
      INSERT INTO photos VALUES ('p1','g1','c1',NULL,10,NULL);\`);
    x.close();
  }
} else {
  for (let round = 0; round < 2; round++) {          // second round: migration is idempotent
    db.init(dir, 10);
    const ps = db.getPhotosByGuest('g1');
    const by = Object.fromEntries(ps.map(p => [p.id, p]));
    assert.strictEqual(by.p1.ordinal, 1, 'oldest photo gets ordinal 1');
    assert.strictEqual(by.p2.ordinal, 2);
    assert.strictEqual(by.p1.caption, null);
    assert.strictEqual(by.p1.task_text, null);
    if (round === 0) assert.strictEqual(db.getGuest('g1').photo_limit, 15, 'every guest gets the base limit 15 once');
    assert.strictEqual(by.p2.task_label, 'Slika nekoga, ki pleše', 'old task_text gets the seed label');
    assert.strictEqual(by.p1.task_label, null);
    assert.strictEqual(db.getTasks().length, round === 0 ? 37 : 36, 'tasks seeded once, soft delete survives restart');
    if (round === 0) {
      const r = db.createPhoto({ id: 'p3', guestId: 'g1', clientId: 'c3', createdAt: 30, caption: 'hej', taskText: 'Slikaj torto ali sladico' }, 10);
      assert.strictEqual(r.ordinal, 3);
      assert.strictEqual(r.bonus, 2, 'old photo with task_text counts retroactively + the new task');
      assert.strictEqual(r.bonusGranted, true);
      assert.strictEqual(r.remaining, 10 + 2 - 3);
      assert.throws(() => db.createPhoto({ id: 'p4', guestId: 'g1', clientId: 'c4', createdAt: 40 }, 1), /PHOTO_LIMIT_EXCEEDED/);
      assert.strictEqual(db.getSetting('album_open'), null);
      db.setSetting('album_open', '1');
      // limit migration is one-time: a later lower limit stays
      db.setGuestLimit('g1', 12);
      // soft delete: hidden from lists but still resolvable
      const t1 = db.getTasks()[0];
      db.deleteTask(t1.id);
      assert.strictEqual(db.getTask(t1.id).deleted, 1);
      assert.strictEqual(db.getTaskByText(t1.text).id, t1.id);
      assert.ok(!db.getTasks({ activeOnly: true }).some(t => t.id === t1.id));
      const nt = db.createTask({ text: 'Nova', label: 'Nova slika', active: false });
      assert.ok(nt.id > 37 && nt.active === 0);
      assert.ok(!db.getTasks({ activeOnly: true }).some(t => t.id === nt.id));
      db.updateTask(nt.id, { text: 'Nova2', label: 'L', active: true });
      assert.strictEqual(db.getTask(nt.id).text, 'Nova2');
      db.deleteTask(nt.id);
      // hearts + quota work in both backends
      assert.deepStrictEqual(db.toggleHeart('p3', 'v:aaa'), { hearted: true, count: 1 });
      assert.deepStrictEqual(db.toggleHeart('p3', 'v:bbb'), { hearted: true, count: 2 });
      assert.deepStrictEqual(db.toggleHeart('p3', 'v:aaa'), { hearted: false, count: 1 });
      assert.deepStrictEqual(db.getHeartCounts(), { p3: 1 });
      assert.deepStrictEqual(db.getVoterHearts('v:bbb'), ['p3']);
      const q = db.getQuota('g1');
      assert.ok(q.bonus === 2 && q.used === 3 && q.remaining === q.limit + 2 - 3, 'quota computed from the photos');
      // separate guest so the main fixture stays intact
      db.createGuest({ id: 'g9', displayName: 'Hrani Gost', normalizedName: 'hrani gost', token: 't9', photoLimit: 5 });
      for (const id of ['h1', 'h2']) db.createPhoto({ id, guestId: 'g9', clientId: 'c-' + id, createdAt: 200 }, 5);
      db.toggleHeart('h1', 'v:aaa'); db.toggleHeart('h2', 'v:aaa');
      db.deletePhoto('h1');
      assert.deepStrictEqual(db.getHeartCounts(), { p3: 1, h2: 1 }, 'hearts removed with the photo');
      db.deleteGuestPhotos('g9');
      assert.deepStrictEqual(db.getHeartCounts(), { p3: 1 }, 'hearts removed with the guest photos');
      db.createPhoto({ id: 'h3', guestId: 'g9', clientId: 'c-h3', createdAt: 300 }, 5);
      db.toggleHeart('h3', 'v:aaa'); db.toggleHeart('p3', 'g:g9');
      db.deleteGuest('g9');
      assert.deepStrictEqual(db.getHeartCounts(), { p3: 1 }, 'deleting a guest removes the photo hearts and their own votes');
    } else {
      assert.strictEqual(db.getPhoto('p3').caption, 'hej');
      assert.strictEqual(db.getPhoto('p3').task_text, 'Slikaj torto ali sladico');
      assert.strictEqual(db.getSetting('album_open'), '1');
      assert.strictEqual(db.getGuest('g1').photo_limit, 12, 'limit migration does not run twice');
    }
    db.close();
  }
}
`;

let n = 0;
for (const backend of ['sqlite', 'json']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bpadb-${backend}-`));
  const env = { ...process.env, ...(backend === 'json' ? { FORCE_JSON_DB: '1' } : {}) };
  delete env.NODE_OPTIONS;
  for (const mode of ['seed-old', 'check']) {
    const r = spawnSync('node', ['-e', child, dir, mode], { env, encoding: 'utf8' });
    if (r.status !== 0) { console.error(r.stdout, r.stderr); process.exit(1); }
  }
  n++;
  console.log(`  PASS  migration + new fields (${backend})`);
}
console.log(`\nDB results: ${n} passed`);
