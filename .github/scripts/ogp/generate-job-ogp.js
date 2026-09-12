'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch, connect, newPage, evalJs, sleep } = require('./cdp.js');

const ROOT = path.resolve(__dirname, '../../..');
const PORT = 9334;
const WIDTH = 1200;
const HEIGHT = 630;
const SCALE = 2; // 2400x1260

const HTML_CONTENT = `<!DOCTYPE html>
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
    padding: 44px 52px;
    border: 1px solid #cbd5e1;
  }
  
  .brand-rail {
    display: flex; align-items: center; justify-content: space-between;
    padding-bottom: 20px; border-bottom: 1px solid #e2e8f0;
  }
  .brand-left { display: flex; align-items: center; gap: 14px; }
  .brand-mono {
    background: #0f172a; color: #ffffff;
    font-family: "Outfit", sans-serif; font-weight: 900; font-size: 16px;
    padding: 6px 12px; border-radius: 4px; letter-spacing: 0.05em;
  }
  .brand-title {
    font-family: "Outfit", sans-serif; font-weight: 800; font-size: 18px;
    letter-spacing: -0.01em; color: #0f172a;
  }
  .brand-sub { font-size: 12px; color: #64748b; font-weight: 600; margin-left: 8px; }
  .site-url {
    font-family: "JetBrains Mono", monospace; font-size: 14px; font-weight: 700;
    color: #0f4c81; background: rgba(15, 76, 129, 0.08); padding: 5px 14px;
    border-radius: 4px; border: 1px solid rgba(15, 76, 129, 0.2);
  }

  .main-content {
    flex: 1; display: flex; align-items: center; justify-content: space-between; gap: 44px;
    padding-top: 16px;
  }

  .left-col { flex: 1; max-width: 670px; }
  .kicker {
    display: inline-flex; align-items: center; gap: 8px;
    font-family: "Outfit", sans-serif; font-size: 12.5px; font-weight: 800;
    letter-spacing: 0.12em; color: #0f4c81; text-transform: uppercase;
    margin-bottom: 16px;
  }
  .kicker-sq { width: 8px; height: 8px; background: #0f4c81; }
  h1 {
    font-size: 43px; font-weight: 900; line-height: 1.32; letter-spacing: -0.025em;
    color: #0f172a; margin-bottom: 16px;
  }
  .desc {
    font-size: 17.5px; line-height: 1.65; color: #334155; font-weight: 600;
    margin-bottom: 24px;
  }
  .tags { display: flex; gap: 10px; flex-wrap: wrap; }
  .tag {
    background: #ffffff; border: 1px solid #cbd5e1; border-radius: 4px;
    padding: 6px 14px; font-size: 13px; font-weight: 700; color: #334155;
    box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  }

  .right-col { width: 380px; flex-shrink: 0; }
  .signal-card {
    background: #ffffff; border: 1px solid #cbd5e1; border-radius: 12px;
    padding: 24px; box-shadow: 0 10px 25px -5px rgba(15, 23, 42, 0.06);
  }
  .signal-header {
    display: flex; justify-content: space-between; align-items: center;
    margin-bottom: 16px; padding-bottom: 10px; border-bottom: 1px solid #f1f5f9;
  }
  .signal-title {
    font-family: "Outfit", sans-serif; font-size: 11.5px; font-weight: 800;
    letter-spacing: 0.08em; text-transform: uppercase; color: #0f4c81;
  }
  .status-badge {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 11px; font-weight: 800; color: #15803d; background: #dcfce7;
    padding: 2px 8px; border-radius: 4px;
  }
  .status-dot { width: 5px; height: 5px; border-radius: 50%; background: #15803d; }
  
  .metrics-row { display: flex; gap: 12px; margin-bottom: 16px; }
  .metric-box {
    flex: 1; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px;
    padding: 12px 14px;
  }
  .metric-label {
    font-family: "Outfit", sans-serif; font-size: 10px; font-weight: 800;
    color: #64748b; letter-spacing: 0.06em; margin-bottom: 2px;
  }
  .metric-val {
    font-family: "Outfit", sans-serif; font-size: 26px; font-weight: 900;
    color: #0f172a; letter-spacing: -0.02em; line-height: 1.1; margin-bottom: 4px;
  }
  .metric-sub { font-size: 9.5px; color: #94a3b8; font-weight: 600; }

  .arch-box {
    background: #0f172a; border-radius: 6px; padding: 14px 16px; color: #ffffff;
  }
  .arch-title {
    font-family: "Outfit", sans-serif; font-size: 10px; font-weight: 800;
    letter-spacing: 0.1em; color: #38bdf8; text-transform: uppercase; margin-bottom: 4px;
  }
  .arch-lead { font-size: 12px; font-weight: 700; line-height: 1.45; margin-bottom: 8px; }
  .arch-flow {
    font-family: "Outfit", sans-serif; font-size: 9px; font-weight: 800;
    color: #94a3b8; letter-spacing: 0.04em;
  }
</style>
</head>
<body>
  <div class="brand-rail">
    <div class="brand-left">
      <div class="brand-mono">ST</div>
      <div>
        <span class="brand-title">Shinya Takeda</span>
        <span class="brand-sub">Portfolio &amp; Works 2026</span>
      </div>
    </div>
    <div class="site-url">tk.st/job/</div>
  </div>

  <div class="main-content">
    <div class="left-col">
      <div class="kicker"><span class="kicker-sq"></span>Digital Strategist / Tech Lead / Architect</div>
      <h1>データ駆動のグロースハックから、AI・Web3の次世代UX実装まで。</h1>
      <p class="desc">EC/流通のUI/UX改善、データ基盤構築、AIエージェント開発を横断し、ビジネス指標と顧客体験を最大化する。</p>
      <div class="tags">
        <span class="tag">Growth &amp; Analytics</span>
        <span class="tag">AI Agent UX</span>
        <span class="tag">Web3 Architecture</span>
        <span class="tag">Retail DX &amp; POS</span>
      </div>
    </div>

    <div class="right-col">
      <div class="signal-card">
        <div class="signal-header">
          <span class="signal-title">Signal Board</span>
          <span class="status-badge"><span class="status-dot"></span>Active Pipeline</span>
        </div>
        <div class="metrics-row">
          <div class="metric-box">
            <div class="metric-label">CVR LIFT</div>
            <div class="metric-val">+18.4%</div>
            <div class="metric-sub">AB Testing Baseline</div>
          </div>
          <div class="metric-box">
            <div class="metric-label">ENGAGEMENT</div>
            <div class="metric-val">+31.0%</div>
            <div class="metric-sub">Avg. Session Depth</div>
          </div>
        </div>
        <div class="arch-box">
          <div class="arch-title">Experience Architecture</div>
          <div class="arch-lead">指標を読むだけでなく、心に残る体験まで設計する。</div>
          <div class="arch-flow">DATA INGESTION &rarr; AI REASONING &rarr; HIGH-LTV UX</div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'job-ogp-'));
  const chrome = await launch(PORT);
  try {
    const cdp = await connect(PORT);
    const page = path.join(tmp, 'job-ogp.html');
    fs.writeFileSync(page, HTML_CONTENT, 'utf8');

    const { s } = await newPage(cdp, 'file:///' + page.split(path.sep).join('/'));
    await s('Emulation.setDeviceMetricsOverride', {
      width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, mobile: false,
    });

    const fontState = await evalJs(s, `(async () => await Promise.race([
      document.fonts.ready.then(() => 'ready'),
      new Promise(r => setTimeout(() => r('TIMEOUT-local-fonts'), 8000)),
    ]))()`);
    console.log('Fonts status:', fontState);
    await sleep(800);

    const shot = await s('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1 },
      captureBeyondViewport: true,
    });

    const dest = path.join(ROOT, 'images', 'ogp', 'job-ogp.png');
    fs.writeFileSync(dest, Buffer.from(shot.data, 'base64'));
    const kb = (fs.statSync(dest).size / 1024).toFixed(0);
    console.log('SUCCESS: Written images/ogp/job-ogp.png (' + kb + ' KB, 2400x1260)');
    cdp.ws.close();
  } finally {
    chrome.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
