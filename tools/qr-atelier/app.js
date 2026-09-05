/* QR Atelier — 画面まわり
 *
 * qr-core.js（符号化）と qr-style.js（描画）をつなぎ、入力・デザイン操作・
 * 書き出しを受け持つ。
 *
 * 入力した内容そのものは、符号化から検査・書き出しまで一度も外へ出ない。
 * 外へ出るのはページの土台（Tailwind・lucide・Google Fonts など）と、
 * 「画像をURLで指定」したときのその画像、それに書き出し時のフォント取得だけ。
 */
(function () {
  'use strict';

  const { showToast } = window.STCommon;
  const A = window.QRAssets;
  // 選べる書体は qr-style.js の表がひとつの出どころ。検証もシャッフルもそこから引く。
  const FONTS = window.QRStyle.FONT_KEYS;

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
    presetCategory: 'all',
    iconGroup: 'brand',
    frameTopIconGroup: 'brand',
    frameBottomIconGroup: 'brand',
    colorScope: 'cell',  // 最後に触った色パネル（＝着色対象）
    previewChecker: 'auto', // 'auto' | 'light' | 'dark'
    style: JSON.parse(JSON.stringify(window.QRStyle.DEFAULTS))
  };
  TYPES.forEach(t => { state.values[t.id] = Object.assign({}, t.init); });

  // 色の設定パネルは着色対象ごとに1枚ずつ、その対象の形の設定のすぐ下に置く。
  // 切り替えるタブはないので、スコープ名がそのまま対象名になる。
  const COLOR_SCOPES = ['cell', 'frame', 'eye', 'bg', 'logobd', 'frameborder', 'framelabel', 'frametext', 'framebd'];

  // 画像の塗りの倍率（描画エンジンと同じ範囲。UI では % で見せる）
  const IMG_SCALE_MIN = (window.QRStyle && window.QRStyle.IMG_SCALE_MIN) || 0.2;
  const IMG_SCALE_MAX = (window.QRStyle && window.QRStyle.IMG_SCALE_MAX) || 4;

  function imgScalePct(p) {
    const v = clampNum(p && p.imgScale, IMG_SCALE_MIN, IMG_SCALE_MAX, 1);
    return Math.round(v * 100);
  }

  // 画像モードのときだけ出す拡大・縮小スライダー
  function syncImageScaleRow(row, input, label, paint, visible) {
    const pct = imgScalePct(paint);
    if (row) row.classList.toggle('hidden', !visible);
    if (input) input.value = pct;
    if (label) label.textContent = pct + '%';
  }

  function scopeTarget(scope) { return scope; }

  // state.style は必ず DEFAULTS から起こす（初期化・復元・テンプレート適用・
  // 初期化ボタンの4か所とも）。QRStyle.merge は DEFAULTS のキーを再帰的に
  // 埋めるので、frame も frame.paint も「無いかもしれない」状態にはならない。
  // 以前は呼び出し側ごとに作り直していたが、その場しのぎの不完全な形が
  // 入るだけで、守っている対象は存在しなかった。
  function getFrameLinePaint() { return state.style.frame.paint; }
  function getFrameTextPaint() { return state.style.frame.textPaint; }

  // ラベルの中身の下地の塗り。ロゴの下地と同じ 9 モードを持つが、
  // 既定は「なし」なので、選ぶまでは今までどおり板は敷かれない。
  function getFrameBackdropPaint() {
    return state.style.frame.backdropPaint;
  }

  function paintOf(target) {
    if (target === 'frame') return state.style.markerFramePaint;
    if (target === 'eye') return state.style.markerEyePaint;
    if (target === 'bg') return state.style.bg;
    if (target === 'logobd') return getLogoBackdropPaint();
    if (target === 'frameborder' || target === 'framelabel') return getFrameLinePaint();
    if (target === 'frametext') return getFrameTextPaint();
    if (target === 'framebd') return getFrameBackdropPaint();
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

  function getLogoPaint() { return state.style.logo.paint; }

  const STORE_KEY = 'qr-atelier-v1';

  // 受け付ける画像の上限。ファイルからでもURLからでも同じ線を引く。
  const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

  // これより長い画像（data URL）は覚えない。localStorage の枠を1枚で使い切る。
  const MAX_STORED_SRC = 300000;

  // 覚えるときに大きすぎる画像を落とす場所。[持ち主, キー名] で並べる。
  function storedImageSlots(s) {
    return [
      [s.logo, 'src'], [s.logo.paint, 'src'],
      [s.fg, 'src'], [s.bg, 'src'],
      [s.markerFramePaint, 'src'], [s.markerEyePaint, 'src'],
      [s.frame.paint, 'src'], [s.frame.textPaint, 'src'], [s.frame.backdropPaint, 'src'],
      [s.frame, 'src'], [s.frame, 'topSrc']
    ];
  }

  function save() {
    try {
      // 覚えられない画像は、複製せずに直列化しながら落とす。state を丸ごと
      // 複製してから消すと、これから捨てる data URL を一度そっくり作り直す
      // ことになる（4MB の画像なら往復で 10MB 級の文字列になる）。
      const drop = new Set();
      let logoDropped = false;
      storedImageSlots(state.style).forEach(slot => {
        const owner = slot[0], key = slot[1];
        if (owner && typeof owner[key] === 'string' && owner[key].length > MAX_STORED_SRC) {
          drop.add(owner[key]);
          if (owner === state.style.logo && key === 'src') logoDropped = true;
        }
      });
      const json = JSON.stringify(state, function (k, v) {
        // アイコンの実体は QRAssets から引き直せるので覚えない
        if (k === 'iconData' || k === 'topIconData') return undefined;
        if (typeof v === 'string' && drop.has(v)) return '';
        // ロゴ本体の画像だけは、消したあと種類も戻さないと空のロゴが残る
        if (logoDropped && k === 'type' && this === state.style.logo) return 'none';
        return v;
      });
      localStorage.setItem(STORE_KEY, json);
    } catch (e) { /* private mode — 保存しないだけ */ }
  }

  // 保存は state 全体の直列化なので、埋め込んだ画像ぶんだけ重い。操作のたびに
  // 走らせる意味はないので、最後の操作から少し置いて1回にまとめる。画面を
  // 離れるときだけは、待っているぶんを取りこぼさないよう即座に書く。
  let saveTimer = null;
  function saveSoon() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; save(); }, 400);
  }
  function saveNow() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    save();
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
      ['ec', 'minVersion', 'exportSize', 'presetName', 'presetCategory', 'iconGroup', 'frameTopIconGroup', 'frameBottomIconGroup'].forEach(k => {
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
      // merge は DEFAULTS のキーを再帰的に埋めるので、frame.paint / logo.paint /
      // font などの穴埋めはここでは要らない。値の妥当性は sanitizeStyle が見る。
      if (saved.style) state.style = window.QRStyle.merge(window.QRStyle.DEFAULTS, saved.style);
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
      if (state.style.frame && state.style.frame.icon) {
        state.style.frame.iconData = A.ICONS.find(i => i.id === state.style.frame.icon) || null;
      }
      if (state.style.frame && state.style.frame.topIcon) {
        state.style.frame.topIconData = A.ICONS.find(i => i.id === state.style.frame.topIcon) || null;
      }
      sanitizeStyle(state.style);
    } catch (e) { /* 壊れた保存は捨てる */ }
  }

  // 塗りのモードは、どこに使う塗りかで選べる顔ぶれが変わる。画面のボタンの
  // 並び（index.html の color-mode-seg / logo-color-mode-seg）と対で持つこと。
  //   basic … セルとラベルの文字。追従先が無いので実体のある塗りだけ
  //   auto  … マーカーとフレームの線。既定は「セルの色に追従」
  //   brand … ロゴ。アイコンのブランド公式色を選べる
  //   plate … 背景と下地。敷く面なので白・黒・透明まで選べる
  const PAINT_MODES = {
    basic: ['solid', 'multi', 'linear', 'radial', 'image'],
    auto: ['auto', 'solid', 'multi', 'linear', 'radial', 'image'],
    brand: ['brand', 'auto', 'solid', 'multi', 'linear', 'radial', 'image'],
    plate: ['white', 'black', 'none', 'auto', 'solid', 'multi', 'linear', 'radial', 'image']
  };

  function sanitizePaint(p, kind, defaultType, fallbackColor) {
    if (!p || typeof p !== 'object') p = {};
    const isPlate = kind === 'plate';
    if (PAINT_MODES[kind].indexOf(p.type) < 0) p.type = defaultType;
    p.color = normHex(p.color, fallbackColor || (isPlate ? '#FFFFFF' : '#111827'));
    p.from = normHex(p.from, isPlate ? '#FFFFFF' : '#FC466B');
    p.to = normHex(p.to, isPlate ? '#E5E7EB' : '#3F5EFB');
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
    p.imgScale = clampNum(p.imgScale, IMG_SCALE_MIN, IMG_SCALE_MAX, 1);
    // 透過スライダーを持たない塗り（ロゴなど）に、勝手に生やさない
    if (isPlate || p.transparency !== undefined) {
      p.transparency = clampNum(p.transparency, 0, 100, 0);
    }
    return p;
  }

  // localStorage の中身はそのまま SVG の属性と数値に流れる。壊れた保存や
  // 別経路で書き換えられた値が fill="..." を閉じて属性を足せてしまわないよう、
  // 色は #RRGGBB に、数値は範囲内の数に必ず均しておく。
  function sanitizeStyle(s) {
    const D = window.QRStyle.DEFAULTS;
    s.fg = sanitizePaint(s.fg, 'basic', 'solid', '#111827');

    // 旧プロパティからの移行と初期化
    if (!s.markerFramePaint) {
      s.markerFramePaint = s.markerFrameColor ? { type: 'solid', color: s.markerFrameColor } : { type: 'auto' };
    }
    s.markerFramePaint = sanitizePaint(s.markerFramePaint, 'auto', 'auto', s.fg.color);

    if (!s.markerEyePaint) {
      s.markerEyePaint = s.markerEyeColor ? { type: 'solid', color: s.markerEyeColor } : { type: 'auto' };
    }
    s.markerEyePaint = sanitizePaint(s.markerEyePaint, 'auto', 'auto', s.fg.color);

    if (!s.frame.paint) {
      s.frame.paint = { type: 'auto', color: s.frame.color || '#111827' };
    }
    s.frame.paint = sanitizePaint(s.frame.paint, 'auto', 'auto', s.fg.color);

    if (!s.frame.textPaint) {
      s.frame.textPaint = { type: 'solid', color: s.frame.textColor || '#FFFFFF' };
    }
    s.frame.textPaint = sanitizePaint(s.frame.textPaint, 'basic', 'solid', '#FFFFFF');
    if (!s.frame.font || FONTS.indexOf(s.frame.font) < 0) {
      s.frame.font = 'sans';
    }
    if (!s.frame.contentMode || ['text', 'icon', 'image'].indexOf(s.frame.contentMode) < 0) {
      s.frame.contentMode = 'text';
    }
    if (!s.frame.topContentMode || ['text', 'icon', 'image'].indexOf(s.frame.topContentMode) < 0) {
      s.frame.topContentMode = 'text';
    }
    if (!s.frame.pos || ['bottom', 'top', 'both'].indexOf(s.frame.pos) < 0) {
      s.frame.pos = 'bottom';
    }
    s.frame.icon = s.frame.icon || 'si-instagram';
    if (!s.frame.iconColorMode || ['brand', 'auto', 'solid'].indexOf(s.frame.iconColorMode) < 0) {
      s.frame.iconColorMode = 'brand';
    }
    s.frame.iconColor = normHex(s.frame.iconColor, '#FFFFFF');
    s.frame.src = sanitizeImageUrl(s.frame.src);

    s.frame.topIcon = s.frame.topIcon || 'si-instagram';
    if (!s.frame.topIconColorMode || ['brand', 'auto', 'solid'].indexOf(s.frame.topIconColorMode) < 0) {
      s.frame.topIconColorMode = 'brand';
    }
    s.frame.topIconColor = normHex(s.frame.topIconColor, '#FFFFFF');
    s.frame.topSrc = sanitizeImageUrl(s.frame.topSrc);
    s.frame.textTop = String(s.frame.textTop || '');

    // 消えた種類（点線・太線＋細線）は近いものへ寄せる
    s.frame.line = window.QRStyle.lineIdOf(s.frame.line);
    const lineDef = window.QRStyle.LINE_STYLES[s.frame.line];
    s.frame.lineWidth = clampNum(s.frame.lineWidth, 0.15, 2.5, lineDef.stroke);
    s.frame.lineWidth2 = clampNum(s.frame.lineWidth2, 0.15, 2.5, lineDef.inner || 0.28);

    // ラベルの中身の下地。形はマーカーの枠と同じ一覧から選ぶ
    if (!s.frame.backdrop || !A.MARKER_FRAMES.some(f => f.id === s.frame.backdrop)) {
      s.frame.backdrop = D.frame.backdrop;
    }
    if (!s.frame.backdropPaint || !s.frame.backdropPaint.type) {
      s.frame.backdropPaint = { type: 'none', color: '#FFFFFF', transparency: 0 };
    }
    // 下地は既定で不透明。sanitizePaint は未指定を 80% 透過とみなすので、先に埋めておく
    if (s.frame.backdropPaint.transparency === undefined) s.frame.backdropPaint.transparency = 0;
    s.frame.backdropPaint = sanitizePaint(s.frame.backdropPaint, 'plate', 'none', '#FFFFFF');

    s.bg = sanitizePaint(s.bg, 'plate', 'solid', '#FFFFFF');

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
    if (s.logo.backdropPaint.transparency === undefined) s.logo.backdropPaint.transparency = 0;
    s.logo.backdropPaint = sanitizePaint(s.logo.backdropPaint, 'plate', 'solid', '#FFFFFF');

    // ロゴ本体の塗り。ここだけ 'brand'（アイコンのブランド公式色）を選べる。
    // 画面では、ブランド以外のアイコン群を選んでいるときに syncControls が
    // 'auto' へ寄せるので、ここでは 'brand' をそのまま通してよい。
    s.logo.paint = sanitizePaint(s.logo.paint, 'brand', 'brand', s.logo.color || D.logo.color);

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
    s.frame.contentSize = clampNum(s.frame.contentSize, 0.5, 1.6, D.frame.contentSize);
    s.frame.contentPad = clampNum(s.frame.contentPad, 0, 0.6, D.frame.contentPad);
    s.frame.text = String(s.frame.text == null ? D.frame.text : s.frame.text);
    s.logo.text = String(s.logo.text == null ? '' : s.logo.text);
    if (!s.logo.font || FONTS.indexOf(s.logo.font) < 0) s.logo.font = 'sans';
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

  // Blob / File を data URL に。画像もフォントもこれ1本で読む。
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('read failed'));
      reader.readAsDataURL(blob);
    });
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

  const PRESET_CATEGORIES = [
    { id: 'all', name: 'すべて' },
    { id: 'basic', name: '定番' },
    { id: 'gradient', name: 'グラデ' },
    { id: 'multi', name: '多色' },
    { id: 'frame', name: 'フレーム' },
    { id: 'unique', name: '個性派' }
  ];

  function buildPresetCategoryChips() {
    const host = $('preset-cat-chips');
    if (!host) return;
    host.innerHTML = '';
    PRESET_CATEGORIES.forEach(cat => {
      const b = el('button', {
        class: 'chip' + (state.presetCategory === cat.id ? ' active' : ''),
        type: 'button'
      }, cat.name);
      b.addEventListener('click', () => {
        state.presetCategory = cat.id;
        buildPresetCategoryChips();
        buildPresets();
      });
      host.appendChild(b);
    });
  }

  function syncPresetActive() {
    const host = $('preset-grid');
    if (host) {
      const buttons = host.querySelectorAll('.preset-btn');
      const filtered = A.PRESETS.filter(p => state.presetCategory === 'all' || p.category === state.presetCategory);
      buttons.forEach((btn, idx) => {
        const p = filtered[idx];
        if (p) btn.classList.toggle('active', state.presetName === p.name);
      });
    }
    const hint = $('hint-preset');
    if (hint) hint.textContent = state.presetName || 'カスタム';
  }

  function buildPresets() {
    const host = $('preset-grid');
    if (!host) return;
    host.innerHTML = '';
    if (!previewQR) previewQR = window.QRCore.encode('https://tk.st/', { ec: 'M' });

    const filtered = A.PRESETS.filter(p => state.presetCategory === 'all' || p.category === state.presetCategory);

    filtered.forEach(p => {
      const btn = el('button', { class: 'preset-btn' + (state.presetName === p.name ? ' active' : ''), type: 'button' });

      // サムネイル用のレンダリングスタイル
      const thumbStyle = Object.assign({}, p.style);
      if (thumbStyle.margin === undefined) thumbStyle.margin = 3;

      const out = window.QRStyle.render(previewQR, thumbStyle);
      const thumb = el('div', { class: 'preset-thumb' });
      thumb.innerHTML = out.svg;
      btn.appendChild(thumb);
      btn.appendChild(el('i', null, p.name));

      btn.addEventListener('click', () => {
        const userLogoSrc = (state.style.logo && state.style.logo.type === 'image') ? state.style.logo.src : '';
        const userLogoText = (state.style.logo && state.style.logo.type === 'text') ? state.style.logo.text : '';

        // DEFAULTS をベースにしてテンプレートのスタイルをディープマージ
        const base = JSON.parse(JSON.stringify(window.QRStyle.DEFAULTS));
        state.style = window.QRStyle.merge(base, JSON.parse(JSON.stringify(p.style)));

        // ユーザーが置いていた画像ロゴ・文字ロゴは、テンプレートがロゴに
        // 触れていないときだけ戻す。logo を書いたテンプレート（ミニマルなど）は
        // 「ロゴなし」まで含めて指定なので、そちらを尊重する。
        if (!p.style.logo && userLogoSrc) {
          state.style.logo.type = 'image';
          state.style.logo.src = userLogoSrc;
        } else if (!p.style.logo && userLogoText) {
          state.style.logo.type = 'text';
          state.style.logo.text = userLogoText;
        }

        // セルの密度は style ではなく state 側。テンプレートは基本「自動」に戻す
        state.minVersion = p.minVersion || 1;

        state.presetName = p.name;
        syncControls();
        buildFrameChips();
        syncPresetActive();
        update();
      });
      host.appendChild(btn);
    });
    const hint = $('hint-preset');
    if (hint) hint.textContent = state.presetName || 'カスタム';
  }

  function syncShapeGridActive(hostId, currentId) {
    const host = $(hostId);
    if (!host) return;
    Array.prototype.forEach.call(host.children, btn => {
      btn.classList.toggle('active', btn.dataset.id === currentId);
    });
  }

  function updateFrameGridPreviews() {
    const host = $('frame-grid');
    if (!host) return;
    Array.prototype.forEach.call(host.children, btn => {
      const id = btn.dataset.id;
      const holder = btn.querySelector('.preview-holder');
      if (holder && id) {
        holder.innerHTML = window.QRStyle.markerPreview(id, state.style.markerEye);
      }
    });
  }

  function syncShapeActive() {
    syncShapeGridActive('cell-grid', state.style.cell);
    syncShapeGridActive('frame-grid', state.style.markerFrame);
    syncShapeGridActive('logo-backdrop-grid', state.style.logo.backdrop);
    syncShapeGridActive('frame-backdrop-grid', state.style.frame && state.style.frame.backdrop);
    syncShapeGridActive('frame-line-grid', state.style.frame && state.style.frame.line);
    syncShapeGridActive('eye-grid', state.style.markerEye);

    const cellName = (A.CELL_SHAPES.find(s => s.id === state.style.cell) || {}).name || '';
    const hintShape = $('hint-shape');
    if (hintShape) hintShape.textContent = cellName;
  }

  function buildShapeGrids() {
    const cellHost = $('cell-grid');
    if (cellHost) {
      cellHost.innerHTML = '';
      A.CELL_SHAPES.forEach(s => {
        const b = el('button', { class: 'shape-btn' + (state.style.cell === s.id ? ' active' : ''), type: 'button', title: s.name });
        b.dataset.id = s.id;
        const holder = el('div', { class: 'preview-holder' });
        holder.innerHTML = window.QRStyle.cellPreview(s.id);
        b.appendChild(holder);
        b.appendChild(el('i', null, s.name));
        b.addEventListener('click', () => {
          state.style.cell = s.id;
          state.presetName = '';
          syncShapeActive();
          syncPresetActive();
          update();
        });
        cellHost.appendChild(b);
      });
    }

    const frameHost = $('frame-grid');
    if (frameHost) {
      frameHost.innerHTML = '';
      A.MARKER_FRAMES.forEach(s => {
        const b = el('button', { class: 'shape-btn' + (state.style.markerFrame === s.id ? ' active' : ''), type: 'button', title: s.name });
        b.dataset.id = s.id;
        const holder = el('div', { class: 'preview-holder' });
        holder.innerHTML = window.QRStyle.markerPreview(s.id, state.style.markerEye);
        b.appendChild(holder);
        b.appendChild(el('i', null, s.name));
        b.addEventListener('click', () => {
          state.style.markerFrame = s.id;
          state.presetName = '';
          syncShapeActive();
          syncPresetActive();
          update();
        });
        frameHost.appendChild(b);
      });
    }

    // ロゴの下地とラベルの下地は同じ形の一覧から選ぶ
    function buildBackdropGrid(hostId, current, pick) {
      const host = $(hostId);
      if (!host) return;
      host.innerHTML = '';
      A.MARKER_FRAMES.forEach(f => {
        const b = el('button', { class: 'shape-btn' + (current === f.id ? ' active' : ''), type: 'button', title: f.name });
        b.dataset.id = f.id;
        const holder = el('div', { class: 'preview-holder' });
        holder.innerHTML = window.QRStyle.backdropPreview(f.id);
        b.appendChild(holder);
        b.appendChild(el('i', null, f.name));
        b.addEventListener('click', () => {
          pick(f.id);
          state.presetName = '';
          syncShapeActive();
          syncPresetActive();
          update();
        });
        host.appendChild(b);
      });
    }

    buildBackdropGrid('logo-backdrop-grid', state.style.logo.backdrop, id => {
      state.style.logo.backdrop = id;
    });
    buildBackdropGrid('frame-backdrop-grid', state.style.frame && state.style.frame.backdrop, id => {
      state.style.frame.backdrop = id;
    });

    // 枠線の種類。見本は本番と同じ描画コードから起こす
    const lineHost = $('frame-line-grid');
    if (lineHost) {
      lineHost.innerHTML = '';
      A.FRAME_LINES.forEach(f => {
        const b = el('button', { class: 'shape-btn' + ((state.style.frame && state.style.frame.line === f.id) ? ' active' : ''), type: 'button', title: f.name });
        b.dataset.id = f.id;
        const holder = el('div', { class: 'preview-holder' });
        holder.innerHTML = window.QRStyle.linePreview(f.id);
        b.appendChild(holder);
        b.appendChild(el('i', null, f.name));
        b.addEventListener('click', () => {
          const ls = window.QRStyle.LINE_STYLES[f.id] || {};
          state.style.frame.line = f.id;
          state.style.frame.lineWidth = ls.stroke;
          state.style.frame.lineWidth2 = ls.inner || 0.28;
          state.presetName = '';
          syncShapeActive();
          buildFrameChips();
          syncPresetActive();
          // 太さの既定値と、二重線のときだけ出る2本目のスライダーを描き直す
          syncControls();
          update();
        });
        lineHost.appendChild(b);
      });
    }

    const eyeHost = $('eye-grid');
    if (eyeHost) {
      eyeHost.innerHTML = '';
      A.MARKER_EYES.forEach(s => {
        const b = el('button', { class: 'shape-btn' + (state.style.markerEye === s.id ? ' active' : ''), type: 'button', title: s.name });
        b.dataset.id = s.id;
        const holder = el('div', { class: 'preview-holder' });
        holder.innerHTML = window.QRStyle.eyePreview(s.id);
        b.appendChild(holder);
        b.appendChild(el('i', null, s.name));
        b.addEventListener('click', () => {
          state.style.markerEye = s.id;
          state.presetName = '';
          syncShapeActive();
          updateFrameGridPreviews();
          syncPresetActive();
          update();
        });
        eyeHost.appendChild(b);
      });
    }

    const cellName = (A.CELL_SHAPES.find(s => s.id === state.style.cell) || {}).name || '';
    const hintShape = $('hint-shape');
    if (hintShape) hintShape.textContent = cellName;
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

  function blendHex(c1, c2) {
    const a = hexToRgb(c1) || [0, 0, 0];
    const b = hexToRgb(c2) || [255, 255, 255];
    const m = a.map((v, i) => Math.round((v + b[i]) / 2));
    return '#' + m.map(v => v.toString(16).padStart(2, '0')).join('');
  }

  function renderMultiColorsList(host, p, addBtn) {
    if (!host) return;
    host.innerHTML = '';
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

    if (addBtn) {
      const atMax = colors.length >= 8;
      addBtn.classList.toggle('hidden', atMax);
      addBtn.hidden = atMax;
      addBtn.disabled = atMax;
    }
  }

  function renderMultiPalettes(host, getPaint, onSelect) {
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
        if (onSelect) onSelect();
        getPaint().colors = p.colors.slice();
        state.presetName = '';
        syncControls();
        syncPresetActive();
        update();
      });
      host.appendChild(btn);
    });
  }

  function renderGradColorsList(host, p, addBtn) {
    if (!host) return;
    host.innerHTML = '';
    const hasMid = !!p.mid;
    const items = hasMid
      ? [{ key: 'from', role: '開始', val: p.from || '#FC466B' },
         { key: 'mid',  role: '中間', val: p.mid },
         { key: 'to',   role: '終了', val: p.to || '#3F5EFB' }]
      : [{ key: 'from', role: '開始', val: p.from || '#FC466B' },
         { key: 'to',   role: '終了', val: p.to || '#3F5EFB' }];

    items.forEach((item) => {
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

    if (addBtn) {
      addBtn.classList.toggle('hidden', hasMid);
      addBtn.hidden = hasMid;
      addBtn.disabled = hasMid;
    }
  }

  function renderGradients(host, getPaint, onSelect) {
    if (!host) return;
    host.innerHTML = '';
    A.GRADIENTS.forEach(g => {
      const b = el('button', { class: 'grad-btn', type: 'button', title: g.name });
      const stops = g.mid ? [g.from, g.mid, g.to] : [g.from, g.to];
      b.style.background = 'linear-gradient(' + (g.angle + 90) + 'deg, ' + stops.join(', ') + ')';
      b.appendChild(el('span', null, g.name));
      b.addEventListener('click', () => {
        if (onSelect) onSelect();
        const p = getPaint();
        p.from = g.from;
        p.mid = g.mid || '';
        p.to = g.to;
        p.angle = g.angle;
        if (p.type === 'solid' || p.type === 'multi' || p.type === 'auto') p.type = 'linear';
        state.presetName = '';
        syncControls();
        syncPresetActive();
        update();
      });
      host.appendChild(b);
    });
  }

  function renderSwatches(host, onPickColor) {
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
          onPickColor(c);
          state.presetName = '';
          syncControls();
          syncPresetActive();
          update();
        });
        row.appendChild(b);
      });
      g.appendChild(row);
      host.appendChild(g);
    });
  }

  // 汎用スコープ（セル・マーカー・背景）
  function buildMultiColorsList(scope) {
    renderMultiColorsList(cq(scope, 'multi-colors-list'), paintOfScope(scope), cq(scope, 'btn-add-color'));
  }

  function buildMultiPalettes(scope) {
    renderMultiPalettes(cq(scope, 'multi-palette-grid'), () => paintOfScope(scope), () => { state.colorScope = scope; });
  }

  function buildGradColorsList(scope) {
    renderGradColorsList(cq(scope, 'grad-colors-list'), paintOfScope(scope), cq(scope, 'btn-add-grad-color'));
  }

  function buildSwatches(scope) {
    renderSwatches(cq(scope, 'swatch-host'), c => {
      state.colorScope = scope;
      const p = paintOfScope(scope);
      if (p.type === 'solid') {
        p.color = c;
      } else if (p.type === 'multi') {
        if (p.colors.indexOf(c) < 0 && p.colors.length < 8) p.colors.push(c);
        else p.colors[p.colors.length - 1] = c;
      } else {
        if (!p.mid) p.mid = c;
        else p.to = c;
      }
    });
  }

  function buildGradients(scope) {
    renderGradients(cq(scope, 'grad-grid'), () => paintOfScope(scope), () => { state.colorScope = scope; });
  }

  // 中央ロゴ用。
  // ロゴの塗り（getLogoPaint）は「アイコン」パネルと「文字」パネルで共有していて、
  // 部品の id もこの2つの頭違いで揃えてある。片方だけ描き直すと隠れているほうが
  // 古い値のまま残るので、どちらも同じ内容で起こす。
  const LOGO_PANES = ['logo', 'logo-text'];

  function buildLogoMultiColorsList() {
    LOGO_PANES.forEach(p => renderMultiColorsList($(p + '-multi-colors-list'), getLogoPaint(), $('btn-' + p + '-add-color')));
  }

  function buildLogoMultiPalettes() {
    LOGO_PANES.forEach(p => renderMultiPalettes($(p + '-multi-palette-grid'), getLogoPaint));
  }

  function buildLogoGradColorsList() {
    LOGO_PANES.forEach(p => renderGradColorsList($(p + '-grad-colors-list'), getLogoPaint(), $('btn-' + p + '-add-grad-color')));
  }

  function buildLogoGradients() {
    LOGO_PANES.forEach(p => renderGradients($(p + '-grad-grid'), getLogoPaint));
  }

  function buildLogoSwatches() {
    LOGO_PANES.forEach(p => renderSwatches($(p + '-swatch-host'), c => {
      const lp = getLogoPaint();
      lp.color = c;
      state.style.logo.color = c;
    }));
  }

  function renderIconSvg(icon, uidPrefix) {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', icon.vb);
    if (icon.rawSvg) {
      svg.innerHTML = icon.rawSvg.replace(/__UID__/g, (uidPrefix || 'icon_') + icon.id);
    } else {
      svg.setAttribute('fill', 'currentColor');
      icon.p.forEach(p => {
        const path = document.createElementNS(svgNS, 'path');
        path.setAttribute('d', p.d);
        if (p.e) path.setAttribute('fill-rule', 'evenodd');
        svg.appendChild(path);
      });
    }
    return svg;
  }

  function renderIconGrid(host, group, currentId, uidPrefix, onPick) {
    if (!host) return;
    host.innerHTML = '';
    A.ICONS.filter(i => i.group === group).forEach(icon => {
      const b = el('button', {
        class: 'icon-btn' + (currentId === icon.id ? ' active' : ''),
        type: 'button',
        title: icon.name,
        'aria-label': icon.name
      });
      b.dataset.id = icon.id;
      b.appendChild(renderIconSvg(icon, uidPrefix));
      b.addEventListener('click', () => {
        onPick(icon);
        Array.prototype.forEach.call(host.children, child => {
          child.classList.toggle('active', child.dataset.id === icon.id);
        });
        state.presetName = '';
        syncControls();
        update();
      });
      host.appendChild(b);
    });
  }

  function buildIconGrid() {
    renderIconGrid($('icon-grid'), state.iconGroup, state.style.logo.icon, 'grid_', icon => {
      state.style.logo.icon = icon.id;
      state.style.logo.iconData = icon;
      state.style.logo.type = 'icon';
      if (A.BRAND_COLORS[icon.id]) {
        state.style.logo.color = A.BRAND_COLORS[icon.id];
      }
    });
  }

  function buildFrameTopIconGrid() {
    const currentIcon = (state.style.frame && state.style.frame.topIcon) || 'si-instagram';
    renderIconGrid($('frame-top-icon-grid'), state.frameTopIconGroup, currentIcon, 'frame_top_grid_', icon => {
      state.style.frame.topIcon = icon.id;
      state.style.frame.topIconData = icon;
      state.style.frame.topContentMode = 'icon';
    });
  }

  function buildFrameBottomIconGrid() {
    const currentIcon = (state.style.frame && state.style.frame.icon) || 'si-instagram';
    renderIconGrid($('frame-bottom-icon-grid'), state.frameBottomIconGroup, currentIcon, 'frame_bot_grid_', icon => {
      state.style.frame.icon = icon.id;
      state.style.frame.iconData = icon;
      state.style.frame.contentMode = 'icon';
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
    const frameName = (A.FRAMES.find(f => f.id === state.style.frame.type) || {}).name || 'なし';
    const lineName = (A.FRAME_LINES.find(f => f.id === state.style.frame.line) || {}).name || '';
    $('hint-frame').textContent = state.style.frame.type === 'line' && lineName ? lineName : frameName;
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
    const isFrameBd = target === 'framebd';
    // 背景と下地は「敷く面」なので、白・黒・透明まで選べる
    const isPlate = isBg || isLogoBd || isFrameBd;

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

    const plateWord = isLogoBd ? 'ロゴの下地' : isFrameBd ? 'ラベルの下地' : '背景';
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
        : isFrameBd
          ? 'ラベルの下地を描きません。<br>文字やアイコンだけがフレームの上に載ります。'
          : '背景を透明にします。<br>透過PNGや透過SVGとして背景のない画像を書き出せます。';
    }

    const swatchHost = cq(scope, 'swatch-host');
    if (swatchHost) swatchHost.classList.toggle('hidden', isImage || isAuto || isNone || isWhite || isBlack);

    const transRow = cq(scope, 'transparency-row');
    if (transRow) transRow.classList.toggle('hidden', !isPlate || isNone || isWhite || isBlack);
    const transVal = p.transparency !== undefined ? p.transparency : 0;
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
    syncImageScaleRow(cq(scope, 'image-scale-row'), cq(scope, 'image-scale'),
      cq(scope, 'val-image-scale'), p, !!(isImage && p.src));

    if (isMulti) buildMultiColorsList(scope);
    else if (isGrad) buildGradColorsList(scope);
  }

  // 0.70 ではなく 0.7 と出す
  function fmtLineWidth(v) {
    return String(Math.round(Number(v) * 100) / 100);
  }

  function syncControls() {
    const s = state.style;

    syncShapeActive();
    updateFrameGridPreviews();

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
    syncImageScaleRow($('logo-image-scale-row'), $('logo-image-scale'),
      $('val-logo-image-scale'), lp, !!(isLImage && lp.src));
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

    const pTextGrad = $('logo-text-pane-grad');
    if (pTextGrad) pTextGrad.classList.toggle('hidden', !isLGrad);
    const textLogoGradAngleRow = $('logo-text-grad-angle-row');
    if (textLogoGradAngleRow) textLogoGradAngleRow.classList.toggle('hidden', lp.type === 'radial');
    const textAngleRange = $('logo-text-target-angle');
    const textAngleVal = $('val-logo-text-target-angle');
    if (textAngleRange) textAngleRange.value = lp.angle || 45;
    if (textAngleVal) textAngleVal.textContent = (lp.angle || 45) + '°';

    const pTextImage = $('logo-text-pane-image');
    if (pTextImage) pTextImage.classList.toggle('hidden', !isLImage);
    const textImgMaskThumb = $('logo-text-image-mask-thumb');
    if (textImgMaskThumb) {
      textImgMaskThumb.classList.toggle('hidden', !(isLImage && lp.src));
      if (lp.src) $('logo-text-image-mask-thumb-img').src = lp.src;
    }
    syncImageScaleRow($('logo-text-image-scale-row'), $('logo-text-image-scale'),
      $('val-logo-text-image-scale'), lp, !!(isLImage && lp.src));
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

    const isFrameLine = s.frame.type === 'line';
    const isFrameLabel = s.frame.type === 'label';
    if ($('frame-line-opts')) $('frame-line-opts').classList.toggle('hidden', !isFrameLine);
    if ($('frame-label-opts')) $('frame-label-opts').classList.toggle('hidden', !isFrameLabel);

    const isDoubleLine = s.frame.line === 'double';
    if ($('frame-line-width')) $('frame-line-width').value = s.frame.lineWidth;
    if ($('val-frame-line-width')) $('val-frame-line-width').textContent = fmtLineWidth(s.frame.lineWidth);
    if ($('frame-line-width2')) $('frame-line-width2').value = s.frame.lineWidth2;
    if ($('val-frame-line-width2')) $('val-frame-line-width2').textContent = fmtLineWidth(s.frame.lineWidth2);
    if ($('frame-line-width2-row')) $('frame-line-width2-row').classList.toggle('hidden', !isDoubleLine);
    if ($('frame-line-width-label')) $('frame-line-width-label').textContent = isDoubleLine ? '外側の太さ' : '太さ';
    if ($('frame-line-note')) {
      $('frame-line-note').textContent =
        s.frame.line === 'cells' ? '※ 太さは、外周に並べるセルの大きさです。セルの形と太さの設定に連動します。'
        : s.frame.line === 'stamp' ? '※ 太さは、ミシン目の内側にできる縁の幅です。'
        : s.frame.line === 'ticket' ? '※ 左右の切り欠きは、地をくり抜いて作っています。'
        : s.frame.line === 'balloon' ? '※ しっぽのぶん、下に伸びます。'
        : '';
    }

    const framePos = (s.frame && s.frame.pos) || 'bottom';
    setSeg('frame-pos-seg', framePos, 'pos');

    const showTop = framePos === 'top' || framePos === 'both';
    const showBottom = framePos === 'bottom' || framePos === 'both';
    const isBoth = framePos === 'both';

    if ($('frame-section-top')) $('frame-section-top').classList.toggle('hidden', !showTop);
    if ($('frame-section-bottom')) $('frame-section-bottom').classList.toggle('hidden', !showBottom);

    if ($('frame-top-heading')) $('frame-top-heading').textContent = isBoth ? '上部ラベルの内容' : 'ラベルの内容';
    if ($('frame-bottom-heading')) $('frame-bottom-heading').textContent = isBoth ? '下部ラベルの内容' : 'ラベルの内容';

    // ---- 上部ラベル同期 ----
    const topCMode = (s.frame && s.frame.topContentMode) || 'text';
    setSeg('frame-top-content-mode-seg', topCMode, 'mode');
    if ($('frame-top-pane-text')) $('frame-top-pane-text').classList.toggle('hidden', topCMode !== 'text');
    if ($('frame-top-pane-icon')) $('frame-top-pane-icon').classList.toggle('hidden', topCMode !== 'icon');
    if ($('frame-top-pane-image')) $('frame-top-pane-image').classList.toggle('hidden', topCMode !== 'image');

    if ($('frame-text-top')) $('frame-text-top').value = (s.frame && s.frame.textTop) || '';

    if ($('frame-top-icon-tabs')) {
      Array.prototype.forEach.call($('frame-top-icon-tabs').children, t => {
        t.classList.toggle('active', t.dataset.group === state.frameTopIconGroup);
      });
    }
    const currentTopIcon = (s.frame && s.frame.topIcon) || 'si-instagram';
    syncShapeGridActive('frame-top-icon-grid', currentTopIcon);
    const topIconColorMode = (s.frame && s.frame.topIconColorMode) || 'brand';
    setSeg('frame-top-icon-color-mode-seg', topIconColorMode, 'mode');
    if ($('frame-top-icon-pane-solid')) $('frame-top-icon-pane-solid').classList.toggle('hidden', topIconColorMode !== 'solid');
    const topIconColor = (s.frame && s.frame.topIconColor) || '#FFFFFF';
    if ($('frame-top-icon-solid-picker')) $('frame-top-icon-solid-picker').value = normHex(topIconColor, '#FFFFFF');
    if ($('frame-top-icon-solid-hex')) $('frame-top-icon-solid-hex').value = normHex(topIconColor, '#FFFFFF');

    const hasTopImg = !!(s.frame && s.frame.topSrc);
    if ($('frame-top-image-thumb')) {
      $('frame-top-image-thumb').classList.toggle('hidden', !hasTopImg);
      if (hasTopImg && $('frame-top-image-thumb-img')) {
        $('frame-top-image-thumb-img').src = s.frame.topSrc;
      }
    }

    // ---- 下部ラベル同期 ----
    const bottomCMode = (s.frame && s.frame.contentMode) || 'text';
    setSeg('frame-bottom-content-mode-seg', bottomCMode, 'mode');
    if ($('frame-bottom-pane-text')) $('frame-bottom-pane-text').classList.toggle('hidden', bottomCMode !== 'text');
    if ($('frame-bottom-pane-icon')) $('frame-bottom-pane-icon').classList.toggle('hidden', bottomCMode !== 'icon');
    if ($('frame-bottom-pane-image')) $('frame-bottom-pane-image').classList.toggle('hidden', bottomCMode !== 'image');

    if ($('frame-text')) $('frame-text').value = (s.frame && s.frame.text) || '';
    if ($('frame-text-label')) $('frame-text-label').textContent = isBoth ? '下部の文字' : 'フレームの文字';

    if ($('frame-bottom-icon-tabs')) {
      Array.prototype.forEach.call($('frame-bottom-icon-tabs').children, t => {
        t.classList.toggle('active', t.dataset.group === state.frameBottomIconGroup);
      });
    }
    const currentBottomIcon = (s.frame && s.frame.icon) || 'si-instagram';
    syncShapeGridActive('frame-bottom-icon-grid', currentBottomIcon);
    const bottomIconColorMode = (s.frame && s.frame.iconColorMode) || 'brand';
    setSeg('frame-bottom-icon-color-mode-seg', bottomIconColorMode, 'mode');
    if ($('frame-bottom-icon-pane-solid')) $('frame-bottom-icon-pane-solid').classList.toggle('hidden', bottomIconColorMode !== 'solid');
    const bottomIconColor = (s.frame && s.frame.iconColor) || '#FFFFFF';
    if ($('frame-bottom-icon-solid-picker')) $('frame-bottom-icon-solid-picker').value = normHex(bottomIconColor, '#FFFFFF');
    if ($('frame-bottom-icon-solid-hex')) $('frame-bottom-icon-solid-hex').value = normHex(bottomIconColor, '#FFFFFF');

    const hasBottomImg = !!(s.frame && s.frame.src);
    if ($('frame-bottom-image-thumb')) {
      $('frame-bottom-image-thumb').classList.toggle('hidden', !hasBottomImg);
      if (hasBottomImg && $('frame-bottom-image-thumb-img')) {
        $('frame-bottom-image-thumb-img').src = s.frame.src;
      }
    }

    // ---- 共通：中身の大きさ・余白 ----
    const fcSize = s.frame && s.frame.contentSize != null ? s.frame.contentSize : 1;
    const fcPad = s.frame && s.frame.contentPad != null ? s.frame.contentPad : 0.2;
    if ($('frame-content-size')) $('frame-content-size').value = fcSize;
    if ($('val-frame-content-size')) $('val-frame-content-size').textContent = Math.round(fcSize * 100) + '%';
    if ($('frame-content-pad')) $('frame-content-pad').value = fcPad;
    if ($('val-frame-content-pad')) $('val-frame-content-pad').textContent = Math.round(fcPad * 100) + '%';

    // ---- 共通：フォント ----
    setSeg('frame-font-seg', (s.frame && s.frame.font) || 'sans', 'font');
    const hasAnyText = (showTop && topCMode === 'text') || (showBottom && bottomCMode === 'text');
    if ($('frame-font-wrap')) $('frame-font-wrap').classList.toggle('hidden', !hasAnyText);
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
    saveSoon();
    // 市松模様はセルの色だけで決まる。描けたかどうかに関係なく合わせたいので、
    // 出口ごとに呼ばず入口で一度だけ。
    updateCanvasChecker();

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

  // 足りない余白を補うときの色。実際に地として描かれる色を使う。
  // 「セルの色」や「白」は指定でしかないので resolvePaint で解いてから訊く。
  // 透明（paintColor が null）は、読ませるときは白い紙の上とみなす。
  function padColor() {
    const bg = window.QRStyle.resolvePaint(state.style.bg, state.style.fg);
    return window.QRStyle.paintColor(bg) || '#FFFFFF';
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
  // ---- 書き出し用のフォント -------------------------------------------
  // 画面のプレビューはページが読み込んだ Google Fonts で描かれるが、書き出しは
  // SVG を data URL の <img> として読ませるため、外部リソースを取りに行けず、
  // ページのフォントも受け継がない。放っておくと、選んだ書体が画面にだけ効いて
  // 書き出した画像は既定の書体になる（実測でも指定あり／なしが同じ形になった）。
  //
  // そこで書き出す直前に「いま実際に使っている字だけ」を woff2 で取り寄せて、
  // @font-face として SVG に埋める。Google Fonts の &text= で欲しい字だけに
  // 絞れるので、数キロバイトで済む。
  //
  // 取り寄せに失敗しても書き出し自体は止めない（今までどおり既定の書体で出る）。
  // 直近ぶんだけ覚えておく。字面が変わるたびに別の項目になるので、
  // 上限を置かないと base64 のフォントがセッション中ずっと溜まりつづける。
  const FONT_CACHE_MAX = 8;
  const fontCssCache = new Map();

  async function fetchWithTimeout(url, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(url, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchFontFace(run) {
    const cssUrl = 'https://fonts.googleapis.com/css2?family=' +
      encodeURIComponent(run.web).replace(/%20/g, '+') + ':wght@' + run.weight +
      '&text=' + encodeURIComponent(run.text);
    const cssRes = await fetchWithTimeout(cssUrl, 6000);
    if (!cssRes.ok) throw new Error('font css ' + cssRes.status);
    const css = await cssRes.text();

    // &text= を付けたときの応答は @font-face ひとつ。そこから woff2 の URL を拾う。
    // 字を絞った配信は拡張子が付かない（/l/font?kit=… の形）ので、
    // 拡張子ではなく format('woff2') の側で見分ける。
    const m = css.match(/url\((https:\/\/[^)]+)\)\s*format\('woff2'\)/);
    if (!m) throw new Error('no woff2');
    const fontRes = await fetchWithTimeout(m[1], 6000);
    if (!fontRes.ok) throw new Error('font ' + fontRes.status);
    const dataUrl = await blobToDataUrl(await fontRes.blob());

    return '@font-face{font-family:"' + run.web + '";font-style:normal;font-weight:' +
      run.weight + ";src:url(" + dataUrl + ") format('woff2');}";
  }

  // 覚えるのは「結果」ではなく「取り寄せ中の約束」。書き出しを続けて押しても
  // 取りに行くのは一度で済み、取れなかったこと自体も覚える（取れない環境で
  // 書き出すたびに待ち時間だけ払う、ということがなくなる）。
  function fontFaceCss(run) {
    const key = run.web + '|' + run.weight + '|' + run.text;
    let p = fontCssCache.get(key);
    if (!p) {
      p = fetchFontFace(run).catch(() => '');
      fontCssCache.set(key, p);
      if (fontCssCache.size > FONT_CACHE_MAX) {
        fontCssCache.delete(fontCssCache.keys().next().value);
      }
    }
    return p;
  }

  // 書き出す SVG に、その絵で使っている書体を埋めて返す。取れなかったぶんは諦める。
  async function withExportFonts(svg) {
    let runs = [];
    try { runs = window.QRStyle.textRuns(state.style); } catch (e) { return svg; }
    if (!runs.length) return svg;
    const faces = await Promise.all(runs.map(fontFaceCss));
    return window.QRStyle.embedFontCss(svg, faces.join(''));
  }

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
      const canvas = await rasterize(await withExportFonts(lastSvg), state.exportSize, flatten);
      const blob = await new Promise(res => canvas.toBlob(res, mime, quality));
      if (!blob) throw new Error('encode failed');
      // 対応していない形式を渡すと、黙って PNG が返ってくる。拡張子を偽らない
      const realExt = blob.type === mime ? ext : (blob.type.split('/')[1] || ext);
      saveBlob(blob, fileStem() + '.' + realExt);
      showToast(realExt === ext
        ? ext.toUpperCase() + 'を保存しました'
        : 'このブラウザは' + ext.toUpperCase() + 'に対応していないため' +
          realExt.toUpperCase() + 'で保存しました');
    } catch (e) {
      showToast('書き出しに失敗しました', 'error');
    }
    setStatus('ready', 'idle');
  }

  async function exportSvg() {
    if (!lastSvg) { showToast('先に内容を入力してください', 'error'); return; }
    const doc = '<?xml version="1.0" encoding="UTF-8"?>' + String.fromCharCode(10) +
      window.QRStyle.resize(await withExportFonts(lastSvg), 1024);
    saveBlob(new Blob([doc], { type: 'image/svg+xml;charset=utf-8' }), fileStem() + '.svg');
    showToast('SVGを保存しました');
  }

  async function copyImage() {
    if (!lastSvg) { showToast('先に内容を入力してください', 'error'); return; }
    if (!navigator.clipboard || typeof window.ClipboardItem === 'undefined') {
      showToast('このブラウザは画像コピーに対応していません', 'error');
      return;
    }
    // Safari は「押されてすぐ」でないと書き込ませてくれない。描き終わってから
    // write を呼ぶと操作の有効期限が切れるので、中身は Promise のまま渡す。
    const png = (async () => {
      const canvas = await rasterize(await withExportFonts(lastSvg), Math.min(2048, state.exportSize), null);
      const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
      if (!blob) throw new Error('encode failed');
      return blob;
    })();
    try {
      await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': png })]);
      showToast('画像をコピーしました');
      if (window.STShare) STShare.celebrate();
    } catch (e) {
      // Promise を受け付けない実装もあるので、その場合は焼けた Blob で入れ直す
      try {
        await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': await png })]);
        showToast('画像をコピーしました');
        if (window.STShare) STShare.celebrate();
      } catch (e2) {
        showToast('コピーできませんでした', 'error');
      }
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
      syncPresetActive();
      update({ debounceVerify: true });
    });
    picker.addEventListener('change', () => {
      if (verifyTimer) {
        clearTimeout(verifyTimer);
        verifyTimer = null;
        if (lastSvg && lastPayload) verify(lastSvg, lastPayload, false);
      }
    });
    if (hex) {
      hex.addEventListener('change', () => {
        const v = normHex(hex.value, null);
        if (!v) { showToast('カラーコードの形式が違います', 'error'); return; }
        hex.value = v;
        picker.value = v;
        apply(v);
        state.presetName = '';
        syncPresetActive();
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
        syncPresetActive();
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

  // ---- 画像の受け口 --------------------------------------------------
  // ドロップ・ファイル選択・URL入力の配線は、行き先が違うだけで中身は同じ。
  // before は「押される前にやること」（色パネルは、いま触っている対象を移す）。

  // 落とされたものを受けるだけの部分。プレビュー領域のように、
  // ファイル選択ボタンを持たない場所でも使う。
  // 枠そのもの（クリック・Enter/Space・ドラッグ中の見た目・ファイルの受け取り）は
  // ツール共通の STCommon.setupDropzone に任せる。ここで足すのは2つだけ：
  //   - 他のブラウザ窓から画像を引くと、ファイルではなく URL が落ちてくる
  //   - ファイル選択ダイアログの change（共通側は click までしか見ない）
  // fileId を渡さなければ、落とすだけの領域（プレビュー）として使える。
  function wireImageDrop(zoneId, fileId, target, before) {
    const zone = asEl(zoneId);
    if (!zone) return;
    const fileInput = fileId ? asEl(fileId) : null;
    const take = file => { if (before) before(); loadImageFile(file, target); };

    window.STCommon.setupDropzone({
      dropzone: zone,
      fileInput: fileInput,
      onFiles: files => take(files[0])
    });

    zone.addEventListener('drop', e => {
      const dt = e.dataTransfer;
      if (!dt || (dt.files && dt.files.length)) return;   // ファイルは共通側が受けている
      const url = dt.getData('text/uri-list') || dt.getData('text/plain');
      if (!url) return;
      if (before) before();
      loadImageUrl(url, target);
    });

    if (fileInput) {
      fileInput.addEventListener('change', e => {
        if (e.target.files && e.target.files.length) take(e.target.files[0]);
      });
    }
  }

  // URLで指定する欄（ボタンと Enter の両方）
  function wireImageUrlInput(btnId, inputId, target, before) {
    const btn = asEl(btnId), input = asEl(inputId);
    if (!btn || !input) return;
    const go = () => { if (before) before(); loadImageUrl(input.value, target); };
    btn.addEventListener('click', go);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); go(); }
    });
  }

  // 画像を外す。file 欄を空にしないと、同じファイルを選び直しても change が出ない
  function wireImageClear(btnId, fileId, clear) {
    const btn = asEl(btnId);
    if (!btn) return;
    btn.addEventListener('click', () => {
      clear();
      const fileInput = asEl(fileId);
      if (fileInput) fileInput.value = '';
      state.presetName = '';
      syncControls();
      update();
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
    wireImageDrop(cq(scope, 'image-drop'), cq(scope, 'image-file'),
      IMAGE_TARGETS.target, touch);
    bindRange(cq(scope, 'image-scale'), cq(scope, 'val-image-scale'), v => Math.round(v) + '%', v => {
      touch();
      paintOfScope(scope).imgScale = Math.round(v) / 100;
    });
    const scaleReset = cq(scope, 'btn-image-scale-reset');
    if (scaleReset) scaleReset.addEventListener('click', () => {
      touch();
      paintOfScope(scope).imgScale = 1;
      state.presetName = '';
      syncControls();
      update();
    });

    wireImageClear(cq(scope, 'btn-image-clear'), cq(scope, 'image-file'), () => {
      touch();
      const p = paintOfScope(scope);
      p.src = '';
      p.type = (scope === 'frame' || scope === 'eye') ? 'auto' : 'solid';
    });
    wireImageUrlInput(cq(scope, 'btn-image-url'), cq(scope, 'image-url'),
      IMAGE_TARGETS.target, touch);
  }

  function wire() {
    $('opt-ec').addEventListener('change', e => { state.ec = e.target.value; syncControls(); update(); });
    $('opt-size').addEventListener('change', e => { state.exportSize = parseInt(e.target.value, 10); saveNow(); });

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

    // ロゴの塗りは「アイコン」パネルと「文字」パネルの両方から触れる。中身は
    // getLogoPaint() ひとつなので、同じ操作を id の頭だけ変えて2枚ぶん結線する。
    // 片方を動かしたらもう片方の目盛りも合うよう、どの操作も syncControls を通す。
    const afterLogoPaint = () => {
      state.presetName = '';
      syncControls();
      update();
    };

    LOGO_PANES.forEach(pane => {
      bindSeg(pane + '-color-mode-seg', 'mode', v => {
        getLogoPaint().type = v;
        afterLogoPaint();
      });

      bindColor(pane + '-solid-picker', pane + '-solid-hex', v => {
        getLogoPaint().color = v;
        state.style.logo.color = v;
        state.presetName = '';
        update();
      });

      bindRange(pane + '-target-angle', 'val-' + pane + '-target-angle', v => v + '°', v => {
        getLogoPaint().angle = v;
        state.presetName = '';
        update();
      });

      const addColor = $('btn-' + pane + '-add-color');
      if (addColor) addColor.addEventListener('click', () => {
        const lp = getLogoPaint();
        if (!Array.isArray(lp.colors)) lp.colors = ['#2563EB', '#7C3AED'];
        if (lp.colors.length >= 8) return;
        const last = lp.colors[lp.colors.length - 1];
        const prev = lp.colors.length > 1 ? lp.colors[lp.colors.length - 2] : '#2563EB';
        lp.colors.push(blendHex(last, prev));
        afterLogoPaint();
      });

      const shuffleColor = $('btn-' + pane + '-shuffle-color');
      if (shuffleColor) shuffleColor.addEventListener('click', () => {
        const lp = getLogoPaint();
        if (!Array.isArray(lp.colors) || lp.colors.length <= 1) return;
        for (let i = lp.colors.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          const t = lp.colors[i];
          lp.colors[i] = lp.colors[j];
          lp.colors[j] = t;
        }
        lp.seed = (lp.seed || 0) + 1;
        afterLogoPaint();
      });

      const addGrad = $('btn-' + pane + '-add-grad-color');
      if (addGrad) addGrad.addEventListener('click', () => {
        const lp = getLogoPaint();
        if (lp.mid) return;
        lp.mid = blendHex(lp.from || '#FC466B', lp.to || '#3F5EFB');
        afterLogoPaint();
      });

      // 塗りに敷く画像（マスク）
      wireImageDrop(pane + '-image-mask-drop', pane + '-image-mask-file',
        IMAGE_TARGETS.logoMask);
      wireImageUrlInput('btn-' + pane + '-image-mask-url', pane + '-image-mask-url',
        IMAGE_TARGETS.logoMask);
      wireImageClear('btn-' + pane + '-image-mask-clear', pane + '-image-mask-file', () => {
        getLogoPaint().src = '';
      });

      bindRange(pane + '-image-scale', 'val-' + pane + '-image-scale', v => Math.round(v) + '%', v => {
        getLogoPaint().imgScale = Math.round(v) / 100;
        state.presetName = '';
        syncControls();
      });
      const scaleReset = $('btn-' + pane + '-image-scale-reset');
      if (scaleReset) scaleReset.addEventListener('click', () => {
        getLogoPaint().imgScale = 1;
        afterLogoPaint();
      });
    });
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
    bindRange('frame-line-width', 'val-frame-line-width', fmtLineWidth, v => { state.style.frame.lineWidth = v; });
    bindRange('frame-line-width2', 'val-frame-line-width2', fmtLineWidth, v => { state.style.frame.lineWidth2 = v; });
    bindRange('frame-content-size', 'val-frame-content-size', v => Math.round(v * 100) + '%', v => { state.style.frame.contentSize = v; });
    bindRange('frame-content-pad', 'val-frame-content-pad', v => Math.round(v * 100) + '%', v => { state.style.frame.contentPad = v; });

    $('logo-text').addEventListener('input', e => {
      state.style.logo.text = e.target.value;
      state.presetName = '';
      scheduleUpdate();
    });

    bindSeg('logo-font-seg', 'font', v => {
      state.style.logo.font = v;
      state.presetName = '';
      update();
    });

    bindSeg('frame-pos-seg', 'pos', v => {
      state.style.frame.pos = v;
      state.presetName = '';
      syncControls();
      update();
    });

    bindSeg('frame-font-seg', 'font', v => {
      state.style.frame.font = v;
      state.presetName = '';
      update();
    });

    // ---- 上部ラベル ----
    bindSeg('frame-top-content-mode-seg', 'mode', v => {
      state.style.frame.topContentMode = v;
      if (v === 'icon' && !state.style.frame.topIconData) {
        const first = A.ICONS.find(i => i.group === state.frameTopIconGroup) || A.ICONS[0];
        state.style.frame.topIcon = first.id;
        state.style.frame.topIconData = first;
        buildFrameTopIconGrid();
      }
      state.presetName = '';
      syncControls();
      update();
    });

    const frameTopIconTabs = $('frame-top-icon-tabs');
    if (frameTopIconTabs) {
      Array.prototype.forEach.call(frameTopIconTabs.children, b => {
        b.addEventListener('click', () => {
          state.frameTopIconGroup = b.dataset.group;
          Array.prototype.forEach.call(frameTopIconTabs.children, t => t.classList.toggle('active', t === b));
          buildFrameTopIconGrid();
        });
      });
    }

    bindSeg('frame-top-icon-color-mode-seg', 'mode', v => {
      state.style.frame.topIconColorMode = v;
      state.presetName = '';
      syncControls();
      update();
    });

    bindColor('frame-top-icon-solid-picker', 'frame-top-icon-solid-hex', v => {
      state.style.frame.topIconColor = v;
      state.presetName = '';
      update();
    });

    // ---- 下部ラベル ----
    bindSeg('frame-bottom-content-mode-seg', 'mode', v => {
      state.style.frame.contentMode = v;
      if (v === 'icon' && !state.style.frame.iconData) {
        const first = A.ICONS.find(i => i.group === state.frameBottomIconGroup) || A.ICONS[0];
        state.style.frame.icon = first.id;
        state.style.frame.iconData = first;
        buildFrameBottomIconGrid();
      }
      state.presetName = '';
      syncControls();
      update();
    });

    const frameBottomIconTabs = $('frame-bottom-icon-tabs');
    if (frameBottomIconTabs) {
      Array.prototype.forEach.call(frameBottomIconTabs.children, b => {
        b.addEventListener('click', () => {
          state.frameBottomIconGroup = b.dataset.group;
          Array.prototype.forEach.call(frameBottomIconTabs.children, t => t.classList.toggle('active', t === b));
          buildFrameBottomIconGrid();
        });
      });
    }

    bindSeg('frame-bottom-icon-color-mode-seg', 'mode', v => {
      state.style.frame.iconColorMode = v;
      state.presetName = '';
      syncControls();
      update();
    });

    bindColor('frame-bottom-icon-solid-picker', 'frame-bottom-icon-solid-hex', v => {
      state.style.frame.iconColor = v;
      state.presetName = '';
      update();
    });

    $('frame-text').addEventListener('input', e => {
      state.style.frame.text = e.target.value;
      scheduleUpdate();
    });

    const frameTextTop = $('frame-text-top');
    if (frameTextTop) {
      frameTextTop.addEventListener('input', e => {
        state.style.frame.textTop = e.target.value;
        scheduleUpdate();
      });
    }

    Array.prototype.forEach.call($('icon-tabs').children, b => {
      b.addEventListener('click', () => {
        state.iconGroup = b.dataset.group;
        Array.prototype.forEach.call($('icon-tabs').children, x => x.classList.toggle('active', x === b));
        buildIconGrid();
        syncControls();
        saveNow();
      });
    });

    // ---- ロゴ画像 ----
    wireImageDrop('logo-drop', 'logo-file', IMAGE_TARGETS.logo);
    wireImageUrlInput('btn-logo-image-url', 'logo-image-url', IMAGE_TARGETS.logo);
    wireImageClear('btn-logo-clear', 'logo-file', () => {
      state.style.logo.src = '';
      state.style.logo.type = 'none';
    });

    // ---- 上下フレームの画像 ----
    wireImageDrop('frame-top-image-drop', 'frame-top-image-file', IMAGE_TARGETS.frameTop);
    wireImageUrlInput('btn-frame-top-image-url', 'frame-top-image-url', IMAGE_TARGETS.frameTop);
    wireImageClear('btn-frame-top-image-clear', 'frame-top-image-file', () => { state.style.frame.topSrc = ''; });

    wireImageDrop('frame-bottom-image-drop', 'frame-bottom-image-file', IMAGE_TARGETS.frameBottom);
    wireImageUrlInput('btn-frame-bottom-image-url', 'frame-bottom-image-url', IMAGE_TARGETS.frameBottom);
    wireImageClear('btn-frame-bottom-image-clear', 'frame-bottom-image-file', () => { state.style.frame.src = ''; });

    // ---- プレビュー領域への画像ドロップ（選択中の対象画像として反映） ----
    wireImageDrop(document.querySelector('.canvas-card'), null, IMAGE_TARGETS.target);


    // ---- プレビュー市松模様の明暗切り替え ----
    const checkerToggle = $('checker-toggle');
    if (checkerToggle) {
      Array.prototype.forEach.call(checkerToggle.children, btn => {
        btn.addEventListener('click', () => {
          state.previewChecker = btn.dataset.checker || 'auto';
          updateCanvasChecker();
          saveNow();
        });
      });
    }

    // ---- ツールバー ----
    $('btn-shuffle').addEventListener('click', shuffle);
    $('btn-reset').addEventListener('click', () => {
      state.style = JSON.parse(JSON.stringify(window.QRStyle.DEFAULTS));
      // セルの密度も「自動」に戻す（密度だけ style ではなく state 側にある）
      state.minVersion = 1;
      state.presetName = '';
      syncControls();
      buildShapeGrids();
      buildFrameChips();
      syncPresetActive();
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

    // 保存はまとめて後回しにしているので、離れる前に取りこぼしを書き切る
    window.addEventListener('pagehide', saveNow);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') saveNow();
    });
  }

  // 中身が正しく伝わるエラー。これを投げたぶんは文面をそのまま出す。
  function imageError(message) {
    const e = new Error(message);
    e.shown = true;
    return e;
  }

  async function fetchImageAsDataUrl(url) {
    const clean = sanitizeImageUrl(url);
    if (!clean) throw imageError('有効な画像URL（https://... または data:image/...）を入力してください');
    if (clean.startsWith('data:image/')) {
      return clean;
    }
    // 社内・家庭内のアドレスは取りに行かない（他のツールと同じ扱い）
    try {
      if (window.STCommon.isPrivateHost(new URL(clean).hostname)) {
        throw imageError('このアドレスからは取得できません。公開されているURLを指定してください');
      }
    } catch (err) {
      throw err.shown ? err : imageError('URLの形式が正しくありません');
    }
    let res;
    // fetch そのものが失敗するのは、相手が CORS を許していないときがほとんど。
    // 応答が返ってきたあとの失敗（404・サイズ超過・読み込み失敗）まで
    // CORS のせいにすると、直しようのない案内をしてしまう。
    try {
      res = await fetch(clean, { mode: 'cors' });
    } catch (err) {
      throw imageError('外部サーバーの画像保護（CORS）により取得できませんでした。端末から画像ファイルを直接アップロードしてください');
    }
    if (!res.ok) throw imageError('画像を取得できませんでした（HTTP ' + res.status + '）。URLを確認してください');
    const blob = await res.blob();
    if (blob.size > MAX_IMAGE_BYTES) throw imageError('画像は4MBまでにしてください');
    if (blob.type && blob.type.indexOf('image/') !== 0) {
      throw imageError('画像ではないものが返ってきました。URLを確認してください');
    }
    return blobToDataUrl(blob).catch(() => {
      throw imageError('画像の読み込みに失敗しました');
    });
  }

  // 色パネルのスコープ名 → 画面で呼んでいる名前。COLOR_SCOPES と同じ顔ぶれを
  // 揃えておくこと（抜けると、別の対象に適用したのに「背景」と案内してしまう）。
  const TARGET_LABELS = {
    cell: 'セル',
    frame: 'マーカー枠',
    eye: 'マーカー目',
    bg: '背景',
    logobd: 'ロゴの下地',
    frameborder: 'フレームの線',
    framelabel: 'フレームの帯',
    frametext: 'フレームの文字',
    framebd: 'ラベルの下地'
  };

  function getTargetLabel() {
    return TARGET_LABELS[scopeTarget(state.colorScope)] || '背景';
  }

  // 画像の受け口。ファイルからでもURLからでも、入り口の検査と後始末は同じで、
  // 違うのは「どこに入れるか」だけ。行き先ごとに apply / label / urlInputs を持つ。
  // label と urlInputs はどれも関数（色パネル向けは、いま触っている対象で
  // 中身が変わるため）。
  const IMAGE_TARGETS = {
    logo: {
      label: () => 'ロゴ画像',
      urlInputs: () => [$('logo-image-url')],
      apply: src => {
        state.style.logo.src = src;
        state.style.logo.type = 'image';
      }
    },
    // アイコン・文字ロゴの「塗り」に敷く画像。入力欄は2枚のパネルに1つずつある
    logoMask: {
      label: () => 'ロゴの塗り画像',
      urlInputs: () => [$('logo-image-mask-url'), $('logo-text-image-mask-url')],
      apply: src => { getLogoPaint().src = src; }
    },
    frameTop: {
      label: () => '上部フレーム画像',
      urlInputs: () => [$('frame-top-image-url')],
      apply: src => {
        state.style.frame.topSrc = src;
        state.style.frame.topContentMode = 'image';
      }
    },
    frameBottom: {
      label: () => '下部フレーム画像',
      urlInputs: () => [$('frame-bottom-image-url')],
      apply: src => {
        state.style.frame.src = src;
        state.style.frame.contentMode = 'image';
      }
    },
    // いま触っている色パネルの塗り。入力欄はそのパネルの中にある
    target: {
      label: () => getTargetLabel() + '画像',
      urlInputs: () => [cq(state.colorScope, 'image-url')],
      apply: src => {
        const p = getActivePaint();
        p.src = src;
        p.type = 'image';
      }
    }
  };

  function applyImage(src, target) {
    target.apply(src);
    state.presetName = '';
    syncControls();
    update();
    target.urlInputs().forEach(input => { if (input) input.value = ''; });
    showToast(target.label() + 'を適用しました');
  }

  function loadImageFile(file, target) {
    if (!file || !file.type || file.type.indexOf('image/') !== 0) {
      showToast('画像ファイルを選んでください', 'error');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      showToast('画像は4MBまでにしてください', 'error');
      return;
    }
    blobToDataUrl(file).then(
      src => applyImage(src, target),
      () => showToast('画像を読み込めませんでした', 'error')
    );
  }

  async function loadImageUrl(url, target) {
    const s = String(url || '').trim();
    if (!s) return;
    try {
      showToast('画像を読み込み中…');
      // ここで必ず data URL に焼く。URL のまま持つと、画面には出るのに
      // 書き出した画像からは消える（書き出しの SVG は外部を取りに行けない）。
      applyImage(await fetchImageAsDataUrl(s), target);
    } catch (err) {
      showToast((err && err.shown && err.message) || '画像を読み込めませんでした', 'error');
    }
  }



  function pick(list) { return list[Math.floor(Math.random() * list.length)]; }

  // おまかせデザイン。押すたびにはっきり違うものが出るように、
  // 「地の明暗 → 塗り方 → 形 → フレーム」の順に振っていく。
  // 塗りは丸ごと差し替えるので、必ず既定値にマージして欠けたキーを埋める
  // （transparency が抜けると背景が透けてしまうため）。
  function shuffle() {
    const s = state.style;
    const D = window.QRStyle.DEFAULTS;
    const M = window.QRStyle.merge;
    const contrast = window.QRStyle.contrastRatio;

    // ---- 地の色。4回に1回くらいは暗い地（反転デザイン）にする ----
    const lightGrounds = ['#FFFFFF', '#FFFFFF', '#FFFFFF', '#FAFAFA', '#F8FAFC', '#FFF8F0',
                          '#F7F4EE', '#F0FDF4', '#FDF2F8', '#EEF2FF', '#FFFBEB', '#ECFEFF'];
    const darkGrounds = ['#0B1220', '#09090B', '#111827', '#0F172A', '#172554',
                         '#1E1B4B', '#022C22', '#3B0764'];
    const dark = Math.random() < 0.25;
    const ground = pick(dark ? darkGrounds : lightGrounds);
    const readable = c => contrast(c, ground) >= 5;

    const solids = [];
    A.SWATCHES.forEach(group => group.colors.forEach(c => { if (readable(c)) solids.push(c); }));
    const grads = A.GRADIENTS.filter(g => readable(g.from) && readable(g.to) && (!g.mid || readable(g.mid)));
    const accent = () => (solids.length ? pick(solids) : (dark ? '#F8FAFC' : '#111827'));

    // ---- セルの塗り。単色ばかりにならないよう塗り方から振る ----
    const roll = Math.random();
    let fg = null;
    if (roll < 0.34 && grads.length) {
      const g = pick(grads);
      fg = {
        type: Math.random() < 0.28 ? 'radial' : 'linear',
        color: g.from, from: g.from, to: g.to,
        mid: (g.mid && Math.random() < 0.5) ? g.mid : '',
        angle: pick([0, 30, 45, 60, 90, 120, 135, 180, 225, 270, 315])
      };
    } else if (roll < 0.5 && solids.length >= 4) {
      const colors = [];
      const want = pick([3, 3, 4]);
      let guard = 0;
      while (colors.length < want && guard++ < 40) {
        const c = pick(solids);
        if (colors.indexOf(c) < 0) colors.push(c);
      }
      fg = { type: 'multi', colors: colors, seed: Math.floor(Math.random() * 1000) };
    }
    if (!fg) fg = { type: 'solid', color: accent() };

    s.fg = M(D.fg, fg);
    s.bg = M(D.bg, { type: 'solid', color: ground, transparency: 0 });
    // 暗い地に明るいセルを置くのは意図したデザインなので、反転の注意は補足に落とす
    s.invertOk = dark;

    // ---- 形 ----
    s.cell = pick(A.CELL_SHAPES).id;
    s.markerFrame = pick(A.MARKER_FRAMES).id;
    s.markerEye = pick(A.MARKER_EYES).id;
    s.cellScale = pick([0.9, 0.95, 1, 1, 1, 1.05]);
    s.cellJitter = pick([0, 0, 0, 0, 0.15, 0.3]);
    s.radius = pick([0, 0, 1, 2, 3, 4, 6, 8]);
    s.margin = 4;
    state.minVersion = 1;

    // ---- マーカーの色 ----
    s.markerFrameColor = '';
    s.markerEyeColor = '';
    s.markerFramePaint = M(D.markerFramePaint,
      Math.random() < 0.45 ? { type: 'solid', color: accent() } : { type: 'auto' });
    s.markerEyePaint = M(D.markerEyePaint,
      Math.random() < 0.35 ? { type: 'solid', color: accent() } : { type: 'auto' });

    // ---- フレーム。半分は枠なし、残りを枠線とラベルで分ける ----
    const frameRoll = Math.random();
    if (frameRoll < 0.5) {
      s.frame.type = 'none';
    } else if (frameRoll < 0.78) {
      const lineId = pick(A.FRAME_LINES).id;
      const ls = window.QRStyle.LINE_STYLES[lineId] || {};
      s.frame.type = 'line';
      s.frame.line = lineId;
      s.frame.lineWidth = ls.stroke || 0.7;
      s.frame.lineWidth2 = ls.inner || 0.28;
      s.frame.paint = M(D.frame.paint,
        Math.random() < 0.5 ? { type: 'auto' } : { type: 'solid', color: accent() });
    } else {
      // ラベルは帯の色を先に決めて、そのうえで読める文字色を選ぶ
      const band = accent();
      const onBand = contrast(band, '#FFFFFF') >= contrast(band, '#111827') ? '#FFFFFF' : '#111827';
      s.frame.type = 'label';
      s.frame.pos = pick(['bottom', 'bottom', 'bottom', 'top', 'both']);
      s.frame.contentMode = 'text';
      s.frame.topContentMode = 'text';
      s.frame.text = pick(['スキャンしてね', 'SCAN ME', '読み取ってください', 'こちらから', 'MENU', 'FOLLOW US']);
      const tops = ['SCAN ME', 'ようこそ', 'FOLLOW US', 'MENU'].filter(t => t !== s.frame.text);
      s.frame.textTop = s.frame.pos === 'bottom' ? '' : pick(tops);
      s.frame.font = pick(FONTS);
      s.frame.contentSize = pick([0.85, 0.9, 1, 1, 1.1]);
      s.frame.contentPad = 0.2;
      s.frame.paint = M(D.frame.paint, { type: 'solid', color: band });
      s.frame.textPaint = M(D.frame.textPaint, { type: 'solid', color: onBand });
      s.frame.backdropPaint = M(D.frame.backdropPaint, { type: 'none' });
    }

    state.presetName = '';

    syncControls();
    buildShapeGrids();
    buildFrameChips();
    // テンプレートの見本は state に依存しないので、選択状態を移すだけでよい
    syncPresetActive();
    update();
  }

  // ------------------------------------------------------------------
  // 起動
  // ------------------------------------------------------------------
  function init() {
    // 飾りのアイコンは CDN 頼み。取れなかったときにここで転ぶと、
    // ローカルだけで動くはずの本体まで巻き添えで死ぬ。
    if (window.lucide) lucide.createIcons();
    $('currentYear').textContent = new Date().getFullYear();

    restore();
    Array.prototype.forEach.call($('icon-tabs').children, b => {
      b.classList.toggle('active', b.dataset.group === state.iconGroup);
    });

    buildTypeChips();
    buildTypeFields();
    buildPresetCategoryChips();
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
    buildIconGrid();
    buildFrameTopIconGrid();
    buildFrameBottomIconGrid();
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
