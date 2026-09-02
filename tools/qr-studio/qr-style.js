/* QR Studio — マス目を SVG に起こす描画エンジン
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

  const DEFAULTS = {
    cell: 'rounded',
    cellScale: 1,
    markerFrame: 'rounded',
    markerEye: 'rounded',
    fg: { type: 'solid', color: '#111827', from: '#111827', to: '#2563EB', angle: 45 },
    bg: { type: 'solid', color: '#FFFFFF', from: '#FFFFFF', to: '#E5E7EB', angle: 45 },
    markerFrameColor: '',
    markerEyeColor: '',
    margin: 4,
    radius: 2,
    logo: {
      type: 'none', icon: '', src: '', text: '',
      size: 0.22, pad: 0.14, backdrop: 'rounded', backdropColor: '#FFFFFF',
      color: '#111827', knockout: true
    },
    frame: { type: 'none', text: 'スキャンしてね', color: '#111827', textColor: '#FFFFFF', radius: 3 }
  };

  // 外枠の余白・ラベル高さ（モジュール単位）
  const FRAME_METRICS = {
    none:   { pad: 0,   label: 0,   stroke: 0 },
    line:   { pad: 1.6, label: 0,   stroke: 0.7 },
    label:  { pad: 1.8, label: 5.6, stroke: 0 },
    bubble: { pad: 2.2, label: 6.2, stroke: 0 },
    ticket: { pad: 1.8, label: 5.6, stroke: 0 }
  };

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

  function merge(base, over) {
    const out = {};
    Object.keys(base).forEach(k => {
      const b = base[k];
      const o = over ? over[k] : undefined;
      if (b && typeof b === 'object' && !Array.isArray(b)) {
        out[k] = merge(b, o && typeof o === 'object' ? o : {});
      } else {
        out[k] = o === undefined || o === null ? b : o;
      }
    });
    // 上書き側にしかないキー（markerFrameColor の空文字など）も拾う
    if (over) Object.keys(over).forEach(k => { if (!(k in out)) out[k] = over[k]; });
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

  // グラデーションは代表色（中間）で明るさを判定する
  function paintColor(paint) {
    if (!paint || paint.type === 'none') return null;
    if (paint.type === 'solid') return paint.color;
    const a = hexToRgb(paint.from), b = hexToRgb(paint.to);
    if (!a || !b) return paint.from || paint.color;
    const mid = a.map((v, i) => Math.round((v + b[i]) / 2));
    return '#' + mid.map(v => v.toString(16).padStart(2, '0')).join('');
  }

  // ------------------------------------------------------------------
  // パス生成のプリミティブ
  // ------------------------------------------------------------------

  // 角ごとに「1=丸める / 0=直角 / -1=えぐる」を指定できる矩形パス。
  // 角は時計回りに TL, TR, BR, BL の順。
  function boxPath(x0, y0, x1, y1, radii, kinds) {
    const r = radii;
    const k = kinds || [1, 1, 1, 1];
    const rr = [0, 1, 2, 3].map(i => (k[i] === 0 ? 0 : r[i]));
    const arc = (i, x, y) => {
      if (rr[i] === 0) return 'L' + n(x) + ' ' + n(y);
      return 'A' + n(rr[i]) + ' ' + n(rr[i]) + ' 0 0 ' + (k[i] === -1 ? '0' : '1') + ' ' + n(x) + ' ' + n(y);
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

  function rectPath(x, y, w, h, r) {
    const rad = Math.min(r || 0, w / 2, h / 2);
    return boxPath(x, y, x + w, y + h, [rad, rad, rad, rad], [1, 1, 1, 1]);
  }

  function circlePath(cx, cy, r) {
    return 'M' + n(cx - r) + ' ' + n(cy) +
      'a' + n(r) + ' ' + n(r) + ' 0 1 0 ' + n(r * 2) + ' 0' +
      'a' + n(r) + ' ' + n(r) + ' 0 1 0 ' + n(-r * 2) + ' 0Z';
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

  // 4方向がへこんだ、きらめき（4条星）。制御点を中心まで引くとやせすぎるので、
  // 中心と角の間に置いてふくらみを残す。
  function sparklePath(cx, cy, r) {
    const k = r * 0.5;
    const p = (dx, dy) => n(cx + dx) + ' ' + n(cy + dy);
    return 'M' + p(0, -r) +
      'Q' + p(k, -k) + ' ' + p(r, 0) +
      'Q' + p(k, k) + ' ' + p(0, r) +
      'Q' + p(-k, k) + ' ' + p(-r, 0) +
      'Q' + p(-k, -k) + ' ' + p(0, -r) + 'Z';
  }

  // 腕の長さ r、腕の太さ 2t の十字
  function plusPath(cx, cy, r, t) {
    return polyPath([
      [cx - t, cy - r], [cx + t, cy - r], [cx + t, cy - t], [cx + r, cy - t],
      [cx + r, cy + t], [cx + t, cy + t], [cx + t, cy + r], [cx - t, cy + r],
      [cx - t, cy + t], [cx - r, cy + t], [cx - r, cy - t], [cx - t, cy - t]
    ]);
  }

  // ------------------------------------------------------------------
  // データセルの描画
  // ------------------------------------------------------------------
  function cellsPath(grid, size, ox, oy, shape, scale) {
    const dark = (x, y) => x >= 0 && y >= 0 && x < size && y < size && grid[y * size + x] === 1;
    const parts = [];

    // 縦横のラインは連続するマスをまとめてカプセルにする
    if (shape === 'vbar' || shape === 'hbar') {
      const t = Math.max(0.3, Math.min(1, scale));
      const inset = (1 - t) / 2;
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
          const w = shape === 'vbar' ? t : len;
          const h = shape === 'vbar' ? len : t;
          const px = ox + x + (shape === 'vbar' ? inset : 0);
          const py = oy + y + (shape === 'vbar' ? 0 : inset);
          parts.push(rectPath(px, py, w, h, t / 2));
        }
      }
      return parts.join('');
    }

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!dark(x, y)) continue;
        const s = shape === 'fluid' ? 1 : Math.max(0.3, Math.min(1.15, scale));
        const inset = (1 - s) / 2;
        const x0 = ox + x + inset, y0 = oy + y + inset;
        const x1 = x0 + s, y1 = y0 + s;
        const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;

        switch (shape) {
          case 'square':
            parts.push(rectPath(x0, y0, s, s, 0));
            break;
          case 'rounded':
            parts.push(rectPath(x0, y0, s, s, s * 0.3));
            break;
          case 'dot':
            parts.push(circlePath(cx, cy, s / 2));
            break;
          case 'diamond':
            // 頂点をセルの外へ少し出す。素直に内接させるとインクが減りすぎて、
            // 読み取り機が「明るいマス」と誤読しやすくなる。
            parts.push(polyPath([[cx, cy - s * 0.66], [cx + s * 0.66, cy], [cx, cy + s * 0.66], [cx - s * 0.66, cy]]));
            break;
          case 'star':
            parts.push(starPath(cx, cy, s * 0.72, s * 0.44, 5));
            break;
          case 'sparkle':
            parts.push(sparklePath(cx, cy, s * 0.72));
            break;
          case 'plus':
            parts.push(plusPath(cx, cy, s * 0.68, s * 0.3));
            break;
          case 'classy':
            parts.push(boxPath(x0, y0, x1, y1, [s / 2, 0, s / 2, 0], [1, 0, 1, 0]));
            break;
          case 'classy2':
            parts.push(boxPath(x0, y0, x1, y1, [s / 2, s / 2, 0, s / 2], [1, 1, 0, 1]));
            break;
          case 'fluid': {
            const U = dark(x, y - 1), D = dark(x, y + 1), L = dark(x - 1, y), R = dark(x + 1, y);
            const kind = (s1, s2, diag) => (!s1 && !s2) ? 1 : (s1 && s2 && !diag) ? -1 : 0;
            const kinds = [
              kind(U, L, dark(x - 1, y - 1)),
              kind(U, R, dark(x + 1, y - 1)),
              kind(D, R, dark(x + 1, y + 1)),
              kind(D, L, dark(x - 1, y + 1))
            ];
            // 出っ張りは半マス、へこみは1/4マス。へこみを半マスにすると、
            // 3マスが集まる角のまわりが白く抜けすぎて読み取りが不安定になる。
            const radii = kinds.map(k => (k === -1 ? 0.26 : 0.5));
            parts.push(boxPath(x0, y0, x1, y1, radii, kinds));
            break;
          }
          default:
            parts.push(rectPath(x0, y0, s, s, s * 0.3));
        }
      }
    }
    return parts.join('');
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
      case 'xrounded': return boxPath(x, y, x1, y1, r(s * 0.3), [1, 1, 1, 1]);
      case 'circle':   return boxPath(x, y, x1, y1, r(s * 0.38), [1, 1, 1, 1]);
      case 'leaf':     return boxPath(x, y, x1, y1, [s * 0.36, 0, s * 0.36, 0], [1, 0, 1, 0]);
      case 'leaf2':    return boxPath(x, y, x1, y1, [0, s * 0.36, 0, s * 0.36], [0, 1, 0, 1]);
      case 'cut':      return boxPath(x, y, x1, y1, [0, s * 0.34, s * 0.34, s * 0.34], [0, 1, 1, 1]);
      default:         return boxPath(x, y, x1, y1, r(s * 0.16), [1, 1, 1, 1]);
    }
  }

  // 外周リング（7x7 から 5x5 を抜く）
  function markerFramePath(fx, fy, style) {
    if (style === 'dots') {
      // リング上の24モジュールを点で置く。半径0.58でわずかに重ね、
      // 走査線が途切れないようにしている。
      const parts = [];
      for (let dy = 0; dy < 7; dy++) {
        for (let dx = 0; dx < 7; dx++) {
          if (dx !== 0 && dx !== 6 && dy !== 0 && dy !== 6) continue;
          parts.push(circlePath(fx + dx + 0.5, fy + dy + 0.5, 0.58));
        }
      }
      return parts.join('');
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
    switch (style) {
      case 'square':  return boxPath(x, y, x1, y1, [0, 0, 0, 0], [0, 0, 0, 0]);
      case 'circle':  return boxPath(x, y, x1, y1, [EYE_R, EYE_R, EYE_R, EYE_R], [1, 1, 1, 1]);
      case 'leaf':    return boxPath(x, y, x1, y1, [EYE_R, 0, EYE_R, 0], [1, 0, 1, 0]);
      case 'leaf2':   return boxPath(x, y, x1, y1, [0, EYE_R, 0, EYE_R], [0, 1, 0, 1]);
      case 'cut':     return boxPath(x, y, x1, y1, [0, s * 0.45, s * 0.45, s * 0.45], [0, 1, 1, 1]);
      case 'rounded':
      default:        return boxPath(x, y, x1, y1, [s * 0.3, s * 0.3, s * 0.3, s * 0.3], [1, 1, 1, 1]);
    }
  }

  // ------------------------------------------------------------------
  // 塗り（単色 / グラデーション）
  // ------------------------------------------------------------------
  function paintDef(paint, id, box) {
    if (!paint || paint.type === 'solid' || paint.type === 'none') return '';
    const a = ((paint.angle || 0) * Math.PI) / 180;
    if (paint.type === 'radial') {
      const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
      const r = Math.sqrt(box.w * box.w + box.h * box.h) / 2;
      return '<radialGradient id="' + id + '" gradientUnits="userSpaceOnUse" cx="' + n(cx) +
        '" cy="' + n(cy) + '" r="' + n(r) + '">' +
        '<stop offset="0" stop-color="' + esc(paint.from) + '"/>' +
        '<stop offset="1" stop-color="' + esc(paint.to) + '"/></radialGradient>';
    }
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    const half = Math.max(box.w, box.h) / 2;
    const dx = Math.cos(a) * half, dy = Math.sin(a) * half;
    return '<linearGradient id="' + id + '" gradientUnits="userSpaceOnUse" x1="' + n(cx - dx) +
      '" y1="' + n(cy - dy) + '" x2="' + n(cx + dx) + '" y2="' + n(cy + dy) + '">' +
      '<stop offset="0" stop-color="' + esc(paint.from) + '"/>' +
      '<stop offset="1" stop-color="' + esc(paint.to) + '"/></linearGradient>';
  }

  function paintRef(paint, id) {
    if (!paint || paint.type === 'none') return 'none';
    if (paint.type === 'solid') return esc(paint.color);
    return 'url(#' + id + ')';
  }

  // ------------------------------------------------------------------
  // ロゴ
  // ------------------------------------------------------------------
  function logoSvg(logo, cx, cy, side) {
    if (!logo || logo.type === 'none') return '';
    const half = side / 2;
    const x = cx - half, y = cy - half;
    let out = '';

    if (logo.type === 'icon' && logo.iconData) {
      const vb = String(logo.iconData.vb || '0 0 24 24').split(/\s+/).map(Number);
      const vw = vb[2] || 24, vh = vb[3] || 24;
      const k = side / Math.max(vw, vh);
      const tx = cx - (vw * k) / 2 - vb[0] * k;
      const ty = cy - (vh * k) / 2 - vb[1] * k;
      out += '<g transform="translate(' + n(tx) + ' ' + n(ty) + ') scale(' + n(k) + ')" fill="' +
        esc(logo.color) + '">';
      logo.iconData.p.forEach(p => {
        out += '<path d="' + p.d + '"' + (p.e ? ' fill-rule="evenodd"' : '') + '/>';
      });
      out += '</g>';
    } else if (logo.type === 'image' && logo.src) {
      out += '<image href="' + esc(logo.src) + '" x="' + n(x) + '" y="' + n(y) + '" width="' +
        n(side) + '" height="' + n(side) + '" preserveAspectRatio="xMidYMid meet"/>';
    } else if (logo.type === 'text' && logo.text) {
      const fs = side * (logo.text.length > 2 ? 0.5 : 0.78);
      out += '<text x="' + n(cx) + '" y="' + n(cy) + '" font-size="' + n(fs) +
        '" font-weight="700" fill="' + esc(logo.color) +
        '" text-anchor="middle" dominant-baseline="central" ' +
        'font-family="Inter, &quot;Noto Sans JP&quot;, system-ui, sans-serif">' +
        esc(logo.text) + '</text>';
    }
    return out;
  }

  // ------------------------------------------------------------------
  // 本体
  // ------------------------------------------------------------------
  function render(qr, styleIn) {
    const st = merge(DEFAULTS, styleIn || {});
    const size = qr.size;
    const margin = Math.max(0, Math.min(10, Math.round(st.margin)));
    const inner = size + margin * 2;
    // 角を丸めすぎると、下地の角が削れてクワイエットゾーンを食う。
    // 余白の1.5倍を上限にして、四隅の白場が必ず残るようにする。
    const radius = Math.max(0, Math.min(st.radius, margin * 1.5));
    const fm = FRAME_METRICS[st.frame.type] || FRAME_METRICS.none;
    const pad = fm.pad;
    const labelH = fm.label && st.frame.text ? fm.label : 0;

    const W = inner + pad * 2;
    const H = inner + pad * 2 + labelH;
    const bx = pad, by = pad;               // QRブロック（余白込み）の左上
    const ox = pad + margin, oy = pad + margin; // モジュール(0,0)の左上

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

    if (hasLogo && logo.knockout) {
      const half = knockSide / 2;
      const round = logo.backdrop === 'circle';
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const mx = ox + x + 0.5, my = oy + y + 0.5;
          const dx = mx - cx, dy = my - cy;
          const insideBox = Math.abs(dx) <= half && Math.abs(dy) <= half;
          const inside = round ? Math.hypot(dx, dy) <= half : insideBox;
          if (!inside) continue;
          knocked++;
          if (!isFinder(x, y)) grid[y * size + x] = 0;
        }
      }
    }

    // ---- 塗りの定義 ---------------------------------------------------
    const qrBox = { x: ox, y: oy, w: size, h: size };
    const uid = 'qs' + Math.random().toString(36).slice(2, 8);
    let defs = '';
    defs += paintDef(st.fg, uid + 'f', qrBox);
    defs += paintDef(st.bg, uid + 'b', { x: 0, y: 0, w: W, h: H });
    const fgRef = paintRef(st.fg, uid + 'f');
    const bgRef = paintRef(st.bg, uid + 'b');
    const frameFill = st.markerFrameColor || fgRef;
    const eyeFill = st.markerEyeColor || fgRef;

    // ---- 組み立て -----------------------------------------------------
    let body = '';

    // 外枠の地
    if (st.frame.type === 'label' || st.frame.type === 'bubble' || st.frame.type === 'ticket') {
      const fr = st.frame.type === 'bubble' ? st.frame.radius + 2 : st.frame.radius;
      body += '<path d="' + rectPath(0, 0, W, H, fr) + '" fill="' + esc(st.frame.color) + '"/>';
      if (st.frame.type === 'bubble') {
        // 下向きの小さな尻尾
        const tw = 3.2, th = 2.4;
        body += '<path d="' + polyPath([[W / 2 - tw / 2, H - 0.2], [W / 2 + tw / 2, H - 0.2], [W / 2, H + th]]) +
          '" fill="' + esc(st.frame.color) + '"/>';
      }
      if (st.frame.type === 'ticket') {
        // ラベルとの境目にミシン目と切り込み
        const ly = pad + inner + 0.6;
        body += '<line x1="' + n(1.6) + '" y1="' + n(ly) + '" x2="' + n(W - 1.6) + '" y2="' + n(ly) +
          '" stroke="' + esc(st.frame.textColor) + '" stroke-width="0.28" stroke-dasharray="1 1" opacity="0.65"/>';
      }
      // QRブロックの下地
      body += '<path d="' + rectPath(bx, by, inner, inner, radius) + '" fill="' +
        (st.bg.type === 'none' ? '#FFFFFF' : bgRef) + '"/>';
    } else {
      if (st.bg.type !== 'none') {
        body += '<path d="' + rectPath(0, 0, W, H, radius) + '" fill="' + bgRef + '"/>';
      }
      if (st.frame.type === 'line') {
        const inset = fm.stroke / 2 + 0.4;
        body += '<path d="' + rectPath(inset, inset, W - inset * 2, H - inset * 2, Math.max(0, radius - inset)) +
          '" fill="none" stroke="' + esc(st.frame.color) + '" stroke-width="' + n(fm.stroke) + '"/>';
      }
    }

    // データセル
    const cells = cellsPath(grid, size, ox, oy, st.cell, st.cellScale);
    if (cells) body += '<path d="' + cells + '" fill="' + fgRef + '"/>';

    // マーカー3つ
    const corners = [[0, 0], [size - 7, 0], [0, size - 7]];
    corners.forEach(c => {
      const fx = ox + c[0], fy = oy + c[1];
      body += '<path d="' + markerFramePath(fx, fy, st.markerFrame) +
        '" fill="' + frameFill + '" fill-rule="evenodd"/>';
      body += '<path d="' + markerEyePath(fx, fy, st.markerEye) + '" fill="' + eyeFill + '"/>';
    });

    // ロゴ
    if (hasLogo) {
      if (logo.backdrop !== 'none') {
        const half = knockSide / 2;
        const d = logo.backdrop === 'circle'
          ? circlePath(cx, cy, half)
          : rectPath(cx - half, cy - half, knockSide, knockSide, knockSide * 0.22);
        body += '<path d="' + d + '" fill="' + esc(logo.backdropColor) + '"/>';
      }
      body += logoSvg(logo, cx, cy, logoSide);
    }

    // 外枠のテキスト
    if (labelH) {
      const text = String(st.frame.text);
      const avail = W - 3;
      // 全角は約1em、半角は約0.55em として収まる字送りを見積もる
      let units = 0;
      for (let i = 0; i < text.length; i++) {
        units += text.charCodeAt(i) > 0x2E80 ? 1 : 0.56;
      }
      const fs = Math.max(1.6, Math.min(3.4, units ? avail / units : 3.4));
      const ty = pad + inner + labelH / 2 + (st.frame.type === 'ticket' ? 0.5 : 0);
      body += '<text x="' + n(W / 2) + '" y="' + n(ty) + '" font-size="' + n(fs) +
        '" font-weight="700" fill="' + esc(st.frame.textColor) +
        '" text-anchor="middle" dominant-baseline="central" letter-spacing="' + n(fs * 0.02) +
        '" font-family="Inter, &quot;Noto Sans JP&quot;, &quot;Hiragino Sans&quot;, &quot;Yu Gothic&quot;, system-ui, sans-serif">' +
        esc(text) + '</text>';
    }

    const totalH = st.frame.type === 'bubble' ? H + 2.6 : H;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n(W) + ' ' + n(totalH) +
      '" width="' + n(W) + '" height="' + n(totalH) + '" shape-rendering="geometricPrecision">' +
      (defs ? '<defs>' + defs + '</defs>' : '') + body + '</svg>';

    // ---- 読み取りへの注意 ---------------------------------------------
    const warnings = [];
    const fgC = paintColor(st.fg);
    const bgC = st.bg.type === 'none' ? '#FFFFFF' : paintColor(st.bg);
    const ratio = fgC && bgC ? contrastRatio(fgC, bgC) : 21;
    if (ratio < 3) {
      warnings.push({ level: 'error', text: 'コントラストが不足しています（' + ratio.toFixed(1) + ':1）。前景と背景の明暗差を大きくしてください。' });
    } else if (ratio < 4.5) {
      warnings.push({ level: 'warn', text: 'コントラストがやや低めです（' + ratio.toFixed(1) + ':1）。読み取りにくい環境があるかもしれません。' });
    }
    // マーカーだけ別色にしたときの見落としが一番多い
    [[st.markerFrameColor, 'マーカーの枠'], [st.markerEyeColor, 'マーカーの目']].forEach(pair => {
      if (!pair[0] || !bgC) return;
      const r = contrastRatio(pair[0], bgC);
      if (r < 3) {
        warnings.push({ level: 'error', text: pair[1] + 'の色が背景に近すぎます（' + r.toFixed(1) + ':1）。位置検出パターンが見えないと読み取れません。' });
      } else if (r < 4.5) {
        warnings.push({ level: 'warn', text: pair[1] + 'の色がやや薄めです（' + r.toFixed(1) + ':1）。' });
      }
    });
    if (fgC && bgC && luminance(fgC) > luminance(bgC)) {
      warnings.push({ level: 'warn', text: '背景より前景のほうが明るい「反転QR」です。読み取れないアプリがあります。' });
    }
    const coverage = knocked / (size * size);
    const budget = ({ L: 0.07, M: 0.15, Q: 0.25, H: 0.30 })[qr.ec] || 0.15;
    if (hasLogo && coverage > budget * 0.85) {
      warnings.push({ level: 'error', text: 'ロゴが大きすぎます（' + Math.round(coverage * 100) + '%）。小さくするか誤り訂正レベルを上げてください。' });
    } else if (hasLogo && coverage > budget * 0.55) {
      warnings.push({ level: 'warn', text: 'ロゴの面積が誤り訂正の余力に近づいています（' + Math.round(coverage * 100) + '%）。' });
    }
    if (margin < 2) {
      warnings.push({ level: 'warn', text: '余白（クワイエットゾーン）が狭いと読み取り精度が落ちます。4以上を推奨。' });
    }

    return {
      svg: svg,
      width: W,
      height: totalH,
      contrast: ratio,
      coverage: coverage,
      warnings: warnings
    };
  }

  // 指定ピクセル幅で書き出すために width/height だけ差し替える
  function resize(svg, px) {
    const m = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
    if (!m) return svg;
    const w = parseFloat(m[1]), h = parseFloat(m[2]);
    const height = Math.round((px * h) / w);
    return svg.replace(/width="[^"]*" height="[^"]*"/, 'width="' + px + '" height="' + height + '"');
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

  function markerPreview(frameStyle, eyeStyle) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-0.3 -0.3 7.6 7.6">' +
      '<path d="' + markerFramePath(0, 0, frameStyle) + '" fill="currentColor" fill-rule="evenodd"/>' +
      '<path d="' + markerEyePath(0, 0, eyeStyle) + '" fill="currentColor"/></svg>';
  }

  function eyePreview(eyeStyle) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="1.8 1.8 3.4 3.4">' +
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
    contrastRatio: contrastRatio
  };
})(window);
