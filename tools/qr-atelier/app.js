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
        return 'mailto:' + String(f.to).trim() + (q.length ? '?' + q.join('&') : '');
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
        if (f.url) L.push('URL:' + normalizeUrl(f.url));
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
    style: JSON.parse(JSON.stringify(window.QRStyle.DEFAULTS))
  };
  TYPES.forEach(t => { state.values[t.id] = Object.assign({}, t.init); });

  const STORE_KEY = 'qr-atelier-v1';

  function save() {
    try {
      const copy = JSON.parse(JSON.stringify(state));
      // 画像は重いので、大きいものは覚えない
      if (copy.style.logo && copy.style.logo.src && copy.style.logo.src.length > 300000) {
        copy.style.logo.src = '';
        copy.style.logo.type = 'none';
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
      if (saved.style) state.style = window.QRStyle.merge(window.QRStyle.DEFAULTS, saved.style);
      if (state.style.logo.type === 'icon' && state.style.logo.icon) {
        state.style.logo.iconData = A.ICONS.find(i => i.id === state.style.logo.icon) || null;
      }
    } catch (e) { /* 壊れた保存は捨てる */ }
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

  function normHex(v, fallback) {
    let s = String(v || '').trim();
    if (s.charAt(0) !== '#') s = '#' + s;
    if (/^#[0-9a-fA-F]{3}$/.test(s)) {
      s = '#' + s.slice(1).split('').map(c => c + c).join('');
    }
    return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toUpperCase() : fallback;
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

  function buildSwatches() {
    const host = $('swatch-host');
    host.innerHTML = '';
    A.SWATCHES.forEach(group => {
      const g = el('div', { class: 'swatch-group' });
      g.appendChild(el('b', null, group.name));
      const row = el('div', { class: 'swatches' });
      group.colors.forEach(c => {
        const b = el('button', { class: 'sw', type: 'button', title: c, 'aria-label': c });
        b.style.background = c;
        b.addEventListener('click', () => {
          if (state.style.fg.type === 'solid') {
            state.style.fg.color = c;
          } else {
            state.style.fg.from = c;
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

  function buildGradients() {
    const host = $('grad-grid');
    host.innerHTML = '';
    A.GRADIENTS.forEach(g => {
      const b = el('button', { class: 'grad-btn', type: 'button', title: g.name });
      b.style.background = 'linear-gradient(' + (g.angle + 90) + 'deg, ' + g.from + ', ' + g.to + ')';
      b.appendChild(el('span', null, g.name));
      b.addEventListener('click', () => {
        state.style.fg.from = g.from;
        state.style.fg.to = g.to;
        state.style.fg.angle = g.angle;
        if (state.style.fg.type === 'solid') state.style.fg.type = 'linear';
        state.presetName = '';
        syncControls();
        buildPresets();
        update();
      });
      host.appendChild(b);
    });
  }

  function buildIconGrid() {
    const host = $('icon-grid');
    host.innerHTML = '';
    A.ICONS.filter(i => i.group === state.iconGroup).forEach(icon => {
      const b = el('button', { class: 'icon-btn' + (state.style.logo.icon === icon.id ? ' active' : ''), type: 'button', title: icon.name, 'aria-label': icon.name });
      const svgNS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('viewBox', icon.vb);
      svg.setAttribute('fill', 'currentColor');
      icon.p.forEach(p => {
        const path = document.createElementNS(svgNS, 'path');
        path.setAttribute('d', p.d);
        if (p.e) path.setAttribute('fill-rule', 'evenodd');
        svg.appendChild(path);
      });
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
  function setSeg(hostId, value, attr) {
    const host = $(hostId);
    if (!host) return;
    Array.prototype.forEach.call(host.children, b => {
      b.classList.toggle('active', b.dataset[attr] === value);
    });
  }

  function syncControls() {
    const s = state.style;

    $('opt-ec').value = state.ec;
    $('opt-size').value = String(state.exportSize);

    setSeg('fg-mode', s.fg.type, 'mode');
    $('fg-solid').classList.toggle('hidden', s.fg.type !== 'solid');
    $('fg-grad').classList.toggle('hidden', s.fg.type === 'solid');
    $('fg-color-picker').value = normHex(s.fg.color, '#111827');
    $('fg-color-hex').value = normHex(s.fg.color, '#111827');
    $('fg-from').value = normHex(s.fg.from, '#FC466B');
    $('fg-to').value = normHex(s.fg.to, '#3F5EFB');
    $('fg-angle').value = s.fg.angle;
    $('val-angle').textContent = s.fg.angle + '°';
    $('hint-color').textContent = s.fg.type === 'solid' ? '単色' : s.fg.type === 'radial' ? '放射' : 'グラデーション';

    setSeg('bg-mode', s.bg.type, 'mode');
    $('bg-row').classList.toggle('hidden', s.bg.type === 'none');
    $('bg-color-picker').value = normHex(s.bg.color, '#FFFFFF');
    $('bg-color-hex').value = normHex(s.bg.color, '#FFFFFF');

    $('mf-color').value = normHex(s.markerFrameColor || s.fg.color, '#111827');
    $('me-color').value = normHex(s.markerEyeColor || s.fg.color, '#111827');

    $('opt-cellscale').value = s.cellScale;
    $('val-cellscale').textContent = Math.round(s.cellScale * 100) + '%';
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
    $('logo-color').value = normHex(s.logo.color, '#111827');
    $('logo-color-hex').value = normHex(s.logo.color, '#111827');
    $('logo-text-color').value = normHex(s.logo.color, '#111827');
    $('logo-text').value = s.logo.text || '';
    $('logo-size').value = s.logo.size;
    $('val-logosize').textContent = Math.round(s.logo.size * 100) + '%';
    $('logo-pad').value = s.logo.pad;
    $('val-logopad').textContent = Math.round(s.logo.pad * 100) + '%';
    setSeg('logo-backdrop', s.logo.backdrop, 'v');
    $('logo-bd-color').value = normHex(s.logo.backdropColor, '#FFFFFF');
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

    $('hint-adv').textContent = '余白' + s.margin + ' / ' + state.ec;
  }

  // ------------------------------------------------------------------
  // 描画
  // ------------------------------------------------------------------
  let lastSvg = '';
  let lastPayload = '';
  let renderTimer = null;
  let verifySeq = 0;

  // 読み取りテストの手段。ブラウザ内蔵のBarcodeDetectorが使えるならそれを、
  // 使えない環境（Windows版Chromeなど）ではjsQRで読み返す。
  const detector = (function () {
    if (typeof window.BarcodeDetector === 'undefined') return null;
    try { return new window.BarcodeDetector({ formats: ['qr_code'] }); }
    catch (e) { return null; }
  })();

  async function decodeCanvas(canvas) {
    if (detector) {
      try {
        const results = await detector.detect(canvas);
        if (results.length) return results[0].rawValue;
      } catch (e) { /* 内蔵が転んだらjsQRに任せる */ }
    }
    if (typeof window.jsQR === 'function') {
      const ctx = canvas.getContext('2d');
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const hit = window.jsQR(data.data, data.width, data.height, { inversionAttempts: 'attemptBoth' });
      if (hit) return hit.data;
    }
    return null;
  }

  function scheduleUpdate() {
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(update, 90);
  }

  function update() {
    if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
    save();

    const text = payload();
    lastPayload = text;

    const alerts = $('alerts');
    alerts.innerHTML = '';
    const meta = $('meta-row');
    meta.innerHTML = '';

    if (!text) {
      $('preview').innerHTML = '';
      lastSvg = '';
      setVerdict('na', '待機中', '内容を入力するとここに出ます');
      setStatus('ready', 'idle');
      return;
    }

    let qr;
    try {
      qr = window.QRCore.encode(text, { ec: state.ec, minVersion: state.minVersion });
    } catch (e) {
      $('preview').innerHTML = '';
      lastSvg = '';
      setVerdict('ng', '入りきりません', '文字数を減らすか、誤り訂正レベルを下げてください');
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

    verify(out.svg, text);
  }

  function pushAlert(level, text) {
    const a = el('div', { class: 'alert' + (level === 'error' ? ' error' : '') });
    a.appendChild(el('span', null, text));
    $('alerts').appendChild(a);
  }

  function setVerdict(kind, title, note) {
    const v = $('verdict');
    v.className = 'verdict ' + kind;
    $('verdict-title').textContent = title;
    $('verdict-note').textContent = note || '';
  }

  // 生成した絵をそのままデコードし直して、本当に読めるか確かめる。
  // 実機のカメラに近い解像度（1モジュール3〜9px）で何段か試す。解像度を
  // 上げすぎるとデコーダ側の二値化がかえって不安定になり、逆に特定の倍率
  // だけ取りこぼすこともあるので、1つでも通れば「読める」と判断する。
  const VERIFY_SCALES = [4, 3, 6, 7, 9];

  function moduleWidth(svg) {
    const m = svg.match(/viewBox="0 0 ([0-9.]+) /);
    return m ? parseFloat(m[1]) : 41;
  }

  async function verify(svg, expect) {
    if (!detector && typeof window.jsQR !== 'function') {
      setVerdict('na', '読み取りテスト非対応', 'この環境では自動チェックできません');
      return;
    }
    const seq = ++verifySeq;
    setVerdict('na', 'チェック中…', '');
    const W = moduleWidth(svg);
    let sawSomething = false;
    try {
      for (const k of VERIFY_SCALES) {
        const canvas = await rasterize(svg, Math.round(W * k), '#FFFFFF');
        const decoded = await decodeCanvas(canvas);
        if (seq !== verifySeq) return;
        if (decoded === expect) {
          setVerdict('ok', '読み取りOK', '書き出す絵をその場でデコードして確認しました');
          return;
        }
        if (decoded) sawSomething = true;
      }
      setVerdict('ng', sawSomething ? '内容がずれています' : '読み取れませんでした',
        'コントラスト・ロゴの大きさ・余白を見直してください');
    } catch (e) {
      if (seq !== verifySeq) return;
      setVerdict('na', 'チェックできず', '');
    }
  }

  // ------------------------------------------------------------------
  // 書き出し
  // ------------------------------------------------------------------
  function svgToImage(svg, px) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('svg load failed'));
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(window.QRStyle.resize(svg, px));
    });
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
    const picker = $(pickerId);
    const hex = hexId ? $(hexId) : null;
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
    const host = $(hostId);
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
    const input = $(id);
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      $(labelId).textContent = format(v);
      apply(v);
      state.presetName = '';
      update();
    });
  }

  function wire() {
    $('opt-ec').addEventListener('change', e => { state.ec = e.target.value; syncControls(); update(); });
    $('opt-size').addEventListener('change', e => { state.exportSize = parseInt(e.target.value, 10); save(); });

    bindSeg('fg-mode', 'mode', v => { state.style.fg.type = v; });
    bindSeg('bg-mode', 'mode', v => { state.style.bg.type = v; });
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
    bindSeg('logo-backdrop', 'v', v => { state.style.logo.backdrop = v; });

    bindColor('fg-color-picker', 'fg-color-hex', v => { state.style.fg.color = v; });
    bindColor('bg-color-picker', 'bg-color-hex', v => { state.style.bg.color = v; });
    bindColor('fg-from', null, v => { state.style.fg.from = v; });
    bindColor('fg-to', null, v => { state.style.fg.to = v; });
    bindColor('mf-color', null, v => { state.style.markerFrameColor = v; });
    bindColor('me-color', null, v => { state.style.markerEyeColor = v; });
    bindColor('logo-color', 'logo-color-hex', v => { state.style.logo.color = v; });
    bindColor('logo-text-color', null, v => { state.style.logo.color = v; });
    bindColor('logo-bd-color', null, v => { state.style.logo.backdropColor = v; });
    bindColor('frame-color', null, v => { state.style.frame.color = v; });
    bindColor('frame-textcolor', null, v => { state.style.frame.textColor = v; });

    document.querySelectorAll('[data-clear]').forEach(b => {
      b.addEventListener('click', () => {
        if (b.dataset.clear === 'mf') state.style.markerFrameColor = '';
        else state.style.markerEyeColor = '';
        syncControls();
        update();
      });
    });

    bindRange('fg-angle', 'val-angle', v => v + '°', v => { state.style.fg.angle = v; });
    bindRange('opt-cellscale', 'val-cellscale', v => Math.round(v * 100) + '%', v => { state.style.cellScale = v; });
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
    $('frame-text').addEventListener('input', e => {
      state.style.frame.text = e.target.value;
      scheduleUpdate();
    });

    Array.prototype.forEach.call($('icon-tabs').children, b => {
      b.addEventListener('click', () => {
        state.iconGroup = b.dataset.group;
        Array.prototype.forEach.call($('icon-tabs').children, x => x.classList.toggle('active', x === b));
        buildIconGrid();
        save();
      });
    });

    // ---- ロゴ画像 ----
    const drop = $('logo-drop');
    const fileInput = $('logo-file');
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
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) loadLogo(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', e => {
      if (e.target.files && e.target.files.length) loadLogo(e.target.files[0]);
    });
    $('btn-logo-clear').addEventListener('click', () => {
      state.style.logo.src = '';
      state.style.logo.type = 'none';
      fileInput.value = '';
      syncControls();
      update();
    });

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
    };
    reader.onerror = () => showToast('画像を読み込めませんでした', 'error');
    reader.readAsDataURL(file);
  }

  function pick(list) { return list[Math.floor(Math.random() * list.length)]; }

  // おまかせは「必ず読める範囲で」振る。明るい地に暗い前景を置き、
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

    // 前景：4割はグラデーション。ただし両端とも十分濃いものだけ通す。
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
    s.markerFrameColor = (accents.length && Math.random() < 0.4) ? pick(accents) : '';
    s.markerEyeColor = (accents.length && Math.random() < 0.3) ? pick(accents) : '';

    s.radius = pick([0, 1, 2, 3, 4, 6]);
    s.cellScale = pick([0.9, 0.95, 1, 1, 1]);
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
    buildSwatches();
    buildGradients();
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
