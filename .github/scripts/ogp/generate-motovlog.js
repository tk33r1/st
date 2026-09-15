#!/usr/bin/env node
/* LIBERTY MOTOVLOG の OGP カードとファビコン PNG を書き出す。
 *
 *   node .github/scripts/ogp/generate-motovlog.js
 *
 * 書き出すもの:
 *   images/ogp/motovlog-ogp.jpg   2400x1260
 *
 * カードの色・書体・グラデーションは motovlog/index.html のヒーローと同じ値で、
 * 左肩のマークもページのナビと同じ motovlog-logo.webp。ページ側を触ったら
 * ここも合わせること。
 *
 * generate.js と同じく、ページ HTML は OS の temp に書く。リポジトリ内に置くと
 * sitemap のワークフローが *.html を拾って公開してしまう。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch, connect, newPage, evalJs, sleep } = require('./cdp.js');

const ROOT = path.resolve(__dirname, '../../..');
const PORT = 9335;
const WIDTH = 1200;
const HEIGHT = 630;
const SCALE = 2;              // 1200x630 を dsf 2 で撮って 2400x1260
const JPEG_QUALITY = 90;

const SHOT = 'images/contents/motovlog-liberty-canyon.jpg';
const MARK = 'images/contents/motovlog-logo.webp';

function dataUri(rel) {
  const ext = path.extname(rel).slice(1).toLowerCase();
  const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : 'image/' + ext;
  return 'data:' + mime + ';base64,' + fs.readFileSync(path.join(ROOT, rel)).toString('base64');
}

function buildHtml() {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Montserrat:wght@600;700;800&family=Zen+Kaku+Gothic+New:wght@500;700&display=swap" rel="stylesheet">
<style>
  :root{
    --ink:#08090b; --paper:#efe9dc; --paper-bright:#faf7ef;
    --blue:#0758c8; --blue-bright:#2274e8; --red:#c62b32; --red-bright:#eb3941;
    --display:'Bebas Neue',Impact,sans-serif;
    --sans:'Montserrat',Arial,sans-serif;
    --jp:'Zen Kaku Gothic New',sans-serif;
  }
  *{margin:0;padding:0;box-sizing:border-box}
  body{width:1200px;height:630px;overflow:hidden;background:var(--ink);
       color:var(--paper-bright);font-family:var(--jp);position:relative;isolation:isolate}

  /* 車体を文字から逃がして右 2/3 に丸ごと置く。ヒーローと同じ絵を 1.91:1 に切った形 */
  .shot{position:absolute;left:276px;top:-26px;width:1166px;z-index:-2;
        filter:saturate(.78) contrast(1.08) brightness(.72);
        -webkit-mask-image:linear-gradient(90deg,transparent 0,#000 190px)}
  .veil{position:absolute;inset:0;z-index:-1;background:
      linear-gradient(90deg,rgba(3,5,8,.96) 0%,rgba(3,5,8,.9) 26%,rgba(3,5,8,.5) 52%,rgba(3,5,8,.1) 80%),
      linear-gradient(0deg,#08090b 0%,transparent 30%),
      linear-gradient(180deg,rgba(3,5,8,.45),transparent 24%)}
  /* ページと同じ SVG turbulence のフィルムグレイン */
  .grain{position:absolute;inset:0;z-index:3;pointer-events:none;opacity:.05;mix-blend-mode:soft-light;
         background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.9'/%3E%3C/svg%3E")}

  .wrap{position:relative;z-index:2;height:100%;padding:52px 60px 46px;display:flex;flex-direction:column}

  .top{display:flex;align-items:center;gap:16px}
  .mark{width:64px;height:64px;flex:0 0 auto}
  .wordmark{font-family:var(--sans);font-weight:700;font-size:17px;letter-spacing:.2em;color:#fff}
  .anniv{font-family:var(--sans);font-weight:700;font-size:10px;letter-spacing:.13em;
         padding:5px 9px 4px;border:1px solid rgba(255,255,255,.28);border-radius:2px;
         background:rgba(7,9,12,.45);color:rgba(255,255,255,.8)}

  .badges{display:flex;gap:8px;margin:36px 0 22px}
  .pill{font-family:var(--sans);font-weight:700;font-size:11px;letter-spacing:.09em;line-height:1;
        padding:7px 11px 6px;border:1px solid rgba(255,255,255,.26);border-radius:2px;
        background:rgba(7,9,12,.45);color:rgba(255,255,255,.78)}
  .pill.jp{font-family:var(--jp);font-weight:700;letter-spacing:.04em}
  .pill.status{border-color:rgba(225,54,62,.72);background:rgba(141,14,21,.26);color:#ffbdc0;
               display:flex;align-items:center;gap:6px}
  .pill.status::before{content:'';width:5px;height:5px;border-radius:50%;background:var(--red-bright);
                       box-shadow:0 0 9px var(--red-bright)}

  h1{font-family:var(--display);font-weight:400;font-size:112px;line-height:.76;letter-spacing:.01em}
  h1 .solid{display:block;color:var(--paper-bright);text-shadow:0 10px 40px rgba(0,0,0,.35)}
  h1 .accent{display:block;color:transparent;-webkit-text-stroke:1.4px rgba(250,247,239,.62)}

  .lead{margin-top:24px;padding-left:16px;border-left:3px solid var(--red);
        font-weight:700;font-size:25px;line-height:1.5;letter-spacing:.01em;color:var(--paper-bright);
        text-shadow:0 4px 22px rgba(0,0,0,.6)}
  .lead small{display:block;margin-top:5px;font-weight:500;font-size:16px;letter-spacing:.02em;
              color:rgba(239,233,220,.72)}

  .foot{margin-top:auto;display:flex;align-items:flex-end;gap:30px}
  .stats{display:flex;gap:30px}
  .stat{border-top:1px solid rgba(255,255,255,.18);padding-top:9px;min-width:104px}
  .num{font-family:var(--display);font-size:42px;line-height:.9;color:var(--paper-bright)}
  .num small{font-size:20px;opacity:.75}
  .cap{font-family:var(--sans);font-weight:700;font-size:8.5px;letter-spacing:.13em;
       color:rgba(239,233,220,.5);margin-top:4px}
  .url{margin-left:auto;font-family:var(--sans);font-weight:700;font-size:15px;letter-spacing:.16em;
       color:rgba(239,233,220,.82);padding-bottom:3px}

  .flag{position:absolute;right:0;top:0;bottom:0;width:7px;z-index:4;
        background:linear-gradient(to bottom,var(--red) 0 33.3%,#eee 33.3% 66.6%,var(--blue-bright) 66.6%)}
</style></head><body>
  <img class="shot" src="${dataUri(SHOT)}" alt="">
  <div class="veil"></div>
  <div class="wrap">
    <div class="top">
      <img class="mark" src="${dataUri(MARK)}" alt="">
      <div class="wordmark">LIBERTY MOTOVLOG</div>
      <div class="anniv">250th ANNIVERSARY</div>
    </div>

    <div class="badges">
      <span class="pill">★ UNITED STATES 250 / 1776—2026</span>
      <span class="pill jp">日本限定 39 台</span>
      <span class="pill status">始動準備中 / COMING SOON</span>
    </div>

    <h1><span class="solid">LIBERTY</span><span class="accent">MOTOVLOG</span></h1>

    <div class="lead">死線を越えて、再び風の中へ。
      <small>建国250周年記念の限定ハーレーと、事故からのリターン。</small>
    </div>

    <div class="foot">
      <div class="stats">
        <div class="stat"><div class="num">250<small>th</small></div><div class="cap">U.S. SEMIQUINCENTENNIAL</div></div>
        <div class="stat"><div class="num">39</div><div class="cap">JAPAN LIMITED (UNITS)</div></div>
        <div class="stat"><div class="num">ver 2.0</div><div class="cap">SECOND LIFE</div></div>
      </div>
      <div class="url">tk.st/motovlog</div>
    </div>
  </div>
  <div class="grain"></div><div class="flag"></div>
</body></html>`;
}

function fileUrl(p) {
  return 'file:///' + p.split(path.sep).join('/');
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'motovlog-ogp-'));
  const chrome = await launch(PORT);
  try {
    const cdp = await connect(PORT);

    const page = path.join(tmp, 'motovlog-ogp.html');
    fs.writeFileSync(page, buildHtml(), 'utf8');

    const { s } = await newPage(cdp, fileUrl(page));
    await s('Emulation.setDeviceMetricsOverride', {
      width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, mobile: false,
    });

    // Bebas Neue / Montserrat / Zen Kaku Gothic New は Google Fonts 頼りなので
    // ネットワークが要る。落ちたら TIMEOUT-local-fonts と出るので捨ててやり直す。
    const fontState = await evalJs(s, `(async () => await Promise.race([
      document.fonts.ready.then(() => 'ready'),
      new Promise(r => setTimeout(() => r('TIMEOUT-local-fonts'), 8000)),
    ]))()`);
    console.log('Fonts status:', fontState);
    await sleep(800);

    const shot = await s('Page.captureScreenshot', {
      format: 'jpeg',
      quality: JPEG_QUALITY,
      clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1 },
      captureBeyondViewport: true,
    });
    const dest = path.join(ROOT, 'images', 'ogp', 'motovlog-ogp.jpg');
    fs.writeFileSync(dest, Buffer.from(shot.data, 'base64'));
    console.log('images/ogp/motovlog-ogp.jpg  ' +
      (fs.statSync(dest).size / 1024).toFixed(0) + ' KB, 2400x1260');

    cdp.ws.close();
  } finally {
    chrome.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
