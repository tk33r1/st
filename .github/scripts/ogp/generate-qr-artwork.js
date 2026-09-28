#!/usr/bin/env node
/* QR Palette の OGP に載せる、読み取り可能な3つの QR を生成する。
 * ツール本体と同じ QRCore / QRStyle を使い、透過 PNG として書き出す。
 *
 *   node .github/scripts/ogp/generate-qr-artwork.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch, connect, newPage, evalJs } = require('./cdp.js');

const ROOT = path.resolve(__dirname, '../../..');
const OUT = path.join(__dirname, 'assets', 'qr-artwork.png');
const PORT = 9335;
const WIDTH = 968;
const HEIGHT = 742;
const TARGET = 'https://tk.st/tools/qr-palette/';

function inlineScript(file) {
  return fs.readFileSync(path.join(ROOT, 'tools', 'qr-palette', file), 'utf8')
    .replace(/<\/script/gi, '<\\/script');
}

function html() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; background: transparent; }
    .card { position: absolute; box-sizing: border-box; display: grid; place-items: center;
      background: #151B20; border: 2px solid #29323A; }
    .card.large { left: 10px; top: 97px; width: 560px; height: 560px; padding: 32px; border-radius: 31px; }
    .card.small { left: 614px; width: 344px; height: 344px; padding: 32px; border-radius: 31px; }
    .card.top { top: 10px; }
    .card.bottom { top: 398px; }
    .qr { width: 100%; height: 100%; overflow: hidden; background: #fff; }
    .large .qr { border-radius: 37px; }
    .small .qr { border-radius: 24px; }
    .qr svg { display: block; width: 100%; height: 100%; }
  </style></head><body>
    <div class="card large"><div class="qr" id="large"></div></div>
    <div class="card small top"><div class="qr" id="top"></div></div>
    <div class="card small bottom"><div class="qr" id="bottom"></div></div>
    <script>${inlineScript('qr-core.js')}</script>
    <script>${inlineScript('qr-style.js')}</script>
    <script>${inlineScript('qr-assets.js')}</script>
    <script>
      const qr = QRCore.encode(${JSON.stringify(TARGET)}, { ec: 'H' });
      const heart = QRAssets.ICONS.find(i => i.id === 'bi-heart-fill');
      const styles = {
        large: {
          cell: 'classy2', cellScale: 1.04,
          markerFrame: 'xrounded', markerEye: 'rounded',
          fg: { type: 'linear', from: '#C026D3', to: '#4F46E5', angle: 135 },
          bg: { type: 'white', transparency: 0 },
          markerFramePaint: { type: 'auto' }, markerEyePaint: { type: 'auto' },
          margin: 2, radius: 3,
          logo: {
            type: 'icon', icon: 'bi-heart-fill', iconData: heart, size: 0.20, pad: 0.12,
            backdrop: 'rounded', backdropPaint: { type: 'white', transparency: 0 },
            paint: { type: 'solid', color: '#C026D3' }, knockout: true
          }
        },
        top: {
          cell: 'dot', cellScale: 0.82,
          markerFrame: 'rounded', markerEye: 'rounded',
          fg: { type: 'solid', color: '#1E293B' },
          bg: { type: 'white', transparency: 0 },
          markerFramePaint: { type: 'solid', color: '#2563EB' },
          markerEyePaint: { type: 'solid', color: '#2563EB' },
          margin: 2, radius: 2
        },
        bottom: {
          cell: 'classy2', cellScale: 0.96,
          markerFrame: 'square', markerEye: 'square',
          fg: { type: 'solid', color: '#0E7490' },
          bg: { type: 'white', transparency: 0 },
          markerFramePaint: { type: 'solid', color: '#C53030' },
          markerEyePaint: { type: 'solid', color: '#0E7490' },
          margin: 2, radius: 2
        }
      };
      Object.keys(styles).forEach(id => {
        document.getElementById(id).innerHTML = QRStyle.render(qr, styles[id]).svg;
      });
      window.__qrArtworkReady = true;
    </script>
  </body></html>`;
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ogp-qr-artwork-'));
  const page = path.join(tmp, 'qr-artwork.html');
  fs.writeFileSync(page, html());

  const chrome = await launch(PORT);
  try {
    const cdp = await connect(PORT);
    const { s } = await newPage(cdp, 'file:///' + page.split(path.sep).join('/'));
    await s('Emulation.setDeviceMetricsOverride', {
      width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
    });
    if (!(await evalJs(s, 'window.__qrArtworkReady === true'))) {
      throw new Error('QR artwork did not render');
    }
    const shot = await s('Page.captureScreenshot', {
      format: 'png', omitBackground: true,
      clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1 },
      captureBeyondViewport: true,
    });
    fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
    console.log(path.relative(ROOT, OUT) + ' -> ' + TARGET);
    cdp.ws.close();
  } finally {
    chrome.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
