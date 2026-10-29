# BirthdayPhotoApp

Party photo web app: guests scan a QR code, take photos in the browser, solve photo tasks for bonus photos, and browse a shared album with hearts the next day. No build step — plain Node.js + Express + vanilla HTML/CSS/JS. UI texts are Slovenian.

## Stack
- Node 20+, Express, better-sqlite3 (JSON fallback), multer, sharp, archiver, qrcode, cookie-parser
- Frontend: `public/app.js` + `public/style.css`, pages in `views/` (served with `{{placeholders}}`)
- Config: `.env` (see `.env.example`); everything personal (event title, domain, codes) lives there

## Key files
- `server.js` — all routes, admin page HTML, card rendering (sharp), album access
- `lib/db.js` — SQLite or JSON fallback with the same interface, idempotent migrations
- `lib/quota.js` — photo allowance (limit + one bonus per distinct completed task)
- `lib/labels.js` — photo label rules, shared by server and browser
- `lib/names.js` — name normalization + fuzzy matching
- `lib/upload-core.js` — client upload helpers (resize sizes, ETA, queue cost), shared with tests
- `public/app.js` — guest UI state machine and background upload queue
- `views/album.html` — album page (sorting, lightbox, hearts, save to gallery)
- `scripts/audit-guests.js` — read-only health check of every guest against a copy of the data
- `tests/*.test.js` — unit + integration tests (each integration test starts a real server)

## Run
```
npm install
cp .env.example .env   # edit it
node server.js
npm test
```

## Notes
- Guest session: cookie "gid" (HttpOnly) + localStorage token + X-Guest-Token header
- Admin at /admin (login page; ?key=ADMIN_KEY also works). Album at /album (code link or guest session)
- Photos at DATA_DIR/photos/{guestId}/{uuid}.jpg; derived files in DATA_DIR/{cards,medium}
- Must be served over https: some browser APIs used by the guest app only exist in secure contexts
- Never commit `.env` or `data/` (they are in .gitignore)
