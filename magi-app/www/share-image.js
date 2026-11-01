/* 回答の共有画像。統合人格の回答1つを、左上に MAGI のエンブレム、左下に出どころ（「MAGIアプリから」など）を入れた
 * 角丸のカードにして PNG で返す。描画は端末の中だけで行い、どこにも送らない。
 * window.MagiShareImage.render({ text, footer, theme: 'dark'|'light', lang }) → Promise<Blob> */
(function (root) {
  'use strict';
  var W = 1080, PAD = 64, RADIUS = 48;
  var LOGO = 96, LOGO_GAP = 40;          // エンブレムの大きさと、本文までの間
  var FONT = 40, LINE = 66, PARA = 22;   // 本文の文字・行の高さ・段落の間（空行）
  var FOOT = 28, FOOT_GAP = 44;          // 出どころの文字と、本文からの間
  var MAX_H = 5400;                      // 縦長になりすぎないよう、ここを超える分は … で切る
  var SANS = 'system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", "Noto Sans CJK JP", "Yu Gothic", sans-serif';
  var PALETTE = {
    dark: { bg: '#1f1f1f', text: '#ececec', muted: '#8f8f8f', accent: '#4ade80', fill: 'rgba(74,222,128,0.15)' },
    light: { bg: '#ffffff', text: '#1f2937', muted: '#6b7280', accent: '#15803d', fill: '#dcfce7' }
  };
  // 行頭に置かない文字（句読点・閉じ括弧・小書きの仮名など）と、行末に置かない文字（開き括弧）
  var NO_START = '、。，．,.:;!?！？）)]｝}」』】〕〉》ー・…‥ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ々〜％%';
  var NO_END = '（([｛{「『【〔〈《';

  // スプラッシュのエンブレム（app.js の agentHintHTML）と同じ形。流れる線の演出は除き、色は属性で直に持つ
  function emblemSVG(c) {
    var frames = '<polygon points="43,14 77,14 77,44 68,54 52,54 43,44"/><polygon points="18,58 40,58 52,68 52,98 18,98"/><polygon points="80,58 102,58 102,98 68,98 68,68"/>';
    var lines = '<line x1="51.5" y1="49" x2="43.5" y2="63"/><line x1="76.5" y1="63" x2="68.5" y2="49"/><line x1="52" y1="78" x2="68" y2="78"/>';
    var num = function (x, y, n) { return '<text x="' + x + '" y="' + y + '" text-anchor="middle" font-family="sans-serif" font-size="13" font-weight="700" fill="' + c.accent + '">' + n + '</text>'; };
    return '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 120 120">'
      + '<g stroke="' + c.accent + '" stroke-width="2" stroke-linecap="round" opacity="0.55">' + lines + '</g>'
      + '<g fill="' + c.bg + '" stroke="none">' + frames + '</g>'
      + '<g fill="' + c.fill + '" stroke="' + c.accent + '" stroke-width="2">' + frames + '</g>'
      + num(60, 39, 2) + num(35, 83, 3) + num(85, 83, 1) + '</svg>';
  }
  function loadImage(svg) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })), img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('emblem')); };
      img.src = url;
    });
  }

  // 1段落を幅に収まる行に分ける。英数字の語は切らず、日本語は1文字ずつ。行頭禁則は前の行へぶら下げる
  function wrap(ctx, text, max) {
    var tokens = text.match(/[A-Za-z0-9'’_@#&+=\/%$.,:;!?-]+\s*|\s+|[\s\S]/gu) || [], lines = [], line = '';
    function push() {
      var tail = '';
      while (line.length > 1 && NO_END.indexOf(line.slice(-1)) >= 0) { tail = line.slice(-1) + tail; line = line.slice(0, -1); }
      lines.push(line.replace(/\s+$/, '')); line = tail;
    }
    tokens.forEach(function (tok) {
      if (ctx.measureText(line + tok).width <= max) { line += tok; return; }
      if (line && tok.length === 1 && NO_START.indexOf(tok) >= 0) { line += tok; return; }
      if (line) push();
      tok = line ? tok : tok.replace(/^\s+/, '');
      if (ctx.measureText(line + tok).width <= max) { line += tok; return; }
      Array.from(tok).forEach(function (ch) {     // 1語が1行より長いときだけ文字で切る
        if (ctx.measureText(line + ch).width > max && line) push();
        line += ch;
      });
    });
    if (line || !lines.length) lines.push(line.replace(/\s+$/, ''));
    return lines;
  }

  function layout(ctx, text) {
    ctx.font = FONT + 'px ' + SANS;
    var rows = [], paras = String(text || '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().split('\n');
    paras.forEach(function (p, i) {
      if (!p.trim()) { if (i && rows.length) rows.push({ gap: true }); return; }
      wrap(ctx, p, W - PAD * 2).forEach(function (l) { rows.push({ text: l }); });
    });
    return rows;
  }
  function height(rows) {
    return rows.reduce(function (h, r) { return h + (r.gap ? PARA : LINE); }, 0);
  }

  async function render(opts) {
    var c = PALETTE[opts && opts.theme === 'light' ? 'light' : 'dark'];
    var canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
    if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (_) {} }
    var rows = layout(ctx, opts && opts.text);
    var fixed = PAD + LOGO + LOGO_GAP + FOOT_GAP + FOOT + PAD;
    if (fixed + height(rows) > MAX_H) {          // 長い回答は入る行まで描き、最後の行を … で終える
      // 回答と出典を共有するときは、省略せず呼び出し元の全文テキスト共有へ戻す。
      if (opts && opts.truncate === false) throw new Error('share_image_too_long');
      while (rows.length && fixed + height(rows) > MAX_H) rows.pop();
      while (rows.length && rows[rows.length - 1].gap) rows.pop();
      if (rows.length) {
        var last = rows[rows.length - 1];
        while (last.text && ctx.measureText(last.text + '…').width > W - PAD * 2) last.text = Array.from(last.text).slice(0, -1).join('');
        last.text += '…';
      }
    }
    var H = Math.round(fixed + height(rows));
    canvas.width = W; canvas.height = H;

    ctx.fillStyle = c.bg;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(0, 0, W, H, RADIUS); else ctx.rect(0, 0, W, H);
    ctx.fill();

    try { ctx.drawImage(await loadImage(emblemSVG(c)), PAD - 8, PAD - 6, LOGO, LOGO); } catch (_) {}

    ctx.fillStyle = c.text; ctx.font = FONT + 'px ' + SANS; ctx.textBaseline = 'middle';
    var y = PAD + LOGO + LOGO_GAP;
    rows.forEach(function (r) {
      if (r.gap) { y += PARA; return; }
      ctx.fillText(r.text, PAD, y + LINE / 2);
      y += LINE;
    });

    ctx.fillStyle = c.muted; ctx.font = FOOT + 'px ' + SANS; ctx.textBaseline = 'alphabetic';
    ctx.fillText(String(opts && opts.footer || 'MAGI'), PAD, H - PAD);

    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) { blob ? resolve(blob) : reject(new Error('share_image')); }, 'image/png');
    });
  }
  root.MagiShareImage = { render: render };
})(typeof window !== 'undefined' ? window : globalThis);
