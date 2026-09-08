/* QR Atelier — マス目を SVG に起こす描画エンジン
 *
 * QRCore が返したモジュール配列を受け取り、セル形状・マーカー・配色・
 * ロゴ・外枠をのせた SVG 文字列を組み立てる。座標系は「1モジュール = 1」で、
 * 出力時に width / height だけ px に読み替える。SVG を唯一の正とし、PNG は
 * この SVG をラスタライズして作る（見た目が二重管理にならないように）。
 *
 *   const out = QRStyle.render(qr, style);
 *   out.svg      → SVG文字列
 *   out.warnings → 読み取りに響きそうな点（コントラスト・ロゴ面積）
 */
(function (global) {
  'use strict';

  // 画像の塗りの倍率の範囲（UI のスライダーと合わせる）
  const IMG_SCALE_MIN = 0.2;
  const IMG_SCALE_MAX = 4;

  // 初期状態（「デザインを初期化」もここに戻る）。
  // 四角いセル・四角いマーカー・黒・白地の、いちばん素の QR。
  const DEFAULTS = {
    cell: 'square',
    cellScale: 1,
    cellJitter: 0,
    markerFrame: 'square',
    markerEye: 'square',
    fg: { type: 'solid', color: '#000000', from: '#111827', mid: '', to: '#2563EB', angle: 45, colors: ['#2563EB', '#7C3AED', '#DB2777'], seed: 0, src: '', imgScale: 1 },
    bg: { type: 'white', color: '#FFFFFF', from: '#FFFFFF', mid: '', to: '#E5E7EB', angle: 45, colors: ['#2563EB', '#7C3AED', '#DB2777'], seed: 0, src: '', imgScale: 1, transparency: 0 },
    markerFramePaint: { type: 'auto', color: '#000000', from: '#111827', mid: '', to: '#2563EB', angle: 45, colors: ['#2563EB', '#7C3AED', '#DB2777'], seed: 0, src: '', imgScale: 1 },
    markerEyePaint: { type: 'auto', color: '#000000', from: '#111827', mid: '', to: '#2563EB', angle: 45, colors: ['#2563EB', '#7C3AED', '#DB2777'], seed: 0, src: '', imgScale: 1 },
    markerFrameColor: '',
    markerEyeColor: '',
    margin: 4,
    radius: 2,
    // 暗い地に明るいセルを意図して置くデザインでは true。反転の注意を
    // 「警告」から「補足」に落とすだけで、注意そのものは消さない。
    invertOk: false,
    logo: {
      type: 'none', icon: '', src: '', text: '',
      font: 'sans',
      size: 0.22, pad: 0.14, backdrop: 'rounded', backdropColor: '#FFFFFF',
      // 下地の塗り。背景と同じ 9 モード（白・黒・透明・セルの色・単色・
      // 多色・グラデーション・放射・画像）を受け付ける
      backdropPaint: {
        type: 'white', color: '#FFFFFF', from: '#FFFFFF', mid: '', to: '#E5E7EB', angle: 45,
        colors: ['#FFFFFF', '#E5E7EB'], seed: 0, src: '', imgScale: 1, transparency: 0
      },
      color: '#111827', knockout: true,
      // アイコンの塗り。ここだけ 'brand'（アイコン公式色）を選べる
      paint: {
        type: 'brand', color: '#111827', from: '#111827', mid: '', to: '#2563EB', angle: 45,
        colors: ['#2563EB', '#7C3AED', '#DB2777'], seed: 0, src: '', imgScale: 1
      },
      // 文字の塗り。画面ではアイコンと別の欄なので、状態も分けて持つ
      textPaint: {
        type: 'auto', color: '#111827', from: '#FC466B', mid: '', to: '#3F5EFB', angle: 45,
        colors: ['#2563EB', '#7C3AED', '#DB2777'], seed: 0, src: '', imgScale: 1
      }
    },
    frame: {
      type: 'none',
      // 枠線の種類と太さ（type: 'line' のときだけ効く）。
      // lineWidth2 は二重線の内側の線だけに効く
      line: 'solid',
      lineWidth: 0.7,
      lineWidth2: 0.28,
      mode: 'text',
      contentMode: 'text',
      topMode: 'text',
      topContentMode: 'text',
      pos: 'bottom',
      text: 'スキャンしてね',
      textTop: '',
      font: 'sans',
      icon: 'si-instagram',
      iconData: '',
      iconColorMode: 'brand',
      iconColor: '#FFFFFF',
      // ラベルのアイコンの塗り。ロゴのアイコンと同じ 7 モード
      // （ブランドカラー・セルの色・単色・多色・グラデーション・放射・画像）。
      // iconColorMode / iconColor は旧データ用に残してある。
      iconPaint: {
        type: 'brand', color: '#FFFFFF', from: '#FC466B', mid: '', to: '#3F5EFB', angle: 45,
        colors: ['#2563EB', '#7C3AED', '#DB2777'], seed: 0, src: '', imgScale: 1
      },
      src: '',
      topIcon: 'si-instagram',
      topIconData: null,
      topIconColorMode: 'brand',
      topIconColor: '#FFFFFF',
      topSrc: '',
      color: '#111827',
      textColor: '#FFFFFF',
      radius: 3,
      // ラベルの中身（文字・アイコン・画像）の大きさと、その周りの余白。
      // 既定の 1.0 / 0.2 で帯の高さが 4.0 + 0.8*2 = 5.6 になり、
      // 旧来の FRAME_METRICS.label と同じ見た目に揃う
      contentSize: 1,
      contentPad: 0.2,
      // 中身の後ろに敷く板。形はマーカーの枠と同じ一覧から選ぶ
      backdrop: 'rounded',
      backdropPaint: {
        type: 'none', color: '#FFFFFF', from: '#FFFFFF', mid: '', to: '#E5E7EB', angle: 45,
        colors: ['#FFFFFF', '#E5E7EB'], seed: 0, src: '', imgScale: 1, transparency: 0
      },
      paint: {
        type: 'auto',
        color: '#111827',
        from: '#111827',
        mid: '',
        to: '#2563EB',
        angle: 45,
        colors: ['#2563EB', '#7C3AED', '#DB2777'],
        seed: 0,
        src: '',
        imgScale: 1,
        transparency: 0
      },
      textPaint: {
        type: 'solid',
        color: '#FFFFFF',
        from: '#FC466B',
        mid: '',
        to: '#3F5EFB',
        angle: 45,
        colors: ['#2563EB', '#7C3AED', '#DB2777'],
        seed: 0,
        src: '',
        imgScale: 1,
        transparency: 0
      }
    }
  };

  // 外枠の余白・ラベル高さ（モジュール単位）
  const FRAME_METRICS = {
    none:   { pad: 0,   label: 0,   stroke: 0 },
    line:   { pad: 1.6, label: 0,   stroke: 0.7 },
    label:  { pad: 1.8, label: 5.6, stroke: 0 }
  };

  // 枠線の種類ごとの既定値（モジュール単位）。
  //   stroke … 線の太さの初期値。ユーザーが太さスライダーで上書きする
  //   outer  … 外周から線の外側までの隙間
  //   clear  … 線の内側から QR ブロックまでの隙間
  // 余白（pad）は太さから毎回計算するので、線を太くしても QR に食い込まない。
  // クワイエットゾーンは pad とは別に margin で確保してあるので、読み取りには影響しない。
  const LINE_STYLES = {
    solid:   { stroke: 0.7,  outer: 0.4,  clear: 0.5 },
    double:  { stroke: 0.5,  outer: 0.4,  clear: 0.86, inner: 0.28, gap: 0.85 },
    dashed:  { stroke: 0.7,  outer: 0.4,  clear: 0.5 },
    bracket: { stroke: 0.9,  outer: 0.45, clear: 0.55 },
    ticket:  { stroke: 0.55, outer: 0.4,  clear: 0.83, notch: 1.25 },
    // セル枠の「太さ」は、外周に並べるセルの大きさ
    cells:   { stroke: 1,    outer: 0.25, clear: 0.85 },
    // 切手の「太さ」は、ミシン目の内側にできる縁の幅。outer はミシン目の山のぶん
    stamp:   { stroke: 1.3,  outer: 0,    clear: 0.7,  bite: 0.5 },
    balloon: { stroke: 0.7,  outer: 0.4,  clear: 0.5,  tail: 2.2 }
  };

  // 種類が消えた古い保存を拾い直す
  const LINE_ALIAS = { doubleBold: 'double', dotted: 'dashed' };

  // 文字の書体。ロゴの文字とフレームのラベルで同じ一覧を使う。
  //
  // web は「その見た目を出すのに Google Fonts が要る書体」。書き出しでは SVG を
  // data URL の <img> として読み込むが、その文脈の SVG は外部リソースを取りに
  // 行けず、ページが読み込んだフォントも受け継がない。指定したままだと画面と
  // 書き出しで書体が変わってしまうので、app.js 側がこの名前を頼りにフォントを
  // 埋め込んでから書き出す。impact はどの環境にもある想定なので web は無し。
  const FONT_STACKS = {
    sans:    { stack: 'Inter, "Noto Sans JP", system-ui, sans-serif', web: 'Inter' },
    rounded: { stack: '"M PLUS Rounded 1c", "Hiragino Maru Gothic ProN", "Kosugi Maru", sans-serif', web: 'M PLUS Rounded 1c' },
    serif:   { stack: '"Noto Serif JP", "Hiragino Mincho ProN", "Yu Mincho", serif', web: 'Noto Serif JP' },
    mono:    { stack: '"JetBrains Mono", Consolas, Monaco, monospace', web: 'JetBrains Mono' },
    impact:  { stack: 'Impact, "Arial Black", sans-serif', web: '' }
  };

  // 文字はどこでも太字 700 で描いている。埋め込む字面もこの太さで揃える。
  const FONT_WEIGHT = 700;
  const FONT_KEYS = Object.keys(FONT_STACKS);

  function fontOf(key) {
    return FONT_STACKS[key] || FONT_STACKS.sans;
  }

  // 角を丸めすぎると、下地の角が削れてクワイエットゾーンを食う。余白の1.5倍を
  // 上限にして、四隅の白場が必ず残るようにする。画面のスライダーも同じ上限で
  // 頭打ちにしたいので、係数はここひとつに置いて app.js から引かせる。
  function maxRadius(margin) {
    const m = Number(margin);
    return Number.isFinite(m) ? Math.max(0, m) * 1.5 : 0;
  }

  function lineIdOf(id) {
    const a = LINE_ALIAS[id] || id;
    return LINE_STYLES[a] ? a : 'solid';
  }

  function lineStyleOf(id) {
    return LINE_STYLES[lineIdOf(id)];
  }

  // ミシン目の山の半径。細い縁のときは山も小さくする
  function stampBite(ls, lw) {
    return Math.max(0.25, Math.min(ls.bite, lw * 0.5));
  }

  function clampLineWidth(v, fallback) {
    const x = Number(v);
    return isFinite(x) ? Math.max(0.15, Math.min(2.5, x)) : fallback;
  }

  // 太さから、線の位置（inset）と外枠の余白（pad）を出す。
  // 太くしたぶんだけ pad も広がるので、どの太さでも QR との隙間は変わらない。
  function lineGeom(id, lw, lw2) {
    const key = lineIdOf(id);
    const ls = LINE_STYLES[key];
    const w = clampLineWidth(lw, ls.stroke);
    const w2 = clampLineWidth(lw2, ls.inner || 0.28);
    let inset, pad;
    if (key === 'cells') {
      inset = ls.outer;
      pad = ls.outer + w + ls.clear;
    } else if (key === 'stamp') {
      // ミシン目の山が外へ膨らむので、その半径ぶんだけ外側を空けておく
      inset = stampBite(ls, w);
      pad = inset + w + ls.clear;
    } else if (key === 'ticket') {
      // 切り取り線は、切り欠きの内側にミシン目が来るところまで下げる
      inset = ls.notch + 0.3 + w / 2;
      pad = inset + w / 2 + ls.clear;
    } else if (key === 'double') {
      inset = ls.outer + w / 2;
      pad = inset + ls.gap + w2 / 2 + ls.clear;
    } else {
      inset = ls.outer + w / 2;
      pad = inset + w / 2 + ls.clear;
    }
    return { key: key, ls: ls, lw: w, lw2: w2, inset: inset, pad: pad, tail: ls.tail || 0 };
  }

  // ------------------------------------------------------------------
  // 小物
  // ------------------------------------------------------------------
  function n(v) {
    const r = Math.round(v * 1000) / 1000;
    return String(r);
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // 入れ物は必ず写しを返す。参照のまま返すと、返り値の colors を1つ足しただけで
  // 元の DEFAULTS（やテンプレートの定義）まで書き換わってしまう。
  // 下の merge が組み立て直すのは「DEFAULTS 側にも同じキーがある入れ子」だけで、
  // 上書き側にしかないキー（テンプレートが足した設定や iconData など）はここを
  // 素通りする。配列だけ写して足りていたのは、たまたまその形が来ていなかった
  // からで、来た瞬間に元を書き換える口になる。中身まで再帰で写しておく。
  function dup(v) {
    if (Array.isArray(v)) return v.map(dup);
    if (v && typeof v === 'object') {
      const out = {};
      Object.keys(v).forEach(k => { out[k] = dup(v[k]); });
      return out;
    }
    return v;
  }

  function merge(base, over) {
    const out = {};
    Object.keys(base).forEach(k => {
      const b = base[k];
      const o = over ? over[k] : undefined;
      if (b && typeof b === 'object' && !Array.isArray(b)) {
        out[k] = merge(b, o && typeof o === 'object' ? o : {});
      } else {
        out[k] = dup(o === undefined || o === null ? b : o);
      }
    });
    // 上書き側にしかないキー（markerFrameColor の空文字など）も拾う
    if (over) Object.keys(over).forEach(k => { if (!(k in out)) out[k] = dup(over[k]); });
    return out;
  }

  function hexToRgb(hex) {
    let h = String(hex || '').trim().replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  function luminance(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb) return 0;
    const c = rgb.map(v => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  function contrastRatio(a, b) {
    const la = luminance(a), lb = luminance(b);
    const hi = Math.max(la, lb), lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  }

  // WCAG のコントラスト比は「人が小さな文字を読めるか」の指標で、デコーダが
  // 見ている量ではない。読み取りの警告はこちらで出す。
  //
  // jsQR も ZXing も、二値化は 8x8 ブロックごとの平均を閾値にする。ただし
  // ブロック内の明暗差が小さいとき（jsQR の MIN_DYNAMIC_RANGE = 24）は平均が
  // 使えないので、閾値を min / 2 に落とす。書き出し解像度では 1 モジュールが
  // 8px より大きく、ブロックがまるごと 1 色で埋まるので、事実上この分岐しか
  // 通らない。つまりデコーダの条件は「暗いほうの明るさが明るいほうの半分未満」。
  //
  // 実測でも境界はちょうど半分だった。白背景なら #7E7E7E（0.494）は全解像度で
  // 通り、#818181（0.506）は 16px 以上で全滅する。同じ境界を WCAG 比で書くと
  // 背景の明るさしだいで 2.78:1 〜 4.06:1 の間を動くので、固定のしきい値では
  // どう選んでも当たらない。
  //
  // 明るさはガンマ補正されたまま使う（線形化しない）。デコーダがそうしている。
  function encodedLuma(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb) return 0;
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  }

  // 0 に近いほど良く、1 は同じ色。反転QRでも同じ意味になるよう暗い側 / 明るい側で取る。
  function lumaRatio(a, b) {
    const la = encodedLuma(a), lb = encodedLuma(b);
    const hi = Math.max(la, lb), lo = Math.min(la, lb);
    return hi <= 0 ? 1 : lo / hi;   // どちらも真っ黒なら差が無い＝最悪
  }

  // 0.50 が二値化の壁そのもの。0.44 は壁まで 1 割強しかないあたりで、装飾セルの
  // アンチエイリアスや印刷のにじみで壁を越えうる範囲。
  //
  // 逆に、カメラ相当（ぼかし＋ノイズ＋照明むら）で 4〜6px/モジュールを測ると
  // 0.45〜0.66 まで通った。低解像度ではブロック平均のほうが効いて、min / 2 の
  // 分岐に落ちないため。厳しいのはカメラではなく書き出した画像のほうなので、
  // カメラのための上乗せは要らない。
  const LUMA_WALL = 0.50;
  const LUMA_TIGHT = 0.44;

  // 塗りを白い紙の上に置いたときに見える色。透かしたぶんは紙が透ける。
  // 透過は「その色が薄くなる」ではなく「地の白が出てくる」なので、
  // 色そのものだけを見て明暗やコントラストを決めると判断を誤る。
  function overWhite(hex, opacity) {
    const rgb = hexToRgb(hex);
    if (!rgb) return '#FFFFFF';
    const a = Math.max(0, Math.min(1, Number(opacity)));
    if (a >= 1) return rgbToHex(rgb);
    return rgbToHex(rgb.map(v => v * a + 255 * (1 - a)));
  }

  function rgbToHex(rgb) {
    const toHex = n => {
      const h = Math.max(0, Math.min(255, Math.round(n))).toString(16);
      return h.length === 1 ? '0' + h : h;
    };
    return ('#' + toHex(rgb[0]) + toHex(rgb[1]) + toHex(rgb[2])).toUpperCase();
  }


  // 「白」「黒」「セルの色」は、それ自体が塗りではなく指定でしかない。実際に
  // 何で描かれるかを知りたい場所（描画・コントラスト判定・余白を補う色）が
  // それぞれ解決していたので、ここ一箇所にまとめる。
  function resolvePaint(paint, fg) {
    const p = paint || { type: 'solid', color: '#FFFFFF', transparency: 0 };
    // 白・黒は「不透明で固定」という指定（画面でも透過スライダーを隠している）
    if (p.type === 'white') return { type: 'solid', color: '#FFFFFF', transparency: 0 };
    if (p.type === 'black') return { type: 'solid', color: '#000000', transparency: 0 };
    // 「セルの色」はセルの塗りをそのまま延ばす。透過の指定だけは持ち越す
    if (p.type === 'auto') {
      return Object.assign({}, fg, {
        transparency: p.transparency !== undefined ? p.transparency : 0
      });
    }
    return p;
  }

  // グラデーションは代表色（中間）で明るさを判定する。多色は背景と最もコントラストが低い色を返す。
  // 指定でしかない type（white/black/auto）は resolvePaint で解いてから渡すこと。
  function paintColor(paint, bgHex) {
    if (!paint || paint.type === 'none' || paint.type === 'auto') return null;
    if (paint.type === 'white') return '#FFFFFF';
    if (paint.type === 'black') return '#000000';
    if (paint.type === 'solid') return paint.color;
    if (paint.type === 'image') return paint.color || '#111827';
    if (paint.type === 'multi') {
      const colors = (Array.isArray(paint.colors) && paint.colors.length) ? paint.colors : [paint.color || '#111827'];
      if (!bgHex) return colors[0];
      let worstColor = colors[0];
      let minRatio = Infinity;
      colors.forEach(c => {
        const r = contrastRatio(c, bgHex);
        if (r < minRatio) {
          minRatio = r;
          worstColor = c;
        }
      });
      return worstColor;
    }
    const stops = [paint.from];
    if (paint.mid) stops.push(paint.mid);
    stops.push(paint.to);
    if (bgHex) {
      let worstColor = stops[0];
      let minRatio = Infinity;
      stops.forEach(c => {
        if (!c) return;
        const r = contrastRatio(c, bgHex);
        if (r < minRatio) {
          minRatio = r;
          worstColor = c;
        }
      });
      return worstColor;
    }
    if (paint.mid) return paint.mid;
    const a = hexToRgb(paint.from), b = hexToRgb(paint.to);
    if (!a || !b) return paint.from || paint.color;
    const mid = a.map((v, i) => Math.round((v + b[i]) / 2));
    return '#' + mid.map(v => v.toString(16).padStart(2, '0')).join('');
  }

  // ------------------------------------------------------------------
  // パス生成のプリミティブ
  // ------------------------------------------------------------------

  // 角ごとに「1=丸める / 0=直角」を指定できる矩形パス。
  // 角は時計回りに TL, TR, BR, BL の順。
  function boxPath(x0, y0, x1, y1, radii, kinds) {
    const r = radii;
    const k = kinds || [1, 1, 1, 1];
    const rr = [0, 1, 2, 3].map(i => (k[i] === 0 ? 0 : r[i]));
    const arc = (i, x, y) => {
      if (rr[i] === 0) return 'L' + n(x) + ' ' + n(y);
      return 'A' + n(rr[i]) + ' ' + n(rr[i]) + ' 0 0 1 ' + n(x) + ' ' + n(y);
    };
    let d = 'M' + n(x0 + rr[0]) + ' ' + n(y0);
    d += 'L' + n(x1 - rr[1]) + ' ' + n(y0);
    d += arc(1, x1, y0 + rr[1]);
    d += 'L' + n(x1) + ' ' + n(y1 - rr[2]);
    d += arc(2, x1 - rr[2], y1);
    d += 'L' + n(x0 + rr[3]) + ' ' + n(y1);
    d += arc(3, x0, y1 - rr[3]);
    d += 'L' + n(x0) + ' ' + n(y0 + rr[0]);
    d += arc(0, x0 + rr[0], y0);
    return d + 'Z';
  }

  // 隣とくっつく形のセルの輪郭。時計回りに一周しながら、角ごとに
  //   { r: 半径 }        … 外側の角。丸める
  //   { ch: 落とし幅 }   … 外側の角。45度で落とす
  //   { nx: 横, ny: 縦 } … 内側の角。隣の帯の内側の線まで欠き取る
  //   null               … 直角
  // を選ぶ。corners は [左上, 右上, 右下, 左下] の順。
  // 回り方と始点は boxPath と同じ（左上の角を出たところから時計回り）。
  function joinedBoxPath(x0, y0, x1, y1, corners) {
    const P = (px, py) => n(px) + ' ' + n(py);
    // 角ごとに「入ってくる辺が止まる点」「角の中の道」「出ていく辺が始まる点」。
    // どちらの辺から入ってどちらへ出るかは角の位置で決まる（左上なら左辺から
    // 入って上辺へ出る）ので、i の偶奇で縦横を振り分ける。
    const geom = i => {
      const k = corners[i] || {};
      const cx = (i === 0 || i === 3) ? x0 : x1;
      const cy = (i === 0 || i === 1) ? y0 : y1;
      const sx = (i === 0 || i === 3) ? 1 : -1;
      const sy = (i === 0 || i === 1) ? 1 : -1;
      const hx = k.nx !== undefined ? k.nx : (k.r || k.ch || 0);
      const vy = k.ny !== undefined ? k.ny : (k.r || k.ch || 0);
      const onV = [cx, cy + sy * vy];
      const onH = [cx + sx * hx, cy];
      const vFirst = (i % 2) === 0;
      const entry = vFirst ? onV : onH;
      const exit = vFirst ? onH : onV;
      let mid = '';
      if (k.r) mid = 'A' + n(k.r) + ' ' + n(k.r) + ' 0 0 1 ' + P(exit[0], exit[1]);
      else if (k.ch) mid = 'L' + P(exit[0], exit[1]);
      else if (k.nx !== undefined) mid = 'L' + P(cx + sx * hx, cy + sy * vy) + 'L' + P(exit[0], exit[1]);
      return { entry: entry, exit: exit, mid: mid };
    };
    const g = [geom(0), geom(1), geom(2), geom(3)];
    return 'M' + P(g[0].exit[0], g[0].exit[1]) +
      'L' + P(g[1].entry[0], g[1].entry[1]) + g[1].mid +
      'L' + P(g[2].entry[0], g[2].entry[1]) + g[2].mid +
      'L' + P(g[3].entry[0], g[3].entry[1]) + g[3].mid +
      'L' + P(g[0].entry[0], g[0].entry[1]) + g[0].mid + 'Z';
  }

  function rectPath(x, y, w, h, r) {
    const rad = Math.min(r || 0, w / 2, h / 2);
    return boxPath(x, y, x + w, y + h, [rad, rad, rad, rad], [1, 1, 1, 1]);
  }

  function circlePath(cx, cy, r) {
    return 'M' + n(cx - r) + ' ' + n(cy) +
      'a' + n(r) + ' ' + n(r) + ' 0 1 0 ' + n(r * 2) + ' 0' +
      'a' + n(r) + ' ' + n(r) + ' 0 1 0 ' + n(-r * 2) + ' 0Z';
  }

  // 塗りを足し合わせるための円。boxPath と回り方（時計回り）を揃えてある。
  // circlePath は逆回りなので、和をとると nonzero 規則で穴が空いてしまう。
  function circlePathCW(cx, cy, r) {
    return 'M' + n(cx - r) + ' ' + n(cy) +
      'a' + n(r) + ' ' + n(r) + ' 0 1 1 ' + n(r * 2) + ' 0' +
      'a' + n(r) + ' ' + n(r) + ' 0 1 1 ' + n(-r * 2) + ' 0Z';
  }

  function polyPath(pts) {
    return 'M' + pts.map(p => n(p[0]) + ' ' + n(p[1])).join('L') + 'Z';
  }

  function starPath(cx, cy, outer, inner, points, rotate) {
    const pts = [];
    const step = Math.PI / points;
    let ang = (rotate || -Math.PI / 2);
    for (let i = 0; i < points * 2; i++) {
      const r = i % 2 === 0 ? outer : inner;
      pts.push([cx + Math.cos(ang) * r, cy + Math.sin(ang) * r]);
      ang += step;
    }
    return polyPath(pts);
  }

  // ハート。単位正方形の上に置いた輪郭を、セルの大きさへ写して描く。
  // 先頭が始点、以降は3次ベジェの制御点2つと終点。
  const HEART = [
    [0.5, 1],
    [0.14, 0.72, 0, 0.5, 0, 0.33],
    [0, 0.14, 0.15, 0, 0.32, 0],
    [0.4, 0, 0.46, 0.04, 0.5, 0.1],
    [0.54, 0.04, 0.6, 0, 0.68, 0],
    [0.85, 0, 1, 0.14, 1, 0.33],
    [1, 0.5, 0.86, 0.72, 0.5, 1]
  ];
  function heartPath(cx, cy, r) {
    const X = v => n(cx + (v - 0.5) * 2 * r);
    const Y = v => n(cy + (v - 0.5) * 2 * r);
    let d = 'M' + X(HEART[0][0]) + ' ' + Y(HEART[0][1]);
    for (let i = 1; i < HEART.length; i++) {
      const c = HEART[i];
      d += 'C' + X(c[0]) + ' ' + Y(c[1]) + ' ' + X(c[2]) + ' ' + Y(c[3]) + ' ' + X(c[4]) + ' ' + Y(c[5]);
    }
    return d + 'Z';
  }

  // ばってん：太さ 2t の帯を2本、斜めに交差させた×印。先端は半円で丸い。
  // 半円は sweep=0 側でないと内側にえぐれてしまい、2本の重なりが nonzero で
  // 打ち消し合って穴が空く。
  function crossPath(cx, cy, r, t) {
    const k = Math.SQRT1_2;
    return [[k, k], [k, -k]].map(u => {
      const nx = -u[1] * t, ny = u[0] * t;
      const ax = cx - u[0] * r, ay = cy - u[1] * r;
      const bx = cx + u[0] * r, by = cy + u[1] * r;
      const arc = (x, y) => 'A' + n(t) + ' ' + n(t) + ' 0 0 0 ' + n(x) + ' ' + n(y);
      return 'M' + n(ax + nx) + ' ' + n(ay + ny) +
        'L' + n(bx + nx) + ' ' + n(by + ny) +
        arc(bx - nx, by - ny) +
        'L' + n(ax - nx) + ' ' + n(ay - ny) +
        arc(ax + nx, ay + ny) + 'Z';
    }).join('');
  }

  // 腕の長さ r、腕の太さ 2t の十字
  function plusPath(cx, cy, r, t) {
    return polyPath([
      [cx - t, cy - r], [cx + t, cy - r],
      [cx + t, cy - t], [cx + r, cy - t],
      [cx + r, cy + t], [cx + t, cy + t],
      [cx + t, cy + r], [cx - t, cy + r],
      [cx - t, cy + t], [cx - r, cy + t],
      [cx - r, cy - t], [cx - t, cy - t]
    ]);
  }

  // 上下が尖った正六角形
  function hexagonPath(cx, cy, r) {
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const ang = -Math.PI / 2 + (i * Math.PI) / 3;
      pts.push([cx + Math.cos(ang) * r, cy + Math.sin(ang) * r]);
    }
    return polyPath(pts);
  }

  // 四隅を斜めにカットした八角形（面取り幅 c）
  function octagonPath(x0, y0, s, c) {
    const x1 = x0 + s, y1 = y0 + s;
    return polyPath([
      [x0 + c, y0],
      [x1 - c, y0],
      [x1, y0 + c],
      [x1, y1 - c],
      [x1 - c, y1],
      [x0 + c, y1],
      [x0, y1 - c],
      [x0, y0 + c]
    ]);
  }

  // 5枚の花びらを持つフラワー
  function flowerPath(cx, cy, r) {
    const d = r * 0.28;
    const rad = r * 0.4;
    const pts = [];
    for (let i = 0; i < 5; i++) {
      const ang = -Math.PI / 2 - Math.PI / 5 + (i * 2 * Math.PI) / 5;
      pts.push([cx + Math.cos(ang) * d, cy + Math.sin(ang) * d]);
    }
    let res = 'M' + n(pts[0][0]) + ' ' + n(pts[0][1]);
    for (let i = 0; i < 5; i++) {
      const next = pts[(i + 1) % 5];
      res += 'A' + n(rad) + ' ' + n(rad) + ' 0 1 1 ' + n(next[0]) + ' ' + n(next[1]);
    }
    return res + 'Z';
  }

  // ------------------------------------------------------------------
  // データセルの描画
  // ------------------------------------------------------------------
  // 座標 (x, y) に基づく決定的な疑似乱数（0 <= r < 1）。
  // 再描画しても同じセルは同じサイズ・色を保ち、チラつきやズレを防ぐ。
  function cellRand(x, y, seed) {
    let h = (x * 374761393 + y * 668265263 + (seed || 0) * 1013904223) ^ 0x5bf03635;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  function cellScaleAt(x, y, baseScale, jitter) {
    const s0 = Math.max(0.3, Math.min(1.15, baseScale));
    if (!jitter) return s0;
    const r = cellRand(x, y, 0);
    const delta = (r - 0.5) * 2; // -1 ~ +1
    // jitter = 1 のとき最大 ±35% のサイズ変動
    const s = s0 * (1 + delta * jitter * 0.35);
    return Math.max(0.55, Math.min(1.15, s));
  }

  function singleCellPath(shape, x0, y0, s) {
    const x1 = x0 + s, y1 = y0 + s;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    switch (shape) {
      case 'square':   return rectPath(x0, y0, s, s, 0);
      case 'rounded':  return rectPath(x0, y0, s, s, s * 0.16);
      case 'xrounded': return rectPath(x0, y0, s, s, s * 0.34);
      case 'connected': return rectPath(x0, y0, s, s, s * 0.45);
      case 'liquid':   return circlePath(cx, cy, s * 0.48);
      case 'circuit':  return octagonPath(x0, y0, s, s * 0.22);
      case 'mosaic':   return polyPath([[cx, cy - s * 0.52], [cx + s * 0.52, cy], [cx, cy + s * 0.52], [cx - s * 0.52, cy]]);
      case 'dot':      return circlePath(cx, cy, s / 2);
      case 'diamond':  return polyPath([[cx, cy - s * 0.66], [cx + s * 0.66, cy], [cx, cy + s * 0.66], [cx - s * 0.66, cy]]);
      case 'star':     return starPath(cx, cy, s * 0.72, s * 0.44, 5);
      case 'heart':    return heartPath(cx, cy, s * 0.62);
      case 'plus':     return plusPath(cx, cy, s * 0.68, s * 0.3);
      case 'xmark':    return crossPath(cx, cy, s * 0.46, s * 0.2);
      case 'hexagon':  return hexagonPath(cx, cy, s * 0.58);
      case 'octagon':  return octagonPath(x0, y0, s, s * 0.28);
      case 'flower':   return flowerPath(cx, cy, s * 0.54);
      case 'classy':   return boxPath(x0, y0, x1, y1, [s / 2, 0, s / 2, 0], [1, 0, 1, 0]);
      case 'classy2':  return boxPath(x0, y0, x1, y1, [0, s / 2, s / 2, s / 2], [0, 1, 1, 1]);
      default:         return rectPath(x0, y0, s, s, s * 0.16);
    }
  }

  function cellsGroupedPath(grid, size, ox, oy, shape, scale, jitter, colors, seed) {
    const dark = (x, y) => x >= 0 && y >= 0 && x < size && y < size && grid[y * size + x] === 1;
    const jit = Math.max(0, Math.min(1, Number(jitter) || 0));

    // セルが隣まで伸びるぶんの引っ込み量。ジッタで太さが揃わないので隣の値で測る。
    const insAt = (ax, ay) => Math.max(0, (1 - cellScaleAt(ax, ay, scale, jit)) / 2);

    // 両隣が暗いのに斜めが明るい角。箱の角をそのまま出すと、隣の帯の内側の線
    // より外へ張り出して小さな突起になる（L字の内側に残る出っ張り）。
    // 隣の帯の内側の線まで欠き取ってやると、帯の太さが一定になる。
    const notchAt = (x, y, a, b, dx, dy) => (a && b && !dark(x + dx, y + dy))
      ? { nx: insAt(x, y + dy), ny: insAt(x + dx, y) } : null;
    const isMulti = Array.isArray(colors) && colors.length > 1;
    const colorBuckets = new Map();
    if (isMulti) {
      colors.forEach(c => { if (!colorBuckets.has(c)) colorBuckets.set(c, []); });
    }
    const singleParts = [];

    const pushP = (p, x, y) => {
      if (!p) return;
      if (isMulti) {
        const cIdx = Math.floor(cellRand(x, y, (seed || 0) + 17) * colors.length);
        colorBuckets.get(colors[cIdx]).push(p);
      } else {
        singleParts.push(p);
      }
    };

    if (shape === 'vbar' || shape === 'hbar') {
      const seen = new Uint8Array(size * size);
      for (let a = 0; a < size; a++) {
        for (let b = 0; b < size; b++) {
          const x = shape === 'vbar' ? a : b;
          const y = shape === 'vbar' ? b : a;
          if (!dark(x, y) || seen[y * size + x]) continue;
          let len = 0;
          while (true) {
            const nx = shape === 'vbar' ? x : x + len;
            const ny = shape === 'vbar' ? y + len : y;
            if (!dark(nx, ny)) break;
            seen[ny * size + nx] = 1;
            len++;
          }
          const t = Math.min(1, cellScaleAt(x, y, scale, jit));
          const inset = (1 - t) / 2;
          const w = shape === 'vbar' ? t : len;
          const h = shape === 'vbar' ? len : t;
          const px = ox + x + (shape === 'vbar' ? inset : 0);
          const py = oy + y + (shape === 'vbar' ? 0 : inset);
          pushP(rectPath(px, py, w, h, t / 2), x, y);
        }
      }
    } else if (shape === 'connected' || shape === 'liquid') {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (!dark(x, y)) continue;
          const top = dark(x, y - 1);
          const right = dark(x + 1, y);
          const bottom = dark(x, y + 1);
          const left = dark(x - 1, y);
          const s = cellScaleAt(x, y, scale, jit);

          // リキッドで孤立した1マスは完全な正円（水滴）
          if (shape === 'liquid' && !top && !right && !bottom && !left) {
            pushP(circlePath(ox + x + 0.5, oy + y + 0.5, s * 0.48), x, y);
            continue;
          }

          const inset = Math.max(0, (1 - s) / 2);
          const x0 = ox + x + (left ? 0 : inset);
          const y0 = oy + y + (top ? 0 : inset);
          const x1 = ox + x + 1 - (right ? 0 : inset);
          const y1 = oy + y + 1 - (bottom ? 0 : inset);
          const w = x1 - x0;
          const h = y1 - y0;
          const rBase = Math.min(w, h) * (shape === 'liquid' ? 0.5 : 0.45);
          // リキッドは同じ角に逆アールのフィレットを足して滑らかにつなぐので、
          // ここで欠き取らない（フィレットが覆う範囲と紙一重で、境に髪の毛ほどの
          // 隙間が出る）。連結は欠き取って帯の太さを揃える。
          const nt = (a, b, dx, dy) => (shape === 'liquid' ? null : notchAt(x, y, a, b, dx, dy));
          const cor = (outer, notch) => (outer ? { r: rBase } : notch);
          pushP(joinedBoxPath(x0, y0, x1, y1, [
            cor(!top && !left, nt(top, left, -1, -1)),
            cor(!top && !right, nt(top, right, 1, -1)),
            cor(!bottom && !right, nt(bottom, right, 1, 1)),
            cor(!bottom && !left, nt(bottom, left, -1, 1))
          ]), x, y);

          // リキッドは内角（くぼみ）にも逆アールフィレットを入れて完全一体化
          // セルの太さ（s）で細くしたときも、枝の外側エッジの真の交点（inset 考慮）から正確に円弧を開始し、
          // 隣接DARKセルの肉の内部深くまでアンカーを潜り込ませることで、どの太さでも白線・隙間を完全に根絶する。
          // 全パスは boxPath と同じ時計回り（CW）で統一。
          if (shape === 'liquid') {
            const rIn = Math.min(0.32, s * 0.38);
            const d = Math.min(0.35, s * 0.42); // セル本体の内部へ深く潜らせるアンカー深度
            const f = n => n.toFixed(3);
            if (top && left && !dark(x - 1, y - 1)) {
              const cx = ox + x + inset, cy = oy + y + inset;
              pushP(`M ${f(cx - rIn)} ${f(cy)} A ${f(rIn)} ${f(rIn)} 0 0 0 ${f(cx)} ${f(cy - rIn)} L ${f(cx + d)} ${f(cy - rIn)} L ${f(cx + d)} ${f(cy + d)} L ${f(cx - rIn)} ${f(cy + d)} Z`, x, y);
            }
            if (top && right && !dark(x + 1, y - 1)) {
              const cx = ox + x + 1 - inset, cy = oy + y + inset;
              pushP(`M ${f(cx)} ${f(cy - rIn)} A ${f(rIn)} ${f(rIn)} 0 0 0 ${f(cx + rIn)} ${f(cy)} L ${f(cx + rIn)} ${f(cy + d)} L ${f(cx - d)} ${f(cy + d)} L ${f(cx - d)} ${f(cy - rIn)} Z`, x, y);
            }
            if (bottom && right && !dark(x + 1, y + 1)) {
              const cx = ox + x + 1 - inset, cy = oy + y + 1 - inset;
              pushP(`M ${f(cx + rIn)} ${f(cy)} A ${f(rIn)} ${f(rIn)} 0 0 0 ${f(cx)} ${f(cy + rIn)} L ${f(cx - d)} ${f(cy + rIn)} L ${f(cx - d)} ${f(cy - d)} L ${f(cx + rIn)} ${f(cy - d)} Z`, x, y);
            }
            if (bottom && left && !dark(x - 1, y + 1)) {
              const cx = ox + x + inset, cy = oy + y + 1 - inset;
              pushP(`M ${f(cx)} ${f(cy + rIn)} A ${f(rIn)} ${f(rIn)} 0 0 0 ${f(cx - rIn)} ${f(cy)} L ${f(cx - rIn)} ${f(cy - d)} L ${f(cx + d)} ${f(cy - d)} L ${f(cx + d)} ${f(cy + rIn)} Z`, x, y);
            }
          }
        }
      }
    } else if (shape === 'circuit') {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (!dark(x, y)) continue;
          const top = dark(x, y - 1);
          const right = dark(x + 1, y);
          const bottom = dark(x, y + 1);
          const left = dark(x - 1, y);
          const s = cellScaleAt(x, y, scale, jit);

          const inset = Math.max(0, (1 - s) / 2);
          const x0 = ox + x + (left ? 0 : inset);
          const y0 = oy + y + (top ? 0 : inset);
          const x1 = ox + x + 1 - (right ? 0 : inset);
          const y1 = oy + y + 1 - (bottom ? 0 : inset);

          // 回路基板特有の45度斜め面取り配線（PCB Chamfer Trace）
          const ch = Math.min(x1 - x0, y1 - y0) * 0.22;
          const cor = (outer, notch) => (outer ? { ch: ch } : notch);
          pushP(joinedBoxPath(x0, y0, x1, y1, [
            cor(!top && !left, notchAt(x, y, top, left, -1, -1)),
            cor(!top && !right, notchAt(x, y, top, right, 1, -1)),
            cor(!bottom && !right, notchAt(x, y, bottom, right, 1, 1)),
            cor(!bottom && !left, notchAt(x, y, bottom, left, -1, 1))
          ]), x, y);
        }
      }
    } else if (shape === 'mosaic') {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (!dark(x, y)) continue;
          const s = cellScaleAt(x, y, scale, jit);
          const inset = (1 - s) / 2;
          const x0 = ox + x + inset, y0 = oy + y + inset;
          // メインセル
          pushP(rectPath(x0, y0, s, s, s * 0.22), x, y);

          // 対角（斜め）隣接セルとのマイクロ菱形ブリッジ
          const dBR = dark(x + 1, y + 1) && (!dark(x + 1, y) || !dark(x, y + 1));
          if (dBR) {
            const bx = ox + x + 1, by = oy + y + 1;
            const bw = 0.22;
            pushP(polyPath([[bx, by - bw], [bx + bw, by], [bx, by + bw], [bx - bw, by]]), x, y);
          }
          const dBL = dark(x - 1, y + 1) && (!dark(x - 1, y) || !dark(x, y + 1));
          if (dBL) {
            const bx = ox + x, by = oy + y + 1;
            const bw = 0.22;
            pushP(polyPath([[bx, by - bw], [bx + bw, by], [bx, by + bw], [bx - bw, by]]), x, y);
          }
        }
      }
    } else {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (!dark(x, y)) continue;
          const s = cellScaleAt(x, y, scale, jit);
          const inset = (1 - s) / 2;
          const x0 = ox + x + inset, y0 = oy + y + inset;
          const p = singleCellPath(shape, x0, y0, s);
          pushP(p, x, y);
        }
      }
    }

    if (isMulti) {
      // 重複を畳んだので、束は Map の並び（＝初出順）で1色1本ずつ出す
      return Array.from(colorBuckets, e => ({ color: e[0], d: e[1].join('') }));
    }
    return [{ color: null, d: singleParts.join('') }];
  }

  function cellsPath(grid, size, ox, oy, shape, scale, jitter) {
    const groups = cellsGroupedPath(grid, size, ox, oy, shape, scale, jitter, null, 0);
    return groups[0].d;
  }

  // パスの数値をまとめて u 倍する（原点まわりの相似拡大）。cellsGroupedPath は
  // 「1セル＝1」の座標系で組み立てるので、セルの大きさが 1 でない場所で使い回す
  // ときにこれを通す。呼ぶ側が原点も u で割った系で渡せば平行移動は要らず、
  // 相対コマンドもそのまま同じ倍率で効く。
  // 円弧の回転角と2つのフラグ（3〜5番目）は長さではないので、そのまま通す。
  function scalePath(d, u) {
    const tokens = String(d).match(/[A-Za-z]|[-+]?[0-9.]+(?:[eE][-+]?[0-9]+)?/g);
    if (!tokens) return '';
    let out = '', cmd = '', arg = 0;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.length === 1 && (t >= 'A' && t <= 'Z' || t >= 'a' && t <= 'z')) {
        cmd = t; arg = 0; out += t;
        continue;
      }
      const slot = (cmd === 'A' || cmd === 'a') ? arg % 7 : -1;
      const keep = slot >= 2 && slot <= 4;
      out += (arg ? ' ' : '') + (keep ? t : n(parseFloat(t) * u));
      arg++;
    }
    return out;
  }

  // ------------------------------------------------------------------
  // 位置検出パターン（マーカー）
  // ------------------------------------------------------------------
  // 枠の丸みは「読み取り機が1行ずつ走査したときに 1:1:3:1:1 が取れる範囲」で
  // 上限を決めてある。完全な円まで丸めると中心行しか条件を満たさなくなる。
  function frameShape(x, y, s, style) {
    const x1 = x + s, y1 = y + s;
    const r = k => [k, k, k, k];
    switch (style) {
      case 'square':   return boxPath(x, y, x1, y1, r(0), [0, 0, 0, 0]);
      case 'rounded':  return boxPath(x, y, x1, y1, r(s * 0.16), [1, 1, 1, 1]);
      case 'xrounded': return boxPath(x, y, x1, y1, r(s * 0.34), [1, 1, 1, 1]);
      case 'circle':   return boxPath(x, y, x1, y1, r(s * 0.42), [1, 1, 1, 1]);
      case 'octagon':  return octagonPath(x, y, s, s * 0.26);
      case 'leaf':     return boxPath(x, y, x1, y1, [s * 0.36, 0, s * 0.36, 0], [1, 0, 1, 0]);
      case 'cut':      return boxPath(x, y, x1, y1, [0, s * 0.34, s * 0.34, s * 0.34], [0, 1, 1, 1]);
      default:         return boxPath(x, y, x1, y1, r(s * 0.16), [1, 1, 1, 1]);
    }
  }

  // スカラップ（花型）の外周パス。マーカーの 7x7 を基準に、辺の長さ s へ伸縮する
  function scallopPath(x0, y0, s) {
    const u = s / 7;
    const p = (x, y) => n(x0 + x * u) + ' ' + n(y0 + y * u);
    const R = 2.8 * u;
    const arc = (x, y) => 'A' + n(R) + ' ' + n(R) + ' 0 0 1 ' + p(x, y);
    const cr = 1.0 * u;
    const corner = (x, y) => 'A' + n(cr) + ' ' + n(cr) + ' 0 0 1 ' + p(x, y);

    return 'M' + p(1, 0) +
      arc(3.5, 0) + arc(6, 0) + corner(7, 1) +
      arc(7, 3.5) + arc(7, 6) + corner(6, 7) +
      arc(3.5, 7) + arc(1, 7) + corner(0, 6) +
      arc(0, 3.5) + arc(0, 1) + corner(1, 0) + 'Z';
  }

  function scallopFramePath(fx, fy) {
    return scallopPath(fx, fy, 7);
  }

  // ------------------------------------------------------------------
  // 枠線
  // ------------------------------------------------------------------
  // 切手のミシン目。外周に半円の食い込みを等間隔で並べた矩形を、時計回りに一周描く。
  // 進行方向の右（＝内側）へ膨らませるので sweep は全辺 1。
  function scallopRectPath(x, y, w, h, bite) {
    // 切り上げておくと山の半径が bite を超えない＝外周からはみ出さない
    const nx = Math.max(2, Math.ceil(w / (bite * 2)));
    const ny = Math.max(2, Math.ceil(h / (bite * 2)));
    const sx = w / nx, sy = h / ny;
    const arc = (rr, px, py) => 'A' + n(rr) + ' ' + n(rr) + ' 0 0 1 ' + n(px) + ' ' + n(py);
    let d = 'M' + n(x) + ' ' + n(y);
    for (let i = 0; i < nx; i++) d += arc(sx / 2, x + (i + 1) * sx, y);
    for (let j = 0; j < ny; j++) d += arc(sy / 2, x + w, y + (j + 1) * sy);
    for (let i = nx - 1; i >= 0; i--) d += arc(sx / 2, x + i * sx, y + h);
    for (let j = ny - 1; j >= 0; j--) d += arc(sy / 2, x, y + j * sy);
    return d + 'Z';
  }

  // 吹き出し。角丸の本体の下辺から、しっぽが三角に飛び出す。
  // k を増やすと全体が内側に寄るので、地の形（k=0）と枠線（k=inset）を同じ式から作れる。
  function balloonPath(k, W, H, tail, r, tailCx, tailW) {
    const x0 = k, y0 = k, x1 = W - k;
    const y1 = H - tail - k;                 // 本体の下端
    const tipY = H - k * 1.8;                // しっぽの先
    const tw = Math.max(0.6, tailW - k * 1.4);
    const t1 = tailCx - tw / 2, t2 = tailCx + tw / 2;
    const rr = Math.max(0, Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2));
    const arc = (px, py) => 'A' + n(rr) + ' ' + n(rr) + ' 0 0 1 ' + n(px) + ' ' + n(py);
    return 'M' + n(x0 + rr) + ' ' + n(y0) +
      'H' + n(x1 - rr) + arc(x1, y0 + rr) +
      'V' + n(y1 - rr) + arc(x1 - rr, y1) +
      'H' + n(t2) +
      'L' + n(tailCx - tw * 0.25) + ' ' + n(tipY) +
      'L' + n(t1) + ' ' + n(y1) +
      'H' + n(x0 + rr) + arc(x0, y1 - rr) +
      'V' + n(y0 + rr) + arc(x0 + rr, y0) + 'Z';
  }

  // 枠線を「stroke で描くパス」「塗りで描くパス」「地を切り抜く形」に分けて返す。
  // 色の当て方（単色・グラデ・画像・多色）は呼び出し側でまとめて面倒を見るので、
  // ここは形だけを組み立てる。プレビューの小さい絵も同じ関数から作る。
  function frameLineParts(id, opts) {
    const o = opts || {};
    const W = o.W, H = o.H;
    const g = lineGeom(id, o.lw, o.lw2);
    const ls = g.ls, lw = g.lw, inset = g.inset;
    const tail = o.tail !== undefined ? o.tail : g.tail;
    const radius = o.radius || 0;
    const outerR = Math.max(0, radius - inset);
    const box = () => rectPath(inset, inset, W - inset * 2, H - inset * 2, outerR);
    const strokes = [];
    let fillD = '';
    let bgClipD = '';
    // 塗りが「外形から内側を抜いた帯」になる種類は evenodd で抜く
    let fillEvenOdd = false;

    if (g.key === 'cells') {
      // 外周に、QR本体と同じ形のセルをぐるっと一周並べる。太さ＝セルの大きさ。
      //
      // 並べ方は本体と同じ cellsGroupedPath に任せる。連結・リキッド・サーキット・
      // 縦横ラインは「隣に何があるか」で形が変わり、モザイクに至っては単独と
      // 連なりで形そのものが違う（ひし形／角丸四角）。ここで1マスずつ独立に
      // 描いていたので、本体だけが繋がって枠は粒のまま、という食い違いが出ていた。
      const u = lw;
      const cols = Math.max(3, Math.round((W - inset * 2) / u));
      const rows = Math.max(3, Math.round((H - inset * 2) / u));
      const x0 = (W - cols * u) / 2, y0 = (H - rows * u) / 2;
      // 本体のセルは 100% だと隣とくっついてベタ帯に見えるので、枠では少し痩せさせる
      const t = Math.max(0.35, Math.min(0.86, (Number(o.cellScale) || 1) * 0.82));
      // 外周だけを暗にした格子を作って渡す。cellsGroupedPath は正方の格子を
      // 前提にしているので、一辺は長いほうに合わせる（余りはすべて明のまま）。
      const N = Math.max(cols, rows);
      const ring = new Uint8Array(N * N);
      for (let i = 0; i < cols; i++) {
        ring[i] = 1;
        ring[(rows - 1) * N + i] = 1;
      }
      for (let j = 1; j < rows - 1; j++) {
        ring[j * N] = 1;
        ring[j * N + cols - 1] = 1;
      }
      // 「1セル＝1」で組んでから u 倍する。原点も u で割って渡しておけば、
      // 拡大だけで正しい位置に収まる。
      const ringD = cellsGroupedPath(ring, N, x0 / u, y0 / u, o.cell || 'rounded', t, 0, null, 0)[0].d;
      fillD = scalePath(ringD, u);
    } else if (g.key === 'stamp') {
      // ミシン目で縁取った札。地もこの形に切り抜くので、食い込みがそのまま外形になる
      const bite = stampBite(ls, lw);
      const outerD = scallopRectPath(inset, inset, W - inset * 2, H - inset * 2, bite);
      bgClipD = outerD;
      fillD = outerD + rectPath(inset + lw, inset + lw, W - (inset + lw) * 2, H - (inset + lw) * 2, Math.max(0, outerR));
      fillEvenOdd = true;
    } else if (g.key === 'balloon') {
      const tailCx = W * 0.32, tailW = Math.min(2.6, W * 0.16);
      bgClipD = balloonPath(0, W, H, tail, Math.max(1, radius), tailCx, tailW);
      strokes.push({
        d: balloonPath(inset, W, H, tail, Math.max(1, radius) - inset * 0.5, tailCx, tailW),
        w: lw
      });
    } else if (g.key === 'bracket') {
      // 四隅だけの L 字。カメラのファインダーのように「ここを読む」を示す
      const L = Math.max(lw * 3, Math.min(W, H) * 0.22);
      const r = Math.max(0.4, outerR);
      const x0 = inset, y0 = inset, x1 = W - inset, y1 = H - inset;
      const arc = 'A' + n(r) + ' ' + n(r) + ' 0 0 1 ';
      strokes.push({ d:
        'M' + n(x0) + ' ' + n(y0 + L) + 'V' + n(y0 + r) + arc + n(x0 + r) + ' ' + n(y0) + 'H' + n(x0 + L) +
        'M' + n(x1 - L) + ' ' + n(y0) + 'H' + n(x1 - r) + arc + n(x1) + ' ' + n(y0 + r) + 'V' + n(y0 + L) +
        'M' + n(x1) + ' ' + n(y1 - L) + 'V' + n(y1 - r) + arc + n(x1 - r) + ' ' + n(y1) + 'H' + n(x1 - L) +
        'M' + n(x0 + L) + ' ' + n(y1) + 'H' + n(x0 + r) + arc + n(x0) + ' ' + n(y1 - r) + 'V' + n(y1 - L),
        w: lw, cap: 'round' });
    } else if (g.key === 'double') {
      const gap = ls.gap;
      strokes.push({ d: box(), w: lw });
      strokes.push({
        d: rectPath(inset + gap, inset + gap, W - (inset + gap) * 2, H - (inset + gap) * 2, Math.max(0, outerR - gap)),
        w: g.lw2
      });
    } else if (g.key === 'dashed') {
      strokes.push({ d: box(), w: lw, dash: n(lw * 2.8) + ' ' + n(lw * 1.7) });
    } else if (g.key === 'ticket') {
      // 切り取り線＋左右の切り欠き。切り欠きは地をくり抜いて作る
      const cy = H / 2;
      const nr = ls.notch;
      bgClipD = rectPath(0, 0, W, H, radius) + circlePath(0, cy, nr) + circlePath(W, cy, nr);
      strokes.push({ d: box(), w: lw, dash: '0 ' + n(lw * 2.4), cap: 'round' });
      // くり抜いた縁をなぞる半円。地が透明でも切り欠きの形が分かる
      strokes.push({
        d: 'M0 ' + n(cy - nr) + 'A' + n(nr) + ' ' + n(nr) + ' 0 0 1 0 ' + n(cy + nr) +
           'M' + n(W) + ' ' + n(cy - nr) + 'A' + n(nr) + ' ' + n(nr) + ' 0 0 0 ' + n(W) + ' ' + n(cy + nr),
        w: lw * 0.8
      });
    } else {
      strokes.push({ d: box(), w: lw });
    }

    return { strokes: strokes, fillD: fillD, bgClipD: bgClipD, fillEvenOdd: fillEvenOdd };
  }

  function lineFillMarkup(parts, val) {
    if (!parts.fillD) return '';
    return '<path d="' + parts.fillD + '" fill="' + val + '"' +
      (parts.fillEvenOdd ? ' fill-rule="evenodd"' : '') + '/>';
  }

  // 既定（butt / miter）のときは属性を書かない。角丸0の実線で角が丸まってしまうのを避ける
  function lineStrokeMarkup(parts, val) {
    return parts.strokes.map(s =>
      '<path d="' + s.d + '" fill="none" stroke="' + val + '" stroke-width="' + n(s.w) + '"' +
      (s.dash ? ' stroke-dasharray="' + s.dash + '"' : '') +
      (s.cap ? ' stroke-linecap="' + s.cap + '"' : '') + '/>').join('');
  }

  // ------------------------------------------------------------------
  // ロゴの下地
  // ------------------------------------------------------------------
  // 形はマーカーの枠と同じ 9 種。ただし枠はリング（外形から内側を抜いたもの）
  // なので、下地では同じ輪郭を塗りつぶしで描く。角の丸みの比率は frameShape と
  // 揃えてあり、抜き（knockout）の判定もこの表から作る。
  const BACKDROP_CORNERS = {
    square:   [0, 0, 0, 0],
    rounded:  [0.16, 0.16, 0.16, 0.16],
    xrounded: [0.34, 0.34, 0.34, 0.34],
    circle:   [0.42, 0.42, 0.42, 0.42],
    leaf:     [0.36, 0, 0.36, 0],
    cut:      [0, 0.34, 0.34, 0.34],
    // ドット枠とフラワーは縁が波打つ。角の欠けは浅いので小さい丸みで近似する
    dots:     [0.06, 0.06, 0.06, 0.06],
    flower:   [0.14, 0.14, 0.14, 0.14]
  };
  const OCTAGON_CUT = 0.26;

  function backdropPath(cx, cy, side, style) {
    const half = side / 2;
    const x = cx - half, y = cy - half;
    if (style === 'octagon') return octagonPath(x, y, side, side * OCTAGON_CUT);
    if (style === 'flower') return scallopPath(x, y, side);
    if (style === 'dots') {
      // 縁に丸を並べた枠の塗り版。内側の四角と縁の丸の和で、ふちが波打つ札になる
      const u = side / 7;
      let d = rectPath(x + u * 0.5, y + u * 0.5, side - u, side - u, 0);
      for (let j = 0; j < 7; j++) {
        for (let i = 0; i < 7; i++) {
          if (i !== 0 && i !== 6 && j !== 0 && j !== 6) continue;
          d += circlePathCW(x + (i + 0.5) * u, y + (j + 0.5) * u, u * 0.58);
        }
      }
      return d;
    }
    const c = BACKDROP_CORNERS[style] || BACKDROP_CORNERS.rounded;
    return boxPath(x, y, x + side, y + side,
      c.map(k => k * side), c.map(k => (k > 0 ? 1 : 0)));
  }

  // 下地の内側かどうか。抜きが下地からはみ出すと、下地の外にセルを消した跡が
  // 地色のまま残ってしまうので、実際に描く形に合わせて判定する。
  function insideBackdrop(dx, dy, half, style) {
    const ax = Math.abs(dx), ay = Math.abs(dy);
    if (ax > half || ay > half) return false;
    if (style === 'octagon') return ax + ay <= 2 * half * (1 - OCTAGON_CUT);
    const c = BACKDROP_CORNERS[style] || BACKDROP_CORNERS.rounded;
    // boxPath と同じ [左上, 右上, 右下, 左下] の並びで、その象限の丸みを引く
    const idx = dy < 0 ? (dx < 0 ? 0 : 1) : (dx < 0 ? 3 : 2);
    const r = c[idx] * half * 2;
    if (r <= 0) return true;
    const inner = half - r;
    if (ax <= inner || ay <= inner) return true;
    return Math.hypot(ax - inner, ay - inner) <= r;
  }

  // ラベルの上下に「何を」「どの文字・画像で」出すか。位置の指定と、上側だけ
  // 別指定にできる仕組みが絡んで条件が込み入るので、ここでまとめて決める。
  // 描画（render）と、書き出し用のフォント集め（textRuns）の両方がこれを見る。
  // 片方だけ直すと、描いた文字と埋め込む字がずれても気づけない。
  function frameLabelParts(st) {
    const fr = st.frame || {};
    const isLabel = fr.type === 'label';
    const pos = fr.pos || 'bottom';
    // contentMode/topContentMode が今のキー。mode/topMode は旧データ。
    const bottomCMode = isLabel ? (fr.contentMode || fr.mode || 'text') : 'text';
    // 上下を出し分けないときは、上も下の指定をそのまま使う
    const topOwn = fr.topContentMode || fr.topMode;
    const topCMode = isLabel ? ((pos === 'both' || topOwn) ? (topOwn || 'text') : bottomCMode) : 'text';
    return {
      pos: pos,
      isLabel: isLabel,
      topCMode: topCMode,
      bottomCMode: bottomCMode,
      topText: pos === 'both' ? (fr.textTop || '') : (fr.textTop || fr.text || ''),
      bottomText: fr.text || '',
      topSrc: (pos === 'both' || fr.topSrc) ? (fr.topSrc || '') : (fr.src || ''),
      bottomSrc: fr.src || ''
    };
  }

  // 旧データ（backdropColor と backdrop:'none'）も受けられるようにして塗りを取り出す
  function backdropPaintOf(logo, fg) {
    let p = logo.backdropPaint;
    if (!p || !p.type) {
      p = logo.backdrop === 'none'
        ? { type: 'none' }
        : { type: 'solid', color: logo.backdropColor || '#FFFFFF', transparency: 0 };
    }
    return resolvePaint(p, fg);
  }

  // 外周リング（7x7 から 5x5 を抜く）
  //   opts … セル枠のときだけ見る { cell, cellScale }
  function markerFramePath(fx, fy, style, opts) {
    if (style === 'cells') {
      // 枠線の「セル枠」と同じ考え方で、外周7マスに本体と同じ形のセルを並べる。
      // 並べ方は cellsGroupedPath に任せるので、隣を見て形が変わる種類
      // （連結・リキッド・サーキット・モザイク）も本体と同じつながり方になる。
      const o = opts || {};
      const ring = new Uint8Array(49);
      for (let i = 0; i < 7; i++) { ring[i] = 1; ring[42 + i] = 1; }
      for (let j = 1; j < 6; j++) { ring[j * 7] = 1; ring[j * 7 + 6] = 1; }
      // ここは飾りである前に位置検出パターンなので、外周の枠線とは逆に、
      // 隣とわずかに重なるまで太らせる。粒の間に地色の隙間が空くと
      // 1:1:3:1:1 の走査が途切れ、読み取りが目に見えて落ちる（実測で
      // ドットのセルが 6解像度中 1 まで落ちた）。旧「ドット枠」も直径 1.16
      // モジュールの円を重ねて輪にしていたので、太さの狙いはそれに合わせる。
      const t = Math.max(0.35, Math.min(1.15, (Number(o.cellScale) || 1) * 1.15));
      return cellsGroupedPath(ring, 7, fx, fy, o.cell || 'rounded', t, 0, null, 0)[0].d;
    }
    if (style === 'dots') {
      const parts = [];
      for (let dy = 0; dy < 7; dy++) {
        for (let dx = 0; dx < 7; dx++) {
          if (dx !== 0 && dx !== 6 && dy !== 0 && dy !== 6) continue;
          parts.push(circlePath(fx + dx + 0.5, fy + dy + 0.5, 0.58));
        }
      }
      return parts.join('');
    }
    if (style === 'flower') {
      const outer = scallopFramePath(fx, fy);
      const hole = boxPath(fx + 1, fy + 1, fx + 6, fy + 6, [1.4, 1.4, 1.4, 1.4], [1, 1, 1, 1]);
      return outer + hole;
    }
    const outer = frameShape(fx, fy, 7, style);
    const hole = frameShape(fx + 1, fy + 1, 5, style);
    return outer + hole;
  }

  // 目の形も同じ理由で丸めすぎない。完全な円（半径1.5）にすると走査で
  // 中心行しか拾えなくなるため、1.2 を上限にしている。面積が痩せる
  // ひし形や四つ葉は、位置検出パターンが壊れるので採用していない。
  const EYE_R = 1.2;

  function markerEyePath(fx, fy, style) {
    const x = fx + 2, y = fy + 2, s = 3;
    const x1 = x + s, y1 = y + s;
    const cx = x + s / 2, cy = y + s / 2;
    switch (style) {
      case 'square':   return boxPath(x, y, x1, y1, [0, 0, 0, 0], [0, 0, 0, 0]);
      case 'rounded':  return boxPath(x, y, x1, y1, [s * 0.16, s * 0.16, s * 0.16, s * 0.16], [1, 1, 1, 1]);
      case 'xrounded': return boxPath(x, y, x1, y1, [s * 0.34, s * 0.34, s * 0.34, s * 0.34], [1, 1, 1, 1]);
      case 'circle':   return boxPath(x, y, x1, y1, [EYE_R, EYE_R, EYE_R, EYE_R], [1, 1, 1, 1]);
      case 'hexagon':  return hexagonPath(cx, cy, 1.6);
      case 'octagon':  return octagonPath(x, y, s, 0.78);
      case 'flower':   return flowerPath(cx, cy, 1.55);
      case 'leaf':     return boxPath(x, y, x1, y1, [EYE_R, 0, EYE_R, 0], [1, 0, 1, 0]);
      case 'cut':      return boxPath(x, y, x1, y1, [0, s * 0.45, s * 0.45, s * 0.45], [0, 1, 1, 1]);
      case 'diamond':  return polyPath([[cx, cy - 1.65], [cx + 1.65, cy], [cx, cy + 1.65], [cx - 1.65, cy]]);
      case 'star':     return starPath(cx, cy, 1.7, 1.05, 5);
      case 'heart':    return heartPath(cx, cy, 1.45);
      case 'plus':     return plusPath(cx, cy, 1.5, 0.72);
      case 'xmark':    return crossPath(cx, cy, 1.2, 0.75);
      case 'vbar':     return [0, 1, 2].map(i => rectPath(x + i + 0.1, y, 0.8, s, 0.4)).join('');
      case 'hbar':     return [0, 1, 2].map(i => rectPath(x, y + i + 0.1, s, 0.8, 0.4)).join('');
      default:         return boxPath(x, y, x1, y1, [s * 0.16, s * 0.16, s * 0.16, s * 0.16], [1, 1, 1, 1]);
    }
  }

  // ------------------------------------------------------------------
  // 塗り（単色 / グラデーション）
  // ------------------------------------------------------------------
  function gradientStops(paint) {
    let s = '<stop offset="0" stop-color="' + esc(paint.from) + '"/>';
    if (paint.mid) {
      s += '<stop offset="0.5" stop-color="' + esc(paint.mid) + '"/>';
    }
    s += '<stop offset="1" stop-color="' + esc(paint.to) + '"/>';
    return s;
  }

  function multiGradientStops(colors) {
    if (!Array.isArray(colors) || colors.length === 0) {
      return '<stop offset="0" stop-color="#2563EB"/><stop offset="1" stop-color="#DB2777"/>';
    }
    if (colors.length === 1) {
      return '<stop offset="0" stop-color="' + esc(colors[0]) + '"/><stop offset="1" stop-color="' + esc(colors[0]) + '"/>';
    }
    return colors.map((c, i) => {
      const offset = (i / (colors.length - 1)).toFixed(3);
      return '<stop offset="' + offset + '" stop-color="' + esc(c) + '"/>';
    }).join('');
  }

  // 画像の塗りの倍率。1 で面いっぱい、大きくすると寄って（切り取られて）、
  // 小さくするとタイルのように繰り返す
  function imgScaleOf(paint) {
    const s = Number(paint && paint.imgScale);
    return Number.isFinite(s) && s > 0 ? Math.min(IMG_SCALE_MAX, Math.max(IMG_SCALE_MIN, s)) : 1;
  }

  function paintDef(paint, id, box) {
    if (!paint || paint.type === 'solid' || paint.type === 'none') return '';
    if (paint.type === 'image') {
      if (!paint.src) return '';
      // パターンの升目そのものを拡大縮小する。升目が面より大きければ中央を
      // 切り取った「寄り」に、小さければ同じ絵が並ぶ
      const k = imgScaleOf(paint);
      const pw = box.w * k, ph = box.h * k;
      const px = box.x + (box.w - pw) / 2, py = box.y + (box.h - ph) / 2;
      return '<pattern id="' + id + '" patternUnits="userSpaceOnUse" x="' + n(px) +
        '" y="' + n(py) + '" width="' + n(pw) + '" height="' + n(ph) + '">' +
        '<image href="' + esc(paint.src) + '" x="0" y="0" width="' + n(pw) +
        '" height="' + n(ph) + '" preserveAspectRatio="xMidYMid slice"/>' +
        '</pattern>';
    }
    const isMulti = paint.type === 'multi';
    const a = ((paint.angle || 0) * Math.PI) / 180;
    const stops = isMulti ? multiGradientStops(paint.colors) : gradientStops(paint);
    if (paint.type === 'radial') {
      const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
      const r = Math.sqrt(box.w * box.w + box.h * box.h) / 2;
      return '<radialGradient id="' + id + '" gradientUnits="userSpaceOnUse" cx="' + n(cx) +
        '" cy="' + n(cy) + '" r="' + n(r) + '">' + stops + '</radialGradient>';
    }
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    const half = Math.max(box.w, box.h) / 2;
    const dx = Math.cos(a) * half, dy = Math.sin(a) * half;
    return '<linearGradient id="' + id + '" gradientUnits="userSpaceOnUse" x1="' + n(cx - dx) +
      '" y1="' + n(cy - dy) + '" x2="' + n(cx + dx) + '" y2="' + n(cy + dy) + '">' +
      stops + '</linearGradient>';
  }

  function paintRef(paint, id, fallbackColor) {
    if (!paint || paint.type === 'none') return 'none';
    if (paint.type === 'white') return '#FFFFFF';
    if (paint.type === 'black') return '#000000';
    if (paint.type === 'solid') return esc(paint.color || fallbackColor || '#111827');
    if (paint.type === 'image') return paint.src ? 'url(#' + id + ')' : esc(paint.color || fallbackColor || '#111827');
    return 'url(#' + id + ')';
  }

  // 多色をマーカーに配る。面は3隅×（枠・目）の6つしかないので、色を順ぐりに
  // 当てると規則がそのまま見えてしまい、しかも枠と目に同じ番号が回るので
  // 「枠と目がどの隅でも必ず同じ色」になってしまう。セルと同じ決定的な乱数で
  // 選び、枠と目には別の種を与えて、同じ色になる隅もあれば違う隅もある形にする。
  const MARKER_PART_SEED = { frame: 13, eye: 71 };

  function pickMarkerColor(colors, seed, cornerIdx, part) {
    const r = cellRand(cornerIdx, MARKER_PART_SEED[part] || 13, (seed || 0) + 41);
    return colors[Math.floor(r * colors.length)];
  }

  function getMarkerFill(paint, fg, id, fgRef, cornerIdx, part) {
    if (!paint || paint.type === 'auto' || paint.type === 'none') {
      if (fg.type === 'multi') {
        const colors = (Array.isArray(fg.colors) && fg.colors.length) ? fg.colors : ['#111827'];
        return esc(pickMarkerColor(colors, fg.seed, cornerIdx, part));
      }
      return fgRef;
    }
    if (paint.type === 'solid') {
      return esc(paint.color || '#111827');
    }
    if (paint.type === 'multi') {
      const colors = (Array.isArray(paint.colors) && paint.colors.length) ? paint.colors : ['#111827'];
      return esc(pickMarkerColor(colors, paint.seed, cornerIdx, part));
    }
    if (paint.type === 'image') {
      return paint.src ? 'url(#' + id + ')' : esc(paint.color || '#111827');
    }
    if (paint.type === 'linear' || paint.type === 'radial') {
      return 'url(#' + id + ')';
    }
    return fgRef;
  }

  // 面をタイルに割って色を振る「多色」の下地。開始位置と刻みをそろえれば
  // 背景・セル・ロゴで同じ模様がつながる。はみ出た分は呼び出し側でクリップする。
  function mosaicTiles(box, colors, seed, tileSize, origin, seedShift) {
    const cols = (Array.isArray(colors) && colors.length) ? colors : ['#2563EB', '#7C3AED'];
    const gx = origin ? origin.x : box.x;
    const gy = origin ? origin.y : box.y;
    const i0 = Math.floor((box.x - gx) / tileSize);
    const j0 = Math.floor((box.y - gy) / tileSize);
    const i1 = Math.ceil((box.x + box.w - gx) / tileSize);
    const j1 = Math.ceil((box.y + box.h - gy) / tileSize);
    // タイルの継ぎ目に地色の線が出ないよう、わずかに重ねる
    const ov = Math.min(0.05, tileSize * 0.06);
    const buckets = new Map();
    cols.forEach(c => { if (!buckets.has(c)) buckets.set(c, []); });
    for (let j = j0; j < j1; j++) {
      for (let i = i0; i < i1; i++) {
        const c = cols[Math.floor(cellRand(i, j, (seed || 0) + (seedShift || 0)) * cols.length)];
        buckets.get(c).push(rectPath(gx + i * tileSize, gy + j * tileSize, tileSize + ov, tileSize + ov, 0));
      }
    }
    let out = '';
    buckets.forEach((paths, c) => {
      if (paths.length) out += '<path d="' + paths.join('') + '" fill="' + esc(c) + '"/>';
    });
    return out;
  }

  // ------------------------------------------------------------------
  // ロゴ
  // ------------------------------------------------------------------

  // ロゴの「面で塗る」系（多色・グラデーション・放射・画像）はここで描く。
  // アイコンは translate/scale をかけた <g> の中に置くので、そこで url(#…) を
  // 参照すると勾配もパターンもアイコン内部の座標に引きずられ、
  // グラデーションは単色に潰れ、画像は細かく繰り返してしまう。
  // 形はクリップに逃がして、塗り自体はセルと同じ外側の座標系に置く。
  //   shape … クリップに入れる図形（変換込み）
  //   box   … 塗りを敷く矩形（＝ロゴの外接箱）
  function paintedShape(paint, box, id, shape, opts) {
    const type = paint.type;
    let defs = '<clipPath id="' + id + 'c">' + shape + '</clipPath>';
    let fill = '';
    if (type === 'image') {
      if (!paint.src) return null;
      // 倍率つきの升目をそのまま使いたいので、直に <image> を置かずパターン越しに塗る
      defs += paintDef(paint, id, box);
      fill = '<path d="' + rectPath(box.x, box.y, box.w, box.h, 0) + '" fill="url(#' + id + ')"/>';
    } else if (type === 'multi') {
      const o = opts || {};
      const tile = o.tile || Math.max(0.2, box.w / 6);
      fill = mosaicTiles(box, paint.colors, paint.seed, tile, o.origin, o.seedShift || 103);
    } else if (type === 'linear' || type === 'radial') {
      defs += paintDef(paint, id, box);
      fill = '<path d="' + rectPath(box.x, box.y, box.w, box.h, 0) + '" fill="url(#' + id + ')"/>';
    } else {
      return null;
    }
    return { defs: defs, body: '<g clip-path="url(#' + id + 'c)">' + fill + '</g>' };
  }

  // 戻り値は { defs, body }。塗りの定義が要る描き方があるので本体と一緒に返す。
  function logoSvg(logo, cx, cy, side, uid, fg, fgRef, qrBox) {
    const empty = { defs: '', body: '' };
    if (!logo || logo.type === 'none') return empty;
    const half = side / 2;
    const x = cx - half, y = cy - half;
    let box = { x: x, y: y, w: side, h: side };
    const pid = (uid || 'logo_') + 'lo';
    // セルと同じ模様をロゴにも通すための、モジュール格子の基準点
    const cellOpts = qrBox ? { tile: 1, origin: { x: qrBox.x, y: qrBox.y }, seedShift: 17 } : null;
    let defs = '';
    let out = '';

    if (logo.type === 'icon' && logo.iconData) {
      const icon = logo.iconData;
      const vb = String(icon.vb || '0 0 24 24').split(/\s+/).map(Number);
      const vw = vb[2] || 24, vh = vb[3] || 24;
      const k = side / Math.max(vw, vh);
      const tx = cx - (vw * k) / 2 - vb[0] * k;
      const ty = cy - (vh * k) / 2 - vb[1] * k;
      const lp = (logo && logo.paint) ? logo.paint : { type: 'brand', color: logo.color || '#111827' };
      const mode = lp.type || 'brand';
      const tf = 'translate(' + n(tx) + ' ' + n(ty) + ') scale(' + n(k) + ')';

      // 一色で塗るだけの描き方
      const flat = color => {
        let s = '<g transform="' + tf + '" fill="' + color + '">';
        icon.p.forEach(p => {
          s += '<path d="' + p.d + '"' + (p.e ? ' fill-rule="evenodd"' : '') + '/>';
        });
        return s + '</g>';
      };
      // アイコンの形そのもの（クリップ用）
      const clipShape = () => {
        let s = '';
        icon.p.forEach(p => {
          s += '<path d="' + p.d + '" transform="' + tf + '"' + (p.e ? ' clip-rule="evenodd"' : '') + '/>';
        });
        return s;
      };

      if (mode === 'brand') {
        if (icon.rawSvg) {
          const raw = icon.rawSvg.replace(/__UID__/g, (uid || 'logo_') + '_');
          out += '<g transform="' + tf + '">' + raw + '</g>';
        } else {
          const bColor = (global.QRAssets && global.QRAssets.BRAND_COLORS && global.QRAssets.BRAND_COLORS[icon.id]) || lp.color || logo.color || '#111827';
          out += flat(esc(bColor));
        }
      } else if (mode === 'solid') {
        out += flat(esc(lp.color || logo.color || '#111827'));
      } else if (mode === 'auto') {
        // セルの塗りをそのまま延長する。単色以外はセル側の定義を参照するので、
        // ロゴの上でも模様がつながって見える。
        const fgMode = fg ? fg.type : 'solid';
        if (fgMode === 'solid') {
          out += flat(esc(fg.color || '#111827'));
        } else if (fgMode === 'multi') {
          const layer = paintedShape(fg, box, pid, clipShape(), cellOpts);
          if (layer) { defs += layer.defs; out += layer.body; }
          else out += flat(fgRef || '#111827');
        } else {
          defs += '<clipPath id="' + pid + 'c">' + clipShape() + '</clipPath>';
          out += '<g clip-path="url(#' + pid + 'c)"><path d="' +
            rectPath(box.x, box.y, box.w, box.h, 0) + '" fill="' + (fgRef || '#111827') + '"/></g>';
        }
      } else {
        const layer = paintedShape(lp, box, pid, clipShape(), null);
        if (layer) { defs += layer.defs; out += layer.body; }
        else out += flat(esc(lp.color || logo.color || '#111827'));
      }
    } else if (logo.type === 'image' && logo.src) {
      out += '<image href="' + esc(logo.src) + '" x="' + n(x) + '" y="' + n(y) + '" width="' +
        n(side) + '" height="' + n(side) + '" preserveAspectRatio="xMidYMid meet"/>';
    } else if (logo.type === 'text' && logo.text) {
      const fs = side * (logo.text.length > 2 ? 0.5 : 0.78);
      // textPaint が今のキー。旧データはアイコンと同じ paint を共有していた。
      const lp = (logo && (logo.textPaint || logo.paint)) || { type: 'solid', color: logo.color || '#111827' };
      const mode = lp.type || 'solid';
      const fontFamily = fontOf(logo.font).stack;

      // 塗りを敷く箱は文字の広がりに合わせる。正方形のままだと、横に長い
      // 文字列で画像がタイル状に繰り返され、勾配も途中で頭打ちになる。
      // 全角は約1em、半角は約0.6em として字送りを見積もる。
      let units = 0;
      for (let i = 0; i < logo.text.length; i++) {
        units += logo.text.charCodeAt(i) > 0x2E80 ? 1 : 0.6;
      }
      const tw = Math.max(side, fs * units);
      const th = Math.max(side, fs * 1.15);
      box = { x: cx - tw / 2, y: cy - th / 2, w: tw, h: th };

      const textEl = fill => '<text x="' + n(cx) + '" y="' + n(cy) + '" font-size="' + n(fs) +
        '" font-weight="' + FONT_WEIGHT + '"' + (fill ? ' fill="' + fill + '"' : '') +
        ' text-anchor="middle" dominant-baseline="central" ' +
        'font-family="' + esc(fontFamily) + '">' + esc(logo.text) + '</text>';

      // 「セルの色」はセル側の塗りをそのまま使う
      const paint = mode === 'auto' ? (fg || { type: 'solid', color: '#111827' }) : lp;
      const pType = paint.type || 'solid';

      if (pType === 'multi') {
        // 文字も面で塗る。アイコンの多色と同じブロック模様になる
        const layer = paintedShape(paint, box, pid, textEl(null), mode === 'auto' ? cellOpts : null);
        if (layer) { defs += layer.defs; out += layer.body; }
        else out += textEl(esc((paint.colors && paint.colors[0]) || '#111827'));
      } else if (pType === 'linear' || pType === 'radial' || (pType === 'image' && paint.src)) {
        // 文字には変換がかからないので、外側の座標系の定義をそのまま参照できる
        if (mode === 'auto') {
          out += textEl(fgRef || '#111827');
        } else {
          defs += paintDef(paint, pid, box);
          out += textEl('url(#' + pid + ')');
        }
      } else {
        out += textEl(esc(paint.color || logo.color || '#111827'));
      }
    }
    return { defs: defs, body: out };
  }

  // ------------------------------------------------------------------
  // 本体
  // ------------------------------------------------------------------
  function render(qr, styleIn) {
    const st = merge(DEFAULTS, styleIn || {});
    const size = qr.size;
    const margin = Math.max(0, Math.min(10, Math.round(st.margin)));
    const inner = size + margin * 2;
    const radius = Math.max(0, Math.min(st.radius, maxRadius(margin)));
    const fm = FRAME_METRICS[st.frame.type] || FRAME_METRICS.none;
    const isLine = st.frame.type === 'line';
    // 枠線の余白は、種類と太さから毎回計算する（太くしても QR に食い込まないように）
    const lineId = isLine ? lineIdOf(st.frame.line) : 'solid';
    const lineG = lineGeom(lineId, st.frame.lineWidth, st.frame.lineWidth2);
    const pad = isLine ? lineG.pad : fm.pad;
    // 吹き出しのしっぽは下にはみ出すぶんだけ縦を伸ばす
    const tailH = isLine ? lineG.tail : 0;
    const isLabel = st.frame.type === 'label';
    const L = frameLabelParts(st);
    const pos = L.pos;
    const topCMode = L.topCMode;
    const bottomCMode = L.bottomCMode;
    const topText = L.topText;
    const bottomText = L.bottomText;
    const topSrc = L.topSrc;
    const bottomSrc = L.bottomSrc;

    const hasTop = isLabel && (pos === 'top' || pos === 'both');
    const hasBottom = isLabel && (pos === 'bottom' || pos === 'both');

    const hasTopContent = topCMode === 'icon'
      ? true
      : (topCMode === 'image' ? !!topSrc : !!String(topText).trim());
    const hasBottomContent = bottomCMode === 'icon'
      ? true
      : (bottomCMode === 'image' ? !!bottomSrc : !!String(bottomText).trim());

    // ラベルの中身の大きさと、その周りの余白（中身の大きさに対する比）。
    // 既定の 1.0 / 0.2 なら 4.0 + 0.8*2 = 5.6 で、FRAME_METRICS.label と同じ帯になる。
    const fcSizeRaw = Number(st.frame.contentSize);
    const fcSize = isFinite(fcSizeRaw) ? Math.max(0.5, Math.min(1.6, fcSizeRaw)) : 1;
    const fcPadRaw = Number(st.frame.contentPad);
    const fcPadR = isFinite(fcPadRaw) ? Math.max(0, Math.min(0.6, fcPadRaw)) : 0.2;
    const contentSide = 4 * fcSize;
    const contentPadU = contentSide * fcPadR;

    const labelH = isLabel && fm.label ? contentSide + contentPadU * 2 : 0;
    const topH = hasTop && hasTopContent ? labelH : 0;
    const bottomH = hasBottom && hasBottomContent ? labelH : 0;

    const W = inner + pad * 2;
    const H = inner + pad * 2 + topH + bottomH + tailH;
    const bx = pad, by = pad + topH;               // QRブロック（余白込み）の左上
    const ox = pad + margin, oy = pad + topH + margin; // モジュール(0,0)の左上

    // ---- どのモジュールを「データセル」として描くか -------------------
    const isFinder = (x, y) =>
      (x < 7 && y < 7) || (x >= size - 7 && y < 7) || (x < 7 && y >= size - 7);

    const grid = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!isFinder(x, y) && qr.at(x, y)) grid[y * size + x] = 1;
      }
    }

    // ---- ロゴの抜き（ノックアウト） -----------------------------------
    const logo = st.logo;
    const hasLogo = logo.type !== 'none' &&
      (logo.type === 'icon' ? !!logo.iconData : logo.type === 'image' ? !!logo.src : !!logo.text);
    const cx = ox + size / 2, cy = oy + size / 2;
    const logoSide = Math.max(0.06, Math.min(0.34, logo.size)) * size;
    const knockSide = logoSide * (1 + Math.max(0, Math.min(0.5, logo.pad)) * 2);
    let knocked = 0;

    // 下地の形。'none' は旧データの「下地なし」なので、抜きの形だけ角丸で代用する
    const bdStyle = (logo.backdrop && logo.backdrop !== 'none') ? logo.backdrop : 'rounded';

    // ロゴが覆うモジュールは、セルを消すかどうかに関わらず数える。knocked は
    // 「誤り訂正でどれだけ取り返す必要があるか」の見積もりで、抜かずに上から
    // 重ねても隠れる量は変わらない。ここを knockout の中に入れていたので、
    // 抜きを切ったときだけ面積の警告まで黙っていた。
    if (hasLogo) {
      const half = knockSide / 2;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const mx = ox + x + 0.5, my = oy + y + 0.5;
          if (!insideBackdrop(mx - cx, my - cy, half, bdStyle)) continue;
          knocked++;
          if (logo.knockout && !isFinder(x, y)) grid[y * size + x] = 0;
        }
      }
    }

    // ---- 塗りの定義 ---------------------------------------------------
    const qrBox = { x: ox, y: oy, w: size, h: size };
    const uid = 'qs' + Math.random().toString(36).slice(2, 8);
    let defs = '';
    defs += paintDef(st.fg, uid + 'f', qrBox);
    const fgRef = paintRef(st.fg, uid + 'f', '#111827');

    const bgBox = st.frame.type === 'label' ? { x: bx, y: by, w: inner, h: inner } : { x: 0, y: 0, w: W, h: H };
    const bgPaint = resolvePaint(st.bg, st.fg);

    if (bgPaint.type === 'linear' || bgPaint.type === 'radial' || bgPaint.type === 'image') {
      defs += paintDef(bgPaint, uid + 'b', bgBox);
    }
    const bgRef = paintRef(bgPaint, uid + 'b', '#FFFFFF');
    // 透明度が指定されていない塗りは「不透明」とみなす。
    // （透明にしたいときは type:'none' か transparency を明示する）
    const bgTransparency = bgPaint.transparency !== undefined ? Number(bgPaint.transparency) : 0;
    const bgOpacity = bgPaint.type === 'none' ? 0 : Math.max(0, Math.min(1, (100 - bgTransparency) / 100));

    function buildBgMosaic(box, r, colors, seed, opac, shapeD) {
      const clipId = uid + 'bgc';
      defs += '<clipPath id="' + clipId + '"><path d="' +
        (shapeD || rectPath(box.x, box.y, box.w, box.h, r)) + '" clip-rule="evenodd"/></clipPath>';
      const tileSize = Math.max(1.8, Math.min(2.6, box.w / 18));
      return '<g clip-path="url(#' + clipId + ')"' + (opac < 1 ? ' opacity="' + n(opac) + '"' : '') + '>' +
        mosaicTiles(box, colors, seed, tileSize, null, 103) + '</g>';
    }

    const mfPaint = st.markerFramePaint || (st.markerFrameColor ? { type: 'solid', color: st.markerFrameColor } : { type: 'auto' });
    const mePaint = st.markerEyePaint || (st.markerEyeColor ? { type: 'solid', color: st.markerEyeColor } : { type: 'auto' });

    if (mfPaint && (mfPaint.type === 'linear' || mfPaint.type === 'radial' || mfPaint.type === 'image')) {
      defs += paintDef(mfPaint, uid + 'mf', qrBox);
    }
    if (mePaint && (mePaint.type === 'linear' || mePaint.type === 'radial' || mePaint.type === 'image')) {
      defs += paintDef(mePaint, uid + 'me', qrBox);
    }

    // ---- 組み立て -----------------------------------------------------
    let body = '';

    // 外枠の地
    if (st.frame.type === 'label') {
      const fr = st.frame.radius;
      const flPaint = (st.frame && st.frame.paint) ? st.frame.paint : (st.frame && st.frame.color ? { type: 'solid', color: st.frame.color } : { type: 'auto' });
      const labelD = rectPath(0, 0, W, H, fr);
      const isFlAuto = flPaint.type === 'auto';
      if (isFlAuto && (st.fg.type === 'linear' || st.fg.type === 'radial' || st.fg.type === 'image')) {
        defs += '<clipPath id="' + uid + 'flc"><path d="' + labelD + '"/></clipPath>';
        body += '<g clip-path="url(#' + uid + 'flc)"><path d="' +
          rectPath(0, 0, W, H, 0) + '" fill="' + (fgRef || '#111827') + '"/></g>';
      } else {
        const cellOpts = isFlAuto ? { tile: 1, origin: { x: qrBox.x, y: qrBox.y }, seedShift: 17 } : null;
        const actualPaint = isFlAuto ? st.fg : flPaint;
        const layer = paintedShape(actualPaint, { x: 0, y: 0, w: W, h: H }, uid + 'fl', '<path d="' + labelD + '"/>', cellOpts);
        if (layer) {
          defs += layer.defs;
          body += layer.body;
        } else {
          const c = isFlAuto ? (st.fg.color || '#111827') : (flPaint.color || st.frame.color || '#111827');
          body += '<path d="' + labelD + '" fill="' + esc(c) + '"/>';
        }
      }
      // QRブロックの下地
      if (bgPaint.type !== 'none' && bgOpacity > 0) {
        if (bgPaint.type === 'multi') {
          body += buildBgMosaic({ x: bx, y: by, w: inner, h: inner }, radius, bgPaint.colors, bgPaint.seed, bgOpacity);
        } else {
          body += '<path d="' + rectPath(bx, by, inner, inner, radius) + '" fill="' + bgRef +
            '"' + (bgOpacity < 1 ? ' fill-opacity="' + n(bgOpacity) + '"' : '') + '/>';
        }
      }
    } else {
      // 切り取り線・切手・吹き出しは、地も枠の形に合わせて切り抜く
      const lineParts = st.frame.type === 'line'
        ? frameLineParts(lineId, {
            W: W, H: H, radius: radius, cell: st.cell, cellScale: st.cellScale,
            lw: st.frame.lineWidth, lw2: st.frame.lineWidth2
          })
        : { strokes: [], fillD: '', bgClipD: '' };
      const bgShapeD = lineParts.bgClipD || '';

      if (bgPaint.type !== 'none' && bgOpacity > 0) {
        if (bgPaint.type === 'multi') {
          body += buildBgMosaic({ x: 0, y: 0, w: W, h: H }, radius, bgPaint.colors, bgPaint.seed, bgOpacity, bgShapeD);
        } else if (bgShapeD) {
          // 塗るのは矩形のまま。形はクリップ側で決める（evenodd を直塗りすると、
          // 札の外へはみ出した切り欠きが逆に塗られてしまう）
          const cutId = uid + 'cut';
          defs += '<clipPath id="' + cutId + '"><path d="' + bgShapeD + '" clip-rule="evenodd"/></clipPath>';
          body += '<g clip-path="url(#' + cutId + ')"><path d="' + rectPath(0, 0, W, H, 0) +
            '" fill="' + bgRef + '"' + (bgOpacity < 1 ? ' fill-opacity="' + n(bgOpacity) + '"' : '') + '/></g>';
        } else {
          body += '<path d="' + rectPath(0, 0, W, H, radius) + '" fill="' + bgRef +
            '"' + (bgOpacity < 1 ? ' fill-opacity="' + n(bgOpacity) + '"' : '') + '/>';
        }
      }
      if (st.frame.type === 'line') {
        const flPaint = (st.frame && st.frame.paint) ? st.frame.paint : (st.frame && st.frame.color ? { type: 'solid', color: st.frame.color } : { type: 'auto' });
        const frameBox = { x: 0, y: 0, w: W, h: H };
        const isFlAuto = flPaint.type === 'auto';
        const isMultiMode = (isFlAuto && st.fg.type === 'multi') || (!isFlAuto && flPaint.type === 'multi');

        if (isMultiMode) {
          const multiColors = isFlAuto ? st.fg.colors : flPaint.colors;
          const multiSeed = isFlAuto ? st.fg.seed : flPaint.seed;
          const multiOrigin = isFlAuto ? { x: qrBox.x, y: qrBox.y } : null;
          const tileSize = Math.max(1.8, Math.min(2.6, W / 18));
          const maskId = uid + 'flm';
          defs += '<mask id="' + maskId + '" maskUnits="userSpaceOnUse" x="0" y="0" width="' + n(W) + '" height="' + n(H) + '">' +
            lineStrokeMarkup(lineParts, '#FFFFFF') +
            lineFillMarkup(lineParts, '#FFFFFF') +
            '</mask>';
          body += '<g mask="url(#' + maskId + ')">' +
            mosaicTiles(frameBox, multiColors, multiSeed, tileSize, multiOrigin, 103) +
            '</g>';
        } else {
          // 単色は色そのもの、グラデ・画像は url(#...)。どちらも stroke にも fill にも使える
          let strokeVal = '';
          if (isFlAuto) {
            if (st.fg.type === 'linear' || st.fg.type === 'radial' || st.fg.type === 'image') {
              strokeVal = fgRef || '#111827';
            } else {
              strokeVal = esc(st.fg.color || '#111827');
            }
          } else if (flPaint.type === 'solid') {
            strokeVal = esc(flPaint.color || st.frame.color || '#111827');
          } else if (flPaint.type === 'linear' || flPaint.type === 'radial' || flPaint.type === 'image') {
            defs += paintDef(flPaint, uid + 'fl', frameBox);
            strokeVal = paintRef(flPaint, uid + 'fl', '#111827');
          } else {
            strokeVal = esc(flPaint.color || st.frame.color || '#111827');
          }
          body += lineStrokeMarkup(lineParts, strokeVal);
          body += lineFillMarkup(lineParts, strokeVal);
        }
      }
    }

    // データセル
    const cellGroups = cellsGroupedPath(
      grid, size, ox, oy, st.cell, st.cellScale, st.cellJitter,
      st.fg.type === 'multi' ? st.fg.colors : null, st.fg.seed
    );
    cellGroups.forEach(g => {
      if (g.d) {
        body += '<path d="' + g.d + '" fill="' + (g.color ? esc(g.color) : fgRef) + '"/>';
      }
    });

    // マーカー3つ
    const corners = [[0, 0], [size - 7, 0], [0, size - 7]];
    corners.forEach((c, idx) => {
      const fx = ox + c[0], fy = oy + c[1];
      const frameFill = getMarkerFill(mfPaint, st.fg, uid + 'mf', fgRef, idx, 'frame');
      const eyeFill = getMarkerFill(mePaint, st.fg, uid + 'me', fgRef, idx, 'eye');
      // セル枠は粒を並べるだけで穴を抜かない。evenodd だと重なりが白く抜ける
      const mfEvenOdd = st.markerFrame === 'cells' ? '' : ' fill-rule="evenodd"';
      body += '<path d="' + markerFramePath(fx, fy, st.markerFrame, { cell: st.cell, cellScale: st.cellScale }) +
        '" fill="' + frameFill + '"' + mfEvenOdd + '/>';
      body += '<path d="' + markerEyePath(fx, fy, st.markerEye) + '" fill="' + eyeFill + '"/>';
    });

    // ロゴ
    if (hasLogo) {
      const bdPaint = backdropPaintOf(logo, st.fg);
      if (bdPaint.type !== 'none') {
        const d = backdropPath(cx, cy, knockSide, bdStyle);
        const half = knockSide / 2;
        const bdBox = { x: cx - half, y: cy - half, w: knockSide, h: knockSide };
        const bdTr = bdPaint.transparency !== undefined ? Number(bdPaint.transparency) : 0;
        const bdOp = Math.max(0, Math.min(1, (100 - bdTr) / 100));
        const op = bdOp < 1 ? ' opacity="' + n(bdOp) + '"' : '';
        const isBdAuto = !!(logo.backdropPaint && logo.backdropPaint.type === 'auto');
        if (bdPaint.type === 'solid') {
          body += '<path d="' + d + '" fill="' + esc(bdPaint.color || '#FFFFFF') + '"' +
            (bdOp < 1 ? ' fill-opacity="' + n(bdOp) + '"' : '') + '/>';
        } else if (isBdAuto && bdPaint.type !== 'multi') {
          // 「セルの色」のグラデーション・放射・画像は、セル側の定義をそのまま引く。
          // 下地の箱で定義し直すと、勾配も画像も下地の中だけで完結してしまい、
          // セルと切れた別の模様になる。形で切り抜くだけにして一続きにする。
          defs += '<clipPath id="' + uid + 'bdc"><path d="' + d + '"/></clipPath>';
          body += '<g clip-path="url(#' + uid + 'bdc)"' + op + '><path d="' +
            rectPath(bdBox.x, bdBox.y, bdBox.w, bdBox.h, 0) + '" fill="' + (fgRef || '#111827') + '"/></g>';
        } else {
          // 多色はセルと同じモジュール格子・同じ種で振ると目地がそろう
          const cellOpts = isBdAuto
            ? { tile: 1, origin: { x: qrBox.x, y: qrBox.y }, seedShift: 17 } : null;
          const layer = paintedShape(bdPaint, bdBox, uid + 'bd', '<path d="' + d + '"/>', cellOpts);
          if (layer) {
            defs += layer.defs;
            body += op ? '<g' + op + '>' + layer.body + '</g>' : layer.body;
          } else {
            body += '<path d="' + d + '" fill="' + esc(bdPaint.color || '#FFFFFF') + '"/>';
          }
        }
      }
      const lo = logoSvg(logo, cx, cy, logoSide, uid, st.fg, fgRef, qrBox);
      defs += lo.defs;
      body += lo.body;
    }

    // 外枠のコンテンツ（文字・アイコン・画像）
    if (topH || bottomH) {
      const fontFamily = fontOf(st.frame.font).stack;

      const tp = (st.frame && st.frame.textPaint) ? st.frame.textPaint : (st.frame && st.frame.textColor ? { type: 'solid', color: st.frame.textColor } : { type: 'solid', color: '#FFFFFF' });
      const tMode = tp.type || 'solid';
      const tPaint = tMode === 'auto' ? (st.fg || { type: 'solid', color: '#111827' }) : tp;
      const tPtype = tPaint.type || 'solid';

      // 下地を先に敷くために、文字の寸法だけを取り出せるようにしておく
      function frameTextMetrics(textStr) {
        const text = String(textStr || '');
        const avail = W - 3;
        let units = 0;
        for (let i = 0; i < text.length; i++) {
          units += text.charCodeAt(i) > 0x2E80 ? 1 : 0.56;
        }
        const cap = contentSide * 0.85;
        const fs = Math.max(contentSide * 0.4, Math.min(cap, units ? avail / units : cap));
        return { fs: fs, units: units, tw: Math.max(fs * 2, fs * units) };
      }

      function renderFrameText(textStr, ty, idSuffix) {
        if (!textStr) return;
        const text = String(textStr);
        const m = frameTextMetrics(text);
        const fs = m.fs;
        const tw = m.tw;
        const th = Math.max(fs * 1.5, labelH);
        const textBox = { x: W / 2 - tw / 2, y: ty - th / 2, w: tw, h: th };
        const tPid = uid + 'ft' + idSuffix;

        const textEl = fill => '<text x="' + n(W / 2) + '" y="' + n(ty) + '" font-size="' + n(fs) +
          '" font-weight="' + FONT_WEIGHT + '"' + (fill ? ' fill="' + fill + '"' : '') +
          ' text-anchor="middle" dominant-baseline="central" letter-spacing="' + n(fs * 0.02) +
          '" font-family="' + esc(fontFamily) + '">' + esc(text) + '</text>';

        if (tPtype === 'multi') {
          const cellOpts = tMode === 'auto' ? { tile: 1, origin: { x: qrBox.x, y: qrBox.y }, seedShift: 17 } : null;
          const layer = paintedShape(tPaint, textBox, tPid, textEl(null), cellOpts);
          if (layer) { defs += layer.defs; body += layer.body; }
          else body += textEl(esc((tPaint.colors && tPaint.colors[0]) || '#FFFFFF'));
        } else if (tPtype === 'linear' || tPtype === 'radial' || (tPtype === 'image' && tPaint.src)) {
          if (tMode === 'auto') {
            body += textEl(fgRef || '#111827');
          } else {
            defs += paintDef(tPaint, tPid, textBox);
            body += textEl('url(#' + tPid + ')');
          }
        } else {
          body += textEl(esc(tPaint.color || st.frame.textColor || '#FFFFFF'));
        }
      }

      function renderFrameIcon(iconId, cx, cy, idSuffix, iconDataOpt, iconPaintOpt) {
        const icons = (global.QRAssets && global.QRAssets.ICONS) || [];
        const icon = iconDataOpt || icons.find(i => i.id === iconId) || icons[0];
        if (!icon) return;
        const side = contentSide;
        const vb = String(icon.vb || '0 0 24 24').split(/\s+/).map(Number);
        const vw = vb[2] || 24, vh = vb[3] || 24;
        const k = side / Math.max(vw, vh);
        const tx = cx - (vw * k) / 2 - (vb[0] || 0) * k;
        const ty = cy - (vh * k) / 2 - (vb[1] || 0) * k;
        const tf = 'translate(' + n(tx) + ' ' + n(ty) + ') scale(' + n(k) + ')';
        const pid = uid + 'fi' + idSuffix;
        const box = { x: cx - side / 2, y: cy - side / 2, w: side, h: side };

        const ip = iconPaintOpt || (st.frame && st.frame.iconPaint) ||
          { type: (st.frame && st.frame.iconColorMode) || 'brand', color: (st.frame && st.frame.iconColor) || '#FFFFFF' };
        const iconMode = ip.type || 'brand';
        const iconCol = ip.color || (st.frame && st.frame.iconColor) || '#FFFFFF';

        const flat = color => {
          let s = '<g transform="' + tf + '" fill="' + color + '">';
          icon.p.forEach(p => {
            s += '<path d="' + p.d + '"' + (p.e ? ' fill-rule="evenodd"' : '') + '/>';
          });
          return s + '</g>';
        };
        // アイコンの形そのもの（クリップ用）。ロゴと同じで、塗りは変換の外に置く
        const clipShape = () => {
          let s = '';
          icon.p.forEach(p => {
            s += '<path d="' + p.d + '" transform="' + tf + '"' + (p.e ? ' clip-rule="evenodd"' : '') + '/>';
          });
          return s;
        };

        if (iconMode === 'brand') {
          if (icon.rawSvg) {
            const raw = icon.rawSvg.replace(/__UID__/g, pid + '_');
            body += '<g transform="' + tf + '">' + raw + '</g>';
          } else {
            const bColor = (global.QRAssets && global.QRAssets.BRAND_COLORS && global.QRAssets.BRAND_COLORS[icon.id]) || iconCol;
            body += flat(esc(bColor));
          }
        } else if (iconMode === 'solid') {
          body += flat(esc(iconCol));
        } else if (iconMode === 'auto') {
          // セルの塗りをそのまま延長する。多色だけは面で塗らないと粒が出ない
          const fgMode = st.fg ? st.fg.type : 'solid';
          if (fgMode === 'solid') {
            body += flat(esc(st.fg.color || '#111827'));
          } else if (fgMode === 'multi') {
            const cellOpts = { tile: 1, origin: { x: qrBox.x, y: qrBox.y }, seedShift: 17 };
            const layer = paintedShape(st.fg, box, pid, clipShape(), cellOpts);
            if (layer) { defs += layer.defs; body += layer.body; }
            else body += flat(fgRef || '#111827');
          } else {
            body += flat(fgRef || '#111827');
          }
        } else {
          const layer = paintedShape(ip, box, pid, clipShape(), null);
          if (layer) { defs += layer.defs; body += layer.body; }
          else body += flat(esc(iconCol));
        }
      }

      function renderFrameImage(src, cx, cy) {
        if (!src) return;
        const maxH = contentSide * 1.05;
        const maxW = W - pad * 2;
        const imgX = cx - maxW / 2;
        const imgY = cy - maxH / 2;
        body += '<image href="' + esc(src) + '" x="' + n(imgX) + '" y="' + n(imgY) + '" width="' +
          n(maxW) + '" height="' + n(maxH) + '" preserveAspectRatio="xMidYMid meet"/>';
      }

      // 中身がどれだけの箱を占めるか。下地の大きさをこれに合わせる。
      // 画像は縦横比が分からない（読み込まずに文字列だけで組み立てている）ので、
      // アイコンと同じ正方形の板を敷く。
      function frameContentBox(isTop) {
        const cMode = isTop ? topCMode : bottomCMode;
        if (cMode === 'icon') return { w: contentSide, h: contentSide };
        if (cMode === 'image') {
          return (isTop ? topSrc : bottomSrc) ? { w: contentSide, h: contentSide } : null;
        }
        const txt = isTop ? topText : bottomText;
        if (!String(txt).trim()) return null;
        // 文字幅は「全角1・半角0.56」の見積もりなので、大文字の並びだと少し足りない。
        // 板が字に食い込まないよう、両側に半文字ぶんだけ足しておく。
        const m = frameTextMetrics(txt);
        return { w: m.tw + m.fs * 0.5, h: contentSide };
      }

      // 中身の後ろに敷く板。正方形の下地を描いてから横に伸ばすので、
      // 文字のように横長のときは角の丸みも一緒に伸びて帯になる。
      function renderFrameBackdrop(cy, idSuffix, isTop) {
        const bdPaint = backdropPaintOf(st.frame, st.fg);
        if (!bdPaint || bdPaint.type === 'none') return;
        const box = frameContentBox(isTop);
        if (!box || box.w <= 0 || box.h <= 0) return;

        const bh = box.h + contentPadU;
        const bw = Math.min(W, box.w + contentPadU);
        const style = (st.frame.backdrop && st.frame.backdrop !== 'none') ? st.frame.backdrop : 'rounded';
        const d = backdropPath(0, 0, bh, style);
        const sx = bh > 0 ? bw / bh : 1;
        const tf = 'translate(' + n(W / 2) + ' ' + n(cy) + ') scale(' + n(sx) + ' 1)';
        const shape = '<g transform="' + tf + '"><path d="' + d + '"/></g>';
        const bdBox = { x: W / 2 - bw / 2, y: cy - bh / 2, w: bw, h: bh };
        const pid = uid + 'fbd' + idSuffix;

        const bdTr = bdPaint.transparency !== undefined ? Number(bdPaint.transparency) : 0;
        const bdOp = Math.max(0, Math.min(1, (100 - bdTr) / 100));
        const op = bdOp < 1 ? ' opacity="' + n(bdOp) + '"' : '';
        const isBdAuto = !!(st.frame.backdropPaint && st.frame.backdropPaint.type === 'auto');

        if (bdPaint.type === 'solid') {
          body += '<g transform="' + tf + '" fill="' + esc(bdPaint.color || '#FFFFFF') + '"' +
            (bdOp < 1 ? ' fill-opacity="' + n(bdOp) + '"' : '') + '><path d="' + d + '"/></g>';
        } else if (isBdAuto && bdPaint.type !== 'multi') {
          // 「セルの色」はセル側の定義をそのまま引く。板の中だけで勾配や画像を
          // 組み直すと、セルと切れた別の模様になってしまう。
          defs += '<clipPath id="' + pid + 'c">' + shape + '</clipPath>';
          body += '<g clip-path="url(#' + pid + 'c)"' + op + '><path d="' +
            rectPath(bdBox.x, bdBox.y, bdBox.w, bdBox.h, 0) + '" fill="' + (fgRef || '#111827') + '"/></g>';
        } else {
          const cellOpts = isBdAuto
            ? { tile: 1, origin: { x: qrBox.x, y: qrBox.y }, seedShift: 17 } : null;
          const layer = paintedShape(bdPaint, bdBox, pid, shape, cellOpts);
          if (layer) {
            defs += layer.defs;
            body += op ? '<g' + op + '>' + layer.body + '</g>' : layer.body;
          } else {
            body += '<g transform="' + tf + '" fill="' + esc(bdPaint.color || '#FFFFFF') +
              '"><path d="' + d + '"/></g>';
          }
        }
      }

      function renderContent(cy, idSuffix, isTop) {
        const cMode = isTop ? topCMode : bottomCMode;

        renderFrameBackdrop(cy, idSuffix, isTop);

        if (cMode === 'icon') {
          const iconId = isTop
            ? ((pos === 'both' || st.frame.topIcon) ? (st.frame.topIcon || 'si-instagram') : (st.frame.icon || 'si-instagram'))
            : (st.frame.icon || 'si-instagram');
          const iconData = isTop
            ? ((pos === 'both' || st.frame.topIconData) ? st.frame.topIconData : st.frame.iconData)
            : st.frame.iconData;
          // アイコンの色は上下で分けられない（指定する場所がひとつしかない）。
          // iconPaint が今のキーで、topIconColorMode/iconColorMode は旧データ。
          const iconPaint = st.frame.iconPaint || {
            type: (isTop ? st.frame.topIconColorMode : st.frame.iconColorMode) || 'brand',
            color: (isTop ? st.frame.topIconColor : st.frame.iconColor) || '#FFFFFF'
          };
          renderFrameIcon(iconId, W / 2, cy, idSuffix, iconData, iconPaint);
        } else if (cMode === 'image') {
          const src = isTop ? topSrc : bottomSrc;
          renderFrameImage(src, W / 2, cy);
        } else {
          const txt = isTop ? topText : bottomText;
          renderFrameText(txt, cy, idSuffix);
        }
      }

      if (topH) {
        renderContent(pad + labelH / 2, 't', true);
      }
      if (bottomH) {
        renderContent(pad + topH + inner + labelH / 2, 'b', false);
      }
    }

    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n(W) + ' ' + n(H) +
      '" width="' + n(W) + '" height="' + n(H) + '" shape-rendering="geometricPrecision">' +
      (defs ? '<defs>' + defs + '</defs>' : '') + body + '</svg>';

    // ---- 読み取りへの注意 ---------------------------------------------
    const warnings = [];
    // 判定には、白・黒・「セルの色」を解決したあとの bgPaint を使う。
    // st.bg をそのまま渡すと type:'auto' が素通りしてグラデーションの
    // 既定色を返し、実際は地とセルが同色でもコントラスト良好と出てしまう。
    // 透過スライダーで抜いたぶんは白い紙が透ける。不透明な色のまま比べると、
    // 「背景＝セルの色・透過100%」のように実際には何も描かれない配色でも
    // セルと同色と判定してしまい、出るはずのないコントラスト警告が必ず出る。
    const bgC = bgOpacity <= 0 ? '#FFFFFF' : overWhite(paintColor(bgPaint), bgOpacity);
    const fgC = paintColor(st.fg, bgC);
    const ratio = fgC && bgC ? contrastRatio(fgC, bgC) : 21;
    // 表示する数値は WCAG 比のまま（見慣れているのはこちら）。ただし警告を
    // 出すかどうかは lumaRatio で決める。判定と、見せる数字とを分けている。
    const lr = fgC && bgC ? lumaRatio(fgC, bgC) : 0;
    const pct = Math.round(lr * 100);
    if (lr >= LUMA_WALL) {
      warnings.push({ kind: 'contrast', level: 'error', text: 'セルと背景の明暗差が足りません（暗いほうの明るさが明るいほうの ' + pct + '%）。50% を超えるとデコーダが白黒に分けられず、まず読み取れません。' });
    } else if (lr >= LUMA_TIGHT) {
      warnings.push({ kind: 'contrast', level: 'warn', text: 'セルと背景の明暗差に余裕がありません（' + pct + '%、限界は 50%）。装飾のにじみや印刷で崩れると読めなくなることがあります。' });
    }
    // マーカーだけ別色にしたときの見落としが一番多い。
    // 'auto'（セルの色に追従）はセル側の判定で見ているので、ここでは外す。
    [[mfPaint, 'マーカーの枠'], [mePaint, 'マーカーの目']].forEach(pair => {
      if (!bgC) return;
      // 'auto'（セルの色に追従）と 'none' は paintColor が null を返す。
      // 前者はセル側の判定で見ているので、ここで重ねて言わない。
      const mc = paintColor(pair[0], bgC);
      if (!mc) return;
      const r = lumaRatio(mc, bgC);
      if (r >= LUMA_WALL) {
        warnings.push({ level: 'error', text: pair[1] + 'の色が背景に近すぎます（明るさの比 ' + Math.round(r * 100) + '%）。位置検出パターンが見えないと読み取れません。' });
      } else if (r >= LUMA_TIGHT) {
        warnings.push({ level: 'warn', text: pair[1] + 'の色が背景に近めです（' + Math.round(r * 100) + '%、限界は 50%）。' });
      }
    });
    if (fgC && bgC && luminance(fgC) > luminance(bgC)) {
      warnings.push(st.invertOk
        ? { level: 'info', text: '暗い地に明るいセルを置いた「反転QR」です。意図した配色ですが、対応していない読み取りアプリもあるので実機で確かめてください。' }
        : { level: 'warn', text: '背景よりセルのほうが明るい「反転QR」です。読み取れないアプリがあります。' });
    }
    const coverage = knocked / (size * size);
    // 各レベルが取り返せるコード語の割合（規格の公称値）。ロゴで隠せる量の目安。
    const budget = ({ L: 0.07, M: 0.15, Q: 0.25, H: 0.30 })[qr.ec] || 0.15;
    if (hasLogo && coverage > budget * 0.85) {
      warnings.push({ level: 'error', text: 'ロゴが大きすぎます（' + Math.round(coverage * 100) + '%）。小さくするか誤り訂正レベルを上げてください。' });
    } else if (hasLogo && coverage > budget * 0.55) {
      warnings.push({ level: 'warn', text: 'ロゴの面積が誤り訂正の余力に近づいています（' + Math.round(coverage * 100) + '%）。' });
    }
    if (margin < 2) {
      warnings.push({ level: 'warn', text: '余白（クワイエットゾーン）が狭いと読み取り精度が落ちます。4以上を推奨。' });
    }
    if (st.fg.type === 'image' && st.fg.src) {
      warnings.push({ level: 'info', text: '画像セルは絵柄や明暗によって読み取りにくくなる場合があります。実機で確認してください。' });
    }
    if (st.bg.type === 'image' && st.bg.src) {
      warnings.push({ level: 'info', text: '背景画像は絵柄や明暗によって読み取りにくくなる場合があります。実機で確認してください。' });
    }
    if (mfPaint && mfPaint.type === 'image' && mfPaint.src) {
      warnings.push({ level: 'info', text: 'マーカー枠の画像は絵柄によって読み取りにくくなる場合があります。実機で確認してください。' });
    }
    if (mePaint && mePaint.type === 'image' && mePaint.src) {
      warnings.push({ level: 'info', text: 'マーカー目の画像は絵柄によって読み取りにくくなる場合があります。実機で確認してください。' });
    }

    return {
      svg: svg,
      width: W,
      height: H,
      contrast: ratio,
      lumaRatio: lr,
      coverage: coverage,
      warnings: warnings
    };
  }

  // ------------------------------------------------------------------
  // 書き出し用のフォント埋め込み
  // ------------------------------------------------------------------
  // このスタイルで実際に描かれる文字を、書体ごとにまとめて返す。
  // 書き出し前にこのぶんだけフォントを取り寄せて SVG に埋めれば、画面と
  // 同じ書体で書き出せる。impact のようにローカルで足りる書体は web が空。
  function textRuns(styleIn) {
    const st = merge(DEFAULTS, styleIn || {});
    const byFont = new Map();
    const add = (fontKey, text) => {
      const t = String(text || '');
      if (!t.trim()) return;
      const web = fontOf(fontKey).web;
      if (!web) return;
      byFont.set(web, (byFont.get(web) || '') + t);
    };

    if (st.logo.type === 'text') add(st.logo.font, st.logo.text);

    const L = frameLabelParts(st);
    if (L.isLabel) {
      if ((L.pos === 'bottom' || L.pos === 'both') && L.bottomCMode === 'text') {
        add(st.frame.font, L.bottomText);
      }
      if ((L.pos === 'top' || L.pos === 'both') && L.topCMode === 'text') {
        add(st.frame.font, L.topText);
      }
    }

    // 要るのは字の種類だけ。並べ替えて畳めば、同じ字を使い回した文言は
    // 同じ取り寄せになる（呼び出し側のキャッシュがそのまま効く）。
    return Array.from(byFont, e => ({
      web: e[0],
      weight: FONT_WEIGHT,
      text: Array.from(new Set(e[1])).sort().join('')
    }));
  }

  // @font-face を SVG の中に入れる。<defs> があればその先頭へ、無ければ作る。
  function embedFontCss(svg, css) {
    if (!css) return svg;
    const style = '<style>' + css + '</style>';
    if (svg.indexOf('<defs>') >= 0) return svg.replace('<defs>', '<defs>' + style);
    return svg.replace(/(<svg\b[^>]*>)/, '$1<defs>' + style + '</defs>');
  }

  // 指定ピクセル幅で書き出すために width/height だけ差し替える
  function resize(svg, px) {
    const m = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
    if (!m) return svg;
    const w = parseFloat(m[1]), h = parseFloat(m[2]);
    const height = Math.round((px * h) / w);
    return svg.replace(/(<svg\b[^>]*?)\bwidth="[^"]*"\s+height="[^"]*"/, '$1width="' + px + '" height="' + height + '"');
  }

  // ------------------------------------------------------------------
  // UIのボタン用の小さなプレビュー
  // ------------------------------------------------------------------
  function cellPreview(shape) {
    // 3x3 の市松に近い並びで形の特徴を見せる
    const size = 3;
    const grid = new Uint8Array(9);
    [0, 1, 3, 4, 5, 7, 8].forEach(i => { grid[i] = 1; });
    const d = cellsPath(grid, size, 0, 0, shape, 1);
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-0.2 -0.2 3.4 3.4"><path d="' + d +
      '" fill="currentColor"/></svg>';
  }

  function markerPreview(frameStyle, eyeStyle, opts) {
    const eo = frameStyle === 'cells' ? '' : ' fill-rule="evenodd"';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-0.3 -0.3 7.6 7.6">' +
      '<path d="' + markerFramePath(0, 0, frameStyle, opts) + '" fill="currentColor"' + eo + '/>' +
      '<path d="' + markerEyePath(0, 0, eyeStyle) + '" fill="currentColor"/></svg>';
  }

  // ロゴの下地の形を選ぶグリッド用。中央にロゴの当たりを重ねて向きが分かるようにする
  function backdropPreview(style) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-0.3 -0.3 7.6 7.6">' +
      '<path d="' + backdropPath(3.5, 3.5, 7, style) + '" fill="currentColor" opacity="0.32"/>' +
      '<circle cx="3.5" cy="3.5" r="1.6" fill="currentColor"/></svg>';
  }

  // 枠線の種類の見本。本番と同じ frameLineParts から作るので、
  // 一覧の絵と実際の出力がずれない。
  function linePreview(id) {
    const B = 8;
    // しっぽは見本の中に収まるよう短くする
    const tail = lineStyleOf(id).tail ? 1.5 : 0;
    const parts = frameLineParts(id, {
      W: B, H: B + tail, radius: 1.6, cell: 'rounded', cellScale: 0.92, tail: tail
    });
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-0.3 -0.3 ' + n(B + 0.6) + ' ' + n(B + tail + 0.6) + '">' +
      lineStrokeMarkup(parts, 'currentColor') +
      lineFillMarkup(parts, 'currentColor') +
      '</svg>';
  }

  function eyePreview(eyeStyle) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="1.7 1.7 3.6 3.6">' +
      '<path d="' + markerEyePath(0, 0, eyeStyle) + '" fill="currentColor"/></svg>';
  }

  global.QRStyle = {
    DEFAULTS: DEFAULTS,
    render: render,
    resize: resize,
    merge: merge,
    cellPreview: cellPreview,
    markerPreview: markerPreview,
    eyePreview: eyePreview,
    backdropPreview: backdropPreview,
    linePreview: linePreview,
    LINE_STYLES: LINE_STYLES,
    lineIdOf: lineIdOf,
    maxRadius: maxRadius,
    contrastRatio: contrastRatio,
    // 明るさの見立ては app.js（プレビューの市松）でも使うので出しておく。
    // 読み取りのしきい値（LUMA_WALL / LUMA_TIGHT）は判定ごとここが持つ。
    encodedLuma: encodedLuma,
    paintColor: paintColor,
    resolvePaint: resolvePaint,
    overWhite: overWhite,
    FONT_KEYS: FONT_KEYS,
    textRuns: textRuns,
    embedFontCss: embedFontCss,
    IMG_SCALE_MIN: IMG_SCALE_MIN,
    IMG_SCALE_MAX: IMG_SCALE_MAX
  };
})(window);
