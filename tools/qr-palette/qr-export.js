/* QR Palette — 書き出し（フォントの埋め込みと画像化）
 *
 * QRStyle.render が返す SVG を、画像として書き出せる形に仕上げる。
 * QR Palette の書き出しと、ほかのページ（dj/request の回の QR など）で同じものを使う。
 * 二か所に写しを持つと、予熱や unicode-range の解釈を直したときに片方だけ残る。
 *
 *   const css = await QRExport.fontCss(style);            // いまの絵で使う字のフォント
 *   const svg = QRStyle.embedFontCss(out.svg, css);
 *   const canvas = await QRExport.rasterize(svg, 1024);    // 横 1024px のキャンバス
 *
 * フォントの一覧は、既定ではページが読み込んだ @font-face（data/fonts/*.css）から拾う。
 * その CSS を読み込んでいないページは fontCss(style, { cssUrl }) で CSS の場所を渡す。
 * 取りに行くのはこのサイトのファイルだけで、字をどこかへ問い合わせることはない。
 */
(function (global) {
  'use strict';

  // ---- 書き出し用のフォント -------------------------------------------
  // 画面のプレビューはページが読み込んだフォント（data/fonts/ に同梱）で描かれるが、
  // 書き出しは SVG を data URL の <img> として読ませるため、ページのフォントを
  // 受け継がない。放っておくと、選んだ書体が画面にだけ効いて、書き出した画像は
  // 既定の書体になる（実測でも指定あり／なしが同じ形になった）。
  //
  // そこで書き出す直前に、いま使っている字を含むフォントのファイルだけを
  // @font-face として SVG に埋める。フォントは字の範囲（unicode-range）ごとに
  // 分けて同梱してあるので、埋めるのは使った字の範囲のぶんだけで済む。
  //
  // 取れなかったぶんは諦める（書き出し自体は止めず、既定の書体で出る）。

  // Blob / File を data URL に
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('read failed'));
      reader.readAsDataURL(blob);
    });
  }

  // "U+0000-00FF, U+0131" → [[0, 255], [305, 305]]。範囲の指定が無い面は全域とみなす
  function parseUnicodeRange(text) {
    const s = String(text || '').trim();
    if (!s) return [[0, 0x10FFFF]];
    return s.split(',').map(part => {
      const p = part.trim().replace(/^u\+/i, '');
      // U+4?? のような書き方は、? を 0 と F に置いた範囲
      if (p.indexOf('?') >= 0) return [parseInt(p.replace(/\?/g, '0'), 16), parseInt(p.replace(/\?/g, 'F'), 16)];
      const [lo, hi] = p.split('-');
      return [parseInt(lo, 16), parseInt(hi || lo, 16)];
    });
  }

  function coversAny(ranges, text) {
    for (const ch of text) {
      const c = ch.codePointAt(0);
      if (ranges.some(r => c >= r[0] && c <= r[1])) return true;
    }
    return false;
  }

  // その面で描く字のうち、見える最初の1字（空白は描いても跡が残らないので外す）
  function firstInkChar(ranges, text) {
    for (const ch of text) {
      const c = ch.codePointAt(0);
      if (/\S/.test(ch) && ranges.some(r => c >= r[0] && c <= r[1])) return ch;
    }
    return '';
  }

  // CSS の規則から @font-face を拾う。このサイトのファイルを指すものだけを残す。
  // src は相対のまま返すブラウザと、解決済みで返すブラウザがあるので、どちらでも
  // CSS 自身の場所（base）を基準に読み直す。
  function facesOf(rules, base) {
    const out = [];
    Array.prototype.forEach.call(rules, rule => {
      if (!(rule instanceof CSSFontFaceRule)) return;
      const st = rule.style;
      const src = st.getPropertyValue('src').match(/url\(\s*["']?([^"')]+)["']?\s*\)/);
      if (!src) return;
      const url = new URL(src[1], base);
      if (url.origin !== location.origin) return;
      out.push({
        family: st.getPropertyValue('font-family').replace(/["']/g, '').trim(),
        weight: Number(st.getPropertyValue('font-weight')) || 400,
        url: url.href,
        range: st.getPropertyValue('unicode-range').trim(),
        ranges: parseUnicodeRange(st.getPropertyValue('unicode-range'))
      });
    });
    return out;
  }

  // ページが読み込んだ @font-face（data/fonts/*.css）。索引を別に持たず、CSS を
  // そのまま引く（別に作ると、CSS と食い違ったときに気づけない）。
  let pageFaces = null;
  function pageFontFaces() {
    if (pageFaces) return pageFaces;
    const out = [];
    Array.prototype.forEach.call(document.styleSheets, sheet => {
      let rules;
      try { rules = sheet.cssRules; } catch (e) { return; }   // 別オリジンの CSS は中を読めない
      out.push(...facesOf(rules, sheet.href || location.href));
    });
    // CSS がまだ読めていないうちの空振りは覚えない
    if (out.length) pageFaces = out;
    return out;
  }

  // ページが読み込んでいない CSS の @font-face。取りに行って組み立てたシートから拾う。
  // シートには CSS の場所を baseURL として渡す（渡さないと相対の url() がページの場所で
  // 解決され、src を解決済みで返すブラウザでは別のパスを取りに行ってしまう）。
  // 失敗は覚えず、次にまた試す。
  const cssFaces = new Map();
  function cssFontFaces(cssUrl) {
    const base = new URL(cssUrl, location.href).href;
    let p = cssFaces.get(base);
    if (!p) {
      p = fetch(base)
        .then(res => { if (!res.ok) throw new Error('font css ' + res.status); return res.text(); })
        .then(text => {
          const sheet = new CSSStyleSheet({ baseURL: base });
          sheet.replaceSync(text);
          return facesOf(sheet.cssRules, base);
        })
        .catch(e => { cssFaces.delete(base); throw e; });
      cssFaces.set(base, p);
    }
    return p;
  }

  // フォントのファイルを data URL に。同じファイルは一度しか読まない。
  // ファイルの数は同梱したぶんで頭打ちなので、上限は置かない。失敗は覚えず、次にまた試す。
  const fontFileCache = new Map();
  function fontFileDataUrl(url) {
    let p = fontFileCache.get(url);
    if (!p) {
      p = fetch(url)
        .then(res => { if (!res.ok) throw new Error('font ' + res.status); return res.blob(); })
        .then(blobToDataUrl)
        .catch(e => { fontFileCache.delete(url); throw e; });
      fontFileCache.set(url, p);
    }
    return p;
  }

  // 埋め込んだフォントは、SVG を <img> で描く最初の一回には間に合わない。初回の
  // 描画で読み込みが始まるので、その絵では字が抜ける（実測で、字の範囲ごとに分けた
  // 面を複数使うとラベルの文字が丸ごと消えた）。同じ @font-face を持つ小さな見本を
  // 先に描き、面ごとに1字ずつ出るまで待っておけば、読み込み済みのフォントが本番の
  // SVG にも最初から効く（同じ data URL のフォントは使い回される）。
  // 読み込めない面があっても、ブラウザが代わりの書体に切り替える 3 秒で打ち切る。
  let warmFonts = null;   // 予熱に使った見本。参照を手放すと、読み込んだフォントごと捨てられうる
  async function warmUpFonts(css, probes) {
    if (!probes.length || (warmFonts && warmFonts.css === css)) return;
    const cell = 40;
    const x = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const w = probes.length * cell;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + cell +
      '" width="' + w + '" height="' + cell + '"><defs><style>' + css + '</style></defs>' +
      probes.map((p, i) => '<text x="' + (i * cell + cell / 2) + '" y="30" font-size="30" font-weight="' +
        p.weight + '" text-anchor="middle" font-family="' + x('"' + p.family + '"') + '">' + x(p.ch) + '</text>').join('') +
      '</svg>';
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    try { await img.decode(); } catch (e) { return; }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = cell;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    // どの升にも字の跡があるか
    const inked = () => {
      ctx.clearRect(0, 0, w, cell);
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, w, cell).data;
      return probes.every((p, i) => {
        for (let y = 0; y < cell; y++) {
          for (let px = i * cell; px < (i + 1) * cell; px++) if (d[(y * w + px) * 4 + 3] > 0) return true;
        }
        return false;
      });
    };
    const until = performance.now() + 3000;
    while (!inked() && performance.now() < until) await new Promise(r => setTimeout(r, 16));
    warmFonts = { css: css, img: img };
  }

  // そのスタイルで実際に描く字を含むフォントだけの @font-face。取れなかったぶんは諦める。
  // 返す前に予熱まで済ませるので、この CSS を埋めた SVG は最初の描画から字が出る。
  //   opts.cssUrl … フォントの CSS。省略時はページが読み込んだ CSS から拾う
  async function fontCss(style, opts) {
    let runs = [];
    try { runs = global.QRStyle.textRuns(style); } catch (e) { return ''; }
    if (!runs.length) return '';
    let faces;
    try {
      faces = opts && opts.cssUrl ? await cssFontFaces(opts.cssUrl) : pageFontFaces();
    } catch (e) {
      return '';   // CSS が読めなければ埋めない（既定の書体で出る）
    }
    const picks = [];
    runs.forEach(run => faces.forEach(f => {
      if (f.family === run.web && f.weight === run.weight && coversAny(f.ranges, run.text)) {
        picks.push({ face: f, ch: firstInkChar(f.ranges, run.text) });
      }
    }));
    const loaded = await Promise.all(picks.map(p => fontFileDataUrl(p.face.url).then(
      data => '@font-face{font-family:"' + p.face.family + '";font-style:normal;font-weight:' + p.face.weight +
        ';src:url(' + data + ") format('woff2')" + (p.face.range ? ';unicode-range:' + p.face.range : '') + ';}',
      () => '')));
    const css = loaded.join('');
    // 読めた面のうち、見える字を描くものだけを予熱の見本にする
    await warmUpFonts(css, picks.filter((p, i) => loaded[i] && p.ch)
      .map(p => ({ family: p.face.family, weight: p.face.weight, ch: p.ch })));
    return css;
  }

  // ---- 画像化 ---------------------------------------------------------
  // 画像の読み込み待ちは onload ではなく decode() を使う。onload は描画の
  // 都合で発火が遅れたり落ちたりすることがあり、読み取りテストのように
  // 短い間隔で何枚も起こすと止まってしまう。
  async function svgToImage(svg, px) {
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(global.QRStyle.resize(svg, px));
    if (typeof img.decode === 'function') {
      await img.decode();
      return img;
    }
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('svg load failed'));
    });
    return img;
  }

  // 横 px のキャンバスに描く。flatten に色を渡すと、その色の地に敷いてから描く
  async function rasterize(svg, px, flatten) {
    const img = await svgToImage(svg, px);
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || px;
    canvas.height = img.naturalHeight || px;
    const ctx = canvas.getContext('2d');
    if (flatten) {
      ctx.fillStyle = flatten;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  global.QRExport = {
    fontCss: fontCss,
    rasterize: rasterize,
    // 画像ファイルの読み込み（app.js）もこれを使う
    blobToDataUrl: blobToDataUrl
  };
})(window);
