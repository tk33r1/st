/* Shared "ask" panel for SAFE TOOLS pages.
 *
 * ツールが仕事を終えた瞬間（ダウンロード・保存・書き出し）にだけ、
 * 「役に立ったならシェアと支援を」と一度だけ小さく声をかけるための共通部品。
 * 依存なしの自給自足（スタイルも自前で注入する）。tools-ui.css があるページ
 * ではそのトークンに載るので、ツールごとのアクセント色に自動で馴染む。
 *
 * 使い方 — ダウンロード処理の最後で呼ぶだけ:
 *
 *   window.STShare && STShare.celebrate();
 *
 * 見出し・本文・共有文はページの JSON-LD / og:title / canonical から
 * 自動で組み立てるので、通常は引数不要。上書きしたいときだけ渡す:
 *
 *   STShare.celebrate({
 *     toolName : 'NextGen Image',   // 既定: パンくずの末尾 → og:title の左側
 *     url      : 'https://...',     // 既定: canonical → og:url → 現在地
 *     text     : '共有文',           // 既定: og:title
 *     hashtags : ['SAFETOOLS'],     // 既定: なし
 *     feedbackUrl: 'https://...',   // 既定: /contact/（件名にツール名が入る）
 *     after    : 1,                 // 何回目の完了で出すか（既定 1）
 *     delay    : 1200,              // 完了から表示までの ms（既定 1200）
 *     force    : false              // 抑制記録を無視して必ず出す
 *   });
 *
 * 出しすぎない仕掛け（記録は localStorage の一箇所に集約する。ツール横断で
 * 共有するので、3つのツールを続けて使った人に3回聞くことはない）:
 *   - 1セッションにつき最大1回
 *   - 一度出したら 21 日は出さない
 *   - シェアや支援に進んでくれたら 180 日は出さない
 *   - 「今後は表示しない」を押されたら実質永久に出さない
 *
 * デバッグ: URL に ?st-share=preview を付けると抑制を無視して即表示。
 *           STShare.reset() で記録を消す。
 */
