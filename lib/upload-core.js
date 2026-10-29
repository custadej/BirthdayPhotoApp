'use strict';

/**
 * Pure upload logic, shared by the browser (window.UploadCore) and the unit tests:
 * image sizing/quality ladder, JPEG header parsing, retry backoff, counters.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.UploadCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX_PX       = 1600;
  const QUALITIES    = [0.8, 0.7, 0.6, 0.5]; // first try, then smaller until under the target
  const TARGET_BYTES = 400 * 1024;
  const STALL_MS     = 30000;                   // abort only when no progress for this long
  const BACKOFF_MS   = [2000, 4000, 8000, 15000, 30000]; // then 30 s forever
  const ERROR_ROUNDS = 6;                       // failed rounds before the red box

  /** Scale (w, h) down so the long edge is at most max; never enlarges. */
  function fitSize(w, h, max = MAX_PX) {
    if (w <= max && h <= max) return { width: w, height: h };
    if (w >= h) return { width: max, height: Math.max(1, Math.round(h * max / w)) };
    return { width: Math.max(1, Math.round(w * max / h)), height: max };
  }

  /**
   * Encode with the quality ladder. encode(q) -> Promise<Blob-like with .size>.
   * Returns the first result under the target, else the one at the lowest quality.
   */
  async function encodeAdaptive(encode, target = TARGET_BYTES) {
    let blob = null;
    for (const q of QUALITIES) {
      blob = await encode(q);
      if (blob.size <= target) break;
    }
    return blob;
  }

  /** Delay before the next try after `failedRounds` (1-based) failures. */
  function backoffDelay(failedRounds) {
    const i = Math.max(1, failedRounds) - 1;
    return BACKOFF_MS[Math.min(i, BACKOFF_MS.length - 1)];
  }

  function isStalled(lastProgressAt, now, limit = STALL_MS) {
    return now - lastProgressAt > limit;
  }

  /** 4xx (except timeout / rate limit) will not fix itself by retrying. */
  function isPermanentStatus(status) {
    return status >= 400 && status < 500 && status !== 408 && status !== 429;
  }

  /**
   * Slots the queued photos will use. A queued photo whose task is not completed yet (and is
   * the first queued one for that task) gives its slot back as a bonus, so it costs nothing.
   */
  function pendingCost(items, completedTaskIds) {
    const done = new Set((completedTaskIds || []).map(Number));
    let cost = 0;
    for (const it of items) {
      const id = it.taskId != null && it.taskId !== '' ? Number(it.taskId) : NaN;
      if (!Number.isNaN(id) && !done.has(id)) { done.add(id); continue; }
      cost++;
    }
    return cost;
  }

  function effectiveRemaining(serverRemaining, pendingCount) {
    return Math.max(0, serverRemaining - pendingCount);
  }

  function percent(loaded, total) {
    if (!(total > 0)) return 0;
    return Math.max(0, Math.min(100, Math.round(loaded / total * 100)));
  }

  /** Seconds left from the average speed so far; null until there is enough data. */
  function etaSeconds(loaded, total, elapsedMs) {
    if (!(loaded > 0) || !(total > loaded) || !(elapsedMs >= 500)) return null;
    return Math.max(1, Math.ceil((total - loaded) / (loaded / elapsedMs) / 1000));
  }

  function etaText(sec) {
    if (sec == null) return '';
    if (sec < 60) return `še ${sec} s`;
    return `še ${Math.floor(sec / 60)} min ${sec % 60} s`;
  }

  function progressText(pct, eta) {
    if (pct >= 100) return 'Končujem…';
    return `Pošiljam… ${pct} %` + (eta == null ? '' : ` · ${etaText(eta)}`);
  }

  /**
   * Width, height and EXIF orientation from the first bytes of a JPEG
   * (Uint8Array). Returns null when it cannot tell. Reported size is the
   * stored one; orientation 5-8 means it is displayed rotated.
   */
  function parseJpegInfo(b) {
    if (!b || b.length < 4 || b[0] !== 0xFF || b[1] !== 0xD8) return null;
    let orientation = 1, width = 0, height = 0;
    let i = 2;
    while (i + 4 <= b.length) {
      if (b[i] !== 0xFF) { i++; continue; }
      const marker = b[i + 1];
      if (marker === 0xFF) { i++; continue; }
      if (marker === 0xD8 || (marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) { i += 2; continue; }
      const len = (b[i + 2] << 8) | b[i + 3];
      if (len < 2) return null;
      const seg = i + 4;
      if (marker === 0xE1 && b[seg] === 0x45 && b[seg + 1] === 0x78 && b[seg + 2] === 0x69 && b[seg + 3] === 0x66) {
        orientation = readExifOrientation(b, seg + 6, i + 2 + len) || 1;
      }
      const isSof = marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
      if (isSof) {
        if (seg + 5 > b.length) return null;
        height = (b[seg + 1] << 8) | b[seg + 2];
        width  = (b[seg + 3] << 8) | b[seg + 4];
        break;
      }
      i += 2 + len;
    }
    if (!width || !height) return null;
    return { width, height, orientation };
  }

  function readExifOrientation(b, t, end) {
    if (t + 8 > b.length) return 0;
    const le = b[t] === 0x49 && b[t + 1] === 0x49;
    if (!le && !(b[t] === 0x4D && b[t + 1] === 0x4D)) return 0;
    const u16 = p => le ? (b[p] | (b[p + 1] << 8)) : ((b[p] << 8) | b[p + 1]);
    const u32 = p => le
      ? (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0
      : ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
    const ifd = t + u32(t + 4);
    if (ifd + 2 > b.length || ifd + 2 > end) return 0;
    const n = u16(ifd);
    for (let k = 0; k < n; k++) {
      const e = ifd + 2 + k * 12;
      if (e + 12 > b.length) return 0;
      if (u16(e) === 0x0112) return u16(e + 8);
    }
    return 0;
  }

  /** Size as displayed (after EXIF rotation) for parseJpegInfo's result. */
  function displaySize(info) {
    if (!info) return null;
    return info.orientation >= 5 && info.orientation <= 8
      ? { width: info.height, height: info.width }
      : { width: info.width, height: info.height };
  }

  return {
    MAX_PX, QUALITIES, TARGET_BYTES, STALL_MS, BACKOFF_MS, ERROR_ROUNDS,
    fitSize, encodeAdaptive, backoffDelay, isStalled, isPermanentStatus,
    effectiveRemaining, pendingCost, percent, progressText, etaSeconds, etaText, parseJpegInfo, displaySize,
  };
});
