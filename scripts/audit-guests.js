#!/usr/bin/env node
'use strict';

/**
 * Read-only audit of every guest against a COPY of the data dir.
 *   node scripts/audit-guests.js [dataDir]      (default ./data)
 * Copies the data dir to a temp dir, starts the real server on it and exercises, per guest:
 * login (exact, fuzzy), /api/me, /api/tasks, upload eligibility, album-session, photo files.
 * Also checks DB integrity. Nothing in the real data dir is changed.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { randomUUID } = require('crypto');
const Database = require('better-sqlite3');
const { normalize, namesMatch } = require('../lib/names');

const src  = path.resolve(process.argv[2] || path.join(__dirname, '..', 'data'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-audit-'));
fs.cpSync(src, work, { recursive: true });
const PORT = 19990 + Math.floor(Math.random() * 9);
const BASE = `http://localhost:${PORT}`;
const problems = [];
const note = (who, msg) => { problems.push(`${who}: ${msg}`); console.log(`  PROBLEM  ${who}: ${msg}`); };
const ok = msg => console.log(`  ok       ${msg}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function integrity() {
  console.log('\n── Data integrity ──');
  const db = new Database(path.join(work, 'party.db'), { readonly: true });
  const guests = db.prepare('SELECT * FROM guests').all();
  const photos = db.prepare('SELECT * FROM photos ORDER BY created_at').all();
  const tokens = new Map();
  for (const g of guests) {
    if (tokens.has(g.token)) note(g.display_name, 'duplicate token');
    tokens.set(g.token, g.id);
    if (!g.token) note(g.display_name, 'empty token');
    if (!Number.isInteger(g.photo_limit) || g.photo_limit < 1) note(g.display_name, `bad photo_limit ${g.photo_limit}`);
    if (normalize(g.display_name) !== g.normalized_name) note(g.display_name, `normalized_name "${g.normalized_name}" != "${normalize(g.display_name)}"`);
    const mine = photos.filter(p => p.guest_id === g.id);
    if (mine.length > g.photo_limit) note(g.display_name, `${mine.length} photos > limit ${g.photo_limit}`);
    const ords = mine.map(p => p.ordinal).sort((a, b) => a - b);
    if (ords.some(o => !Number.isInteger(o))) note(g.display_name, 'NULL/non-integer ordinal');
    if (new Set(ords).size !== ords.length) note(g.display_name, `duplicate ordinals ${ords}`);
    if (ords.length && ords.some((o, i) => o !== i + 1)) note(g.display_name, `gapped ordinals ${ords}`);
  }
  for (let i = 0; i < guests.length; i++) for (let j = i + 1; j < guests.length; j++) {
    if (namesMatch(guests[i].normalized_name, guests[j].normalized_name)) {
      note(`${guests[i].display_name} / ${guests[j].display_name}`, 'fuzzy name conflict (login shows the "choose" step)');
    }
  }
  const guestIds = new Set(guests.map(g => g.id));
  for (const p of photos) {
    const who = `photo ${p.id.slice(0, 8)}`;
    if (!guestIds.has(p.guest_id)) note(who, 'orphan (guest missing)');
    for (const col of ['caption', 'task_text', 'task_label']) {
      if (p[col] != null && typeof p[col] !== 'string') note(who, `${col} has type ${typeof p[col]}`);
      if (typeof p[col] === 'string' && !p[col].trim()) note(who, `${col} is blank`);
    }
    if (p.caption && Array.from(p.caption).length > 140) note(who, 'caption longer than 140');
    const dir = path.join(work, 'photos', p.guest_id);
    if (!fs.existsSync(path.join(dir, `${p.id}.jpg`))) note(who, 'original file missing');
    else if (fs.statSync(path.join(dir, `${p.id}.jpg`)).size < 100) note(who, 'original file is empty');
    if (!fs.existsSync(path.join(dir, `${p.id}_thumb.jpg`))) note(who, 'thumb file missing (regenerated on demand)');
  }
  console.log(`  ${guests.length} guests, ${photos.length} photos checked`);
  db.close();
  return guests;
}

async function api(method, url, { token, body, json = true, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h['X-Guest-Token'] = token;
  let b = body;
  if (body && !(body instanceof FormData)) { h['Content-Type'] = 'application/json'; b = JSON.stringify(body); }
  const r = await fetch(BASE + url, { method, headers: h, body: b, redirect: 'manual' });
  let data = null;
  if (json) { const t = await r.text(); try { data = JSON.parse(t); } catch { data = t; } } else await r.arrayBuffer();
  return { status: r.status, data, headers: r.headers };
}

async function main() {
  const guests = integrity();
  const server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: work, ADMIN_KEY: 'audit', ALBUM_CODE: 'audit' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  server.stderr.on('data', d => { stderr += d; });
  try {
    for (let i = 0; i < 40; i++) { try { await fetch(`${BASE}/api/config`); break; } catch { await sleep(250); } }
    await api('POST', '/api/admin/album/toggle', { headers: { 'X-Admin-Key': 'audit' } }).then(async r => {
      if (r.data.open === false) await api('POST', '/api/admin/album/toggle', { headers: { 'X-Admin-Key': 'audit' } });
    });
    const jpg = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#778899' } }).jpeg().toBuffer();

    console.log('\n── Per guest ──');
    for (const g of guests) {
      const who = g.display_name;
      // login by the exact name, lowercased without diacritics, and with a typo
      const variants = [g.display_name, normalize(g.display_name), g.display_name.toUpperCase()];
      const first = g.display_name.split(' ');
      if (first.length > 1) variants.push(first.slice().reverse().join(' '));
      let token = null;
      for (const name of variants) {
        const r = await api('POST', '/api/login', { body: { name } });
        if (r.status !== 200) { note(who, `login "${name}" -> HTTP ${r.status} ${JSON.stringify(r.data)}`); continue; }
        if (r.data.status === 'ok') {
          if (r.data.guest.id !== g.id) note(who, `login "${name}" logged in the WRONG guest ${r.data.guest.displayName}`);
          else token = r.data.token;
        } else if (r.data.status === 'choose') {
          const ids = r.data.candidates.map(c => c.id);
          if (!ids.includes(g.id)) note(who, `login "${name}": choose list does not contain this guest`);
          const c = await api('POST', '/api/login/confirm', { body: { guestId: g.id } });
          if (c.status !== 200 || c.data.guest?.id !== g.id) note(who, `login/confirm -> HTTP ${c.status}`);
          else token = c.data.token;
          if (name === g.display_name) note(who, `exact name shows a "choose" step (${r.data.candidates.map(x => x.displayName).join(', ')})`);
        }
      }
      if (!token) { note(who, 'could not log in at all'); continue; }
      if (token !== g.token) note(who, 'login returned a different token than the stored one');

      const me = await api('GET', '/api/me', { token });
      if (me.status !== 200) { note(who, `/api/me -> HTTP ${me.status} ${JSON.stringify(me.data).slice(0, 200)}`); continue; }
      const tasks = await api('GET', '/api/tasks', { token });
      if (tasks.status !== 200 || !Array.isArray(tasks.data)) note(who, `/api/tasks -> HTTP ${tasks.status}`);
      for (const p of me.data.items) {
        for (const route of [`/photo/${p.id}`, `/thumb/${p.id}`]) {
          const r = await api('GET', route, { token, json: false });
          if (r.status !== 200) note(who, `${route} -> HTTP ${r.status}`);
        }
      }
      if (me.data.remaining > 0) {
        const fd = new FormData();
        fd.append('photo', new Blob([jpg]), 'p.jpg'); fd.append('clientId', randomUUID());
        const u = await api('POST', '/api/upload', { token, body: fd });
        if (u.status !== 200 || !u.data.ok) note(who, `upload (on the copy) -> HTTP ${u.status} ${JSON.stringify(u.data).slice(0, 200)}`);
      } else ok(`${who}: no photos left, upload skipped`);
      const meAfter = await api('GET', '/api/me', { token });
      const sess = await api('POST', '/api/album-session', { token });
      if (meAfter.data.items?.length > 0 && sess.status !== 200) note(who, `album-session -> HTTP ${sess.status} ${JSON.stringify(sess.data)}`);
      ok(`${who}: login, /api/me, tasks, upload, album-session`);
    }

    console.log('\n── Album / admin pages built from the same rows ──');
    const adm = { headers: { 'X-Admin-Key': 'audit' } };
    for (const route of ['/api/album/photos', '/api/admin/guests', '/api/admin/stats', '/api/admin/tasks']) {
      const r = await api('GET', route, adm);
      if (r.status !== 200) note(route, `HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`); else ok(route);
    }
    const list = await api('GET', '/api/album/photos', adm);
    for (const p of (list.data.photos || []).slice(0, 200)) {
      for (const route of [`/album/medium/${p.id}`, `/album/thumb/${p.id}`, `/album/card/${p.id}.jpg`]) {
        const r = await api('GET', route, { ...adm, json: false });
        if (r.status !== 200) note(`photo ${p.id.slice(0, 8)}`, `${route.split('/')[2]} -> HTTP ${r.status}`);
      }
    }
  } finally {
    server.kill();
    if (/Error|at /.test(stderr)) { console.log('\n── Server stderr ──\n' + stderr.slice(0, 3000)); problems.push('server wrote errors to stderr'); }
    fs.rmSync(work, { recursive: true, force: true });
  }
  console.log(`\n${problems.length ? problems.length + ' problem(s) found' : 'No problems found'}`);
  process.exit(problems.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
