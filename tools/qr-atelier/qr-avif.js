/* qr-avif.js — AVIF で書き出すためのエンコーダ。
 *
 * ブラウザは AVIF を «読む» ことはできても «書く» ことはできない。
 * canvas.toBlob(cb, 'image/avif') は黙って PNG を返してくるだけで、
 * これは Chrome・Firefox・Safari のどれも同じ（2026 年時点）。
 * そこで libavif/aom の WebAssembly ビルドを同梱して、こちらで焼く。
 *
 *   window.QRAvif.encode(canvas) → Promise<Blob>
 *
 * 可逆と非可逆のどちらでも焼ける。どちらを使うかは画面の設定で決まる。
 * エンコーダは 3.4MB あるので、AVIF を押されたときに初めて読み込む。
 * 置き場所は vendor/avif/ で、実行時に外へ出る通信はない（読み取りテストの
 * デコーダと同じ扱い）。
 */
(function (global) {
  'use strict';

  // vendor/ の場所はこのファイルからの相対で決める。ページの階層に依存しない。
  const HERE = (function () {
    const s = document.currentScript;
    return s ? s.src : location.href;
  })();
  const ENCODER = new URL('vendor/avif/avif_enc.js', HERE).href;

  // 動かさない部分。subsample:3 は YUV444 で色を間引かないので、多色モザイクの
  // ようにセル単位で色が変わる絵でも輪郭が濁らない。qualityAlpha:-1 は
  // 「透過も本体と同じ扱い」。透過を持てるのが JPEG との違い。
  const BASE = {
    quality: 95,
    qualityAlpha: -1,
    denoiseLevel: 0,
    tileColsLog2: 0,
    tileRowsLog2: 0,
    speed: 8,
    subsample: 3,
    chromaDeltaQ: false,
    sharpness: 0,
    tune: 0,
    enableSharpYUV: false,
    bitDepth: 8,
    lossless: false
  };

  // 可逆のときの「圧縮の強さ」。speed は数字が小さいほど時間をかけて縮める。
  // 1024px の黒白QRで実測した値：
  //   speed 10 … 233KB / 0.2秒     speed 8 …  51KB / 0.5秒
  //   speed  6 …  33KB / 4.1秒     speed 4 …  29KB / 12.5秒
  // speed 4 は 3 倍の時間をかけて 4KB しか縮まないので出さない。
  // speed 9 は 10 と同じ大きさになったので、こちらも刻みから外してある。
  const EFFORT_SPEED = { 1: 10, 2: 8, 3: 6 };

  function optionsFor(opts) {
    const o = Object.assign({}, BASE);
    if (opts && opts.lossless) {
      o.lossless = true;
      o.quality = 100;
      o.speed = EFFORT_SPEED[opts.effort] || EFFORT_SPEED[2];
    } else {
      o.lossless = false;
      o.quality = Math.max(1, Math.min(100, Math.round((opts && opts.quality) || BASE.quality)));
    }
    return o;
  }

  // 一度読み込んだら使い回す。失敗したら次にまた取りに行かせる
  // （読み込み途中で通信が切れたときに、永久に押せなくならないように）。
  let modulePromise = null;
  let ready = false;

  function load() {
    if (!modulePromise) {
      // エンコーダは ES モジュールなので動的 import で読む。wasm は
      // avif_enc.js からの相対で解決されるので、こちらで場所を渡す必要はない。
      modulePromise = import(ENCODER)
        .then(mod => mod.default())
        .then(m => { ready = true; return m; })
        .catch(err => { modulePromise = null; ready = false; throw err; });
    }
    return modulePromise;
  }

  function loaded() { return ready; }

  // opts: { lossless: bool, quality: 60..100, effort: 1..3 }
  async function encode(canvas, opts) {
    const mod = await load();
    const ctx = canvas.getContext('2d');
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const out = mod.encode(new Uint8Array(px.data.buffer), canvas.width, canvas.height, optionsFor(opts));
    if (!out) throw new Error('avif encode failed');
    // 返るのは Uint8Array。直接渡せば byteOffset / byteLength が正しく反映される
    return new Blob([out], { type: 'image/avif' });
  }

  global.QRAvif = {
    encode: encode,
    load: load,
    loaded: loaded,
    EFFORT_SPEED: EFFORT_SPEED
  };
})(window);
