# BirthdayPhotoApp

A self-hosted party photo app. Guests scan a QR code, type their name once, and take photos right in the phone browser. No app install, no account. Photos can come with a short caption or a fun photo task, every solved task earns an extra photo, and the next day everybody gets a shared album with hearts, sorting and "save to gallery".

It was built for a 50th birthday party and ran on a Raspberry Pi 4 behind a Cloudflare Tunnel. It is plain Node.js + Express + vanilla HTML/CSS/JS with SQLite storage. There is no build step and no external service.

> The guest-facing texts are in **Slovenian**. See [Changing the language](#changing-the-language) if you want another one.

---

## Contents

- [How it works](#how-it-works)
- [Features](#features)
- [Quick start (local)](#quick-start-local)
- [Configuration](#configuration)
- [Hosting it on a server](#hosting-it-on-a-server)
  - [1. Get a machine](#1-get-a-machine)
  - [2. Install and configure](#2-install-and-configure)
  - [3. Keep it running](#3-keep-it-running)
  - [4. Point a domain at it](#4-point-a-domain-at-it)
  - [5. Make the QR code](#5-make-the-qr-code)
- [Running the party](#running-the-party)
- [The admin page](#the-admin-page)
- [The album](#the-album)
- [Photo allowance and tasks](#photo-allowance-and-tasks)
- [Security and privacy](#security-and-privacy)
- [Backups](#backups)
- [Customising](#customising)
- [Project layout](#project-layout)
- [HTTP API overview](#http-api-overview)
- [Tests and the guest audit](#tests-and-the-guest-audit)
- [Troubleshooting](#troubleshooting)

---

## How it works

```
 phone browser ──https──►  your domain  ──►  reverse proxy / tunnel  ──►  Node.js (server.js)
 (guest, album, admin)                                                    │
                                                                          ├── SQLite  (DATA_DIR/party.db)
                                                                          └── photos  (DATA_DIR/photos/<guest>/<id>.jpg)
```

**Guest flow**

1. A guest scans the QR code and opens the welcome page.
2. They type their name. Names are matched fuzzily (accents, typos, "Last First", an initial instead of the surname), so a guest who comes back is recognised and a stranger is asked "who are you?". The session is kept in a cookie plus `localStorage`, so reloading or switching to another browser tab never asks again.
3. The big camera button opens the phone camera. The photo is shrunk **on the phone** (long edge 1600 px, about 400 KB), shown in a preview where the guest can add a short caption, and put into an upload queue.
4. The queue uploads in the background with a progress bar and "seconds left". If the connection is bad, uploads are retried with back-off and survive a page reload (unsent photos are kept in IndexedDB). The server stores the photo exactly once, even if a response gets lost.
5. After the first photo the guest also sees a **photo task** ("Photograph someone dancing"). Photos taken with "Slikaj nalogo" complete that task and give **one extra photo**.

**Album**

When the host opens the album (admin switch), guests tap "Poglej si celoten album" in the app, or open the album link/code. The album shows every photo, newest first, with captions, a guest filter, sorting (newest, oldest, most hearted), a lightbox with swipe/arrow keys, hearts, and a "save to gallery" button that shares a caption card as an image (on iOS you then tap "Save Image" and it lands in Photos).

**Server side**

- `better-sqlite3` for storage, with an automatic JSON-file fallback if the native module cannot be built.
- `sharp` renders caption cards (white card, gold border, photo, caption, task line) and the 1280 px album images. They are generated on demand and cached.
- Everything the host needs is on one admin page: guests, photos, tasks, album switches, zip download.

---

## Features

**Guests**
- QR code → name → camera. Works in the phone browser, iOS and Android.
- Photo preview with optional caption (140 characters), prefilled with the task title for task photos.
- Background upload queue, real progress with time left, automatic resume after reload or a lost connection, no double uploads.
- Photo tasks with a bonus photo per solved task (edited in the admin, no code needed).
- Own photos strip with fullscreen viewer.
- The page updates itself when a new version is deployed (when nothing is being sent).

**Album**
- Newest-first grid (1280 px images), guest filter, three sort modes, lightbox with swipe/keys.
- Hearts (one per person per photo, not on your own photos), shown in red on the photos.
- Save a caption card to the phone gallery (system share sheet) or download it on desktop.
- Optional "download everything" zip for guests (off by default).
- Access by a code link, by the guest session from the app, or without a password if you switch the password off.

**Host / admin**
- Login page, guest list with used photos, limit, bonus and hearts.
- Delete photos or guests, reset a guest, give a guest +5 photos.
- Task editor (text, photo title, active, delete).
- Switches: album open/closed, album password on/off, guest download-all on/off.
- One-click zip of all photos: `originali/` (as uploaded) and `z-opisi/` (caption cards).
- Failed uploads and client-side errors are logged to files for diagnosis.

**Safety nets**
- Per-IP brute-force protection on the admin login and the album code.
- Idempotent uploads, limits enforced in a database transaction.
- Idempotent migrations, nothing is ever deleted by an upgrade.
- A read-only audit script that exercises every guest against a copy of the data.

---

## Quick start (local)

Requirements: Node.js 20 or newer. A C/C++ toolchain is only needed if no prebuilt binary exists for `better-sqlite3` on your platform (otherwise the app falls back to a JSON file).

```bash
git clone https://github.com/<you>/BirthdayPhotoApp.git
cd BirthdayPhotoApp
npm install
cp .env.example .env     # then edit .env (at least ADMIN_KEY and EVENT_TITLE)
node server.js
```

Open `http://localhost:3000` for the guest page, `http://localhost:3000/admin` for the admin. Run the tests with `npm test`.

On localhost plain `http` is fine. **On a real server you must use https**, see below.

---

## Configuration

All settings are environment variables, normally set in `.env` (copy `.env.example`). `.env` is in `.gitignore`, never commit it.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port the app listens on. |
| `PUBLIC_URL` | `http://localhost:<PORT>` | Public https address. Used for the QR code and the album link shown in the admin. |
| `ADMIN_KEY` | `changeme` | Admin password. **Change it.** Use something long and random: `openssl rand -base64 24`. |
| `ALBUM_CODE` | generated | Code for the `/album?code=...` link. Not case sensitive. If empty, one is generated on first start, stored in the database and printed in the log. |
| `EVENT_TITLE` | `Birthday Party` | Title shown everywhere (welcome screen, album, admin, caption cards, QR sheet). The first word is the big line, the rest is the smaller line below it. |
| `EVENT_BADGE` | empty | Optional big gold badge on the welcome screen, for example `50` or `30`. Empty = none. |
| `PHOTO_LIMIT` | `15` | Base photos per guest. Every different task a guest completes adds one. |
| `DATA_DIR` | `./data` | Where the database, photos and caches live. Put it on a disk with enough space. |
| `FORCE_JSON_DB` | unset | Set to `1` to use the JSON-file storage instead of SQLite (used by the tests). |

Photo limits are stored per guest. Changing `PHOTO_LIMIT` later only affects guests created afterwards.

---

## Hosting it on a server

Any machine that can run Node.js 20 works: a Raspberry Pi, a small VPS, an old laptop, a NAS. A Raspberry Pi 4 handled a party of about twenty guests without problems. Phones do the heavy work (resizing), the server mostly stores files.

You need three things: the app running, **https**, and a name (domain) that points at it.

> **Why https is required.** Parts of the guest app (secure random IDs, the share sheet used for "save to gallery", clipboard) only exist in "secure contexts". If a guest opens the plain `http://` address the upload can fail. The server redirects `http` → `https` when it sits behind a proxy that reports the original scheme (Cloudflare and nginx both do), but you still need https in front of it.

### 1. Get a machine

- Raspberry Pi OS / Debian / Ubuntu all work. Make sure it has an internet connection and enough disk space: reckon about 0.5 MB per photo plus about the same again for generated album images.
- Install Node.js 20+ (for example from [nodejs.org](https://nodejs.org/) or NodeSource) and `git`.

### 2. Install and configure

```bash
git clone https://github.com/<you>/BirthdayPhotoApp.git
cd BirthdayPhotoApp
npm install --omit=dev
cp .env.example .env
nano .env
```

Set at least:

```env
PORT=3000
PUBLIC_URL=https://photos.example.com     # your real public address
ADMIN_KEY=<long random string>
ALBUM_CODE=<something short you can read out>
EVENT_TITLE=Anna's 40th
EVENT_BADGE=40
PHOTO_LIMIT=15
```

Test it once in the foreground: `node server.js`, then open `http://<server-ip>:3000` from your laptop.

### 3. Keep it running

Pick one.

**systemd** (recommended, starts on boot and restarts on crashes). Create `/etc/systemd/system/birthdayphotoapp.service`:

```ini
[Unit]
Description=BirthdayPhotoApp
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/BirthdayPhotoApp
EnvironmentFile=/home/pi/BirthdayPhotoApp/.env
ExecStart=/usr/bin/node server.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now birthdayphotoapp
sudo journalctl -fu birthdayphotoapp      # logs
```

**PM2**: `npm i -g pm2 && pm2 start server.js --name birthdayphotoapp && pm2 save && pm2 startup`.

**tmux** (what the original party used, simplest for a one-off): `tmux new -s photos 'node server.js; read'`, detach with `Ctrl+b d`, come back with `tmux attach -t photos`. To restart: attach, `Ctrl+C`, press Enter at the `read` prompt, start it again.

### 4. Point a domain at it

You need a domain you control (for example `example.com`) and a subdomain for the app (for example `photos.example.com`). Two common ways:

#### Option A: Cloudflare Tunnel (no open ports, free, works behind a home router)

Good when the server is at home: no port forwarding, https is handled by Cloudflare.

1. Put your domain on Cloudflare (free plan) and install `cloudflared` on the server ([install guide](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)).
2. Log in and create a tunnel:
   ```bash
   cloudflared tunnel login
   cloudflared tunnel create birthdayphotoapp
   ```
   This prints a tunnel UUID and writes a credentials file.
3. Create `/etc/cloudflared/config.yml` (or `~/.cloudflared/config.yml`):
   ```yaml
   tunnel: <TUNNEL-UUID>
   credentials-file: /home/pi/.cloudflared/<TUNNEL-UUID>.json
   ingress:
     - hostname: photos.example.com
       service: http://localhost:3000
     - service: http_status:404
   ```
   If you already run other hostnames through the same tunnel, add this as one more `hostname` rule **before** the final `http_status:404` rule. Validate with `cloudflared tunnel ingress validate`.
4. Create the DNS record, either with `cloudflared tunnel route dns birthdayphotoapp photos.example.com` or by hand in the Cloudflare dashboard: type **CNAME**, name `photos`, target `<TUNNEL-UUID>.cfargotunnel.com`, **proxied** (orange cloud).
5. Run it as a service: `sudo cloudflared service install && sudo systemctl enable --now cloudflared`.
6. In the Cloudflare dashboard turn on **SSL/TLS → Edge Certificates → Always Use HTTPS** (optional but nice; the app also redirects `http` visitors itself).

Uploads are small (about 400 KB), so the tunnel's upload limits are never an issue.

#### Option B: nginx + Let's Encrypt on a public server

For a VPS (or a home server with ports 80/443 forwarded):

1. Create a DNS **A record** `photos.example.com` → your server's public IP (and an AAAA record for IPv6 if you have one).
2. Install nginx and certbot: `sudo apt install nginx certbot python3-certbot-nginx`.
3. Create `/etc/nginx/sites-available/birthdayphotoapp`:
   ```nginx
   server {
       server_name photos.example.com;
       client_max_body_size 15m;               # photos are small, but allow some room

       location / {
           proxy_pass http://127.0.0.1:3000;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
           proxy_read_timeout 120s;
       }
   }
   ```
   ```bash
   sudo ln -s /etc/nginx/sites-available/birthdayphotoapp /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   sudo certbot --nginx -d photos.example.com     # gets the certificate and enables https + redirect
   ```
4. The app trusts one proxy hop (`trust proxy`), which matches this setup: it reads `X-Forwarded-Proto` to set `Secure` cookies and to redirect `http` to `https`.

Whichever option you choose, open `https://photos.example.com` from a phone **on mobile data** (not your Wi-Fi) to make sure it works from the outside.

### 5. Make the QR code

With `PUBLIC_URL` set to the https address:

```bash
node scripts/make-qr.js
```

This writes `qr.png` and a printable A4 sheet `printable/qr-sheet.html` (open it in a browser and print). Both are in `.gitignore` because they contain your address. Put the sheet on every table.

---

## Running the party

- **Before:** deploy, open the app on your own phone, take a test photo, check the admin page, then delete the test guest in the admin.
- **During:** guests scan, type their name, shoot. You do not have to do anything. If someone loses their limit or you want to be generous, press **+5 slik** next to their name.
- **After / next day:** open the album in the admin ("Album: ZAPRT" → "ODPRT"), copy the album link, and send it round (or tell guests to tap the album button in the app). Download the zip for yourself from the admin.

---

## The admin page

Open `https://photos.example.com/admin`, enter `ADMIN_KEY`. The login sets a 7-day cookie. (`/admin?key=...` also works and redirects, but avoid it: the key ends up in browser history and logs.)

| Area | What it does |
|---|---|
| Stats | Total photos and disk usage. |
| Album switches | **Album: ZAPRT/ODPRT** (closed/open), **Geslo za album** (code needed or not), **Prenos celotnega albuma** (let guests download the whole album as a zip). Shows the copyable album link. |
| Zip | One zip with `originali/` and `z-opisi/` (caption cards) for every photo. |
| Guests | Used / base limit (+bonus), hearts received. Buttons: +5 photos, reset (delete this guest's photos), delete guest. Click a name to see their photos with labels, task and hearts; delete single photos. |
| Tasks (Naloge) | Edit the task text and its "photo title", activate/deactivate, delete (soft delete: photos that used it keep working), add new tasks. Typing "Slikaj nekaj rdečega" prefills the title "Slika nečesa rdečega" as a suggestion. |

---

## The album

- Address: `https://photos.example.com/album`.
- The album is **closed by default** and shows a friendly "opens tomorrow" page. The admin can always see it.
- With the password **on** (default) a visitor needs the code (`/album?code=...`, entered in a form or opened from the link) or a guest session from the app. The code is case-insensitive and ignores spaces.
- With the password **off** (and the album open) everybody who knows the address can see it. The admin shows a warning for this.
- Hearts: a guest cannot heart their own photos. People who come in with the code link get an anonymous "viewer" cookie so they can heart too (one heart per person per photo).
- **Saving to the gallery.** Browsers cannot write to a phone's gallery directly, so on phones the album shares the caption card as an image file through the system share sheet (`navigator.share`); on iOS the guest then taps "Save Image". If sharing is not available it falls back to a normal download. This is the best method a web page can offer.
- Captions on the photos follow fixed rules: your caption; otherwise the task's photo title; otherwise "First photo", "Second photo", …, always followed by the guest's name. A caption plus a task adds a second line "Naloga: <task>".

---

## Photo allowance and tasks

- Every guest starts with `PHOTO_LIMIT` photos (default 15).
- A photo taken through **"Slikaj nalogo"** completes that task. **Each different task completed gives +1 photo**, once per task per guest. So a task photo is "free": it uses one photo and gives one back.
- Allowed photos = base limit + number of different completed tasks. The bonus is always **computed from the photos**, never stored in a counter, so it is correct for old data too.
- At 0 photos left, plain photos are blocked but a photo for a **new** task is still accepted, so guests are nudged to solve tasks instead of stopping. The app tells them: "solve a task first".
- Deleting a task never removes anything: the photo keeps a snapshot of the task text and title, and soft-deleted tasks still count as completed.
- The default task list lives in `lib/seed-tasks.js` (Slovenian) and is copied into the database on first run only; after that, manage tasks in the admin.

---

## Security and privacy

What is in place:

- **Secrets stay out of git.** `.env`, `data/`, logs, backups, `qr.png` and `printable/` are ignored. The repository contains no real credentials, names or domains (the examples use `example.com`).
- Admin and album codes are compared in constant time. The admin cookie and album cookie store **hashes**, not the password. All cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` over https.
- **Brute-force protection:** at most 5 wrong attempts per IP per 10 minutes for the admin login/`?key=` and for album codes, then HTTP 429. The IP is taken from `cf-connecting-ip` (Cloudflare) and falls back to the connection address. If you are not behind Cloudflare, make sure your proxy overwrites that header or ignore it.
- Photos are served only to their owner (guest session), to the admin, or, through the album routes, to people with album access while the album is open.
- Uploads are validated (JPEG magic bytes, 12 MB limit), photos are re-encoded in the browser (EXIF/GPS data stripped, orientation baked in), and every user-supplied text is rendered with `textContent`, never `innerHTML`.
- Heart votes are rate-limited (120 per minute per voter).

What you should do:

- Use a long random `ADMIN_KEY` and do not reuse a password.
- Keep the album password on unless the link will only reach people you trust.
- Remember that **photos of people are personal data**. Tell guests what happens to the photos, and delete the data when you no longer need it: stop the app and remove `DATA_DIR`.
- Keep the server updated (`sudo apt update && sudo apt upgrade`) and run `npm audit` now and then.

---

## Backups

Everything that matters is in `DATA_DIR` (database + photos). Copy it:

```bash
cp -r data data-backup-$(date +%s)                     # quick local copy
bash scripts/backup.sh /mnt/usb/backup                 # rsync to a USB stick
bash scripts/backup.sh user@nas:/backups/party         # rsync over ssh
```

Cron example (every 15 minutes during the party):
`*/15 * * * * /usr/bin/bash /path/to/BirthdayPhotoApp/scripts/backup.sh /mnt/usb/backup >> /var/log/photoapp-backup.log 2>&1`.

The cached folders `DATA_DIR/cards` and `DATA_DIR/medium` can be deleted at any time; they are rebuilt on demand.

---

## Customising

### Event look and text

- Set `EVENT_TITLE` and `EVENT_BADGE` in `.env` and restart.
- Colours, fonts and layout: `public/style.css` (variables at the top: gold `#B8924A`, light grey sections `#F4F3EF`, text `#2A2A2A`). Fonts (Cormorant Garamond, Lora) are served locally from `public/fonts`, nothing is loaded from the internet. The title uses "Cavolini" first if the phone has it.
- The welcome balloons are inline SVG in `views/guest.html`.
- Caption card layout: `renderCard()` in `server.js` (uses the DejaVu fonts installed on most Linux systems; make sure your language's characters are covered, `sudo apt install fonts-dejavu-core`).

### Changing the language

All guest-facing strings are Slovenian and live in plain text in a few files:

- `views/guest.html`, `views/album.html` (page texts)
- `public/app.js` (messages, button labels, plural forms in `remainingText()`)
- `lib/labels.js` (the "Prva slika", "Druga slika" ordinals and "Naloga:" line)
- `lib/seed-tasks.js` (default tasks)
- `server.js` (the admin page, locked/closed album pages, error messages)

Search for the Slovenian text and replace it. Tests assert on some of these strings, so run `npm test` afterwards and adjust them.

### Rules

- Photos per guest: `PHOTO_LIMIT`, per-guest in the admin. Bonus rule: `lib/quota.js`.
- Photo size sent from phones: `MAX_PX` and `TARGET_BYTES` at the top of `lib/upload-core.js` (default 1600 px / about 400 KB). Smaller = faster uploads on poor connections.
- Name matching strictness: `lib/names.js`.

---

## Project layout

```
server.js            all routes, admin page, caption cards (sharp), album access
lib/
  db.js              SQLite or JSON storage, same interface, idempotent migrations
  quota.js           photo allowance (limit + one bonus per completed task)
  labels.js          photo label rules (shared with the browser)
  names.js           name normalisation and fuzzy matching
  ratelimit.js       in-memory failed-attempt limiter
  upload-core.js     upload helpers shared with the browser (sizes, ETA, queue cost)
  thumbs.js          thumbnail / medium image generation
  seed-tasks.js      default photo tasks
  event.js           EVENT_TITLE / EVENT_BADGE
public/              app.js, style.css, fonts (guest app, static files)
views/               guest.html, album.html (served with {{placeholders}})
scripts/
  make-qr.js         QR code + printable sheet
  backup.sh          rsync backup of DATA_DIR
  audit-guests.js    read-only health check of every guest (works on a copy of the data)
tests/               unit + integration tests (each integration test starts a real server)
```

Data layout under `DATA_DIR`:

```
party.db                       SQLite (guests, photos, tasks, hearts, settings)
photos/<guestId>/<id>.jpg      the photo as uploaded (1600 px)
photos/<guestId>/<id>_thumb.jpg  small thumbnail (made by the server)
cards/<id>.jpg                 cached caption cards
medium/<id>.jpg                cached 1280 px album images
upload.log, upload-errors.log, client-errors.log   diagnostics
```

---

## HTTP API overview

Guest (cookie `gid` or header `X-Guest-Token`):
`POST /api/login`, `POST /api/login/confirm`, `GET /api/me`, `GET /api/tasks`, `POST /api/upload`, `GET /api/upload/status/:clientId`, `POST /api/album-session`, `POST /api/client-log`, `GET /photo/:id`, `GET /thumb/:id`.

Album (album cookie, or no password if switched off; album must be open):
`GET /album`, `GET /api/album/photos`, `GET /album/{photo,thumb,medium}/:id`, `GET /album/card/:id.jpg`, `GET /album/zip`, `POST /album/api/heart`, `GET /album/api/hearts`.

Admin (cookie from `/admin/login`, or header `X-Admin-Key`):
`GET /admin`, `/api/admin/guests`, `/api/admin/tasks`, `/api/admin/album`, `/api/admin/download-zip`, and the POST/PUT/DELETE routes behind the buttons.

Public: `GET /api/config`, `GET /api/version`.

---

## Tests and the guest audit

```bash
npm test                         # all suites, takes a couple of minutes
node tests/quota.test.js         # a single suite
node scripts/audit-guests.js     # read-only check of every guest in ./data (uses a temp copy)
```

The suites cover name matching, labels, the photo allowance and bonus rules, database migrations (SQLite and JSON), uploads (idempotency, limits, logging), the album (access rules, password switch, cards, zips, hearts, ordering), security (login, rate limiting, caching headers) and the client code paths that can be checked without a browser.

`scripts/audit-guests.js` copies your data to a temp directory, starts the server on it, and for every guest tries login (several spellings), `/api/me`, tasks, an upload, the album session and all photo files, then checks the database for gaps and inconsistencies. Run it before the party and after upgrades.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| A guest taps "Pošlji" and lands back on the first screen, nothing uploads | They opened the plain `http://` address. Use `https://` links in the QR code and make sure https is set up (see above). The server redirects `http` to `https` only if the proxy tells it the original scheme. |
| Uploads are slow | Check the phone's signal first. The bar shows the stage: "Pripravljam sliko…" (the phone is resizing) or the percentage and seconds left (network). Lower `MAX_PX` / `TARGET_BYTES` in `lib/upload-core.js` for weaker networks. |
| Guest page looks old on one phone | A page left open keeps old code. It reloads itself when idle after a deploy; otherwise pull to refresh. |
| `better-sqlite3` fails to install | The app starts anyway with the JSON fallback (the log says so). To get SQLite install build tools (`sudo apt install build-essential python3`) and run `npm rebuild better-sqlite3`. |
| `sharp` fails to install | Use Node 20+ on a supported platform (arm64 and x64 Linux, macOS, Windows are). Caption cards and album images need it. |
| Umlauts/č š ž missing on caption cards | Install fonts: `sudo apt install fonts-dejavu-core`. |
| "Preveč poskusov" (too many attempts) | The IP hit the brute-force limit for the admin or album code; wait 10 minutes. |
| Something odd about one guest | Look at `DATA_DIR/client-errors.log` and `upload-errors.log`, then run `node scripts/audit-guests.js`. |

---

## License

No license file is included yet. Add one (for example MIT) before others reuse the code.
