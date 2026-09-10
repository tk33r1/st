/* qr-avif.js — AVIF で書き出すためのエンコーダ。
 *
 * ブラウザは AVIF を «読む» ことはできても «書く» ことはできない。
 * canvas.toBlob(cb, 'image/avif') は黙って PNG を返してくるだけで、
 * これは Chrome・Firefox・Safari のどれも同じ（2026 年時点）。
 * そこで libavif/aom の WebAssembly ビルドを同梱して、こちらで焼く。
 *
 *   window.QRAvif.encode(canvas) → Promise<Blob>
 *
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

  // 設定は実測で決めた。1024px の素の四角で測った値：
  //
  //   可逆 speed6 …  33KB / 4.3秒     可逆 speed8 …  51KB / 0.5秒
  //   q95  speed8 …  13KB / 0.3秒     q90  speed8 …  14KB / 0.3秒
  //   （PNG 43KB / WebP 22KB）
  //
  // 可逆は「大きいのに遅い」で良いところがなかった。2048px では 19 秒かかる。
  // q95 はどのデザイン・どの解像度でも4つのデコーダ全通過を保ったまま、
  // PNG の 1/3 の大きさに収まる。subsample:3 は YUV444 で色を間引かないので、
  // 多色モザイクのようにセル単位で色が変わる絵でも輪郭が濁らない。
  // qualityAlpha:-1 は「透過も本体と同じ扱い」。透過を持てるのが JPEG との違い。
  const OPTIONS = {
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

  async function encode(canvas) {
    const mod = await load();
    const ctx = canvas.getContext('2d');
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const out = mod.encode(new Uint8Array(px.data.buffer), canvas.width, canvas.height, OPTIONS);
    if (!out) throw new Error('avif encode failed');
    // 返るのは Uint8Array。そのまま渡すと環境によって型が合わないので包み直す
    return new Blob([out.buffer || out], { type: 'image/avif' });
  }

  global.QRAvif = {
    encode: encode,
    load: load,
    loaded: loaded
  };
})(window);
