'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { launch, connect, newPage, evalJs, sleep } = require('./cdp.js');

const ROOT = path.resolve(__dirname, '../../..');
const WIDTH = 1200;
const HEIGHT = 630;
const SCALE = 2; // 2400x1260

const BRAND_CONFIGS = {
  'retail-tech': {
    port: 9335,
    brandTitle: 'Retail Tech Daily',
    brandSub: '毎朝8時の流通DX・リテールテック速報',
    primaryColor: '#0f4c81',
    primarySubtle: 'rgba(15, 76, 129, 0.08)',
    primaryBorder: 'rgba(15, 76, 129, 0.2)',
    badgeBg: '#0f172a',
    jsonPath: path.join(ROOT, 'data', 'retail-tech-daily.json'),
    outPrefix: 'retailtechdaily',
    portalOgpPath: path.join(ROOT, 'images', 'ogp', 'retail-tech-ogp.webp'),
    defaultTags: ['店舗DX', '流通'],
    logoSvg: `<svg viewBox="0 0 64 64" width="38" height="38" style="flex-shrink:0; border-radius:8px; box-shadow:0 1px 3px rgba(15,23,42,0.12);">
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
</svg>`
  },
  'nitori': {
    port: 9336,
    brandTitle: 'Nitori Daily',
    brandSub: '毎朝8時のニトリ速報＆SNS話題',
    primaryColor: '#009e96',
    primarySubtle: 'rgba(0, 158, 150, 0.08)',
    primaryBorder: 'rgba(0, 158, 150, 0.25)',
    badgeBg: '#009e96',
    jsonPath: path.join(ROOT, 'data', 'nitori-daily.json'),
    outPrefix: 'nitoridaily',
    portalOgpPath: path.join(ROOT, 'images', 'ogp', 'nitori-ogp.webp'),
    defaultTags: ['ニトリ', '店舗DX', '商品開発'],
    logoSvg: `<svg viewBox="0 0 64 64" width="38" height="38" style="flex-shrink:0; border-radius:8px; box-shadow:0 1px 3px rgba(15,23,42,0.12);">
  <defs>
    <linearGradient id="ntOgBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#006b66" />
      <stop offset="55%" stop-color="#009e96" />
      <stop offset="100%" stop-color="#14b8a6" />
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="10" fill="url(#ntOgBg)" />
  <rect x="1" y="1" width="62" height="62" rx="9" fill="none" stroke="rgba(255, 255, 255, 0.28)" stroke-width="1.2" />
  <path d="M13 26 L32 13 L51 26" fill="none" stroke="#ffffff" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round" />
  <path d="M21 48 V27 L43 48 V27" fill="none" stroke="#ffffff" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round" />
</svg>`
  }
};

