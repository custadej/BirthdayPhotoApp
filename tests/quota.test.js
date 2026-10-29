'use strict';

const assert = require('assert');
const Q = require('../lib/quota');
const U = require('../lib/upload-core');

let n = 0;
function t(name, fn) { fn(); n++; console.log(`  PASS  ${name}`); }
const photo = (task_id, task_text = null) => ({ task_id, task_text });

t('photoKey: task_id first, else task_text, else null', () => {
  assert.strictEqual(Q.photoKey(photo('7', 'x')), '7');
  assert.strictEqual(Q.photoKey(photo(null, 'Slikaj torto')), 'Slikaj torto');
  assert.strictEqual(Q.photoKey(photo(null, null)), null);
  assert.strictEqual(Q.photoKey(photo('', null)), null);
});
t('first task photo is net free (+1)', () => {
  const r = Q.evaluateUpload({ limit: 3, photos: [], photo: photo('1') });
  assert.ok(r.accepted && r.bonusGranted && r.bonus === 1 && r.remaining === 3 && r.used === 1);
});
t('same task twice gives no extra', () => {
  const r = Q.evaluateUpload({ limit: 3, photos: [photo('1')], photo: photo('1') });
  assert.ok(r.accepted && !r.bonusGranted && r.bonus === 1 && r.remaining === 2);
});
t('two different tasks give +2', () => {
  const r = Q.evaluateUpload({ limit: 3, photos: [photo('1')], photo: photo('2') });
  assert.ok(r.bonusGranted && r.bonus === 2 && r.remaining === 3);
  assert.deepStrictEqual(r.completedTaskIds, [1, 2]);
});
t('at 0 slots a plain photo is rejected, but a photo for a NEW task is accepted (net free)', () => {
  const full = [photo(null), photo(null)];
  assert.strictEqual(Q.evaluateUpload({ limit: 2, photos: full, photo: photo(null) }).accepted, false);
  const r = Q.evaluateUpload({ limit: 2, photos: full, photo: photo('5') });
  assert.ok(r.accepted && r.bonusGranted && r.bonus === 1 && r.remaining === 0, 'task photo at 0: accepted, still 0 left, +1 bonus');
});
t('at 0 slots a task already completed is rejected', () => {
  const photos = [photo('5'), photo(null)];                // limit 1 + bonus 1 = 2 allowed, 2 used
  assert.strictEqual(Q.evaluateUpload({ limit: 1, photos, photo: photo('5') }).accepted, false);
  assert.strictEqual(Q.evaluateUpload({ limit: 1, photos, photo: photo('6') }).accepted, true);
});
t('a guest over the allowance (took more than limit + bonus) cannot add anything', () => {
  const over = [photo(null), photo(null), photo(null), photo(null)];   // limit 2, 4 used
  assert.strictEqual(Q.evaluateUpload({ limit: 2, photos: over, photo: photo('9') }).accepted, false);
  assert.strictEqual(Q.computeQuota({ limit: 2, used: 4, keys: Q.keysOf(over) }).remaining, 0);
});
t('with earned bonus the guest can use the extra slot', () => {
  const photos = [photo('1'), photo(null)];               // limit 2, bonus 1 -> 3 allowed
  assert.strictEqual(Q.evaluateUpload({ limit: 2, photos, photo: photo(null) }).accepted, true);
  assert.strictEqual(Q.evaluateUpload({ limit: 2, photos: [...photos, photo(null)], photo: photo(null) }).accepted, false);
});
t('old photos identified by task_text count retroactively (and not twice)', () => {
  const photos = [photo(null, 'Slikaj torto'), photo(null, 'Slikaj torto'), photo(null, 'Slikaj nekaj rdečega')];
  const q = Q.computeQuota({ limit: 5, used: 3, keys: Q.keysOf(photos) });
  assert.strictEqual(q.bonus, 2);
  assert.strictEqual(q.remaining, 4);
  assert.deepStrictEqual(q.completedTaskIds, []);          // text identities have no numeric id
});
t('pendingCost: the first queued photo of a new task nets zero', () => {
  assert.strictEqual(U.pendingCost([{ taskId: 4 }, { taskId: 4 }, { taskId: null }, { taskId: 9 }], [9]), 3);
  assert.strictEqual(U.pendingCost([{ taskId: 4 }], []), 0);
  assert.strictEqual(U.pendingCost([{ taskId: '4' }, { taskId: 5 }], [4]), 1);
  assert.strictEqual(U.pendingCost([], []), 0);
});

console.log(`\nQuota results: ${n} passed`);
