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

  const DEFAULTS = {
    cell: 'rounded',
    cellScale: 1,
    cellJitter: 0,
    markerFrame: 'rounded',
    markerEye: 'rounded',
    fg: { type: 'solid', color: '#111827', from: '#111827', mid: '', to: '#2563EB', angle: 45, colors: ['#2563EB', '#7C3AED', '#DB2777'], seed: 0, src: '' },
    bg: { type: 'solid', color: '#FFFFFF', from: '#FFFFFF', mid: '', to: '#E5E7EB', angle: 45, colors: ['#2563EB', '#7C3AED', '#DB2777'], seed: 0, src: '', transparency: 80 },
    markerFramePaint: { type: 'auto', color: '#111827', from: '#111827', mid: '', to: '#2563EB', angle: 45, colors: ['#2563EB', '#7C3AED', '#DB2777'], seed: 0, src: '' },
    markerEyePaint: { type: 'auto', color: '#111827', from: '#111827', mid: '', to: '#2563EB', angle: 45, colors: ['#2563EB', '#7C3AED', '#DB2777'], seed: 0, src: '' },
    markerFrameColor: '',
    markerEyeColor: '',
    margin: 4,
    radius: 2,
    // 暗い地に明るいセルを意図して置くデザインでは true。反転の注意を
    // 「警告」から「補足」に落とすだけで、注意そのものは消さない。
    invertOk: false,
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
    label:  { pad: 1.8, label: 5.6, stroke: 0 }
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

  // グラデーションは代表色（中間）で明るさを判定する。多色は背景と最もコントラストが低い色を返す
  function paintColor(paint, bgHex) {
    if (!paint || paint.type === 'none') return null;
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
    const isMulti = Array.isArray(colors) && colors.length > 1;
    const colorBuckets = {};
    if (isMulti) {
      colors.forEach(c => { colorBuckets[c] = []; });
    }
    const singleParts = [];

    // 縦横のラインは連続するマスをまとめてカプセルにする
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
          const p = rectPath(px, py, w, h, t / 2);
          if (isMulti) {
            const cIdx = Math.floor(cellRand(x, y, (seed || 0) + 17) * colors.length);
            colorBuckets[colors[cIdx]].push(p);
          } else {
            singleParts.push(p);
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
          if (isMulti) {
            const cIdx = Math.floor(cellRand(x, y, (seed || 0) + 17) * colors.length);
            colorBuckets[colors[cIdx]].push(p);
          } else {
            singleParts.push(p);
          }
        }
      }
    }

    if (isMulti) {
      return colors.map(c => ({ color: c, d: (colorBuckets[c] || []).join('') }));
    }
    return [{ color: null, d: singleParts.join('') }];
  }

  function cellsPath(grid, size, ox, oy, shape, scale, jitter) {
    const groups = cellsGroupedPath(grid, size, ox, oy, shape, scale, jitter, null, 0);
    return groups[0].d;
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

  // スカラップ（花型）の外周パス
  function scallopFramePath(fx, fy) {
    const p = (x, y) => n(fx + x) + ' ' + n(fy + y);
    const R = 2.8;
    const arc = (x, y) => 'A' + n(R) + ' ' + n(R) + ' 0 0 1 ' + p(x, y);
    const cr = 1.0;
    const corner = (x, y) => 'A' + n(cr) + ' ' + n(cr) + ' 0 0 1 ' + p(x, y);

    return 'M' + p(1, 0) +
      arc(3.5, 0) + arc(6, 0) + corner(7, 1) +
      arc(7, 3.5) + arc(7, 6) + corner(6, 7) +
      arc(3.5, 7) + arc(1, 7) + corner(0, 6) +
      arc(0, 3.5) + arc(0, 1) + corner(1, 0) + 'Z';
  }

  // 外周リング（7x7 から 5x5 を抜く）
  function markerFramePath(fx, fy, style) {
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

  function paintDef(paint, id, box) {
    if (!paint || paint.type === 'solid' || paint.type === 'none') return '';
    if (paint.type === 'image') {
      if (!paint.src) return '';
      return '<pattern id="' + id + '" patternUnits="userSpaceOnUse" x="' + n(box.x) +
        '" y="' + n(box.y) + '" width="' + n(box.w) + '" height="' + n(box.h) + '">' +
        '<image href="' + esc(paint.src) + '" x="0" y="0" width="' + n(box.w) +
        '" height="' + n(box.h) + '" preserveAspectRatio="xMidYMid slice"/>' +
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

  function getMarkerFill(paint, fg, id, fgRef, cornerIdx) {
    if (!paint || paint.type === 'auto' || paint.type === 'none') {
      if (fg.type === 'multi') {
        const colors = (Array.isArray(fg.colors) && fg.colors.length) ? fg.colors : ['#111827'];
        return esc(colors[cornerIdx % colors.length]);
      }
      return fgRef;
    }
    if (paint.type === 'solid') {
      return esc(paint.color || '#111827');
    }
    if (paint.type === 'multi') {
      const colors = (Array.isArray(paint.colors) && paint.colors.length) ? paint.colors : ['#111827'];
      return esc(colors[(cornerIdx + (paint.seed || 0)) % colors.length]);
    }
    if (paint.type === 'image') {
      return paint.src ? 'url(#' + id + ')' : esc(paint.color || '#111827');
    }
    if (paint.type === 'linear' || paint.type === 'radial') {
      return 'url(#' + id + ')';
    }
    return fgRef;
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
    const fgRef = paintRef(st.fg, uid + 'f', '#111827');

    const bgBox = st.frame.type === 'label' ? { x: bx, y: by, w: inner, h: inner } : { x: 0, y: 0, w: W, h: H };
    let bgPaint = st.bg || { type: 'solid', color: '#FFFFFF', transparency: 80 };
    if (bgPaint.type === 'white') {
      bgPaint = { type: 'solid', color: '#FFFFFF', transparency: 0 };
    } else if (bgPaint.type === 'black') {
      bgPaint = { type: 'solid', color: '#000000', transparency: 0 };
    } else if (bgPaint.type === 'auto') {
      bgPaint = Object.assign({}, st.fg, {
        transparency: st.bg.transparency !== undefined ? st.bg.transparency : 80
      });
    }

    if (bgPaint.type === 'linear' || bgPaint.type === 'radial' || bgPaint.type === 'image') {
      defs += paintDef(bgPaint, uid + 'b', bgBox);
    }
    const bgRef = paintRef(bgPaint, uid + 'b', '#FFFFFF');
    const bgTransparency = bgPaint.transparency !== undefined ? Number(bgPaint.transparency) : 80;
    const bgOpacity = bgPaint.type === 'none' ? 0 : Math.max(0, Math.min(1, (100 - bgTransparency) / 100));

    function buildBgMosaic(box, r, colors, seed, opac) {
      const clipId = uid + 'bgc';
      defs += '<clipPath id="' + clipId + '"><path d="' + rectPath(box.x, box.y, box.w, box.h, r) + '"/></clipPath>';
      const cols = Array.isArray(colors) && colors.length ? colors : ['#2563EB', '#7C3AED'];
      const tileSize = Math.max(1.8, Math.min(2.6, box.w / 18));
      const nCols = Math.ceil(box.w / tileSize);
      const nRows = Math.ceil(box.h / tileSize);
      const buckets = {};
      cols.forEach(c => { buckets[c] = []; });
      for (let ry = 0; ry < nRows; ry++) {
        for (let rx = 0; rx < nCols; rx++) {
          const cIdx = Math.floor(cellRand(rx, ry, (seed || 0) + 103) * cols.length);
          const px = box.x + rx * tileSize;
          const py = box.y + ry * tileSize;
          const pw = Math.min(tileSize, box.x + box.w - px) + 0.05;
          const ph = Math.min(tileSize, box.y + box.h - py) + 0.05;
          buckets[cols[cIdx]].push(rectPath(px, py, pw, ph, 0));
        }
      }
      let out = '<g clip-path="url(#' + clipId + ')"' + (opac < 1 ? ' opacity="' + n(opac) + '"' : '') + '>';
      cols.forEach(c => {
        if (buckets[c].length) {
          out += '<path d="' + buckets[c].join('') + '" fill="' + esc(c) + '"/>';
        }
      });
      out += '</g>';
      return out;
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
      body += '<path d="' + rectPath(0, 0, W, H, fr) + '" fill="' + esc(st.frame.color) + '"/>';
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
      if (bgPaint.type !== 'none' && bgOpacity > 0) {
        if (bgPaint.type === 'multi') {
          body += buildBgMosaic({ x: 0, y: 0, w: W, h: H }, radius, bgPaint.colors, bgPaint.seed, bgOpacity);
        } else {
          body += '<path d="' + rectPath(0, 0, W, H, radius) + '" fill="' + bgRef +
            '"' + (bgOpacity < 1 ? ' fill-opacity="' + n(bgOpacity) + '"' : '') + '/>';
        }
      }
      if (st.frame.type === 'line') {
        const inset = fm.stroke / 2 + 0.4;
        body += '<path d="' + rectPath(inset, inset, W - inset * 2, H - inset * 2, Math.max(0, radius - inset)) +
          '" fill="none" stroke="' + esc(st.frame.color) + '" stroke-width="' + n(fm.stroke) + '"/>';
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
      const frameFill = getMarkerFill(mfPaint, st.fg, uid + 'mf', fgRef, idx);
      const eyeFill = getMarkerFill(mePaint, st.fg, uid + 'me', fgRef, idx);
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
      const ty = pad + inner + labelH / 2;
      body += '<text x="' + n(W / 2) + '" y="' + n(ty) + '" font-size="' + n(fs) +
        '" font-weight="700" fill="' + esc(st.frame.textColor) +
        '" text-anchor="middle" dominant-baseline="central" letter-spacing="' + n(fs * 0.02) +
        '" font-family="Inter, &quot;Noto Sans JP&quot;, &quot;Hiragino Sans&quot;, &quot;Yu Gothic&quot;, system-ui, sans-serif">' +
        esc(text) + '</text>';
    }

    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n(W) + ' ' + n(H) +
      '" width="' + n(W) + '" height="' + n(H) + '" shape-rendering="geometricPrecision">' +
      (defs ? '<defs>' + defs + '</defs>' : '') + body + '</svg>';

    // ---- 読み取りへの注意 ---------------------------------------------
    const warnings = [];
    const bgC = st.bg.type === 'none' ? '#FFFFFF' : paintColor(st.bg);
    const fgC = paintColor(st.fg, bgC);
    const ratio = fgC && bgC ? contrastRatio(fgC, bgC) : 21;
    if (ratio < 3) {
      warnings.push({ level: 'error', text: 'コントラストが不足しています（' + ratio.toFixed(1) + ':1）。セルと背景の明暗差を大きくしてください。' });
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
      warnings.push(st.invertOk
        ? { level: 'info', text: '暗い地に明るいセルを置いた「反転QR」です。意図した配色ですが、対応していない読み取りアプリもあるので実機で確かめてください。' }
        : { level: 'warn', text: '背景よりセルのほうが明るい「反転QR」です。読み取れないアプリがあります。' });
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

  function markerPreview(frameStyle, eyeStyle) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-0.3 -0.3 7.6 7.6">' +
      '<path d="' + markerFramePath(0, 0, frameStyle) + '" fill="currentColor" fill-rule="evenodd"/>' +
      '<path d="' + markerEyePath(0, 0, eyeStyle) + '" fill="currentColor"/></svg>';
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
    contrastRatio: contrastRatio
  };
})(window);
