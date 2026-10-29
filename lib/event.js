'use strict';

/** Single source of truth for the event title. Load dotenv before requiring this. */
const EVENT_TITLE = process.env.EVENT_TITLE || 'Birthday Party';
/** Big gold badge on the welcome screen, e.g. "50". Empty = no badge. */
const EVENT_BADGE = (process.env.EVENT_BADGE || '').trim();

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = { EVENT_TITLE, EVENT_BADGE, escapeHtml };