(function (global) {
  'use strict';

  var STORE_KEY = 'st-share-prompt';
  var DAY = 86400000;
  var COOLDOWN_SHOWN = 21 * DAY;    // 見せたあとの通常の間隔
  var COOLDOWN_ACTED = 180 * DAY;   // 応えてくれた人には当分聞かない
  var COOLDOWN_OPTOUT = 3650 * DAY;
  var AUTO_HIDE_MS = 22000;
  var NL = String.fromCharCode(10);

  // localStorage が使えない環境（プライベートウィンドウ、サイトデータ拒否）
  // でも「セッション中に何度も出る」ことだけは避けたいので、同じ形の
  // オブジェクトをメモリにも持っておく。
  var memStore = {};
  var shownThisSession = false;
  var completions = 0;
  var pendingTimer = null;
  var current = null; // 表示中のカード

  function readStore() {
    try {
      var raw = global.localStorage.getItem(STORE_KEY);
      return raw ? (JSON.parse(raw) || {}) : {};
    } catch (e) {
      return memStore;
    }
  }

  function writeStore(obj) {
    memStore = obj;
    try {
      global.localStorage.setItem(STORE_KEY, JSON.stringify(obj));
    } catch (e) { /* サイトデータが使えないだけ。機能は落とさない */ }
  }

  function suppressFor(ms) {
    var store = readStore();
    store.v = 1;
    store.next = Date.now() + ms;
    store.count = (store.count || 0) + 1;
    writeStore(store);
  }

  function isPreview() {
    try {
      return new URLSearchParams(global.location.search).get('st-share') === 'preview';
    } catch (e) {
      return false;
    }
  }

  // ---- ページから素性を読む ------------------------------------------------

  function meta(selector, attr) {
    var el = document.querySelector(selector);
    return el ? (el.getAttribute(attr) || '').trim() : '';
  }

  function pageTitle() {
    return meta('meta[property="og:title"]', 'content') ||
      (document.title || '').split('|')[0].trim();
  }

  function pageUrl() {
    var url = meta('link[rel="canonical"]', 'href') || meta('meta[property="og:url"]', 'content');
    if (url) return url;
    // クエリとハッシュは作業中の状態でしかないので、共有する URL からは落とす。
    return global.location.origin + global.location.pathname;
  }

  function toolName() {
    // パンくずの JSON-LD があればその末尾が一番正確（「NextGen Image」）。
    // なければ og:title を区切りで割って左側を取る。
    var blocks = document.querySelectorAll('script[type="application/ld+json"]');
    for (var b = 0; b < blocks.length; b++) {
      try {
        var data = JSON.parse(blocks[b].textContent);
        var graph = data['@graph'] || [data];
        for (var i = 0; i < graph.length; i++) {
          var list = graph[i] && graph[i].itemListElement;
          if (list && list.length) {
            var last = list[list.length - 1];
            if (last && last.name) return String(last.name);
          }
        }
      } catch (e) { /* 読めない JSON-LD は飛ばす */ }
    }
    return pageTitle().split(/\s+[-–—]\s+/)[0].trim() || 'このツール';
  }

  // ---- スタイル ------------------------------------------------------------

  var STYLE_ID = 'st-share-style';

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '.st-share-card{',
      '  position:fixed; right:20px; bottom:68px; z-index:110;',
      '  width:min(340px, calc(100vw - 32px));',
      '  box-sizing:border-box; padding:16px 16px 13px;',
      '  border:1px solid var(--rule, #E3E7EA);',
      '  border-radius:var(--r-2, 10px);',
      '  background:var(--panel, #FFFFFF);',
      '  color:var(--ink, #15191D);',
      '  font-family:var(--font-ui, system-ui, sans-serif);',
      '  box-shadow:var(--shadow-1, 0 1px 2px rgb(15 25 35 / .06), 0 8px 24px rgb(15 25 35 / .05));',
      '  opacity:0; transform:translateY(10px);',
      '  transition:opacity 240ms ease, transform 240ms ease;',
      '}',
      '.st-share-card.st-share-in{opacity:1; transform:none;}',
      /* 下辺の 68px はスクロールトップボタン、中央のトーストとも重ならない高さ。 */
      '@media (max-width:560px){',
      '  .st-share-card{left:12px; right:12px; bottom:72px; width:auto;}',
      '}',
      '@media (prefers-reduced-motion: reduce){',
      '  .st-share-card{transition:opacity 120ms linear; transform:none;}',
      '}',
      '.st-share-head{display:flex; align-items:flex-start; gap:8px; margin:0 0 6px;}',
      '.st-share-title{',
      '  margin:0; flex:1 1 auto;',
      '  font-size:13.5px; font-weight:600; line-height:1.45; letter-spacing:.01em;',
      '}',
      '.st-share-mark{',
      '  flex:0 0 auto; width:18px; height:18px; margin-top:1px;',
      '  color:var(--accent, #0F766E);',
      '}',
      '.st-share-mark svg{width:100%; height:100%; display:block;}',
      '.st-share-close{',
      '  flex:0 0 auto; width:24px; height:24px; margin:-3px -4px 0 0; padding:0;',
      '  display:flex; align-items:center; justify-content:center;',
      '  border:0; background:none; border-radius:var(--r-1, 6px);',
      '  color:var(--ink-3, #8C949B); cursor:pointer;',
      '}',
      '.st-share-close:hover{color:var(--ink, #15191D); background:var(--panel-2, #F1F3F5);}',
      '.st-share-close svg{width:14px; height:14px;}',
      '.st-share-body{',
      '  margin:0 0 12px; font-size:12px; line-height:1.7; color:var(--ink-2, #5C666E);',
      '}',
      '.st-share-row{display:flex; flex-wrap:wrap; gap:8px; margin-bottom:8px;}',
      '.st-share-btn{',
      '  flex:1 1 auto; min-width:0;',
      '  display:inline-flex; align-items:center; justify-content:center; gap:6px;',
      '  padding:8px 10px; border-radius:var(--r-1, 6px);',
      '  border:1px solid var(--rule, #E3E7EA); background:var(--panel, #FFFFFF);',
      '  color:var(--ink, #15191D);',
      '  font-family:inherit; font-size:12px; font-weight:500; line-height:1.2;',
      '  white-space:nowrap; cursor:pointer;',
      '  transition:border-color 120ms ease, color 120ms ease, background 120ms ease;',
      '}',
      '.st-share-btn:hover{border-color:var(--accent, #0F766E); color:var(--accent, #0F766E);}',
      '.st-share-btn:focus-visible, .st-share-close:focus-visible, .st-share-quiet:focus-visible{',
      '  outline:2px solid var(--accent, #0F766E); outline-offset:2px;',
      '}',
      '.st-share-btn svg{width:14px; height:14px; flex:0 0 auto;}',
      '.st-share-btn--oil{',
      '  width:100%; flex:1 1 100%;',
      '  border-color:transparent;',
      '  background:var(--accent-soft, #E3F2F0); color:var(--accent, #0F766E);',
      '}',
      '.st-share-btn--oil:hover{background:var(--accent, #0F766E); color:var(--accent-ink, #FFFFFF);}',
      // 足元の2つは役割が逆向き（届ける／黙らせる）なので、左右に離して置く。
      '.st-share-foot{',
      '  display:flex; align-items:center; justify-content:space-between;',
      '  gap:10px; margin-top:11px;',
      '}',
      '.st-share-quiet{',
      '  padding:2px 0; border:0; background:none; cursor:pointer;',
      '  font-family:inherit; font-size:10.5px; line-height:1.5;',
      '  color:var(--ink-3, #8C949B);',
      '  text-decoration:underline; text-underline-offset:2px;',
      '}',
      '.st-share-quiet:hover{color:var(--ink-2, #5C666E);}'
    ].join(NL);
    document.head.appendChild(style);
  }

  // ---- アイコン（lucide が無いページでも欠けないよう素の SVG で持つ） ------

  function icon(paths, filled) {
    return '<svg viewBox="0 0 24 24" fill="' + (filled ? 'currentColor' : 'none') +
      '" stroke="' + (filled ? 'none' : 'currentColor') +
      '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      paths + '</svg>';
  }

  var ICON = {
    spark: icon('<path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"/><path d="M18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9z"/>'),
    close: icon('<path d="M6 18L18 6M6 6l12 12"/>'),
    x: icon('<path d="M18.9 2H22l-7 8 8.2 12H16l-5-7.3L5.4 22H2.3l7.5-8.6L2 2h6.9l4.5 6.6L18.9 2zm-1.1 18h1.7L7.3 3.8H5.5L17.8 20z"/>', true),
    link: icon('<path d="M10 13a5 5 0 007.5.5l2-2a5 5 0 00-7-7l-1.2 1.1"/><path d="M14 11a5 5 0 00-7.5-.5l-2 2a5 5 0 007 7L12.7 18"/>'),
    check: icon('<path d="M20 6L9 17l-5-5"/>'),
    share: icon('<path d="M12 3v12"/><path d="M8 7l4-4 4 4"/><path d="M5 13v6a2 2 0 002 2h10a2 2 0 002-2v-6"/>'),
    // 給油機 — フッターの Buy Me Oil ウィジェットと同じ物を指す。
    oil: icon('<path d="M3 22h12"/><path d="M4 9h10"/><path d="M14 22V4a2 2 0 00-2-2H6a2 2 0 00-2 2v18"/><path d="M14 13h2a2 2 0 012 2v2a2 2 0 002 2 2 2 0 002-2V9.8a2 2 0 00-.6-1.4L18 5"/>')
  };

  // ---- 表示 ----------------------------------------------------------------

  function dismiss(card) {
    if (!card || !card.parentNode) return;
    card.classList.remove('st-share-in');
    if (current === card) current = null;
    global.setTimeout(function () {
      if (card.parentNode) card.parentNode.removeChild(card);
    }, 260);
  }

  function openDonation() {
    // 寄付モーダルは buy-me-oil.js が持っている。開くための公開 API がないので、
    // フッターに置かれたトリガーを押す。読み込んでいないページでは Ko-fi を
    // 新しいタブで開いて代替する。
    var trigger = document.querySelector('.donation-widget-button');
    if (trigger) {
      trigger.click();
      return true;
    }
    global.open('https://ko-fi.com/tk33r1', '_blank', 'noopener');
    return false;
  }

  function copyText(text) {
    if (global.navigator.clipboard && global.navigator.clipboard.writeText) {
      return global.navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      if (ok) resolve(); else reject(new Error('copy failed'));
    });
  }

  function flash(btn, label) {
    var original = btn.innerHTML;
    btn.innerHTML = ICON.check + '<span></span>';
    btn.lastChild.textContent = label;
    global.setTimeout(function () { btn.innerHTML = original; }, 1600);
  }

  function button(extraClass, glyph, label) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'st-share-btn' + (extraClass ? ' ' + extraClass : '');
    b.innerHTML = glyph + '<span></span>';
    b.lastChild.textContent = label;
    return b;
  }

  function render(cfg) {
    injectStyle();
    if (current) dismiss(current);

    var card = document.createElement('section');
    card.className = 'st-share-card';
    card.setAttribute('aria-label', 'このツールを応援する');
    card.setAttribute('aria-live', 'polite');

    var head = document.createElement('div');
    head.className = 'st-share-head';

    var mark = document.createElement('span');
    mark.className = 'st-share-mark';
    mark.innerHTML = ICON.spark;

    var title = document.createElement('h2');
    title.className = 'st-share-title';
    title.textContent = cfg.heading;

    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'st-share-close';
    close.setAttribute('aria-label', '閉じる');
    close.innerHTML = ICON.close;

    head.appendChild(mark);
    head.appendChild(title);
    head.appendChild(close);

    var body = document.createElement('p');
    body.className = 'st-share-body';
    body.textContent = cfg.body;

    var row = document.createElement('div');
    row.className = 'st-share-row';

    // タッチ端末では OS の共有シートを出す（LINE でも Slack でも、その人が
    // ふだん使うところへ届く）。デスクトップの Chrome にも navigator.share は
    // あるが、そこは共有シートより X の intent のほうが素直に届く。
    var canWebShare = typeof global.navigator.share === 'function' &&
      global.navigator.maxTouchPoints > 0;
    var primary = canWebShare
      ? button('', ICON.share, 'シェアする')
      : button('', ICON.x, 'X でシェア');
    var copy = button('', ICON.link, 'リンクをコピー');
    row.appendChild(primary);
    row.appendChild(copy);

    var oil = button('st-share-btn--oil', ICON.oil, '開発を応援する');

    // 「役に立たなかった」人にも行き先を用意する。褒める導線しかないと、
    // 直せるはずの不満が黙って持ち帰られてしまう。
    var foot = document.createElement('div');
    foot.className = 'st-share-foot';

    var feedback = document.createElement('a');
    feedback.className = 'st-share-quiet';
    feedback.href = cfg.feedbackUrl;
    feedback.target = '_blank';
    feedback.rel = 'noopener noreferrer';
    feedback.textContent = '要望・不具合を伝える';

    var skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'st-share-quiet st-share-skip';
    skip.textContent = '今後は表示しない';

    foot.appendChild(feedback);
    foot.appendChild(skip);

    card.appendChild(head);
    card.appendChild(body);
    card.appendChild(row);
    card.appendChild(oil);
    card.appendChild(foot);
    document.body.appendChild(card);
    current = card;

    // 放っておけば自分で引っ込む。触っている間は待つ。
    var hideTimer = null;
    function stopHide() {
      if (hideTimer) { global.clearTimeout(hideTimer); hideTimer = null; }
    }
    function startHide() {
      stopHide();
      hideTimer = global.setTimeout(function () { dismiss(card); }, AUTO_HIDE_MS);
    }
    card.addEventListener('pointerenter', stopHide);
    card.addEventListener('focusin', stopHide);
    card.addEventListener('pointerleave', startHide);
    startHide();

    function onKey(e) {
      if (e.key !== 'Escape') return;
      dismiss(card);
      document.removeEventListener('keydown', onKey);
    }
    document.addEventListener('keydown', onKey);

    close.addEventListener('click', function () { dismiss(card); });

    skip.addEventListener('click', function () {
      if (!cfg.preview) suppressFor(COOLDOWN_OPTOUT);
      dismiss(card);
    });

    // 遷移は href に任せる（中クリックや「新しいタブで開く」を殺さないため）。
    // ここでやるのは、声を届けてくれた人にしばらく聞かないことだけ。
    feedback.addEventListener('click', function () {
      if (!cfg.preview) suppressFor(COOLDOWN_ACTED);
      dismiss(card);
    });

    primary.addEventListener('click', function () {
      if (!cfg.preview) suppressFor(COOLDOWN_ACTED);
      stopHide();
      if (canWebShare) {
        global.navigator.share({ title: cfg.shareTitle, text: cfg.text, url: cfg.url })
          .then(function () { dismiss(card); })
          .catch(function () { /* キャンセルはそのまま置いておく */ });
        return;
      }
      global.open(cfg.intentUrl, '_blank', 'noopener');
      dismiss(card);
    });

    copy.addEventListener('click', function () {
      if (!cfg.preview) suppressFor(COOLDOWN_ACTED);
      stopHide();
      copyText(cfg.url).then(function () {
        flash(copy, 'コピーしました');
      }, function () {
        flash(copy, 'コピーできません');
      });
      startHide();
    });

    oil.addEventListener('click', function () {
      if (!cfg.preview) suppressFor(COOLDOWN_ACTED);
      stopHide();
      openDonation();
      dismiss(card);
    });

    // 1フレーム置いてからクラスを足さないと transition が走らない。
    global.requestAnimationFrame(function () {
      global.requestAnimationFrame(function () { card.classList.add('st-share-in'); });
    });

    return card;
  }

  function buildConfig(opts) {
    opts = opts || {};
    var name = opts.toolName || toolName();
    var url = opts.url || pageUrl();
    var text = opts.text || pageTitle();
    var params = new URLSearchParams();
    params.set('text', text);
    params.set('url', url);
    if (opts.hashtags && opts.hashtags.length) params.set('hashtags', opts.hashtags.join(','));

    return {
      heading: opts.heading || 'お役に立てましたか？',
      body: opts.body ||
        (name + ' は登録不要・無料で、ファイルはあなたのブラウザの中だけで処理しています。' +
          'ひとこと広めてもらえると、次をつくる力になります。'),
      shareTitle: text,
      text: text,
      url: url,
      intentUrl: 'https://twitter.com/intent/tweet?' + params.toString(),
      // /contact/ は Turnstile を通してからメーラーを開くページ。どのツールの
      // 話かが分からないと直しようがないので、件名にツール名を載せて渡す。
      feedbackUrl: opts.feedbackUrl ||
        ('https://tk.st/contact/?subject=' + encodeURIComponent('[' + name + '] 改善のご提案')),
      preview: !!opts.preview
    };
  }

  // ---- 公開 API ------------------------------------------------------------

  // 抑制記録を無視してその場で出す。プレビューや、呼び出し側で頻度を
  // 決めたいときだけ使う。ふだんは celebrate を呼ぶ。
  function show(opts) {
    var cfg = buildConfig(opts);
    cfg.preview = true;
    return render(cfg);
  }

  function celebrate(opts) {
    opts = opts || {};
    completions += 1;

    var preview = opts.force === true || isPreview();
    if (!preview) {
      if (shownThisSession) return;
      if (completions < (opts.after || 1)) return;
      var store = readStore();
      if (store.next && Date.now() < store.next) return;
    }

    if (pendingTimer) global.clearTimeout(pendingTimer);
    var delay = opts.delay != null ? opts.delay : 1200;

    pendingTimer = global.setTimeout(function () {
      pendingTimer = null;
      // 裏に回ったタブに向かって出しても意味がない。戻ってくるまで待つ。
      if (document.hidden) {
        document.addEventListener('visibilitychange', function once() {
          document.removeEventListener('visibilitychange', once);
          if (document.hidden) return;
          completions -= 1; // 再入で二重に数えない
          celebrate(Object.assign({}, opts, { force: preview, delay: 500 }));
        });
        return;
      }
      if (!preview) {
        shownThisSession = true;
        suppressFor(COOLDOWN_SHOWN);
      }
      var cfg = buildConfig(opts);
      cfg.preview = preview;
      render(cfg);
    }, delay);
  }

  function hide() {
    if (pendingTimer) { global.clearTimeout(pendingTimer); pendingTimer = null; }
    dismiss(current);
  }

  function reset() {
    memStore = {};
    shownThisSession = false;
    completions = 0;
    try { global.localStorage.removeItem(STORE_KEY); } catch (e) { /* noop */ }
  }

  global.STShare = {
    celebrate: celebrate,
    show: show,
    hide: hide,
    reset: reset
  };
})(window);
