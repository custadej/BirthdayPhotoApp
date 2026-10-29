#!/usr/bin/env node
'use strict';

/**
 * Generates qr.png and printable/qr-sheet.html from PUBLIC_URL in .env
 * Usage: node scripts/make-qr.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const QRCode = require('qrcode');
const { EVENT_TITLE, escapeHtml } = require('../lib/event');
const fs     = require('fs');
const path   = require('path');

const url = process.env.PUBLIC_URL;
if (!url) {
  console.error('Error: PUBLIC_URL is not set in .env');
  process.exit(1);
}

async function main() {
  // Generate QR PNG
  const pngPath = path.join(__dirname, '..', 'qr.png');
  await QRCode.toFile(pngPath, url, { width: 600, margin: 2, color: { dark: '#000', light: '#fff' } });
  console.log(`Generated: ${pngPath}`);

  // Generate printable HTML sheet
  const dataUrl = await QRCode.toDataURL(url, { width: 600, margin: 2 });

  const html = `<!DOCTYPE html>
<html lang="sl">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(EVENT_TITLE)}</title>
<style>
  @page { size: A4; margin: 15mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: Arial, sans-serif;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 10mm;
    background: #fff;
    color: #111;
  }
  h1 { font-size: 36pt; margin-bottom: 4mm; font-family: Georgia, serif; font-weight: 400; }
  .sub { font-size: 20pt; margin-bottom: 8mm; color: #8F6F2E; }
  .qr-img { width: 160mm; height: 160mm; margin: 0 auto 10mm; display: block; }
  ol { font-size: 22pt; text-align: left; display: inline-block; margin: 0 0 10mm; line-height: 1.7; }
  ol li { margin-bottom: 3mm; }
  .url {
    font-size: 16pt;
    word-break: break-all;
    color: #333;
    border: 2px solid #ccc;
    padding: 6mm 10mm;
    border-radius: 8px;
    background: #f9f9f9;
    max-width: 170mm;
  }
</style>
</head>
<body>
  <h1>${escapeHtml(EVENT_TITLE)}</h1>
  <p class="sub">Deli slike z nami! 📸</p>
  <img class="qr-img" src="${dataUrl}" alt="QR koda">
  <ol>
    <li>Odpri kamero na telefonu</li>
    <li>Usmeri jo v kodo</li>
    <li>Tapni na povezavo</li>
  </ol>
  <p class="url">${url}</p>
</body>
</html>`;

  const printDir = path.join(__dirname, '..', 'printable');
  fs.mkdirSync(printDir, { recursive: true });
  const htmlPath = path.join(printDir, 'qr-sheet.html');
  fs.writeFileSync(htmlPath, html, 'utf8');
  console.log(`Generated: ${htmlPath}`);
  console.log(`\nOpen ${htmlPath} in a browser and print (Ctrl+P) for an A4 sheet.`);
}

main().catch(err => { console.error(err); process.exit(1); });
