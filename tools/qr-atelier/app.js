/* QR Atelier — 画面まわり
 *
 * qr-core.js（符号化）と qr-style.js（描画）をつなぎ、入力・デザイン操作・
 * 書き出しを受け持つ。
 *
 * 入力した内容そのものは、符号化から検査・書き出しまで一度も外へ出ない。
 * フォント・デコーダ・エンコーダ・アイコンは同梱してあり、外とやりとりするのは
 * ページの計測だけ（入力には触れない）。
 */
(function () {
  'use strict';

  const { showToast, setStatus, setupDropzone, saveBlob } = window.STCommon;
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

  // Wi-Fi・vCard・MeCard は区切り記号をエスケープしないと読み取り側が誤解する。
  // 形式ごとに違うのは「どの記号を逃がすか」と「改行を何に置き換えるか」だけ。
  //   newline … 改行の置き換え先（undefined なら改行もそのまま通す）
  function escapeWith(special, newline) {
    return v => {
      let out = '';
      const s = String(v || '');
      for (let i = 0; i < s.length; i++) {
        const ch = s.charAt(i);
        const code = s.charCodeAt(i);
        if (newline !== undefined && (code === 10 || code === 13)) { out += newline; continue; }
        out += special.indexOf(ch) >= 0 ? BACKSLASH + ch : ch;
      }
      return out;
    };
  }

  const wifiEscape = escapeWith([BACKSLASH, ';', ',', '"', ':']);
  const vcardEscape = escapeWith([BACKSLASH, ';', ','], BACKSLASH + 'n');
  // MeCard は区切りが ; と : で、姓名の区切りに , まで使う。vCard とは
  // 顔ぶれが違うので別に持つ。
  const mecardEscape = escapeWith([BACKSLASH, ';', ':', ','], ' ');

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
        const raw = String(f.id || '').trim().replace(/^@/, '');
        if (!raw) return '';
        // 空白や / ? # が混ざっても URL の別の部分にならないよう符号化する。
        // @ だけは YouTube の「@ハンドル」で使うので戻す。
        const id = encodeURIComponent(raw).replace(/%40/g, '@');
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
          default: return normalizeUrl(raw);
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
        // 区切りは T のほか空白も通す。表計算で日付を選ぶと
        // 「2026/11/05 10:30」の形で来るので、T だけを見ていると
        // 予定の時刻が丸ごと落ちる。時刻なしの日付だけも 0時として通す。
        const fmtDt = val => {
          const parts = String(val || '').trim().split(/[T ]+/);
          const date = (parts[0] || '').replace(/[^0-9]/g, '');
          const time = (parts[1] || '').replace(/[^0-9]/g, '');
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
        const amt = bitcoinAmount(f.amount);
        if (amt) q.push('amount=' + amt);
        if (f.label) q.push('label=' + encodeURIComponent(String(f.label).trim()));
        return 'bitcoin:' + addr + (q.length ? '?' + q.join('&') : '');
      }
    }
  ];

  // BIP-21 の amount は指数表記ではなく、小数点以下8桁までの10進数で渡す。
  // Number を通すと 1 satoshi が 1e-8 になり、ウォレットによっては解釈されない。
  function bitcoinAmount(value) {
    let s = String(value == null ? '' : value).trim();
    if (!s || !/^(?:\d+(?:\.\d{1,8})?|\.\d{1,8})$/.test(s)) return '';
    if (s.charAt(0) === '.') s = '0' + s;
    const parts = s.split('.');
    const whole = parts[0].replace(/^0+(?=\d)/, '');
    const frac = (parts[1] || '').replace(/0+$/, '');
    if (whole === '0' && !frac) return '';
    return whole + (frac ? '.' + frac : '');
  }

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

  // 保存・復元・undo/redo が持ち回る、style 以外の状態キー。type / values / style は
  // 形が特別なので、それぞれの関数が個別に見る。
  //
  // 一覧を1か所にしておかないと、キーを足したときに getSnapshot には入れたのに
  // applySnapshot へ書き忘れる、といったことが起きる。そうなると undo だけが
  // その項目を戻さないのに、画面上は何も壊れていないように見えてしまう。
  //
  // colorScope と previewChecker はここに入れない。どちらも「いまどこを見ているか」
  // という画面の都合で、作った絵の一部ではないので、undo で巻き戻すとかえって驚く。
  const SNAPSHOT_KEYS = ['ec', 'minVersion', 'exportSize', 'sizeUnit', 'printMm', 'printDpi',
    'lossless', 'quality', 'effort', 'presetName', 'presetCategory', 'iconGroup', 'frameIconGroup'];

  // 色パネルごとの違いはここだけに置く。対象一覧・塗りの場所・使える特殊色・
  // 画像を外したときの戻り先・表示名を別々に持つと、追加時に必ずどれかが漏れる。
  const COLOR_SCOPE_META = {
    cell:        { paint: s => s.fg,                kind: 'basic', clearType: 'solid', label: 'セル' },
    bg:          { paint: s => s.bg,                kind: 'plate', clearType: 'white', label: '背景' },
    frame:       { paint: s => s.markerFramePaint,  kind: 'auto',  clearType: 'auto',  label: 'マーカーの枠' },
    eye:         { paint: s => s.markerEyePaint,    kind: 'auto',  clearType: 'auto',  label: 'マーカーの目' },
    logoicon:    { paint: s => s.logo.paint,        kind: 'brand', clearType: 'brand', label: 'ロゴのアイコン' },
    logotext:    { paint: s => s.logo.textPaint,    kind: 'auto',  clearType: 'auto',  label: 'ロゴの文字' },
    logobd:      { paint: s => s.logo.backdropPaint, kind: 'plate', clearType: 'white', label: 'ロゴの下地' },
    frameborder: { paint: s => s.frame.paint,       kind: 'auto',  clearType: 'auto',  label: '枠線' },
    framelabel:  { paint: s => s.frame.paint,       kind: 'auto',  clearType: 'auto',  label: '帯' },
    // 文字は既定どおり単色（白）へ戻す。帯は既定で「セルの色」なので、文字まで
    // 'auto' に戻すと帯と同じ色になって読めなくなる
    frametext:   { paint: s => s.frame.textPaint,   kind: 'auto',  clearType: 'solid', label: 'ラベルの文字' },
    frameicon:   { paint: s => s.frame.iconPaint,   kind: 'brand', clearType: 'brand', label: 'ラベルのアイコン' },
    framebd:     { paint: s => s.frame.backdropPaint, kind: 'plate', clearType: 'none', label: 'ラベルの下地' }
  };
  const COLOR_SCOPES = Object.keys(COLOR_SCOPE_META);

  // 画像の塗りの倍率（描画エンジンと同じ範囲。UI では % で見せる）。
  // QRStyle は 16行目で無ガードに読んでいるので、ここに来た時点で必ずある。
  const IMG_SCALE_MIN = window.QRStyle.IMG_SCALE_MIN;
  const IMG_SCALE_MAX = window.QRStyle.IMG_SCALE_MAX;

  function imgScalePct(p) {
    const v = clampNum(p && p.imgScale, IMG_SCALE_MIN, IMG_SCALE_MAX, 1);
    return Math.round(v * 100);
  }

  // 画像モードのときだけ出す拡大・縮小スライダー
  function syncImageScaleRow(row, input, label, paint, visible) {
    const scale = imgScalePct(paint);
    showIf(row, visible);
    setRange(input, label, scale, scale + '%');
  }

  function paintOf(scope) {
    const meta = COLOR_SCOPE_META[scope];
    return meta ? meta.paint(state.style) : state.style.fg;
  }

  // プレビューへの画像ドロップなど、パネル外から「いま触っている色」を指す用
  function getActivePaint() { return paintOf(state.colorScope); }

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

  const STORE_KEY = 'qr-atelier-v1';

  // 受け付ける画像ファイルの上限。
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

  // 覚えるには重すぎる画像の場所。本体の保存もマイテンプレートも同じ線を引く。
  function oversizedImageSlots(s) {
    return storedImageSlots(s).filter(slot => {
      const v = slot[0] && slot[0][slot[1]];
      return typeof v === 'string' && v.length > MAX_STORED_SRC;
    });
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
      oversizedImageSlots(state.style).forEach(slot => {
        drop.add(slot[0][slot[1]]);
        if (slot[0] === state.style.logo && slot[1] === 'src') logoDropped = true;
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

  // 待っている書き込みを、書かずに捨てる（消したあとに書き戻させない）
  function cancelPendingSave() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  }

  function saveNow() {
    cancelPendingSave();
    save();
  }

  function restore() {
    let raw = null;
    try { raw = localStorage.getItem(STORE_KEY); } catch (e) { return; }
    if (!raw) return;
    try {
      const saved = JSON.parse(raw);
      if (saved.type && TYPES.some(t => t.id === saved.type)) state.type = saved.type;
      if (saved.values) Object.keys(state.values).forEach(k => {
        // 文字列が来ると Object.assign が1文字ずつ '0','1'… のキーに展開する
        const v = saved.values[k];
        if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(state.values[k], v);
      });
      SNAPSHOT_KEYS.forEach(k => {
        if (saved[k] !== undefined) state[k] = saved[k];
      });
      // 市松模様は履歴には乗せないが、保存はする（次に開いたときも同じ見え方にしたい）
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
      // 知らない形の id や iconData の引き直しは sanitizeStyle が無条件でやる
      // （保存されたオブジェクトは信用せず、id から毎回引く）ので、ここでは触らない。
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

  // 画像（Data URLなど巨大な文字列）の重複保持を防ぐメモリ上の参照プール。
  // 50世代のスナップショットが同じ画像を参照していても、実体は1つだけ保持する。
  const historyImagePool = new Map();
  const historyImageRevPool = new Map();
  let historyImageSeq = 0;

  function internHistoryImage(src) {
    if (!src || typeof src !== 'string' || src.length < 100) return src;
    let id = historyImageRevPool.get(src);
    if (!id) {
      id = '__img_ref_' + (++historyImageSeq) + '__';
      historyImagePool.set(id, src);
      historyImageRevPool.set(src, id);
    }
    return id;
  }

  function resolveHistoryImage(val) {
    return typeof val === 'string' && historyImagePool.has(val) ? historyImagePool.get(val) : val;
  }

  function cleanHistoryImagePool() {
    const activeRefs = new Set();
    const scan = str => {
      if (!str) return;
      const matches = str.match(/__img_ref_\d+__/g);
      if (matches) matches.forEach(m => activeRefs.add(m));
    };
    undoStack.forEach(scan);
    redoStack.forEach(scan);
    scan(lastCommittedSnapshot);

    for (const [id, src] of historyImagePool.entries()) {
      if (!activeRefs.has(id)) {
        historyImagePool.delete(id);
        historyImageRevPool.delete(src);
      }
    }
  }

  function getSnapshot() {
    const snap = { type: state.type, values: state.values, style: state.style };
    SNAPSHOT_KEYS.forEach(k => { snap[k] = state[k]; });
    return JSON.stringify(snap, function (k, v) {
      if (typeof v === 'string' && v.length >= 100 && (k === 'src' || k === 'topSrc' || v.indexOf('data:image/') === 0)) {
        return internHistoryImage(v);
      }
      return v;
    });
  }

  function commitHistory() {
    if (isApplyingHistory) return;
    const snap = getSnapshot();
    if (snap === lastCommittedSnapshot) return;
    if (lastCommittedSnapshot) {
      undoStack.push(lastCommittedSnapshot);
      if (undoStack.length > MAX_HISTORY) {
        undoStack.shift();
      }
      redoStack.length = 0;
      updateHistoryButtons();
    }
    lastCommittedSnapshot = snap;
    // Undo 後に別の編集を始めると Redo 側の画像参照は不要になる。
    // 新しいスナップショットを確定してから、孤立した巨大な Data URL を捨てる。
    cleanHistoryImagePool();
  }

  function cancelPendingHistory() {
    if (historyTimer) { clearTimeout(historyTimer); historyTimer = null; }
  }

  function recordHistorySoon(immediate) {
    if (isApplyingHistory) return;
    cancelPendingHistory();
    if (immediate) { commitHistory(); return; }
    historyTimer = setTimeout(() => {
      historyTimer = null;
      commitHistory();
    }, 400);
  }

  function updateHistoryButtons() {
    const btnUndo = $('btn-undo'), btnRedo = $('btn-redo');
    if (btnUndo) btnUndo.disabled = undoStack.length === 0;
    if (btnRedo) btnRedo.disabled = redoStack.length === 0;
  }

  function applySnapshot(snapStr) {
    if (!snapStr) return;
    let data;
    try {
      data = JSON.parse(snapStr, function (k, v) {
        return resolveHistoryImage(v);
      });
    } catch (e) {
      return;
    }

    isApplyingHistory = true;
    const prevPresetCategory = state.presetCategory;
    try {
      if (data.type && TYPES.some(t => t.id === data.type)) state.type = data.type;
      if (data.values) {
        Object.keys(data.values).forEach(k => {
          state.values[k] = Object.assign({}, data.values[k]);
        });
      }
      SNAPSHOT_KEYS.forEach(k => {
        if (data[k] !== undefined) state[k] = data[k];
      });
      state.lossless = state.lossless === true;
      if (data.style) {
        state.style = window.QRStyle.merge(window.QRStyle.DEFAULTS, data.style);
        sanitizeStyle(state.style);
      }

      lastCommittedSnapshot = getSnapshot();

      buildTypeChips();
      buildTypeFields();
      rebuildDesignUI();
      // 分類も履歴に乗っているので、見た目も戻す（アイコンのタブは rebuildDesignUI）
      if (state.presetCategory !== prevPresetCategory) {
        buildPresetCategoryChips();
        buildPresets();
      }
      update();
    } finally {
      isApplyingHistory = false;
    }
    updateHistoryButtons();
  }

  function undo() {
    // 待っている1手を先に確定させる（打ちかけの変更ごと戻す）
    if (historyTimer) recordHistorySoon(true);
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

  function resetHistory() {
    cancelPendingHistory();
    undoStack.length = 0;
    redoStack.length = 0;
    historyImagePool.clear();
    historyImageRevPool.clear();
    historyImageSeq = 0;
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

  // ラベルの中身（文字・アイコン・画像）
  const CONTENT_MODES = ['text', 'icon', 'image'];

  // 多色で持てる色の数
  const MAX_MULTI_COLORS = 8;

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
      p.colors = window.QRStyle.DEFAULTS.fg.colors.slice();
    } else {
      p.colors = p.colors.map(c => normHex(c, '#2563EB')).slice(0, MAX_MULTI_COLORS);
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
    s.frame.font = oneOf(s.frame.font, FONTS, 'sans');
    s.frame.contentMode = oneOf(s.frame.contentMode, CONTENT_MODES, 'text');
    s.frame.topContentMode = oneOf(s.frame.topContentMode, CONTENT_MODES, 'text');
    s.frame.pos = oneOf(s.frame.pos, ['bottom', 'top', 'both'], 'bottom');
    pickIcon(s.frame, 'icon', 'iconData', D.frame.icon);
    s.frame.iconPaint = sanitizePaint(s.frame.iconPaint, 'brand', 'brand', '#FFFFFF');
    s.frame.src = sanitizeImageUrl(s.frame.src);

    pickIcon(s.frame, 'topIcon', 'topIconData', D.frame.topIcon);
    s.frame.topSrc = sanitizeImageUrl(s.frame.topSrc);
    s.frame.textTop = String(s.frame.textTop || '');

    // 消えた種類（点線・太線＋細線）は近いものへ寄せる
    s.frame.line = window.QRStyle.lineIdOf(s.frame.line);
    const lineDef = window.QRStyle.LINE_STYLES[s.frame.line];
    s.frame.lineWidth = clampNum(s.frame.lineWidth, 0.15, 2.5, lineDef.stroke);
    s.frame.lineWidth2 = clampNum(s.frame.lineWidth2, 0.15, 2.5, lineDef.inner || 0.28);

    // ラベルの中身の下地。形は下地用の一覧から選ぶ
    if (!hasId(A.BACKDROP_SHAPES, s.frame.backdrop)) s.frame.backdrop = D.frame.backdrop;
    // 透過は sanitizePaint が埋める（下地は plate なので、未指定は 0＝不透明）
    s.frame.backdropPaint = sanitizePaint(s.frame.backdropPaint, 'plate', 'none', '#FFFFFF');

    s.bg = sanitizePaint(s.bg, 'plate', 'solid', '#FFFFFF');

    // ロゴの下地。形は下地用の一覧から選ぶ
    if (!hasId(A.BACKDROP_SHAPES, s.logo.backdrop)) s.logo.backdrop = D.logo.backdrop;
    s.logo.backdropPaint = sanitizePaint(s.logo.backdropPaint, 'plate', 'solid', '#FFFFFF');

    // ロゴ本体の塗り。ここだけ 'brand'（アイコンのブランド公式色）を選べる。
    // 画面では、ブランド以外のアイコン群を選んでいるときに syncControls が
    // 'auto' へ寄せるので、ここでは 'brand' をそのまま通してよい。
    s.logo.paint = sanitizePaint(s.logo.paint, 'brand', 'brand', D.logo.paint.color);
    s.logo.textPaint = sanitizePaint(s.logo.textPaint, 'auto', 'auto', D.logo.textPaint.color);
    pickIcon(s.logo, 'icon', 'iconData', D.logo.icon);

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
    s.logo.font = oneOf(s.logo.font, FONTS, 'sans');
    // 知らない種類だと、中央のセルを抜いたまま何も描かれない
    s.logo.type = oneOf(s.logo.type, ['none', 'icon', 'image', 'text'], 'none');
    s.logo.src = sanitizeImageUrl(s.logo.src);
    // ロゴの下のセルを抜くか。画面には出していないが、テンプレートや古い保存が
    // 落としてくることがあるので、真偽値には均しておく
    s.logo.knockout = s.logo.knockout !== false;
    s.invertOk = !!s.invertOk;
    // 形の id。知らないものは既定へ寄せる（一覧のどれも選ばれていない画面になるため）
    if (!hasId(A.CELL_SHAPES, s.cell)) s.cell = D.cell;
    s.markerFrame = window.QRStyle.markerFrameIdOf(s.markerFrame);
    if (!hasId(A.MARKER_FRAMES, s.markerFrame)) s.markerFrame = D.markerFrame;
    if (!hasId(A.MARKER_EYES, s.markerEye)) s.markerEye = D.markerEye;
    if (!hasId(A.FRAMES, s.frame.type)) s.frame.type = 'none';
  }

  // 同梱アイコンの id と実体（iconData）を組で決める。実体は保存・共有された
  // オブジェクトを信用せず、同梱一覧の id から毎回引き直す。無い id は既定へ寄せる。
  function pickIcon(owner, idKey, dataKey, fallbackId) {
    const icon = findById(A.ICONS, owner[idKey]) || findById(A.ICONS, fallbackId);
    owner[idKey] = icon ? icon.id : fallbackId;
    owner[dataKey] = icon;
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

  function clampNum(v, lo, hi, fallback) {
    const x = Number(v);
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : fallback;
  }

  // 一覧にない値は fallback に倒す
  function oneOf(v, list, fallback) {
    return list.indexOf(v) >= 0 ? v : fallback;
  }

  // QRAssets の一覧（{ id, name, … }）を id で引く
  function findById(list, id) {
    return list.find(x => x.id === id) || null;
  }

  function hasId(list, id) {
    return !!findById(list, id);
  }

  function nameOf(list, id, fallback) {
    const hit = findById(list, id);
    return hit ? hit.name : (fallback || '');
  }

  // 2桁に0埋め（日時の組み立て用）
  const pad2 = v => String(v).padStart(2, '0');

  // いまの日時を YYYYMMDD-HHMMSS に（ファイル名用）
  function stamp() {
    const d = new Date();
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
      '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
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

  // 色の分解は qr-style.js のものをそのまま借りる。二重に持つと、3桁表記や
  // # なしの扱いを片方だけ直したときに、画面と書き出しで色がずれる。
  const hexToRgb = window.QRStyle.hexToRgb;

  // セルの明るさ（0〜255）。複数色の塗りは平均で見る。
  // 明るさの式は qr-style.js の encodedLuma ひとつに寄せる。ここだけ別の
  // 係数で測っていると、同じ色を「明るい」と言ったり言わなかったりする。
  function getCellLuminance() {
    const fg = state.style.fg;
    const cols = fg.type === 'solid' ? [fg.color]
      : fg.type === 'multi' ? fg.colors
      : (fg.type === 'linear' || fg.type === 'radial') ? [fg.from, fg.mid, fg.to].filter(Boolean)
      : null;
    if (!cols) return 0;   // 画像などは絵柄しだいなので暗いほうに倒しておく
    const luma = window.QRStyle.encodedLuma;
    return cols.reduce((sum, c) => sum + luma(c), 0) / cols.length;
  }

  function updateCanvasChecker() {
    const card = $('canvas-card');
    if (!card) return;
    // 'auto': セルが明るい（輝度 >= 130）なら黒ベース市松、暗いなら白ベース市松
    const isDark = state.previewChecker === 'auto'
      ? getCellLuminance() >= 130
      : state.previewChecker === 'dark';
    card.classList.toggle('theme-dark', isDark);
    card.classList.toggle('theme-light', !isDark);

    eachSegButton('checker-toggle', btn => {
      setActive(btn, btn.dataset.checker === state.previewChecker);
    });
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
        // 種類ごとのタブが入ったブックなら、その種類のタブへ一緒に移る
        if (bulk.sheets.length > 1) {
          const at = bulkSheetForType(bulk.sheets, t.name);
          if (at >= 0 && at !== bulk.sheetAt) {
            bulkUseSheet(at);
            clearBulkPicked();
          }
        }
        bulkRefresh();
        update();
      });
      host.appendChild(b);
    });
  }

  // 見出しの脇に出す要約。形式を選べる種別（連絡先・暗号通貨）は、選んだ
  // ものによって変わるので関数でも書けるようにしてある。
  function syncContentHint() {
    const type = currentType();
    const h = typeof type.hint === 'function' ? type.hint(state.values[type.id]) : type.hint;
    $('hint-content').textContent = h;
  }

  // パスワード欄の表示切り替えボタンのアイコン（lucide の eye / eye-off）
  const EYE_SVG_HEAD = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';
  const EYE_ICON = EYE_SVG_HEAD + '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF_ICON = EYE_SVG_HEAD + '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>';

  function buildTypeFields() {
    const type = currentType();
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
        toggleBtn.innerHTML = EYE_ICON;
        toggleBtn.addEventListener('click', () => {
          const isPwd = input.type === 'password';
          input.type = isPwd ? 'text' : 'password';
          toggleBtn.innerHTML = isPwd ? EYE_OFF_ICON : EYE_ICON;
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
        // SNS の選択肢の id と、同梱アイコンの id は 'si-' を足すだけで対応する。
        // 表で持つと、選択肢を足したときに片方だけ書き忘れて黙って効かなくなる。
        // アイコンが無い相手はここで弾かれるので、増やすのは選択肢だけでよい。
        const platform = values.platform;
        const icon = findById(A.ICONS, 'si-' + platform);
        if (icon) {
          setLogoIcon(icon);
          designChanged();
          showToast('中央ロゴに ' + platform + ' を設定しました');
        }
      });
      pairs.push(btnLogoSync);
    }

    // 連絡先やカレンダーは項目が多いので2列に畳む
    const twoCol = type.id === 'vcard' || type.id === 'geo' || type.id === 'event';
    const box = el('div', { class: twoCol ? 'grid2' : 'cols' });
    pairs.forEach(p => box.appendChild(p));
    host.appendChild(box);
  }

  function payload() {
    const type = currentType();
    return type.build(state.values[type.id]);
  }

  // 「内容」でいま選んでいる種類。一括生成もこの種類の組み立てをそのまま使う。
  function currentType() {
    return findById(TYPES, state.type) || TYPES[0];
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
    setText('hint-preset', state.presetName || 'カスタム');
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

  // テンプレートの札。見本と名前までは同梱ぶんもマイテンプレートも同じで、
  // 押したときの振る舞いだけが違う。「いま選ばれているか」の印は
  // buildPresets の最後に syncPresetActive がまとめて付ける。
  function tileButton(name, style, onPick) {
    const btn = el('button', { class: 'preset-btn', type: 'button', title: name });
    btn.dataset.presetName = name;
    btn.appendChild(presetThumb(style));
    btn.appendChild(el('i', null, name));
    btn.addEventListener('click', onPick);
    return btn;
  }

  // はじめから入っているテンプレート
  function presetTile(p) {
    // セルの密度は style ではなく state 側。テンプレートは基本「自動」に戻す。
    return tileButton(p.name, p.style,
      () => applyStyle(p.style, p.name, { minVersion: p.minVersion || 1, keepLogo: true }));
  }

  // 自分で足したテンプレート。消せるように×を重ねる
  function myTile(d) {
    const tile = el('div', { class: 'my-tile' });
    const btn = tileButton(d.name, d.style, () => {
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
    showIf('my-foot', isMine);
    showIf('my-design-empty', isMine && !mine.length);

    syncPresetActive();
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
    state.presetCategory = 'all';
    state.ec = 'H';

    closeSaveRow();
    buildTypeChips();
    buildTypeFields();
    buildPresetCategoryChips();
    buildPresets();
    // 見た目は「デザインを初期化」と同じ入口で既定へ戻す（組み直しと描き直しまで）
    applyStyle({}, '', { minVersion: 1 });

    // update() が予約した履歴と書き戻しを取り消す。Undo/Redo や画像プールに
    // 消す前の入力が残ると、この画面だけで復元できてしまう。
    resetHistory();
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
    showIf('my-save-row', false);
  }

  function syncShapeGridActive(hostId, currentId) {
    eachSegButton(hostId, btn => setActive(btn, btn.dataset.id === currentId));
  }

  // 「セル枠」はセルの形と太さをそのまま使うので、見本もそれを渡して起こす
  function markerPreviewOpts() {
    return { cell: state.style.cell, cellScale: state.style.cellScale };
  }

  function updateFrameGridPreviews() {
    const opts = markerPreviewOpts();
    eachSegButton('frame-grid', btn => {
      const id = btn.dataset.id;
      const holder = btn.querySelector('.preview-holder');
      if (holder && id) {
        holder.innerHTML = window.QRStyle.markerPreview(id, state.style.markerEye, opts);
      }
    });
  }

  // 選んでいるセルの形の名前を説明文のところに出す。一覧を組み直したときも、
  // 選び直しただけのときも同じものを出したいので、1か所に置く。
  function syncShapeHint() {
    setText('hint-shape', nameOf(A.CELL_SHAPES, state.style.cell));
  }

  function syncShapeActive() {
    updateFrameGridPreviews();
    syncShapeGridActive('cell-grid', state.style.cell);
    syncShapeGridActive('frame-grid', state.style.markerFrame);
    syncShapeGridActive('logo-backdrop-grid', state.style.logo.backdrop);
    syncShapeGridActive('frame-backdrop-grid', state.style.frame && state.style.frame.backdrop);
    syncShapeGridActive('frame-line-grid', state.style.frame && state.style.frame.line);
    syncShapeGridActive('eye-grid', state.style.markerEye);
    syncShapeHint();
  }

  // 形を選ぶ一覧（セル・マーカー枠・下地・枠線・マーカー目）。
  // どれも「見本を敷いたボタンを並べて、押されたら state を書いて描き直す」だけで、
  // 違うのは一覧と見本の起こし方と state の書き方に限られる。選択の印や、ほかの
  // 一覧の見本（マーカー枠は目とセルの形を映す）は designChanged が合わせ直す。
  //   items   … { id, name } の一覧
  //   current … いま選ばれている id を返す関数（描き直すたびに引き直す）
  //   preview … id から見本の SVG を起こす関数
  //   pick    … 押されたときに state を書く関数
  function buildShapeGrid(hostId, items, current, preview, pick) {
    const host = $(hostId);
    if (!host) return;
    host.innerHTML = '';
    const cur = current();
    items.forEach(s => {
      const b = el('button', { class: 'shape-btn', type: 'button', title: s.name });
      setActive(b, cur === s.id);
      b.dataset.id = s.id;
      const holder = el('div', { class: 'preview-holder' });
      holder.innerHTML = preview(s.id);
      b.appendChild(holder);
      b.appendChild(el('i', null, s.name));
      b.addEventListener('click', () => {
        pick(s.id);
        designChanged();
      });
      host.appendChild(b);
    });
  }

  function buildShapeGrids() {
    const S = window.QRStyle;

    buildShapeGrid('cell-grid', A.CELL_SHAPES,
      () => state.style.cell, S.cellPreview,
      id => { state.style.cell = id; });

    buildShapeGrid('frame-grid', A.MARKER_FRAMES,
      () => state.style.markerFrame,
      id => S.markerPreview(id, state.style.markerEye, markerPreviewOpts()),
      id => { state.style.markerFrame = id; });

    // ロゴの下地とラベルの下地は同じ形の一覧から選ぶ
    buildShapeGrid('logo-backdrop-grid', A.BACKDROP_SHAPES,
      () => state.style.logo.backdrop, S.backdropPreview,
      id => { state.style.logo.backdrop = id; });

    buildShapeGrid('frame-backdrop-grid', A.BACKDROP_SHAPES,
      () => state.style.frame.backdrop, S.backdropPreview,
      id => { state.style.frame.backdrop = id; });

    // 枠線の種類。見本は本番と同じ描画コードから起こす
    buildShapeGrid('frame-line-grid', A.FRAME_LINES,
      () => state.style.frame.line, S.linePreview,
      id => {
        const ls = S.LINE_STYLES[id] || {};
        state.style.frame.line = id;
        state.style.frame.lineWidth = ls.stroke;
        state.style.frame.lineWidth2 = ls.inner || 0.28;
        // 見出しの脇の要約（「枠線」ではなく線の種類名）を描き直す
        buildFrameChips();
      });

    buildShapeGrid('eye-grid', A.MARKER_EYES,
      () => state.style.markerEye, S.eyePreview,
      id => { state.style.markerEye = id; });

    syncShapeHint();
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

  // 色を足し引きするボタン。見た目（.hidden）だけでなく hidden と disabled も
  // 揃えて、隠れているあいだはキーボードからも押せないようにする。
  function showButton(btn, on) {
    if (!btn) return;
    btn.classList.toggle('hidden', !on);
    btn.hidden = !on;
    btn.disabled = !on;
  }

  // 多色・グラデーションの色の1行（見本・カラーコード・削除ボタン）。
  // 見本だけでなくカラーコードを押しても色を選べるように、<label> で包む。
  // ラベルはクリックを中の input へ渡すので、こちらで転送を書く必要はない。
  //   label       … 見本の読み上げ名。削除ボタンは removeLabel（省略時は label）＋「を削除」
  //   role        … 見本の脇に出す役割（グラデーションの開始・中間・終了）
  //   onColor(hex) … 色が動いたときに state へ書く
  //   onRemove    … 削除したときに state を書く。null なら押せない
  function colorRow(o) {
    const hex = normHex(o.value, '#000000');
    const item = el('div', { class: 'multi-color-item' });
    const hit = el('label', { class: 'mc-hit' });
    const picker = el('input', { type: 'color', value: hex, 'aria-label': o.label });
    const hexSpan = el('span', { class: 'color-hex' }, hex);
    const removeText = (o.removeLabel || o.label) + 'を削除';
    const removeBtn = el('button', {
      class: 'btn-remove-color', type: 'button', title: removeText, 'aria-label': removeText
    }, '×');
    removeBtn.disabled = !o.onRemove;

    // つまみを動かしているあいだは検査を待たせる。ここを素の update() に
    // すると、ドラッグ1コマごとにデコーダが起動して画面が固まる
    picker.addEventListener('input', () => {
      const v = picker.value.toUpperCase();
      hexSpan.textContent = v;
      o.onColor(v);
      designDragged();
    });
    picker.addEventListener('change', verifyOnCommit);
    if (o.onRemove) {
      removeBtn.addEventListener('click', () => { o.onRemove(); designChanged(); });
    }

    hit.appendChild(picker);
    if (o.role) {
      hit.appendChild(el('span', { class: 'color-hex', style: 'font-size:10px; color:var(--ink-3); margin-right:2px;' }, o.role));
    }
    hit.appendChild(hexSpan);
    item.appendChild(hit);
    item.appendChild(removeBtn);
    return item;
  }

  function renderMultiColorsList(host, p, addBtn) {
    if (!host) return;
    host.innerHTML = '';
    const colors = p.colors;
    colors.forEach((c, idx) => host.appendChild(colorRow({
      value: c, label: '色 ' + (idx + 1), removeLabel: 'この色',
      onColor: v => { colors[idx] = v; },
      onRemove: colors.length > 2 ? () => { colors.splice(idx, 1); } : null
    })));
    showButton(addBtn, colors.length < MAX_MULTI_COLORS);
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
        designChanged();
      });
      host.appendChild(btn);
    });
  }

  const GRAD_ROLES = { from: '開始', mid: '中間', to: '終了' };

  function renderGradColorsList(host, p, addBtn) {
    if (!host) return;
    host.innerHTML = '';
    const hasMid = !!p.mid;
    (hasMid ? ['from', 'mid', 'to'] : ['from', 'to']).forEach(key => host.appendChild(colorRow({
      value: p[key], label: GRAD_ROLES[key] + '色', role: GRAD_ROLES[key],
      onColor: v => { p[key] = v; },
      // 端の色を消したら、中間の色がその端へ繰り上がる
      onRemove: hasMid ? () => { if (key !== 'mid') p[key] = p.mid; p.mid = ''; } : null
    })));
    showButton(addBtn, !hasMid);
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
        designChanged();
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
          designChanged();
        });
        row.appendChild(b);
      });
      g.appendChild(row);
      host.appendChild(g);
    });
  }

  // 汎用スコープ（セル・マーカー・背景）
  function buildMultiColorsList(scope) {
    renderMultiColorsList(cq(scope, 'multi-colors-list'), paintOf(scope), cq(scope, 'btn-add-color'));
  }

  function buildMultiPalettes(scope) {
    renderMultiPalettes(cq(scope, 'multi-palette-grid'), () => paintOf(scope), () => { state.colorScope = scope; });
  }

  function buildGradColorsList(scope) {
    renderGradColorsList(cq(scope, 'grad-colors-list'), paintOf(scope), cq(scope, 'btn-add-grad-color'));
  }

  function buildSwatches(scope) {
    renderSwatches(cq(scope, 'swatch-host'), c => {
      state.colorScope = scope;
      const p = paintOf(scope);
      if (p.type === 'solid') {
        p.color = c;
      } else if (p.type === 'multi') {
        if (p.colors.indexOf(c) < 0 && p.colors.length < MAX_MULTI_COLORS) p.colors.push(c);
        else p.colors[p.colors.length - 1] = c;
      } else {
        if (!p.mid) p.mid = c;
        else p.to = c;
      }
    });
  }

  function buildGradients(scope) {
    renderGradients(cq(scope, 'grad-grid'), () => paintOf(scope), () => { state.colorScope = scope; });
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
        designChanged();   // 選択の印も syncControls が付け直す
      });
      host.appendChild(b);
    });
  }

  // ロゴ・ラベルのアイコンを差し替える。id と実体（iconData）は必ず組で書く。
  function setLogoIcon(icon) {
    const lg = state.style.logo;
    lg.type = 'icon';
    lg.icon = icon.id;
    lg.iconData = icon;
  }

  // ラベルは上下で別々に持てるが、アイコンを選ぶ欄はひとつなので両方へ入れる。
  function setFrameIcon(icon) {
    const fr = state.style.frame;
    fr.icon = fr.topIcon = icon.id;
    fr.iconData = fr.topIconData = icon;
    fr.contentMode = fr.topContentMode = 'icon';
  }

  // ラベルのアイコンの一覧で選ばれているもの。「上」だけに出すときは上の指定、
  // それ以外（下・上下）は下の指定を見せる（ほかの欄と同じ決め方）
  function shownFrameIcon() {
    const fr = state.style.frame;
    return fr.pos === 'top' ? fr.topIcon : fr.icon;
  }

  function buildIconGrid() {
    renderIconGrid($('icon-grid'), state.iconGroup, state.style.logo.icon, 'grid_', setLogoIcon);
  }

  function buildFrameIconGrid() {
    renderIconGrid($('frame-icon-grid'), state.frameIconGroup, shownFrameIcon(),
      'frame_icon_grid_', setFrameIcon);
  }

  function buildFrameChips() {
    const host = $('frame-chips');
    host.innerHTML = '';
    A.FRAMES.forEach(f => {
      const b = el('button', { class: 'chip', type: 'button' }, f.name);
      setActive(b, state.style.frame.type === f.id);
      b.addEventListener('click', () => {
        state.style.frame.type = f.id;
        buildFrameChips();
        designChanged();
      });
      host.appendChild(b);
    });
    const frameName = nameOf(A.FRAMES, state.style.frame.type, 'なし');
    const lineName = nameOf(A.FRAME_LINES, state.style.frame.line);
    setText('hint-frame', state.style.frame.type === 'line' && lineName ? lineName : frameName);
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
    const slots = oversizedImageSlots(st);
    slots.forEach(slot => { slot[0][slot[1]] = ''; });
    return slots.length > 0;
  }

  // 画像をすべて外す（リンクに載せるとき用）。落としたあとは、その画像が
  // 無いと描けない塗りの種類も戻しておかないと、空の絵になる。戻り先は
  // 色パネルで「外す」を押したときと同じ（COLOR_SCOPE_META.clearType）。
  function stripImages(st) {
    let dropped = false;
    COLOR_SCOPES.forEach(scope => {
      const meta = COLOR_SCOPE_META[scope];
      const owner = meta.paint(st);
      if (!owner) return;
      if (owner.src) { owner.src = ''; dropped = true; }
      if (owner.type === 'image') { owner.type = meta.clearType; dropped = true; }
    });
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
    return withoutIconData(state.style);
  }

  function withoutIconData(style) {
    const st = JSON.parse(JSON.stringify(style || {}));
    if (st.logo) delete st.logo.iconData;
    if (st.frame) {
      delete st.frame.iconData;
      delete st.frame.topIconData;
    }
    return st;
  }

  // 読み込んだデザインを画面に載せる。アイコンの実体は id から引き直す。
  // 見た目をまるごと差し替える唯一の入口。テンプレート・マイテンプレート・
  // 共有リンクのどれから来ても、ここを通して同じ後始末（値の均し・グリッドの
  // 組み直し・履歴への確定）をする。経路ごとに手で並べると、片方にだけ
  // buildIconGrid を書き忘れて一覧の選択が古いまま残る、といったズレが出る。
  //   opts.minVersion … セルの密度は style ではなく state 側なので別で受ける
  //   opts.keepLogo   … 渡された style がロゴに触れていないときだけ、
  //                     いま置いてある画像／文字ロゴを残す
  function applyStyle(styleIn, name, opts) {
    const o = opts || {};
    const incoming = withoutIconData(styleIn);

    // 残すなら、差し替える前に控えておく
    const cur = state.style.logo || {};
    const keepSrc = o.keepLogo && !incoming.logo && cur.type === 'image' ? cur.src : '';
    const keepText = o.keepLogo && !incoming.logo && cur.type === 'text' ? cur.text : '';

    // merge は入れ物を必ず写して返すので、DEFAULTS もテンプレートの定義も
    // 返り値経由では書き換わらない（写しを作ってから渡す必要はない）
    state.style = window.QRStyle.merge(window.QRStyle.DEFAULTS, incoming);

    // logo を書いたテンプレート（ミニマルなど）は「ロゴなし」まで含めて指定なので、
    // そちらを尊重する。触れていないときだけ、ユーザーの置きものを戻す。
    if (keepSrc) {
      state.style.logo.type = 'image';
      state.style.logo.src = keepSrc;
    } else if (keepText) {
      state.style.logo.type = 'text';
      state.style.logo.text = keepText;
    }

    // 範囲外の値や古い形のキーを均す。まるごと差し替える経路は
    // 復元・undo と同じように、ここを必ず通す
    sanitizeStyle(state.style);
    if (o.minVersion !== undefined) state.minVersion = o.minVersion;
    state.presetName = name || '';
    rebuildDesignUI();
    update({ immediateHistory: true });
  }

  // 見た目をまるごと差し替えたあと（テンプレート・undo・リセット・シャッフル・
  // 端末から消す）に、デザインの操作部品をすべて state に合わせ直す。
  // 経路ごとに手で並べると、どれか1つだけ組み直しが漏れる。
  function rebuildDesignUI() {
    syncControls();
    buildShapeGrids();
    buildIconGrid();
    buildFrameIconGrid();
    buildFrameChips();
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

  // セグメントやタブの子ボタンを順に触る。children は HTMLCollection なので
  // forEach を持たない。要素が無いページでは黙って何もしない。
  // 押したときに何をするかは呼び出し側ごとに違う（出力設定はテンプレート名を
  // 消してはいけない、など）ので、ここは回すところだけを引き受ける。
  function eachSegButton(host, fn) {
    const el = asEl(host);
    if (!el) return;
    Array.prototype.forEach.call(el.children, fn);
  }

  function setSeg(hostId, value, attr) {
    eachSegButton(hostId, b => setActive(b, b.dataset[attr] === value));
  }

  // 画面への書き込み口。id でも要素でも受け、要素が無いページでは黙って何もしない
  // （同じ要素を「あるか確かめる」「書く」で2回引かずに済むように）。
  function setVal(target, v) { const n = asEl(target); if (n) n.value = v; }
  function setText(target, t) { const n = asEl(target); if (n) n.textContent = t; }
  function showIf(target, on) { const n = asEl(target); if (n) n.classList.toggle('hidden', !on); }
  function setImgSrc(target, src) { const n = asEl(target); if (n && src) n.src = src; }

  // 補足の段落。色分け（ok / warn / err）は class で付ける
  function setNote(target, cls, text) {
    const n = asEl(target);
    if (!n) return;
    n.className = 'print-note' + (cls ? ' ' + cls : '');
    n.textContent = text;
  }

  // スライダーと、その横の値の表示
  function setRange(id, labelId, v, label) {
    setVal(id, v);
    setText(labelId, label);
  }

  const pct = v => Math.round(v * 100) + '%';

  // 色パネル1枚ぶんの表示を、その対象の塗りに合わせる
  function syncColorPanel(scope) {
    if (!colorPanel(scope)) return;
    const meta = COLOR_SCOPE_META[scope];
    const p = paintOf(scope);
    const isCell = scope === 'cell';
    const isBg = scope === 'bg';
    const isLogoBd = scope === 'logobd';
    const isFrameBd = scope === 'framebd';
    // 背景と下地は「敷く面」なので、白・黒・透明まで選べる
    const isPlate = meta.kind === 'plate';
    // ブランドカラーはアイコンにしか意味がない。さらに、汎用アイコンには
    // ブランド色そのものが無いので、「SNS・ブランド」の一覧を開いている
    // ときだけ出す。ロゴとラベルで別々の一覧を持っているので、対象ごとに見る。
    const iconGroupOf = { logoicon: state.iconGroup, frameicon: state.frameIconGroup };
    const showBrand = meta.kind === 'brand' && iconGroupOf[scope] === 'brand';

    [['btn-mode-white', isPlate], ['btn-mode-black', isPlate],
     ['btn-mode-none', isPlate], ['btn-mode-brand', showBrand],
     ['btn-mode-auto', !isCell]].forEach(pair => showButton(cq(scope, pair[0]), pair[1]));

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
      showIf(cq(scope, pair[0]), pair[1]);
    });

    // 一覧の中身は重いので、その塗り方を選んだときに一度だけ組み立てる
    if (isGrad) ensurePanelPart(scope, 'grad');
    if (isMulti) ensurePanelPart(scope, 'multi');

    const plateWord = isLogoBd ? 'ロゴの下地' : isFrameBd ? 'ラベルの下地' : '背景';
    const autoNotice = cq(scope, 'auto-notice');
    if (autoNotice) {
      autoNotice.innerHTML = isBg
        ? 'セルの色設定と連動します。<br>グラデーション・放射・画像・多色のテクスチャが指定の透明度で背景に反映されます。'
        : (scope === 'frame' || scope === 'eye')
          ? 'セルの色設定と連動します。<br>多色のときは、3つのマーカーに色が1つずつ振られます。'
          : 'セルの色設定と連動します。<br>グラデーション・放射・画像の時はセルと一体の連続したテクスチャとして描画されます。';
    }
    setText(cq(scope, 'white-notice'), plateWord + 'を不透明な白（#FFFFFF）に固定します。');
    setText(cq(scope, 'black-notice'), plateWord + 'を不透明な黒（#000000）に固定します。');
    const noneNotice = cq(scope, 'none-notice');
    if (noneNotice) {
      noneNotice.innerHTML = isLogoBd
        ? 'ロゴの下地を描きません。<br>セルを消す範囲（下地の形）はそのまま残るので、背景が抜けて見えます。'
        : isFrameBd
          ? 'ラベルの下地を描きません。<br>文字やアイコンだけがフレームの上に載ります。'
          : '背景を透明にします。<br>透過PNGや透過SVGとして背景のない画像を書き出せます。';
    }

    const hideSwatch = isImage || isAuto || isNone || isWhite || isBlack || isBrand;
    if (!hideSwatch) ensurePanelPart(scope, 'swatch');
    showIf(cq(scope, 'swatch-host'), !hideSwatch);

    showIf(cq(scope, 'transparency-row'), isPlate && !isNone && !isWhite && !isBlack);
    const transVal = p.transparency !== undefined ? p.transparency : 0;
    setRange(cq(scope, 'transparency'), cq(scope, 'val-transparency'), transVal, transVal + '%');

    const hex = normHex(p.color, isPlate ? '#FFFFFF' : '#111827');
    setVal(cq(scope, 'color-picker'), hex);
    setVal(cq(scope, 'color-hex'), hex);

    setRange(cq(scope, 'angle'), cq(scope, 'val-angle'), p.angle, p.angle + '°');
    showIf(cq(scope, 'angle-row'), p.type !== 'radial');

    const hasImage = !!(isImage && p.src);
    showIf(cq(scope, 'image-thumb'), hasImage);
    setImgSrc(cq(scope, 'image-thumb-img'), p.src);
    syncImageScaleRow(cq(scope, 'image-scale-row'), cq(scope, 'image-scale'),
      cq(scope, 'val-image-scale'), p, hasImage);

    if (isMulti) buildMultiColorsList(scope);
    else if (isGrad) buildGradColorsList(scope);
  }

  // 0.70 ではなく 0.7 と出す
  function fmtLineWidth(v) {
    return String(Math.round(Number(v) * 100) / 100);
  }

  function fmtMinVersion(v) {
    return v <= 1 ? '自動' : 'v' + v + '以上';
  }

  // 枠線の種類ごとに、太さのスライダーの下へ添える補足
  const FRAME_LINE_NOTES = {
    cells: '※ 太さは、外周に並べるセルの大きさです。セルの形と太さの設定に連動します。',
    stamp: '※ 太さは、ミシン目の内側にできる縁の幅です。',
    ticket: '※ 左右の切り欠きは、地をくり抜いて作っています。',
    balloon: '※ しっぽのぶん、下に伸びます。'
  };

  // ラベルの文字は上下で入れ物が違う（text / textTop）。qr-style.js が
  // その位置で実際に描くほうのキーを返す。「上下」のときは下を指し、
  // 上の文字は専用の欄（frame-text-top）が受け持つ。
  function frameTextKey() {
    return state.style.frame.pos === 'top' ? 'textTop' : 'text';
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

    setVal('opt-ec', state.ec);
    setVal('opt-size', String(state.exportSize));
    syncSizeUnit();
    syncCompress();

    COLOR_SCOPES.forEach(syncColorPanel);

    // 見出しの脇に出す要約
    setText('hint-shape-color', paintLabel(s.fg));
    setText('hint-bg', paintLabel(s.bg));
    // 枠と目（またはその塗り）が同じなら1つだけ、違えば並べて出す
    const pairText = (a, b) => (a === b ? a : a + '／' + b);
    setText('hint-marker', pairText(nameOf(A.MARKER_FRAMES, s.markerFrame), nameOf(A.MARKER_EYES, s.markerEye)));
    setText('hint-marker-color', pairText(paintLabel(s.markerFramePaint), paintLabel(s.markerEyePaint)));

    setRange('opt-cellscale', 'val-cellscale', s.cellScale, pct(s.cellScale));
    setRange('opt-celljitter', 'val-celljitter', s.cellJitter, pct(s.cellJitter));
    setRange('opt-margin', 'val-margin', s.margin, s.margin);
    // 角丸の上限は余白しだい。はみ出したぶんを削るのは余白を動かした側の
    // 仕事で、ここは見せるだけ（syncControls が state を書き換えると、
    // 履歴の取り方と噛み合わなくなる）
    const maxRadius = maxRadiusOf(s.margin);
    $('opt-radius').max = maxRadius;
    $('opt-radius').disabled = maxRadius === 0;
    setRange('opt-radius', 'val-radius', s.radius, maxRadius === 0 ? '—' : s.radius);
    setRange('opt-minver', 'val-minver', state.minVersion, fmtMinVersion(state.minVersion));

    // ロゴ同期
    setSeg('logo-mode', s.logo.type, 'mode');
    showIf('logo-icon-pane', s.logo.type === 'icon');
    showIf('logo-image-pane', s.logo.type === 'image');
    showIf('logo-text-pane', s.logo.type === 'text');
    showIf('logo-common', s.logo.type !== 'none');

    setSeg('logo-font-seg', s.logo.font, 'font');
    setVal('logo-text', s.logo.text);

    // ロゴ共通
    setRange('logo-size', 'val-logosize', s.logo.size, pct(s.logo.size));
    setRange('logo-pad', 'val-logopad', s.logo.pad, pct(s.logo.pad));
    showIf('logo-thumb', s.logo.type === 'image' && s.logo.src);
    setImgSrc('logo-thumb-img', s.logo.src);
    setText('hint-logo', s.logo.type === 'none' ? 'なし'
      : s.logo.type === 'icon' ? nameOf(A.ICONS, s.logo.icon, 'アイコン')
      : s.logo.type === 'image' ? '画像' : '文字');

    // フレーム同期
    showIf('frame-line-opts', s.frame.type === 'line');
    showIf('frame-label-opts', s.frame.type === 'label');

    const isDoubleLine = s.frame.line === 'double';
    setRange('frame-line-width', 'val-frame-line-width', s.frame.lineWidth, fmtLineWidth(s.frame.lineWidth));
    setRange('frame-line-width2', 'val-frame-line-width2', s.frame.lineWidth2, fmtLineWidth(s.frame.lineWidth2));
    showIf('frame-line-width2-row', isDoubleLine);
    setText('frame-line-width-label', isDoubleLine ? '外側の太さ' : '太さ');
    setText('frame-line-note', FRAME_LINE_NOTES[s.frame.line] || '');
    // 「上」だけのときは上の指定を、それ以外（下・上下）は下の指定を見せる
    const isTopPos = s.frame.pos === 'top';
    const isBothPos = s.frame.pos === 'both';
    setSeg('frame-pos-seg', s.frame.pos, 'pos');

    const cMode = isTopPos ? s.frame.topContentMode : s.frame.contentMode;
    setSeg('frame-content-mode-seg', cMode, 'mode');
    CONTENT_MODES.forEach(m => showIf('frame-pane-' + m, cMode === m));

    // テキスト。上下に出すときだけ、上の文字を別の欄で受ける
    setVal('frame-text', s.frame[frameTextKey()]);
    setText('frame-text-label', isBothPos ? '下部の文字' : '表示する文字');
    showIf('frame-text-top-row', isBothPos);
    setVal('frame-text-top', s.frame.textTop);
    setSeg('frame-font-seg', s.frame.font, 'font');

    // アイコン（一覧のタブはロゴとラベルで別々に持つ）
    setSeg('icon-tabs', state.iconGroup, 'group');
    setSeg('frame-icon-tabs', state.frameIconGroup, 'group');
    syncShapeGridActive('icon-grid', s.logo.icon);
    syncShapeGridActive('frame-icon-grid', shownFrameIcon());

    // 画像。上の画像が空なら下の画像を使うのは qr-style.js と同じ
    const curImgSrc = isTopPos ? (s.frame.topSrc || s.frame.src) : s.frame.src;
    showIf('frame-image-thumb', curImgSrc);
    setImgSrc('frame-image-thumb-img', curImgSrc);

    // 中身の大きさ・余白
    setRange('frame-content-size', 'val-frame-content-size', s.frame.contentSize, pct(s.frame.contentSize));
    setRange('frame-content-pad', 'val-frame-content-pad', s.frame.contentPad, pct(s.frame.contentPad));

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

  // 予約してある検査を取り消す
  function cancelVerify() {
    if (verifyTimer) { clearTimeout(verifyTimer); verifyTimer = null; }
  }

  function scheduleVerify(svg, text, heavy, delay) {
    cancelVerify();
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
    // デザインを触った側は presetName を消すだけでよい。選択の印と見出しは
    // ここで必ず揃える（操作ごとに呼ぶと、どこかで書き忘れて古い名前が残る）。
    syncPresetActive();

    const text = payload();
    lastPayload = text;

    const meta = $('meta-row');
    meta.innerHTML = '';

    if (!text) {
      showNoPreview('na', '待機中', '内容を入力するとここに出ます', [], 'ready', 'idle');
      return;
    }

    let qr;
    try {
      qr = encodeQR(text);
    } catch (e) {
      showNoPreview('ng', '入りきりません', '文字数を減らすか、誤り訂正レベルを下げてください',
        [{ kind: 'too-long', level: 'error', text: 'この内容はQRコードの上限（バージョン40）を超えています。文字数を減らしてください。' }],
        'too long', 'err');
      return;
    }

    let out;
    try {
      out = window.QRStyle.render(qr, state.style);
    } catch (e) {
      showNoPreview('ng', '描けませんでした', 'デザインの設定を見直すか、リセットしてください', [],
        'render error', 'err');
      return;
    }
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
      cancelVerify();
      verify(out.svg, text, false);
    }
  }

  // デザインを触ったあとの一式。テンプレートから外れたことにして、操作部品を
  // state に合わせ直し、描き直す。操作ごとに手で並べると、どこかで1行抜ける。
  //   opts.keepPreset … 誤り訂正のようにデザインではない設定なら、名前を残す
  //   ほかは update() にそのまま渡す
  function designChanged(opts) {
    if (!(opts && opts.keepPreset)) state.presetName = '';
    syncControls();
    update(opts);
  }

  // つまみや色を動かしているあいだ。部品は動かしている本人が映しているので
  // 組み直さず、検査も手を止めるまで待たせる（1コマごとにデコーダを起こさない）。
  function designDragged() {
    state.presetName = '';
    update({ debounceVerify: true });
  }

  // 絵を出せないとき（空・入りきらない・描画で落ちた）の後始末。前の絵と判定を
  // 残すと、いまの設定とは違う絵がそのまま書き出されてしまうので、検査の予約も
  // 含めて全部片づける。
  function showNoPreview(kind, title, note, alerts, statusText, statusCls) {
    cancelVerify();
    $('preview').innerHTML = '';
    lastSvg = '';
    setVerdict(kind, title, note, []);
    syncVerifyButton(false);
    renderAlerts(alerts);
    syncPrintNote(0);
    setStatus(statusText, statusCls);
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

  // 1枚の canvas に持てる大きさには上限がある。Chrome でも 18898px 四方
  // （400mm・1200dpi）は描けず、書き出しが黙って失敗した。mm 指定で解像度を
  // 上げすぎたときはここで頭を打ち、実際の解像度が下がることは印刷の注記で伝える。
  const MAX_OUTPUT_PX = 8192;

  // 寸法と解像度どおりの画素数（上限をかける前）
  function wantedPrintPx() {
    return Math.max(64, Math.round(state.printMm / MM_PER_INCH * state.printDpi));
  }

  function printPx() {
    return Math.min(MAX_OUTPUT_PX, wantedPrintPx());
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
    // WebP の可逆には強弱がない。効かないつまみを出しておくより、消して
    // 「ここは選ぶところがない」と分かるほうがよい。
    const noKnob = compressFor === 'webp' && state.lossless;
    setText('compress-title', (compressFor === 'webp' ? 'WebP' : 'AVIF') + ' の圧縮');
    showIf('compress-slider-row', !noKnob);
    setVal('opt-quality', state.quality);
    showIf('opt-quality', !state.lossless);
    setVal('opt-effort', state.effort);
    showIf('opt-effort', state.lossless);
    setText('compress-label', state.lossless ? '圧縮の強さ' : '品質');
    setText('val-compress', state.lossless ? EFFORT_WORDS[state.effort] : String(state.quality));
    setNote('compress-note', '', noKnob
      ? 'WebPの可逆圧縮に強弱の設定はありません。元の絵と1ピクセルも変わらないまま保存します。'
      : state.lossless
      ? '元の絵と1ピクセルも変わりません。強くするほど小さくなりますが、書き出しに時間がかかります'
        + '（1024pxの黒白QRで、ふつう51KB・0.5秒／小ささ優先33KB・4秒）。'
      : '元の絵とごくわずかに変わりますが、読み取りには影響しません'
        + '（1024pxの黒白QRで13KBほど。可逆なら51KB、PNGなら43KB）。');
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
    showIf('opt-compress', false);
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
    showIf('print-fields', isMm);
    showIf('px-fields', !isMm);
    setVal('opt-print-mm', String(state.printMm));
    setVal('opt-print-dpi', String(state.printDpi));
    syncPrintNote();
  }

  function syncPrintNote(moduleW) {
    if (moduleW !== undefined) lastModuleW = moduleW;
    const isMm = state.sizeUnit === 'mm';
    setText('opt-size-derived', lastModuleW && isMm ? printPx() + ' px' : '');

    if (!lastModuleW) {
      setNote('print-note', '', '');
    } else if (isMm) {
      const mm = moduleMm();
      const lv = moduleMmLevel(mm);
      const capped = wantedPrintPx() > MAX_OUTPUT_PX;
      const realDpi = Math.round(printPx() / (state.printMm / MM_PER_INCH));
      setNote('print-note', lv.cls, '幅 ' + state.printMm + 'mm・' + state.printDpi + 'dpi なら ' +
        (capped
          ? wantedPrintPx() + 'px になりますが、書き出せる上限の ' + MAX_OUTPUT_PX + 'px（約' + realDpi + 'dpi）で書き出します。'
          : printPx() + 'px で書き出します。') +
        '1モジュール ' + fmtMm(mm) + 'mm（' + lv.word + '）。' +
        '読み取り距離の目安は ' + fmtScanDistance(state.printMm) + 'まで。');
    } else {
      // 幅が決まっていないので、逆に「最低これだけ要る」を言う
      const minMm = Math.ceil(lastModuleW * MODULE_MM_OK);
      setNote('print-note', '', '印刷するなら幅 ' + minMm + 'mm 以上（1モジュール ' + MODULE_MM_OK +
        'mm）。それより小さいと、にじみでマス目が潰れることがあります。' +
        '寸法で決めたいときは「印刷（mm）」に切り替えてください。');
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
    designChanged({ keepPreset: !!(opts && opts.keepPreset), immediateHistory: true });
    if (message) showToast(message);
  }

  // hex を target へ t（0〜1）だけ寄せる。白黒へ寄せれば色みを残したまま
  // 明るさだけが動き、t = 0.5 なら2色のちょうど中間になる。
  function towardHex(hex, target, t) {
    const a = hexToRgb(hex) || [0, 0, 0];
    const b = hexToRgb(target) || [0, 0, 0];
    return window.QRStyle.rgbToHex(a.map((v, i) => v + (b[i] - v) * t));
  }

  // 読ませるときに敷く紙の色。書き出した絵は透けたまま渡されるので、
  // どこかで不透明にしないとデコーダは透明部分を真っ黒として読む。
  const PAPER = '#FFFFFF';

  // いまの背景（白・透明・セル追従まで解いたあと）の実際に地として描かれる色。
  // 「セルの色」や「白」は指定でしかないので resolvePaint で解いてから訊く。
  // 透過スライダーで抜いたぶんは紙が透けるので、そのぶん白へ寄せる。
  // 透明（paintColor が null）は、読ませるときも見るときも白い紙の上とみなす。
  //
  // ここを不透明の色のまま返すと、透過 100%（＝何も描かれない）の背景でも
  // 紙をその色で塗ってしまい、「背景＝セルの色」や「セルと同じグラデーション」
  // では絵の全面がセルと同色になって、必ず読み取りに失敗していた。
  function resolvedBgHex() {
    const bg = window.QRStyle.resolvePaint(state.style.bg, state.style.fg);
    const c = window.QRStyle.paintColor(bg);
    if (!c || bg.type === 'none') return PAPER;
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
          // 種類だけ戻す。塗りを丸ごと差し替えると、ほかのモードの色（多色の並びや
          // グラデーションの端）まで消え、あとで切り替えたときに空の塗りになる
          state.style[key].type = 'auto';
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

  // デコーダを読み込んだあとの検査は数十msで終わる。結果が前と同じだと画面が
  // まったく動かず、走ったのかどうか分からないので、終わるたびに枠を短く光らせ、
  // 時刻を出す。検査そのものは引き延ばさない。
  function markChecked() {
    const v = $('verdict');
    const d = new Date();
    $('verdict-time').textContent = pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
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
      const pad = resolvedBgHex();
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
        } else if (r.mismatch) {
          // ひとつでも別の内容として復号したなら、ほかのエンジンで読めても安全とは
          // 言えない。簡易チェックかどうかより先に赤判定へ倒す。
          setVerdict('ng', '内容がずれています',
            '別の内容として読まれています。ロゴや装飾を控えめにしてください', r.engines);
        } else if (r.level === 'ng' && !window.QRVerify.heavyLoaded()) {
          // 軽いデコーダしか動いていない段階での失敗は、証拠として弱い。jsQR は
          // 装飾に厳しく、そこで落ちても実機では読めることが多い。断定せずに
          // 詳しい検査へ誘導する。
          setVerdict('fair', '簡易チェックでは読めません',
            '実機のカメラなら読めることがあります。「詳しく検査」で確かめてください', r.engines);
        } else if (r.level === 'ng') {
          setVerdict('ng', '読み取れませんでした',
            'コントラスト・ロゴの大きさ・余白を見直してください', r.engines);
        } else if (r.level === 'best') {
          setVerdict('ok', '読み取りOK',
            (r.ran > 1 ? r.ran + 'つのデコーダすべてで' : '') +
            '全解像度に成功しました。確認した範囲では安定しています' + missing, r.engines);
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
              strong.map(e => e.name).join('と') + 'では全解像度に成功しました。' + worst.name +
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
  // 画面のプレビューはページが読み込んだフォント（data/fonts/ に同梱）で描かれるが、
  // 書き出しは SVG を data URL の <img> として読ませるため、ページのフォントを
  // 受け継がない。放っておくと、選んだ書体が画面にだけ効いて、書き出した画像は
  // 既定の書体になる（実測でも指定あり／なしが同じ形になった）。
  //
  // そこで書き出す直前に、いま使っている字を含むフォントのファイルだけを
  // @font-face として SVG に埋める。フォントは字の範囲（unicode-range）ごとに
  // 分けて同梱してあるので、埋めるのは使った字の範囲のぶんだけで済む。
  // 取りに行くのはこのサイトの data/fonts/ だけで、字をどこかへ問い合わせることはない。
  //
  // 取れなかったぶんは諦める（書き出し自体は止めず、既定の書体で出る）。

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

  // ページが読み込んだ @font-face（data/fonts/*.css）。索引を別に持たず、CSS を
  // そのまま引く（別に作ると、CSS と食い違ったときに気づけない）。
  // このサイトのファイルを指すものだけを拾うので、書き出しが外へ出ることはない。
  let bundledFaces = null;
  function bundledFontFaces() {
    if (bundledFaces) return bundledFaces;
    const out = [];
    Array.prototype.forEach.call(document.styleSheets, sheet => {
      let rules;
      try { rules = sheet.cssRules; } catch (e) { return; }   // 別オリジンの CSS は中を読めない
      Array.prototype.forEach.call(rules, rule => {
        if (!(rule instanceof CSSFontFaceRule)) return;
        const st = rule.style;
        const src = st.getPropertyValue('src').match(/url\(\s*["']?([^"')]+)["']?\s*\)/);
        if (!src) return;
        const url = new URL(src[1], sheet.href || location.href);
        if (url.origin !== location.origin) return;
        out.push({
          family: st.getPropertyValue('font-family').replace(/["']/g, '').trim(),
          weight: Number(st.getPropertyValue('font-weight')) || 400,
          url: url.href,
          range: st.getPropertyValue('unicode-range').trim(),
          ranges: parseUnicodeRange(st.getPropertyValue('unicode-range'))
        });
      });
    });
    // CSS がまだ読めていないうちの空振りは覚えない
    if (out.length) bundledFaces = out;
    return out;
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

  // その面で描く字のうち、見える最初の1字（空白は描いても跡が残らないので外す）
  function firstInkChar(ranges, text) {
    for (const ch of text) {
      const c = ch.codePointAt(0);
      if (/\S/.test(ch) && ranges.some(r => c >= r[0] && c <= r[1])) return ch;
    }
    return '';
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
  async function exportFontCss(style) {
    let runs = [];
    try { runs = window.QRStyle.textRuns(style); } catch (e) { return ''; }
    if (!runs.length) return '';
    const faces = bundledFontFaces();
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

  // 書き出す SVG に、いまの絵で使っている書体を埋めて返す。
  async function withExportFonts(svg) {
    return window.QRStyle.embedFontCss(svg, await exportFontCss(state.style));
  }

  // 書き出す SVG 文書。mm 指定のときは mm のまま書き出す。Illustrator や
  // InDesign に読ませたときに、拡大率をいじらなくてもその寸法で入る。
  function svgDocument(svg) {
    const sized = state.sizeUnit === 'mm'
      ? window.QRStyle.resizeMm(svg, state.printMm)
      : window.QRStyle.resize(svg, 1024);
    return '<?xml version="1.0" encoding="UTF-8"?>' + String.fromCharCode(10) + sized;
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
    // 印刷向けに書き出したものは、あとから見て何ミリで作ったか分かるようにする
    const size = state.sizeUnit === 'mm' ? '-' + state.printMm + 'mm' : '';
    return 'qr-' + state.type + '-' + stamp() + size;
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

  let lastFocusedElement = null;

  function openFullscreen() {
    if (!lastSvg) return;
    const modal = $('fullscreen-modal');
    const host = $('fullscreen-preview');
    if (!modal || !host) return;
    lastFocusedElement = document.activeElement;
    host.innerHTML = lastSvg;
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    const closeBtn = $('btn-fullscreen-close');
    if (closeBtn) closeBtn.focus();
  }

  function closeFullscreen() {
    const modal = $('fullscreen-modal');
    if (!modal || modal.classList.contains('hidden')) return;
    modal.classList.add('hidden');
    document.body.style.overflow = '';
    if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') {
      lastFocusedElement.focus();
      lastFocusedElement = null;
    }
  }

  // 書き出す直前に、待っている検査を繰り上げて片づける。押した時点の絵で
  // 判断したいので、180ms 後に走る予定のものを待たない。
  // すでに検査が走っている最中なら、その完了を待つ。
  async function settleVerdict() {
    if (verifyTimer) {
      cancelVerify();
      if (lastSvg && lastPayload) await verify(lastSvg, lastPayload, false);
    } else if (activeVerifyPromise) {
      await activeVerifyPromise;
    }
  }

  // ------------------------------------------------------------------
  // CSV のひな形
  // ------------------------------------------------------------------
  // 種類ごとに1本。見出しは項目の名前そのものにするので、落としてそのまま
  // 読み込ませれば、どの列がどの項目かは bulkGuessColumn が自動で当てる。
  // cols は項目キー。行ごとに変わらない設定（連絡先の形式、暗号通貨の種類、
  // ステルスSSID）は列に出さない。「内容」で一度選べば全行に効く。
  const TEMPLATE_ROWS = {
    url: { cols: ['url'], rows: [
      ['https://example.com/shop-a'],
      ['https://example.com/shop-b'],
      ['https://example.com/shop-c']] },
    sns: { cols: ['platform', 'id'], rows: [
      ['instagram', 'example_shop'],
      ['x', 'example_shop'],
      ['line', 'abcdefg'],
      ['youtube', 'example_shop']] },
    text: { cols: ['text'], rows: [
      ['ご来店ありがとうございます'],
      ['10%OFF クーポン']] },
    event: { cols: ['title', 'start', 'end', 'location', 'desc'], rows: [
      ['新商品発表会', '2026-10-01T13:00', '2026-10-01T15:00', '東京ビッグサイト', '受付は12時30分から'],
      ['内覧会', '2026-10-02T10:00', '2026-10-02T17:00', '本社ショールーム', '']] },
    email: { cols: ['to', 'subject', 'body'], rows: [
      ['info@example.com', 'お問い合わせ', ''],
      ['support@example.com', '修理のご依頼', '製品名：']] },
    tel: { cols: ['tel'], rows: [
      ['+81312345678'],
      ['09012345678']] },
    sms: { cols: ['tel', 'msg'], rows: [
      ['09012345678', '予約をお願いします'],
      ['09087654321', '']] },
    wifi: { cols: ['ssid', 'pass', 'enc'], rows: [
      ['CafeWiFi-1F', 'guest1234', 'WPA'],
      ['CafeWiFi-2F', 'guest5678', 'WPA'],
      ['CafeWiFi-Free', '', 'なし（オープン）']] },
    vcard: { cols: ['last', 'first', 'org', 'title', 'tel', 'email'], rows: [
      ['山田', '太郎', '株式会社サンプル', '営業部', '09012345678', 'taro@example.com'],
      ['鈴木', '花子', '株式会社サンプル', '広報部', '09087654321', 'hanako@example.com']] },
    geo: { cols: ['lat', 'lng'], rows: [
      ['35.681236', '139.767125'],
      ['34.702485', '135.495951']] },
    crypto: { cols: ['addr', 'amount', 'label'], rows: [
      ['bc1qexampleaddressreplacemexxxxxxxxxxxxxxx', '0.001', 'ご支援ありがとうございます'],
      ['bc1qanotheraddressreplacemexxxxxxxxxxxxxxx', '', '']] }
  };

  // ひな形の中身。見出しは項目の名前そのもの。
  function templateParts(type) {
    const tpl = TEMPLATE_ROWS[type.id];
    if (!tpl) return null;
    const fields = tpl.cols.map(k => type.fields.find(x => x.k === k) || { k: k, label: k });
    // 選ぶ項目は、ドロップダウンに並ぶ言葉そのものを見本にする。'WPA' と
    // 書いておくと、一覧に無い値として Excel に弾かれる（一覧側は
    // 'WPA / WPA2 / WPA3' という表示名で持っているため）。
    const rows = tpl.rows.map(r => r.map((v, i) => {
      const f = fields[i];
      if (!f || f.type !== 'select') return v;
      const hit = (f.options || []).find(o => o[0] === v || o[1] === v);
      return hit ? hit[1] : v;
    }));
    return {
      fields: fields,
      headers: fields.map(f => f.label),
      rows: rows
    };
  }

  const TEMPLATE_EXAMPLE_SHEET = '記入例';

  // ブック1冊に種類ぶんのシートを立てる。ボタンを11個並べるより、
  // 落としてから中でタブを選ぶほうが早い。
  //
  // 種類のシートには見出しだけを置き、見本は「記入例」シートへ寄せる。
  // 見本をそのまま残しておくと、消し忘れた行がそのままQRコードになって
  // 出てくる。
  function templateBookSheets() {
    const sheets = [];
    const example = [];
    TYPES.forEach(t => {
      const part = templateParts(t);
      if (!part) return;
      const lists = [];
      const dates = [];
      part.fields.forEach((f, i) => {
        if (f.type === 'select') {
          lists.push({ col: i, values: (f.options || []).map(o => o[1]) });
        } else if (f.type === 'datetime-local') {
          dates.push(i);
        }
      });
      sheets.push({
        name: t.name,
        grid: [part.headers],
        headerRow: true,
        lists: lists,
        dates: dates
      });

      example.push([t.name]);
      example.push(part.headers);
      part.rows.forEach(r => example.push(r));
      example.push([]);
    });

    // 記入例は太字の種類名で区切る。どこからどこまでが1種類か分かるように
    const bold = [];
    example.forEach((row, n) => { if (row.length === 1 && row[0]) bold.push(n); });
    sheets.push({
      name: TEMPLATE_EXAMPLE_SHEET,
      grid: example,
      boldRows: bold
    });
    return sheets;
  }

  function downloadTemplateBook() {
    if (window.QRXlsx && window.QRBulk) {
      try {
        const blob = window.QRXlsx.build({
          sheets: templateBookSheets(),
          maxRows: BULK_MAX
        });
        saveBlob(blob, 'qr-template.xlsx');
        showToast('種類ごとのシートが入っています。「記入例」を見ながら書いてください');
        return;
      } catch (e) {
        // ブックを組めなかったときは、いま選んでいる種類の CSV に落とす。
        // 何も落ちてこないより、選択肢が無いだけのほうがまだ進める。
      }
    }
    const type = currentType();
    const csv = templateCsv(type);
    if (!csv) return;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    saveBlob(blob, 'qr-template-' + type.id + '.csv');
  }

  function templateCsv(type) {
    const t = templateParts(type);
    if (!t) return '';
    const lines = [t.headers.map(csvCell).join(',')];
    t.rows.forEach(r => lines.push(r.map(csvCell).join(',')));
    // Excel で開いたときに日本語が化けないよう BOM を付ける
    return String.fromCharCode(0xFEFF) + lines.join(CRLF) + CRLF;
  }

  function buildTemplateGrid() {
    const grid = $('csv-tpl-grid');
    if (!grid || grid.childElementCount) return;
    const b = el('button', { type: 'button', class: 'st-btn-quiet btn-sm' },
      'ひな形(.xlsx)をダウンロード');
    b.addEventListener('click', downloadTemplateBook);
    grid.appendChild(b);
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

  // 書き出しに失敗したときの言い方。大きな絵は端末の上限にかかっていることが多い
  // （とくに iPhone の Safari は、canvas がおよそ 4096px 四方まで）ので、下げれば
  // 通ることを添える。
  function exportFailMessage(what) {
    return outputPx() > 4096
      ? what + 'に失敗しました。この端末では大きすぎるようです。寸法か解像度を下げてください'
      : what + 'に失敗しました';
  }

  // 書き出す絵があるか。無ければ知らせて止める
  function hasPreview() {
    if (lastSvg) return true;
    showToast('先に内容を入力してください', 'error');
    return false;
  }

  // 1枚ぶんを焼く。AVIF だけはブラウザが焼けないので、同梱した
  // エンコーダに渡す（toBlob に image/avif を渡すと黙って PNG が返る）。
  async function encodeCanvas(canvas, mime, avifOpts) {
    if (mime === 'image/avif') {
      if (!window.QRAvif) throw new Error('avif encoder missing');
      return window.QRAvif.encode(canvas, avifOpts || avifOptions());
    }
    const q = mime === 'image/webp' ? webpQuality() : undefined;
    return new Promise(res => canvas.toBlob(res, mime, q));
  }

  async function exportRaster(mime, ext) {
    if (!hasPreview()) return;
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
      showToast(exportFailMessage('書き出し'), 'error');
    }
    setStatus('ready', 'idle');
  }

  async function exportSvg() {
    if (!hasPreview()) return;
    if (!(await okToExport())) return;
    const doc = svgDocument(await withExportFonts(lastSvg));
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
    if (!hasPreview()) return;
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
    const write = item => navigator.clipboard.write([new window.ClipboardItem({ 'image/png': item })]);
    try {
      try {
        await write(png);
      } catch (e) {
        // Promise を受け付けない実装もあるので、その場合は焼けた Blob で入れ直す
        await write(await png);
      }
    } catch (e2) {
      showToast('コピーできませんでした', 'error');
      return;
    }
    flashButtonSuccess($('btn-copy'), '✓ コピー完了');
    showToast(copyNote());
    if (window.STShare) STShare.celebrate();
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
  // ZIP にする前に全部を手元に抱えるので、形式の上限（4GB）より手前で止める。
  // そこまで行くと、ZIP を組む前にタブのほうが落ちる。
  const BULK_BYTES_MAX = 512 * 1024 * 1024;
  const BULK_NONE = '__none__';
  const BULK_DOT = String.fromCharCode(46);   // 種類と項目をつなぐ区切り
  const BULK_SEP = String.fromCharCode(47);   // 1つの列を2項目に当てたときの区切り
  const BULK_NL = String.fromCharCode(10);

  const bulk = {
    rows: [],          // 見出しも含む、読み込んだままの全行
    sheets: [],        // Excel ブックのときは、入っていたシートぜんぶ
    sheetAt: 0,        // そのうち、いま読んでいるもの
    fileName: '',
    encoding: '',
    running: false,
    starting: false,   // 押してから走り出すまで（判定待ち・確認ダイアログ中）
    abort: false
  };

  // 種類の名前と同じシートを探す。ひな形は種類ごとのタブでできているので、
  // 「内容」で Wi-Fi を選んでいるなら Wi-Fi のタブを読むのが素直。
  function bulkSheetForType(sheets, typeName) {
    const want = bulkNorm(typeName);
    return sheets.findIndex(sh => bulkNorm(sh.name) === want);
  }

  // 中身のあるシート＝見出しのほかに1行以上あるもの
  function bulkSheetHasData(sh) {
    return sh && sh.rows.length > 1 && sh.rows.slice(1).some(r => r.some(v => String(v || '').trim()));
  }

  function bulkUseSheet(at) {
    const sh = bulk.sheets[at];
    if (!sh) return;
    bulk.sheetAt = at;
    bulk.rows = sh.rows;
    bulk.encoding = excelLabel(sh);
  }

  // 読み込み元の表示（右肩の要約に出す）
  function excelLabel(sh) {
    return 'Excel' + (sh.name ? '／' + sh.name : '');
  }

  function bulkFillSheetSelect() {
    const row = $('bulk-sheet-row');
    const sel = $('bulk-sheet');
    if (!row || !sel) return;
    const many = bulk.sheets.length > 1;
    showIf(row, many);
    if (!many) return;
    sel.innerHTML = '';
    bulk.sheets.forEach((sh, i) => {
      const mark = bulkSheetHasData(sh) ? '' : '（空）';
      sel.appendChild(el('option', { value: String(i) }, (sh.name || ('シート' + (i + 1))) + mark));
    });
    sel.value = String(bulk.sheetAt);
  }

  // 見出し行にするかは、チェックのとおりに従う。かつては「1行しかないなら
  // 見出し扱いしない」と気を利かせていたが、ひな形の空シート（見出しだけ）で
  // その見出しがそのままQRコードになって出てきた。
  function bulkUseHeader() {
    const box = $('bulk-header');
    return !!(box && box.checked);
  }

  // 見出し行（使わないときは空）
  function bulkHeadRow() {
    return (bulkUseHeader() && bulk.rows[0]) || [];
  }

  // 列の見出し。1行目を見出しに使わないときは「1列目」「2列目」…と数える。
  function bulkColumns() {
    const width = bulk.rows.reduce((m, r) => Math.max(m, r.length), 0);
    const head = bulkHeadRow();
    const out = [];
    for (let i = 0; i < width; i++) {
      const name = (head[i] || '').trim();
      out.push(name ? name + '（' + (i + 1) + '列目）' : (i + 1) + '列目');
    }
    return out;
  }

  function bulkDataRows() {
    const useHeader = bulkUseHeader();
    return bulk.rows.slice(useHeader ? 1 : 0);
  }

  // 項目に列を当てるときの手がかり。見出しが項目名そのものでなくても拾える
  // ように、よくある言い換えを持っておく。キーは「種類.項目」にすること。
  // 項目キーだけで引くと、カレンダーの「予定名」と連絡先の「役職」が同じ
  // title で衝突して、まるで関係のない列を掴む。
  const BULK_ALIAS = {
    'url.url': ['url', 'リンク', 'リンク先', '内容', 'アドレス', 'リンクurl'],
    'sns.id': ['id', 'ユーザー名', 'アカウント', 'ユーザーid', 'ユーザ名'],
    'sns.platform': ['サービス', 'sns', 'プラットフォーム'],
    'text.text': ['文章', '本文', '内容', 'テキスト'],
    'event.title': ['予定名', 'タイトル', '名称', 'イベント名'],
    'event.start': ['開始', '開始日時', '開始時刻'],
    'event.end': ['終了', '終了日時', '終了時刻'],
    'event.location': ['場所', '会場', '住所'],
    'event.desc': ['詳細', 'メモ', '説明', '備考', '詳細メモ'],
    'email.to': ['宛先', 'メール', 'メールアドレス', 'email'],
    'email.subject': ['件名', 'タイトル'],
    'email.body': ['本文', '内容'],
    'tel.tel': ['電話', '電話番号', '連絡先', 'tel'],
    'sms.tel': ['送信先', '電話', '電話番号', 'tel'],
    'sms.msg': ['本文', 'メッセージ'],
    'wifi.ssid': ['ssid', 'ネットワーク名', 'ネットワーク', 'ネットワーク名ssid'],
    'wifi.pass': ['パスワード', 'password', 'pass', 'キー'],
    'wifi.enc': ['暗号化', '暗号化方式', '認証方式', 'セキュリティ'],
    'wifi.hidden': ['ステルス', 'ステルスssid', '非公開'],
    'vcard.last': ['姓', '名字', '苗字'],
    'vcard.first': ['名', '下の名前'],
    'vcard.org': ['会社', '組織', '会社名', '所属', '会社組織'],
    'vcard.title': ['役職', '肩書', '肩書き'],
    'vcard.tel': ['電話', '電話番号', '携帯'],
    'vcard.email': ['メール', 'メールアドレス', 'email'],
    'vcard.url': ['サイト', 'url', 'ホームページ'],
    'vcard.note': ['メモ', '備考'],
    'geo.lat': ['緯度', 'lat'],
    'geo.lng': ['経度', 'lng', 'lon', 'longitude'],
    'crypto.addr': ['アドレス', '請求書', 'address', 'アドレス請求書'],
    'crypto.amount': ['金額', 'amount', '金額btc'],
    'crypto.label': ['ラベル', 'label']
  };

  function bulkNorm(v) {
    return String(v == null ? '' : v).trim().toLowerCase()
      .split(' ').join('').split('　').join('');
  }

  // 見出しの名前で当たりを付ける。合わなければ空を返して「固定」のままにする。
  function bulkGuessColumn(type, field) {
    const head = bulkHeadRow();
    if (!head.length) return '';
    const want = [field.label, field.k]
      .concat(BULK_ALIAS[bulkMapKey(type, field)] || []).map(bulkNorm);
    for (let i = 0; i < head.length; i++) {
      const name = bulkNorm(head[i]);
      if (name && want.indexOf(name) >= 0) return String(i);
    }
    return '';
  }

  // bulkMap … いま効いている割り当て（毎回組み直す）
  // bulkPicked … 人が手で選んだものだけ。当て推量はここへ入れない。
  // 分けないと、列がまだ無いうちの空振りが「選んだ結果」として焼き付き、
  // ファイルを読ませても見出しを拾わなくなる。
  const bulkMap = {};
  const bulkPicked = {};

  // 手で選んだ割り当てを捨てる（列の並びが変わったとき）
  function clearBulkPicked() {
    Object.keys(bulkPicked).forEach(k => { delete bulkPicked[k]; });
  }

  function bulkMapKey(type, field) { return type.id + BULK_DOT + field.k; }

  // その項目に当てた列の番号。当てていなければ -1
  function bulkColumnOf(type, field) {
    const v = bulkMap[bulkMapKey(type, field)];
    return v == null || v === BULK_NONE ? -1 : Number(v);
  }

  // 項目ひとつにつき1本のセレクト。当てなければ「内容」の値のまま。
  function bulkFillSelects() {
    const host = $('bulk-map');
    if (!host) return;
    const type = currentType();
    const cols = bulkColumns();
    host.innerHTML = '';

    const head = el('p', { class: 'bulk-map-head' });
    head.appendChild(document.createTextNode('「内容」で選んでいる '));
    head.appendChild(el('b', null, type.name));
    head.appendChild(document.createTextNode(' の項目に、CSVの列を当てます。'));
    host.appendChild(head);

    const firstText = type.fields.find(f => f.type !== 'select' && f.type !== 'checkbox');

    type.fields.forEach(f => {
      const wrap = el('div', { class: 'field' });
      const id = 'bulk-map-' + type.id + '-' + f.k;
      wrap.appendChild(el('label', { for: id }, f.label));
      const sel = el('select', { class: 'tb-select', id: id });
      sel.appendChild(el('option', { value: BULK_NONE }, '使わない（いまの内容のまま）'));
      cols.forEach((c, i) => sel.appendChild(el('option', { value: String(i) }, c)));
      const key = bulkMapKey(type, f);
      const keep = bulkPicked[key];
      const has = keep != null && Array.prototype.some.call(sel.options, o => o.value === keep);
      // 何も当てないと全行が同じ絵になるので、頭の1項目だけ1列目を指しておく。
      // 選択肢やチェックの項目を指しても意味が通らないので、文字の項目から選ぶ。
      const fallback = f === firstText ? '0' : BULK_NONE;
      sel.value = has ? keep : (bulkGuessColumn(type, f) || fallback);
      // 列がまだ1本も無いときは、どの値も選べない。空のままにしない。
      if (sel.selectedIndex < 0) sel.value = BULK_NONE;
      bulkMap[key] = sel.value;
      sel.addEventListener('change', () => {
        bulkPicked[key] = sel.value;
        bulkMap[key] = sel.value;
        wrap.classList.toggle('has-words', showWords());
        bulkPreview();
      });
      wrap.appendChild(sel);

      // 選択式の項目は、CSVに何と書けばよいのかが画面のどこにも無かった。
      // 列を当てたときだけ、選べる値をその場に並べる。
      const words = f.type === 'select' ? bulkOptionWords(f) : null;
      function showWords() { return !!words && sel.value !== BULK_NONE; }
      if (words) {
        wrap.appendChild(el('span', { class: 'bulk-words' },
          '書ける値：' + words.join('')));
        wrap.classList.toggle('has-words', showWords());
      }
      host.appendChild(wrap);
    });
  }

  // 当てた列がひとつでもあるか。ぜんぶ「固定」だと、同じ絵が行数ぶん出る。
  function bulkMappedFields(type) {
    return type.fields.filter(f => bulkColumnOf(type, f) >= 0);
  }

  // 選択肢とチェックは、CSV に何と書かれていても拾えるようにする。
  // 読めない綴りのときは「内容」の値を残す（黙って既定値に倒さない）。
  const BULK_TRUE = ['true', '1', 'yes', 'y', 'on', 'はい', 'オン', 'あり', '○'];
  const BULK_FALSE = ['false', '0', 'no', 'n', 'off', 'いいえ', 'オフ', 'なし', '×'];

  // 選択式の別名。人が手で打つ以上、正式な綴りだけを通しても取りこぼす。
  // キーは「種類.項目.選択肢の値」。ここに無い綴りは通さず、行ごと止める。
  const BULK_OPTION_ALIAS = {
    'wifi.enc.WPA': ['wpa2', 'wpa3', 'wpa/wpa2', 'wpa2psk', 'wpa2-psk', 'wpapsk', 'wpa2personal'],
    'wifi.enc.nopass': ['オープン', 'open', 'none', '無し', 'なし', 'パスワードなし', 'フリー', 'free'],
    'sns.platform.x': ['twitter', 'ツイッター', 'ツイート', 'エックス'],
    'sns.platform.instagram': ['インスタ', 'インスタグラム', 'ig'],
    'sns.platform.youtube': ['yt', 'ユーチューブ'],
    'sns.platform.line': ['ライン'],
    'sns.platform.tiktok': ['ティックトック', 'ティクトク'],
    'sns.platform.facebook': ['fb', 'フェイスブック'],
    'sns.platform.threads': ['スレッズ'],
    'sns.platform.bluesky': ['ブルースカイ', 'bsky'],
    'vcard.format.vcard': ['vcard', 'ブイカード', '標準'],
    'vcard.format.mecard': ['mecard', 'ミーカード'],
    'crypto.chain.bitcoin': ['btc', 'ビットコイン', 'オンチェーン'],
    'crypto.chain.lightning': ['ln', 'ライトニング', 'lnurl']
  };

  // その項目で選べる値。画面のドロップダウンに出ているものと同じ。
  // 「WPA / WPA2 / WPA3」のように選択肢の名前自体に区切り記号が入るので、
  // 中黒で並べるとどこで切れるのか読めない。1つずつ括ってから並べる。
  function bulkOptionWords(field) {
    return (field.options || []).map(o => '「' + o[1] + '」');
  }

  // 突き合わせの結果。ok が false の行は作らない。黙って既定値に倒すと、
  // 形としては正しいQRができてしまい、刷ってから間違いに気づくことになる。
  function bulkCoerce(type, field, raw, fallback) {
    const s = String(raw == null ? '' : raw).trim();
    if (field.type === 'checkbox') {
      const k = bulkNorm(s);
      if (!k) return { ok: true, value: fallback };
      if (BULK_TRUE.indexOf(k) >= 0) return { ok: true, value: true };
      if (BULK_FALSE.indexOf(k) >= 0) return { ok: true, value: false };
      return { ok: false, value: fallback, raw: s, words: ['はい', 'いいえ'] };
    }
    if (field.type === 'select') {
      const k = bulkNorm(s);
      // 空欄は「書いていない」＝「内容」の値のまま。誤りとは分けて扱う。
      if (!k) return { ok: true, value: fallback };
      const opts = field.options || [];
      let hit = opts.find(o => bulkNorm(o[0]) === k || bulkNorm(o[1]) === k);
      if (!hit) {
        hit = opts.find(o => {
          const alias = BULK_OPTION_ALIAS[bulkMapKey(type, field) + BULK_DOT + o[0]];
          return alias && alias.some(a => bulkNorm(a) === k);
        });
      }
      if (hit) return { ok: true, value: hit[0] };
      return { ok: false, value: fallback, raw: s, words: bulkOptionWords(field) };
    }
    return { ok: true, value: s };
  }

  // 1行ぶんの中身を、画面と同じ build() で組み立てる。
  // 戻りは { text, errors }。errors があれば、その行は作らない。
  function bulkPayload(type, row) {
    const base = state.values[type.id] || {};
    const vals = Object.assign({}, base);
    const errors = [];
    type.fields.forEach(f => {
      const col = bulkColumnOf(type, f);
      if (col < 0) return;
      const got = bulkCoerce(type, f, row[col], base[f.k]);
      vals[f.k] = got.value;
      if (!got.ok) errors.push({ col: col, label: f.label, raw: got.raw, words: got.words });
    });
    let text = '';
    try { text = String(type.build(vals) || ''); } catch (e) { text = ''; }
    return { text: text, errors: errors };
  }

  // 最初の数行を表で見せる。当てた列に色を置き、その下に「1行目はこうなる」を
  // そのまま出す。組み上がりを見せないと、当て方が合っているか確かめようがない。
  function bulkPreview() {
    const host = $('bulk-preview');
    host.innerHTML = '';
    const rows = bulkDataRows();
    if (!rows.length) {
      // 空のまま黙っていると、読めていないのか書いていないのかが分からない
      host.appendChild(el('p', { class: 'bulk-map-out empty' },
        bulk.sheets.length > 1
          ? 'このシートには、まだ中身の行がありません。書いたシートを上で選んでください。'
          : '中身の行がありません。見出しの下に1行以上書いてください。'));
      return;
    }
    const cols = bulkColumns();
    const type = currentType();
    // 組み立ては行ごとに1回だけ。表の赤・全行の点検・1行目の見本で使い回す
    const built = rows.map(r => bulkPayload(type, r));
    // 列番号 → 当てた項目名（同じ列を2つの項目に当てることもできる）
    const picked = {};
    type.fields.forEach(f => {
      const i = bulkColumnOf(type, f);
      if (i >= 0) picked[i] = picked[i] ? picked[i] + BULK_SEP + f.label : f.label;
    });

    const table = el('table');
    const thead = el('thead');
    const htr = el('tr');
    cols.forEach((c, i) => {
      const th = el('th', { class: picked[i] ? 'pick' : '' }, picked[i] ? picked[i] : c);
      if (picked[i]) th.setAttribute('title', c);
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);
    const tbody = el('tbody');
    rows.slice(0, 4).forEach((r, n) => {
      const tr = el('tr');
      // 選べない値が入っている列は、押す前に赤で分かるようにする
      const bad = {};
      built[n].errors.forEach(e => { bad[e.col] = true; });
      cols.forEach((c, i) => {
        const marks = picked[i] ? ['pick'] : [];
        if (bad[i]) marks.push('bad');
        tr.appendChild(el('td', { class: marks.join(' ') }, r[i] || ''));
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    // 全行ぶん見ておく。1行目だけ見て「大丈夫そう」と押させない。
    // 見出し行があるぶん、CSV の行番号は1つずれる
    const headOffset = bulkUseHeader() ? 2 : 1;
    const badRows = built.filter(b => b.errors.length).length;
    const firstBad = built.findIndex(b => b.errors.length);

    const first = built[0];
    let line;
    if (badRows) {
      const e = built[firstBad].errors[0];
      line = el('p', { class: 'bulk-map-out empty' },
        badRows + '行で、選べない値が使われています。このままだと、その行は作られません。' + BULK_NL +
        (firstBad + headOffset) + '行目「' + e.label + '：' + e.raw + '」' + BULK_NL +
        '書ける値：' + (e.words || []).join(''));
    } else if (first.text) {
      line = el('p', { class: 'bulk-map-out' }, '1行目はこうなります：' + BULK_NL + first.text);
    } else {
      line = el('p', { class: 'bulk-map-out empty' },
        '1行目が空になります。当てる列を見直すか、「内容」に値を入れてください。');
    }
    host.appendChild(line);
    host.appendChild(table);
  }

  function bulkSummary() {
    if (!bulk.rows.length) return '—';
    const n = bulkDataRows().length;
    return n + '行' + (bulk.encoding ? ' / ' + bulk.encoding : '');
  }

  function syncBulkHint() {
    setText('hint-bulk', bulkSummary());
  }

  // 読み込んだファイルの見出し。行数は「これから作る枚数」＝データ行で数える。
  // 見出し行を含めた総数を出すと、右肩の要約や書き出した枚数と1つずれる。
  function syncBulkFileName() {
    setText('bulk-file-name', bulk.fileName
      ? bulk.fileName + '（' + bulkDataRows().length + '行）' : '');
  }

  function bulkRefresh() {
    bulkFillSheetSelect();
    bulkFillSelects();
    bulkPreview();
    syncBulkFileName();
    syncBulkHint();
    $('bulk-report').innerHTML = '';
  }

  // 先頭が PK なら ZIP、つまり xlsx（拡張子を変えられていても中身で決める）
  function looksXlsx(buf, name) {
    const u = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
    const pk = u.length >= 2 && u[0] === 0x50 && u[1] === 0x4B;
    return pk || /\.xlsx$/i.test(String(name || ''));
  }

  async function loadBulkFile(file) {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      showToast('ファイルが大きすぎます（8MBまで）', 'error');
      return;
    }
    try {
      const buf = await file.arrayBuffer();
      let out, encoding;
      let sheets = [];
      let pickAt = 0;
      if (looksXlsx(buf, file.name)) {
        if (!window.QRXlsx || !window.QRXlsx.canRead()) {
          showToast('この環境ではExcelブックを開けません。CSVで保存し直してください', 'error');
          return;
        }
        const book = await window.QRXlsx.read(buf);
        // 隠しシート（選択肢の置き場）は選ばせない
        sheets = book.sheets.filter(sh => !sh.hidden);
        if (!sheets.length) sheets = book.sheets;
        // いま選んでいる種類のタブ → 中身のあるタブ → 先頭、の順で当てる
        let at = bulkSheetForType(sheets, currentType().name);
        if (at < 0) at = sheets.findIndex(bulkSheetHasData);
        if (at < 0) at = 0;
        out = { rows: sheets[at].rows };
        encoding = excelLabel(sheets[at]);
        pickAt = at;
      } else {
        const parsed = window.QRBulk.decodeText(buf);
        out = window.QRBulk.parse(parsed.text);
        encoding = parsed.encoding;
      }
      if (!out.rows.length) {
        showToast('ファイルに行がありません', 'error');
        return;
      }
      bulk.sheets = sheets;
      bulk.sheetAt = pickAt;
      bulk.rows = out.rows;
      bulk.fileName = file.name;
      bulk.encoding = encoding;
      // 別のファイルなら列の並びも違う。前の選択は引き継がず、見出しから引き直す
      clearBulkPicked();
      $('bulk-setup').classList.remove('hidden');
      // 見出しらしさは、1行目に「作れない中身」が並んでいるかでは決められない。
      // 素直に既定を on にしておき、表を見て外してもらう
      bulkRefresh();
    } catch (e) {
      const message = String(e && e.message);
      showToast(message === 'not xlsx'
        ? 'Excelブックとして読めませんでした（.xlsx で保存されているか確かめてください）'
        : message === 'xlsx too large'
        ? 'Excelブックの展開サイズ・シート数・行数が大きすぎます'
        : 'ファイルを読み込めませんでした', 'error');
    }
  }

  function clearBulk() {
    bulk.rows = [];
    bulk.sheets = [];
    bulk.sheetAt = 0;
    bulk.fileName = '';
    bulk.encoding = '';
    $('bulk-setup').classList.add('hidden');
    $('bulk-preview').innerHTML = '';
    $('bulk-report').innerHTML = '';
    syncBulkFileName();
    syncBulkHint();
  }

  function setBulkProgress(done, total, note) {
    const box = $('bulk-progress');
    box.classList.remove('hidden');
    $('bulk-bar-fill').style.width = (total ? Math.round((done / total) * 100) : 0) + '%';
    $('bulk-progress-text').textContent = note || (done + ' / ' + total);
  }

  const BULK_FORMATS = {
    png:  { ext: 'png',  mime: 'image/png',  quality: undefined },
    avif: { ext: 'avif', mime: 'image/avif' },
    webp: { ext: 'webp', mime: 'image/webp' },
    svg:  { ext: 'svg',  mime: '' }
  };

  async function runBulk() {
    if (bulk.running) { bulk.abort = true; return; }
    // 判定待ちや確認ダイアログのあいだに押し直されても、2本目を走らせない
    if (bulk.starting) return;
    const rows = bulkDataRows();
    if (!rows.length) { showToast('読み込んだ行がありません', 'error'); return; }
    bulk.starting = true;
    let ok;
    try { ok = await okToExport(); } finally { bulk.starting = false; }
    if (!ok) return;

    const type = currentType();
    if (!bulkMappedFields(type).length) {
      showToast('CSVの列をひとつも当てていません', 'error');
      return;
    }
    const fmt = BULK_FORMATS[$('bulk-format').value] || BULK_FORMATS.png;
    // AVIF のエンコードはメインスレッドを止める。可逆の「小ささ優先」は
    // 1枚4秒ほどかかり、そのあいだ「中止」も効かないので、一括では「ふつう」まで。
    const isAvif = fmt.ext === 'avif';
    const bulkAvif = Object.assign(avifOptions(), { effort: Math.min(state.effort, 2) });

    const over = rows.length > BULK_MAX ? rows.length - BULK_MAX : 0;
    const use = over ? rows.slice(0, BULK_MAX) : rows;

    // デザインは全行で同じ。フレームの文字も、画面で入れた値のまま出る。
    // 走っているあいだに画面で色を触っても途中から変わらないよう、押した時点の
    // ものを丸ごと写して使う（merge は入れ子まで写す）
    const baseStyle = window.QRStyle.merge(window.QRStyle.DEFAULTS, state.style);

    const btn = $('btn-bulk-run');
    bulk.running = true;
    bulk.abort = false;
    btn.textContent = '中止する';
    $('bulk-report').innerHTML = '';
    setBulkProgress(0, use.length, '書体を用意しています…');
    setStatus('bulk', '');

    const files = [];
    let totalBytes = 0;
    const skipped = [];   // 中身が空だった行
    const failed = [];    // 入りきらなかった行
    const invalid = [];   // 選べない値が書かれていた行（{ line, label, raw, words }）
    const take = window.QRBulk.nameTaker();
    const headOffset = bulkUseHeader() ? 2 : 1;
    const digits = String(use.length).length;
    const pad = n => String(n).padStart(digits, '0');
    const manifest = [['行', 'ファイル名', '中身']];

    try {
      // デザインは全行で同じなので、書体の取り寄せも最初の1回で済む
      const faceCss = await exportFontCss(baseStyle);

      for (let i = 0; i < use.length; i++) {
        if (bulk.abort) break;
        // 進み具合と「中止」は、飛ばした行でも動かす。ここを行の処理の後ろに
        // 置くと、空行が続いたときだけバーが止まって固まったように見える。
        // canvas.toBlob と decode() のあいだは画面が止まるので、数件ごとに返す
        // AVIF は1枚が重いので、1枚ごとに返して「中止」を効かせる。
        if (isAvif || i % BULK_YIELD === 0) {
          setBulkProgress(i, use.length);
          await new Promise(r => setTimeout(r, 0));
          if (bulk.abort) break;
        }
        const row = use[i];
        const lineNo = i + headOffset;
        const built = bulkPayload(type, row);
        // 選べない値は、黙って既定値に倒さない。形の正しいQRができてしまうと、
        // 読み取り検査も通り、刷ってから気づくことになる。
        if (built.errors.length) {
          const e = built.errors[0];
          invalid.push({ line: lineNo, label: e.label, raw: e.raw, words: e.words });
          continue;
        }
        const text = built.text;
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

        let svg = window.QRStyle.render(qr, baseStyle).svg;
        if (faceCss) svg = window.QRStyle.embedFontCss(svg, faceCss);

        const name = take('qr-' + pad(i + 1), fmt.ext);

        let bytes;
        if (fmt.ext === 'svg') {
          // 1枚ずつの書き出しと同じく、mm 指定ならその寸法で出す
          bytes = new TextEncoder().encode(svgDocument(svg));
        } else {
          const canvas = await rasterize(svg, outputPx(), null);
          const blob = await encodeCanvas(canvas, fmt.mime, bulkAvif);
          if (!blob) { failed.push(lineNo); continue; }
          bytes = new Uint8Array(await blob.arrayBuffer());
        }

        totalBytes += bytes.length;
        if (totalBytes > BULK_BYTES_MAX) throw new Error('zip too large');
        files.push({ name: name, bytes: bytes });
        // QR に埋める本文は変えず、表計算ソフトで開く一覧側だけ数式を無害化する。
        manifest.push([String(lineNo), name, spreadsheetText(text)]);
      }

      if (!files.length) {
        showToast(bulk.abort ? '中止しました'
          : invalid.length ? '選べない値が書かれていて、1件も作れませんでした'
          : 'QRコードにできる行がありませんでした',
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
      }

      bulkReport({
        made: files.length ? files.length - 1 : 0,
        skipped: skipped, failed: failed, invalid: invalid,
        over: over, aborted: bulk.abort, ext: fmt.ext
      });
    } catch (e) {
      showToast(String(e && e.message) === 'zip too large'
        ? 'ZIPが大きすぎます。サイズを下げるか、行を分けてください'
        : exportFailMessage('一括生成'), 'error');
    } finally {
      bulk.running = false;
      bulk.abort = false;
      btn.textContent = 'まとめて作る';
      $('bulk-progress').classList.add('hidden');
      setStatus('ready', 'idle');
    }
  }

  // CSV のセル。区切り・引用符・改行が入っていたら引用符でくるむ
  // 区切りの見分けは引用符の外だけを数えるので、「;」やタブを含むセルも
  // 囲んでおく。囲まないと WIFI: の「;」だらけの行がセミコロン区切りに
  // 見えてしまい、読み直したときに列がばらばらになる。
  function spreadsheetText(v) {
    const s = String(v == null ? '' : v);
    // 引用符で囲むだけでは Excel 等の数式評価は止まらない。先頭の空白を
    // 飛ばした位置に数式記号がある場合も含め、文字列として扱わせる。
    return (/^[\u0000-\u0020]*[=+\-@]/.test(s) || /^[\t\r\n]/.test(s)) ? "'" + s : s;
  }

  function csvCell(v) {
    const s = String(v == null ? '' : v);
    const q = String.fromCharCode(34);
    const marks = [',', ';', q, String.fromCharCode(9),
      String.fromCharCode(10), String.fromCharCode(13)];
    const needs = marks.some(m => s.indexOf(m) >= 0);
    return needs ? q + s.split(q).join(q + q) + q : s;
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
    // 何をどう直せばよいかまで書く。行番号だけだと、結局CSVと画面を往復させる。
    if (r.invalid.length) {
      const e = r.invalid[0];
      notes.push('選べない値が書かれていた行：' + lineList(r.invalid.map(v => v.line)) +
        '（例：' + e.line + '行目「' + e.label + '：' + e.raw + '」→ 書ける値は ' +
        (e.words || []).join('') + '）');
    }
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
    const sel = $('bulk-format');
    if (sel) showIf('bulk-format-note', sel.value === 'avif');
  }

  function wireBulk() {
    const fmtSel = $('bulk-format');
    if (fmtSel) {
      fmtSel.addEventListener('change', syncBulkFormatNote);
      syncBulkFormatNote();
    }

    if (!window.QRBulk) return;
    const zone = $('bulk-drop'), input = $('bulk-file');
    setupDropzone({
      dropzone: zone,
      fileInput: input,
      onFiles: files => loadBulkFile(files[0])
    });
    $('btn-bulk-clear').addEventListener('click', clearBulk);
    $('bulk-header').addEventListener('change', bulkRefresh);
    const sheetSel = $('bulk-sheet');
    if (sheetSel) {
      sheetSel.addEventListener('change', () => {
        bulkUseSheet(Number(sheetSel.value) || 0);
        // シートが変われば列の並びも変わる。当てた列は引き直す
        clearBulkPicked();
        bulkRefresh();
      });
    }
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
      designDragged();
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
        update();
      });
    }
  }

  // 見た目を変えるセグメント。押せばテンプレートから外れたことになるので、
  // presetName を消して描き直すところまでが一式。
  function bindSeg(hostId, attr, apply) {
    eachSegButton(hostId, b => {
      b.addEventListener('click', () => {
        apply(b.dataset[attr]);
        designChanged();
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
      designDragged();
    });
    input.addEventListener('change', verifyOnCommit);
  }

  // ---- 画像の受け口 --------------------------------------------------
  // ドロップとファイル選択の配線は、行き先が違うだけで中身は同じ。
  // before は「押される前にやること」（色パネルは、いま触っている対象を移す）。

  // 落とされたものを受けるだけの部分。プレビュー領域のように、
  // ファイル選択ボタンを持たない場所でも使う。
  // 枠そのもの（クリック・Enter/Space・ファイル選択・ドラッグ中の見た目・ファイルの受け取り）は
  // ツール共通の STCommon.setupDropzone に任せる。
  // fileId を渡さなければ、落とすだけの領域（プレビュー）として使える。
  function wireImageDrop(zoneId, fileId, target, before) {
    const zone = asEl(zoneId);
    if (!zone) return;
    setupDropzone({
      dropzone: zone,
      fileInput: fileId ? asEl(fileId) : null,
      onFiles: files => { if (before) before(); loadImageFile(files[0], target); }
    });
  }

  // 画像を外す。file 欄は setupDropzone が選んだ直後に空にしているので、同じファイルを選び直せる
  function wireImageClear(btnId, clear) {
    const btn = asEl(btnId);
    if (!btn) return;
    btn.addEventListener('click', () => {
      clear();
      designChanged();
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
      paintOf(scope).type = v;
    });

    bindColor(cq(scope, 'color-picker'), cq(scope, 'color-hex'), v => {
      touch();
      paintOf(scope).color = v;
    });
    bindRange(cq(scope, 'angle'), cq(scope, 'val-angle'), v => v + '°', v => {
      touch();
      paintOf(scope).angle = v;
    });
    bindRange(cq(scope, 'transparency'), cq(scope, 'val-transparency'), v => Math.round(v) + '%', v => {
      touch();
      paintOf(scope).transparency = Math.round(v);
    });

    const addColor = cq(scope, 'btn-add-color');
    if (addColor) addColor.addEventListener('click', () => {
      touch();
      const p = paintOf(scope);
      if (p.colors.length >= MAX_MULTI_COLORS) return;
      const candidates = ['#EF4444', '#F59E0B', '#10B981', '#06B6D4', '#6366F1', '#EC4899', '#8B5CF6', '#14B8A6'];
      p.colors.push(candidates.find(c => p.colors.indexOf(c) < 0) ||
        candidates[Math.floor(Math.random() * candidates.length)]);
      designChanged();
    });

    const shuffleColor = cq(scope, 'btn-shuffle-color');
    if (shuffleColor) shuffleColor.addEventListener('click', () => {
      touch();
      const p = paintOf(scope);
      p.seed = (p.seed || 0) + 1;
      update();
    });

    const addGrad = cq(scope, 'btn-add-grad-color');
    if (addGrad) addGrad.addEventListener('click', () => {
      touch();
      const p = paintOf(scope);
      if (p.mid) return;
      p.mid = towardHex(p.from, p.to, 0.5);
      designChanged();
    });

    // 画像
    wireImageDrop(cq(scope, 'image-drop'), cq(scope, 'image-file'),
      IMAGE_TARGETS.target, touch);
    bindRange(cq(scope, 'image-scale'), cq(scope, 'val-image-scale'), v => Math.round(v) + '%', v => {
      touch();
      paintOf(scope).imgScale = Math.round(v) / 100;
    });
    const scaleReset = cq(scope, 'btn-image-scale-reset');
    if (scaleReset) scaleReset.addEventListener('click', () => {
      touch();
      paintOf(scope).imgScale = 1;
      designChanged();
    });

    wireImageClear(cq(scope, 'btn-image-clear'), () => {
      touch();
      const p = paintOf(scope);
      p.src = '';
      p.type = COLOR_SCOPE_META[scope].clearType;
    });
  }

  // マーカーの枠と目の色パネルは中身が同じなので、縦に２枚並べず切り替えで見せる。
  // 状態は持たない（どちらの色も常に生きている）ただの表示切り替え。
  function wireMarkerColorToggle() {
    eachSegButton('marker-color-seg', b => {
      b.addEventListener('click', () => {
        const part = b.dataset.part;
        eachSegButton('marker-color-seg', o => setActive(o, o === b));
        ['frame', 'eye'].forEach(scope => showIf(colorPanel(scope), scope === part));
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
    eachSegButton('size-unit-seg', b => {
      b.addEventListener('click', () => {
        state.sizeUnit = b.dataset.unit === 'mm' ? 'mm' : 'px';
        syncSizeUnit();
        saveNow();
      });
    });

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
    eachSegButton('compress-seg', b => {
      b.addEventListener('click', () => {
        state.lossless = b.dataset.mode === 'lossless';
        syncCompress();
        saveNow();
      });
    });
    const inQuality = $('opt-quality');
    if (inQuality) {
      inQuality.addEventListener('input', () => {
        state.quality = Math.round(clampNum(inQuality.value, QUALITY_MIN, QUALITY_MAX, 95));
        setText('val-compress', String(state.quality));
      });
      inQuality.addEventListener('change', saveNow);
    }
    const inEffort = $('opt-effort');
    if (inEffort) {
      inEffort.addEventListener('input', () => {
        state.effort = Math.round(clampNum(inEffort.value, 1, 3, 2));
        setText('val-compress', EFFORT_WORDS[state.effort]);
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
      // ロゴは既定でアイコンを持たない。選ばないまま切り替えたら、開いている一覧の先頭を置く
      if (v === 'icon' && !state.style.logo.iconData) {
        setLogoIcon(A.ICONS.find(i => i.group === state.iconGroup) || A.ICONS[0]);
      }
    });

    bindRange('opt-cellscale', 'val-cellscale', pct, v => {
      state.style.cellScale = v;
      updateFrameGridPreviews();
    });
    bindRange('opt-celljitter', 'val-celljitter', pct, v => { state.style.cellJitter = v; });
    bindRange('opt-margin', 'val-margin', v => String(v), v => {
      state.style.margin = v;
      // 角丸の上限は余白で決まる。余白を詰めたぶん、はみ出した丸みは先に削る
      const cap = maxRadiusOf(v);
      if (state.style.radius > cap) state.style.radius = cap;
      syncControls();
    });
    bindRange('opt-radius', 'val-radius', v => String(v), v => { state.style.radius = v; });
    bindRange('opt-minver', 'val-minver', fmtMinVersion, v => { state.minVersion = v; });
    bindRange('logo-size', 'val-logosize', pct, v => { state.style.logo.size = v; });
    bindRange('logo-pad', 'val-logopad', pct, v => { state.style.logo.pad = v; });
    bindRange('frame-line-width', 'val-frame-line-width', fmtLineWidth, v => { state.style.frame.lineWidth = v; });
    bindRange('frame-line-width2', 'val-frame-line-width2', fmtLineWidth, v => { state.style.frame.lineWidth2 = v; });
    bindRange('frame-content-size', 'val-frame-content-size', pct, v => { state.style.frame.contentSize = v; });
    bindRange('frame-content-pad', 'val-frame-content-pad', pct, v => { state.style.frame.contentPad = v; });

    $('logo-text').addEventListener('input', e => {
      state.style.logo.text = e.target.value;
      state.presetName = '';
      scheduleUpdate();
    });

    bindSeg('logo-font-seg', 'font', v => {
      state.style.logo.font = v;
    });

    // フレーム位置・種類・内容
    bindSeg('frame-pos-seg', 'pos', v => {
      const fr = state.style.frame;
      // 上を使う配置へ移るとき、上の文字がまだ無ければ下の文字から起こす。
      // qr-style.js は textTop が空だと text へ落とすので、空欄のまま見せると
      // 画面（空）と実際の絵（下の文字が上にも出る）が食い違う。
      if ((v === 'top' || v === 'both') && !fr.textTop) fr.textTop = fr.text || '';
      fr.pos = v;
    });

    bindSeg('frame-content-mode-seg', 'mode', v => {
      // アイコンの実体は sanitizeStyle が必ず埋めているので、切り替えるだけでよい
      state.style.frame.contentMode = v;
      state.style.frame.topContentMode = v;
    });

    bindSeg('frame-font-seg', 'font', v => {
      state.style.frame.font = v;
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

    // アイコンの一覧の切り替え（ロゴ用とラベル用）。一覧を替えるとブランドカラーを
    // 出せるかどうかが変わり、syncControls が 'brand' を 'auto' へ寄せる。描き直さないと、
    // 画面だけブランド色のまま取り残される。タブの印は syncControls が付ける。
    [['icon-tabs', 'iconGroup', buildIconGrid],
     ['frame-icon-tabs', 'frameIconGroup', buildFrameIconGrid]].forEach(([hostId, key, rebuild]) => {
      eachSegButton(hostId, b => {
        b.addEventListener('click', () => {
          state[key] = b.dataset.group;
          rebuild();
          syncControls();
          update();
        });
      });
    });

    // ---- ロゴ画像 ----
    wireImageDrop('logo-drop', 'logo-file', IMAGE_TARGETS.logo);
    wireImageClear('btn-logo-clear', () => {
      state.style.logo.src = '';
      state.style.logo.type = 'none';
    });

    // ---- フレーム画像 ----
    wireImageDrop('frame-image-drop', 'frame-image-file', IMAGE_TARGETS.frame);
    wireImageClear('btn-frame-image-clear', () => {
      state.style.frame.src = '';
      state.style.frame.topSrc = '';
    });

    // ---- プレビュー領域への画像ドロップ（選択中の対象画像として反映） ----
    wireImageDrop('canvas-card', null, IMAGE_TARGETS.target);

    // ---- プレビュー市松模様の明暗切り替え ----
    eachSegButton('checker-toggle', btn => {
      btn.addEventListener('click', () => {
        state.previewChecker = btn.dataset.checker || 'auto';
        updateCanvasChecker();
        saveNow();
      });
    });

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
      // 既定の見た目をテンプレートと同じ入口から当てる。セルの密度も「自動」に
      // 戻す（密度だけ style ではなく state 側にある）
      applyStyle({}, '', { minVersion: 1 });
      showToast('デザインを初期化しました');
    });

    // このボタンは開け閉めだけ。保存するのは引き出しの中の1本に絞る。
    // 「AVIFで保存」を押しても保存されないのが、いちばん分かりにくかった。
    function toggleCompress(fmt) {
      if (compressFor === fmt) { closeCompress(); return; }
      openCompress(fmt);
    }

    $('btn-png').addEventListener('click', () => exportRaster('image/png', 'png'));
    $('btn-avif').addEventListener('click', () => toggleCompress('avif'));
    $('btn-webp').addEventListener('click', () => toggleCompress('webp'));
    const btnCompressSave = $('btn-compress-save');
    if (btnCompressSave) btnCompressSave.addEventListener('click', () => {
      if (compressFor) exportRaster(COMPRESS_MIME[compressFor], compressFor);
    });
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
      if (e.key === 'Escape') {
        const fsModal = $('fullscreen-modal');
        if (fsModal && !fsModal.classList.contains('hidden')) {
          closeFullscreen();
          return;
        }
        const optCompress = $('opt-compress');
        if (optCompress && !optCompress.classList.contains('hidden')) {
          // closeCompress を通す。class を直接落とすと compressFor と
          // ボタンの is-open / aria-expanded が開いたままで取り残される。
          const opener = $('btn-' + (compressFor || 'avif'));
          closeCompress();
          if (opener) opener.focus();
          return;
        }
        if (bulk.running) {
          bulk.abort = true;
          const btn = $('btn-bulk-run');
          if (btn) btn.textContent = '中止しています…';
          return;
        }
      }
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

      // 文字を打てる欄では、ブラウザ自身の取り消しに任せる（内容欄に限らず、
      // ロゴの文字なども同じ）。スライダーや色などは、こちらの履歴で戻す。
      const target = e.target;
      const isContentField = !!target && (target.tagName === 'TEXTAREA' || target.isContentEditable ||
        (target.tagName === 'INPUT' &&
          ['text', 'search', 'url', 'email', 'tel', 'password', 'number'].indexOf(target.type) >= 0));

      const key = String(e.key).toLowerCase();
      if ((key !== 'z' && key !== 'y') || isContentField) return;
      e.preventDefault();
      // Ctrl+Y と Shift 付きの Z はやり直し
      if (key === 'y' || e.shiftKey) redo();
      else undo();
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

  function getTargetLabel() {
    const meta = COLOR_SCOPE_META[state.colorScope];
    return meta ? meta.label : '背景';
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
    designChanged();
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

    rebuildDesignUI();
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

    // 保存が無いときの既定も、復元したときと同じ形に揃えておく（iconData の
    // 引き直しなど）。以後の画面の同期は、値がそろっている前提で書いてある
    sanitizeStyle(state.style);
    restore();

    buildTypeChips();
    buildTypeFields();
    buildPresetCategoryChips();
    buildPresets();
    buildShapeGrids();
    buildColorPanels();
    buildIconGrid();
    buildFrameIconGrid();
    buildFrameChips();
    buildTemplateGrid();
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
    resetHistory();
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
