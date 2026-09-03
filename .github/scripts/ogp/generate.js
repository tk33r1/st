#!/usr/bin/env node
/* Renders the SAFE TOOLS OGP cards to images/ogp/.
 *
 *   node .github/scripts/ogp/generate.js              # all cards
 *   node .github/scripts/ogp/generate.js light-svg    # one card
 *   node .github/scripts/ogp/generate.js --check      # verify, write nothing
 *
 * Cards are defined in cards.js. This file only turns one into an image.
 *
 * The page HTML is written to the OS temp dir, never into the repo: the sitemap
 * workflow globs *.html and would happily publish a template.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch, connect, newPage, evalJs, sleep } = require('./cdp.js');
const { CATEGORIES, SHELL_CSS, CARDS } = require('./cards.js');

const ROOT = path.resolve(__dirname, '../../..');
const ASSETS = path.join(__dirname, 'assets');
const PORT = 9333;

const WIDTH = 1200;
const HEIGHT = 630;
const SCALE = 2;              // 1200x630 CSS px at dsf 2 -> the 2400x1260 asset
const WEBP_QUALITY = 92;

function dataUri(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/' + ext;
  return 'data:' + mime + ';base64,' + fs.readFileSync(path.join(ASSETS, file)).toString('base64');
}

function buildHtml(card) {
  const cat = CATEGORIES[card.cat];
  if (!cat) throw new Error(card.slug + ': unknown category "' + card.cat + '"');

  let panel = card.panel;
  if (card.asset) panel = panel.split('ASSET').join(dataUri(card.asset));
  const chips = card.chips.map((t) => '<div class="chip">' + t + '</div>').join('');

  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@500;700&family=Noto+Sans+JP:wght@400;500;700;900&display=swap" rel="stylesheet">
<style>${SHELL_CSS}
  :root { --accent: ${cat.accent}; --accent-ink: ${cat.ink}; }
  ${card.css || ''}
</style></head><body>
  <div class="top">
    <div class="brand"><i class="dot"></i><span>SAFE&nbsp;TOOLS</span></div>
    <i class="rule"></i>
    <div class="kind">${cat.label}</div>
  </div>
  <div class="main">
    <div class="left">
      <h1>${card.h1}</h1>
      <p class="sub">${card.sub}</p>
      <div class="chips${card.chipMono ? ' mono' : ''}">${chips}</div>
    </div>
    <div class="right">${panel}</div>
  </div>
  <div class="foot">
    <div class="url">tk.st/tools/${card.slug}</div>
    <i class="rule"></i>
    <div class="noup">NO UPLOAD</div>
  </div>
</body></html>`;
}

/* The card's category must be the one data/tools.json already records, or the
 * card would advertise a colour the tool page does not use. */
function checkCategories() {
  const tools = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/tools.json'), 'utf8'));
  const bySlug = new Map(
    tools.map((t) => [t.url.replace(/.*\/tools\//, '').replace(/\/$/, ''), t])
  );
  const problems = [];
  for (const card of CARDS) {
    const tool = bySlug.get(card.slug);
    if (!tool) { problems.push(card.slug + ': not in data/tools.json'); continue; }
    if (tool.category !== card.cat) {
      problems.push(card.slug + ': card says "' + card.cat + '", tools.json says "' + tool.category + '"');
    }
    const want = 'https://tk.st/' + card.out;
    if (tool.imageUrl !== want) {
      problems.push(card.slug + ': tools.json imageUrl is ' + tool.imageUrl + ', card writes ' + want);
    }
  }
  for (const [slug] of bySlug) {
    if (!CARDS.some((c) => c.slug === slug)) problems.push(slug + ': in tools.json but has no card here');
  }
  return problems;
}

(async () => {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const only = args.filter((a) => !a.startsWith('--'));

  const problems = checkCategories();
  if (problems.length) {
    console.error('Card definitions disagree with data/tools.json:');
    for (const p of problems) console.error('  - ' + p);
    process.exit(1);
  }
  console.log('categories and image paths agree with data/tools.json');
  if (checkOnly) return;

  const targets = only.length ? CARDS.filter((c) => only.includes(c.slug)) : CARDS;
  if (!targets.length) {
    console.error('No card matches ' + only.join(', ') + '. Known: ' + CARDS.map((c) => c.slug).join(', '));
    process.exit(1);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ogp-'));
  const chrome = await launch(PORT);
  try {
    const cdp = await connect(PORT);
    for (const card of targets) {
      const page = path.join(tmp, card.slug + '.html');
      fs.writeFileSync(page, buildHtml(card));

      const { s } = await newPage(cdp, 'file:///' + page.split(path.sep).join('/'));
      await s('Emulation.setDeviceMetricsOverride', {
        width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, mobile: false,
      });
      if (card.post) await evalJs(s, card.post);

      // Webfonts come from Google Fonts; fall back to the local stack if offline.
      const fontState = await evalJs(s, `(async () => await Promise.race([
        document.fonts.ready.then(() => 'ready'),
        new Promise(r => setTimeout(() => r('TIMEOUT-local-fonts'), 8000)),
      ]))()`);
      await sleep(500);

      const webp = card.out.endsWith('.webp');
      const shot = await s('Page.captureScreenshot', {
        format: webp ? 'webp' : 'png',
        quality: webp ? WEBP_QUALITY : undefined,
        // scale 1: the device scale factor above already doubles it.
        clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1 },
        captureBeyondViewport: true,
      });

      const dest = path.join(ROOT, card.out);
      fs.writeFileSync(dest, Buffer.from(shot.data, 'base64'));
      const kb = (fs.statSync(dest).size / 1024).toFixed(0);
      console.log(
        card.slug.padEnd(20) + card.cat.padEnd(11) + String(fontState).padEnd(22) +
        card.out.replace('images/ogp/', '').padEnd(32) + kb + 'KB'
      );
    }
    cdp.ws.close();
  } finally {
    chrome.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
