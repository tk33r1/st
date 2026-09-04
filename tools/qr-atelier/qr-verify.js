/* qr-verify.js — 書き出す絵をそのまま読み返して、本当にスキャンできるかを確かめる。
 *
 * 単一のデコーダで白黒をつけると、実機では読めるものを「読めません」と言って
 * しまう。デコーダごとに得意・不得意がはっきり違うためで、とくに jsQR は
 * ファインダを走査線の 1:1:3:1:1 比で探すので、凝ったマーカー枠で落ちやすい。
 * 実機のカメラはそこがずっと寛容なので、jsQR の失敗＝読めない、にはならない。
 *
 * そこで「寛容さの違う複数のデコーダに読ませて、何個が通ったか」を出す。
 * ENGINES は厳しい順に並べていて、通った数がそのまま
 * 「どの程度ゆるい読み取り環境まで耐えるか」の目盛りになる。
 *
 *   window.QRVerify.run({ render, expect, moduleWidth, margin, padColor })
 *     → { engines: [{id,name,state}], ran, passed, level, mismatch }
 *
 * デコーダは全部このリポジトリに同梱してあり（vendor/）、実行時に外へ出る
 * 通信はない。重いものは押されたときだけ読み込む。
 */
(function (global) {
  'use strict';

  // vendor/ の場所はこのファイルからの相対で決める。ページの階層に依存しない。
  const HERE = (function () {
    const s = document.currentScript;
    return s ? s.src : location.href;
  })();
  const V = url => new URL('vendor/' + url, HERE).href;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error('load failed: ' + src));
      document.head.appendChild(el);
    });
  }

  // 一度読み込んだら以後は使い回す。読み込み中の重複呼び出しも 1 本にまとめる。
  function once(fn) {
    let p = null;
    const wrapped = () => (p || (p = fn().catch(e => { p = null; throw e; })));
    wrapped.loaded = () => p !== null;
    return wrapped;
  }

  // ------------------------------------------------------------------
  // デコーダ（寛容さの順：厳しい → 寛容）
  // ------------------------------------------------------------------
  // heavy: 初回に MB 級を取りに行くもの。自動実行はせず、明示的に呼ばれたときだけ。
  const ENGINES = [
    {
      id: 'jsqr',
      name: 'jsQR',
      note: '素朴なJSデコーダ。いちばん厳しい',
      heavy: false,
      load: once(async () => {
        if (typeof global.jsQR !== 'function') await loadScript(V('jsQR.js'));
        return typeof global.jsQR === 'function';
      }),
      decode: (canvas, image) => {
        const hit = global.jsQR(image.data, image.width, image.height,
          { inversionAttempts: 'attemptBoth' });
        return hit ? hit.data : null;
      }
    },
    {
      id: 'zxing',
      name: 'ZXing',
      note: 'zxing-cpp。多くのスキャナアプリの系統',
      heavy: true,
      load: once(async () => {
        if (typeof global.ZXingWASM === 'undefined') {
          await loadScript(V('zxing/zxing_reader.js'));
        }
        if (typeof global.ZXingWASM === 'undefined') return false;
        // 既定では CDN から .wasm を取りに行くので、同梱したものに向け直す。
        global.ZXingWASM.setZXingModuleOverrides({
          locateFile: (path, prefix) =>
            (/zxing_reader\.wasm$/.test(path) ? V('zxing/zxing_reader.wasm') : prefix + path)
        });
        return true;
      }),
      decode: async (canvas, image) => {
        const hits = await global.ZXingWASM.readBarcodes(image, {
          formats: ['QRCode'], tryHarder: true, tryRotate: true, tryInvert: true,
          maxNumberOfSymbols: 1
        });
        return hits && hits.length ? hits[0].text : null;
      }
    },
    {
      id: 'wechat',
      name: 'OpenCV WeChat',
      note: '検出が機械学習ベース。装飾に強い',
      heavy: true,
      load: once(async () => {
        const mod = await import(V('wechat/index.js'));
        await mod.ready();
        ENGINES_BY_ID.wechat._scan = mod.scan;
        return true;
      }),
      decode: async (canvas) => {
        // 見つからないと内部で空のベクタを引きにいって転ぶことがある。
        try {
          const r = await ENGINES_BY_ID.wechat._scan(canvas);
          return r && r.text ? r.text : null;
        } catch (e) { return null; }
      }
    },
    {
      id: 'native',
      name: 'ブラウザ内蔵',
      note: 'macOS/iOSはApple Vision、AndroidはML Kit。実機そのもの',
      heavy: false,
      load: once(async () => {
        if (typeof global.BarcodeDetector === 'undefined') return false;
        try {
          const formats = await global.BarcodeDetector.getSupportedFormats();
          if (formats.indexOf('qr_code') < 0) return false;
          ENGINES_BY_ID.native._det = new global.BarcodeDetector({ formats: ['qr_code'] });
          return true;
        } catch (e) { return false; }
      }),
      decode: async (canvas) => {
        const hits = await ENGINES_BY_ID.native._det.detect(canvas);
        return hits.length ? hits[0].rawValue : null;
      }
    }
  ];

  const ENGINES_BY_ID = {};
  ENGINES.forEach(e => { ENGINES_BY_ID[e.id] = e; });

  // ------------------------------------------------------------------
  // 検査
  // ------------------------------------------------------------------
  // 実機のカメラが捉える解像度に近いあたりを何段か試す。デコーダによって
  // 得意な倍率が違い、上げれば通るとは限らないので、1つでも通れば合格とする。
  const SCALES = [4, 6, 9, 12];

  // クワイエットゾーンが規格の 4 モジュールに足りないぶんは、背景色で補って
  // から読ませる。実際には QR の周りにも背景が続いているのが普通で、そこを
  // 詰めて落とすと「余白が狭い」という別の警告と二重に減点することになる。
  function padded(canvas, px, pad, color) {
    if (pad <= 0) return canvas;
    const out = document.createElement('canvas');
    out.width = canvas.width + pad * px * 2;
    out.height = canvas.height + pad * px * 2;
    const c = out.getContext('2d');
    c.fillStyle = color || '#FFFFFF';
    c.fillRect(0, 0, out.width, out.height);
    c.drawImage(canvas, pad * px, pad * px);
    return out;
  }

  // 1 段ぶんの描画が返ってこなくても、パネル全体が固まらないようにする。
  function withTimeout(p, ms) {
    let t;
    return Promise.race([
      Promise.resolve(p).finally(() => clearTimeout(t)),
      new Promise((_, reject) => { t = setTimeout(() => reject(new Error('timeout')), ms); })
    ]);
  }

  let seq = 0;

  /* opts:
   *   render(px)   → Promise<canvas>  指定の横幅で描いたもの
   *   expect       期待する文字列
   *   moduleWidth  viewBox の横幅（モジュール数＋余白）
   *   margin       設定されている余白のモジュール数
   *   padColor     余白を補うときの色
   *   heavy        true なら重いデコーダも読み込む（ボタン用）
   *   onProgress(text)
   */
  async function run(opts) {
    const mine = ++seq;
    const stale = () => mine !== seq;
    const report = t => { if (opts.onProgress && !stale()) opts.onProgress(t); };

    // 使うデコーダを決める。重いものは、明示的に頼まれたときか、
    // すでに一度読み込んであるとき（＝費用は払い済み）だけ動かす。
    const use = [];
    for (const e of ENGINES) {
      if (e.heavy && !opts.heavy && !e.load.loaded()) continue;
      let ok = false;
      try {
        if (e.heavy && !e.load.loaded()) report(e.name + ' を読み込み中…');
        ok = await e.load();
      } catch (err) { ok = false; }
      if (stale()) return null;
      if (ok) use.push(e);
    }
    if (!use.length) return { engines: [], ran: 0, passed: 0, level: 'na', mismatch: false };

    const state = {};
    const tries = {};   // 試した回数と、そのうち応答が返らなかった回数。
    const stalls = {};  // 全部だんまりだったデコーダは「落ちた」ではなく「動かなかった」。
    use.forEach(e => { state[e.id] = 'fail'; tries[e.id] = 0; stalls[e.id] = 0; });
    const pad = Math.max(0, 4 - (opts.margin == null ? 4 : opts.margin));
    let mismatch = false;

    let drew = 0;
    for (const px of SCALES) {
      const pending = use.filter(e => state[e.id] !== 'ok');
      if (!pending.length) break;

      report('検査中… (' + px + 'px/モジュール)');
      let canvas, image;
      try {
        canvas = padded(await withTimeout(opts.render(Math.round(opts.moduleWidth * px)), 6000),
          px, pad, opts.padColor);
        image = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
        drew++;
      } catch (e) { continue; }
      if (stale()) return null;

      for (const e of pending) {
        let text = null;
        tries[e.id]++;
        try {
          text = await withTimeout(e.decode(canvas, image), 8000);
        } catch (err) {
          text = null;
          if (err && err.message === 'timeout') stalls[e.id]++;
        }
        if (stale()) return null;
        if (text === opts.expect) state[e.id] = 'ok';
        else if (text) { state[e.id] = 'mismatch'; mismatch = true; }
      }
    }

    // 一枚も描けなかったのに「読めません」と言うのは嘘になる。
    if (!drew) return { engines: [], ran: 0, passed: 0, level: 'na', mismatch: false };

    const engines = use
      .filter(e => !(tries[e.id] > 0 && stalls[e.id] === tries[e.id]))
      .map(e => ({ id: e.id, name: e.name, note: e.note, state: state[e.id] }));
    if (!engines.length) return { engines: [], ran: 0, passed: 0, level: 'na', mismatch: false };
    const passed = engines.filter(e => e.state === 'ok').length;

    // 通った数ではなく「いちばん厳しいどこまで通ったか」で段を決める。
    // ENGINES が厳しい順なので、先頭が通っていれば最良。
    let level;
    if (passed === 0) level = 'ng';
    else if (passed === engines.length) level = 'best';
    else if (engines[0].state === 'ok') level = 'good';
    else level = 'fair';

    return { engines: engines, ran: engines.length, passed: passed, level: level, mismatch: mismatch };
  }

  // 重いデコーダをすでに抱えているか（ボタンの表示切り替え用）
  function heavyLoaded() {
    return ENGINES.filter(e => e.heavy).every(e => e.load.loaded());
  }

  global.QRVerify = { run: run, heavyLoaded: heavyLoaded, ENGINES: ENGINES };
})(window);
