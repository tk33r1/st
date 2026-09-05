/* QR Atelier — 画面まわり
 *
 * qr-core.js（符号化）と qr-style.js（描画）をつなぎ、入力・デザイン操作・
 * 書き出しを受け持つ。ページの外へ出ていく通信はひとつもない。
 */
(function () {
  'use strict';

  const { showToast } = window.STCommon;
  const A = window.QRAssets;

  // 制御文字はエスケープ表記が化けやすいので、必ずコードポイントから作る。
  const CRLF = String.fromCharCode(13) + String.fromCharCode(10);
  const BACKSLASH = String.fromCharCode(92);

  // ------------------------------------------------------------------
  // 入力の種類
  // ------------------------------------------------------------------
  function normalizeUrl(v) {
    const s = String(v || '').trim();
    if (!s) return '';
    const lower = s.toLowerCase();
    const schemes = ['http://', 'https://', 'mailto:', 'tel:', 'sms:', 'line:', 'geo:', 'ftp://'];
    if (schemes.some(p => lower.indexOf(p) === 0)) return s;
    return 'https://' + s;
  }

  // Wi-Fi と vCard は区切り記号をエスケープしないと読み取り側が誤解する。
  function wifiEscape(v) {
    const special = [BACKSLASH, ';', ',', '"', ':'];
    let out = '';
    const s = String(v || '');
    for (let i = 0; i < s.length; i++) {
      const ch = s.charAt(i);
      out += special.indexOf(ch) >= 0 ? BACKSLASH + ch : ch;
    }
    return out;
  }

  function vcardEscape(v) {
    const special = [BACKSLASH, ';', ','];
    let out = '';
    const s = String(v || '');
    for (let i = 0; i < s.length; i++) {
      const ch = s.charAt(i);
      if (ch === String.fromCharCode(10) || ch === String.fromCharCode(13)) { out += BACKSLASH + 'n'; continue; }
      out += special.indexOf(ch) >= 0 ? BACKSLASH + ch : ch;
    }
    return out;
  }

  const TYPES = [
    {
      id: 'url', name: 'URL', hint: 'URL',
      fields: [{ k: 'url', label: 'リンク先URL', type: 'url', ph: 'https://tk.st/' }],
      init: { url: 'https://tk.st/tools/qr-atelier/' },
      build: f => normalizeUrl(f.url)
    },
    {
      id: 'text', name: 'テキスト', hint: 'テキスト',
      fields: [{ k: 'text', label: '好きな文章', type: 'textarea', ph: 'そのまま表示される文字列' }],
      init: { text: '' },
      build: f => String(f.text || '')
    },
    {
      id: 'email', name: 'メール', hint: 'mailto',
      fields: [
        { k: 'to', label: '宛先', type: 'email', ph: 'hello@example.com' },
        { k: 'subject', label: '件名', type: 'text', ph: 'お問い合わせ' },
        { k: 'body', label: '本文', type: 'textarea', ph: '' }
      ],
      init: { to: '', subject: '', body: '' },
      build: f => {
        if (!f.to) return '';
        const q = [];
        if (f.subject) q.push('subject=' + encodeURIComponent(f.subject));
        if (f.body) q.push('body=' + encodeURIComponent(f.body));
        // 宛先も空白や記号が入るとURLとして壊れる。ただし @ と , まで潰すと
        // 読みにくいうえ、カンマ区切りの複数宛先が使えなくなるので戻す。
        const to = encodeURIComponent(String(f.to).trim())
          .replace(/%40/g, '@').replace(/%2C/gi, ',');
        return 'mailto:' + to + (q.length ? '?' + q.join('&') : '');
      }
    },
    {
      id: 'tel', name: '電話', hint: 'tel',
      fields: [{ k: 'tel', label: '電話番号', type: 'tel', ph: '+81312345678', sub: '国番号から書くと海外の端末でもかけられます。' }],
      init: { tel: '' },
      build: f => (f.tel ? 'tel:' + String(f.tel).replace(/[^0-9+]/g, '') : '')
    },
    {
      id: 'sms', name: 'SMS', hint: 'smsto',
      fields: [
        { k: 'tel', label: '送信先', type: 'tel', ph: '09012345678' },
        { k: 'msg', label: '本文', type: 'textarea', ph: '' }
      ],
      init: { tel: '', msg: '' },
      build: f => (f.tel ? 'SMSTO:' + String(f.tel).replace(/[^0-9+]/g, '') + ':' + String(f.msg || '') : '')
    },
    {
      id: 'wifi', name: 'Wi-Fi', hint: 'WIFI',
      fields: [
        { k: 'ssid', label: 'ネットワーク名（SSID）', type: 'text', ph: 'MyHomeWiFi' },
        { k: 'pass', label: 'パスワード', type: 'text', ph: '' },
        { k: 'enc', label: '暗号化方式', type: 'select', options: [['WPA', 'WPA / WPA2 / WPA3'], ['WEP', 'WEP'], ['nopass', 'なし（オープン）']] },
        { k: 'hidden', label: 'ステルスSSID', type: 'checkbox', sub: 'SSIDを隠している場合はオン' }
      ],
      init: { ssid: '', pass: '', enc: 'WPA', hidden: false },
      build: f => {
        if (!f.ssid) return '';
        let s = 'WIFI:T:' + (f.enc || 'WPA') + ';S:' + wifiEscape(f.ssid) + ';';
        if (f.enc !== 'nopass') s += 'P:' + wifiEscape(f.pass) + ';';
        if (f.hidden) s += 'H:true;';
        return s + ';';
      }
    },
    {
      id: 'vcard', name: '連絡先', hint: 'vCard',
      fields: [
        { k: 'last', label: '姓', type: 'text', ph: '武田' },
        { k: 'first', label: '名', type: 'text', ph: '慎也' },
        { k: 'org', label: '会社・組織', type: 'text', ph: '' },
        { k: 'title', label: '役職', type: 'text', ph: '' },
        { k: 'tel', label: '電話', type: 'tel', ph: '' },
        { k: 'email', label: 'メール', type: 'email', ph: '' },
        { k: 'url', label: 'サイト', type: 'url', ph: '' },
        { k: 'note', label: 'メモ', type: 'text', ph: '' }
      ],
      init: { last: '', first: '', org: '', title: '', tel: '', email: '', url: '', note: '' },
      build: f => {
        if (!f.last && !f.first && !f.org) return '';
        const L = ['BEGIN:VCARD', 'VERSION:3.0'];
        L.push('N:' + vcardEscape(f.last) + ';' + vcardEscape(f.first) + ';;;');
        L.push('FN:' + vcardEscape((f.last + ' ' + f.first).trim()));
        if (f.org) L.push('ORG:' + vcardEscape(f.org));
        if (f.title) L.push('TITLE:' + vcardEscape(f.title));
        if (f.tel) L.push('TEL;TYPE=CELL:' + vcardEscape(f.tel));
        if (f.email) L.push('EMAIL:' + vcardEscape(f.email));
        if (f.url) L.push('URL:' + vcardEscape(normalizeUrl(f.url)));
        if (f.note) L.push('NOTE:' + vcardEscape(f.note));
        L.push('END:VCARD');
        return L.join(CRLF);
      }
    },
    {
      id: 'geo', name: '位置情報', hint: 'geo',
      fields: [
        { k: 'lat', label: '緯度', type: 'text', ph: '35.681236' },
        { k: 'lng', label: '経度', type: 'text', ph: '139.767125' }
      ],
      init: { lat: '', lng: '' },
      build: f => (f.lat && f.lng ? 'geo:' + String(f.lat).trim() + ',' + String(f.lng).trim() : '')
    }
  ];

  // ------------------------------------------------------------------
  // 状態
  // ------------------------------------------------------------------
  const state = {
    type: 'url',
    values: {},
    ec: 'H',
    minVersion: 1,
    exportSize: 1024,
    presetName: '',
    iconGroup: 'brand',
    colorScope: 'cell',  // 最後に触った色パネル（＝着色対象）
    previewChecker: 'auto', // 'auto' | 'light' | 'dark'
    style: JSON.parse(JSON.stringify(window.QRStyle.DEFAULTS))
  };
  TYPES.forEach(t => { state.values[t.id] = Object.assign({}, t.init); });

  // 色の設定パネルは着色対象ごとに1枚ずつ、その対象の形の設定のすぐ下に置く。
  // 切り替えるタブはないので、スコープ名がそのまま対象名になる。
  const COLOR_SCOPES = ['cell', 'frame', 'eye', 'bg', 'logobd'];

  function scopeTarget(scope) { return scope; }

  function paintOf(target) {
    if (target === 'frame') return state.style.markerFramePaint;
    if (target === 'eye') return state.style.markerEyePaint;
    if (target === 'bg') return state.style.bg;
    if (target === 'logobd') return getLogoBackdropPaint();
    return state.style.fg;
  }

  function paintOfScope(scope) { return paintOf(scopeTarget(scope)); }

  // プレビューへの画像ドロップなど、パネル外から「いま触っている色」を指す用
  function getActivePaint() { return paintOfScope(state.colorScope); }

  function colorPanel(scope) {
    return document.querySelector('.color-panel[data-scope="' + scope + '"]');
  }

  // パネル内の部品は id ではなく data-cid で引く（3枚あるので id にできない）
  function cq(scope, cid) {
    const panel = colorPanel(scope);
    return panel ? panel.querySelector('[data-cid="' + cid + '"]') : null;
  }

  function paintLabel(p) {
    const n = p.mid ? '3色' : '2色';
    return p.type === 'white' ? '白' :
      p.type === 'black' ? '黒' :
      p.type === 'none' ? '透明' :
      p.type === 'auto' ? 'セルの色' :
      p.type === 'solid' ? '単色' :
      p.type === 'multi' ? '多色 (' + ((p.colors || []).length) + '色)' :
      p.type === 'image' ? '画像' :
      p.type === 'radial' ? '放射 (' + n + ')' :
      'グラデーション (' + n + ')';
  }

  // ロゴの下地の塗り。背景と同じ 9 モードを持つ。
  // 旧データは色ひとつ（backdropColor）と backdrop:'none' で表していたので拾い直す。
  function getLogoBackdropPaint() {
    const lg = state.style.logo;
    if (!lg.backdropPaint || !lg.backdropPaint.type) {
      lg.backdropPaint = lg.backdrop === 'none'
        ? { type: 'none', color: '#FFFFFF', transparency: 0 }
        : { type: 'solid', color: lg.backdropColor || '#FFFFFF', transparency: 0 };
    }
    return lg.backdropPaint;
  }

  function getLogoPaint() {
    if (!state.style.logo.paint) {
      state.style.logo.paint = {
        type: 'brand', color: state.style.logo.color || '#111827',
        from: '#111827', mid: '', to: '#2563EB', angle: 45,
        colors: ['#2563EB', '#7C3AED', '#DB2777'], seed: 0, src: ''
      };
    }
    return state.style.logo.paint;
  }

  const STORE_KEY = 'qr-atelier-v1';

  function save() {
    try {
      const copy = JSON.parse(JSON.stringify(state));
      // 画像は重いので、大きいものは覚えない
      if (copy.style.logo && copy.style.logo.src && copy.style.logo.src.length > 300000) {
        copy.style.logo.src = '';
        copy.style.logo.type = 'none';
      }
      if (copy.style.logo && copy.style.logo.paint && copy.style.logo.paint.src && copy.style.logo.paint.src.length > 300000) {
        copy.style.logo.paint.src = '';
      }
      if (copy.style.fg && copy.style.fg.src && copy.style.fg.src.length > 300000) {
        copy.style.fg.src = '';
      }
      if (copy.style.bg && copy.style.bg.src && copy.style.bg.src.length > 300000) {
        copy.style.bg.src = '';
      }
      if (copy.style.markerFramePaint && copy.style.markerFramePaint.src && copy.style.markerFramePaint.src.length > 300000) {
        copy.style.markerFramePaint.src = '';
      }
      if (copy.style.markerEyePaint && copy.style.markerEyePaint.src && copy.style.markerEyePaint.src.length > 300000) {
        copy.style.markerEyePaint.src = '';
      }
      delete copy.style.logo.iconData;
      localStorage.setItem(STORE_KEY, JSON.stringify(copy));
    } catch (e) { /* private mode — 保存しないだけ */ }
  }

  function restore() {
    let raw = null;
    try { raw = localStorage.getItem(STORE_KEY); } catch (e) { return; }
    if (!raw) return;
    try {
      const saved = JSON.parse(raw);
      if (saved.type) state.type = saved.type;
      if (saved.values) Object.keys(state.values).forEach(k => {
        if (saved.values[k]) Object.assign(state.values[k], saved.values[k]);
      });
      ['ec', 'minVersion', 'exportSize', 'presetName', 'iconGroup'].forEach(k => {
        if (saved[k] !== undefined) state[k] = saved[k];
      });
      if (['auto', 'light', 'dark'].indexOf(saved.previewChecker) >= 0) {
        state.previewChecker = saved.previewChecker;
      }
      if (window.QRCore.LEVELS.indexOf(state.ec) < 0) state.ec = 'H';
      state.minVersion = clampNum(state.minVersion, 1, 14, 1);
      if ([512, 1024, 2048, 4096].indexOf(state.exportSize) < 0) state.exportSize = 1024;
      // 旧データのロゴの下地は、色ひとつ（backdropColor）と backdrop:'none'（下地なし）で
      // 表していた。DEFAULTS を被せると backdropPaint が既定値で埋まってしまうので、
      // 被せる前に「形＋塗り」へ移しておく。
      if (saved.style && saved.style.logo && !saved.style.logo.backdropPaint) {
        saved.style.logo.backdropPaint = saved.style.logo.backdrop === 'none'
          ? { type: 'none', color: '#FFFFFF', transparency: 0 }
          : { type: 'solid', color: saved.style.logo.backdropColor || '#FFFFFF', transparency: 0 };
      }
      if (saved.style) state.style = window.QRStyle.merge(window.QRStyle.DEFAULTS, saved.style);
      if (state.style.logo && !state.style.logo.paint) {
        state.style.logo.paint = {
          type: 'brand', color: state.style.logo.color || '#111827', from: '#111827', mid: '', to: '#2563EB', angle: 45,
          colors: ['#2563EB', '#7C3AED', '#DB2777'], seed: 0, src: ''
        };
      }
      if (state.style.logo && !state.style.logo.font) {
        state.style.logo.font = 'sans';
      }
      if (state.style.markerFrame && !A.MARKER_FRAMES.some(f => f.id === state.style.markerFrame)) {
        state.style.markerFrame = window.QRStyle.DEFAULTS.markerFrame;
      }
      if (state.style.markerEye && !A.MARKER_EYES.some(e => e.id === state.style.markerEye)) {
        state.style.markerEye = window.QRStyle.DEFAULTS.markerEye;
      }
      if (state.style.frame && state.style.frame.type && !A.FRAMES.some(f => f.id === state.style.frame.type)) {
        state.style.frame.type = 'none';
      }
      if (state.style.logo.type === 'icon' && state.style.logo.icon) {
        state.style.logo.iconData = A.ICONS.find(i => i.id === state.style.logo.icon) || null;
      }
      sanitizeStyle(state.style);
    } catch (e) { /* 壊れた保存は捨てる */ }
  }

  function sanitizePaint(p, defaultType, fallbackColor, isBg) {
    const D = window.QRStyle.DEFAULTS;
    if (!p || typeof p !== 'object') p = {};
    const validTypes = isBg
      ? ['white', 'black', 'none', 'auto', 'solid', 'multi', 'linear', 'radial', 'image']
      : defaultType === 'auto'
        ? ['auto', 'solid', 'multi', 'linear', 'radial', 'image']
        : ['solid', 'multi', 'linear', 'radial', 'image'];
    if (validTypes.indexOf(p.type) < 0) p.type = defaultType;
    p.color = normHex(p.color, fallbackColor || (isBg ? '#FFFFFF' : '#111827'));
    p.from = normHex(p.from, isBg ? '#FFFFFF' : '#FC466B');
    p.to = normHex(p.to, isBg ? '#E5E7EB' : '#3F5EFB');
    p.mid = p.mid ? normHex(p.mid, '') : '';
    p.angle = clampNum(p.angle, 0, 359, 45);
    if (!Array.isArray(p.colors) || p.colors.length === 0) {
      p.colors = ['#2563EB', '#7C3AED', '#DB2777'];
    } else {
      p.colors = p.colors.map(c => normHex(c, '#2563EB')).slice(0, 8);
      if (p.colors.length < 2) p.colors.push('#7C3AED');
    }
    p.seed = typeof p.seed === 'number' && !isNaN(p.seed) ? Math.floor(p.seed) : 0;
    p.src = sanitizeImageUrl(p.src);
    if (isBg || p.transparency !== undefined) {
      p.transparency = clampNum(p.transparency, 0, 100, 80);
    }
    return p;
  }

  // localStorage の中身はそのまま SVG の属性と数値に流れる。壊れた保存や
  // 別経路で書き換えられた値が fill="..." を閉じて属性を足せてしまわないよう、
  // 色は #RRGGBB に、数値は範囲内の数に必ず均しておく。
  function sanitizeStyle(s) {
    const D = window.QRStyle.DEFAULTS;
    s.fg = sanitizePaint(s.fg, 'solid', '#111827');

    // 旧プロパティからの移行と初期化
    if (!s.markerFramePaint) {
      s.markerFramePaint = s.markerFrameColor ? { type: 'solid', color: s.markerFrameColor } : { type: 'auto' };
    }
    s.markerFramePaint = sanitizePaint(s.markerFramePaint, 'auto', s.fg.color);

    if (!s.markerEyePaint) {
      s.markerEyePaint = s.markerEyeColor ? { type: 'solid', color: s.markerEyeColor } : { type: 'auto' };
    }
    s.markerEyePaint = sanitizePaint(s.markerEyePaint, 'auto', s.fg.color);

    s.bg = sanitizePaint(s.bg, 'solid', '#FFFFFF', true);

    // ロゴの下地。形はマーカーの枠と同じ一覧から選ぶ。旧データの 'none'（下地なし）は
    // 形を角丸に戻したうえで、塗りのほうを「透明」に移す。
    if (!s.logo.backdropPaint) {
      s.logo.backdropPaint = s.logo.backdrop === 'none'
        ? { type: 'none', color: '#FFFFFF', transparency: 0 }
        : { type: 'solid', color: s.logo.backdropColor || '#FFFFFF', transparency: 0 };
    }
    if (!s.logo.backdrop || !A.MARKER_FRAMES.some(f => f.id === s.logo.backdrop)) {
      s.logo.backdrop = D.logo.backdrop;
    }
    // 下地は既定で不透明。sanitizePaint は未指定を 80% 透過とみなすので、先に埋めておく
    if (s.logo.backdropPaint.transparency === undefined) s.logo.backdropPaint.transparency = 0;
    s.logo.backdropPaint = sanitizePaint(s.logo.backdropPaint, 'solid', '#FFFFFF', true);

    [[s, 'markerFrameColor', ''], [s, 'markerEyeColor', ''],
     [s.logo, 'color', D.logo.color], [s.logo, 'backdropColor', D.logo.backdropColor],
     [s.frame, 'color', D.frame.color], [s.frame, 'textColor', D.frame.textColor]
    ].forEach(t => { t[0][t[1]] = t[0][t[1]] ? normHex(t[0][t[1]], t[2]) : t[2]; });

    s.cellScale = clampNum(s.cellScale, 0.3, 1.15, D.cellScale);
    s.cellJitter = clampNum(s.cellJitter, 0, 1, D.cellJitter);
    s.margin = clampNum(s.margin, 0, 10, D.margin);
    s.radius = clampNum(s.radius, 0, 10, D.radius);
    s.logo.size = clampNum(s.logo.size, 0.06, 0.34, D.logo.size);
    s.logo.pad = clampNum(s.logo.pad, 0, 0.5, D.logo.pad);
    s.frame.radius = clampNum(s.frame.radius, 0, 10, D.frame.radius);
    s.frame.text = String(s.frame.text == null ? D.frame.text : s.frame.text);
    s.logo.text = String(s.logo.text == null ? '' : s.logo.text);
    s.logo.src = sanitizeImageUrl(s.logo.src);
    s.invertOk = !!s.invertOk;
    if (!A.CELL_SHAPES.some(c => c.id === s.cell)) s.cell = D.cell;
  }

  function sanitizeImageUrl(v) {
    if (!v || typeof v !== 'string') return '';
    const s = v.trim();
    if (/^(https?:\/\/|data:image\/)/i.test(s)) {
      return s;
    }
    return '';
  }

  // ------------------------------------------------------------------
  // 小物
  // ------------------------------------------------------------------
  const $ = id => document.getElementById(id);

  function el(tag, attrs, text) {
    const node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(k => {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'dataset') Object.assign(node.dataset, attrs[k]);
      else node.setAttribute(k, attrs[k]);
    });
    if (text != null) node.textContent = text;
    return node;
  }

  function setStatus(text, cls) {
    const led = $('status-led'), t = $('status-text');
    led.className = 'st-led' + (cls ? ' ' + cls : '');
    t.textContent = text;
  }

  function clampNum(v, lo, hi, fallback) {
    const x = Number(v);
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : fallback;
  }

  function normHex(v, fallback) {
    let s = String(v || '').trim();
    if (s.charAt(0) !== '#') s = '#' + s;
    if (/^#[0-9a-fA-F]{3}$/.test(s)) {
      s = '#' + s.slice(1).split('').map(c => c + c).join('');
    }
    return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toUpperCase() : fallback;
  }

  function hexToRgb(hex) {
    let h = String(hex || '').trim().replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  function getLuminance(rgb) {
    if (!rgb) return 0;
    return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
  }

  function getCellLuminance() {
    const fg = state.style && state.style.fg;
    if (!fg) return 0;
    if (fg.type === 'solid') {
      return getLuminance(hexToRgb(fg.color));
    }
    if (fg.type === 'linear' || fg.type === 'radial') {
      const cols = [fg.from, fg.to];
      if (fg.mid) cols.push(fg.mid);
      let sum = 0, count = 0;
      cols.forEach(c => {
        const rgb = hexToRgb(c);
        if (rgb) { sum += getLuminance(rgb); count++; }
      });
      return count ? sum / count : 0;
    }
    if (fg.type === 'multi') {
      const cols = Array.isArray(fg.colors) && fg.colors.length ? fg.colors : ['#2563EB', '#7C3AED'];
      let sum = 0, count = 0;
      cols.forEach(c => {
        const rgb = hexToRgb(c);
        if (rgb) { sum += getLuminance(rgb); count++; }
      });
      return count ? sum / count : 0;
    }
    if (fg.type === 'image') {
      return 0;
    }
    return 0;
  }

  function updateCanvasChecker() {
    const card = $('canvas-card') || document.querySelector('.canvas-card');
    if (!card) return;
    let isDark = false;
    if (state.previewChecker === 'dark') {
      isDark = true;
    } else if (state.previewChecker === 'light') {
      isDark = false;
    } else {
      // 'auto': セルが明るい（輝度 >= 130）なら黒ベース市松、暗いなら白ベース市松
      isDark = getCellLuminance() >= 130;
    }
    card.classList.toggle('theme-dark', isDark);
    card.classList.toggle('theme-light', !isDark);

    const toggle = $('checker-toggle');
    if (toggle) {
      Array.prototype.forEach.call(toggle.children, btn => {
        btn.classList.toggle('active', btn.dataset.checker === state.previewChecker);
      });
    }
  }

  // ------------------------------------------------------------------
  // 内容フォーム
  // ------------------------------------------------------------------
  function buildTypeChips() {
    const host = $('type-chips');
    host.innerHTML = '';
    TYPES.forEach(t => {
      const b = el('button', { class: 'chip' + (t.id === state.type ? ' active' : ''), type: 'button' }, t.name);
      b.addEventListener('click', () => {
        state.type = t.id;
        buildTypeChips();
        buildTypeFields();
        update();
      });
      host.appendChild(b);
    });
  }

  function buildTypeFields() {
    const type = TYPES.find(t => t.id === state.type);
    const host = $('type-fields');
    host.innerHTML = '';
    $('hint-content').textContent = type.hint;

    const values = state.values[type.id];
    const pairs = [];
    type.fields.forEach(f => {
      const wrap = el('div', { class: 'field' });
      const id = 'f-' + type.id + '-' + f.k;
      wrap.appendChild(el('label', { for: id }, f.label));

      let input;
      if (f.type === 'textarea') {
        input = el('textarea', { id: id, placeholder: f.ph || '' });
        input.value = values[f.k] || '';
      } else if (f.type === 'select') {
        input = el('select', { id: id });
        f.options.forEach(o => {
          const opt = el('option', { value: o[0] }, o[1]);
          if (values[f.k] === o[0]) opt.selected = true;
          input.appendChild(opt);
        });
      } else if (f.type === 'checkbox') {
        input = el('input', { type: 'checkbox', id: id, class: 'tb-check' });
        input.checked = !!values[f.k];
        wrap.classList.add('color-row');
        wrap.style.flexDirection = 'row';
        wrap.style.alignItems = 'center';
        wrap.insertBefore(input, wrap.firstChild);
      } else {
        input = el('input', { type: f.type, id: id, placeholder: f.ph || '' });
        input.value = values[f.k] || '';
      }

      const commit = () => {
        values[f.k] = f.type === 'checkbox' ? input.checked : input.value;
        update();
      };
      input.addEventListener('input', commit);
      input.addEventListener('change', commit);

      if (f.type !== 'checkbox') wrap.appendChild(input);
      if (f.sub) wrap.appendChild(el('span', { class: 'sub' }, f.sub));
      pairs.push(wrap);
    });

    // 連絡先は項目が多いので2列に畳む
    if (type.id === 'vcard' || type.id === 'geo') {
      const grid = el('div', { class: 'grid2' });
      pairs.forEach(p => grid.appendChild(p));
      host.appendChild(grid);
    } else {
      const stack = el('div', { class: 'cols' });
      pairs.forEach(p => stack.appendChild(p));
      host.appendChild(stack);
    }
  }

  function payload() {
    const type = TYPES.find(t => t.id === state.type);
    return type.build(state.values[type.id]);
  }

  // ------------------------------------------------------------------
  // デザインUI
  // ------------------------------------------------------------------
  let previewQR = null; // テンプレート用の使い回し

  function buildPresets() {
    const host = $('preset-grid');
    host.innerHTML = '';
    if (!previewQR) previewQR = window.QRCore.encode('https://tk.st/', { ec: 'M' });

    A.PRESETS.forEach(p => {
      const btn = el('button', { class: 'preset-btn' + (state.presetName === p.name ? ' active' : ''), type: 'button' });
      const out = window.QRStyle.render(previewQR, Object.assign({}, p.style, { margin: 2, frame: { type: 'none' } }));
      const holder = el('div');
      holder.innerHTML = out.svg;
      btn.appendChild(holder.firstChild);
      btn.appendChild(el('i', null, p.name));
      btn.addEventListener('click', () => {
        state.style = window.QRStyle.merge(state.style, JSON.parse(JSON.stringify(p.style)));
        state.presetName = p.name;
        syncControls();
        buildShapeGrids();
        buildPresets();
        update();
      });
      host.appendChild(btn);
    });
    $('hint-preset').textContent = state.presetName || 'カスタム';
  }

  function buildShapeGrids() {
    const cellHost = $('cell-grid');
    cellHost.innerHTML = '';
    A.CELL_SHAPES.forEach(s => {
      const b = el('button', { class: 'shape-btn' + (state.style.cell === s.id ? ' active' : ''), type: 'button', title: s.name });
      const holder = el('div');
      holder.innerHTML = window.QRStyle.cellPreview(s.id);
      b.appendChild(holder.firstChild);
      b.appendChild(el('i', null, s.name));
      b.addEventListener('click', () => {
        state.style.cell = s.id;
        state.presetName = '';
        buildShapeGrids();
        buildPresets();
        update();
      });
      cellHost.appendChild(b);
    });

    const frameHost = $('frame-grid');
    frameHost.innerHTML = '';
    A.MARKER_FRAMES.forEach(s => {
      const b = el('button', { class: 'shape-btn' + (state.style.markerFrame === s.id ? ' active' : ''), type: 'button', title: s.name });
      const holder = el('div');
      holder.innerHTML = window.QRStyle.markerPreview(s.id, state.style.markerEye);
      b.appendChild(holder.firstChild);
      b.appendChild(el('i', null, s.name));
      b.addEventListener('click', () => {
        state.style.markerFrame = s.id;
        state.presetName = '';
        buildShapeGrids();
        buildPresets();
        update();
      });
      frameHost.appendChild(b);
    });

    const bdHost = $('logo-backdrop-grid');
    if (bdHost) {
      bdHost.innerHTML = '';
      A.MARKER_FRAMES.forEach(f => {
        const b = el('button', { class: 'shape-btn' + (state.style.logo.backdrop === f.id ? ' active' : ''), type: 'button', title: f.name });
        const holder = el('div');
        holder.innerHTML = window.QRStyle.backdropPreview(f.id);
        b.appendChild(holder.firstChild);
        b.appendChild(el('i', null, f.name));
        b.addEventListener('click', () => {
          state.style.logo.backdrop = f.id;
          state.presetName = '';
          buildShapeGrids();
          buildPresets();
          update();
        });
        bdHost.appendChild(b);
      });
    }

    const eyeHost = $('eye-grid');
    eyeHost.innerHTML = '';
    A.MARKER_EYES.forEach(s => {
      const b = el('button', { class: 'shape-btn' + (state.style.markerEye === s.id ? ' active' : ''), type: 'button', title: s.name });
      const holder = el('div');
      holder.innerHTML = window.QRStyle.eyePreview(s.id);
      b.appendChild(holder.firstChild);
      b.appendChild(el('i', null, s.name));
      b.addEventListener('click', () => {
        state.style.markerEye = s.id;
        state.presetName = '';
        buildShapeGrids();
        buildPresets();
        update();
      });
      eyeHost.appendChild(b);
    });

    const cellName = (A.CELL_SHAPES.find(s => s.id === state.style.cell) || {}).name || '';
    $('hint-shape').textContent = cellName;
  }

  const MULTI_PALETTES = [
    { name: 'ポップ',   colors: ['#2563EB', '#7C3AED', '#DB2777'] },
    { name: 'ビビッド', colors: ['#EF4444', '#F59E0B', '#10B981', '#3B82F6'] },
    { name: 'ネオン',   colors: ['#FF006E', '#FB5607', '#FFBE0B', '#3A86FF'] },
    { name: 'オーシャン', colors: ['#1E3A8A', '#0284C7', '#06B6D4', '#10B981'] },
    { name: 'サンセット', colors: ['#831843', '#BE185D', '#EA580C', '#F59E0B'] },
    { name: '和モダン', colors: ['#165E83', '#B7282E', '#68BE8D', '#F8B500'] },
    { name: 'シック',   colors: ['#111827', '#374151', '#4B5563', '#6B7280'] },
    { name: 'パステル', colors: ['#F472B6', '#A78BFA', '#60A5FA', '#34D399'] }
  ];

  function buildMultiColorsList(scope) {
    const host = cq(scope, 'multi-colors-list');
    if (!host) return;
    host.innerHTML = '';
    const p = paintOfScope(scope);
    if (!Array.isArray(p.colors)) p.colors = ['#2563EB', '#7C3AED', '#DB2777'];
    const colors = p.colors;
    colors.forEach((c, idx) => {
      const item = el('div', { class: 'multi-color-item' });
      const picker = el('input', { type: 'color', value: normHex(c, '#2563EB'), 'aria-label': '色 ' + (idx + 1) });
      const hexSpan = el('span', { class: 'color-hex' }, normHex(c, '#2563EB'));
      const removeBtn = el('button', {
        class: 'btn-remove-color',
        type: 'button',
        title: 'この色を削除',
        'aria-label': 'この色を削除'
      }, '×');
      if (colors.length <= 2) {
        removeBtn.disabled = true;
      }

      picker.addEventListener('input', () => {
        const hex = picker.value.toUpperCase();
        hexSpan.textContent = hex;
        colors[idx] = hex;
        state.presetName = '';
        update();
      });
      picker.addEventListener('change', () => {
        save();
      });

      removeBtn.addEventListener('click', () => {
        if (colors.length <= 2) return;
        colors.splice(idx, 1);
        state.presetName = '';
        syncControls();
        update();
      });

      item.appendChild(picker);
      item.appendChild(hexSpan);
      item.appendChild(removeBtn);
      host.appendChild(item);
    });

    const addBtn = cq(scope, 'btn-add-color');
    if (addBtn) {
      const atMax = colors.length >= 8;
      addBtn.classList.toggle('hidden', atMax);
      addBtn.hidden = atMax;
      addBtn.disabled = atMax;
    }
  }

  function buildMultiPalettes(scope) {
    const host = cq(scope, 'multi-palette-grid');
    if (!host) return;
    host.innerHTML = '';
    MULTI_PALETTES.forEach(p => {
      const btn = el('button', { class: 'multi-pal-btn', type: 'button', title: p.name });
      const dots = el('div', { class: 'multi-pal-dots' });
      p.colors.forEach(c => {
        const s = el('span');
        s.style.background = c;
        dots.appendChild(s);
      });
      btn.appendChild(dots);
      btn.appendChild(el('i', null, p.name));
      btn.addEventListener('click', () => {
        state.colorScope = scope;
        paintOfScope(scope).colors = p.colors.slice();
        state.presetName = '';
        syncControls();
        buildPresets();
        update();
      });
      host.appendChild(btn);
    });
  }

  function blendHex(c1, c2) {
    const a = hexToRgb(c1) || [0, 0, 0];
    const b = hexToRgb(c2) || [255, 255, 255];
    const m = a.map((v, i) => Math.round((v + b[i]) / 2));
    return '#' + m.map(v => v.toString(16).padStart(2, '0')).join('');
  }

  function buildGradColorsList(scope) {
    const host = cq(scope, 'grad-colors-list');
    if (!host) return;
    host.innerHTML = '';
    const p = paintOfScope(scope);
    const hasMid = !!p.mid;
    const items = hasMid
      ? [{ key: 'from', role: '開始', val: p.from || '#FC466B' },
         { key: 'mid',  role: '中間', val: p.mid },
         { key: 'to',   role: '終了', val: p.to || '#3F5EFB' }]
      : [{ key: 'from', role: '開始', val: p.from || '#FC466B' },
         { key: 'to',   role: '終了', val: p.to || '#3F5EFB' }];

    items.forEach((item, idx) => {
      const elItem = el('div', { class: 'multi-color-item' });
      const picker = el('input', { type: 'color', value: normHex(item.val, '#FC466B'), 'aria-label': item.role + '色' });
      const roleSpan = el('span', { class: 'color-hex', style: 'font-size:10px; color:var(--ink-3); margin-right:2px;' }, item.role);
      const hexSpan = el('span', { class: 'color-hex' }, normHex(item.val, '#FC466B'));
      const removeBtn = el('button', {
        class: 'btn-remove-color',
        type: 'button',
        title: item.role + '色を削除',
        'aria-label': item.role + '色を削除'
      }, '×');

      if (!hasMid) {
        removeBtn.disabled = true;
      }

      picker.addEventListener('input', () => {
        const hex = picker.value.toUpperCase();
        hexSpan.textContent = hex;
        if (item.key === 'from') p.from = hex;
        else if (item.key === 'mid') p.mid = hex;
        else p.to = hex;
        state.presetName = '';
        update();
      });
      picker.addEventListener('change', () => {
        save();
      });

      removeBtn.addEventListener('click', () => {
        if (!hasMid) return;
        if (item.key === 'from') {
          p.from = p.mid;
          p.mid = '';
        } else if (item.key === 'mid') {
          p.mid = '';
        } else {
          p.to = p.mid;
          p.mid = '';
        }
        state.presetName = '';
        syncControls();
        update();
      });

      elItem.appendChild(picker);
      elItem.appendChild(roleSpan);
      elItem.appendChild(hexSpan);
      elItem.appendChild(removeBtn);
      host.appendChild(elItem);
    });

    const addBtn = cq(scope, 'btn-add-grad-color');
    if (addBtn) {
      addBtn.classList.toggle('hidden', hasMid);
      addBtn.hidden = hasMid;
      addBtn.disabled = hasMid;
    }
  }



  function buildSwatches(scope) {
    const host = cq(scope, 'swatch-host');
    if (!host) return;
    host.innerHTML = '';
    A.SWATCHES.forEach(group => {
      const g = el('div', { class: 'swatch-group' });
      g.appendChild(el('b', null, group.name));
      const row = el('div', { class: 'swatches' });
      group.colors.forEach(c => {
        const b = el('button', { class: 'sw', type: 'button', title: c, 'aria-label': c });
        b.style.background = c;
        b.addEventListener('click', () => {
          state.colorScope = scope;
          const p = paintOfScope(scope);
          if (p.type === 'solid') {
            p.color = c;
          } else if (p.type === 'multi') {
            if (p.colors.indexOf(c) < 0 && p.colors.length < 8) {
              p.colors.push(c);
            } else {
              p.colors[p.colors.length - 1] = c;
            }
          } else {
            if (!p.mid) {
              p.mid = c;
            } else {
              p.to = c;
            }
          }
          state.presetName = '';
          syncControls();
          buildPresets();
          update();
        });
        row.appendChild(b);
      });
      g.appendChild(row);
      host.appendChild(g);
    });
  }

  function buildGradients(scope) {
    const host = cq(scope, 'grad-grid');
    if (!host) return;
    host.innerHTML = '';
    A.GRADIENTS.forEach(g => {
      const b = el('button', { class: 'grad-btn', type: 'button', title: g.name });
      const stops = g.mid ? [g.from, g.mid, g.to] : [g.from, g.to];
      b.style.background = 'linear-gradient(' + (g.angle + 90) + 'deg, ' + stops.join(', ') + ')';
      b.appendChild(el('span', null, g.name));
      b.addEventListener('click', () => {
        state.colorScope = scope;
        const p = paintOfScope(scope);
        p.from = g.from;
        p.mid = g.mid || '';
        p.to = g.to;
        p.angle = g.angle;
        if (p.type === 'solid' || p.type === 'multi' || p.type === 'auto') p.type = 'linear';
        state.presetName = '';
        syncControls();
        buildPresets();
        update();
      });
      host.appendChild(b);
    });
  }

  function buildLogoMultiColorsList() {
    const host = $('logo-multi-colors-list');
    if (!host) return;
    host.innerHTML = '';
    const lp = getLogoPaint();
    if (!Array.isArray(lp.colors)) lp.colors = ['#2563EB', '#7C3AED', '#DB2777'];
    const colors = lp.colors;
    colors.forEach((c, idx) => {
      const item = el('div', { class: 'multi-color-item' });
      const picker = el('input', { type: 'color', value: normHex(c, '#2563EB'), 'aria-label': '色 ' + (idx + 1) });
      const hexSpan = el('span', { class: 'color-hex' }, normHex(c, '#2563EB'));
      const removeBtn = el('button', {
        class: 'btn-remove-color',
        type: 'button',
        title: 'この色を削除',
        'aria-label': 'この色を削除'
      }, '×');
      if (colors.length <= 2) {
        removeBtn.disabled = true;
      }

      picker.addEventListener('input', () => {
        const hex = picker.value.toUpperCase();
        hexSpan.textContent = hex;
        colors[idx] = hex;
        state.presetName = '';
        update();
      });
      picker.addEventListener('change', () => {
        save();
      });

      removeBtn.addEventListener('click', () => {
        if (colors.length <= 2) return;
        colors.splice(idx, 1);
        state.presetName = '';
        syncControls();
        update();
        save();
      });

      item.appendChild(picker);
      item.appendChild(hexSpan);
      item.appendChild(removeBtn);
      host.appendChild(item);
    });

    const addBtn = $('btn-logo-add-color');
    if (addBtn) {
      const atMax = colors.length >= 8;
      addBtn.classList.toggle('hidden', atMax);
      addBtn.hidden = atMax;
      addBtn.disabled = atMax;
    }
  }

  function buildLogoMultiPalettes() {
    const host = $('logo-multi-palette-grid');
    if (!host) return;
    host.innerHTML = '';
    MULTI_PALETTES.forEach(p => {
      const btn = el('button', { class: 'multi-pal-btn', type: 'button', title: p.name });
      const dots = el('div', { class: 'multi-pal-dots' });
      p.colors.forEach(c => {
        const s = el('span');
        s.style.background = c;
        dots.appendChild(s);
      });
      btn.appendChild(dots);
      btn.appendChild(el('i', null, p.name));
      btn.addEventListener('click', () => {
        getLogoPaint().colors = p.colors.slice();
        state.presetName = '';
        syncControls();
        update();
        save();
      });
      host.appendChild(btn);
    });
  }

  function buildLogoGradColorsList() {
    const host = $('logo-grad-colors-list');
    if (!host) return;
    host.innerHTML = '';
    const lp = getLogoPaint();
    const hasMid = !!lp.mid;
    const items = hasMid
      ? [{ key: 'from', role: '開始', val: lp.from || '#FC466B' },
         { key: 'mid',  role: '中間', val: lp.mid },
         { key: 'to',   role: '終了', val: lp.to || '#3F5EFB' }]
      : [{ key: 'from', role: '開始', val: lp.from || '#FC466B' },
         { key: 'to',   role: '終了', val: lp.to || '#3F5EFB' }];

    items.forEach((item, idx) => {
      const elItem = el('div', { class: 'multi-color-item' });
      const picker = el('input', { type: 'color', value: normHex(item.val, '#FC466B'), 'aria-label': item.role + '色' });
      const roleSpan = el('span', { class: 'color-hex', style: 'font-size:10px; color:var(--ink-3); margin-right:2px;' }, item.role);
      const hexSpan = el('span', { class: 'color-hex' }, normHex(item.val, '#FC466B'));
      const removeBtn = el('button', {
        class: 'btn-remove-color',
        type: 'button',
        title: item.role + '色を削除',
        'aria-label': item.role + '色を削除'
      }, '×');

      if (!hasMid) {
        removeBtn.disabled = true;
      }

      picker.addEventListener('input', () => {
        const hex = picker.value.toUpperCase();
        hexSpan.textContent = hex;
        if (item.key === 'from') lp.from = hex;
        else if (item.key === 'mid') lp.mid = hex;
        else lp.to = hex;
        state.presetName = '';
        update();
      });
      picker.addEventListener('change', () => {
        save();
      });

      removeBtn.addEventListener('click', () => {
        if (!hasMid) return;
        if (item.key === 'from') {
          lp.from = lp.mid;
          lp.mid = '';
        } else if (item.key === 'mid') {
          lp.mid = '';
        } else {
          lp.to = lp.mid;
          lp.mid = '';
        }
        state.presetName = '';
        syncControls();
        update();
        save();
      });

      elItem.appendChild(picker);
      elItem.appendChild(roleSpan);
      elItem.appendChild(hexSpan);
      elItem.appendChild(removeBtn);
      host.appendChild(elItem);
    });

    const addBtn = $('btn-logo-add-grad-color');
    if (addBtn) {
      addBtn.classList.toggle('hidden', hasMid);
      addBtn.hidden = hasMid;
      addBtn.disabled = hasMid;
    }
  }

  function buildLogoGradients() {
    const host = $('logo-grad-grid');
    if (!host) return;
    host.innerHTML = '';
    A.GRADIENTS.forEach(g => {
      const b = el('button', { class: 'grad-btn', type: 'button', title: g.name });
      const stops = g.mid ? [g.from, g.mid, g.to] : [g.from, g.to];
      b.style.background = 'linear-gradient(' + (g.angle + 90) + 'deg, ' + stops.join(', ') + ')';
      b.appendChild(el('span', null, g.name));
      b.addEventListener('click', () => {
        const lp = getLogoPaint();
        lp.from = g.from;
        lp.mid = g.mid || '';
        lp.to = g.to;
        lp.angle = g.angle;
        state.presetName = '';
        syncControls();
        update();
        save();
      });
      host.appendChild(b);
    });
  }

  function buildLogoSwatches() {
    const host = $('logo-swatch-host');
    if (!host) return;
    host.innerHTML = '';
    A.SWATCHES.forEach(group => {
      const g = el('div', { class: 'swatch-group' });
      g.appendChild(el('b', null, group.name));
      const row = el('div', { class: 'swatches' });
      group.colors.forEach(c => {
        const b = el('button', { class: 'sw', type: 'button', title: c, 'aria-label': c });
        b.style.background = c;
        b.addEventListener('click', () => {
          const lp = getLogoPaint();
          lp.color = c;
          state.style.logo.color = c;
          state.presetName = '';
          syncControls();
          update();
          save();
        });
        row.appendChild(b);
      });
      g.appendChild(row);
      host.appendChild(g);
    });
  }

  function loadLogoImageMask(file) {
    if (!file || !file.type.match(/^image\//)) {
      showToast('画像ファイルを選んでください', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const lp = getLogoPaint();
      lp.src = reader.result;
      state.presetName = '';
      syncControls();
      update();
      save();
    };
    reader.onerror = () => showToast('画像の読み込みに失敗しました', 'error');
    reader.readAsDataURL(file);
  }

  function loadLogoImageMaskUrl(url) {
    const s = String(url || '').trim();
    if (!s) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const dataUrl = canvas.toDataURL('image/png');
        const lp = getLogoPaint();
        lp.src = dataUrl;
        state.presetName = '';
        syncControls();
        update();
        save();
        showToast('画像を適用しました', 'success');
      } catch (err) {
        const lp = getLogoPaint();
        lp.src = s;
        state.presetName = '';
        syncControls();
        update();
        save();
        showToast('URL画像を適用しました', 'success');
      }
    };
    img.onerror = () => showToast('画像の読み込みに失敗しました。URLを確認してください', 'error');
    img.src = s;
  }

  function buildLogoTextMultiColorsList() {
    const host = $('logo-text-multi-colors-list');
    if (!host) return;
    host.innerHTML = '';
    const lp = getLogoPaint();
    if (!Array.isArray(lp.colors)) lp.colors = ['#2563EB', '#7C3AED', '#DB2777'];
    const colors = lp.colors;
    colors.forEach((c, idx) => {
      const item = el('div', { class: 'multi-color-item' });
      const picker = el('input', { type: 'color', value: normHex(c, '#2563EB'), 'aria-label': '色 ' + (idx + 1) });
      const hexSpan = el('span', { class: 'color-hex' }, normHex(c, '#2563EB'));
      const removeBtn = el('button', {
        class: 'btn-remove-color',
        type: 'button',
        title: 'この色を削除',
        'aria-label': 'この色を削除'
      }, '×');
      if (colors.length <= 2) {
        removeBtn.disabled = true;
      }

      picker.addEventListener('input', () => {
        const hex = picker.value.toUpperCase();
        hexSpan.textContent = hex;
        colors[idx] = hex;
        state.presetName = '';
        update();
      });
      picker.addEventListener('change', () => {
        save();
      });

      removeBtn.addEventListener('click', () => {
        if (colors.length <= 2) return;
        colors.splice(idx, 1);
        state.presetName = '';
        syncControls();
        update();
        save();
      });

      item.appendChild(picker);
      item.appendChild(hexSpan);
      item.appendChild(removeBtn);
      host.appendChild(item);
    });

    const addBtn = $('btn-logo-text-add-color');
    if (addBtn) {
      const atMax = colors.length >= 8;
      addBtn.classList.toggle('hidden', atMax);
      addBtn.hidden = atMax;
      addBtn.disabled = atMax;
    }
  }

  function buildLogoTextMultiPalettes() {
    const host = $('logo-text-multi-palette-grid');
    if (!host) return;
    host.innerHTML = '';
    MULTI_PALETTES.forEach(p => {
      const btn = el('button', { class: 'multi-pal-btn', type: 'button', title: p.name });
      const dots = el('div', { class: 'multi-pal-dots' });
      p.colors.forEach(c => {
        const s = el('span');
        s.style.background = c;
        dots.appendChild(s);
      });
      btn.appendChild(dots);
      btn.appendChild(el('i', null, p.name));
      btn.addEventListener('click', () => {
        getLogoPaint().colors = p.colors.slice();
        state.presetName = '';
        syncControls();
        update();
        save();
      });
      host.appendChild(btn);
    });
  }

  function buildLogoTextGradColorsList() {
    const host = $('logo-text-grad-colors-list');
    if (!host) return;
    host.innerHTML = '';
    const lp = getLogoPaint();
    const hasMid = !!lp.mid;
    const items = hasMid
      ? [{ key: 'from', role: '開始', val: lp.from || '#FC466B' },
         { key: 'mid',  role: '中間', val: lp.mid },
         { key: 'to',   role: '終了', val: lp.to || '#3F5EFB' }]
      : [{ key: 'from', role: '開始', val: lp.from || '#FC466B' },
         { key: 'to',   role: '終了', val: lp.to || '#3F5EFB' }];

    items.forEach((item, idx) => {
      const elItem = el('div', { class: 'multi-color-item' });
      const picker = el('input', { type: 'color', value: normHex(item.val, '#FC466B'), 'aria-label': item.role + '色' });
      const roleSpan = el('span', { class: 'color-hex', style: 'font-size:10px; color:var(--ink-3); margin-right:2px;' }, item.role);
      const hexSpan = el('span', { class: 'color-hex' }, normHex(item.val, '#FC466B'));
      const removeBtn = el('button', {
        class: 'btn-remove-color',
        type: 'button',
        title: item.role + '色を削除',
        'aria-label': item.role + '色を削除'
      }, '×');

      if (!hasMid) {
        removeBtn.disabled = true;
      }

      picker.addEventListener('input', () => {
        const hex = picker.value.toUpperCase();
        hexSpan.textContent = hex;
        if (item.key === 'from') lp.from = hex;
        else if (item.key === 'mid') lp.mid = hex;
        else lp.to = hex;
        state.presetName = '';
        update();
      });
      picker.addEventListener('change', () => {
        save();
      });

      removeBtn.addEventListener('click', () => {
        if (!hasMid) return;
        if (item.key === 'from') {
          lp.from = lp.mid;
          lp.mid = '';
        } else if (item.key === 'mid') {
          lp.mid = '';
        } else {
          lp.to = lp.mid;
          lp.mid = '';
        }
        state.presetName = '';
        syncControls();
        update();
        save();
      });

      elItem.appendChild(picker);
      elItem.appendChild(roleSpan);
      elItem.appendChild(hexSpan);
      elItem.appendChild(removeBtn);
      host.appendChild(elItem);
    });

    const addBtn = $('btn-logo-text-add-grad-color');
    if (addBtn) {
      addBtn.classList.toggle('hidden', hasMid);
      addBtn.hidden = hasMid;
      addBtn.disabled = hasMid;
    }
  }

  function buildLogoTextGradients() {
    const host = $('logo-text-grad-grid');
    if (!host) return;
    host.innerHTML = '';
    A.GRADIENTS.forEach(g => {
      const b = el('button', { class: 'grad-btn', type: 'button', title: g.name });
      const stops = g.mid ? [g.from, g.mid, g.to] : [g.from, g.to];
      b.style.background = 'linear-gradient(' + (g.angle + 90) + 'deg, ' + stops.join(', ') + ')';
      b.appendChild(el('span', null, g.name));
      b.addEventListener('click', () => {
        const lp = getLogoPaint();
        lp.from = g.from;
        lp.mid = g.mid || '';
        lp.to = g.to;
        lp.angle = g.angle;
        state.presetName = '';
        syncControls();
        update();
        save();
      });
      host.appendChild(b);
    });
  }

  function buildLogoTextSwatches() {
    const host = $('logo-text-swatch-host');
    if (!host) return;
    host.innerHTML = '';
    A.SWATCHES.forEach(group => {
      const g = el('div', { class: 'swatch-group' });
      g.appendChild(el('b', null, group.name));
      const row = el('div', { class: 'swatches' });
      group.colors.forEach(c => {
        const b = el('button', { class: 'sw', type: 'button', title: c, 'aria-label': c });
        b.style.background = c;
        b.addEventListener('click', () => {
          const lp = getLogoPaint();
          lp.color = c;
          state.style.logo.color = c;
          state.presetName = '';
          syncControls();
          update();
          save();
        });
        row.appendChild(b);
      });
      g.appendChild(row);
      host.appendChild(g);
    });
  }

  function loadLogoTextImageMask(file) {
    if (!file || !file.type.match(/^image\//)) {
      showToast('画像ファイルを選んでください', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const lp = getLogoPaint();
      lp.src = reader.result;
      state.presetName = '';
      syncControls();
      update();
      save();
    };
    reader.onerror = () => showToast('画像の読み込みに失敗しました', 'error');
    reader.readAsDataURL(file);
  }

  function loadLogoTextImageMaskUrl(url) {
    const s = String(url || '').trim();
    if (!s) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const dataUrl = canvas.toDataURL('image/png');
        const lp = getLogoPaint();
        lp.src = dataUrl;
        state.presetName = '';
        syncControls();
        update();
        save();
        showToast('画像を適用しました', 'success');
      } catch (err) {
        const lp = getLogoPaint();
        lp.src = s;
        state.presetName = '';
        syncControls();
        update();
        save();
        showToast('URL画像を適用しました', 'success');
      }
    };
    img.onerror = () => showToast('画像の読み込みに失敗しました。URLを確認してください', 'error');
    img.src = s;
  }

  function buildIconGrid() {
    const host = $('icon-grid');
    host.innerHTML = '';
    A.ICONS.filter(i => i.group === state.iconGroup).forEach(icon => {
      const b = el('button', { class: 'icon-btn' + (state.style.logo.icon === icon.id ? ' active' : ''), type: 'button', title: icon.name, 'aria-label': icon.name });
      const svgNS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('viewBox', icon.vb);
      if (icon.rawSvg) {
        svg.innerHTML = icon.rawSvg.replace(/__UID__/g, 'grid_' + icon.id);
      } else {
        svg.setAttribute('fill', 'currentColor');
        icon.p.forEach(p => {
          const path = document.createElementNS(svgNS, 'path');
          path.setAttribute('d', p.d);
          if (p.e) path.setAttribute('fill-rule', 'evenodd');
          svg.appendChild(path);
        });
      }
      b.appendChild(svg);
      b.addEventListener('click', () => {
        state.style.logo.icon = icon.id;
        state.style.logo.iconData = icon;
        state.style.logo.type = 'icon';
        if (A.BRAND_COLORS[icon.id]) {
          state.style.logo.color = A.BRAND_COLORS[icon.id];
        }
        state.presetName = '';
        buildIconGrid();
        syncControls();
        update();
      });
      host.appendChild(b);
    });
  }

  function buildFrameChips() {
    const host = $('frame-chips');
    host.innerHTML = '';
    A.FRAMES.forEach(f => {
      const b = el('button', { class: 'chip' + (state.style.frame.type === f.id ? ' active' : ''), type: 'button' }, f.name);
      b.addEventListener('click', () => {
        state.style.frame.type = f.id;
        state.presetName = '';
        buildFrameChips();
        syncControls();
        update();
      });
      host.appendChild(b);
    });
    $('hint-frame').textContent = (A.FRAMES.find(f => f.id === state.style.frame.type) || {}).name || 'なし';
  }

  // ------------------------------------------------------------------
  // 画面と状態の同期
  // ------------------------------------------------------------------
  const asEl = x => (typeof x === 'string' ? $(x) : x);

  function setSeg(hostId, value, attr) {
    const host = asEl(hostId);
    if (!host) return;
    Array.prototype.forEach.call(host.children, b => {
      b.classList.toggle('active', b.dataset[attr] === value);
    });
  }

  // 色パネル1枚ぶんの表示を、その対象の塗りに合わせる
  function syncColorPanel(scope) {
    if (!colorPanel(scope)) return;
    const target = scopeTarget(scope);
    const p = paintOfScope(scope);
    const isCell = target === 'cell';
    const isBg = target === 'bg';
    const isLogoBd = target === 'logobd';
    // 背景とロゴの下地は「敷く面」なので、白・黒・透明まで選べる
    const isPlate = isBg || isLogoBd;

    [['btn-mode-white', !isPlate], ['btn-mode-black', !isPlate],
     ['btn-mode-none', !isPlate], ['btn-mode-auto', isCell]].forEach(pair => {
      const b = cq(scope, pair[0]);
      if (!b) return;
      b.classList.toggle('hidden', pair[1]);
      b.hidden = pair[1];
    });

    setSeg(cq(scope, 'color-mode-seg'), p.type, 'mode');

    const isWhite = p.type === 'white';
    const isBlack = p.type === 'black';
    const isAuto = p.type === 'auto';
    const isNone = p.type === 'none';
    const isSolid = p.type === 'solid';
    const isGrad = p.type === 'linear' || p.type === 'radial';
    const isMulti = p.type === 'multi';
    const isImage = p.type === 'image';

    [['pane-white', isWhite], ['pane-black', isBlack], ['pane-auto', isAuto],
     ['pane-none', isNone], ['pane-solid', isSolid], ['pane-grad', isGrad],
     ['pane-multi', isMulti], ['pane-image', isImage]].forEach(pair => {
      const pane = cq(scope, pair[0]);
      if (pane) pane.classList.toggle('hidden', !pair[1]);
    });

    const plateWord = isLogoBd ? 'ロゴの下地' : '背景';
    const autoNotice = cq(scope, 'auto-notice');
    if (autoNotice) {
      autoNotice.innerHTML = isBg
        ? 'セルの色設定と連動します。<br>グラデーション・放射・画像・多色のテクスチャが指定の透明度で背景に反映されます。'
        : 'セルの色設定と連動します。<br>グラデーション・放射・画像の時はセルと一体の連続したテクスチャとして描画されます。';
    }
    const whiteNotice = cq(scope, 'white-notice');
    if (whiteNotice) whiteNotice.textContent = plateWord + 'を不透明な白（#FFFFFF）に固定します。';
    const blackNotice = cq(scope, 'black-notice');
    if (blackNotice) blackNotice.textContent = plateWord + 'を不透明な黒（#000000）に固定します。';
    const noneNotice = cq(scope, 'none-notice');
    if (noneNotice) {
      noneNotice.innerHTML = isLogoBd
        ? 'ロゴの下地を描きません。<br>セルを消す範囲（下地の形）はそのまま残るので、背景が抜けて見えます。'
        : '背景を透明にします。<br>透過PNGや透過SVGとして背景のない画像を書き出せます。';
    }

    const swatchHost = cq(scope, 'swatch-host');
    if (swatchHost) swatchHost.classList.toggle('hidden', isImage || isAuto || isNone || isWhite || isBlack);

    const transRow = cq(scope, 'transparency-row');
    if (transRow) transRow.classList.toggle('hidden', !isPlate || isNone || isWhite || isBlack);
    const transVal = p.transparency !== undefined ? p.transparency : (isLogoBd ? 0 : 80);
    const transInput = cq(scope, 'transparency');
    if (transInput) transInput.value = transVal;
    const transLabel = cq(scope, 'val-transparency');
    if (transLabel) transLabel.textContent = transVal + '%';

    const fallback = isPlate ? '#FFFFFF' : '#111827';
    const picker = cq(scope, 'color-picker');
    const hex = cq(scope, 'color-hex');
    if (picker) picker.value = normHex(p.color, fallback);
    if (hex) hex.value = normHex(p.color, fallback);

    const angle = cq(scope, 'angle');
    if (angle) angle.value = p.angle || 45;
    const angleLabel = cq(scope, 'val-angle');
    if (angleLabel) angleLabel.textContent = (p.angle || 45) + '°';
    const angleRow = cq(scope, 'angle-row');
    if (angleRow) angleRow.classList.toggle('hidden', p.type === 'radial');

    const thumb = cq(scope, 'image-thumb');
    if (thumb) {
      thumb.classList.toggle('hidden', !(isImage && p.src));
      const img = cq(scope, 'image-thumb-img');
      if (p.src && img) img.src = p.src;
    }

    if (isMulti) buildMultiColorsList(scope);
    else if (isGrad) buildGradColorsList(scope);
  }

  function syncControls() {
    const s = state.style;

    $('opt-ec').value = state.ec;
    $('opt-size').value = String(state.exportSize);

    COLOR_SCOPES.forEach(syncColorPanel);

    // 見出しの脇に出す要約
    $('hint-shape-color').textContent = paintLabel(state.style.fg);
    $('hint-bg').textContent = paintLabel(state.style.bg);

    $('opt-cellscale').value = s.cellScale;
    $('val-cellscale').textContent = Math.round(s.cellScale * 100) + '%';
    $('opt-celljitter').value = s.cellJitter || 0;
    $('val-celljitter').textContent = Math.round((s.cellJitter || 0) * 100) + '%';
    $('opt-margin').value = s.margin;
    $('val-margin').textContent = s.margin;
    // 角丸の上限は余白しだい（qr-style.js 側の丸め上限と合わせる）
    const maxRadius = Math.round(s.margin * 1.5 * 2) / 2;
    if (s.radius > maxRadius) s.radius = maxRadius;
    $('opt-radius').max = maxRadius;
    $('opt-radius').value = s.radius;
    $('opt-radius').disabled = maxRadius === 0;
    $('val-radius').textContent = maxRadius === 0 ? '—' : s.radius;
    $('opt-minver').value = state.minVersion;
    $('val-minver').textContent = state.minVersion <= 1 ? '自動' : 'v' + state.minVersion + '以上';

    setSeg('logo-mode', s.logo.type, 'mode');
    $('logo-icon-pane').classList.toggle('hidden', s.logo.type !== 'icon');
    $('logo-image-pane').classList.toggle('hidden', s.logo.type !== 'image');
    $('logo-text-pane').classList.toggle('hidden', s.logo.type !== 'text');
    $('logo-common').classList.toggle('hidden', s.logo.type === 'none');

    const isBrandGroup = state.iconGroup === 'brand';
    const brandModeBtn = $('btn-logo-mode-brand');
    if (brandModeBtn) {
      brandModeBtn.classList.toggle('hidden', !isBrandGroup);
      brandModeBtn.hidden = !isBrandGroup;
    }

    const lp = getLogoPaint();
    if (!isBrandGroup && lp.type === 'brand') {
      lp.type = 'auto';
    }

    setSeg('logo-color-mode-seg', lp.type, 'mode');

    const isLBrand = lp.type === 'brand';
    const isLAuto = lp.type === 'auto';
    const isLSolid = lp.type === 'solid';
    const isLMulti = lp.type === 'multi';
    const isLGrad = lp.type === 'linear' || lp.type === 'radial';
    const isLImage = lp.type === 'image';

    const pBrand = $('logo-pane-brand');
    if (pBrand) pBrand.classList.toggle('hidden', !isLBrand);
    const brandNotice = $('logo-brand-notice');
    if (brandNotice) {
      const curIcon = A.ICONS.find(i => i.id === s.logo.icon);
      const isRaw = curIcon && !!curIcon.rawSvg;
      brandNotice.textContent = isRaw
        ? '※ 公式マルチカラーで表示されます。'
        : '※ ブランド公式の指定色で表示されます。';
    }

    const pAuto = $('logo-pane-auto');
    if (pAuto) pAuto.classList.toggle('hidden', !isLAuto);

    const pSolid = $('logo-pane-solid');
    if (pSolid) pSolid.classList.toggle('hidden', !isLSolid);
    const solidPicker = $('logo-solid-picker');
    const solidHex = $('logo-solid-hex');
    if (solidPicker) solidPicker.value = normHex(lp.color, '#111827');
    if (solidHex) solidHex.value = normHex(lp.color, '#111827');

    const pMulti = $('logo-pane-multi');
    if (pMulti) pMulti.classList.toggle('hidden', !isLMulti);
    if (isLMulti) buildLogoMultiColorsList();

    const pGrad = $('logo-pane-grad');
    if (pGrad) pGrad.classList.toggle('hidden', !isLGrad);
    const logoGradAngleRow = $('logo-grad-angle-row');
    if (logoGradAngleRow) logoGradAngleRow.classList.toggle('hidden', lp.type === 'radial');
    const angleRange = $('logo-target-angle');
    const angleVal = $('val-logo-target-angle');
    if (angleRange) angleRange.value = lp.angle || 45;
    if (angleVal) angleVal.textContent = (lp.angle || 45) + '°';
    if (isLGrad) buildLogoGradColorsList();

    const pImage = $('logo-pane-image');
    if (pImage) pImage.classList.toggle('hidden', !isLImage);
    const imgMaskThumb = $('logo-image-mask-thumb');
    if (imgMaskThumb) {
      imgMaskThumb.classList.toggle('hidden', !(isLImage && lp.src));
      if (lp.src) $('logo-image-mask-thumb-img').src = lp.src;
    }
    // 文字（Text）用の同期
    setSeg('logo-font-seg', s.logo.font || 'sans', 'font');
    setSeg('logo-text-color-mode-seg', lp.type, 'mode');

    const pTextAuto = $('logo-text-pane-auto');
    if (pTextAuto) pTextAuto.classList.toggle('hidden', !isLAuto);

    const pTextSolid = $('logo-text-pane-solid');
    if (pTextSolid) pTextSolid.classList.toggle('hidden', !isLSolid);
    const textSolidPicker = $('logo-text-solid-picker');
    const textSolidHex = $('logo-text-solid-hex');
    if (textSolidPicker) textSolidPicker.value = normHex(lp.color, '#111827');
    if (textSolidHex) textSolidHex.value = normHex(lp.color, '#111827');

    const pTextMulti = $('logo-text-pane-multi');
    if (pTextMulti) pTextMulti.classList.toggle('hidden', !isLMulti);
    if (isLMulti) buildLogoTextMultiColorsList();

    const pTextGrad = $('logo-text-pane-grad');
    if (pTextGrad) pTextGrad.classList.toggle('hidden', !isLGrad);
    const textLogoGradAngleRow = $('logo-text-grad-angle-row');
    if (textLogoGradAngleRow) textLogoGradAngleRow.classList.toggle('hidden', lp.type === 'radial');
    const textAngleRange = $('logo-text-target-angle');
    const textAngleVal = $('val-logo-text-target-angle');
    if (textAngleRange) textAngleRange.value = lp.angle || 45;
    if (textAngleVal) textAngleVal.textContent = (lp.angle || 45) + '°';
    if (isLGrad) buildLogoTextGradColorsList();

    const pTextImage = $('logo-text-pane-image');
    if (pTextImage) pTextImage.classList.toggle('hidden', !isLImage);
    const textImgMaskThumb = $('logo-text-image-mask-thumb');
    if (textImgMaskThumb) {
      textImgMaskThumb.classList.toggle('hidden', !(isLImage && lp.src));
      if (lp.src) $('logo-text-image-mask-thumb-img').src = lp.src;
    }
    $('logo-text').value = s.logo.text || '';
    $('logo-size').value = s.logo.size;
    $('val-logosize').textContent = Math.round(s.logo.size * 100) + '%';
    $('logo-pad').value = s.logo.pad;
    $('val-logopad').textContent = Math.round(s.logo.pad * 100) + '%';
    $('logo-thumb').classList.toggle('hidden', !(s.logo.type === 'image' && s.logo.src));
    if (s.logo.src) $('logo-thumb-img').src = s.logo.src;
    $('hint-logo').textContent = s.logo.type === 'none' ? 'なし'
      : s.logo.type === 'icon' ? ((A.ICONS.find(i => i.id === s.logo.icon) || {}).name || 'アイコン')
      : s.logo.type === 'image' ? '画像' : '文字';

    $('frame-opts').classList.toggle('hidden', s.frame.type === 'none' || s.frame.type === 'line');
    $('frame-text').value = s.frame.text;
    $('frame-color').value = normHex(s.frame.color, '#111827');
    $('frame-textcolor').value = normHex(s.frame.textColor, '#FFFFFF');
    if (s.frame.type === 'line') {
      $('frame-opts').classList.remove('hidden');
      $('frame-text').parentElement.classList.add('hidden');
    } else {
      $('frame-text').parentElement.classList.remove('hidden');
    }
    updateCanvasChecker();
  }

  // ------------------------------------------------------------------
  // 描画
  // ------------------------------------------------------------------
  let lastSvg = '';
  let lastPayload = '';
  let renderTimer = null;
  let verifyTimer = null;

  function scheduleUpdate() {
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(update, 90);
  }

  function scheduleVerify(svg, text, heavy, delay) {
    if (verifyTimer) clearTimeout(verifyTimer);
    verifyTimer = setTimeout(() => {
      verifyTimer = null;
      verify(svg, text, heavy);
    }, delay || 180);
  }

  function update(opts) {
    if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
    save();

    const text = payload();
    lastPayload = text;

    const alerts = $('alerts');
    alerts.innerHTML = '';
    const meta = $('meta-row');
    meta.innerHTML = '';

    if (!text) {
      if (verifyTimer) { clearTimeout(verifyTimer); verifyTimer = null; }
      $('preview').innerHTML = '';
      lastSvg = '';
      setVerdict('na', '待機中', '内容を入力するとここに出ます', []);
      syncVerifyButton(false);
      setStatus('ready', 'idle');
      return;
    }

    let qr;
    try {
      qr = window.QRCore.encode(text, { ec: state.ec, minVersion: state.minVersion });
    } catch (e) {
      if (verifyTimer) { clearTimeout(verifyTimer); verifyTimer = null; }
      $('preview').innerHTML = '';
      lastSvg = '';
      setVerdict('ng', '入りきりません', '文字数を減らすか、誤り訂正レベルを下げてください', []);
      syncVerifyButton(false);
      pushAlert('error', 'この内容はQRコードの上限（バージョン40）を超えています。文字数を減らしてください。');
      setStatus('too long', 'err');
      return;
    }

    const out = window.QRStyle.render(qr, state.style);
    lastSvg = out.svg;
    $('preview').innerHTML = out.svg;

    [['v' + qr.version, 'バージョン'], [qr.size + '×' + qr.size, 'モジュール'],
     ['EC ' + qr.ec, '誤り訂正'], [new TextEncoder().encode(text).length + ' B', 'データ量'],
     ['コントラスト ' + out.contrast.toFixed(1) + ':1', '']].forEach(m => {
      meta.appendChild(el('span', { class: 'meta', title: m[1] }, m[0]));
    });

    out.warnings.forEach(w => pushAlert(w.level, w.text));
    setStatus('v' + qr.version + ' / ' + qr.ec, 'idle');

    if (opts && opts.debounceVerify) {
      scheduleVerify(out.svg, text, false, 180);
    } else {
      if (verifyTimer) { clearTimeout(verifyTimer); verifyTimer = null; }
      verify(out.svg, text, false);
    }
    updateCanvasChecker();
  }

  function pushAlert(level, text) {
    const a = el('div', { class: 'alert' + (level === 'error' ? ' error' : '') });
    a.appendChild(el('span', null, text));
    $('alerts').appendChild(a);
  }

  // ------------------------------------------------------------------
  // 読み取りテスト
  // ------------------------------------------------------------------
  // 判定は qr-verify.js に任せて、ここは表示だけ。ひとつのデコーダの失敗を
  // 「読めません」と断定しないのが肝。デコーダの寛容さは一直線には並ばない
  // （jsQR だけ落ちる形と、ZXing だけ落ちる形の両方がある）ので、通った数では
  // なく「落ちたもののうちいちばん深刻なもの」で言い方を決める。
  const PARTIAL = {
    1: '読めます（機種による）',
    2: '読めます（一部アプリで注意）',
    3: '読めない環境がありそうです'
  };

  function setVerdict(kind, title, note, engines) {
    $('verdict').className = 'verdict ' + kind;
    $('verdict-title').textContent = title;
    $('verdict-note').textContent = note || '';
    const box = $('verdict-engines');
    box.innerHTML = '';
    (engines || []).forEach(e => {
      const out = e.state === 'unavailable';
      const chip = el('span', { class: 'eng ' + e.state,
        title: out ? '読み込めなかったため、このデコーダでは確かめられていません' : e.note });
      chip.appendChild(el('i'));
      chip.appendChild(el('span', null, e.name + (out ? '（読み込めず）' : '')));
      box.appendChild(chip);
    });
  }

  function moduleWidth(svg) {
    const m = svg.match(/viewBox="0 0 ([0-9.]+) /);
    return m ? parseFloat(m[1]) : 41;
  }

  // 足りない余白を補うときの色。透明のときは白、単色のときはその色。
  function padColor() {
    const bg = state.style.bg;
    if (bg.type === 'none') return '#FFFFFF';
    if (bg.type === 'white') return '#FFFFFF';
    if (bg.type === 'black') return '#000000';
    if (bg.type === 'solid') return bg.color;
    if (bg.type === 'image') return bg.color || '#FFFFFF';
    if (bg.mid) return bg.mid;
    const mix = (a, b) => {
      const n = h => [1, 3, 5].map(i => parseInt(h.substr(i, 2), 16));
      const x = n(a), y = n(b);
      return '#' + x.map((v, i) => Math.round((v + y[i]) / 2).toString(16).padStart(2, '0')).join('');
    };
    return mix(bg.from, bg.to);
  }

  // デコーダを読み込んだあとの検査は数十msで終わる。結果が前と同じだと画面が
  // まったく動かず、走ったのかどうか分からないので、終わるたびに枠を短く光らせ、
  // 時刻を出す。検査そのものは引き延ばさない。
  function markChecked() {
    const v = $('verdict');
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    $('verdict-time').textContent = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    v.classList.remove('flash');
    void v.offsetWidth;               // アニメーションを毎回やり直させる
    v.classList.add('flash');
  }

  // 検査するものが無いときは押せないようにしておく。押しても何も起きない
  // ボタンは、壊れているのか押せていないのか区別がつかない。
  // ボタンは重いデコーダを取りに行くためだけのもの。一度読み込めば以後は
  // 自動チェックに混ざるので、押し直す意味がない。読み込み済みなら消す。
  // 直近の検査で読み込めなかったデコーダの名前
  let missingNames = [];

  // 読み込めなかったデコーダがあるあいだはボタンを残す。qr-verify 側が
  // 壊れたデコーダの読み込みキャッシュを捨てるので、押せば再試行になる。
  function syncVerifyButton(enabled) {
    const btn = $('btn-verify');
    btn.hidden = !!(window.QRVerify && window.QRVerify.heavyLoaded());
    btn.disabled = !enabled;
    btn.textContent = missingNames.length ? 'もう一度読み込む' : '詳しく検査';
    if (!enabled) $('verdict-time').textContent = '';
  }

  async function verify(svg, expect, heavy) {
    if (!window.QRVerify) {
      setVerdict('na', '読み取りテスト非対応', 'この環境では自動チェックできません', []);
      return;
    }
    const pad = padColor();
    setVerdict('na', 'チェック中…', '', []);
    syncVerifyButton(true);
    try {
      const run = window.QRVerify.run({
        render: px => rasterize(svg, px, pad),
        expect: expect,
        moduleWidth: moduleWidth(svg),
        margin: state.style.margin,
        padColor: pad,
        heavy: heavy,
        onProgress: t => setVerdict('na', t, '', [])
      });
      const r = await run;
      if (!r) return;                       // 新しい検査に追い越された
      // 読み込めなかったデコーダは「読めなかった」ではない。確かめられていない
      // だけなので、判定の分母から外したうえで、その旨をはっきり添える。
      missingNames = r.engines.filter(e => e.state === 'unavailable').map(e => e.name);
      const missing = missingNames.length
        ? '（' + missingNames.join('と') + 'は読み込めず、確認できていません）' : '';
      syncVerifyButton(true);

      if (!r.ran) {
        setVerdict('na', 'チェックできません',
          'デコーダを読み込めませんでした。通信状態を確かめて、もう一度お試しください',
          r.engines);
      } else if (r.level === 'ng' && !window.QRVerify.heavyLoaded()) {
        // 軽いデコーダしか動いていない段階での失敗は、証拠として弱い。jsQR は
        // 装飾に厳しく、そこで落ちても実機では読めることが多い。断定せずに
        // 詳しい検査へ誘導する。
        setVerdict('fair', '簡易チェックでは読めません',
          '実機のカメラなら読めることがあります。「詳しく検査」で確かめてください', r.engines);
      } else if (r.level === 'ng') {
        setVerdict('ng', r.mismatch ? '内容がずれています' : '読み取れませんでした',
          r.mismatch ? '別の内容として読まれています。ロゴや装飾を控えめにしてください'
                     : 'コントラスト・ロゴの大きさ・余白を見直してください', r.engines);
      } else if (r.level === 'best') {
        setVerdict('ok', '読み取りOK',
          (r.ran > 1 ? r.ran + 'つのデコーダすべてが' : '') + '全解像度で成功。' +
          (missing ? '確かめられた範囲では問題ありません' + missing
                   : 'どの読み取り環境でも読めます'), r.engines);
      } else {
        const bad = r.engines.filter(e => e.state !== 'ok' && e.state !== 'unavailable')
          .sort((a, b) => b.severity - a.severity);
        const worst = bad[0];
        // 実機系（severity 3）とアプリ系（2）が全部通っているなら、残りは jsQR の
        // 苦手な形というだけ。これで警告を出すと形の半分以上が黄色になり、直した
        // はずの偽陰性が戻ってくる。緑のまま、事実だけ添える。
        const strong = r.engines.filter(e => e.severity >= 2 && e.state !== 'unavailable');
        if (strong.length && strong.every(e => e.state === 'ok')) {
          setVerdict('ok', '読み取りOK',
            '実機のカメラでもスキャナアプリでも読めます。' + worst.name +
            'のような簡素なデコーダだけが苦手な形です' + missing, r.engines);
        } else if (worst.severity >= 3 && worst.state === 'partial') {
          // 実機系までもが「一部の解像度でしか読めない」＝解像度依存。書き出した
          // 画像をそのまま読ませると失敗するので、そこを名指しで言う。
          setVerdict('fair', '解像度によって読めません',
            '小さく写したときは読めますが、拡大すると読めなくなります。' +
            '書き出した画像をそのまま読ませると失敗する可能性が高いので、' +
            'マーカーの目や太さのバラつきを控えめにしてください' + missing, r.engines);
        } else {
          setVerdict('fair', PARTIAL[worst.severity],
            r.passed + '/' + r.ran + 'のデコーダで安定。' + worst.name +
            (worst.state === 'partial' ? 'は一部の解像度でしか読めず、' : 'では読めず、') +
            worst.onFail + missing, r.engines);
        }
      }
      markChecked();   // setVerdict が class を書き換えるので、必ずその後で
    } catch (e) {
      setVerdict('na', 'チェックできず', '', []);
    }
  }

  // ------------------------------------------------------------------
  // 書き出し
  // ------------------------------------------------------------------
  // 画像の読み込み待ちは onload ではなく decode() を使う。onload は描画の
  // 都合で発火が遅れたり落ちたりすることがあり、読み取りテストのように
  // 短い間隔で何枚も起こすと止まってしまう。
  async function svgToImage(svg, px) {
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(window.QRStyle.resize(svg, px));
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

  function fileStem() {
    const d = new Date();
    const p = v => String(v).padStart(2, '0');
    return 'qr-' + state.type + '-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    // 書き出しまで届いた＝この人の用は足りた。共通の「よかったらシェアを」。
    if (window.STShare) STShare.celebrate();
  }

  async function exportRaster(mime, ext, quality) {
    if (!lastSvg) { showToast('先に内容を入力してください', 'error'); return; }
    setStatus('rendering', '');
    try {
      const flatten = mime === 'image/jpeg' ? '#FFFFFF' : null;
      const canvas = await rasterize(lastSvg, state.exportSize, flatten);
      const blob = await new Promise(res => canvas.toBlob(res, mime, quality));
      if (!blob) throw new Error('encode failed');
      saveBlob(blob, fileStem() + '.' + ext);
      showToast(ext.toUpperCase() + 'を保存しました');
    } catch (e) {
      showToast('書き出しに失敗しました', 'error');
    }
    setStatus('ready', 'idle');
  }

  function exportSvg() {
    if (!lastSvg) { showToast('先に内容を入力してください', 'error'); return; }
    const doc = '<?xml version="1.0" encoding="UTF-8"?>' + String.fromCharCode(10) +
      window.QRStyle.resize(lastSvg, 1024);
    saveBlob(new Blob([doc], { type: 'image/svg+xml;charset=utf-8' }), fileStem() + '.svg');
    showToast('SVGを保存しました');
  }

  async function copyImage() {
    if (!lastSvg) { showToast('先に内容を入力してください', 'error'); return; }
    if (!navigator.clipboard || typeof window.ClipboardItem === 'undefined') {
      showToast('このブラウザは画像コピーに対応していません', 'error');
      return;
    }
    try {
      const canvas = await rasterize(lastSvg, Math.min(2048, state.exportSize), null);
      const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
      await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })]);
      showToast('画像をコピーしました');
    } catch (e) {
      showToast('コピーできませんでした', 'error');
    }
  }

  // ------------------------------------------------------------------
  // 配線
  // ------------------------------------------------------------------
  function bindColor(pickerId, hexId, apply) {
    const picker = asEl(pickerId);
    if (!picker) return;
    const hex = hexId ? asEl(hexId) : null;
    picker.addEventListener('input', () => {
      const v = normHex(picker.value, '#000000');
      if (hex) hex.value = v;
      apply(v);
      state.presetName = '';
      buildPresets();
      update();
    });
    if (hex) {
      hex.addEventListener('change', () => {
        const v = normHex(hex.value, null);
        if (!v) { showToast('カラーコードの形式が違います', 'error'); return; }
        hex.value = v;
        picker.value = v;
        apply(v);
        state.presetName = '';
        buildPresets();
        update();
      });
    }
  }

  function bindSeg(hostId, attr, apply) {
    const host = asEl(hostId);
    if (!host) return;
    Array.prototype.forEach.call(host.children, b => {
      b.addEventListener('click', () => {
        apply(b.dataset[attr]);
        state.presetName = '';
        syncControls();
        buildPresets();
        update();
      });
    });
  }

  function bindRange(id, labelId, format, apply) {
    const input = asEl(id);
    if (!input) return;
    const label = asEl(labelId);
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      if (label) label.textContent = format(v);
      apply(v);
      state.presetName = '';
      update({ debounceVerify: true });
    });
    input.addEventListener('change', () => {
      if (verifyTimer) {
        clearTimeout(verifyTimer);
        verifyTimer = null;
        if (lastSvg && lastPayload) verify(lastSvg, lastPayload, false);
      }
    });
  }

  // テンプレートから色パネルを起こし、そのスコープ専用に結線する
  function buildColorPanels() {
    const tpl = $('color-panel-tpl');
    if (!tpl) return;
    COLOR_SCOPES.forEach(scope => {
      const host = colorPanel(scope);
      if (!host || host.childElementCount) return;
      host.appendChild(tpl.content.cloneNode(true));
    });
  }

  function wireColorPanel(scope) {
    if (!colorPanel(scope)) return;
    const touch = () => { state.colorScope = scope; };

    bindSeg(cq(scope, 'color-mode-seg'), 'mode', v => {
      touch();
      paintOfScope(scope).type = v;
    });

    bindColor(cq(scope, 'color-picker'), cq(scope, 'color-hex'), v => {
      touch();
      paintOfScope(scope).color = v;
    });
    bindRange(cq(scope, 'angle'), cq(scope, 'val-angle'), v => v + '°', v => {
      touch();
      paintOfScope(scope).angle = v;
    });
    bindRange(cq(scope, 'transparency'), cq(scope, 'val-transparency'), v => Math.round(v) + '%', v => {
      touch();
      paintOfScope(scope).transparency = Math.round(v);
    });

    const addColor = cq(scope, 'btn-add-color');
    if (addColor) addColor.addEventListener('click', () => {
      touch();
      const p = paintOfScope(scope);
      if (!Array.isArray(p.colors)) p.colors = ['#2563EB', '#7C3AED', '#DB2777'];
      if (p.colors.length >= 8) return;
      const candidates = ['#EF4444', '#F59E0B', '#10B981', '#06B6D4', '#6366F1', '#EC4899', '#8B5CF6', '#14B8A6'];
      p.colors.push(candidates.find(c => p.colors.indexOf(c) < 0) ||
        candidates[Math.floor(Math.random() * candidates.length)]);
      state.presetName = '';
      syncControls();
      update();
    });

    const shuffleColor = cq(scope, 'btn-shuffle-color');
    if (shuffleColor) shuffleColor.addEventListener('click', () => {
      touch();
      const p = paintOfScope(scope);
      p.seed = (p.seed || 0) + 1;
      update();
    });

    const addGrad = cq(scope, 'btn-add-grad-color');
    if (addGrad) addGrad.addEventListener('click', () => {
      touch();
      const p = paintOfScope(scope);
      if (p.mid) return;
      p.mid = blendHex(p.from || '#FC466B', p.to || '#3F5EFB');
      state.presetName = '';
      syncControls();
      update();
    });

    // 画像
    const drop = cq(scope, 'image-drop');
    const fileInput = cq(scope, 'image-file');
    if (drop && fileInput) {
      drop.addEventListener('click', () => { touch(); fileInput.click(); });
      drop.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); touch(); fileInput.click(); }
      });
      ['dragenter', 'dragover'].forEach(nm => drop.addEventListener(nm, e => {
        e.preventDefault(); e.stopPropagation(); drop.classList.add('dragover');
      }));
      ['dragleave', 'drop'].forEach(nm => drop.addEventListener(nm, e => {
        e.preventDefault(); e.stopPropagation(); drop.classList.remove('dragover');
      }));
      drop.addEventListener('drop', e => {
        e.preventDefault(); e.stopPropagation();
        touch();
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
          loadTargetImage(e.dataTransfer.files[0]);
        } else if (e.dataTransfer) {
          const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
          if (url) loadTargetImageUrl(url);
        }
      });
      fileInput.addEventListener('change', e => {
        touch();
        if (e.target.files && e.target.files.length) loadTargetImage(e.target.files[0]);
      });
    }
    const clearBtn = cq(scope, 'btn-image-clear');
    if (clearBtn) clearBtn.addEventListener('click', () => {
      touch();
      const p = paintOfScope(scope);
      p.src = '';
      p.type = (scope === 'frame' || scope === 'eye') ? 'auto' : 'solid';
      if (fileInput) fileInput.value = '';
      syncControls();
      update();
    });
    const urlBtn = cq(scope, 'btn-image-url');
    const urlInput = cq(scope, 'image-url');
    if (urlBtn && urlInput) {
      urlBtn.addEventListener('click', () => { touch(); loadTargetImageUrl(urlInput.value); });
      urlInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); touch(); loadTargetImageUrl(urlInput.value); }
      });
    }
  }

  function wire() {
    $('opt-ec').addEventListener('change', e => { state.ec = e.target.value; syncControls(); update(); });
    $('opt-size').addEventListener('change', e => { state.exportSize = parseInt(e.target.value, 10); save(); });

    COLOR_SCOPES.forEach(wireColorPanel);

    bindSeg('logo-mode', 'mode', v => {
      state.style.logo.type = v;
      if (v === 'icon' && !state.style.logo.iconData) {
        const first = A.ICONS.find(i => i.group === state.iconGroup) || A.ICONS[0];
        state.style.logo.icon = first.id;
        state.style.logo.iconData = first;
        if (A.BRAND_COLORS[first.id]) {
          state.style.logo.color = A.BRAND_COLORS[first.id];
        }
        buildIconGrid();
      }
    });

    bindColor('logo-text-color', null, v => { state.style.logo.color = v; });

    bindSeg('logo-color-mode-seg', 'mode', v => {
      getLogoPaint().type = v;
      state.presetName = '';
      syncControls();
      update();
      save();
    });

    bindColor('logo-solid-picker', 'logo-solid-hex', v => {
      getLogoPaint().color = v;
      state.style.logo.color = v;
      state.presetName = '';
      update();
    });
    bindRange('logo-target-angle', 'val-logo-target-angle', v => v + '°', v => {
      getLogoPaint().angle = v;
      state.presetName = '';
      update();
    });

    const addLogoColorBtn = $('btn-logo-add-color');
    if (addLogoColorBtn) {
      addLogoColorBtn.addEventListener('click', () => {
        const lp = getLogoPaint();
        if (!Array.isArray(lp.colors)) lp.colors = ['#2563EB', '#7C3AED'];
        if (lp.colors.length >= 8) return;
        const last = lp.colors[lp.colors.length - 1];
        const prev = lp.colors.length > 1 ? lp.colors[lp.colors.length - 2] : '#2563EB';
        lp.colors.push(blendHex(last, prev));
        state.presetName = '';
        syncControls();
        update();
        save();
      });
    }

    const shuffleLogoColorBtn = $('btn-logo-shuffle-color');
    if (shuffleLogoColorBtn) {
      shuffleLogoColorBtn.addEventListener('click', () => {
        const lp = getLogoPaint();
        if (!Array.isArray(lp.colors) || lp.colors.length <= 1) return;
        for (let i = lp.colors.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          const t = lp.colors[i];
          lp.colors[i] = lp.colors[j];
          lp.colors[j] = t;
        }
        lp.seed = (lp.seed || 0) + 1;
        state.presetName = '';
        syncControls();
        update();
        save();
      });
    }

    const addLogoGradColorBtn = $('btn-logo-add-grad-color');
    if (addLogoGradColorBtn) {
      addLogoGradColorBtn.addEventListener('click', () => {
        const lp = getLogoPaint();
        if (lp.mid) return;
        lp.mid = blendHex(lp.from || '#FC466B', lp.to || '#3F5EFB');
        state.presetName = '';
        syncControls();
        update();
        save();
      });
    }

    // アイコン画像マスク
    const maskDrop = $('logo-image-mask-drop');
    const maskFileInput = $('logo-image-mask-file');
    if (maskDrop && maskFileInput) {
      maskDrop.addEventListener('click', () => maskFileInput.click());
      maskDrop.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); maskFileInput.click(); }
      });
      ['dragenter', 'dragover'].forEach(name => maskDrop.addEventListener(name, e => {
        e.preventDefault(); e.stopPropagation(); maskDrop.classList.add('dragover');
      }));
      ['dragleave', 'drop'].forEach(name => maskDrop.addEventListener(name, e => {
        e.preventDefault(); e.stopPropagation(); maskDrop.classList.remove('dragover');
      }));
      maskDrop.addEventListener('drop', e => {
        e.preventDefault(); e.stopPropagation(); maskDrop.classList.remove('dragover');
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
          loadLogoImageMask(e.dataTransfer.files[0]);
        } else if (e.dataTransfer) {
          const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
          if (url) loadLogoImageMaskUrl(url);
        }
      });
      maskFileInput.addEventListener('change', e => {
        if (e.target.files && e.target.files.length) {
          loadLogoImageMask(e.target.files[0]);
        }
      });
    }

    const btnLogoMaskUrl = $('btn-logo-image-mask-url');
    if (btnLogoMaskUrl) {
      btnLogoMaskUrl.addEventListener('click', () => {
        const urlInput = $('logo-image-mask-url');
        if (urlInput && urlInput.value) {
          loadLogoImageMaskUrl(urlInput.value);
        }
      });
    }

    const btnLogoMaskClear = $('btn-logo-image-mask-clear');
    if (btnLogoMaskClear) {
      btnLogoMaskClear.addEventListener('click', () => {
        const lp = getLogoPaint();
        lp.src = '';
        state.presetName = '';
        syncControls();
        update();
        save();
      });
    }
    bindColor('frame-color', null, v => { state.style.frame.color = v; });
    bindColor('frame-textcolor', null, v => { state.style.frame.textColor = v; });
    bindRange('opt-cellscale', 'val-cellscale', v => Math.round(v * 100) + '%', v => { state.style.cellScale = v; });
    bindRange('opt-celljitter', 'val-celljitter', v => Math.round(v * 100) + '%', v => { state.style.cellJitter = v; });
    bindRange('opt-margin', 'val-margin', v => String(v), v => {
      state.style.margin = v;
      // 余白を狭めたら角丸の上限も下がる
      syncControls();
    });
    bindRange('opt-radius', 'val-radius', v => String(v), v => { state.style.radius = v; });
    bindRange('opt-minver', 'val-minver', v => (v <= 1 ? '自動' : 'v' + v + '以上'), v => { state.minVersion = v; });
    bindRange('logo-size', 'val-logosize', v => Math.round(v * 100) + '%', v => { state.style.logo.size = v; });
    bindRange('logo-pad', 'val-logopad', v => Math.round(v * 100) + '%', v => { state.style.logo.pad = v; });

    $('logo-text').addEventListener('input', e => {
      state.style.logo.text = e.target.value;
      state.presetName = '';
      scheduleUpdate();
    });

    bindSeg('logo-font-seg', 'font', v => {
      state.style.logo.font = v;
      state.presetName = '';
      update();
      save();
    });

    bindSeg('logo-text-color-mode-seg', 'mode', v => {
      getLogoPaint().type = v;
      state.presetName = '';
      syncControls();
      update();
      save();
    });

    bindColor('logo-text-solid-picker', 'logo-text-solid-hex', v => {
      getLogoPaint().color = v;
      state.style.logo.color = v;
      state.presetName = '';
      update();
    });
    bindRange('logo-text-target-angle', 'val-logo-text-target-angle', v => v + '°', v => {
      getLogoPaint().angle = v;
      state.presetName = '';
      update();
    });

    const addLogoTextColorBtn = $('btn-logo-text-add-color');
    if (addLogoTextColorBtn) {
      addLogoTextColorBtn.addEventListener('click', () => {
        const lp = getLogoPaint();
        if (!Array.isArray(lp.colors)) lp.colors = ['#2563EB', '#7C3AED'];
        if (lp.colors.length >= 8) return;
        const last = lp.colors[lp.colors.length - 1];
        const prev = lp.colors.length > 1 ? lp.colors[lp.colors.length - 2] : '#2563EB';
        lp.colors.push(blendHex(last, prev));
        state.presetName = '';
        syncControls();
        update();
        save();
      });
    }

    const shuffleLogoTextColorBtn = $('btn-logo-text-shuffle-color');
    if (shuffleLogoTextColorBtn) {
      shuffleLogoTextColorBtn.addEventListener('click', () => {
        const lp = getLogoPaint();
        if (!Array.isArray(lp.colors) || lp.colors.length <= 1) return;
        for (let i = lp.colors.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          const t = lp.colors[i];
          lp.colors[i] = lp.colors[j];
          lp.colors[j] = t;
        }
        lp.seed = (lp.seed || 0) + 1;
        state.presetName = '';
        syncControls();
        update();
        save();
      });
    }

    const addLogoTextGradColorBtn = $('btn-logo-text-add-grad-color');
    if (addLogoTextGradColorBtn) {
      addLogoTextGradColorBtn.addEventListener('click', () => {
        const lp = getLogoPaint();
        if (lp.mid) return;
        lp.mid = blendHex(lp.from || '#FC466B', lp.to || '#3F5EFB');
        state.presetName = '';
        syncControls();
        update();
        save();
      });
    }

    // 文字用画像マスク
    const textMaskDrop = $('logo-text-image-mask-drop');
    const textMaskFileInput = $('logo-text-image-mask-file');
    if (textMaskDrop && textMaskFileInput) {
      textMaskDrop.addEventListener('click', () => textMaskFileInput.click());
      textMaskDrop.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); textMaskFileInput.click(); }
      });
      ['dragenter', 'dragover'].forEach(name => textMaskDrop.addEventListener(name, e => {
        e.preventDefault(); e.stopPropagation(); textMaskDrop.classList.add('dragover');
      }));
      ['dragleave', 'drop'].forEach(name => textMaskDrop.addEventListener(name, e => {
        e.preventDefault(); e.stopPropagation(); textMaskDrop.classList.remove('dragover');
      }));
      textMaskDrop.addEventListener('drop', e => {
        e.preventDefault(); e.stopPropagation(); textMaskDrop.classList.remove('dragover');
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
          loadLogoTextImageMask(e.dataTransfer.files[0]);
        } else if (e.dataTransfer) {
          const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
          if (url) loadLogoTextImageMaskUrl(url);
        }
      });
      textMaskFileInput.addEventListener('change', e => {
        if (e.target.files && e.target.files.length) {
          loadLogoTextImageMask(e.target.files[0]);
        }
      });
    }

    const btnLogoTextMaskUrl = $('btn-logo-text-image-mask-url');
    if (btnLogoTextMaskUrl) {
      btnLogoTextMaskUrl.addEventListener('click', () => {
        const urlInput = $('logo-text-image-mask-url');
        if (urlInput && urlInput.value) {
          loadLogoTextImageMaskUrl(urlInput.value);
        }
      });
    }

    const btnLogoTextMaskClear = $('btn-logo-text-image-mask-clear');
    if (btnLogoTextMaskClear) {
      btnLogoTextMaskClear.addEventListener('click', () => {
        const lp = getLogoPaint();
        lp.src = '';
        state.presetName = '';
        syncControls();
        update();
        save();
      });
    }

    $('frame-text').addEventListener('input', e => {
      state.style.frame.text = e.target.value;
      scheduleUpdate();
    });

    Array.prototype.forEach.call($('icon-tabs').children, b => {
      b.addEventListener('click', () => {
        state.iconGroup = b.dataset.group;
        Array.prototype.forEach.call($('icon-tabs').children, x => x.classList.toggle('active', x === b));
        buildIconGrid();
        syncControls();
        save();
      });
    });

    // ---- ロゴ画像 ----
    const drop = $('logo-drop');
    const fileInput = $('logo-file');
    if (drop && fileInput) {
      drop.addEventListener('click', () => fileInput.click());
      drop.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
      });
      ['dragenter', 'dragover'].forEach(name => drop.addEventListener(name, e => {
        e.preventDefault(); e.stopPropagation(); drop.classList.add('dragover');
      }));
      ['dragleave', 'drop'].forEach(name => drop.addEventListener(name, e => {
        e.preventDefault(); e.stopPropagation(); drop.classList.remove('dragover');
      }));
      drop.addEventListener('drop', e => {
        e.preventDefault(); e.stopPropagation(); drop.classList.remove('dragover');
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
          loadLogo(e.dataTransfer.files[0]);
        } else if (e.dataTransfer) {
          const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
          if (url) loadLogoUrl(url);
        }
      });
      fileInput.addEventListener('change', e => {
        if (e.target.files && e.target.files.length) loadLogo(e.target.files[0]);
      });
    }
    const btnLogoClear = $('btn-logo-clear');
    if (btnLogoClear) {
      btnLogoClear.addEventListener('click', () => {
        state.style.logo.src = '';
        state.style.logo.type = 'none';
        if (fileInput) fileInput.value = '';
        syncControls();
        update();
      });
    }
    const btnLogoUrl = $('btn-logo-image-url');
    const logoUrlInput = $('logo-image-url');
    if (btnLogoUrl && logoUrlInput) {
      btnLogoUrl.addEventListener('click', () => loadLogoUrl(logoUrlInput.value));
      logoUrlInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); loadLogoUrl(logoUrlInput.value); }
      });
    }


    // ---- プレビュー領域への画像ドロップ（選択中の対象画像として反映） ----
    const canvasCard = document.querySelector('.canvas-card');
    if (canvasCard) {
      ['dragenter', 'dragover'].forEach(name => canvasCard.addEventListener(name, e => {
        e.preventDefault(); e.stopPropagation(); canvasCard.classList.add('dragover');
      }));
      ['dragleave', 'drop'].forEach(name => canvasCard.addEventListener(name, e => {
        e.preventDefault(); e.stopPropagation(); canvasCard.classList.remove('dragover');
      }));
      canvasCard.addEventListener('drop', e => {
        e.preventDefault(); e.stopPropagation(); canvasCard.classList.remove('dragover');
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
          loadTargetImage(e.dataTransfer.files[0]);
        } else if (e.dataTransfer) {
          const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
          if (url) loadTargetImageUrl(url);
        }
      });
    }



    // ---- プレビュー市松模様の明暗切り替え ----
    const checkerToggle = $('checker-toggle');
    if (checkerToggle) {
      Array.prototype.forEach.call(checkerToggle.children, btn => {
        btn.addEventListener('click', () => {
          state.previewChecker = btn.dataset.checker || 'auto';
          updateCanvasChecker();
          save();
        });
      });
    }

    // ---- ツールバー ----
    $('btn-shuffle').addEventListener('click', shuffle);
    $('btn-reset').addEventListener('click', () => {
      state.style = JSON.parse(JSON.stringify(window.QRStyle.DEFAULTS));
      state.presetName = '';
      syncControls();
      buildShapeGrids();
      buildFrameChips();
      buildPresets();
      update();
      showToast('デザインを初期化しました');
    });

    $('btn-png').addEventListener('click', () => exportRaster('image/png', 'png'));
    $('btn-jpg').addEventListener('click', () => exportRaster('image/jpeg', 'jpg', 0.92));
    $('btn-webp').addEventListener('click', () => exportRaster('image/webp', 'webp', 0.94));
    $('btn-svg').addEventListener('click', exportSvg);
    $('btn-copy').addEventListener('click', copyImage);

    // 重いデコーダ（zxing-wasm と OpenCV）はここで初めて取りに行く。
    // 一度読めば以後の自動チェックにも加わる。
    $('btn-verify').addEventListener('click', () => {
      if (lastSvg && lastPayload) verify(lastSvg, lastPayload, true);
    });
  }

  function testImageLoad(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(url);
      img.onerror = () => reject(new Error('画像を読み込めませんでした。URLを確認してください'));
      img.src = url;
    });
  }

  async function fetchImageAsDataUrl(url) {
    const clean = sanitizeImageUrl(url);
    if (!clean) throw new Error('有効な画像URL（https://... または data:image/...）を入力してください');
    if (clean.startsWith('data:image/')) {
      return clean;
    }
    try {
      const res = await fetch(clean, { mode: 'cors' });
      if (!res.ok) throw new Error('画像の取得に失敗しました (' + res.status + ')');
      const blob = await res.blob();
      if (blob.size > 4 * 1024 * 1024) throw new Error('画像は4MBまでにしてください');
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('画像の読み込みに失敗しました'));
        reader.readAsDataURL(blob);
      });
    } catch (err) {
      console.warn('Direct CORS fetch failed, trying direct image load fallback:', err);
      await testImageLoad(clean);
      return clean;
    }
  }

  function loadLogo(file) {
    if (!file.type || file.type.indexOf('image/') !== 0) {
      showToast('画像ファイルを選んでください', 'error');
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      showToast('画像は4MBまでにしてください', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      state.style.logo.src = String(reader.result);
      state.style.logo.type = 'image';
      state.presetName = '';
      syncControls();
      update();
      showToast('ロゴ画像を適用しました');
    };
    reader.onerror = () => showToast('画像を読み込めませんでした', 'error');
    reader.readAsDataURL(file);
  }

  async function loadLogoUrl(url) {
    if (!url || !url.trim()) return;
    try {
      showToast('ロゴを読み込み中…');
      const dataUrl = await fetchImageAsDataUrl(url.trim());
      state.style.logo.src = dataUrl;
      state.style.logo.type = 'image';
      state.presetName = '';
      const input = $('logo-image-url');
      if (input) input.value = '';
      syncControls();
      update();
      showToast('ロゴ画像を適用しました');
    } catch (err) {
      showToast(err.message || 'ロゴを読み込めませんでした', 'error');
    }
  }

  function getTargetLabel() {
    const t = scopeTarget(state.colorScope);
    return t === 'cell' ? 'セル' :
           t === 'frame' ? 'マーカー枠' :
           t === 'eye' ? 'マーカー目' :
           t === 'logobd' ? 'ロゴの下地' : '背景';
  }

  function loadTargetImage(file) {
    if (!file.type || file.type.indexOf('image/') !== 0) {
      showToast('画像ファイルを選んでください', 'error');
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      showToast('画像は4MBまでにしてください', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const p = getActivePaint();
      p.src = String(reader.result);
      p.type = 'image';
      state.presetName = '';
      syncControls();
      update();
      showToast(getTargetLabel() + '画像を適用しました');
    };
    reader.onerror = () => showToast('画像を読み込めませんでした', 'error');
    reader.readAsDataURL(file);
  }

  async function loadTargetImageUrl(url) {
    if (!url || !url.trim()) return;
    try {
      showToast('画像を読み込み中…');
      const dataUrl = await fetchImageAsDataUrl(url.trim());
      const p = getActivePaint();
      p.src = dataUrl;
      p.type = 'image';
      state.presetName = '';
      const input = cq(state.colorScope, 'image-url');
      if (input) input.value = '';
      syncControls();
      update();
      showToast(getTargetLabel() + '画像を適用しました');
    } catch (err) {
      showToast(err.message || '画像を読み込めませんでした', 'error');
    }
  }



  function pick(list) { return list[Math.floor(Math.random() * list.length)]; }

  // おまかせは「必ず読める範囲で」振る。明るい地に暗いセルを置き、
  // マーカーを別色にするときも背景とのコントラストを確かめてから採用する。
  function shuffle() {
    const s = state.style;
    const contrast = window.QRStyle.contrastRatio;

    s.cell = pick(A.CELL_SHAPES).id;
    s.markerFrame = pick(A.MARKER_FRAMES).id;
    s.markerEye = pick(A.MARKER_EYES).id;

    const grounds = ['#FFFFFF', '#FFFFFF', '#FFFFFF', '#F8FAFC', '#FFF8F0', '#F7F4EE', '#F0FDF4', '#FDF2F8'];
    const bg = pick(grounds);
    const readable = c => contrast(c, bg) >= 5;

    // セル：4割はグラデーション。ただし両端とも十分濃いものだけ通す。
    let fg = null;
    if (Math.random() < 0.4) {
      const usable = A.GRADIENTS.filter(g => readable(g.from) && readable(g.to));
      if (usable.length) {
        const g = pick(usable);
        fg = { type: Math.random() < 0.25 ? 'radial' : 'linear', color: g.from, from: g.from, to: g.to,
               angle: Math.floor(Math.random() * 360) };
      }
    }
    if (!fg) {
      const usable = [];
      A.SWATCHES.forEach(group => group.colors.forEach(c => { if (readable(c)) usable.push(c); }));
      const c = usable.length ? pick(usable) : '#111827';
      fg = { type: 'solid', color: c, from: s.fg.from, to: s.fg.to, angle: s.fg.angle };
    }
    s.fg = fg;
    s.bg = { type: 'solid', color: bg, from: s.bg.from, to: s.bg.to, angle: s.bg.angle };

    const accents = [];
    A.SWATCHES.forEach(group => group.colors.forEach(c => { if (readable(c)) accents.push(c); }));
    s.markerFrameColor = '';
    s.markerEyeColor = '';
    s.markerFramePaint = (accents.length && Math.random() < 0.4) ? { type: 'solid', color: pick(accents) } : { type: 'auto' };
    s.markerEyePaint = (accents.length && Math.random() < 0.3) ? { type: 'solid', color: pick(accents) } : { type: 'auto' };

    s.radius = pick([0, 1, 2, 3, 4, 6]);
    s.cellScale = pick([0.9, 0.95, 1, 1, 1]);
    s.cellJitter = pick([0, 0, 0, 0.15, 0.3]);
    s.margin = 4;
    state.presetName = '';

    syncControls();
    buildShapeGrids();
    buildPresets();
    update();
  }

  // ------------------------------------------------------------------
  // 起動
  // ------------------------------------------------------------------
  function init() {
    lucide.createIcons();
    $('currentYear').textContent = new Date().getFullYear();

    restore();
    Array.prototype.forEach.call($('icon-tabs').children, b => {
      b.classList.toggle('active', b.dataset.group === state.iconGroup);
    });

    buildTypeChips();
    buildTypeFields();
    buildPresets();
    buildShapeGrids();
    buildColorPanels();
    COLOR_SCOPES.forEach(scope => {
      buildSwatches(scope);
      buildGradients(scope);
      buildMultiPalettes(scope);
    });
    buildLogoSwatches();
    buildLogoGradients();
    buildLogoMultiPalettes();
    buildLogoTextSwatches();
    buildLogoTextGradients();
    buildLogoTextMultiPalettes();
    buildIconGrid();
    buildFrameChips();
    syncControls();
    wire();
    update();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
