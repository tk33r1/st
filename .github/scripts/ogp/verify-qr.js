#!/usr/bin/env node
/* The QR Atelier card carries real, scannable QR codes. If a regeneration ever
 * resamples them badly the picture still *looks* right, so check by decoding.
 *
 *   node .github/scripts/ogp/verify-qr.js
 *
 * Uses the same jsQR build the tool itself loads, so a pass here means the same
 * thing a pass in the tool does. Needs network for the CDN.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { launch, connect, newPage, evalJs } = require('./cdp.js');

const ROOT = path.resolve(__dirname, '../../..');
const CARD = path.join(ROOT, 'images/ogp/qr-atelier-ogp.png');
const EXPECT = 'https://tk.st/tools/qr-atelier/';
const PORT = 9334;

// Windows onto each of the three codes, in the 2400x1260 asset.
const BOXES = [[1330, 300, 700, 700], [1900, 250, 420, 420], [1900, 620, 420, 420]];

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ogp-qr-'));
  const host = path.join(tmp, 'decode.html');
  fs.writeFileSync(host, '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<script src="https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js"></script>' +
    '</head><body></body></html>');

  const chrome = await launch(PORT);
  try {
    const cdp = await connect(PORT);
    const { s } = await newPage(cdp, 'file:///' + host.split(path.sep).join('/'));

    const ready = await evalJs(s, `typeof window.jsQR === 'function'`);
    if (!ready) throw new Error('jsQR did not load (offline?)');

    const b64 = fs.readFileSync(CARD).toString('base64');
    const results = await evalJs(s, `(async () => {
      const img = new Image();
      img.src = 'data:image/png;base64,${b64}';
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const x = c.getContext('2d');
      x.drawImage(img, 0, 0);
      return ${JSON.stringify(BOXES)}.map(([bx, by, bw, bh]) => {
        const d = x.getImageData(bx, by, bw, bh);
        const hit = window.jsQR(d.data, d.width, d.height, { inversionAttempts: 'attemptBoth' });
        return hit ? hit.data : null;
      });
    })()`);

    let bad = 0;
    results.forEach((r, i) => {
      const ok = r === EXPECT;
      if (!ok) bad++;
      console.log((ok ? 'OK   ' : 'FAIL ') + 'code ' + (i + 1) + ': ' + (r === null ? '(did not decode)' : r));
    });
    cdp.ws.close();
    if (bad) { console.error('\n' + bad + ' of 3 codes failed — do not ship this card.'); process.exit(1); }
    console.log('\nall 3 codes decode to ' + EXPECT);
  } finally {
    chrome.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