function esc(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildDailyHtml(brandCfg, issue) {
  const d = issue.date;
  const dFmt = `${d.slice(0, 4)}年${parseInt(d.slice(4, 6))}月${parseInt(d.slice(6, 8))}日`;
  const topArticle = (issue.articles && issue.articles[0]) ? issue.articles[0] : null;
  const topTitle = topArticle ? topArticle.title : issue.title;
  const execHighlights = (issue.executive_summary || []).slice(0, 3);
  const execHtml = execHighlights.map(h => `<li>${esc(h)}</li>`).join('');

  const engineLabel = esc(issue.generated_by || 'DeepSeek AI');
  const engineType = esc(issue.engine_type || 'deepseek');
  const tags = (topArticle && topArticle.tags ? topArticle.tags : brandCfg.defaultTags).slice(0, 4);
  const tagsHtml = tags.map(t => `<span class="tag">#${esc(t)}</span>`).join('');

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@500;700;800;900&family=Zen+Kaku+Gothic+New:wght@500;700;900&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: 1200px;
    height: 630px;
    background: #0f172a;
    color: #f8fafc;
    font-family: 'Zen Kaku Gothic New', -apple-system, sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  .card-canvas {
    width: 1200px;
    height: 630px;
    position: relative;
    background: radial-gradient(circle at 85% 15%, rgba(30, 41, 59, 0.7) 0%, rgba(15, 23, 42, 1) 70%);
    padding: 44px 54px 38px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
  }
  .top-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 48px;
  }
  .brand-group {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .brand-text-wrap {
    display: flex;
    flex-direction: column;
    line-height: 1.15;
  }
  .brand-title {
    font-family: 'Outfit', sans-serif;
    font-size: 20px;
    font-weight: 800;
    color: #ffffff;
    letter-spacing: -0.01em;
  }
  .brand-subtitle {
    font-size: 11px;
    font-weight: 700;
    color: #94a3b8;
    letter-spacing: 0.04em;
  }
  .meta-pills {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .pill-date {
    font-family: 'Outfit', 'Zen Kaku Gothic New', sans-serif;
    font-size: 14px;
    font-weight: 800;
    color: ${brandCfg.primaryColor};
    background: ${brandCfg.primarySubtle};
    padding: 5px 14px;
    border-radius: 4px;
    border: 1px solid ${brandCfg.primaryBorder};
  }
  .engine-tag {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
    font-weight: 700;
    padding: 4px 10px;
    border-radius: 4px;
    background: ${brandCfg.badgeBg};
    color: #ffffff;
    border: 1px solid rgba(255, 255, 255, 0.15);
  }
  .engine-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #10b981;
  }
  .headline-section {
    margin: 8px 0 10px;
  }
  .headline-kicker {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: 'Outfit', sans-serif;
    font-size: 14px;
    font-weight: 800;
    color: ${brandCfg.primaryColor};
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin-bottom: 8px;
  }
  .headline-kicker::before {
    content: "";
    width: 8px;
    height: 8px;
    background: ${brandCfg.primaryColor};
    border-radius: 2px;
  }
  .headline-title {
    font-size: 34px;
    font-weight: 900;
    line-height: 1.32;
    color: #ffffff;
    letter-spacing: -0.02em;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .summary-panel {
    background: rgba(30, 41, 59, 0.7);
    border: 1px solid rgba(51, 65, 85, 0.8);
    border-left: 4px solid ${brandCfg.primaryColor};
    border-radius: 8px;
    padding: 16px 22px;
    backdrop-filter: blur(8px);
  }
  .summary-header {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
    font-weight: 800;
    color: ${brandCfg.primaryColor};
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 8px;
  }
  .summary-list {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .summary-list li {
    font-size: 14.5px;
    color: #cbd5e1;
    line-height: 1.5;
    position: relative;
    padding-left: 14px;
  }
  .summary-list li::before {
    content: "•";
    position: absolute;
    left: 0;
    color: #64748b;
    font-weight: bold;
  }
  .footer-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-top: 10px;
    border-top: 1px solid rgba(51, 65, 85, 0.5);
  }
  .tags-group {
    display: flex;
    gap: 8px;
  }
  .tag {
    font-size: 12px;
    font-weight: 700;
    color: #94a3b8;
    background: rgba(15, 23, 42, 0.8);
    padding: 3px 10px;
    border-radius: 4px;
    border: 1px solid rgba(51, 65, 85, 0.6);
  }
  .site-domain {
    font-family: 'Outfit', sans-serif;
    font-size: 14px;
    font-weight: 800;
    color: #94a3b8;
    letter-spacing: 0.04em;
  }
  .site-domain strong {
    color: #ffffff;
  }
</style>
</head>
<body>
  <div class="card-canvas">
    <div class="top-bar">
      <div class="brand-group">
        ${brandCfg.logoSvg}
        <div class="brand-text-wrap">
          <div class="brand-title">${brandCfg.brandTitle}</div>
          <div class="brand-subtitle">${brandCfg.brandSub}</div>
        </div>
      </div>
      <div class="meta-pills">
        <div class="pill-date">${dFmt} 号</div>
        <div class="engine-tag"><span class="engine-dot"></span>${engineLabel}</div>
      </div>
    </div>

    <div class="headline-section">
      <div class="headline-kicker">TODAY'S LEAD TOPIC</div>
      <h1 class="headline-title">${esc(topTitle)}</h1>
    </div>

    <div class="summary-panel">
      <div class="summary-header">EXECUTIVE SUMMARY</div>
      <ul class="summary-list">${execHtml}</ul>
    </div>

    <div class="footer-row">
      <div class="tags-group">${tagsHtml}</div>
      <div class="site-domain">tk.st / <strong>${brandCfg.outPrefix}</strong></div>
    </div>
  </div>
</body>
</html>`;
}

async function generateDailyOgp(targetBrand = 'retail-tech', targetDate = '') {
  // 後方互換性: 第1引数が日付（数字のみ）の場合
  if (/^\d+$/.test(targetBrand) && !targetDate) {
    targetDate = targetBrand;
    targetBrand = 'retail-tech';
  }

  const brandKey = (targetBrand === 'nitori' || targetBrand === 'nitoridaily') ? 'nitori' : 'retail-tech';
  const brandCfg = BRAND_CONFIGS[brandKey];

  if (!fs.existsSync(brandCfg.jsonPath)) {
    throw new Error(`${brandCfg.jsonPath} not found`);
  }

  const newsData = JSON.parse(fs.readFileSync(brandCfg.jsonPath, 'utf8'));
  let issue = null;
  if (targetDate) {
    issue = newsData.find(it => it.date === targetDate);
    if (!issue) throw new Error(`Target date ${targetDate} not found in ${brandCfg.jsonPath}`);
  } else {
    issue = newsData[0];
  }

  const d = issue.date;
  const outPngPath = path.join(ROOT, 'images', 'ogp', `${brandCfg.outPrefix}-${d}.png`);
  const outWebpPath = path.join(ROOT, 'images', 'ogp', `${brandCfg.outPrefix}-${d}.webp`);

  const htmlContent = buildDailyHtml(brandCfg, issue);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `ogp-${brandKey}-`));
  const htmlPath = path.join(tmp, 'card.html');
  fs.writeFileSync(htmlPath, htmlContent, 'utf8');

  const chrome = await launch(brandCfg.port);
  try {
    const cdp = await connect(brandCfg.port);
    const { s } = await newPage(cdp, 'file:///' + htmlPath.replace(/\\/g, '/'));
    await s('Emulation.setDeviceMetricsOverride', {
      width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, mobile: false,
    });

    await evalJs(s, `(async () => await Promise.race([
      document.fonts.ready.then(() => 'ready'),
      new Promise(r => setTimeout(() => r('TIMEOUT'), 6000)),
    ]))()`);
    await sleep(800);

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
  console.log(`SUCCESS: images/ogp/${brandCfg.outPrefix}-${d}.webp (${kb} KB, Lossless WebP 2400x1260)`);

  // ポータル代表 OGP にも同期コピー
  try {
    fs.copyFileSync(outWebpPath, brandCfg.portalOgpPath);
  } catch (e) {}

  return outWebpPath;
}

if (require.main === module) {
  const arg1 = process.argv[2] || '';
  const arg2 = process.argv[3] || '';
  generateDailyOgp(arg1, arg2).catch(e => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { generateDailyOgp };
