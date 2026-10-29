'use strict';

// Server-side derived images (thumb 900px, medium 1280px) made with sharp.
// Jobs run through a small queue (default 2 at a time) so a burst of uploads
// cannot starve the Pi; the same destination is never generated twice at once.

const fs = require('fs');
const path = require('path');

function createQueue(concurrency = 2) {
  const waiting = [];
  let active = 0;

  function pump() {
    while (active < concurrency && waiting.length) {
      const { fn, resolve, reject } = waiting.shift();
      active++;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; pump(); });
    }
  }

  return {
    /** Run fn when a slot is free. priority:true jumps ahead of background jobs. */
    run(fn, { priority = false } = {}) {
      return new Promise((resolve, reject) => {
        const job = { fn, resolve, reject };
        if (priority) waiting.unshift(job); else waiting.push(job);
        pump();
      });
    },
    get active() { return active; },
    get waiting() { return waiting.length; },
  };
}

function createThumbService({ sharp, concurrency = 2 }) {
  const queue = createQueue(concurrency);
  const inflight = new Map(); // dest -> promise

  /** Make dest (a JPEG fitting size x size) from src. Resolves to dest. */
  function make(src, dest, { size, quality }, opts = {}) {
    if (fs.existsSync(dest)) return Promise.resolve(dest);
    if (inflight.has(dest)) {
      const existing = inflight.get(dest);
      return existing;
    }
    const job = queue.run(async () => {
      if (fs.existsSync(dest)) return dest;
      const buf = await sharp(src)
        .rotate()
        .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer();
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, buf);
      await fs.promises.rename(tmp, dest);
      return dest;
    }, opts).finally(() => inflight.delete(dest));
    inflight.set(dest, job);
    return job;
  }

  return {
    queue,
    thumb:  (src, dest, opts) => make(src, dest, { size: 900,  quality: 82 }, opts),
    medium: (src, dest, opts) => make(src, dest, { size: 1280, quality: 82 }, opts),
  };
}

module.exports = { createQueue, createThumbService };
