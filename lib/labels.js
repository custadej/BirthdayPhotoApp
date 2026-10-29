'use strict';

/**
 * Photo label helpers, shared by server (CommonJS) and browser (window.Labels).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Labels = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const ORDINALS = ['Prva', 'Druga', 'Tretja', 'Četrta', 'Peta', 'Šesta', 'Sedma', 'Osma', 'Deveta', 'Deseta'];
  const MAX_CAPTION = 140;

  function ordinalLabel(n) {
    n = Math.floor(Number(n));
    if (!(n >= 1)) n = 1;
    return n <= ORDINALS.length ? `${ORDINALS[n - 1]} slika` : `${n}. slika`;
  }

  /** Trim and cap at 140 characters (by code point). Empty becomes null. */
  function cleanCaption(raw) {
    if (typeof raw !== 'string') return null;
    const chars = Array.from(raw.trim());
    const s = chars.slice(0, MAX_CAPTION).join('').trim();
    return s || null;
  }

  /** "Naloga: {task}" or '' */
  function taskLine(taskText) {
    return taskText ? `Naloga: ${taskText}` : '';
  }

  /**
   * Label rules:
   *  1. caption          -> "{caption} - {Name}", second line "Naloga: {task_text}" if the photo has a task
   *  2. task, no caption -> "{task_label or task_text} - {Name}", no second line
   *  3. otherwise        -> "{Ordinal} slika - {Name}"
   */
  function describe({ caption, ordinal, name, taskText, taskLabel }) {
    const c = typeof caption === 'string' ? caption.trim() : '';
    const t = typeof taskText === 'string' ? taskText.trim() : '';
    if (c) return { label: `${c} - ${name}`, task: taskLine(t) };
    if (t) return { label: `${(typeof taskLabel === 'string' && taskLabel.trim()) || t} - ${name}`, task: '' };
    return { label: `${ordinalLabel(ordinal)} - ${name}`, task: '' };
  }

  /**
   * A caption that is just the task label (case-insensitive) is the prefill the guest left
   * untouched: store NULL so the label rules show "{task label} - {Name}" without a duplicate line.
   */
  function captionForTask(caption, taskLabel) {
    const c = cleanCaption(caption);
    if (!c) return null;
    const l = typeof taskLabel === 'string' ? taskLabel.trim() : '';
    return l && c.toLowerCase() === l.toLowerCase() ? null : c;
  }

  function photoLabel(p) {
    return describe(p).label;
  }

  return { ordinalLabel, cleanCaption, captionForTask, describe, photoLabel, taskLine, MAX_CAPTION };
});
