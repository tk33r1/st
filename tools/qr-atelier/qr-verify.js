/* qr-verify.js — 書き出す絵をそのまま読み返して、本当にスキャンできるかを確かめる。
 *
 * 単一のデコーダで白黒をつけると、実機では読めるものを「読めません」と言って
 * しまう。デコーダごとに得意・不得意がはっきり違うためで、とくに jsQR は
 * ファインダを走査線の 1:1:3:1:1 比で探すので、凝ったマーカー枠で落ちやすい。
 * 実機のカメラはそこがずっと寛容なので、jsQR の失敗＝読めない、にはならない。
 *
 * そこで「性格の違う複数のデコーダに読ませて、どれが通ったか」を出す。
 *
 * 注意: 寛容さは一直線には並ばない。114通りのスタイルで測ったところ、
 * jsQR だけ落ちる組み合わせ（星・ひし形などの目）と、ZXing だけ落ちる
 * 組み合わせ（横ラインの目）の両方があった。なので「何個通ったか」で
 * 順位づけせず、落ちたデコーダが何を意味するかで文面を決める。
 * severity は、そのデコーダが落ちたときの深刻さ。
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
  //
  // started() と done() は別物にしておく。取得中の数秒を「読み込み済み」と
  // 答えると、ボタンが先に消えて無反応に見える。使い分けは呼び出し側で：
  //   started() … いま走らせてよいか（費用を払い済みか）
  //   done()    … もう取りに行く必要がないか（ボタンを畳んでよいか）
  function once(fn) {
    let p = null;
    let ready = false;
    const wrapped = () => (p || (p = fn().then(
      v => { ready = !!v; return v; },
      e => { p = null; ready = false; throw e; }
    )));
    wrapped.started = () => p !== null;
    wrapped.done = () => ready;
    wrapped.reset = () => { p = null; ready = false; };   // 壊れていたら次回また取りに行かせる
    return wrapped;
  }

  let wechatTries = 0;

  // ------------------------------------------------------------------
  // デコーダ（寛容さの順：厳しい → 寛容）
  // ------------------------------------------------------------------
  // heavy: 初回に MB 級を取りに行くもの。自動実行はせず、明示的に呼ばれたときだけ。
  const ENGINES = [
    {
      id: 'jsqr',
      name: 'jsQR',
      note: '素朴なJSデコーダ。装飾に厳しい',
      severity: 1,
      onFail: '簡素な読み取りアプリでは失敗することがあります',
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
      severity: 2,
      onFail: 'スキャナアプリの一部で失敗することがあります',
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
      note: '検出が機械学習ベース。スマホのカメラに近い',
      severity: 3,
      onFail: 'スマホのカメラで失敗する可能性があります',
      heavy: true,
      load: once(async () => {
        // 失敗した import はモジュールマップに残るので、やり直しではクエリを変える
        const q = wechatTries++ ? '?r=' + Date.now() : '';
        const mod = await import(V('wechat/index.js') + q);
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
      severity: 3,
      onFail: 'お使いの端末のカメラでは失敗する可能性があります',
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
  // 1モジュールあたり何ピクセルで読ませるか。カメラで撮ったときに近い低い側
  // （4〜6）から、書き出した PNG をそのまま読ませる高い側（16〜24）までを見る。
  //
  // 「1段でも通れば合格」にしてはいけない。低い側はアンチエイリアスで形の崩れが
  // ならされるぶん通りやすく、そこだけ拾って合格にすると、書き出した画像が
  // まったく読めないデザインを「どの環境でも読めます」と言ってしまう。実際、
  // ハート+ジッター100%+ドット枠+横ライン目 は 3〜4px でしか読めず 9px 以上は
  // 全滅した。なので全段を試して、通った段の広さを見る。
  const SCALES = [4, 6, 10, 16, 24];

  // ただしモジュール数ぶんは掛け算で効くので、絶対値の頭も要る。v40（177
  // モジュール＋余白）を 24px/モジュールで描くと 4440px 四方になり、
  // getImageData だけで 79MB。モバイルでは確保に失敗して黙って落ちる。
  // 上限に張り付いた段は同じ絵になるので、重複は畳んで一度だけ試す。
  const MAX_PX = 2000;

  function scalePixels(moduleWidth) {
    const out = [];
    for (const px of SCALES) {
      const w = Math.min(MAX_PX, Math.round(moduleWidth * px));
      if (!out.length || out[out.length - 1].w !== w) out.push({ px: px, w: w });
    }
    return out;
  }

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

    // 使うデコーダを決める。重いものは、明示的に頼まれたときか、すでに一度
    // 読み込んであるとき（＝費用は払い済み。2回目以降の検査は数十msで終わる）
    // だけ動かす。
    const info = (e, st) => ({ id: e.id, name: e.name, note: e.note,
      severity: e.severity, onFail: e.onFail, state: st });
    const use = [];
    const dead = [];   // 取得や初期化に失敗したもの。「読めなかった」とは別物として扱う。
    for (const e of ENGINES) {
      if (e.heavy && !opts.heavy && !e.load.started()) continue;
      let ok = false, broke = false;
      try {
        if (e.heavy && !e.load.started()) report(e.name + ' を読み込み中…');
        ok = await e.load();
      } catch (err) {
        // 例外＝取りに行って失敗した。false＝この環境にそもそも無い（内蔵APIなど）。
        // 後者は黙って外し、前者だけを「読み込めなかった」として表に出す。
        broke = true;
      }
      if (stale()) return null;
      if (ok) use.push(e);
      else if (broke) dead.push(e);
    }
    // 動かせるものが一つも無い。読み込めなかった顔ぶれは持ち帰る（黙って消すと
    // 「確かめていない」ことが誰にも伝わらない）。
    if (!use.length) {
      return { engines: dead.map(e => info(e, 'unavailable')),
               ran: 0, passed: 0, level: 'na', mismatch: false };
    }

    const state = {};
    const tries = {};   // 試した回数と、そのうち応答が返らなかった回数。
    const stalls = {};  // 全部だんまりだったデコーダは「落ちた」ではなく「動かなかった」。
    const hits = {};    // 通った段の数。全段通って初めて ok にする。
    const errors = {};  // 例外を投げた回数。毎回投げるならデコーダ自体が動いていない。
    use.forEach(e => {
      state[e.id] = 'fail'; tries[e.id] = 0; stalls[e.id] = 0; hits[e.id] = 0; errors[e.id] = 0;
    });
    const pad = Math.max(0, 4 - (opts.margin == null ? 4 : opts.margin));
    let mismatch = false;

    let drew = 0;
    for (const step of scalePixels(opts.moduleWidth)) {
      const px = step.px;
      // 早期打ち切りはしない。どこまで広い解像度で読めるかを知りたいので、
      // 通ったあとの段も必ず試す。
      const pending = use.filter(e => state[e.id] !== 'mismatch');
      if (!pending.length) break;

      report('検査中… (' + px + 'px/モジュール)');
      let canvas, image;
      try {
        canvas = padded(await withTimeout(opts.render(step.w), 6000),
          Math.max(1, Math.round(step.w / opts.moduleWidth)), pad, opts.padColor);
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
          else errors[e.id]++;
        }
        if (stale()) return null;
        if (text === opts.expect) hits[e.id]++;
        else if (text) { state[e.id] = 'mismatch'; mismatch = true; }
      }
    }

    // 一枚も描けなかったのに「読めません」と言うのは嘘になる。
    if (!drew) {
      return { engines: dead.map(e => info(e, 'unavailable')),
               ran: 0, passed: 0, level: 'na', mismatch: false };
    }

    // 実際に動いたデコーダだけを結果に数える。全部だんまりだったもの、毎回例外を
    // 投げたもの（＝wasm が取れていないなど）は「読めなかった」ではないので外す。
    const ran = use.filter(e => {
      const n = tries[e.id] - stalls[e.id];
      if (tries[e.id] > 0 && stalls[e.id] === tries[e.id]) return false;
      if (n > 0 && errors[e.id] === n) {
        e.load.reset();       // 次に呼ばれたら読み込みからやり直す
        dead.push(e);
        return false;
      }
      return true;
    });

    // 全段で読めて ok。一部だけなら partial（解像度しだいで落ちる）。
    ran.forEach(e => {
      if (state[e.id] === 'mismatch') return;
      const n = tries[e.id] - stalls[e.id];
      state[e.id] = hits[e.id] === 0 ? 'fail' : hits[e.id] >= n ? 'ok' : 'partial';
    });

    const engines = ran.map(e => info(e, state[e.id]))
      .concat(dead.map(e => info(e, 'unavailable')));
    if (!ran.length) return { engines: engines, ran: 0, passed: 0, level: 'na', mismatch: false };
    const passed = ran.filter(e => state[e.id] === 'ok').length;

    // ng は「どの解像度でも一度も読めなかった」ときだけ。一部の解像度で
    // 読めているなら壊れてはいないので、partial にして app.js 側で言い分ける。
    const anyHit = ran.some(e => state[e.id] === 'ok' || state[e.id] === 'partial');
    const level = !anyHit ? 'ng' : passed === ran.length ? 'best' : 'partial';

    return { engines: engines, ran: ran.length, passed: passed, level: level, mismatch: mismatch };
  }

  // 重いデコーダをすでに抱えているか（ボタンの表示と、判定の重みづけ用）。
  // 取得中はまだ false。ボタンを先に消してしまうと、押せる状態に戻るまで
  // 何も起きていないように見える。
  function heavyLoaded() {
    return ENGINES.filter(e => e.heavy).every(e => e.load.done());
  }

  global.QRVerify = { run: run, heavyLoaded: heavyLoaded, ENGINES: ENGINES };
})(window);
