'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { launch, connect, newPage, evalJs, sleep } = require('./cdp.js');

const ROOT = path.resolve(__dirname, '../../..');
const PORT = 9335;
const WIDTH = 1200;
const HEIGHT = 630;
const SCALE = 2; // 2400x1260

// ブランドロゴ SVG（案A）
const LOGO_SVG = `<svg viewBox="0 0 64 64" width="38" height="38" style="flex-shrink:0; border-radius:8px; box-shadow:0 1px 3px rgba(15,23,42,0.12);">
  <defs>
    <linearGradient id="dOgBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0b192e" />
      <stop offset="60%" stop-color="#0f4c81" />
      <stop offset="100%" stop-color="#1e293b" />
    </linearGradient>
    <linearGradient id="dOgSig" x1="0%" y1="100%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#38bdf8" />
      <stop offset="100%" stop-color="#818cf8" />
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="10" fill="url(#dOgBg)" />
  <rect x="1" y="1" width="62" height="62" rx="9" fill="none" stroke="rgba(255, 255, 255, 0.18)" stroke-width="1.2" />
  <path d="M12 26 h5 l5 16 h17 l4 -11 h-23" fill="none" stroke="#ffffff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" />
  <circle cx="24" cy="47" r="3" fill="#ffffff" />
  <circle cx="38" cy="47" r="3" fill="#ffffff" />
  <circle cx="40" cy="26" r="2.2" fill="url(#dOgSig)" />
  <path d="M 41.8 19.2 A 7 7 0 0 1 46.8 24.2" fill="none" stroke="url(#dOgSig)" stroke-width="2.8" stroke-linecap="round" />
  <path d="M 43.1 14.4 A 12 12 0 0 1 51.6 22.9" fill="none" stroke="url(#dOgSig)" stroke-width="2.8" stroke-linecap="round" />
</svg>`;

