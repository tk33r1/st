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

  // MeCard は区切りが ; と : で、姓名の区切りに , まで使う。vCard とは
  // 顔ぶれが違うので別に持つ。
  function mecardEscape(v) {
    const special = [BACKSLASH, ';', ':', ','];
    let out = '';
    const s = String(v || '');
    for (let i = 0; i < s.length; i++) {
      const ch = s.charAt(i);
      if (ch === String.fromCharCode(10) || ch === String.fromCharCode(13)) { out += ' '; continue; }
      out += special.indexOf(ch) >= 0 ? BACKSLASH + ch : ch;
    }
    return out;
  }

  // 予定の中身から決まる 32bit の値（FNV-1a）。UID に使う。
  // DTSTAMP（規格上は必須）は入れていない。中身は「この iCal を書き出した時刻」
  // なので、入れると再描画のたびに QR が変わってしまう。実機の取り込みでは
  // DTSTAMP 無しが問題になったことはないので、安定するほうを取る。
  function eventUid(f, start, end) {
    const src = [f.title, start, end, f.location, f.desc].join(String.fromCharCode(31));
    let h = 0x811c9dc5;
    for (let i = 0; i < src.length; i++) {
      h ^= src.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36);
  }

  const TYPES = [
    {
      id: 'url', name: 'URL', hint: 'URL',
      fields: [{ k: 'url', label: 'リンク先URL', type: 'url', ph: 'https://tk.st/' }],
      init: { url: 'https://tk.st/tools/qr-atelier/' },
      build: f => normalizeUrl(f.url)
    },
    {
      id: 'sns', name: 'SNS', hint: 'SNS',
      fields: [
        {
          k: 'platform', label: 'サービス', type: 'select',
          options: [
            ['instagram', 'Instagram'],
            ['x', 'X（Twitter）'],
            ['line', 'LINE（友だち・公式）'],
            ['tiktok', 'TikTok'],
            ['youtube', 'YouTube'],
            ['threads', 'Threads'],
            ['bluesky', 'Bluesky'],
            ['github', 'GitHub'],
            ['note', 'note'],
            ['facebook', 'Facebook']
          ]
        },
        { k: 'id', label: 'ユーザー名 / ID', type: 'text', ph: '例: shitake' }
      ],
      init: { platform: 'instagram', id: '' },
      build: f => {
        const id = String(f.id || '').trim().replace(/^@/, '');
        if (!id) return '';
        switch (f.platform) {
          case 'instagram': return 'https://www.instagram.com/' + id + '/';
          case 'x': return 'https://x.com/' + id;
          case 'line': return 'https://line.me/R/ti/p/~' + id;
          case 'tiktok': return 'https://www.tiktok.com/@' + id;
          case 'youtube': return (id.startsWith('UC') || id.startsWith('@')) ? 'https://www.youtube.com/' + id : 'https://www.youtube.com/@' + id;
          case 'threads': return 'https://www.threads.net/@' + id;
          case 'bluesky': return 'https://bsky.app/profile/' + (id.indexOf('.') >= 0 ? id : id + '.bsky.social');
          case 'github': return 'https://github.com/' + id;
          case 'note': return 'https://note.com/' + id;
          case 'facebook': return 'https://www.facebook.com/' + id;
          default: return normalizeUrl(id);
        }
      }
    },
    {
      id: 'text', name: 'テキスト', hint: 'テキスト',
      fields: [{ k: 'text', label: '好きな文章', type: 'textarea', ph: 'そのまま表示される文字列' }],
      init: { text: '' },
      build: f => String(f.text || '')
    },
    {
      id: 'event', name: 'カレンダー', hint: 'iCal',
      fields: [
        { k: 'title', label: '予定名', type: 'text', ph: '例：新商品リリース / 展示会' },
        { k: 'start', label: '開始日時', type: 'datetime-local', ph: '' },
        { k: 'end', label: '終了日時', type: 'datetime-local', ph: '' },
        { k: 'location', label: '場所', type: 'text', ph: '例：東京ビッグサイト / オンライン' },
        { k: 'desc', label: '詳細・メモ', type: 'textarea', ph: '詳細や参加用リンクなど' }
      ],
      init: { title: '', start: '', end: '', location: '', desc: '' },
      build: f => {
        if (!f.title) return '';
        // datetime-local は "2026-09-07T12:34"（端末によっては秒付きで
        // "2026-09-07T12:34:56"）で届く。iCal の DATE-TIME は
        // YYYYMMDDTHHMMSS の15文字ちょうどなので、秒まで必ず埋める。
        // 区切りを削ってから長さで分岐すると、実際には来ない長さを見ることに
        // なるので、日付と時刻に分けてから桁で揃える。
        const fmtDt = val => {
          const parts = String(val || '').split('T');
          if (parts.length < 2) return '';
          const date = parts[0].replace(/[^0-9]/g, '');
          const time = parts[1].replace(/[^0-9]/g, '');
          if (date.length !== 8) return '';
          return date + 'T' + (time + '000000').slice(0, 6);
        };
        const start = fmtDt(f.start);
        const end = fmtDt(f.end);
        const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT'];
        // UID は規格上必須。ただし毎回ランダムにすると、色を変えただけで
        // QR の中身まで変わってしまう（payload() は再描画のたびに呼ばれる）。
        // 予定の中身から決まる値にして、同じ予定なら同じ QR になるようにする。
        L.push('UID:' + eventUid(f, start, end) + '@qr-atelier.tk.st');
        L.push('SUMMARY:' + vcardEscape(f.title));
        if (start) L.push('DTSTART:' + start);
        if (end) L.push('DTEND:' + end);
        if (f.location) L.push('LOCATION:' + vcardEscape(f.location));
        if (f.desc) L.push('DESCRIPTION:' + vcardEscape(f.desc));
        L.push('END:VEVENT', 'END:VCALENDAR');
        return L.join(CRLF);
      }
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
        { k: 'pass', label: 'パスワード', type: 'password', ph: '' },
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
      id: 'vcard', name: '連絡先',
      hint: f => (f && f.format === 'mecard' ? 'MeCard' : 'vCard'),
      fields: [
        {
          k: 'format', label: '形式', type: 'select',
          options: [['vcard', 'vCard（標準・項目が多い）'], ['mecard', 'MeCard（短い・日本の端末に強い）']],
          sub: 'MeCard は同じ内容でもデータ量が小さく、QRのマス目が粗くなるぶん読み取りやすくなります。会社・役職の欄を持たない規格なので、その2つはメモにまとめて入ります。'
        },
        { k: 'last', label: '姓', type: 'text', ph: '武田' },
        { k: 'first', label: '名', type: 'text', ph: '慎也' },
        { k: 'org', label: '会社・組織', type: 'text', ph: '' },
        { k: 'title', label: '役職', type: 'text', ph: '' },
        { k: 'tel', label: '電話', type: 'tel', ph: '' },
        { k: 'email', label: 'メール', type: 'email', ph: '' },
        { k: 'url', label: 'サイト', type: 'url', ph: '' },
        { k: 'note', label: 'メモ', type: 'text', ph: '' }
      ],
      init: { format: 'vcard', last: '', first: '', org: '', title: '', tel: '', email: '', url: '', note: '' },
      build: f => {
        if (!f.last && !f.first && !f.org) return '';

        // MeCard は ORG / TITLE を持たない。落として黙るのではなく、
        // 人が読める形でメモにまとめる。
        if (f.format === 'mecard') {
          const M = ['MECARD:'];
          M.push('N:' + mecardEscape(f.last) + ',' + mecardEscape(f.first) + ';');
          if (f.tel) M.push('TEL:' + mecardEscape(String(f.tel).replace(/[^0-9+]/g, '')) + ';');
          if (f.email) M.push('EMAIL:' + mecardEscape(f.email) + ';');
          if (f.url) M.push('URL:' + mecardEscape(normalizeUrl(f.url)) + ';');
          const note = [f.org, f.title, f.note].filter(Boolean).join(' ');
          if (note) M.push('NOTE:' + mecardEscape(note) + ';');
          return M.join('') + ';';
        }

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
    },
    {
      id: 'crypto', name: '暗号通貨',
      hint: f => (f && f.chain === 'lightning' ? 'lightning' : 'bitcoin'),
      fields: [
        {
          k: 'chain', label: '種類', type: 'select',
          options: [['bitcoin', 'Bitcoin（オンチェーン）'], ['lightning', 'Lightning（請求書 / LNURL）']]
        },
        { k: 'addr', label: 'アドレス / 請求書', type: 'textarea', ph: 'bc1q... / lnbc...' },
        { k: 'amount', label: '金額（BTC）', type: 'text', ph: '0.001', sub: 'Bitcoin のみ。空欄なら、受け取り側のウォレットで金額を入れてもらいます。' },
        { k: 'label', label: 'ラベル', type: 'text', ph: '例：ご支援ありがとうございます', sub: 'Bitcoin のみ。相手のウォレットの確認画面に出ます。' }
      ],
      init: { chain: 'bitcoin', addr: '', amount: '', label: '' },
      build: f => {
        const raw = String(f.addr || '').replace(/\s+/g, '');
        if (!raw) return '';

        if (f.chain === 'lightning') {
          // BOLT11 の請求書も LNURL も bech32（英数字だけ）。全部を大文字に
          // すると QR の英数字モードに乗り、同じ内容でもマス目が目に見えて
          // 粗くなる（＝読み取りやすくなる）。スキームは大文字小文字を
          // 区別しないので、URI ごと大文字にしてよい。
          const body = raw.replace(/^lightning:/i, '');
          return ('lightning:' + body).toUpperCase();
        }

        // BIP-21。bech32 は大文字小文字を区別しないが、旧来の base58 アドレスは
        // 区別する。取り違えると送金先が変わるので、ここは打たれたまま渡す。
        const addr = raw.replace(/^bitcoin:/i, '');
        const q = [];
        const amt = String(f.amount || '').trim();
        if (amt && isFinite(Number(amt)) && Number(amt) > 0) q.push('amount=' + Number(amt));
        if (f.label) q.push('label=' + encodeURIComponent(String(f.label).trim()));
        return 'bitcoin:' + addr + (q.length ? '?' + q.join('&') : '');
      }
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
    sizeUnit: 'px',       // 'px'（画面向け） | 'mm'（印刷向け）
    printMm: 40,          // 仕上がりの幅（mm）
    printDpi: 300,        // 印刷の解像度
    lossless: false,      // AVIF・WebP を可逆で焼くか
    quality: 95,          // 非可逆のときの品質（60〜100）
    effort: 2,            // 可逆のときの圧縮の強さ（1〜3）
    presetName: '',
    presetCategory: 'all',
    iconGroup: 'brand',
    frameIconGroup: 'brand',
    colorScope: 'cell',  // 最後に触った色パネル（＝着色対象）
    previewChecker: 'auto', // 'auto' | 'light' | 'dark'
    style: JSON.parse(JSON.stringify(window.QRStyle.DEFAULTS))
  };
  TYPES.forEach(t => { state.values[t.id] = Object.assign({}, t.init); });

  // 色設定パネルを立てる場所。どれも同じテンプレートから起こして、
  // 「どの塗りを指すか」だけが違う（paintOf を参照）。
  const COLOR_SCOPES = [
    'cell', 'bg',
    'frame', 'eye',
    'logoicon', 'logotext', 'logobd',
    'frameborder', 'framelabel', 'frametext', 'frameicon', 'framebd'
  ];

  // 白・黒・透明まで選べる「面を敷く」対象
  const PLATE_SCOPES = ['bg', 'logobd', 'framebd'];
  // ブランドカラー（アイコンそのものの色）を選べる対象
  const BRAND_SCOPES = ['logoicon', 'frameicon'];

  // 画像を外したときに戻る塗り方。追従先を持つ対象は「セルの色」に落とす
  const CLEARED_IMAGE_TYPE = {
    cell: 'solid', bg: 'white', logobd: 'white', framebd: 'none',
    logoicon: 'brand', frameicon: 'brand'
  };

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

  function getFrameIconPaint() { return state.style.frame.iconPaint; }

  // ラベルの中身の下地の塗り。ロゴの下地と同じ 9 モードを持つが、
  // 既定は「なし」なので、選ぶまでは今までどおり板は敷かれない。
  function getFrameBackdropPaint() {
    return state.style.frame.backdropPaint;
  }

  function paintOf(target) {
    if (target === 'frame') return state.style.markerFramePaint;
    if (target === 'eye') return state.style.markerEyePaint;
    if (target === 'bg') return state.style.bg;
    if (target === 'logoicon') return getLogoPaint();
    if (target === 'logotext') return getLogoTextPaint();
    if (target === 'frameicon') return getFrameIconPaint();
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
    return p.type === 'brand' ? 'ブランドカラー' :
      p.type === 'white' ? '白' :
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
  function getLogoBackdropPaint() { return state.style.logo.backdropPaint; }

  function getLogoPaint() { return state.style.logo.paint; }

  function getLogoTextPaint() { return state.style.logo.textPaint; }

  const STORE_KEY = 'qr-atelier-v1';

  // 受け付ける画像の上限。ファイルからでもURLからでも同じ線を引く。
  const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

  // これより長い画像（data URL）は覚えない。localStorage の枠を1枚で使い切る。
  const MAX_STORED_SRC = 300000;

  // 覚えるときに大きすぎる画像を落とす場所。[持ち主, キー名] で並べる。
  function storedImageSlots(s) {
    return [
      [s.logo, 'src'], [s.logo.paint, 'src'], [s.logo.textPaint, 'src'],
      [s.fg, 'src'], [s.bg, 'src'],
      [s.markerFramePaint, 'src'], [s.markerEyePaint, 'src'],
      [s.frame.paint, 'src'], [s.frame.textPaint, 'src'], [s.frame.backdropPaint, 'src'],
      [s.frame.iconPaint, 'src'],
      [s.frame, 'src'], [s.frame, 'topSrc']
    ];
  }

  // パスワード欄だけは、覚える設定にかかわらず保存しない。ここに入るのは
  // 自宅とはかぎらず、店や職場の Wi-Fi のこともある。消し忘れの影響が
  // 入力した本人だけで終わらないので、入れ直す手間のほうを取る。
  const SECRET_FIELDS = {};
  TYPES.forEach(t => {
    const keys = t.fields.filter(f => f.type === 'password').map(f => f.k);
    if (keys.length) SECRET_FIELDS[t.id] = keys;
  });

  // 端末に残す入力内容。パスワードだけは抜く。
  function valuesToStore() {
    const out = {};
    Object.keys(state.values).forEach(id => {
      const secret = SECRET_FIELDS[id];
      if (!secret) { out[id] = state.values[id]; return; }
      const copy = Object.assign({}, state.values[id]);
      secret.forEach(k => { copy[k] = ''; });
      out[id] = copy;
    });
    return out;
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
        // 入力内容はここで差し替える（パスワードを抜く／丸ごと落とす）
        if (k === 'values' && this === state) return valuesToStore();
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

  // 待っている書き込みを、書かずに捨てる（消したあとに書き戻させない）
  function cancelPendingSave() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
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
      ['ec', 'minVersion', 'exportSize', 'sizeUnit', 'printMm', 'printDpi',
       'quality', 'effort', 'presetName', 'presetCategory', 'iconGroup', 'frameIconGroup'].forEach(k => {
        if (saved[k] !== undefined) state[k] = saved[k];
      });
      if (['auto', 'light', 'dark'].indexOf(saved.previewChecker) >= 0) {
        state.previewChecker = saved.previewChecker;
      }
      if (window.QRCore.LEVELS.indexOf(state.ec) < 0) state.ec = 'H';
      // 知らない group が入ると、アイコンの一覧が丸ごと空になる
      ['iconGroup', 'frameIconGroup'].forEach(k => {
        if (!A.ICONS.some(i => i.group === state[k])) state[k] = 'brand';
      });
      state.minVersion = clampNum(state.minVersion, 1, 14, 1);
      if ([512, 1024, 2048, 4096].indexOf(state.exportSize) < 0) state.exportSize = 1024;
      if (state.sizeUnit !== 'mm') state.sizeUnit = 'px';
      state.printMm = Math.round(clampNum(state.printMm, PRINT_MM_MIN, PRINT_MM_MAX, 40));
      if (PRINT_DPI.indexOf(state.printDpi) < 0) state.printDpi = 300;
      state.lossless = saved.lossless === true;
      state.quality = Math.round(clampNum(state.quality, QUALITY_MIN, QUALITY_MAX, 95));
      state.effort = Math.round(clampNum(state.effort, 1, 3, 2));
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

  // ------------------------------------------------------------------
  // Undo / Redo 履歴管理
  // ------------------------------------------------------------------
  const undoStack = [];
  const redoStack = [];
  const MAX_HISTORY = 50;
  let isApplyingHistory = false;
  let historyTimer = null;
  let lastCommittedSnapshot = '';

  function getSnapshot() {
    return JSON.stringify({
      type: state.type,
      values: state.values,
      ec: state.ec,
      minVersion: state.minVersion,
      exportSize: state.exportSize,
      sizeUnit: state.sizeUnit,
      printMm: state.printMm,
      printDpi: state.printDpi,
      lossless: state.lossless,
      quality: state.quality,
      effort: state.effort,
      presetName: state.presetName,
      presetCategory: state.presetCategory,
      iconGroup: state.iconGroup,
      frameIconGroup: state.frameIconGroup,
      style: state.style
    });
  }

  function commitHistory() {
    if (isApplyingHistory) return;
    const snap = getSnapshot();
    if (snap === lastCommittedSnapshot) return;
    if (lastCommittedSnapshot) {
      undoStack.push(lastCommittedSnapshot);
      if (undoStack.length > MAX_HISTORY) undoStack.shift();
      redoStack.length = 0;
      updateHistoryButtons();
    }
    lastCommittedSnapshot = snap;
  }

  function recordHistorySoon(immediate) {
    if (isApplyingHistory) return;
    if (immediate) {
      if (historyTimer) { clearTimeout(historyTimer); historyTimer = null; }
      commitHistory();
      return;
    }
    if (historyTimer) clearTimeout(historyTimer);
    historyTimer = setTimeout(() => {
      historyTimer = null;
      commitHistory();
    }, 400);
  }

  function updateHistoryButtons() {
    const btnUndo = $('btn-undo');
    const btnRedo = $('btn-redo');
    if (btnUndo) {
      btnUndo.disabled = undoStack.length === 0;
    }
    if (btnRedo) {
      btnRedo.disabled = redoStack.length === 0;
    }
  }

  function applySnapshot(snapStr) {
    if (!snapStr) return;
    let data;
    try {
      data = JSON.parse(snapStr);
    } catch (e) {
      return;
    }

    isApplyingHistory = true;
    try {
      if (data.type) state.type = data.type;
      if (data.values) {
        Object.keys(data.values).forEach(k => {
          state.values[k] = Object.assign({}, data.values[k]);
        });
      }
      if (data.ec) state.ec = data.ec;
      if (data.minVersion !== undefined) state.minVersion = data.minVersion;
      if (data.exportSize) state.exportSize = data.exportSize;
      if (data.sizeUnit) state.sizeUnit = data.sizeUnit;
      if (data.printMm) state.printMm = data.printMm;
      if (data.printDpi) state.printDpi = data.printDpi;
      if (data.lossless !== undefined) state.lossless = !!data.lossless;
      if (data.quality) state.quality = data.quality;
      if (data.effort) state.effort = data.effort;
      if (data.presetName !== undefined) state.presetName = data.presetName;
      if (data.presetCategory !== undefined) state.presetCategory = data.presetCategory;
      if (data.iconGroup !== undefined) state.iconGroup = data.iconGroup;
      if (data.frameIconGroup !== undefined) state.frameIconGroup = data.frameIconGroup;
      if (data.style) {
        state.style = window.QRStyle.merge(window.QRStyle.DEFAULTS, data.style);
        sanitizeStyle(state.style);
      }

      lastCommittedSnapshot = getSnapshot();

      buildTypeChips();
      buildTypeFields();
      syncControls();
      buildShapeGrids();
      buildIconGrid();
      buildFrameIconGrid();
      buildFrameChips();
      syncPresetActive();
      update();
    } finally {
      isApplyingHistory = false;
    }
    updateHistoryButtons();
  }

  function undo() {
    if (historyTimer) {
      clearTimeout(historyTimer);
      historyTimer = null;
      commitHistory();
    }
    if (undoStack.length === 0) return;
    const prev = undoStack.pop();
    redoStack.push(getSnapshot());
    applySnapshot(prev);
  }

  function redo() {
    if (redoStack.length === 0) return;
    const next = redoStack.pop();
    undoStack.push(getSnapshot());
    applySnapshot(next);
  }

  function initHistory() {
    lastCommittedSnapshot = getSnapshot();
    updateHistoryButtons();
  }

  // 塗りのモードは、どこに使う塗りかで選べる顔ぶれが変わる。画面のボタンの
  // 並び（index.html の color-panel-tpl の color-mode-seg）と対で持つこと。
  //   basic … セル。自分が追従先なので「セルの色」は持てない
  //   auto  … マーカー・枠線・帯・ラベルの文字。既定は「セルの色に追従」
  //   brand … アイコン。ブランド公式色を選べる
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

    s.markerFramePaint = sanitizePaint(s.markerFramePaint, 'auto', 'auto', s.fg.color);
    s.markerEyePaint = sanitizePaint(s.markerEyePaint, 'auto', 'auto', s.fg.color);
    s.frame.paint = sanitizePaint(s.frame.paint, 'auto', 'auto', s.fg.color);
    s.frame.textPaint = sanitizePaint(s.frame.textPaint, 'auto', 'solid', '#FFFFFF');
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
    s.frame.iconPaint = sanitizePaint(s.frame.iconPaint, 'brand', 'brand', '#FFFFFF');
    s.frame.src = sanitizeImageUrl(s.frame.src);

    s.frame.topIcon = s.frame.topIcon || 'si-instagram';
    s.frame.topSrc = sanitizeImageUrl(s.frame.topSrc);
    s.frame.textTop = String(s.frame.textTop || '');

    // 消えた種類（点線・太線＋細線）は近いものへ寄せる
    s.frame.line = window.QRStyle.lineIdOf(s.frame.line);
    const lineDef = window.QRStyle.LINE_STYLES[s.frame.line];
    s.frame.lineWidth = clampNum(s.frame.lineWidth, 0.15, 2.5, lineDef.stroke);
    s.frame.lineWidth2 = clampNum(s.frame.lineWidth2, 0.15, 2.5, lineDef.inner || 0.28);

    // ラベルの中身の下地。形は下地用の一覧から選ぶ
    if (!s.frame.backdrop || !A.BACKDROP_SHAPES.some(f => f.id === s.frame.backdrop)) {
      s.frame.backdrop = D.frame.backdrop;
    }
    // 透過は sanitizePaint が埋める（下地は plate なので、未指定は 0＝不透明）
    s.frame.backdropPaint = sanitizePaint(s.frame.backdropPaint, 'plate', 'none', '#FFFFFF');

    s.bg = sanitizePaint(s.bg, 'plate', 'solid', '#FFFFFF');

    // ロゴの下地。形は下地用の一覧から選ぶ
    if (!s.logo.backdrop || !A.BACKDROP_SHAPES.some(f => f.id === s.logo.backdrop)) {
      s.logo.backdrop = D.logo.backdrop;
    }
    s.logo.backdropPaint = sanitizePaint(s.logo.backdropPaint, 'plate', 'solid', '#FFFFFF');

    // ロゴ本体の塗り。ここだけ 'brand'（アイコンのブランド公式色）を選べる。
    // 画面では、ブランド以外のアイコン群を選んでいるときに syncControls が
    // 'auto' へ寄せるので、ここでは 'brand' をそのまま通してよい。
    s.logo.paint = sanitizePaint(s.logo.paint, 'brand', 'brand', D.logo.paint.color);
    s.logo.textPaint = sanitizePaint(s.logo.textPaint, 'auto', 'auto', D.logo.textPaint.color);

    s.cellScale = clampNum(s.cellScale, 0.3, 1.15, D.cellScale);
    s.cellJitter = clampNum(s.cellJitter, 0, 1, D.cellJitter);
    s.margin = clampNum(s.margin, 0, 10, D.margin);
    // 角丸は余白より大きくできない（余白ゼロなら丸みもゼロ）。復元・テンプレート
    // 適用・シャッフル・undo のどこから来ても、ここで上限に収まっているようにする
    const radiusCap = maxRadiusOf(s.margin);
    s.radius = clampNum(s.radius, 0, radiusCap, Math.min(D.radius, radiusCap));
    s.logo.size = clampNum(s.logo.size, 0.06, 0.34, D.logo.size);
    s.logo.pad = clampNum(s.logo.pad, 0, 0.5, D.logo.pad);
    s.frame.radius = clampNum(s.frame.radius, 0, 10, D.frame.radius);
    s.frame.contentSize = clampNum(s.frame.contentSize, 0.5, 1.6, D.frame.contentSize);
    s.frame.contentPad = clampNum(s.frame.contentPad, 0, 0.6, D.frame.contentPad);
    s.frame.text = String(s.frame.text == null ? D.frame.text : s.frame.text);
    s.logo.text = String(s.logo.text == null ? '' : s.logo.text);
    if (!s.logo.font || FONTS.indexOf(s.logo.font) < 0) s.logo.font = 'sans';
    s.logo.src = sanitizeImageUrl(s.logo.src);
    // ロゴの下のセルを抜くか。画面には出していないが、テンプレートや古い保存が
    // 落としてくることがあるので、真偽値には均しておく
    s.logo.knockout = s.logo.knockout !== false;
    s.invertOk = !!s.invertOk;
    if (!A.CELL_SHAPES.some(c => c.id === s.cell)) s.cell = D.cell;
  }

  // 画像はファイルから読んだものだけなので、持っている src は必ず data URL。
  // ここを http(s) にも開けておくと、デザインのファイルやリンクに仕込まれた
  // アドレスを画面の SVG がそのまま取りに行ってしまう。data: だけに絞る。
  function sanitizeImageUrl(v) {
    if (!v || typeof v !== 'string') return '';
    const s = v.trim();
    return /^data:image\//i.test(s) ? s : '';
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

  // 選択状態は .active の見た目だけでは伝わらない。形やテンプレートの
  // ボタンは数十個あって、どれが選ばれているのかが読み上げ環境からは
  // まったく見えなかった。見た目と aria-pressed は必ず一緒に動かす。
  function setActive(node, on) {
    if (!node) return;
    node.classList.toggle('active', !!on);
    if (node.tagName === 'BUTTON') node.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  // テンプレートから起こした色パネルなど、HTML に直接書かれた .active も
  // 同じ扱いに揃える。以後は setActive が面倒を見る。
  function seedAriaPressed(root) {
    const sel = '.st-seg button, .chip, .shape-btn, .preset-btn, .icon-btn[data-id], .canvas-checker-toggle button';
    Array.prototype.forEach.call((root || document).querySelectorAll(sel), b => {
      if (b.tagName === 'BUTTON' && !b.hasAttribute('aria-pressed')) {
        b.setAttribute('aria-pressed', b.classList.contains('active') ? 'true' : 'false');
      }
    });
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

  // セルの明るさ（0〜255）。複数色の塗りは平均で見る。
  // 明るさの式は qr-style.js の encodedLuma ひとつに寄せる。ここだけ別の
  // 係数で測っていると、同じ色を「明るい」と言ったり言わなかったりする。
  function getCellLuminance() {
    const fg = state.style && state.style.fg;
    if (!fg) return 0;
    const luma = window.QRStyle.encodedLuma;
    if (fg.type === 'solid') return luma(fg.color);
    let cols = null;
    if (fg.type === 'linear' || fg.type === 'radial') {
      cols = fg.mid ? [fg.from, fg.mid, fg.to] : [fg.from, fg.to];
    } else if (fg.type === 'multi') {
      cols = Array.isArray(fg.colors) && fg.colors.length ? fg.colors : ['#2563EB', '#7C3AED', '#DB2777'];
    }
    if (!cols) return 0;   // 画像などは絵柄しだいなので暗いほうに倒しておく
    let sum = 0, count = 0;
    cols.forEach(c => {
      if (hexToRgb(c)) { sum += luma(c); count++; }
    });
    return count ? sum / count : 0;
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
        setActive(btn, btn.dataset.checker === state.previewChecker);
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
      const b = el('button', { class: 'chip', type: 'button' }, t.name);
      setActive(b, t.id === state.type);
      b.addEventListener('click', () => {
        state.type = t.id;
        buildTypeChips();
        buildTypeFields();
        update();
      });
      host.appendChild(b);
    });
  }

  // 見出しの脇に出す要約。形式を選べる種別（連絡先・暗号通貨）は、選んだ
  // ものによって変わるので関数でも書けるようにしてある。
  function syncContentHint() {
    const type = TYPES.find(t => t.id === state.type);
    if (!type) return;
    const h = typeof type.hint === 'function' ? type.hint(state.values[type.id]) : type.hint;
    $('hint-content').textContent = h;
  }

  function buildTypeFields() {
    const type = TYPES.find(t => t.id === state.type);
    const host = $('type-fields');
    host.innerHTML = '';
    syncContentHint();

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
      } else if (f.type === 'password') {
        const pwrap = el('div', { class: 'pwd-wrap' });
        input = el('input', { type: 'password', id: id, placeholder: f.ph || '' });
        input.value = values[f.k] || '';
        const toggleBtn = el('button', { type: 'button', class: 'btn-pwd-toggle', title: 'パスワードの表示/非表示を切り替え', 'aria-label': 'パスワードの表示・非表示' });
        toggleBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
        toggleBtn.addEventListener('click', () => {
          const isPwd = input.type === 'password';
          input.type = isPwd ? 'text' : 'password';
          toggleBtn.innerHTML = isPwd
            ? '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>'
            : '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
        });
        pwrap.appendChild(input);
        pwrap.appendChild(toggleBtn);
        wrap.appendChild(pwrap);
      } else {
        input = el('input', { type: f.type, id: id, placeholder: f.ph || '' });
        input.value = values[f.k] || '';
        if (f.type === 'datetime-local') {
          input.addEventListener('click', () => {
            if (typeof input.showPicker === 'function') {
              try { input.showPicker(); } catch (e) {}
            }
          });
        }
      }

      const commit = opts => {
        values[f.k] = f.type === 'checkbox' ? input.checked : input.value;
        syncContentHint();
        update(opts);
      };
      // 打っているあいだは検査を待たせる。1文字ごとに走らせても、出るのは
      // 打ちかけの文字列に対する判定でしかない
      input.addEventListener('input', () => commit({ debounceVerify: true }));
      input.addEventListener('change', () => commit());

      if (f.type !== 'checkbox' && f.type !== 'password') wrap.appendChild(input);
      if (f.sub) wrap.appendChild(el('span', { class: 'sub' }, f.sub));
      pairs.push(wrap);
    });

    if (type.id === 'sns') {
      const btnLogoSync = el('button', {
        type: 'button',
        class: 'st-btn-quiet btn-sm',
        style: 'align-self: flex-start; margin-top: 4px;'
      }, '中央ロゴもこのSNSアイコンにする');
      btnLogoSync.addEventListener('click', () => {
        const platform = values.platform;
        const iconIdMap = {
          instagram: 'si-instagram',
          x: 'si-x',
          line: 'si-line',
          tiktok: 'si-tiktok',
          youtube: 'si-youtube',
          threads: 'si-threads',
          bluesky: 'si-bluesky',
          github: 'si-github',
          note: 'si-note',
          facebook: 'si-facebook'
        };
        const iconId = iconIdMap[platform];
        if (iconId) {
          state.style.logo.type = 'icon';
          state.style.logo.icon = iconId;
          state.style.logo.iconData = A.ICONS.find(i => i.id === iconId) || null;
          state.presetName = '';
          syncControls();
          update();
          showToast('中央ロゴに ' + platform + ' を設定しました');
        }
      });
      pairs.push(btnLogoSync);
    }

    // 連絡先やカレンダーは項目が多いので2列に畳む
    if (type.id === 'vcard' || type.id === 'geo' || type.id === 'event') {
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
    // 自分で足したものも、はじめから入っているものも同じ「テンプレート」。
    // 棚を分けず、絞り込みひとつで見せ分ける。
    { id: 'mine', name: 'マイ' },
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
        class: 'chip',
        type: 'button'
      }, cat.name);
      setActive(b, state.presetCategory === cat.id);
      b.addEventListener('click', () => {
        state.presetCategory = cat.id;
        closeSaveRow();
        buildPresetCategoryChips();
        buildPresets();
      });
      host.appendChild(b);
    });
  }

  // 並びには自分のぶんとはじめからのぶんが混ざるので、位置ではなく名前で合わせる
  function syncPresetActive() {
    const host = $('preset-grid');
    if (host) {
      Array.prototype.forEach.call(host.querySelectorAll('.preset-btn[data-preset-name]'), btn => {
        setActive(btn, btn.dataset.presetName === state.presetName);
      });
    }
    const hint = $('hint-preset');
    if (hint) hint.textContent = state.presetName || 'カスタム';
  }

  function presetThumb(style) {
    if (!previewQR) previewQR = window.QRCore.encode('https://tk.st/', { ec: 'M' });
    const thumbStyle = window.QRStyle.merge(window.QRStyle.DEFAULTS, style);
    // テンプレートが余白を指定していないときだけ、見本用に少し詰める
    if (style.margin === undefined) thumbStyle.margin = 3;
    const thumb = el('div', { class: 'preset-thumb' });
    try {
      thumb.innerHTML = window.QRStyle.render(previewQR, thumbStyle).svg;
    } catch (e) { /* 壊れた保存でも並びからは消さない */ }
    return thumb;
  }

  // はじめから入っているテンプレート
  function presetTile(p) {
    const btn = el('button', { class: 'preset-btn', type: 'button', title: p.name });
    btn.dataset.presetName = p.name;
    setActive(btn, state.presetName === p.name);
    btn.appendChild(presetThumb(p.style));
    btn.appendChild(el('i', null, p.name));

    btn.addEventListener('click', () => {
      const userLogoSrc = (state.style.logo && state.style.logo.type === 'image') ? state.style.logo.src : '';
      const userLogoText = (state.style.logo && state.style.logo.type === 'text') ? state.style.logo.text : '';

      // DEFAULTS をベースにしてテンプレートのスタイルをディープマージ。
      // merge は入れ物を必ず写して返すので、DEFAULTS もテンプレートの定義も
      // 返り値経由では書き換わらない（写しを作ってから渡す必要はない）
      state.style = window.QRStyle.merge(window.QRStyle.DEFAULTS, p.style);

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

      // 範囲外の値や古い形のキーを均す。まるごと差し替える経路は
      // 復元・undo と同じように、ここを必ず通す
      sanitizeStyle(state.style);

      // セルの密度は style ではなく state 側。テンプレートは基本「自動」に戻す
      state.minVersion = p.minVersion || 1;

      state.presetName = p.name;
      syncControls();
      buildFrameChips();
      syncPresetActive();
      update();
    });
    return btn;
  }

  // 自分で足したテンプレート。消せるように×を重ねる
  function myTile(d) {
    const tile = el('div', { class: 'my-tile' });
    const btn = el('button', { class: 'preset-btn', type: 'button', title: d.name });
    btn.dataset.presetName = d.name;
    setActive(btn, state.presetName === d.name);
    btn.appendChild(presetThumb(d.style));
    btn.appendChild(el('i', null, d.name));
    btn.addEventListener('click', () => {
      applyStyle(d.style, d.name);
      showToast(d.name + ' を読み込みました');
    });

    const del = el('button', {
      class: 'my-del', type: 'button',
      'aria-label': d.name + ' を削除', title: '削除'
    }, '×');
    del.addEventListener('click', () => {
      if (!storeMyDesigns(loadMyDesigns().filter(x => x.id !== d.id))) return;
      buildPresets();
      showToast(d.name + ' を消しました');
    });

    tile.appendChild(btn);
    tile.appendChild(del);
    return tile;
  }

  // 「いまの見た目を追加」。押すものだが、並びの中にあるほうが見つけやすい
  function addTile() {
    const btn = el('button', {
      class: 'preset-btn add-tile', type: 'button',
      title: 'いま画面に出ている見た目を、マイテンプレートに足します'
    });
    btn.appendChild(el('div', { class: 'preset-thumb' }, '＋'));
    btn.appendChild(el('i', null, '見た目を追加'));
    btn.addEventListener('click', openSaveRow);
    return btn;
  }

  function buildPresets() {
    const host = $('preset-grid');
    if (!host) return;
    host.innerHTML = '';

    const cat = state.presetCategory;
    const isMine = cat === 'mine';
    // 自分のぶんは「マイ」と「すべて」に出す。足す口も、出ているところには必ず添える
    const showMine = isMine || cat === 'all';
    const mine = showMine ? loadMyDesigns() : [];

    if (showMine) host.appendChild(addTile());
    mine.forEach(d => host.appendChild(myTile(d)));

    if (!isMine) {
      A.PRESETS
        .filter(p => cat === 'all' || p.category === cat)
        .forEach(p => host.appendChild(presetTile(p)));
    }

    // 持ち出しの口と説明は「マイ」を見ているときだけ
    const foot = $('my-foot');
    if (foot) foot.classList.toggle('hidden', !isMine);
    const empty = $('my-design-empty');
    if (empty) empty.classList.toggle('hidden', !isMine || mine.length > 0);

    const hint = $('hint-preset');
    if (hint) hint.textContent = state.presetName || 'カスタム';
  }

  // このツールがこの端末に残しているものを、まとめて消す。
  //
  // 以前は「入力内容を残すか」のチェックで先に止める作りだったが、
  // マイテンプレートの保存と見分けがつかなかった。残すのは既定にして、
  // 消したい人がいつでも消せるほうへ倒す。消す対象は3つとも
  // （作りかけの内容・いまのデザイン・マイテンプレート）で、
  // 一部だけ残ると「消したのに残っている」がまた起きる。
  async function forgetDevice() {
    const mine = loadMyDesigns().length;
    const ok = await askConfirm({
      title: 'この端末から消しますか？',
      body: '入力した内容と、いま作りかけのデザイン' +
        (mine ? '、マイテンプレート' + mine + '件' : '') +
        'を消します。画面は初期状態に戻ります。元には戻せません。',
      ok: '消す',
      cancel: 'やめる'
    });
    if (!ok) return;

    try {
      localStorage.removeItem(STORE_KEY);
      localStorage.removeItem(MY_KEY);
    } catch (e) { /* サイトデータが使えない環境。画面だけ戻す */ }

    // 画面に出ているものも初期状態へ戻す。ここを残すと、次に何か触った
    // 拍子に同じ内容がそのまま書き戻されてしまう。
    TYPES.forEach(t => { state.values[t.id] = Object.assign({}, t.init); });
    state.type = 'url';
    state.style = JSON.parse(JSON.stringify(window.QRStyle.DEFAULTS));
    state.minVersion = 1;
    state.presetName = '';
    state.presetCategory = 'all';
    state.ec = 'H';

    closeSaveRow();
    buildTypeChips();
    buildTypeFields();
    syncControls();
    buildShapeGrids();
    buildIconGrid();
    buildFrameIconGrid();
    buildFrameChips();
    buildPresetCategoryChips();
    buildPresets();
    update();

    // update() が予約した書き戻しを取り消して、痕跡を残さない
    cancelPendingSave();
    try {
      localStorage.removeItem(STORE_KEY);
      localStorage.removeItem(MY_KEY);
    } catch (e) { /* 同上 */ }

    showToast('この端末に残していたものを消しました');
  }

  // 名前を付ける行。並びの中の「＋」からも、保存し直しからも開く
  function openSaveRow() {
    const row = $('my-save-row');
    const name = $('my-save-name');
    if (!row || !name) return;
    row.classList.remove('hidden');
    name.value = state.presetName || '';
    name.focus();
    name.select();
  }

  function closeSaveRow() {
    const row = $('my-save-row');
    if (row) row.classList.add('hidden');
  }

  function syncShapeGridActive(hostId, currentId) {
    const host = $(hostId);
    if (!host) return;
    Array.prototype.forEach.call(host.children, btn => {
      setActive(btn, btn.dataset.id === currentId);
    });
  }

  // 「セル枠」はセルの形と太さをそのまま使うので、見本もそれを渡して起こす
  function markerPreviewOpts() {
    return { cell: state.style.cell, cellScale: state.style.cellScale };
  }

  function updateFrameGridPreviews() {
    const host = $('frame-grid');
    if (!host) return;
    const opts = markerPreviewOpts();
    Array.prototype.forEach.call(host.children, btn => {
      const id = btn.dataset.id;
      const holder = btn.querySelector('.preview-holder');
      if (holder && id) {
        holder.innerHTML = window.QRStyle.markerPreview(id, state.style.markerEye, opts);
      }
    });
  }

  function syncShapeActive() {
    updateFrameGridPreviews();
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
        const b = el('button', { class: 'shape-btn', type: 'button', title: s.name });
        setActive(b, state.style.cell === s.id);
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
        const b = el('button', { class: 'shape-btn', type: 'button', title: s.name });
        setActive(b, state.style.markerFrame === s.id);
        b.dataset.id = s.id;
        const holder = el('div', { class: 'preview-holder' });
        holder.innerHTML = window.QRStyle.markerPreview(s.id, state.style.markerEye, markerPreviewOpts());
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
      A.BACKDROP_SHAPES.forEach(f => {
        const b = el('button', { class: 'shape-btn', type: 'button', title: f.name });
        setActive(b, current === f.id);
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
        const b = el('button', { class: 'shape-btn', type: 'button', title: f.name });
        setActive(b, !!(state.style.frame && state.style.frame.line === f.id));
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
        const b = el('button', { class: 'shape-btn', type: 'button', title: s.name });
        setActive(b, state.style.markerEye === s.id);
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
      // 見本だけでなくカラーコードを押しても色を選べるように、<label> で包む。
      // ラベルはクリックを中の input へ渡すので、こちらで転送を書く必要はない。
      const hit = el('label', { class: 'mc-hit' });
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

      // つまみを動かしているあいだは検査を待たせる。ここを素の update() に
      // すると、ドラッグ1コマごとにデコーダが起動して画面が固まる
      picker.addEventListener('input', () => {
        const hex = picker.value.toUpperCase();
        hexSpan.textContent = hex;
        colors[idx] = hex;
        state.presetName = '';
        update({ debounceVerify: true });
      });
      picker.addEventListener('change', verifyOnCommit);
      removeBtn.addEventListener('click', () => {
        if (colors.length <= 2) return;
        colors.splice(idx, 1);
        state.presetName = '';
        syncControls();
        update();
      });

      hit.appendChild(picker);
      hit.appendChild(hexSpan);
      item.appendChild(hit);
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
      const hit = el('label', { class: 'mc-hit' });
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
        update({ debounceVerify: true });
      });
      picker.addEventListener('change', verifyOnCommit);
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

      hit.appendChild(picker);
      hit.appendChild(roleSpan);
      hit.appendChild(hexSpan);
      elItem.appendChild(hit);
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

  // 見本の一覧（色・グラデーション・多色パレット）はパネル1枚で百個近いボタンに
  // なる。パネルは十枚以上あるので、その塗り方を実際に開いたときに一度だけ組む。
  const builtPanelParts = new Set();
  function ensurePanelPart(scope, part) {
    const key = scope + ':' + part;
    if (builtPanelParts.has(key)) return;
    builtPanelParts.add(key);
    if (part === 'swatch') buildSwatches(scope);
    else if (part === 'grad') buildGradients(scope);
    else if (part === 'multi') buildMultiPalettes(scope);
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
        class: 'icon-btn',
        type: 'button',
        title: icon.name,
        'aria-label': icon.name
      });
      b.dataset.id = icon.id;
      setActive(b, currentId === icon.id);
      b.appendChild(renderIconSvg(icon, uidPrefix));
      b.addEventListener('click', () => {
        onPick(icon);
        Array.prototype.forEach.call(host.children, child => {
          setActive(child, child.dataset.id === icon.id);
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
    });
  }

  function buildFrameIconGrid() {
    const currentIcon = (state.style.frame && (state.style.frame.icon || state.style.frame.topIcon)) || 'si-instagram';
    renderIconGrid($('frame-icon-grid'), state.frameIconGroup || 'brand', currentIcon, 'frame_icon_grid_', icon => {
      state.style.frame.icon = icon.id;
      state.style.frame.iconData = icon;
      state.style.frame.topIcon = icon.id;
      state.style.frame.topIconData = icon;
      state.style.frame.contentMode = 'icon';
      state.style.frame.topContentMode = 'icon';
    });
  }

  function buildFrameChips() {
    const host = $('frame-chips');
    host.innerHTML = '';
    A.FRAMES.forEach(f => {
      const b = el('button', { class: 'chip', type: 'button' }, f.name);
      setActive(b, state.style.frame.type === f.id);
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
  // マイテンプレート
  // ------------------------------------------------------------------
  // 端末に残るのは「いま開いているもの」ひとつだけなので、名前を付けて
  // 取っておく棚と、別の端末や他人へ渡す口をここで用意する。
  // 渡すのはデザインだけで、内容（URL・Wi-Fiのパスワード・連絡先）は
  // 一切入れない。ここが漏れると、保存先を端末内に閉じている意味がなくなる。
  const MY_KEY = 'qr-atelier-mydesigns-v1';
  const MY_MAX = 24;
  const DESIGN_KIND = 'qr-atelier-design';

  function loadMyDesigns() {
    try {
      const raw = localStorage.getItem(MY_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list.filter(d => d && d.style && d.name) : [];
    } catch (e) { return []; }
  }

  function storeMyDesigns(list) {
    try {
      localStorage.setItem(MY_KEY, JSON.stringify(list));
      return true;
    } catch (e) {
      // 容量オーバーはほぼ画像の埋め込みが原因。黙って消えるのが一番困る
      showToast('保存できませんでした。埋め込んだ画像が大きすぎるようです', 'error');
      return false;
    }
  }

  // 覚えるには重すぎる画像を落とす。本体の保存と同じ線を引く。
  function trimStoredImages(st) {
    let dropped = false;
    storedImageSlots(st).forEach(slot => {
      const owner = slot[0], key = slot[1];
      if (owner && typeof owner[key] === 'string' && owner[key].length > MAX_STORED_SRC) {
        owner[key] = '';
        dropped = true;
      }
    });
    return dropped;
  }

  // 画像をすべて外す（リンクに載せるとき用）。落としたあとは、その画像が
  // 無いと描けない塗りの種類も戻しておかないと、空の絵になる。
  function stripImages(st) {
    let dropped = false;
    const drop = (owner, fallback) => {
      if (!owner) return;
      if (owner.src) { owner.src = ''; dropped = true; }
      if (owner.type === 'image') { owner.type = fallback; dropped = true; }
    };
    drop(st.fg, 'solid');
    drop(st.bg, 'white');
    drop(st.markerFramePaint, 'auto');
    drop(st.markerEyePaint, 'auto');
    drop(st.logo.paint, 'brand');
    drop(st.logo.textPaint, 'auto');
    drop(st.logo.backdropPaint, 'white');
    drop(st.frame.paint, 'auto');
    drop(st.frame.textPaint, 'solid');
    drop(st.frame.backdropPaint, 'none');
    drop(st.frame.iconPaint, 'brand');
    if (st.logo.src) { st.logo.src = ''; dropped = true; }
    if (st.logo.type === 'image') { st.logo.type = 'none'; dropped = true; }
    if (st.frame.src) { st.frame.src = ''; dropped = true; }
    if (st.frame.topSrc) { st.frame.topSrc = ''; dropped = true; }
    if (st.frame.contentMode === 'image') { st.frame.contentMode = 'text'; dropped = true; }
    if (st.frame.topContentMode === 'image') { st.frame.topContentMode = 'text'; dropped = true; }
    return dropped;
  }

  // 取っておく形・渡す形。アイコンの実体（iconData）は QRAssets から
  // 引き直せるので入れない。本体の保存が replacer で落としているのと同じ扱い。
  function styleForExport() {
    const st = JSON.parse(JSON.stringify(state.style));
    delete st.logo.iconData;
    delete st.frame.iconData;
    delete st.frame.topIconData;
    return st;
  }

  // 読み込んだデザインを画面に載せる。アイコンの実体は id から引き直す。
  function applyStyle(styleIn, name) {
    state.style = window.QRStyle.merge(window.QRStyle.DEFAULTS, styleIn || {});
    const lg = state.style.logo, fr = state.style.frame;
    if (lg.icon) lg.iconData = A.ICONS.find(i => i.id === lg.icon) || null;
    if (fr.icon) fr.iconData = A.ICONS.find(i => i.id === fr.icon) || null;
    if (fr.topIcon) fr.topIconData = A.ICONS.find(i => i.id === fr.topIcon) || null;
    sanitizeStyle(state.style);
    state.presetName = name || '';
    syncControls();
    buildShapeGrids();
    buildIconGrid();
    buildFrameIconGrid();
    buildFrameChips();
    buildPresets();
    update({ immediateHistory: true });
  }

  function saveMyDesign(name) {
    const clean = String(name || '').trim().slice(0, 24);
    if (!clean) { showToast('名前を入れてください', 'error'); return false; }

    const style = styleForExport();
    const dropped = trimStoredImages(style);

    // 同じ名前で保存し直したら上書き。似た名前が積み上がるほうが困る。
    const list = loadMyDesigns().filter(d => d.name !== clean);
    list.unshift({ id: 'd' + Date.now().toString(36), name: clean, style: style, at: Date.now() });
    if (!storeMyDesigns(list.slice(0, MY_MAX))) return false;

    state.presetName = clean;
    // 足したものがその場で見えないと、効いたのかどうか分からない
    state.presetCategory = 'mine';
    buildPresetCategoryChips();
    buildPresets();
    showToast(dropped
      ? clean + ' をマイテンプレートに追加しました（大きすぎる画像は含めていません）'
      : clean + ' をマイテンプレートに追加しました');
    return true;
  }

  // ---- 渡す ----------------------------------------------------------
  // 載せるのはデザインだけ。フラグメント（#）はサーバーへ送られないので、
  // 渡したリンクを踏んでも、どこにも中身の記録は残らない。
  function b64urlEncode(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/=+$/, '').replace(/[+]/g, '-').replace(/[/]/g, '_');
  }

  function b64urlDecode(str) {
    const norm = String(str).replace(/-/g, '+').replace(/_/g, '/');
    const pad = '==='.slice((norm.length + 3) % 4);
    const bin = atob(norm + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // 先頭の1文字で中身の詰め方を書いておく。z は deflate、j は生。
  // 圧縮できない環境でも読める側に倒しておく。
  async function packDesign(obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    if (typeof CompressionStream === 'function') {
      try {
        const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
        const buf = await new Response(stream).arrayBuffer();
        return 'z' + b64urlEncode(new Uint8Array(buf));
      } catch (e) { /* 圧縮できない環境ではそのまま載せる */ }
    }
    return 'j' + b64urlEncode(bytes);
  }

  async function unpackDesign(token) {
    const tag = token.charAt(0);
    const body = b64urlDecode(token.slice(1));
    if (tag === 'z') {
      if (typeof DecompressionStream !== 'function') throw new Error('no inflate');
      const stream = new Blob([body]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      const buf = await new Response(stream).arrayBuffer();
      return JSON.parse(new TextDecoder().decode(buf));
    }
    if (tag !== 'j') throw new Error('unknown tag');
    return JSON.parse(new TextDecoder().decode(body));
  }

  async function shareDesign() {
    const style = styleForExport();
    const dropped = stripImages(style);

    let token;
    try {
      token = await packDesign({
        kind: DESIGN_KIND, version: 1, name: state.presetName || '', style: style
      });
    } catch (e) {
      showToast('リンクを作れませんでした', 'error');
      return;
    }

    const url = location.origin + location.pathname + '#d=' + token;
    const note = dropped ? '（埋め込んだ画像は含まれません）' : '';

    // 触る端末では OS の共有シートに渡す（LINE でも Slack でも、その人が
    // ふだん使うところへ届く）。デスクトップにも navigator.share はあるが、
    // そこはリンクが手元に残るコピーのほうが素直なので分ける。
    // 判断の基準は data/tools-share.js と揃えてある。
    const canWebShare = typeof navigator.share === 'function' && navigator.maxTouchPoints > 0;
    if (canWebShare) {
      try {
        await navigator.share({ title: 'QR Atelier のデザイン', url: url });
        return;
      } catch (e) {
        // 取り消しは失敗ではないので、何も言わずに引き下がる
        if (e && e.name === 'AbortError') return;
        // 共有シートが開けなかったときは、下のコピーへ落ちる
      }
    }

    try {
      await navigator.clipboard.writeText(url);
    } catch (e) {
      showToast('リンクを渡せませんでした', 'error');
      return;
    }
    const btn = $('btn-design-share');
    const label = btn && btn.querySelector('span');
    if (label) flashButtonSuccess(label, 'コピーしました');
    showToast('デザインのリンクをコピーしました' + note);
  }

  // 開いたときに #d= が付いていたら、そのデザインで始める。
  // 読み終えたら住所からは消す（読み込み直しのたびに上書きされないように）。
  async function consumeDesignLink() {
    const hash = location.hash || '';
    if (hash.slice(0, 3) !== '#d=') return;
    try {
      const doc = await unpackDesign(hash.slice(3));
      if (!doc || doc.kind !== DESIGN_KIND || !doc.style) throw new Error('bad');
      applyStyle(doc.style, doc.name || '');
      showToast('共有されたデザインを読み込みました');
    } catch (e) {
      showToast('リンクのデザインを読み込めませんでした', 'error');
    }
    try {
      history.replaceState(null, '', location.pathname + location.search);
    } catch (e) { /* file:// では書き換えられない */ }
  }

  // ------------------------------------------------------------------
  // 画面と状態の同期
  // ------------------------------------------------------------------
  const asEl = x => (typeof x === 'string' ? $(x) : x);

  function setSeg(hostId, value, attr) {
    const host = asEl(hostId);
    if (!host) return;
    Array.prototype.forEach.call(host.children, b => {
      setActive(b, b.dataset[attr] === value);
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
    const isPlate = PLATE_SCOPES.indexOf(target) >= 0;
    // ブランドカラーはアイコンにしか意味がない。さらに、汎用アイコンには
    // ブランド色そのものが無いので、「SNS・ブランド」の一覧を開いている
    // ときだけ出す。ロゴとラベルで別々の一覧を持っているので、対象ごとに見る。
    const iconGroupOf = { logoicon: state.iconGroup, frameicon: state.frameIconGroup };
    const showBrand = BRAND_SCOPES.indexOf(target) >= 0 &&
      (iconGroupOf[target] || 'brand') === 'brand';

    [['btn-mode-white', !isPlate], ['btn-mode-black', !isPlate],
     ['btn-mode-none', !isPlate], ['btn-mode-brand', !showBrand],
     ['btn-mode-auto', isCell]].forEach(pair => {
      const b = cq(scope, pair[0]);
      if (!b) return;
      b.classList.toggle('hidden', pair[1]);
      b.hidden = pair[1];
    });

    // 出せない指定が残っていたら、いちばん近い意味に寄せる
    if (p.type === 'brand' && !showBrand) p.type = 'auto';
    if (p.type === 'auto' && isCell) p.type = 'solid';
    if (!isPlate && (p.type === 'white' || p.type === 'black' || p.type === 'none')) {
      p.type = p.type === 'none' ? 'auto' : 'solid';
    }

    const isWhite = p.type === 'white';
    const isBlack = p.type === 'black';
    const isAuto = p.type === 'auto';
    const isNone = p.type === 'none';
    const isBrand = p.type === 'brand';
    const isSolid = p.type === 'solid';
    const isGrad = p.type === 'linear' || p.type === 'radial';
    const isMulti = p.type === 'multi';
    const isImage = p.type === 'image';

    setSeg(cq(scope, 'color-mode-seg'), p.type, 'mode');

    [['pane-white', isWhite], ['pane-black', isBlack], ['pane-auto', isAuto],
     ['pane-none', isNone], ['pane-brand', isBrand], ['pane-solid', isSolid],
     ['pane-grad', isGrad], ['pane-multi', isMulti], ['pane-image', isImage]].forEach(pair => {
      const pane = cq(scope, pair[0]);
      if (pane) pane.classList.toggle('hidden', !pair[1]);
    });

    // 一覧の中身は重いので、その塗り方を選んだときに一度だけ組み立てる
    if (isGrad) ensurePanelPart(scope, 'grad');
    if (isMulti) ensurePanelPart(scope, 'multi');

    const plateWord = isLogoBd ? 'ロゴの下地' : isFrameBd ? 'ラベルの下地' : '背景';
    const autoNotice = cq(scope, 'auto-notice');
    if (autoNotice) {
      autoNotice.innerHTML = isBg
        ? 'セルの色設定と連動します。<br>グラデーション・放射・画像・多色のテクスチャが指定の透明度で背景に反映されます。'
        : (target === 'frame' || target === 'eye')
          ? 'セルの色設定と連動します。<br>多色のときは、3つのマーカーに色が1つずつ振られます。'
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
    const hideSwatch = isImage || isAuto || isNone || isWhite || isBlack || isBrand;
    if (!hideSwatch) ensurePanelPart(scope, 'swatch');
    if (swatchHost) swatchHost.classList.toggle('hidden', hideSwatch);

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

  // ラベルの位置。qr-style.js が受ける3通りをそのまま返す（画面の並びと対）。
  // frame を渡せば、いま画面に出ていない style（一括生成の作業用など）も測れる。
  function framePosOf(frame) {
    const p = (frame || state.style.frame || {}).pos;
    return (p === 'top' || p === 'both') ? p : 'bottom';
  }

  // ラベルの文字は上下で入れ物が違う（text / textTop）。qr-style.js が
  // その位置で実際に描くほうのキーを返す。「上下」のときは下を指し、
  // 上の文字は専用の欄（frame-text-top）が受け持つ。
  function frameTextKey() {
    return framePosOf() === 'top' ? 'textTop' : 'text';
  }

  // 角丸の上限。係数は qr-style.js が持っているので、そこから引いて
  // スライダーの刻み（0.5）と最大値（10）に丸めるだけにする
  function maxRadiusOf(margin) {
    const cap = window.QRStyle.maxRadius(clampNum(margin, 0, 10, 4));
    return Math.min(10, Math.round(cap * 2) / 2);
  }

  function syncControls() {
    const s = state.style;

    syncShapeActive();

    $('opt-ec').value = state.ec;
    $('opt-size').value = String(state.exportSize);
    syncSizeUnit();
    syncCompress();

    COLOR_SCOPES.forEach(syncColorPanel);

    // 見出しの脇に出す要約
    $('hint-shape-color').textContent = paintLabel(state.style.fg);
    $('hint-bg').textContent = paintLabel(state.style.bg);
    const markerHint = $('hint-marker');
    if (markerHint) {
      const fName = (A.MARKER_FRAMES.find(f => f.id === s.markerFrame) || {}).name || '';
      const eName = (A.MARKER_EYES.find(e => e.id === s.markerEye) || {}).name || '';
      markerHint.textContent = fName === eName ? fName : fName + '／' + eName;
    }
    const markerColHint = $('hint-marker-color');
    if (markerColHint) {
      const fLbl = paintLabel(s.markerFramePaint);
      const eLbl = paintLabel(s.markerEyePaint);
      markerColHint.textContent = fLbl === eLbl ? fLbl : fLbl + '／' + eLbl;
    }

    $('opt-cellscale').value = s.cellScale;
    $('val-cellscale').textContent = Math.round(s.cellScale * 100) + '%';
    $('opt-celljitter').value = s.cellJitter || 0;
    $('val-celljitter').textContent = Math.round((s.cellJitter || 0) * 100) + '%';
    $('opt-margin').value = s.margin;
    $('val-margin').textContent = s.margin;
    // 角丸の上限は余白しだい。はみ出したぶんを削るのは余白を動かした側の
    // 仕事で、ここは見せるだけ（syncControls が state を書き換えると、
    // 履歴の取り方と噛み合わなくなる）
    const maxRadius = maxRadiusOf(s.margin);
    $('opt-radius').max = maxRadius;
    $('opt-radius').value = s.radius;
    $('opt-radius').disabled = maxRadius === 0;
    $('val-radius').textContent = maxRadius === 0 ? '—' : s.radius;
    $('opt-minver').value = state.minVersion;
    $('val-minver').textContent = state.minVersion <= 1 ? '自動' : 'v' + state.minVersion + '以上';

    // ロゴ同期
    setSeg('logo-mode', s.logo.type, 'mode');
    $('logo-icon-pane').classList.toggle('hidden', s.logo.type !== 'icon');
    $('logo-image-pane').classList.toggle('hidden', s.logo.type !== 'image');
    $('logo-text-pane').classList.toggle('hidden', s.logo.type !== 'text');
    $('logo-common').classList.toggle('hidden', s.logo.type === 'none');

    setSeg('logo-font-seg', s.logo.font || 'sans', 'font');
    if ($('logo-text')) $('logo-text').value = s.logo.text || '';

    // ロゴ共通
    if ($('logo-size')) $('logo-size').value = s.logo.size;
    if ($('val-logosize')) $('val-logosize').textContent = Math.round(s.logo.size * 100) + '%';
    if ($('logo-pad')) $('logo-pad').value = s.logo.pad;
    if ($('val-logopad')) $('val-logopad').textContent = Math.round(s.logo.pad * 100) + '%';
    if ($('logo-thumb')) $('logo-thumb').classList.toggle('hidden', !(s.logo.type === 'image' && s.logo.src));
    if (s.logo.src && $('logo-thumb-img')) $('logo-thumb-img').src = s.logo.src;
    $('hint-logo').textContent = s.logo.type === 'none' ? 'なし'
      : s.logo.type === 'icon' ? ((A.ICONS.find(i => i.id === s.logo.icon) || {}).name || 'アイコン')
      : s.logo.type === 'image' ? '画像' : '文字';

    // フレーム同期
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
    const framePos = framePosOf();
    const isBothPos = framePos === 'both';
    setSeg('frame-pos-seg', framePos, 'pos');

    const cMode = (s.frame && (framePos === 'top' ? (s.frame.topContentMode || s.frame.contentMode) : s.frame.contentMode)) || 'text';
    setSeg('frame-content-mode-seg', cMode, 'mode');
    if ($('frame-pane-text')) $('frame-pane-text').classList.toggle('hidden', cMode !== 'text');
    if ($('frame-pane-icon')) $('frame-pane-icon').classList.toggle('hidden', cMode !== 'icon');
    if ($('frame-pane-image')) $('frame-pane-image').classList.toggle('hidden', cMode !== 'image');

    // テキスト。上下に出すときだけ、上の文字を別の欄で受ける
    if ($('frame-text')) $('frame-text').value = s.frame[frameTextKey()] || '';
    if ($('frame-text-label')) $('frame-text-label').textContent = isBothPos ? '下部の文字' : '表示する文字';
    const topTextRow = $('frame-text-top-row');
    if (topTextRow) topTextRow.classList.toggle('hidden', !isBothPos);
    if ($('frame-text-top')) $('frame-text-top').value = s.frame.textTop || '';
    setSeg('frame-font-seg', (s.frame && s.frame.font) || 'sans', 'font');

    // アイコン
    if ($('frame-icon-tabs')) {
      Array.prototype.forEach.call($('frame-icon-tabs').children, t => {
        setActive(t, t.dataset.group === (state.frameIconGroup || 'brand'));
      });
    }
    const curIcon = (framePos === 'top' ? (s.frame.topIcon || s.frame.icon) : s.frame.icon) || 'si-instagram';
    syncShapeGridActive('frame-icon-grid', curIcon);

    // 画像
    const curImgSrc = (framePos === 'top' ? (s.frame.topSrc || s.frame.src) : s.frame.src) || '';
    if ($('frame-image-thumb')) {
      $('frame-image-thumb').classList.toggle('hidden', !curImgSrc);
      if (curImgSrc && $('frame-image-thumb-img')) $('frame-image-thumb-img').src = curImgSrc;
    }

    // 中身の大きさ・余白
    const fcSize = s.frame && s.frame.contentSize != null ? s.frame.contentSize : 1;
    const fcPad = s.frame && s.frame.contentPad != null ? s.frame.contentPad : 0.2;
    if ($('frame-content-size')) $('frame-content-size').value = fcSize;
    if ($('val-frame-content-size')) $('val-frame-content-size').textContent = Math.round(fcSize * 100) + '%';
    if ($('frame-content-pad')) $('frame-content-pad').value = fcPad;
    if ($('val-frame-content-pad')) $('val-frame-content-pad').textContent = Math.round(fcPad * 100) + '%';

    updateCanvasChecker();
  }

  // ------------------------------------------------------------------
  // 描画
  // ------------------------------------------------------------------
  let lastSvg = '';
  let lastPayload = '';

  let renderTimer = null;
  let verifyTimer = null;

  // 中身・誤り訂正・密度が変わっていなければ、QR は組み直さなくてよい。
  // 色や形をいじっているあいだ（ドラッグ中は毎コマここへ来る）、同じ
  // 計算を繰り返さないための一枚だけの控え。render は自前の格子へ写して
  // から描くので、渡した QR が書き換わることはない。
  let qrCache = null;
  function encodeQR(text) {
    const key = state.ec + '|' + state.minVersion + '|' + text;
    if (qrCache && qrCache.key === key) return qrCache.qr;
    const qr = window.QRCore.encode(text, { ec: state.ec, minVersion: state.minVersion });
    qrCache = { key: key, qr: qr };
    return qr;
  }
  let activeVerifyPromise = null;

  // 文字を打っているあいだの描き直し。検査まで毎回走らせると、1文字ごとに
  // デコーダが起動する。描き直しは詰めて、検査は打ち終わりまで待たせる。
  function scheduleUpdate() {
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(() => update({ debounceVerify: true }), 90);
  }

  function scheduleVerify(svg, text, heavy, delay) {
    if (verifyTimer) clearTimeout(verifyTimer);
    verifyTimer = setTimeout(() => {
      verifyTimer = null;
      verify(svg, text, heavy);
    }, delay || 180);
  }

  // 「操作が終わった」合図（change）が来たら、180ms を待たずに検査へ入る。
  // ただし待ち時間をゼロにはしない。Chrome の <input type="color"> は、
  // つまみを動かしているあいだ input と一緒に change も投げ続けるので、
  // その場で走らせるとドラッグ1コマごとにデコーダが起動して画面が固まる
  // （40コマ動かすと 40 回・2.4秒ぶん走っていた）。短く待ち直せば、
  // 動かしているあいだは走らず、止まった直後に1回だけ走る。
  function verifyOnCommit() {
    if (!verifyTimer || !lastSvg || !lastPayload) return;
    scheduleVerify(lastSvg, lastPayload, false, 60);
  }

  function update(opts) {
    if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
    saveSoon();
    recordHistorySoon(opts && opts.immediateHistory);
    // 市松模様はセルの色だけで決まる。描けたかどうかに関係なく合わせたいので、
    // 出口ごとに呼ばず入口で一度だけ。
    updateCanvasChecker();
    // 一括生成の「フレームの文字にする列」も、フレームの種類しだいで
    // 出したり引っ込めたりする。ここも描けたかどうかとは関係がない
    syncBulkLabelRow();

    const text = payload();
    lastPayload = text;

    const meta = $('meta-row');
    meta.innerHTML = '';

    if (!text) {
      if (verifyTimer) { clearTimeout(verifyTimer); verifyTimer = null; }
      $('preview').innerHTML = '';
      lastSvg = '';
      setVerdict('na', '待機中', '内容を入力するとここに出ます', []);
      syncVerifyButton(false);
      renderAlerts([]);
      syncPrintNote(0);
      setStatus('ready', 'idle');
      return;
    }

    let qr;
    try {
      qr = encodeQR(text);
    } catch (e) {
      if (verifyTimer) { clearTimeout(verifyTimer); verifyTimer = null; }
      $('preview').innerHTML = '';
      lastSvg = '';
      setVerdict('ng', '入りきりません', '文字数を減らすか、誤り訂正レベルを下げてください', []);
      syncVerifyButton(false);
      renderAlerts([{ kind: 'too-long', level: 'error', text: 'この内容はQRコードの上限（バージョン40）を超えています。文字数を減らしてください。' }]);
      syncPrintNote(0);
      setStatus('too long', 'err');
      return;
    }

    const out = window.QRStyle.render(qr, state.style);
    lastSvg = out.svg;
    $('preview').innerHTML = out.svg;

    // フローティングミニプレビューがあれば同期
    const fpSvg = $('float-preview-svg');
    if (fpSvg) fpSvg.innerHTML = out.svg;

    // フルスクリーンが開いていればプレビューも同期
    const fsPrev = $('fullscreen-preview');
    if (fsPrev && $('fullscreen-modal') && !$('fullscreen-modal').classList.contains('hidden')) {
      fsPrev.innerHTML = out.svg;
    }

    syncPrintNote(out.width);

    [['v' + qr.version, 'バージョン'], [qr.size + '×' + qr.size, 'モジュール'],
     ['EC ' + qr.ec, '誤り訂正'], [new TextEncoder().encode(text).length + ' B', 'データ量'],
     ['コントラスト ' + out.contrast.toFixed(1) + ':1', '']].forEach(m => {
      meta.appendChild(el('span', { class: 'meta', title: m[1] }, m[0]));
    });

    renderAlerts(out.warnings);
    setStatus('v' + qr.version + ' / ' + qr.ec, 'idle');

    if (opts && opts.debounceVerify) {
      scheduleVerify(out.svg, text, false, 180);
    } else {
      if (verifyTimer) { clearTimeout(verifyTimer); verifyTimer = null; }
      verify(out.svg, text, false);
    }
  }



  function pushAlert(level, text, actions) {
    const a = el('div', { class: 'alert' + (level === 'error' ? ' error' : '') });
    const content = el('div', { class: 'alert-body' });
    content.appendChild(el('span', null, text));
    const list = !actions ? [] : (Array.isArray(actions) ? actions : [actions]);
    if (list.length) {
      const row = el('div', { class: 'alert-actions' });
      list.forEach(action => {
        const btn = el('button', { type: 'button', class: 'st-btn-quiet btn-sm' }, action.label);
        btn.addEventListener('click', action.onClick);
        row.appendChild(btn);
      });
      content.appendChild(row);
    }
    a.appendChild(content);
    $('alerts').appendChild(a);
    return a;
  }

  // 同じ知らせが出続けているあいだは組み直さない。1文字打つたびに DOM を
  // 捨てて作り直すと、読み上げ環境では同じ警告を延々と読まれることになるし、
  // 押そうとしていたボタンが指の下で作り直される。
  let lastAlertsKey = '';

  function renderAlerts(warnings) {
    const list = warnings || [];
    // 直し方のボタンは誤り訂正レベルでも変わる（Hのときは「Hにする」を出さない）。
    // 文面が同じでも押せる手が変わるので、鍵にレベルまで入れる。
    const key = state.ec + String.fromCharCode(10) +
      list.map(w => (w.kind || '') + '|' + w.level + '|' + w.text).join(String.fromCharCode(10));
    if (key === lastAlertsKey) return;
    lastAlertsKey = key;
    $('alerts').innerHTML = '';
    list.forEach(w => pushAlert(w.level, w.text, warningActions(w)));
  }

  // ------------------------------------------------------------------
  // 印刷サイズ
  // ------------------------------------------------------------------
  // 刷ったものが読めるかどうかは、画素数ではなく「1モジュールが何ミリか」で
  // 決まる。0.4mm あたりが、一般的な印刷でマス目が潰れずに残る下限。
  // 距離の目安は経験則で、読み取れる距離はおおむねQRの一辺の10倍。
  const MM_PER_INCH = 25.4;
  const MODULE_MM_SAFE = 0.5;
  const MODULE_MM_OK = 0.4;
  const MODULE_MM_TIGHT = 0.3;
  const PRINT_MM_MIN = 5;
  const PRINT_MM_MAX = 400;
  const PRINT_DPI = [300, 600, 1200];

  // ---- AVIF・WebP の圧縮 --------------------------------------------
  // 非可逆は品質を、可逆は「どれだけ時間をかけて縮めるか」を選ばせる。
  // 可逆に品質はないが、縮め方の強弱はある（同じ絵のまま大きさだけ変わる）。
  const QUALITY_MIN = 60;
  const QUALITY_MAX = 100;
  const EFFORT_WORDS = { 1: '速さ優先', 2: 'ふつう', 3: '小ささ優先' };

  // WebP は quality 1.0 のときだけ可逆になる（実測で元と1ピクセルも違わない）。
  // 非可逆で 1.0 を渡すと可逆に化けるので、そこだけは 0.99 で止める。
  function webpQuality() {
    return state.lossless ? 1 : Math.min(0.99, state.quality / 100);
  }

  function avifOptions() {
    return { lossless: state.lossless, quality: state.quality, effort: state.effort };
  }

  // 直近に描いた絵の幅（モジュール単位）。余白もフレームも込みの、
  // 実際に書き出される絵の幅。印刷の目安はこれを分母に取る。
  let lastModuleW = 0;

  function printPx() {
    return Math.max(64, Math.round(state.printMm / MM_PER_INCH * state.printDpi));
  }

  // 書き出す画素数。px 指定ならそのまま、mm 指定なら解像度から起こす。
  function outputPx() {
    return state.sizeUnit === 'mm' ? printPx() : state.exportSize;
  }

  function moduleMm() {
    return lastModuleW > 0 ? state.printMm / lastModuleW : 0;
  }

  // モジュール寸法から、余裕・実用・ギリギリ・危険の4段階に振る
  function moduleMmLevel(mm) {
    if (mm >= MODULE_MM_SAFE) return { cls: 'ok', word: '余裕あり' };
    if (mm >= MODULE_MM_OK) return { cls: 'ok', word: '実用範囲' };
    if (mm >= MODULE_MM_TIGHT) return { cls: 'warn', word: 'ギリギリ。実機で確かめてください' };
    return { cls: 'err', word: '印刷で潰れる恐れがあります' };
  }

  function fmtMm(v) {
    return (Math.round(v * 100) / 100).toFixed(2);
  }

  // 読み取り距離の目安（QRの一辺のおよそ10倍）
  function fmtScanDistance(widthMm) {
    const m = widthMm * 10 / 1000;
    return '約' + (Math.round(m * 10) / 10) + 'm';
  }

  // 圧縮の引き出しは AVIF と WebP でしか意味がない。いま誰のために開いて
  // いるのかを持っておく。見出しも、保存ボタンの文言も、つまみを出すかも
  // これで決まる。
  let compressFor = '';
  const COMPRESS_MIME = { avif: 'image/avif', webp: 'image/webp' };

  function syncCompress() {
    setSeg('compress-seg', state.lossless ? 'lossless' : 'lossy', 'mode');
    const q = $('opt-quality');
    const ef = $('opt-effort');
    const label = $('compress-label');
    const val = $('val-compress');
    const note = $('compress-note');
    const fmt = compressFor === 'webp' ? 'WebP' : 'AVIF';
    // WebP の可逆には強弱がない。効かないつまみを出しておくより、消して
    // 「ここは選ぶところがない」と分かるほうがよい。
    const noKnob = compressFor === 'webp' && state.lossless;
    const title = $('compress-title');
    if (title) title.textContent = fmt + ' の圧縮';
    const row = $('compress-slider-row');
    if (row) row.classList.toggle('hidden', noKnob);
    if (q) { q.value = state.quality; q.classList.toggle('hidden', state.lossless); }
    if (ef) { ef.value = state.effort; ef.classList.toggle('hidden', !state.lossless); }
    if (label) label.textContent = state.lossless ? '圧縮の強さ' : '品質';
    if (val) val.textContent = state.lossless ? EFFORT_WORDS[state.effort] : String(state.quality);
    if (note) {
      note.className = 'print-note';
      note.textContent = noKnob
        ? 'WebPの可逆圧縮に強弱の設定はありません。元の絵と1ピクセルも変わらないまま保存します。'
        : state.lossless
        ? '元の絵と1ピクセルも変わりません。強くするほど小さくなりますが、書き出しに時間がかかります'
          + '（1024pxの黒白QRで、ふつう51KB・0.5秒／小ささ優先33KB・4秒）。'
        : '元の絵とごくわずかに変わりますが、読み取りには影響しません'
          + '（1024pxの黒白QRで13KBほど。可逆なら51KB、PNGなら43KB）。';
    }
  }

  // 押したボタンの真下へ引き出しを向ける。AVIF は左列、WebP は右列。
  function openCompress(fmt) {
    const box = $('opt-compress');
    if (!box) return;
    compressFor = fmt;
    // 2列グリッドの gap 8px ぶんを足し引きすると、ボタンの中心とぴたり合う
    box.style.setProperty('--caret-x', fmt === 'avif' ? 'calc(25% - 2px)' : 'calc(75% + 2px)');
    box.classList.remove('hidden');
    markCompressButtons(fmt);
    syncCompress();
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function closeCompress() {
    const box = $('opt-compress');
    if (box) box.classList.add('hidden');
    compressFor = '';
    markCompressButtons('');
  }

  function markCompressButtons(fmt) {
    ['avif', 'webp'].forEach(f => {
      const b = $('btn-' + f);
      if (!b) return;
      b.classList.toggle('is-open', f === fmt);
      b.setAttribute('aria-expanded', f === fmt ? 'true' : 'false');
    });
  }

  function syncSizeUnit() {
    const isMm = state.sizeUnit === 'mm';
    setSeg('size-unit-seg', state.sizeUnit, 'unit');
    const fields = $('print-fields');
    if (fields) fields.classList.toggle('hidden', !isMm);
    const pxFields = $('px-fields');
    if (pxFields) pxFields.classList.toggle('hidden', isMm);
    const mm = $('opt-print-mm');
    if (mm) mm.value = String(state.printMm);
    const dpi = $('opt-print-dpi');
    if (dpi) dpi.value = String(state.printDpi);
    syncPrintNote();
  }

  function syncPrintNote(moduleW) {
    if (moduleW !== undefined) lastModuleW = moduleW;
    const note = $('print-note');
    const derived = $('opt-size-derived');
    if (!note) return;

    if (!lastModuleW) {
      note.className = 'print-note';
      note.textContent = '';
      if (derived) derived.textContent = '';
      return;
    }

    if (state.sizeUnit === 'mm') {
      const mm = moduleMm();
      const lv = moduleMmLevel(mm);
      const px = printPx();
      if (derived) derived.textContent = px + ' px';
      note.className = 'print-note ' + lv.cls;
      note.textContent = '幅 ' + state.printMm + 'mm・' + state.printDpi + 'dpi なら ' + px +
        'px で書き出します。1モジュール ' + fmtMm(mm) + 'mm（' + lv.word + '）。' +
        '読み取り距離の目安は ' + fmtScanDistance(state.printMm) + 'まで。';
    } else {
      // 幅が決まっていないので、逆に「最低これだけ要る」を言う
      const minMm = Math.ceil(lastModuleW * MODULE_MM_OK);
      note.className = 'print-note';
      note.textContent = '印刷するなら幅 ' + minMm + 'mm 以上（1モジュール ' + MODULE_MM_OK +
        'mm）。それより小さいと、にじみでマス目が潰れることがあります。' +
        '寸法で決めたいときは「印刷（mm）」に切り替えてください。';
      if (derived) derived.textContent = '';
    }
  }

  // ------------------------------------------------------------------
  // 警告の直し方
  // ------------------------------------------------------------------
  // 警告はどれも「いまの組み合わせを測った結果」で、ひとつの設定を見て
  // 出しているわけではない（ロゴの面積なら大きさ・余白・下地の形・誤り訂正・
  // 内容の長さの5つで動く）。だから選べなくするのではなく、測った側が
  // 「こう直せば収まる」を用意して押せるようにする。

  // 直した結果をひと通り画面に反映する。履歴には1手として残す。
  function applyFix(fn, message, opts) {
    if (fn() === false) return;
    // デザインを触った直しはテンプレートから外れる。誤り訂正のように
    // デザインではない設定を変えただけなら、テンプレート名は残す。
    if (!(opts && opts.keepPreset)) state.presetName = '';
    syncControls();
    syncPresetActive();
    update({ immediateHistory: true });
    if (message) showToast(message);
  }

  // 色を白または黒へ寄せる（色みは残したまま明るさだけ動かす）
  function towardHex(hex, target, t) {
    const a = hexToRgb(hex) || [0, 0, 0];
    const b = hexToRgb(target) || [0, 0, 0];
    const m = a.map((v, i) => Math.round(v + (b[i] - v) * t));
    return '#' + m.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
  }

  // いまの背景（白・透明・セル追従まで解いたあと）の実際の色
  function resolvedBgHex() {
    const bg = window.QRStyle.resolvePaint(state.style.bg, state.style.fg);
    const c = window.QRStyle.paintColor(bg);
    if (!c || bg.type === 'none') return '#FFFFFF';
    const tr = bg.transparency !== undefined ? Number(bg.transparency) : 0;
    return window.QRStyle.overWhite(c, (100 - tr) / 100);
  }

  // ロゴを、誤り訂正の余力の半分に収まるところまで縮める。
  // 面積は（大きさ×(1+余白×2)）の2乗にほぼ比例するので、比から一度で寄せて、
  // 丸めのぶんだけ描き直して詰める。
  function shrinkLogoToFit() {
    const lg = state.style.logo;
    let qr;
    try { qr = encodeQR(payload()); } catch (e) { return false; }
    for (let i = 0; i < 6; i++) {
      const out = window.QRStyle.render(qr, state.style);
      const target = out.logoBudget * 0.5;
      if (!out.coverage || out.coverage <= target) return true;
      const next = Math.max(0.1, Math.round(lg.size * Math.min(0.96, Math.sqrt(target / out.coverage)) * 100) / 100);
      if (next >= lg.size) break;
      lg.size = next;
      if (lg.size <= 0.1) break;
    }
    return true;
  }

  // セルの色を、背景と分けられる濃さまで動かす。単色のときだけ効く
  // （グラデーションや画像は、どの色を動かせばよいか決められない）。
  function pushCellAwayFromBg() {
    const fg = state.style.fg;
    if (fg.type !== 'solid') return false;
    const bgHex = resolvedBgHex();
    const luma = window.QRStyle.encodedLuma;
    const goal = luma(fg.color) < luma(bgHex) ? '#000000' : '#FFFFFF';
    const base = fg.color;
    for (let t = 0.1; t <= 1.001; t += 0.1) {
      const cand = towardHex(base, goal, t);
      // ものさしは qr-style のものをそのまま借りる。ここだけ別の式で
      // 見ていると、直したつもりで警告が残る。0.30 は警告の出る 0.44 の
      // 十分手前で、にじんでも越えないところ。
      if (window.QRStyle.lumaRatio(cand, bgHex) <= 0.30) { fg.color = cand; return true; }
    }
    fg.color = goal;
    return true;
  }

  function warningActions(w) {
    const kind = w && w.kind;
    if (!kind) return null;

    if (kind === 'logo-big' || kind === 'logo-tight') {
      const acts = [];
      // 誤り訂正を上げるほうが、デザインを変えずに済む。先に置く。
      if (state.ec !== 'H') {
        acts.push({
          label: '誤り訂正をHにする',
          onClick: () => { state.ec = 'H'; applyFix(() => true, '誤り訂正をHにしました', { keepPreset: true }); }
        });
      }
      acts.push({
        label: '安全な大きさに縮める',
        onClick: () => applyFix(shrinkLogoToFit, 'ロゴを安全な大きさに縮めました')
      });
      return acts;
    }

    if (kind === 'margin') {
      return {
        label: '余白を4にする',
        onClick: () => applyFix(() => {
          state.style.margin = 4;
          state.style.radius = Math.min(state.style.radius, maxRadiusOf(4));
          return true;
        }, '余白を4にしました')
      };
    }

    if (kind === 'contrast' && state.style.fg.type === 'solid') {
      return {
        label: 'セルの色を濃くする',
        onClick: () => applyFix(pushCellAwayFromBg, 'セルの色を、背景と分けられる濃さにしました')
      };
    }

    if (kind === 'marker-frame' || kind === 'marker-eye') {
      const key = kind === 'marker-frame' ? 'markerFramePaint' : 'markerEyePaint';
      return {
        label: 'セルの色に合わせる',
        onClick: () => applyFix(() => {
          state.style[key] = { type: 'auto' };
          return true;
        }, 'マーカーの色をセルに合わせました')
      };
    }

    if (kind === 'invert') {
      return {
        label: '意図した配色として扱う',
        onClick: () => applyFix(() => {
          state.style.invertOk = true;
          return true;
        }, '反転QRとして扱います（警告は出しません）')
      };
    }

    return null;
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

  // 直近の判定。書き出す前に「赤のまま出そうとしていないか」を見るのに使う。
  let lastVerdict = { kind: 'na', title: '', note: '' };

  // 途中経過（「チェック中…」やデコーダの読み込み）は quiet で呼ぶ。
  // 読み上げ環境に流すのは、確定した判定だけにする。走っている最中の
  // 文字まで読み上げると、肝心の結果が埋もれる。
  function setVerdict(kind, title, note, engines, quiet) {
    lastVerdict = { kind: kind, title: title, note: note || '' };
    $('verdict').className = 'verdict ' + kind;
    $('verdict-title').textContent = title;
    $('verdict-note').textContent = note || '';
    const sr = $('verdict-sr');
    if (sr && !quiet) sr.textContent = title + (note ? '。' + note : '');
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

  // 読ませるときに敷く紙の色。書き出した絵は透けたまま渡されるので、
  // どこかで不透明にしないとデコーダは透明部分を真っ黒として読む。
  const PAPER = '#FFFFFF';

  // 足りない余白を補うときの色。実際に地として描かれる色を使う。
  // 「セルの色」や「白」は指定でしかないので resolvePaint で解いてから訊く。
  // 透過スライダーで抜いたぶんは紙が透けるので、そのぶん白へ寄せる。
  // ここを不透明の色のまま返すと、透過 100%（＝何も描かれない）の背景でも
  // 紙をその色で塗ってしまい、「背景＝セルの色」や「セルと同じグラデーション」
  // では絵の全面がセルと同色になって、必ず読み取りに失敗していた。
  // 透明（paintColor が null）は、読ませるときは白い紙の上とみなす。
  function padColor() {
    const bg = window.QRStyle.resolvePaint(state.style.bg, state.style.fg);
    const c = window.QRStyle.paintColor(bg);
    if (!c || bg.type === 'none') return PAPER;
    const tr = bg.transparency !== undefined ? Number(bg.transparency) : 0;
    return window.QRStyle.overWhite(c, (100 - tr) / 100);
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
    const p = (async () => {
      const pad = padColor();
      setVerdict('na', 'チェック中…', '', [], true);
      syncVerifyButton(true);
      try {
        const run = window.QRVerify.run({
          // 下敷きは紙そのもの（白）。ここに背景の色を敷くと、SVG 側の背景が
          // その上にもう一度重なり、透過を指定した意味がなくなってしまう。
          // 足りない余白を補う色（pad）とは役割が違うので、分けて渡す。
          render: px => rasterize(svg, px, PAPER),
          expect: expect,
          moduleWidth: moduleWidth(svg),
          margin: state.style.margin,
          padColor: pad,
          heavy: heavy,
          onProgress: t => setVerdict('na', t, '', [], true)
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
    })();
    activeVerifyPromise = p;
    try {
      await p;
    } finally {
      if (activeVerifyPromise === p) activeVerifyPromise = null;
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
    // 印刷向けに書き出したものは、あとから見て何ミリで作ったか分かるようにする
    const size = state.sizeUnit === 'mm' ? '-' + state.printMm + 'mm' : '';
    return 'qr-' + state.type + '-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + size;
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

  function flashButtonSuccess(btn, successText) {
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = successText;
    btn.classList.add('btn-success-flash');
    setTimeout(() => {
      btn.textContent = orig;
      btn.classList.remove('btn-success-flash');
    }, 1400);
  }

  function openFullscreen() {
    if (!lastSvg) return;
    const modal = $('fullscreen-modal');
    const host = $('fullscreen-preview');
    if (!modal || !host) return;
    host.innerHTML = lastSvg;
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  function closeFullscreen() {
    const modal = $('fullscreen-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    document.body.style.overflow = '';
  }

  // 書き出す直前に、待っている検査を繰り上げて片づける。押した時点の絵で
  // 判断したいので、180ms 後に走る予定のものを待たない。
  // すでに検査が走っている最中なら、その完了を待つ。
  async function settleVerdict() {
    if (verifyTimer) {
      clearTimeout(verifyTimer);
      verifyTimer = null;
      if (lastSvg && lastPayload) await verify(lastSvg, lastPayload, false);
    } else if (activeVerifyPromise) {
      await activeVerifyPromise;
    }
  }

  // 読みもののモーダル。答えを待たないので、confirm と違って Promise は返さない。
  function openCsvHelp() {
    const modal = $('csv-help-modal');
    const close = $('btn-csv-help-close');
    if (!modal || !close) return;
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    function done() {
      modal.classList.add('hidden');
      document.body.style.overflow = '';
      close.removeEventListener('click', done);
      modal.removeEventListener('click', onBackdrop);
      window.removeEventListener('keydown', onKey);
    }
    function onBackdrop(e) {
      if (e.target === modal || e.target.classList.contains('fullscreen-modal-backdrop')) done();
    }
    function onKey(e) { if (e.key === 'Escape') done(); }
    close.addEventListener('click', done);
    modal.addEventListener('click', onBackdrop);
    window.addEventListener('keydown', onKey);
    close.focus();
  }

  // 取り返しのつかない操作の前に一度だけ訊く。
  // opts: { title, body, ok, cancel }。ok を押したときだけ true。
  function askConfirm(opts) {
    const modal = $('confirm-modal');
    if (!modal) return Promise.resolve(true);
    $('confirm-title').textContent = opts.title;
    $('confirm-body').textContent = opts.body;
    $('btn-confirm-ok').textContent = opts.ok;
    $('btn-confirm-cancel').textContent = opts.cancel;
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    const ok = $('btn-confirm-ok');
    const cancel = $('btn-confirm-cancel');
    return new Promise(resolve => {
      function done(answer) {
        modal.classList.add('hidden');
        document.body.style.overflow = '';
        ok.removeEventListener('click', onOk);
        cancel.removeEventListener('click', onCancel);
        modal.removeEventListener('click', onBackdrop);
        window.removeEventListener('keydown', onKey);
        resolve(answer);
      }
      function onOk() { done(true); }
      function onCancel() { done(false); }
      function onBackdrop(e) {
        if (e.target === modal || e.target.classList.contains('fullscreen-modal-backdrop')) done(false);
      }
      function onKey(e) { if (e.key === 'Escape') done(false); }
      ok.addEventListener('click', onOk);
      cancel.addEventListener('click', onCancel);
      modal.addEventListener('click', onBackdrop);
      window.addEventListener('keydown', onKey);
      cancel.focus();
    });
  }

  // 赤い判定のときだけ、一度だけ訊く。印刷してから気づくのがいちばん高くつく。
  function askExportAnyway() {
    // 判定の文面は句点で終わらないことがある。次の文と地続きに見えないよう補う。
    const note = lastVerdict.note || '';
    const lead = !note ? '' : (note.charAt(note.length - 1) === '。' ? note : note + '。');
    return askConfirm({
      title: lastVerdict.title || '読み取れませんでした',
      body: lead + 'このまま書き出すと、印刷したあとで読めないことに気づくかもしれません。',
      ok: 'このまま書き出す',
      cancel: 'やめて直す'
    });
  }

  // 書き出してよいか。読めない判定のときだけ確認を挟む。
  // 「簡易チェックでは読めません」（黄）は止めない。軽いデコーダの失敗は
  // 実機では読めることが多く、そこで止めると偽陰性で手を止めることになる。
  async function okToExport() {
    await settleVerdict();
    if (lastVerdict.kind !== 'ng') return true;
    return askExportAnyway();
  }

  // 1枚ぶんを焼く。AVIF だけはブラウザが焼けないので、同梱した
  // エンコーダに渡す（toBlob に image/avif を渡すと黙って PNG が返る）。
  async function encodeCanvas(canvas, mime) {
    if (mime === 'image/avif') {
      if (!window.QRAvif) throw new Error('avif encoder missing');
      return window.QRAvif.encode(canvas, avifOptions());
    }
    const q = mime === 'image/webp' ? webpQuality() : undefined;
    return new Promise(res => canvas.toBlob(res, mime, q));
  }

  async function exportRaster(mime, ext) {
    if (!lastSvg) { showToast('先に内容を入力してください', 'error'); return; }
    if (!(await okToExport())) return;

    // AVIF のエンコーダは 3.4MB ある。取りに行っているあいだ画面が
    // 止まって見えるので、何をしているかは出しておく。
    const isAvif = mime === 'image/avif';
    if (isAvif && window.QRAvif && !window.QRAvif.loaded()) {
      setStatus('loading avif encoder', '');
      showToast('AVIFエンコーダを読み込み中…');
      try {
        await window.QRAvif.load();
      } catch (e) {
        showToast('AVIFエンコーダを読み込めませんでした', 'error');
        setStatus('ready', 'idle');
        return;
      }
    }

    setStatus('rendering', '');
    try {
      const canvas = await rasterize(await withExportFonts(lastSvg), outputPx(), null);
      const blob = await encodeCanvas(canvas, mime);
      if (!blob) throw new Error('encode failed');
      // 対応していない形式を渡すと、黙って PNG が返ってくる。拡張子を偽らない
      const realExt = blob.type === mime ? ext : (blob.type.split('/')[1] || ext);
      saveBlob(blob, fileStem() + '.' + realExt);
      const btn = $('btn-' + ext);
      if (btn) flashButtonSuccess(btn, '✓ 保存完了');
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
    if (!(await okToExport())) return;
    // mm 指定のときは、mm のまま書き出す。Illustrator や InDesign に読ませた
    // ときに、拡大率をいじらなくてもその寸法で入る。
    const body = await withExportFonts(lastSvg);
    const sized = state.sizeUnit === 'mm'
      ? window.QRStyle.resizeMm(body, state.printMm)
      : window.QRStyle.resize(body, 1024);
    const doc = '<?xml version="1.0" encoding="UTF-8"?>' + String.fromCharCode(10) + sized;
    saveBlob(new Blob([doc], { type: 'image/svg+xml;charset=utf-8' }), fileStem() + '.svg');
    flashButtonSuccess($('btn-svg'), '✓ 保存完了');
    showToast('SVGを保存しました');
  }

  // コピーだけは確認を挟めない。Safari は「押されてすぐ」でないと
  // クリップボードに書かせてくれず、ダイアログを出すと有効期限が切れる。
  // 止めるかわりに、赤い判定のときは知らせを添える。
  function copyNote() {
    return lastVerdict.kind === 'ng'
      ? '画像をコピーしました。読み取りテストは失敗しているので、使う前に確かめてください'
      : '画像をコピーしました';
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
      const canvas = await rasterize(await withExportFonts(lastSvg), Math.min(2048, outputPx()), null);
      const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
      if (!blob) throw new Error('encode failed');
      return blob;
    })();
    try {
      await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': png })]);
      flashButtonSuccess($('btn-copy'), '✓ コピー完了');
      showToast(copyNote());
      if (window.STShare) STShare.celebrate();
    } catch (e) {
      // Promise を受け付けない実装もあるので、その場合は焼けた Blob で入れ直す
      try {
        await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': await png })]);
        flashButtonSuccess($('btn-copy'), '✓ コピー完了');
        showToast(copyNote());
        if (window.STShare) STShare.celebrate();
      } catch (e2) {
        showToast('コピーできませんでした', 'error');
      }
    }
  }

  // ------------------------------------------------------------------
  // CSV一括生成
  // ------------------------------------------------------------------
  // 画面で作っているデザインはそのままに、中身だけを CSV の行で差し替えて焼く。
  //
  // 1行ずつデコーダにかけ直すことはしない。デザインの読み取りやすさは全行に
  // 等しく効くので、上の判定がそのまま全部の答えになる。行ごとに変わるのは
  // 中身の長さ（＝マス目の細かさ）だけなので、入りきらなかった行だけを拾う。

  const BULK_MAX = 1000;      // これ以上は焼くのも ZIP にするのも重すぎる
  const BULK_YIELD = 8;       // 何件ごとに画面へ制御を返すか
  const BULK_NONE = '__none__';

  const bulk = {
    rows: [],          // 見出しも含む、読み込んだままの全行
    fileName: '',
    encoding: '',
    running: false,
    abort: false
  };

  // 列の見出し。1行目を見出しに使わないときは「1列目」「2列目」…と数える。
  function bulkColumns() {
    const width = bulk.rows.reduce((m, r) => Math.max(m, r.length), 0);
    const useHeader = $('bulk-header').checked && bulk.rows.length > 1;
    const head = useHeader ? bulk.rows[0] : [];
    const out = [];
    for (let i = 0; i < width; i++) {
      const name = (head[i] || '').trim();
      out.push(name ? name + '（' + (i + 1) + '列目）' : (i + 1) + '列目');
    }
    return out;
  }

  function bulkDataRows() {
    const useHeader = $('bulk-header').checked && bulk.rows.length > 1;
    return bulk.rows.slice(useHeader ? 1 : 0);
  }

  // 選び直しても選択が飛ばないよう、いまの値を覚えてから組み直す
  function bulkFillSelects() {
    const cols = bulkColumns();
    [['bulk-col-content', false], ['bulk-col-name', true], ['bulk-col-label', true]]
      .forEach(pair => {
        const sel = $(pair[0]);
        const keep = sel.value;
        sel.innerHTML = '';
        if (pair[1]) sel.appendChild(el('option', { value: BULK_NONE }, '使わない'));
        cols.forEach((c, i) => sel.appendChild(el('option', { value: String(i) }, c)));
        const has = Array.prototype.some.call(sel.options, o => o.value === keep);
        sel.value = has ? keep : (pair[1] ? BULK_NONE : '0');
      });
  }

  // 最初の数行を表で見せる。どの列が QR になるのかは、色で示すのが早い。
  function bulkPreview() {
    const host = $('bulk-preview');
    host.innerHTML = '';
    const rows = bulkDataRows();
    if (!rows.length) return;
    const cols = bulkColumns();
    const picked = {
      content: Number($('bulk-col-content').value),
      name: $('bulk-col-name').value === BULK_NONE ? -1 : Number($('bulk-col-name').value),
      label: $('bulk-col-label').value === BULK_NONE ? -1 : Number($('bulk-col-label').value)
    };
    const table = el('table');
    const thead = el('thead');
    const htr = el('tr');
    cols.forEach((c, i) => {
      const th = el('th', { class: i === picked.content ? 'pick' : '' }, c);
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);
    const tbody = el('tbody');
    rows.slice(0, 4).forEach(r => {
      const tr = el('tr');
      cols.forEach((c, i) => {
        const marks = [];
        if (i === picked.content) marks.push('pick');
        tr.appendChild(el('td', { class: marks.join(' ') }, r[i] || ''));
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    host.appendChild(table);
  }

  // ラベル付きのフレームを選んでいるときだけ、文字を差し替える列を出す。
  // 効きようのない設定を並べても、迷わせるだけになる。
  function syncBulkLabelRow() {
    const row = $('bulk-label-row');
    if (!row) return;
    const st = state.style.frame || {};
    // 「文字」で描かれる帯が実際にあるときだけ。位置ごとに内容の指定が
    // 別なので、いま出ている帯のほうを見る
    const pos = framePosOf();
    const usable = st.type === 'label' && (
      (pos !== 'top' && st.contentMode === 'text') ||
      (pos !== 'bottom' && st.topContentMode === 'text'));
    row.classList.toggle('hidden', !usable);
  }

  // ラベルの文字を1行ぶん差し替える。text と textTop のどちらが描かれるかは
  // 位置で決まるので、出ている帯すべてに入れる。ここを frame.text だけに
  // していると、位置が「上部」のとき全行が元の文言のまま焼き上がる。
  function applyBulkLabel(frame, text) {
    const pos = framePosOf(frame);
    if (pos !== 'top') frame.text = text;
    if (pos !== 'bottom') frame.textTop = text;
  }

  function bulkSummary() {
    if (!bulk.rows.length) return '—';
    const n = bulkDataRows().length;
    return n + '行' + (bulk.encoding ? ' / ' + bulk.encoding : '');
  }

  function syncBulkHint() {
    const hint = $('hint-bulk');
    if (hint) hint.textContent = bulkSummary();
  }

  // 読み込んだファイルの見出し。行数は「これから作る枚数」＝データ行で数える。
  // 見出し行を含めた総数を出すと、右肩の要約や書き出した枚数と1つずれる。
  function syncBulkFileName() {
    const host = $('bulk-file-name');
    if (!host) return;
    host.textContent = bulk.fileName
      ? bulk.fileName + '（' + bulkDataRows().length + '行）' : '';
  }

  function bulkRefresh() {
    bulkFillSelects();
    bulkPreview();
    syncBulkLabelRow();
    syncBulkFileName();
    syncBulkHint();
    $('bulk-report').innerHTML = '';
  }

  async function loadBulkFile(file) {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      showToast('CSVが大きすぎます（8MBまで）', 'error');
      return;
    }
    try {
      const parsed = window.QRBulk.decodeText(await file.arrayBuffer());
      const out = window.QRBulk.parse(parsed.text);
      if (!out.rows.length) {
        showToast('CSVに行がありません', 'error');
        return;
      }
      bulk.rows = out.rows;
      bulk.fileName = file.name;
      bulk.encoding = parsed.encoding;
      $('bulk-setup').classList.remove('hidden');
      // 見出しらしさは、1行目に「作れない中身」が並んでいるかでは決められない。
      // 素直に既定を on にしておき、表を見て外してもらう
      bulkRefresh();
    } catch (e) {
      showToast('CSVを読み込めませんでした', 'error');
    }
  }

  function clearBulk() {
    bulk.rows = [];
    bulk.fileName = '';
    bulk.encoding = '';
    $('bulk-setup').classList.add('hidden');
    $('bulk-preview').innerHTML = '';
    $('bulk-report').innerHTML = '';
    $('bulk-file').value = '';
    syncBulkFileName();
    syncBulkHint();
  }

  function setBulkProgress(done, total, note) {
    const box = $('bulk-progress');
    box.classList.remove('hidden');
    $('bulk-bar-fill').style.width = (total ? Math.round((done / total) * 100) : 0) + '%';
    $('bulk-progress-text').textContent = note || (done + ' / ' + total);
  }

  // ラベルを行ごとに差し替えるので、書体の取り寄せは全行ぶんまとめて1回で
  // 済ませる。行ごとに textRuns を通すと、行の数だけ取りに行くことになる。
  async function bulkFontCss(baseStyle, labels) {
    const probe = Object.assign({}, baseStyle);
    probe.frame = Object.assign({}, baseStyle.frame);
    const all = labels.join('');
    probe.frame.text = String(probe.frame.text || '') + all;
    probe.frame.textTop = String(probe.frame.textTop || '') + all;
    let runs = [];
    try { runs = window.QRStyle.textRuns(probe); } catch (e) { return ''; }
    if (!runs.length) return '';
    const faces = await Promise.all(runs.map(fontFaceCss));
    return faces.join('');
  }

  const BULK_FORMATS = {
    png:  { ext: 'png',  mime: 'image/png',  quality: undefined },
    avif: { ext: 'avif', mime: 'image/avif' },
    webp: { ext: 'webp', mime: 'image/webp' },
    svg:  { ext: 'svg',  mime: '' }
  };

  async function runBulk() {
    if (bulk.running) { bulk.abort = true; return; }
    const rows = bulkDataRows();
    if (!rows.length) { showToast('CSVの行がありません', 'error'); return; }
    if (!(await okToExport())) return;

    const contentIdx = Number($('bulk-col-content').value) || 0;
    const nameSel = $('bulk-col-name').value;
    const labelSel = $('bulk-col-label').value;
    const nameIdx = nameSel === BULK_NONE ? -1 : Number(nameSel);
    const labelIdx = (labelSel === BULK_NONE || $('bulk-label-row').classList.contains('hidden'))
      ? -1 : Number(labelSel);
    const asUrl = $('bulk-as-url').checked;
    const fmt = BULK_FORMATS[$('bulk-format').value] || BULK_FORMATS.png;

    const over = rows.length > BULK_MAX ? rows.length - BULK_MAX : 0;
    const use = over ? rows.slice(0, BULK_MAX) : rows;

    // フレームの文字だけ行ごとに差し替える。塗りやロゴは共有のままでよいので、
    // frame だけ自前の入れ物にして、render に渡すあいだ state を汚さない
    const baseStyle = Object.assign({}, state.style);
    baseStyle.frame = Object.assign({}, state.style.frame);

    const btn = $('btn-bulk-run');
    bulk.running = true;
    bulk.abort = false;
    btn.textContent = '中止する';
    $('bulk-report').innerHTML = '';
    setBulkProgress(0, use.length, '書体を用意しています…');
    setStatus('bulk', '');

    const files = [];
    const skipped = [];   // 中身が空だった行
    const failed = [];    // 入りきらなかった行
    const take = window.QRBulk.nameTaker();
    const headOffset = ($('bulk-header').checked && bulk.rows.length > 1) ? 2 : 1;
    const digits = String(use.length).length;
    const pad = n => String(n).padStart(digits, '0');
    const manifest = [['行', 'ファイル名', '中身']];

    try {
      const labels = labelIdx >= 0 ? use.map(r => String(r[labelIdx] || '')) : [];
      const faceCss = await bulkFontCss(baseStyle, labels);

      for (let i = 0; i < use.length; i++) {
        if (bulk.abort) break;
        // 進み具合と「中止」は、飛ばした行でも動かす。ここを行の処理の後ろに
        // 置くと、空行が続いたときだけバーが止まって固まったように見える。
        // canvas.toBlob と decode() のあいだは画面が止まるので、数件ごとに返す
        if (i % BULK_YIELD === 0) {
          setBulkProgress(i, use.length);
          await new Promise(r => setTimeout(r, 0));
          if (bulk.abort) break;
        }
        const row = use[i];
        const lineNo = i + headOffset;
        const raw = String(row[contentIdx] == null ? '' : row[contentIdx]).trim();
        const text = asUrl ? normalizeUrl(raw) : raw;
        if (!text) {
          // 行そのものが空っぽなら黙って飛ばす。ファイル末尾の改行や手で
          // 編集した空行まで並べると、ほんとうに直すべき行が埋もれる
          if (row.some(c => String(c == null ? '' : c).trim())) skipped.push(lineNo);
          continue;
        }

        let qr;
        try {
          qr = window.QRCore.encode(text, { ec: state.ec, minVersion: state.minVersion });
        } catch (e) {
          failed.push(lineNo);
          continue;
        }

        if (labelIdx >= 0) applyBulkLabel(baseStyle.frame, String(row[labelIdx] || ''));
        let svg = window.QRStyle.render(qr, baseStyle).svg;
        if (faceCss) svg = window.QRStyle.embedFontCss(svg, faceCss);

        const base = window.QRBulk.safeName(nameIdx >= 0 ? row[nameIdx] : '') || ('qr-' + pad(i + 1));
        const name = take(base, fmt.ext);

        let bytes;
        if (fmt.ext === 'svg') {
          const doc = '<?xml version="1.0" encoding="UTF-8"?>' + String.fromCharCode(10) +
            window.QRStyle.resize(svg, 1024);
          bytes = new TextEncoder().encode(doc);
        } else {
          const canvas = await rasterize(svg, outputPx(), null);
          const blob = await encodeCanvas(canvas, fmt.mime);
          if (!blob) { failed.push(lineNo); continue; }
          bytes = new Uint8Array(await blob.arrayBuffer());
        }

        files.push({ name: name, bytes: bytes });
        manifest.push([String(lineNo), name, text]);
      }

      if (!files.length) {
        showToast(bulk.abort ? '中止しました' : 'QRコードにできる行がありませんでした',
          bulk.abort ? undefined : 'error');
      } else {
        setBulkProgress(use.length, use.length, 'ZIPにまとめています…');
        // どのファイルが何の中身かを一覧にして同梱する。Excel で開けるよう
        // BOM を付ける（付けないと日本語が化ける）
        const csv = manifest.map(r => r.map(csvCell).join(',')).join(CRLF) + CRLF;
        files.push({
          name: '一覧.csv',
          bytes: new TextEncoder().encode(String.fromCharCode(0xFEFF) + csv)
        });
        const zip = window.QRBulk.zip(files);
        saveBlob(zip, 'qr-bulk-' + stamp() + '.zip');
        if (window.STShare) STShare.celebrate();
      }

      bulkReport({
        made: files.length ? files.length - 1 : 0,
        skipped: skipped, failed: failed, over: over, aborted: bulk.abort, ext: fmt.ext
      });
    } catch (e) {
      showToast(String(e && e.message) === 'zip too large'
        ? 'ZIPが大きすぎます。サイズを下げるか、行を分けてください'
        : '一括生成に失敗しました', 'error');
    }

    bulk.running = false;
    bulk.abort = false;
    btn.textContent = 'まとめて作る';
    $('bulk-progress').classList.add('hidden');
    setStatus('ready', 'idle');
  }

  // CSV のセル。区切り・引用符・改行が入っていたら引用符でくるむ
  function csvCell(v) {
    const s = String(v == null ? '' : v);
    const q = String.fromCharCode(34);
    const needs = s.indexOf(',') >= 0 || s.indexOf(q) >= 0 ||
      s.indexOf(String.fromCharCode(10)) >= 0 || s.indexOf(String.fromCharCode(13)) >= 0;
    return needs ? q + s.split(q).join(q + q) + q : s;
  }

  function stamp() {
    const d = new Date();
    const p = v => String(v).padStart(2, '0');
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  function bulkReport(r) {
    const host = $('bulk-report');
    host.innerHTML = '';
    const head = el('div');
    if (r.aborted && !r.made) {
      head.appendChild(document.createTextNode('中止しました。'));
    } else {
      head.appendChild(el('b', null, r.made + '件'));
      head.appendChild(document.createTextNode(r.aborted
        ? 'を作ったところで中止しました。ここまでのぶんはZIPに入っています。'
        : 'の' + r.ext.toUpperCase() + 'をZIPにまとめました。'));
    }
    host.appendChild(head);

    const notes = [];
    if (r.over && !r.aborted) notes.push('一度に作れるのは' + BULK_MAX + '行までです。残り' + r.over + '行は作っていません。');
    if (r.skipped.length) notes.push('中身が空だった行：' + lineList(r.skipped));
    if (r.failed.length) notes.push('QRコードに入りきらなかった行：' + lineList(r.failed) +
      '（誤り訂正を下げるか、中身を短くしてください）');
    if (notes.length) {
      const ul = el('ul');
      notes.forEach(n => ul.appendChild(el('li', null, n)));
      host.appendChild(ul);
    }
  }

  function lineList(lines) {
    const head = lines.slice(0, 8).map(n => n + '行目').join('、');
    return lines.length > 8 ? head + ' ほか' + (lines.length - 8) + '行' : head;
  }

  // AVIF は1枚ごとにエンコーダを回すので、行数が多いと目に見えて遅い。
  // 選んだ時点で言う（1000行走らせてから気づくのが一番困る）。
  function syncBulkFormatNote() {
    const note = $('bulk-format-note');
    const sel = $('bulk-format');
    if (note && sel) note.classList.toggle('hidden', sel.value !== 'avif');
  }

  function wireBulk() {
    const fmtSel = $('bulk-format');
    if (fmtSel) {
      fmtSel.addEventListener('change', syncBulkFormatNote);
      syncBulkFormatNote();
    }

    if (!window.QRBulk) return;
    const zone = $('bulk-drop'), input = $('bulk-file');
    window.STCommon.setupDropzone({
      dropzone: zone,
      fileInput: input,
      onFiles: files => loadBulkFile(files[0])
    });
    input.addEventListener('change', e => {
      if (e.target.files && e.target.files.length) loadBulkFile(e.target.files[0]);
    });
    $('btn-bulk-clear').addEventListener('click', clearBulk);
    $('bulk-header').addEventListener('change', bulkRefresh);
    ['bulk-col-content', 'bulk-col-name', 'bulk-col-label'].forEach(id => {
      $(id).addEventListener('change', bulkPreview);
    });
    $('btn-bulk-run').addEventListener('click', runBulk);
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
    picker.addEventListener('change', verifyOnCommit);
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
    input.addEventListener('change', verifyOnCommit);
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

    if (fileInput) {
      fileInput.addEventListener('change', e => {
        if (e.target.files && e.target.files.length) take(e.target.files[0]);
      });
    }
  }

  // URLで指定する欄（ボタンと Enter の両方）
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
      p.type = CLEARED_IMAGE_TYPE[scope] || 'auto';
    });
  }

  // マーカーの枠と目の色パネルは中身が同じなので、縦に２枚並べず切り替えで見せる。
  // 状態は持たない（どちらの色も常に生きている）ただの表示切り替え。
  function wireMarkerColorToggle() {
    const seg = $('marker-color-seg');
    if (!seg) return;
    Array.prototype.forEach.call(seg.children, b => {
      b.addEventListener('click', () => {
        const part = b.dataset.part;
        Array.prototype.forEach.call(seg.children, o => setActive(o, o === b));
        ['frame', 'eye'].forEach(scope => {
          const panel = colorPanel(scope);
          if (panel) panel.classList.toggle('hidden', scope !== part);
        });
        state.colorScope = part;
      });
    });
  }

  function wire() {
    $('opt-ec').addEventListener('change', e => { state.ec = e.target.value; syncControls(); update(); });
    $('opt-size').addEventListener('change', e => {
      state.exportSize = parseInt(e.target.value, 10);
      syncPrintNote();
      saveNow();
    });

    // ---- 仕上がりの単位（画面向けの px と、印刷向けの mm） ----
    const unitSeg = $('size-unit-seg');
    if (unitSeg) {
      Array.prototype.forEach.call(unitSeg.children, b => {
        b.addEventListener('click', () => {
          state.sizeUnit = b.dataset.unit === 'mm' ? 'mm' : 'px';
          syncSizeUnit();
          saveNow();
        });
      });
    }

    const inMm = $('opt-print-mm');
    if (inMm) {
      // 打っている途中に丸めない。"4" と打った瞬間に下限へ跳ねると、
      // 40 と打ちたい人が打ち直せなくなる。
      inMm.addEventListener('input', () => {
        const v = Number(inMm.value);
        if (Number.isFinite(v) && v >= PRINT_MM_MIN && v <= PRINT_MM_MAX) {
          state.printMm = Math.round(v);
          syncPrintNote();
        }
      });
      const commitMm = () => {
        state.printMm = Math.round(clampNum(inMm.value, PRINT_MM_MIN, PRINT_MM_MAX, 40));
        inMm.value = String(state.printMm);
        syncPrintNote();
        saveNow();
      };
      inMm.addEventListener('change', commitMm);
      inMm.addEventListener('blur', commitMm);
    }

    // ---- 圧縮 ----
    const compressSeg = $('compress-seg');
    if (compressSeg) {
      Array.prototype.forEach.call(compressSeg.children, b => {
        b.addEventListener('click', () => {
          state.lossless = b.dataset.mode === 'lossless';
          syncCompress();
          saveNow();
        });
      });
    }
    const inQuality = $('opt-quality');
    if (inQuality) {
      inQuality.addEventListener('input', () => {
        state.quality = Math.round(clampNum(inQuality.value, QUALITY_MIN, QUALITY_MAX, 95));
        const val = $('val-compress');
        if (val) val.textContent = String(state.quality);
      });
      inQuality.addEventListener('change', saveNow);
    }
    const inEffort = $('opt-effort');
    if (inEffort) {
      inEffort.addEventListener('input', () => {
        state.effort = Math.round(clampNum(inEffort.value, 1, 3, 2));
        const val = $('val-compress');
        if (val) val.textContent = EFFORT_WORDS[state.effort];
      });
      inEffort.addEventListener('change', saveNow);
    }

    const inDpi = $('opt-print-dpi');
    if (inDpi) {
      inDpi.addEventListener('change', () => {
        state.printDpi = parseInt(inDpi.value, 10) || 300;
        syncPrintNote();
        saveNow();
      });
    }

    COLOR_SCOPES.forEach(wireColorPanel);
    wireMarkerColorToggle();

    // ロゴ種類
    bindSeg('logo-mode', 'mode', v => {
      state.style.logo.type = v;
      if (v === 'icon' && !state.style.logo.iconData) {
        const first = A.ICONS.find(i => i.group === state.iconGroup) || A.ICONS[0];
        state.style.logo.icon = first.id;
        state.style.logo.iconData = first;
        buildIconGrid();
      }
    });

    bindRange('opt-cellscale', 'val-cellscale', v => Math.round(v * 100) + '%', v => {
      state.style.cellScale = v;
      updateFrameGridPreviews();
    });
    bindRange('opt-celljitter', 'val-celljitter', v => Math.round(v * 100) + '%', v => { state.style.cellJitter = v; });
    bindRange('opt-margin', 'val-margin', v => String(v), v => {
      state.style.margin = v;
      // 角丸の上限は余白で決まる。余白を詰めたぶん、はみ出した丸みは先に削る
      const cap = maxRadiusOf(v);
      if (state.style.radius > cap) state.style.radius = cap;
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

    // フレーム位置・種類・内容
    bindSeg('frame-pos-seg', 'pos', v => {
      const fr = state.style.frame;
      // 上を使う配置へ移るとき、上の文字がまだ無ければ下の文字から起こす。
      // qr-style.js は textTop が空だと text へ落とすので、空欄のまま見せると
      // 画面（空）と実際の絵（下の文字が上にも出る）が食い違う。
      if ((v === 'top' || v === 'both') && !fr.textTop) fr.textTop = fr.text || '';
      fr.pos = v;
      state.presetName = '';
      syncControls();
      update();
    });

    bindSeg('frame-content-mode-seg', 'mode', v => {
      state.style.frame.contentMode = v;
      state.style.frame.topContentMode = v;
      if (v === 'icon' && !state.style.frame.iconData) {
        const first = A.ICONS.find(i => i.group === (state.frameIconGroup || 'brand')) || A.ICONS[0];
        state.style.frame.icon = first.id;
        state.style.frame.iconData = first;
        state.style.frame.topIcon = first.id;
        state.style.frame.topIconData = first;
        buildFrameIconGrid();
      }
      state.presetName = '';
      syncControls();
      update();
    });

    const frameIconTabs = $('frame-icon-tabs');
    if (frameIconTabs) {
      Array.prototype.forEach.call(frameIconTabs.children, b => {
        b.addEventListener('click', () => {
          state.frameIconGroup = b.dataset.group;
          Array.prototype.forEach.call(frameIconTabs.children, t => setActive(t, t === b));
          buildFrameIconGrid();
          // 一覧を替えるとブランドカラーを出せるかどうかが変わる。
          // 色パネルを組み直さないと、ベーシックのアイコンに
          // 「ブランドカラー」が残ったままになる。
          syncControls();
          update();
        });
      });
    }

    bindSeg('frame-font-seg', 'font', v => {
      state.style.frame.font = v;
      state.presetName = '';
      update();
    });

    // いま描かれるほうの入れ物へ入れる。上下に出しているときは、この欄は下だけ。
    $('frame-text').addEventListener('input', e => {
      state.style.frame[frameTextKey()] = e.target.value;
      scheduleUpdate();
    });

    if ($('frame-text-top')) {
      $('frame-text-top').addEventListener('input', e => {
        state.style.frame.textTop = e.target.value;
        scheduleUpdate();
      });
    }

    Array.prototype.forEach.call($('icon-tabs').children, b => {
      b.addEventListener('click', () => {
        state.iconGroup = b.dataset.group;
        Array.prototype.forEach.call($('icon-tabs').children, x => setActive(x, x === b));
        buildIconGrid();
        syncControls();
        saveNow();
      });
    });

    // ---- ロゴ画像 ----
    wireImageDrop('logo-drop', 'logo-file', IMAGE_TARGETS.logo);
    wireImageClear('btn-logo-clear', 'logo-file', () => {
      state.style.logo.src = '';
      state.style.logo.type = 'none';
    });

    // ---- フレーム画像 ----
    wireImageDrop('frame-image-drop', 'frame-image-file', IMAGE_TARGETS.frame);
    wireImageClear('btn-frame-image-clear', 'frame-image-file', () => {
      state.style.frame.src = '';
      state.style.frame.topSrc = '';
    });

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

    // ---- マイテンプレート ----
    const saveName = $('my-save-name');
    const btnSaveOk = $('btn-design-save-ok');
    if (btnSaveOk) btnSaveOk.addEventListener('click', () => {
      if (saveMyDesign(saveName ? saveName.value : '')) closeSaveRow();
    });
    const btnSaveCancel = $('btn-design-save-cancel');
    if (btnSaveCancel) btnSaveCancel.addEventListener('click', closeSaveRow);
    if (saveName) saveName.addEventListener('keydown', e => {
      if (e.isComposing || e.keyCode === 229) return;   // 変換中の Enter は確定
      if (e.key === 'Enter') { e.preventDefault(); if (saveMyDesign(saveName.value)) closeSaveRow(); }
      if (e.key === 'Escape') { e.preventDefault(); closeSaveRow(); }
    });

    const btnDesignShare = $('btn-design-share');
    if (btnDesignShare) btnDesignShare.addEventListener('click', shareDesign);

    const btnForget = $('btn-forget');
    if (btnForget) btnForget.addEventListener('click', forgetDevice);

    // 補足はふだん畳んでおく。ⓘ を押した人にだけ出す
    [['btn-ec-help', 'ec-help'],
     ['btn-share-help', 'share-help'],
     ['btn-forget-help', 'forget-help']].forEach(([btnId, noteId]) => {
      const btn = $(btnId), note = $(noteId);
      if (!btn || !note) return;
      btn.addEventListener('click', () => {
        const closed = note.classList.toggle('hidden');
        btn.setAttribute('aria-expanded', closed ? 'false' : 'true');
      });
    });

    // 色パネルはテンプレートから何枚も起こすので、こちらは id ではなく「同じ入れ物の中で
    // data-note を引く」形にする。押した ⓘ と同じパネルの注記だけが開く。
    document.addEventListener('click', (e) => {
      const btn = e.target.closest && e.target.closest('.info-btn[data-note-toggle]');
      if (!btn) return;
      const scope = btn.closest('[data-cid], .sec-body') || document;
      const note = scope.querySelector('[data-note="' + btn.dataset.noteToggle + '"]');
      if (!note) return;
      const closed = note.classList.toggle('hidden');
      btn.setAttribute('aria-expanded', closed ? 'false' : 'true');
    });

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

    // 1度目で設定を開き、同じボタンをもう一度押せばそのまま保存する。
    // 引き出しの中にも保存ボタンがあるので、どちらからでも進める。
    function toggleCompress(fmt) {
      if (compressFor === fmt) { exportRaster(COMPRESS_MIME[fmt], fmt); return; }
      openCompress(fmt);
    }

    $('btn-png').addEventListener('click', () => exportRaster('image/png', 'png'));
    $('btn-avif').addEventListener('click', () => toggleCompress('avif'));
    $('btn-webp').addEventListener('click', () => toggleCompress('webp'));
    const btnCompressSave = $('btn-compress-save');
    if (btnCompressSave) btnCompressSave.addEventListener('click', () => {
      if (compressFor) exportRaster(COMPRESS_MIME[compressFor], compressFor);
    });
    const btnCompressClose = $('btn-compress-close');
    if (btnCompressClose) btnCompressClose.addEventListener('click', closeCompress);
    const btnBulkHelp = $('btn-bulk-help');
    if (btnBulkHelp) btnBulkHelp.addEventListener('click', openCsvHelp);
    $('btn-svg').addEventListener('click', exportSvg);
    $('btn-copy').addEventListener('click', copyImage);

    // 重いデコーダ（zxing-wasm と OpenCV）はここで初めて取りに行く。
    // 一度読めば以後の自動チェックにも加わる。
    $('btn-verify').addEventListener('click', () => {
      if (lastSvg && lastPayload) verify(lastSvg, lastPayload, true);
    });

    // フルスクリーン（ライトボックス）
    const btnFsClose = $('btn-fullscreen-close');
    if (btnFsClose) btnFsClose.addEventListener('click', closeFullscreen);
    const fsModal = $('fullscreen-modal');
    if (fsModal) {
      fsModal.addEventListener('click', e => {
        if (e.target === fsModal || e.target.classList.contains('fullscreen-modal-backdrop')) {
          closeFullscreen();
        }
      });
    }
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeFullscreen();
    });

    // ---- 履歴操作（Undo / Redo） ----
    const btnUndo = $('btn-undo');
    if (btnUndo) btnUndo.addEventListener('click', undo);
    const btnRedo = $('btn-redo');
    if (btnRedo) btnRedo.addEventListener('click', redo);

    window.addEventListener('keydown', e => {
      if (e.isComposing || e.keyCode === 229) return;
      const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod) return;

      const target = e.target;
      const isTextInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
      const isContentField = isTextInput && target.id && target.id.startsWith('f-');

      if (e.key === 'z' || e.key === 'Z') {
        if (e.shiftKey) {
          if (isContentField) return;
          e.preventDefault();
          redo();
        } else {
          if (isContentField) return;
          e.preventDefault();
          undo();
        }
      } else if (e.key === 'y' || e.key === 'Y') {
        if (isContentField) return;
        e.preventDefault();
        redo();
      }
    });

    // モバイル用フローティングミニプレビュー
    setupFloatPreview();

    // 保存はまとめて後回しにしているので、離れる前に取りこぼしを書き切る
    window.addEventListener('pagehide', saveNow);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') saveNow();
    });
  }

  function setupFloatPreview() {
    const card = $('canvas-card');
    const floatEl = $('float-preview');
    if (!card || !floatEl) return;

    floatEl.addEventListener('click', openFullscreen);
    floatEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openFullscreen();
      }
    });

    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver(entries => {
        entries.forEach(entry => {
          floatEl.classList.toggle('visible', !entry.isIntersecting);
        });
      }, { threshold: 0.1 });
      observer.observe(card);
    }
  }

  const TARGET_LABELS = {
    cell: 'セル',
    bg: '背景',
    frame: 'マーカーの枠',
    eye: 'マーカーの目',
    logoicon: 'ロゴのアイコン',
    logotext: 'ロゴの文字',
    logobd: 'ロゴの下地',
    frameborder: '枠線',
    framelabel: '帯',
    frametext: 'ラベルの文字',
    frameicon: 'ラベルのアイコン',
    framebd: 'ラベルの下地'
  };

  function getTargetLabel() {
    return TARGET_LABELS[scopeTarget(state.colorScope)] || '背景';
  }

  // 画像の受け口。入り口の検査と後始末は共通で、違うのは「どこに入れるか」
  // だけなので、行き先ごとに apply と label を持たせる。
  const IMAGE_TARGETS = {
    logo: {
      label: () => 'ロゴ画像',
      apply: src => {
        state.style.logo.src = src;
        state.style.logo.type = 'image';
      }
    },
    frame: {
      label: () => 'フレーム画像',
      apply: src => {
        state.style.frame.src = src;
        state.style.frame.topSrc = src;
        state.style.frame.contentMode = 'image';
        state.style.frame.topContentMode = 'image';
      }
    },
    // いま触っている色パネルの塗り
    target: {
      label: () => getTargetLabel() + '画像',
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

    // 振った値どうしの噛み合わせ（角丸は余白より大きくできない、など）は
    // ここで均す。振る側が上限を知っていなくてよくなる
    sanitizeStyle(state.style);

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
      setActive(b, b.dataset.group === state.iconGroup);
    });

    buildTypeChips();
    buildTypeFields();
    buildPresetCategoryChips();
    buildPresets();
    buildShapeGrids();
    buildColorPanels();
    buildIconGrid();
    buildFrameIconGrid();
    buildFrameChips();
    syncControls();
    wire();
    wireBulk();
    // HTML に直接書かれたボタン（色パネルのテンプレート由来を含む）の
    // 選択状態を aria にも写す。以後は setActive が保つ。
    seedAriaPressed(document);
    // 色パネルはテンプレートから起こすので、最初の createIcons に間に合わない。
    // 中の ⓘ を描くためにもう一度だけ回す。
    if (window.lucide) lucide.createIcons();
    update();
    initHistory();
    // 共有リンクのデザインは、ふつうの起動が済んでから被せる。
    // 復号を待つあいだ画面が空のままになるのを避ける。
    consumeDesignLink();
    // すでにこのページを開いている人が共有リンクを踏むと、ブラウザは
    // 同じ文書のまま # だけ差し替える（読み込み直しは起きない）。
    // それだと何も起きないので、こちらでも拾う。
    window.addEventListener('hashchange', consumeDesignLink);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
