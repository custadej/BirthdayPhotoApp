'use strict';

/**
 * In-memory failed-attempt limiter: at most `max` failures per key within `windowMs`.
 * Only failures are recorded; a correct password never counts.
 */
function createLimiter({ max = 5, windowMs = 10 * 60 * 1000, now = Date.now } = {}) {
  const hits = new Map(); // key -> array of failure timestamps

  function recent(key) {
    const t = now();
    const list = (hits.get(key) || []).filter(ts => t - ts < windowMs);
    if (list.length) hits.set(key, list); else hits.delete(key);
    return list;
  }

  const timer = setInterval(() => { for (const k of [...hits.keys()]) recent(k); }, windowMs);
  if (timer.unref) timer.unref();

  return {
    isBlocked: key => recent(key).length >= max,
    fail(key) { const list = recent(key); list.push(now()); hits.set(key, list); },
  };
}

module.exports = { createLimiter };
