/* DJ リクエスト画面の、回の QR コードの画像を作る（window.EventQR）。
   dj/assets/dj-request-core.js（DJRequestCore）の後に読む。ダイアログの開閉と保存・共有はページ側。

   中身は共有と同じ ?ev= 付きの URL。絵は QR Palette（tools/qr-palette/）の
   エンコーダと描画エンジンをそのまま読み込んで作る。デザインは下の QR_STYLE に固定で持ち、
   上部のラベルに回の名前、下部に開いた日を差し込む。キーと値は QR Palette の画面の項目と対応している
   （qr-style.js の DEFAULTS が正。ここに書いていない項目は既定値のまま）。
   ライブラリとフォントは、押されたときに初めて読む（リクエストするだけの人には要らない）。
   パスはページ（dj/request/）からの相対で、ページの location を基準に解く。 */
(function (global) {
  'use strict';

  const { ymd } = global.DJRequestCore;

  const QR_LIB = '../../tools/qr-palette/';
  // 描画に要る QR Palette のファイル。この順に実行する（qr-export は qr-style を使う）
  const QR_FILES = ['qr-core.js', 'qr-assets.js', 'qr-style.js', 'qr-export.js'];
  const QR_FONT_CSS = '../../assets/fonts/jp.css';
  const QR_PX = 1024;          // 書き出す PNG の横幅
  const QR_LABEL_MAX = 24;     // QR Palette のラベル欄の上限と同じ

  const QR_STYLE = {
    cell: 'heart', cellScale: 0.9, cellJitter: 0.5,          // セル: ハート・太さ90%・バラつき50%
    fg: { type: 'multi', colors: ['#37F2E6', '#FF2F6E'] },   // セルの色: 多色
    markerFrame: 'cells', markerEye: 'heart',                 // マーカー: セル枠・ハート
    markerFramePaint: { type: 'auto' }, markerEyePaint: { type: 'auto' },   // マーカーの色: セルの色
    bg: { type: 'solid', color: '#121216', transparency: 0 }, // 背景: 単色・透明度0%
    // 暗い地に明るいセルを置く反転 QR は意図どおり（注意の段階を下げるだけ）
    invertOk: true,
    margin: 2, radius: 2.5,
    logo: {                                                    // 中央のロゴ: ベーシックの「音楽」
      type: 'icon', icon: 'bi-music-note-beamed', paint: { type: 'auto' },
      size: 0.14, pad: 0.02, backdrop: 'square', backdropPaint: { type: 'bg' },
    },
    frame: {                                                   // フレームと文字: 上下のラベル
      type: 'label', pos: 'both', contentMode: 'text', text: '',
      topContentMode: 'text', textTop: '', font: 'rounded',
      textPaint: { type: 'solid', color: '#FFFFFF', transparency: 0 },
      contentSize: 0.8, contentPad: 0.4,
      paint: { type: 'linear', from: '#37F2E6', mid: '', to: '#FF2F6E', angle: 45, transparency: 0 },
      backdrop: 'rounded', backdropPaint: { type: 'bg' },
    },
  };

  /* 回の名前を上、開いた日を下のラベルに差し込む。両方とも無ければ
     ラベルごと外す（文字の無い帯だけが出るため）。
     アイコンは id だけでは描かれないので、QR Palette と同じく同梱一覧の実体（iconData）を組で渡す。
     id が一覧から消えていたらロゴを外して描き、コンソールに知らせる（QR 自体は読めるので止めない） */
  function qrStyleFor(title, at) {
    const chars = Array.from(String(title || '').trim());
    const label = chars.length > QR_LABEL_MAX ? chars.slice(0, QR_LABEL_MAX - 1).join('') + '…' : chars.join('');
    const date = ymd(at);
    const icon = global.QRAssets.ICONS.find((i) => i.id === QR_STYLE.logo.icon);
    if (!icon) console.warn('QR のロゴのアイコンが見つかりません: ' + QR_STYLE.logo.icon);
    return {
      ...QR_STYLE,
      logo: icon ? { ...QR_STYLE.logo, iconData: icon } : { type: 'none' },
      frame: label || date ? { ...QR_STYLE.frame, textTop: label, text: date } : { type: 'none' },
    };
  }

  /* QR Palette のファイルは、毎回サーバーに新しいかを確かめて（cache: 'no-cache'。変わっていなければ
     304 で中身は来ない）から実行する。こちらで版の番号を持つと、QR Palette を直したときに上げ忘れて、
     古いファイルと新しいファイルが混ざりうる。取得は並べ、実行は QR_FILES の順に1本ずつ。
     実行できたファイルは覚えておき、失敗したファイル（とその後ろ）だけを次に押したときに読み直す
     （実行済みのファイルをもう一度実行しない） */
  const qrRan = new Map();   // ファイル名 → 実行し終えたら解決する Promise

  function runQRFile(file, after) {
    const url = new URL(QR_LIB + file, location.href).href;
    const code = fetch(url, { cache: 'no-cache' }).then((res) => {
      if (!res.ok) throw new Error('load ' + file + ' ' + res.status);
      return res.text();
    });
    return Promise.all([code, after]).then(([text]) => {
      const s = document.createElement('script');
      s.textContent = text + String.fromCharCode(10) + '//# sourceURL=' + url;   // 開発者ツールで元のファイル名が出るように
      document.head.appendChild(s);
    });
  }

  function loadQRLibs() {
    let prev = Promise.resolve();
    return Promise.all(QR_FILES.map((file) => {
      if (!qrRan.has(file)) {
        qrRan.set(file, runQRFile(file, prev).catch((e) => { qrRan.delete(file); throw e; }));
      }
      prev = qrRan.get(file);
      return prev;
    }));
  }

  // 同じ URL・同じ名前・同じ日付なら作り直さない（失敗したものは覚えない）。
  // ラベルの字のフォント埋め込みと画像化は QR Palette の書き出しと共用（qr-export.js）。
  // フォントの CSS はこのページが読み込んでいないので、場所を渡す
  const qrCache = new Map();
  function png(url, title, at) {
    const key = JSON.stringify([url, title, at]);
    if (!qrCache.has(key)) {
      qrCache.set(key, (async () => {
        await loadQRLibs();
        const style = qrStyleFor(title, at);
        const qr = global.QRCore.encode(url, { ec: 'H', minVersion: 1 });
        const css = await global.QRExport.fontCss(style, { cssUrl: QR_FONT_CSS });
        const canvas = await global.QRExport.rasterize(global.QRStyle.embedFontCss(global.QRStyle.render(qr, style).svg, css), QR_PX);
        return new Promise((resolve, reject) =>
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('png'))), 'image/png'));
      })().catch((e) => { qrCache.delete(key); throw e; }));
    }
    return qrCache.get(key);
  }

  global.EventQR = { png };
})(window);