function esc(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildDailyHtml(issue) {
  const d = issue.date;
  const dFmt = `${d.slice(0, 4)}年${parseInt(d.slice(4, 6))}月${parseInt(d.slice(6, 8))}日`;
  const topArticle = (issue.articles && issue.articles[0]) ? issue.articles[0] : null;
  const topTitle = topArticle ? topArticle.title : issue.title;
  const execHighlights = (issue.executive_summary || []).slice(0, 3);
  const execHtml = execHighlights.map(h => `<li>${esc(h)}</li>`).join('');

  const engineLabel = esc(issue.generated_by || 'DeepSeek AI');
  const engineType = esc(issue.engine_type || 'deepseek');
  const tags = (topArticle && topArticle.tags ? topArticle.tags : ['店舗DX', '流通']).slice(0, 4);
  const tagsHtml = tags.map(t => `<span class="tag">#${esc(t)}</span>`).join('');

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@500;700;800;900&family=Zen+Kaku+Gothic+New:wght@500;700;900&family=JetBrains+Mono:wght@700&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 1200px; height: 630px; overflow: hidden;
    background-color: #f8fafc;
    background-image: 
      linear-gradient(rgba(15, 23, 42, 0.04) 1px, transparent 1px),
      linear-gradient(90deg, rgba(15, 23, 42, 0.04) 1px, transparent 1px);
    background-size: 32px 32px;
    font-family: "Zen Kaku Gothic New", -apple-system, sans-serif;
    color: #0f172a;
    display: flex; flex-direction: column;
    padding: 38px 48px;
    border: 1px solid #cbd5e1;
  }

  .brand-rail {
    display: flex; align-items: center; justify-content: space-between;
    padding-bottom: 16px; border-bottom: 1px solid #e2e8f0;
  }
  .brand-left { display: flex; align-items: center; gap: 12px; }
  .brand-title {
    font-family: "Outfit", sans-serif; font-weight: 800; font-size: 18px;
    letter-spacing: -0.01em; color: #0f172a;
  }
  .brand-sub { font-size: 12px; color: #64748b; font-weight: 600; margin-left: 6px; }
  .site-url {
    font-family: "JetBrains Mono", monospace; font-size: 13.5px; font-weight: 700;
    color: #0f4c81; background: rgba(15, 76, 129, 0.08); padding: 5px 14px;
    border-radius: 4px; border: 1px solid rgba(15, 76, 129, 0.2);
  }

  .main-content {
    flex: 1; display: flex; flex-direction: column; justify-content: center;
    padding: 16px 0 10px;
  }

  .meta-row { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
  .daily-tag {
    background: #0f172a; color: #ffffff;
    font-family: "Outfit", sans-serif; font-size: 11px; font-weight: 800;
    padding: 3px 9px; border-radius: 4px; text-transform: uppercase; letter-spacing: 0.06em;
  }
  .issue-date {
    font-family: "Outfit", sans-serif; font-size: 14px; font-weight: 800; color: #0f4c81;
  }
  .engine-badge {
    display: inline-flex; align-items: center; gap: 6px;
    font-family: "Outfit", sans-serif; font-size: 11px; font-weight: 700;
    padding: 2px 9px; border-radius: 4px; border: 1px solid;
    margin-left: auto;
  }
  .engine-dot { width: 5px; height: 5px; border-radius: 50%; }
  .engine-deepseek { background: #eff6ff; color: #1d4ed8; border-color: #bfdbfe; }
  .engine-deepseek .engine-dot { background: #1d4ed8; }
  .engine-openai { background: #ecfdf5; color: #047857; border-color: #a7f3d0; }
  .engine-openai .engine-dot { background: #059669; }
  .engine-fallback { background: #f1f5f9; color: #475569; border-color: #cbd5e1; }
  .engine-fallback .engine-dot { background: #64748b; }

  .lead-title {
    font-size: 32px; font-weight: 900; line-height: 1.35; letter-spacing: -0.02em;
    color: #0f172a; margin-bottom: 16px;
  }

  .exec-card {
    background: #ffffff;
    border: 1px solid #cbd5e1;
    border-left: 4px solid #0f4c81;
    border-radius: 8px;
    padding: 16px 20px;
    box-shadow: 0 4px 6px -1px rgba(15, 23, 42, 0.04);
  }
  .exec-head {
    display: flex; align-items: center; gap: 8px;
    font-size: 12.5px; font-weight: 800; color: #0f4c81; text-transform: uppercase;
    letter-spacing: 0.04em; margin-bottom: 8px;
  }
  .exec-list { list-style: none; display: flex; flex-direction: column; gap: 6px; }
  .exec-list li {
    position: relative; padding-left: 18px; font-size: 13.5px; font-weight: 600;
    line-height: 1.55; color: #334155;
  }
  .exec-list li::before {
    content: "—"; position: absolute; left: 0; color: #0f4c81; font-weight: 800;
  }

  .footer-rail {
    display: flex; align-items: center; justify-content: space-between;
    padding-top: 14px; border-top: 1px solid #e2e8f0; font-size: 12px;
  }
  .tags { display: flex; gap: 8px; }
  .tag {
    font-size: 12px; font-weight: 700; color: #64748b; background: #ffffff;
    border: 1px solid #e2e8f0; padding: 3px 9px; border-radius: 4px;
  }
  .curator-note {
    font-size: 12px; font-weight: 700; color: #64748b; font-family: "Outfit", sans-serif;
  }
</style>
</head>
<body>
  <div class="brand-rail">
    <div class="brand-left">
      ${LOGO_SVG}
      <div>
        <span class="brand-title">Retail Tech Daily Brief</span>
        <span class="brand-sub">毎朝8時の流通DX・リテールテック日刊速報</span>
      </div>
    </div>
    <div class="site-url">tk.st/job/retailtechdaily/</div>
  </div>

  <div class="main-content">
    <div class="meta-row">
      <span class="daily-tag">Daily Brief</span>
      <span class="issue-date">${dFmt} 08:00 号</span>
      <span class="engine-badge engine-${engineType}"><span class="engine-dot"></span>${engineLabel}</span>
    </div>

    <h1 class="lead-title">${esc(topTitle)}</h1>

    <div class="exec-card">
      <div class="exec-head">
        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
        <span>昨日の3大重要トピック（Executive Summary）</span>
      </div>
      <ul class="exec-list">${execHtml}</ul>
    </div>
  </div>

  <div class="footer-rail">
    <div class="tags">${tagsHtml}</div>
    <div class="curator-note">Curated &amp; Analyzed by Shinya Takeda (tk.st)</div>
  </div>
</body>
</html>`;
}

async function generateDailyOgp(targetDate) {
  const jsonPath = path.join(ROOT, 'data', 'retail-tech-news.json');
  if (!fs.existsSync(jsonPath)) {
    throw new Error('data/retail-tech-news.json not found');
  }
  const history = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const issue = targetDate
    ? history.find(h => h.date === targetDate)
    : history[0];

  if (!issue) {
    throw new Error(`Issue not found for date: ${targetDate}`);
  }

  const d = issue.date;
  const outPngPath = path.join(os.tmpdir(), `rtd-${d}.png`);
  const outWebpPath = path.join(ROOT, 'images', 'ogp', `retailtechdaily-${d}.webp`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ogp-daily-'));
  const chrome = await launch(PORT);
  try {
    const cdp = await connect(PORT);
    const page = path.join(tmp, 'daily-ogp.html');
    fs.writeFileSync(page, buildDailyHtml(issue), 'utf8');

    const { s } = await newPage(cdp, 'file:///' + page.split(path.sep).join('/'));
    await s('Emulation.setDeviceMetricsOverride', {
      width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, mobile: false,
    });

    await evalJs(s, `(async () => await Promise.race([
      document.fonts.ready.then(() => 'ready'),
      new Promise(r => setTimeout(() => r('TIMEOUT-local-fonts'), 8000)),
    ]))()`);
    await sleep(600);

    const shot = await s('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1 },
      captureBeyondViewport: true,
    });
    fs.writeFileSync(outPngPath, Buffer.from(shot.data, 'base64'));
    cdp.ws.close();
  } finally {
    chrome.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // Python Pillow で完全可逆（Lossless）WebP に高圧縮変換
  const pyCode = `
from PIL import Image
import sys
src, dst = sys.argv[1], sys.argv[2]
img = Image.open(src)
img.save(dst, format='WEBP', lossless=True, method=6)
`;
  const pyRes = spawnSync('python', ['-c', pyCode, outPngPath, outWebpPath]);
  if (pyRes.error || pyRes.status !== 0) {
    throw new Error('Python WebP conversion failed: ' + (pyRes.stderr ? pyRes.stderr.toString() : ''));
  }
  try { fs.unlinkSync(outPngPath); } catch {}

  const kb = (fs.statSync(outWebpPath).size / 1024).toFixed(1);
  console.log(`SUCCESS: images/ogp/retailtechdaily-${d}.webp (${kb} KB, Lossless WebP 2400x1260)`);
  return outWebpPath;
}

if (require.main === module) {
  const target = process.argv[2] || '';
  generateDailyOgp(target).catch(e => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { generateDailyOgp };
