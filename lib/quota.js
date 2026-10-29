'use strict';

/**
 * Photo allowance. Every DIFFERENT task a guest has completed gives +1 photo, once per task.
 * Allowed = limit + distinct completed tasks. The bonus is always computed from the photos,
 * never stored, so it also applies retroactively.
 */

/** Identity of the task a photo completed, or null: task_id, else the task text snapshot. */
function photoKey(p) {
  const k = p.task_id != null && p.task_id !== '' ? p.task_id : (p.task_text != null && p.task_text !== '' ? p.task_text : null);
  return k == null ? null : String(k);
}

function keysOf(photos) {
  const set = new Set();
  for (const p of photos) { const k = photoKey(p); if (k !== null) set.add(k); }
  return set;
}

/** Numeric task ids among the completed keys (what the guest app needs to skip tasks). */
function completedTaskIds(keys) {
  return [...keys].filter(k => /^\d+$/.test(k)).map(Number).sort((a, b) => a - b);
}

function computeQuota({ limit, used, keys }) {
  return {
    limit,
    used,
    bonus: keys.size,
    remaining: Math.max(0, limit + keys.size - used),
    completedTaskIds: completedTaskIds(keys),
  };
}

/**
 * The single rule for accepting a photo: used < limit + bonus before this photo.
 * Exception: a photo for a NEW task is accepted when exactly 0 slots are left, because it
 * gives its slot straight back (+1 bonus). So at 0 a guest can still earn photos with tasks.
 * Returns the state after inserting `photo` (a row-like object with task_id / task_text).
 */
function evaluateUpload({ limit, photos, photo }) {
  const before = keysOf(photos);
  const key = photoKey(photo);
  const granted = key !== null && !before.has(key);
  const allowed = limit + before.size;
  if (photos.length > allowed || (photos.length === allowed && !granted)) return { accepted: false };
  const after = new Set(before);
  if (granted) after.add(key);
  return {
    accepted: true,
    bonusGranted: granted,
    ...computeQuota({ limit, used: photos.length + 1, keys: after }),
  };
}

module.exports = { photoKey, keysOf, completedTaskIds, computeQuota, evaluateUpload };
