/* Shared UI helpers for SAFE TOOLS pages.
 * Exposes `window.STCommon` with utilities that the tool pages
 * (light-svg, nextgen-image, pdf-studio, video-to-animation, ...)
 * all reach for. Each page should still own its tool-specific logic.
 */
(function (global) {
  'use strict';

  function formatBytes(bytes, decimals) {
    if (decimals == null) decimals = 2;
    if (!bytes || bytes <= 0) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }

  // Assumes the standard toast markup used across tools:
  //   #toast, #toast-msg, #toast-icon-success, #toast-icon-error
  let toastTimer = null;
  function showToast(message, type) {
    const toast = document.getElementById('toast');
    const toastMsg = document.getElementById('toast-msg');
    const iconSuccess = document.getElementById('toast-icon-success');
    const iconError = document.getElementById('toast-icon-error');
    if (!toast || !toastMsg) return;
    toastMsg.textContent = message;
    const isError = type === 'error';
    if (iconSuccess) iconSuccess.classList.toggle('hidden', isError);
    if (iconError) iconError.classList.toggle('hidden', !isError);
    // Errors deserve assertive announcements; success can stay polite.
    toast.setAttribute('role', isError ? 'alert' : 'status');
    toast.classList.remove('translate-y-20', 'opacity-0');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.add('translate-y-20', 'opacity-0');
    }, 3000);
  }

  // Assumes #view-upload / #view-loading / #view-result are present.
  const VIEWS = ['view-upload', 'view-preview', 'view-loading', 'view-result'];
  function switchView(viewId) {
    VIEWS.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.add('hidden');
      el.classList.remove('fade-in');
    });
    const target = document.getElementById(viewId);
    if (!target) return;
    target.classList.remove('hidden');
    // Skip the fade-in on the loading view — animating a spinner is jarring.
    if (viewId !== 'view-loading') target.classList.add('fade-in');
  }

  function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  // setupDropzone wires the common dropzone interactions:
  //   - clicking / Enter / Space opens the hidden file input
  //   - drag enter/over adds the dragover class
  //   - drag leave/drop removes it
  //   - drop forwards e.dataTransfer.files to onFiles
  // Tool-specific filtering (image / pdf / video) belongs in onFiles.
  function setupDropzone(opts) {
    const dropzone = opts.dropzone;
    const fileInput = opts.fileInput;
    const dragoverClass = opts.dragoverClass || 'dragover';
    const onFiles = opts.onFiles;
    if (!dropzone) return;

    if (fileInput) {
      dropzone.addEventListener('click', () => fileInput.click());
      dropzone.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          fileInput.click();
        }
      });
    }

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(name => {
      dropzone.addEventListener(name, preventDefaults, false);
      document.body.addEventListener(name, preventDefaults, false);
    });
    ['dragenter', 'dragover'].forEach(name => {
      dropzone.addEventListener(name, () => dropzone.classList.add(dragoverClass), false);
    });
    ['dragleave', 'drop'].forEach(name => {
      dropzone.addEventListener(name, () => dropzone.classList.remove(dragoverClass), false);
    });

    if (onFiles) {
      dropzone.addEventListener('drop', (e) => {
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
          onFiles(e.dataTransfer.files);
        }
      });
    }
  }

  // Build an inline Before/After compare slider into `container`.
  // Returns a teardown function that removes the global listeners — call it
  // before re-using the container or unmounting, otherwise drag handlers leak.
  //
  // opts:
  //   container        — element to fill (also styled via .compare-inline)
  //   beforeUrl        — image URL shown on the left of the handle
  //   afterUrl         — image URL shown on the right of the handle
  //   beforeLabel      — overlay text on the left (default "変換前")
  //   afterLabel       — overlay text on the right (default "変換後")
  //   initialPercent   — handle starting position 0–100 (default 50)
  function setupInlineCompare(opts) {
    const container = opts.container;
    if (!container) return () => {};
    const initial = opts.initialPercent != null ? opts.initialPercent : 50;
    const beforeLabel = opts.beforeLabel || '変換前';
    const afterLabel = opts.afterLabel || '変換後';

    container.classList.add('compare-inline');
    container.innerHTML = '';

    const beforeImg = document.createElement('img');
    beforeImg.className = 'compare-before';
    beforeImg.alt = beforeLabel;

    const afterWrap = document.createElement('div');
    afterWrap.className = 'compare-after-wrap';
    const afterImg = document.createElement('img');
    afterImg.className = 'compare-after';
    afterImg.alt = afterLabel;
    afterWrap.appendChild(afterImg);

    const handle = document.createElement('div');
    handle.className = 'compare-handle';

    const labelBefore = document.createElement('span');
    labelBefore.className = 'compare-label compare-label-before';
    labelBefore.textContent = beforeLabel;
    const labelAfter = document.createElement('span');
    labelAfter.className = 'compare-label compare-label-after';
    labelAfter.textContent = afterLabel;

    container.appendChild(beforeImg);
    container.appendChild(afterWrap);
    container.appendChild(handle);
    container.appendChild(labelBefore);
    container.appendChild(labelAfter);

    let currentPercent = initial;

    function applyPercent(percent) {
      currentPercent = Math.max(0, Math.min(100, percent));
      // Clip away everything LEFT of the handle so the After image is the one
      // showing on the right, under the 変換後 label. Both layers share the
      // same box via CSS, so the percentage needs no pixel bookkeeping and
      // survives resizes on its own.
      afterWrap.style.clipPath = 'inset(0 0 0 ' + currentPercent + '%)';
      handle.style.left = currentPercent + '%';
    }

    function setFromClientX(clientX) {
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = ((clientX - rect.left) / rect.width) * 100;
      applyPercent(ratio);
    }

    beforeImg.src = opts.beforeUrl;
    afterImg.src = opts.afterUrl;
    applyPercent(initial);

    let dragging = false;
    function onDown(e) {
      dragging = true;
      const x = e.touches ? e.touches[0].clientX : e.clientX;
      setFromClientX(x);
    }
    function onMove(e) {
      if (!dragging) return;
      const x = e.touches ? e.touches[0].clientX : e.clientX;
      setFromClientX(x);
    }
    function onUp() { dragging = false; }

    container.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    container.addEventListener('touchstart', onDown, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onUp);

    return function teardown() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
    };
  }

  // ---- 分けて置いた部品の組み立て ----------------------------------------
  // ライブラリはすべて data/vendor/ に置いてこのサイトから読む（外部の CDN へは行かない。
  // ページの Content-Security-Policy でも止めている）。ただ、Cloudflare Pages は1ファイル
  // 25MB までなので、FFmpeg のコアの wasm（32MB）は2つに分けて置いてある。ここでつなぎ
  // 直し、元のファイルの SHA-256 と一致したときだけ使う（つなぎ間違いや欠けを動かさない）。
  // 部品の名前・大きさ・SHA-256 は、取り込んだときの記録（data/vendor/SOURCES.json の split）を
  // そのまま読む。ここに値を書き写すと、版を上げたときに合わせ忘れる。
  const VENDOR_BASE = new URL('vendor/', (document.currentScript && document.currentScript.src) || location.href);

  //   key … data/vendor/ からのパス（例: '@ffmpeg/core@0.12.6/ffmpeg-core.wasm'）
  // つないだ中身が記録と一致したら blob: の URL にして返す。違えば使わずに止める。
  async function fetchVerified(key, type) {
    const res = await fetch(new URL('SOURCES.json', VENDOR_BASE));
    if (!res.ok) throw new Error('HTTP ' + res.status + ' SOURCES.json');
    const entry = ((await res.json()).split || {})[key];
    if (!entry) throw new Error('unknown part: ' + key);
    // つなぎ先を先に確保し、部品は1つずつ取ってきて書き込む。32MB の部品を全部抱えてから
    // つなぐと、スマホではメモリが足りずにタブが落ちることがある
    const whole = new Uint8Array(entry.size);
    let at = 0;
    for (const part of entry.parts) {
      const r = await fetch(new URL(part, VENDOR_BASE));
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + part);
      const buf = new Uint8Array(await r.arrayBuffer());
      if (at + buf.length > whole.length) throw new Error('部品の大きさが記録と違います（' + key + '）');
      whole.set(buf, at);
      at += buf.length;
    }
    if (at !== whole.length) throw new Error('部品の大きさが記録と違います（' + key + '）');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', whole));
    const hex = Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
    if (hex !== entry.sha256) throw new Error('部品の中身が記録と違うため、使いませんでした（' + key + '）');
    return URL.createObjectURL(new Blob([whole], { type: type }));
  }

  // FAQPage の本文を画面にも出す。既に静的な .faq-section があるページでは
  // 何もしない。QR Atelier のように詳しい構造化データを先に持っていたページは、
  // その内容を正本として共通の折りたたみ UI を組み立てる。
  function renderFaqFromStructuredData() {
    if (document.querySelector('.faq-section')) return;

    let faq = null;
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      try {
        const data = JSON.parse(script.textContent);
        const nodes = data['@graph'] || [data];
        faq = nodes.find(node => node && node['@type'] === 'FAQPage');
        if (faq) break;
      } catch (_) { /* 壊れた構造化データはほかのブロックの探索を続ける */ }
    }
    if (!faq || !Array.isArray(faq.mainEntity) || !faq.mainEntity.length) return;

    const section = document.createElement('section');
    section.className = 'faq-section';
    section.setAttribute('aria-labelledby', 'faq-title');

    const head = document.createElement('div');
    head.className = 'faq-head';
    const kicker = document.createElement('span');
    kicker.className = 'faq-kicker';
    kicker.textContent = 'FAQ';
    const title = document.createElement('h2');
    title.id = 'faq-title';
    title.className = 'faq-title';
    title.textContent = 'よくある質問';
    const lede = document.createElement('p');
    lede.className = 'faq-lede';
    lede.textContent = '使い方、対応形式、ファイルや入力内容の扱いについて回答します。';
    head.append(kicker, title, lede);

    const list = document.createElement('div');
    list.className = 'faq-list';
    faq.mainEntity.forEach(item => {
      const answer = item && item.acceptedAnswer;
      if (!item || !item.name || !answer || !answer.text) return;
      const details = document.createElement('details');
      details.className = 'faq-item';
      const summary = document.createElement('summary');
      summary.className = 'faq-question';
      summary.textContent = item.name;
      const body = document.createElement('p');
      body.className = 'faq-answer';
      body.textContent = answer.text;
      details.append(summary, body);
      list.appendChild(details);
    });
    if (!list.children.length) return;
    section.append(head, list);

    const footer = document.querySelector('.site-foot');
    if (footer) footer.before(section);
    else document.body.appendChild(section);
  }

  // ---- 通信メーター ----------------------------------------------------------
  // 「端末内で処理」「サーバー保存なし」「通信先を制限」を、宣言の言い換えではなく、この
  // ページで実際に起きた通信で見せる。拾うのは3つ。
  //   1. Resource Timing … ページが行った通信の行き先（読み込みも送信も、始まったものは全部）
  //   2. fetch / XHR / sendBeacon / WebSocket / EventSource の呼び出し … 方式と、載せた中身の大きさ
  //   3. securitypolicyviolation … Content-Security-Policy によってブラウザが止めたもの
  // どれもページ自身による計測で、Worker の中の通信は見えない（Worker は blob: から起動して
  // ページの CSP を引き継がせている）。画面にもそう書く。
  // ツールのスクリプトより先に仕掛ける必要があるので、このファイルを読んだ時点で始める。
  const GUARD_HOST = 'example.com';
  const GUARD_PATH = '/st-guard-test';
  const ANALYTICS_HOSTS = [
    [/(^|\.)googletagmanager\.com$/, 'Google タグマネージャー'],
    [/(^|\.)google-analytics\.com$|(^|\.)analytics\.google\.com$|(^|\.)g\.doubleclick\.net$|^www\.google\.com$|^www\.google\.co\.jp$/, 'Google アナリティクス'],
    [/(^|\.)cloudflareinsights\.com$/, 'Cloudflare Web Analytics'],
  ];
  // 広告の配信元。GA4 の Google シグナルが使う stats.g.doubleclick.net は解析のほうに数える
  const AD_HOSTS = /(^|\.)googlesyndication\.com$|(^|\.)googleadservices\.com$|(^|\.)adservice\.google\.|^(securepubads|pubads)\.g\.doubleclick\.net$|^ad\.doubleclick\.net$|(^|\.)amazon-adsystem\.com$|(^|\.)adnxs\.com$|(^|\.)criteo\.(com|net)$|(^|\.)taboola\.com$|(^|\.)outbrain\.com$/;

  const net = {
    // 通信1件ずつ。carries は「中身を載せた送信か」（true / false / 確かめられないとき null）
    entries: [],
    // CSP が止めたもの。linked は entries のどれかに「止められた」として付けたか
    blocked: [],
    // ファイルを受け取ってからの区切り。レシートを出したら次のファイルで区切り直す
    work: null,
  };
  const netListeners = [];
  let netTimer = null;
  function notifyNet() {
    if (netTimer) return;
    netTimer = setTimeout(() => {
      netTimer = null;
      netListeners.forEach(fn => {
        try { fn(); } catch (_) { /* 表示の失敗で計測を止めない */ }
      });
    }, 150);
  }

  function describeDestination(url) {
    let u;
    try {
      u = new URL(url, location.href);
    } catch (_) {
      return { kind: 'other', host: String(url).slice(0, 80), label: '読み取れない行き先' };
    }
    if (!/^(https?|wss?):$/.test(u.protocol)) return { kind: 'local', host: u.protocol, label: '端末の中' };
    const host = u.hostname;
    if (host === GUARD_HOST && u.pathname.indexOf(GUARD_PATH) === 0) {
      return { kind: 'test', host, label: 'ガードの試験' };
    }
    if (u.origin === location.origin) return { kind: 'site', host, label: 'このサイト（tk.st）' };
    if (AD_HOSTS.test(host)) return { kind: 'ad', host, label: '広告の配信元' };
    for (const [re, label] of ANALYTICS_HOSTS) {
      if (re.test(host)) return { kind: 'analytics', host, label };
    }
    if (/(^|\.)ko-fi\.com$/.test(host)) return { kind: 'donation', host, label: 'Ko-fi（寄付の窓口）' };
    return { kind: 'other', host, label: '想定外の行き先' };
  }

  function absoluteHref(url) {
    try { return new URL(url, location.href).href; } catch (_) { return String(url); }
  }

  // 載せた中身のバイト数。数えられない形（ストリームなど）は -1
  function bodySize(body) {
    if (body == null) return 0;
    try {
      if (typeof body === 'string') return new Blob([body]).size;
      if (body instanceof Blob) return body.size;
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body.byteLength;
      if (body instanceof URLSearchParams) return new Blob([body.toString()]).size;
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        let total = 0;
        body.forEach((value, key) => {
          total += new Blob([key]).size + (typeof value === 'string' ? new Blob([value]).size : (value.size || 0));
        });
        return total;
      }
    } catch (_) { /* 数えられなかったものは大きさ不明として扱う */ }
    return -1;
  }

  function recordCall(via, url, method, body) {
    const dest = describeDestination(url);
    if (dest.kind === 'local') return;
    const m = String(method || 'GET').toUpperCase();
    const bytes = bodySize(body);
    net.entries.push(Object.assign({
      at: performance.now(),
      href: absoluteHref(url),
      via,
      method: m,
      bytes,
      carries: bytes !== 0 || !(m === 'GET' || m === 'HEAD'),
      size: 0,
      fromCall: true,
      timed: false,
      blocked: false,
    }, dest));
    notifyNet();
  }

  // 呼び出しを横で書き留めるだけで、引数も戻り値もそのまま渡す。計測で失敗しても通信は止めない
  (function wrapNetworkApis() {
    try {
      const nativeFetch = global.fetch;
      if (typeof nativeFetch === 'function') {
        global.fetch = function (input, init) {
          try {
            const isRequest = typeof Request !== 'undefined' && input instanceof Request;
            const method = (init && init.method) || (isRequest ? input.method : 'GET');
            let body = init && init.body != null ? init.body : null;
            if (body == null && isRequest && input.body) body = input.body; // ストリームは大きさ不明
            recordCall('fetch', isRequest ? input.url : String(input), method, body);
          } catch (_) { /* 計測だけ諦める */ }
          return nativeFetch.apply(global, arguments);
        };
      }
    } catch (_) { /* 差し替えられない環境では Resource Timing だけで数える */ }

    try {
      const proto = XMLHttpRequest.prototype;
      const open = proto.open;
      const send = proto.send;
      const pending = new WeakMap();
      proto.open = function (method, url) {
        try { pending.set(this, { method, url: String(url) }); } catch (_) { /* 同上 */ }
        return open.apply(this, arguments);
      };
      proto.send = function (body) {
        try {
          const p = pending.get(this);
          if (p) recordCall('xhr', p.url, p.method, body);
        } catch (_) { /* 同上 */ }
        return send.apply(this, arguments);
      };
    } catch (_) { /* 同上 */ }

    try {
      const beacon = navigator.sendBeacon;
      if (typeof beacon === 'function') {
        navigator.sendBeacon = function (url, data) {
          try { recordCall('beacon', String(url), 'POST', data); } catch (_) { /* 同上 */ }
          return beacon.apply(navigator, arguments);
        };
      }
    } catch (_) { /* 同上 */ }

    // WebSocket と EventSource は Resource Timing に出ないので、作られた時点で数える
    [['WebSocket', 'websocket', 'WEBSOCKET'], ['EventSource', 'eventsource', 'GET']].forEach(([name, via, method]) => {
      try {
        const Native = global[name];
        if (typeof Native !== 'function' || typeof Proxy !== 'function') return;
        global[name] = new Proxy(Native, {
          construct(target, args) {
            try { recordCall(via, String(args[0]), method, null); } catch (_) { /* 同上 */ }
            return Reflect.construct(target, args);
          },
        });
      } catch (_) { /* 同上 */ }
    });
  })();

  // blockedURI はオリジンまで削られることがあるので、前方一致で同じ通信とみなす
  function sameTarget(href, blockedUri) {
    return Boolean(blockedUri) && (href === blockedUri || href.indexOf(blockedUri) === 0 || blockedUri.indexOf(href) === 0);
  }
  // Chrome は CSP が止めた通信も Resource Timing に1件として載せる。止めた知らせと
  // 結び付けて「止められた」にしないと、出ていない通信を送信として数えてしまう
  function linkBlocked(entry, block) {
    entry.blocked = true;
    entry.directive = block.directive;
    block.linked = true;
  }

  const TIMED_CALLS = { fetch: 'fetch', xmlhttprequest: 'xhr', beacon: 'beacon' };
  function takeResource(entry) {
    const dest = describeDestination(entry.name);
    if (dest.kind === 'local') return;
    const size = entry.encodedBodySize || entry.transferSize || 0;
    const via = TIMED_CALLS[entry.initiatorType];
    if (via) {
      // 呼び出しを書き留めた通信なら、同じ行に受け取った大きさを足すだけ
      const call = net.entries.find(e => e.fromCall && !e.timed && e.via === via && e.href === entry.name);
      if (call) {
        call.timed = true;
        call.size = size;
        notifyNet();
        return;
      }
    }
    const block = net.blocked.find(b => !b.linked && !b.absorbed && b.network && sameTarget(entry.name, b.href));
    if (block) {
      // 止めた知らせが先に届いていた通信。行は増やさず、知らせのほうを一覧に残す
      block.absorbed = true;
      notifyNet();
      return;
    }
    net.entries.push(Object.assign({
      at: entry.startTime,
      href: entry.name,
      via: entry.initiatorType || 'other',
      method: via === 'beacon' ? 'POST' : (via ? '' : 'GET'),
      bytes: via === 'beacon' ? -1 : 0,
      // 書き留める前に始まった fetch / XHR は、中身を載せたかどうか分からない
      carries: via === 'beacon' ? true : (via ? null : false),
      size,
      fromCall: false,
      timed: true,
      blocked: false,
    }, dest));
    notifyNet();
  }

  function takeViolation(blockedUri, rawDirective, at) {
    const uri = String(blockedUri || '');
    const directive = String(rawDirective || '').split(' ')[0];
    const network = /^(https?|wss?):/i.test(uri);
    const dest = network
      ? describeDestination(uri)
      : { kind: 'code', host: uri || directive, label: 'ページ内の処理' };
    const record = Object.assign({ at, href: uri, directive, network, linked: false }, dest);
    if (network) {
      // 呼び出しの行か Resource Timing の行が先にあれば、そこに「止められた」を付ける
      for (let i = net.entries.length - 1; i >= 0; i--) {
        const c = net.entries[i];
        if (c.blocked || c.host !== dest.host || !sameTarget(c.href, uri)) continue;
        linkBlocked(c, record);
        break;
      }
    }
    net.blocked.push(record);
    notifyNet();
  }

  // GTM などはこのファイルより先に動くので、その間に止めた分は head 先頭のインライン
  // スクリプトが window.__stCspLog に書き留めている。それを引き取ってから自分で聞く
  // （引き取ったあとは null にして、先頭の書き留めを止める）。要素に紐づかない違反は
  // ドキュメントに届くので、window の捕捉で両方拾う
  (global.__stCspLog || []).forEach(v => takeViolation(v.u, v.d, v.t));
  global.__stCspLog = null;
  global.addEventListener('securitypolicyviolation', e => {
    takeViolation(e.blockedURI, e.effectiveDirective || e.violatedDirective, performance.now());
  }, true);

  try {
    if (performance.setResourceTimingBufferSize) performance.setResourceTimingBufferSize(2000);
    new PerformanceObserver(list => list.getEntries().forEach(takeResource))
      .observe({ type: 'resource', buffered: true });
  } catch (_) {
    try { performance.getEntriesByType('resource').forEach(takeResource); } catch (__) { /* 計測なし */ }
  }

  // ファイルを受け取った時点を区切りにする。ツールごとの処理より先に拾えるよう捕捉で聞く
  function markWork(fileList) {
    const files = [];
    Array.from(fileList || []).forEach(f => {
      if (f && typeof f.size === 'number') files.push({ name: f.name || '名前のないファイル', size: f.size });
    });
    if (!files.length) return;
    if (!net.work || net.work.reported) net.work = { at: performance.now(), files: [], reported: false };
    net.work.files.push(...files);
    notifyNet();
  }
  document.addEventListener('change', e => {
    const t = e.target;
    if (t && t.type === 'file' && t.files) markWork(t.files);
  }, true);
  document.addEventListener('drop', e => { if (e.dataTransfer) markWork(e.dataTransfer.files); }, true);
  document.addEventListener('paste', e => { if (e.clipboardData) markWork(e.clipboardData.files); }, true);

  function tallyNet(since) {
    const t = {
      sends: 0, sendsSite: 0, unknown: 0,
      site: 0, siteBytes: 0, analytics: 0, donation: 0, ad: 0, other: 0, blocked: 0,
    };
    net.entries.forEach(e => {
      if (e.at < since || e.kind === 'test' || e.blocked) return;
      t[e.kind] = (t[e.kind] || 0) + 1;
      if (e.kind === 'site') t.siteBytes += e.size || 0;
      if (e.kind === 'analytics' || e.kind === 'donation') return;
      // 中身を確かめられない送信も、送ったものとして数える（緑にしない側へ倒す）
      if (e.carries !== false || e.kind === 'other' || e.kind === 'ad') {
        t.sends += 1;
        if (e.carries === null) t.unknown += 1;
        if (e.kind === 'site') t.sendsSite += 1;
      }
    });
    net.blocked.forEach(b => {
      if (b.at >= since && b.kind !== 'test' && b.network) t.blocked += 1;
    });
    return t;
  }

  function h(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // ---- 通信先の制限（CSP）の点検 --------------------------------------------
  // meta があるだけでは足りない。どのスクリプトより前にあること、読み込み・送信の通信先に
  // 「どこでも」（* や https: だけの指定）が混じっていないことまで見る。
  const FETCH_DIRECTIVES = ['default-src', 'connect-src', 'img-src', 'script-src', 'style-src',
    'font-src', 'media-src', 'frame-src', 'worker-src', 'object-src'];
  function inspectCsp() {
    const meta = document.querySelector('meta[http-equiv="Content-Security-Policy" i]');
    if (!meta) return { ok: false, reason: 'ページ先頭に Content-Security-Policy が見つかりませんでした。' };
    const dirs = {};
    String(meta.content || '').split(';').forEach(part => {
      const tokens = part.trim().split(/\s+/).filter(Boolean);
      if (tokens.length) dirs[tokens[0].toLowerCase()] = tokens.slice(1);
    });
    const firstScript = document.querySelector('script');
    const early = meta.parentNode === document.head && (!firstScript
      || Boolean(meta.compareDocumentPosition(firstScript) & Node.DOCUMENT_POSITION_FOLLOWING));
    const broad = [];
    FETCH_DIRECTIVES.forEach(name => (dirs[name] || []).forEach(src => {
      if (src === '*' || /^(https?|wss?):$/i.test(src)) broad.push(name + ' ' + src);
    }));
    const hasConnect = Boolean(dirs['connect-src'] || dirs['default-src']);
    const objectNone = (dirs['object-src'] || []).join(' ') === "'none'";
    const formSelf = (dirs['form-action'] || []).join(' ') === "'self'";
    if (!early) return { ok: false, reason: 'Content-Security-Policy がスクリプトより後ろにあり、先に動くスクリプトを縛れません。' };
    if (!hasConnect) return { ok: false, reason: '送信先を絞る指定（connect-src）が見つかりませんでした。' };
    if (broad.length) return { ok: false, reason: '通信先に「どこでも」を許す指定があります（' + broad.join('、') + '）。' };
    if (!objectNone || !formSelf) return { ok: false, reason: 'プラグインやフォーム送信を絞る指定が足りません。' };
    return { ok: true, reason: '' };
  }

  // ---- ガードを試す ----------------------------------------------------------
  // あえて許していない行き先（example.com）へ送ろうとして、ブラウザが止めることを見せる。
  // CSP は通信が始まる前に止めるので、止まれば何も出ていかない。止まらなかったときに
  // 出ていくのは下の固定の文字列だけで、ファイルや入力の中身は使わない。
  const guard = { state: 'idle', results: [] };
  const GUARD_TEXT = 'SAFE TOOLS guard test';
  async function runGuardTest() {
    guard.state = 'running';
    const startAt = performance.now();
    const base = 'https://' + GUARD_HOST + GUARD_PATH;
    const fetchOutcome = await fetch(base + '?via=fetch', {
      method: 'POST', body: GUARD_TEXT, mode: 'no-cors', cache: 'no-store', credentials: 'omit',
    }).then(() => 'passed', () => 'error');
    const imageOutcome = await new Promise(resolve => {
      const img = new Image();
      const timer = setTimeout(() => resolve('error'), 5000);
      img.onload = () => { clearTimeout(timer); resolve('passed'); };
      img.onerror = () => { clearTimeout(timer); resolve('error'); };
      img.src = base + '?via=image&text=' + encodeURIComponent(GUARD_TEXT);
    });
    // 違反の知らせは通信の失敗より少し遅れて届くことがある
    await new Promise(resolve => setTimeout(resolve, 300));
    const judge = (name, outcome, directive) => {
      const hit = net.blocked.some(b => b.kind === 'test' && b.at >= startAt && b.directive === directive);
      return { name, directive, state: hit ? 'blocked' : (outcome === 'passed' ? 'passed' : 'unclear') };
    };
    guard.results = [
      judge('データを送る通信（fetch）', fetchOutcome, 'connect-src'),
      judge('画像の読み込みに見せかけた送信', imageOutcome, 'img-src'),
    ];
    guard.state = guard.results.some(r => r.state === 'passed') ? 'failed'
      : guard.results.every(r => r.state === 'blocked') ? 'blocked' : 'unclear';
    notifyNet();
  }

  function buildGuard() {
    const root = h('div', 'safety-guard');
    const head = h('div', 'safety-guard-head');
    const text = h('div', 'safety-guard-text');
    text.append(
      h('b', null, 'ガードを試す'),
      h('p', null, 'ボタンを押すと、このページからあえて外部のサイト（' + GUARD_HOST + '）へ短い試験用の文字列を送ろうとします。'
        + '通信先の制限が働いていれば、ブラウザが送信を始める前に止めます。ファイルや入力の中身は使いません。')
    );
    const button = h('button', 'safety-guard-btn', '外部への送信を試す');
    button.type = 'button';
    head.append(text, button);
    const list = h('ul', 'safety-guard-results');
    list.hidden = true;
    list.setAttribute('aria-live', 'polite');
    root.append(head, list);

    const MARKS = { blocked: '✓', passed: '!', unclear: '?' };
    function render() {
      list.hidden = !guard.results.length;
      list.replaceChildren(...guard.results.map(r => {
        const li = h('li', r.state === 'blocked' ? '' : 'is-warning');
        li.dataset.mark = MARKS[r.state];
        const verdict = r.state === 'blocked'
          ? 'ブラウザが止めました（使われたルール: ' + r.directive + '）'
          : r.state === 'passed'
            ? '止まらずに送られました。通信先の制限が働いていません'
            : '止まったことを確かめられませんでした（回線の状態などで失敗した可能性があります）';
        const span = h('span');
        span.append(h('b', null, r.name), document.createTextNode(' … ' + verdict));
        li.appendChild(span);
        return li;
      }));
    }
    button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = '試しています…';
      try {
        await runGuardTest();
      } finally {
        button.disabled = false;
        button.textContent = 'もう一度試す';
        render();
      }
    });
    return { root };
  }

  // ---- 通信の一覧 ------------------------------------------------------------
  const USE_LABELS = {
    script: 'プログラムの読み込み', link: '部品の読み込み', css: '部品の読み込み', img: '画像の読み込み',
    iframe: '埋め込み表示', fetch: 'データの読み込み', xhr: 'データの読み込み',
    eventsource: 'データの受信', other: '部品の読み込み',
  };
  function describeUse(e) {
    if (e.kind === 'test') return 'ガードの試験';
    const sent = e.bytes > 0 ? '（' + formatBytes(e.bytes, 1) + '）' : '';
    if (e.kind === 'analytics') return e.via === 'script' ? '解析プログラムの読み込み' : '閲覧の記録' + sent;
    if (e.carries === true) return 'データの送信' + sent;
    if (e.carries === null) return '送信（中身は確かめられません）';
    return USE_LABELS[e.via] || '読み込み';
  }
  function shortTarget(href) {
    try {
      const u = new URL(href);
      return u.origin === location.origin ? u.pathname.replace(/^.*\/data\//, 'data/') : u.host + u.pathname;
    } catch (_) {
      return href;
    }
  }

  function buildLog() {
    const root = h('details', 'safety-log');
    const summary = h('summary', 'safety-log-summary', '通信の一覧');
    const list = h('ol', 'safety-log-list');
    root.append(summary, list);

    function row(item) {
      const e = item.entry || item.block;
      const blocked = Boolean(item.block) || e.blocked;
      const warn = !blocked && (e.kind === 'other' || e.kind === 'ad' || (e.kind === 'site' && e.carries !== false));
      const li = h('li', 'safety-log-row' + (blocked ? ' is-blocked' : '') + (warn ? ' is-warning' : ''));
      const time = h('span', 'safety-log-time', '+' + (Math.max(0, e.at) / 1000).toFixed(1) + '秒');
      const dest = h('span', 'safety-log-dest', e.label);
      const use = h('span', 'safety-log-use');
      if (blocked) {
        use.textContent = (e.network === false ? 'ブラウザが止めた処理' : 'ブラウザが止めた通信')
          + '（' + (e.directive || 'CSP') + '）';
      } else {
        use.textContent = describeUse(e);
      }
      const target = h('span', 'safety-log-path', e.network === false ? e.host : shortTarget(e.href));
      target.title = e.href || e.host;
      use.appendChild(target);
      li.append(time, dest, use);
      return li;
    }

    function render() {
      const items = [];
      net.entries.forEach(entry => items.push({ at: entry.at, entry }));
      net.blocked.forEach(block => { if (!block.linked) items.push({ at: block.at, block }); });
      items.sort((a, b) => a.at - b.at);
      summary.textContent = '通信の一覧（' + items.length + '件・ページを開いてからの順）';
      if (!root.open) return;
      list.replaceChildren(...items.slice(-400).map(row));
    }
    root.addEventListener('toggle', render);
    return { root, render };
  }

  // ---- 安全設計カード --------------------------------------------------------
  // SAFE TOOLS 共通の5項目を、宣言ではなく、このページで確かめた結果として見せる。
  // 通信の数字は使っているあいだ更新し、想定外のことが起きたら緑のチェックにしない。
  let safetyUi = null;
  function renderSafetyProof() {
    if (document.querySelector('.safety-proof')) return;
    const main = document.querySelector('main');
    if (!main) return;
    const csp = inspectCsp();

    const section = h('section', 'safety-proof');
    section.setAttribute('aria-label', 'このツールの安全設計');
    const details = h('details', 'safety-proof-card');
    const summary = h('summary', 'safety-proof-summary');

    const heading = h('div', 'safety-proof-heading');
    const shield = h('span', 'safety-proof-shield');
    shield.setAttribute('aria-hidden', 'true');
    const count = h('span', 'safety-proof-count');
    heading.append(shield, h('span', 'safety-proof-title', 'このツールの安全設計'), count);

    const LABELS = ['端末内で処理', 'サーバー保存なし', '広告なし', 'インストール不要', '通信先を制限'];
    const chips = h('div', 'safety-proof-chips');
    const chipEls = LABELS.map(label => {
      const chip = h('span', 'safety-proof-chip');
      chip.appendChild(h('span', null, label));
      chips.appendChild(chip);
      return chip;
    });

    const meter = h('div', 'safety-meter');
    const meterLive = h('span', 'safety-meter-live', 'このページの通信');
    const meterItem = (label, key) => {
      const item = h('span', 'safety-meter-item' + (key ? ' is-key' : ''), label);
      const value = h('b');
      item.appendChild(value);
      meter.appendChild(item);
      return { item, value };
    };
    meter.appendChild(meterLive);
    const mSends = meterItem('データの送信', true);
    const mAnalytics = meterItem('アクセス解析');
    const mSite = meterItem('tk.st から受け取った部品');
    const mBlocked = meterItem('ブラウザが止めた通信');
    summary.append(heading, chips, meter);

    const body = h('div', 'safety-proof-body');
    const intro = h('p', 'safety-proof-intro',
      '緑のチェックは、このページを開いてから実際に起きた通信と、ブラウザのセキュリティ設定を確かめた結果です。'
      + '数字は使っているあいだ更新されます。「データの送信」は、ファイルや入力を載せられる送り方（POST など）を'
      + 'アクセス解析の閲覧記録とは別に数えたものです。');
    const grid = h('div', 'safety-proof-grid');
    const itemEls = LABELS.map(() => {
      const box = h('div', 'safety-proof-item');
      const name = h('b');
      const explanation = h('p');
      box.append(name, explanation);
      grid.appendChild(box);
      return { name, explanation };
    });
    const guardUi = buildGuard();
    const log = buildLog();
    const note = h('p', 'safety-proof-note',
      'この表示は、このページのスクリプトが自分の通信を数えたものです。ページが別スレッド（Worker）で行う通信は'
      + '数えていません（Worker も同じ通信先の制限の下で動きます）。ページを信用せずに確かめたいときは、'
      + 'ブラウザの開発者ツールの「ネットワーク」で、同じ通信を見られます。');
    body.append(intro, grid, guardUi.root, log.root, note);
    details.append(summary, body);
    section.appendChild(details);
    main.before(section);

    function proofs() {
      const t = tallyNet(0);
      const w = net.work ? tallyNet(net.work.at) : null;
      const hasAdCode = Boolean(document.querySelector(
        'script[src*="googlesyndication"], script[src*="adservice"], ins.adsbygoogle, [data-ad-client]'
      ));
      const unexpected = t.other > 0 ? '許可していない行き先との通信を検出しました。下の通信の一覧で確かめてください。' : '';
      const localOk = t.sends === 0 && t.other === 0;
      const sendsText = 'データの送信は' + t.sends + '件です（アクセス解析の閲覧記録を除く）。';
      const guardText = {
        idle: '下の「ガードを試す」で、ブラウザが外部への送信を止める様子を確かめられます。',
        running: '',
        blocked: 'ガードの試験でも、ブラウザが外部への送信を止めたことを確かめました。',
        failed: 'ガードの試験で、外部への送信が止まりませんでした。',
        unclear: 'ガードの試験では、止まったことを確かめきれませんでした。',
      }[guard.state];
      return [
        {
          ok: localOk,
          detail: '変換・編集・生成は、このページのJavaScriptやWebAssemblyがブラウザ内で実行します。'
            + (w ? 'ファイルを受け取ってから、データの送信は' + w.sends + '件です。'
              : 'ファイルを選ぶと、そこからの通信も分けて数えます。')
            + 'ページを開いてからの' + sendsText + (localOk ? '' : ' ' + (unexpected || '下の通信の一覧で行き先を確かめてください。')),
        },
        {
          ok: t.sendsSite === 0,
          detail: 'tk.st へのデータの送信は' + t.sendsSite + '件で、tk.st とのやりとりは部品の受け取り（' + t.site + '件）だけです。'
            + '結果はブラウザから端末へ直接ダウンロードします。設定や作業状態を、この端末のブラウザ内へ保存するツールはあります。',
        },
        {
          ok: !hasAdCode && t.ad === 0,
          detail: !hasAdCode && t.ad === 0
            ? '広告枠も、広告の配信元との通信もありません。アクセス解析（' + t.analytics + '件）はありますが、ファイルや入力内容を渡す処理はありません。'
            : '広告のコードか、広告の配信元との通信を検出しました。下の通信の一覧で確かめてください。',
        },
        {
          ok: true,
          detail: 'ブラウザで開くだけで使えます。このページは tk.st から' + t.site + '個のファイル'
            + (t.siteBytes ? '（計' + formatBytes(t.siteBytes, 1) + '）' : '')
            + 'を受け取って動いています。処理に使うライブラリとフォントも同梱で、専用アプリや拡張機能は要りません。',
        },
        {
          ok: csp.ok && guard.state !== 'failed' && t.other === 0,
          detail: (csp.ok
            ? 'ページ先頭の Content-Security-Policy で、読み込みや送信に使える通信先を、このサイトとアクセス解析に必要な送信先に絞っています（Ko-fi は別枠の表示だけ）。'
            : csp.reason)
            + (t.blocked ? 'ページを開いてから、ブラウザが止めた通信は' + t.blocked + '件です。' : '')
            + guardText + unexpected,
        },
      ];
    }

    function update() {
      const list = proofs();
      const okCount = list.filter(p => p.ok).length;
      const allOk = okCount === list.length;
      shield.textContent = allOk ? '✓' : '!';
      shield.classList.toggle('is-warning', !allOk);
      count.textContent = okCount + ' / ' + list.length + ' 確認';
      count.classList.toggle('is-warning', !allOk);
      list.forEach((p, i) => {
        chipEls[i].classList.toggle('is-warning', !p.ok);
        itemEls[i].name.textContent = (p.ok ? '✓ ' : '! ') + LABELS[i];
        itemEls[i].explanation.textContent = p.detail;
      });

      const t = tallyNet(0);
      mSends.value.textContent = t.sends + '件';
      mSends.item.classList.toggle('is-warning', t.sends > 0);
      mAnalytics.value.textContent = t.analytics + '件';
      mSite.value.textContent = t.site + '件';
      mBlocked.value.textContent = t.blocked + '件';
      meter.classList.toggle('is-warning', t.sends > 0 || t.other > 0);
      log.render();
    }

    safetyUi = {
      openLog() {
        details.open = true;
        log.root.open = true;
        log.render();
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      },
    };
    netListeners.push(update);
    update();
  }

  // ---- 処理レシート ----------------------------------------------------------
  // 用が済んだ瞬間（STShare.celebrate を呼ぶところ）に、ファイルを受け取ってからの通信を
  // 1枚にまとめて見せる。出ているあいだに届いた通信（解析など）も数字に足していく。
  const receipt = { card: null, since: 0, work: null, timer: null, hovering: false };
  function buildReceipt() {
    const card = h('aside', 'st-receipt');
    card.setAttribute('role', 'status');
    card.setAttribute('aria-label', '処理レシート');
    card.hidden = true;
    const head = h('div', 'st-receipt-head');
    const mark = h('span', 'st-receipt-mark', '✓');
    mark.setAttribute('aria-hidden', 'true');
    const title = h('b', 'st-receipt-title', '処理レシート');
    const close = h('button', 'st-receipt-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'レシートを閉じる');
    head.append(mark, title, close);

    const rows = h('dl', 'st-receipt-rows');
    const addRow = (label, key) => {
      const row = h('div', key ? 'is-key' : '');
      const dd = h('dd');
      row.append(h('dt', null, label), dd);
      rows.appendChild(row);
      return { row, dd };
    };
    const rInput = addRow('入力');
    const rPlace = addRow('処理した場所');
    rPlace.dd.textContent = 'この端末のブラウザ';
    const rSends = addRow('データの送信', true);
    const rAnalytics = addRow('アクセス解析（閲覧の記録）');
    const rBlocked = addRow('ブラウザが止めた通信');
    const note = h('p', 'st-receipt-note');
    const more = h('button', 'st-receipt-more', '通信の一覧を見る');
    more.type = 'button';
    card.append(head, rows, note, more);
    document.body.appendChild(card);

    close.addEventListener('click', hideReceipt);
    more.addEventListener('click', () => {
      hideReceipt();
      if (safetyUi) safetyUi.openLog();
    });
    card.addEventListener('mouseenter', () => { receipt.hovering = true; });
    card.addEventListener('mouseleave', () => { receipt.hovering = false; });

    receipt.fill = () => {
      const t = tallyNet(receipt.since);
      const work = receipt.work;
      rInput.row.hidden = !work;
      if (work) {
        const total = work.files.reduce((sum, f) => sum + f.size, 0);
        rInput.dd.textContent = work.files[0].name
          + (work.files.length > 1 ? ' ほか' + (work.files.length - 1) + '件' : '')
          + ' · ' + formatBytes(total, 1);
        rInput.dd.title = work.files.map(f => f.name).join('\n');
      }
      const warn = t.sends > 0 || t.other > 0;
      card.classList.toggle('is-warning', warn);
      mark.textContent = warn ? '!' : '✓';
      title.textContent = warn ? '処理レシート（送信を検出）' : '処理レシート';
      rSends.dd.textContent = t.sends + '件';
      rAnalytics.dd.textContent = t.analytics + '件';
      rBlocked.dd.textContent = t.blocked + '件';
      note.textContent = (work ? 'ファイルを受け取ってから' : 'ページを開いてから')
        + 'の通信を、このページ自身が数えた結果です。';
      more.hidden = !safetyUi;
    };
    netListeners.push(() => { if (!card.hidden) receipt.fill(); });
    return card;
  }

  function hideReceipt() {
    const card = receipt.card;
    if (!card || card.hidden) return;
    clearTimeout(receipt.timer);
    card.classList.remove('is-in');
    setTimeout(() => { if (!card.classList.contains('is-in')) card.hidden = true; }, 260);
  }

  function showReceipt() {
    if (!document.body) return;
    receipt.work = net.work;
    receipt.since = net.work ? net.work.at : 0;
    if (net.work) net.work.reported = true;
    if (!receipt.card) receipt.card = buildReceipt();
    const card = receipt.card;
    receipt.fill();
    card.hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => card.classList.add('is-in')));
    // 読んでいるあいだ（ポインタが乗っている・フォーカスがある）は消さない
    clearTimeout(receipt.timer);
    const autoHide = () => {
      receipt.timer = setTimeout(() => {
        if (receipt.hovering || card.contains(document.activeElement)) autoHide();
        else hideReceipt();
      }, 15000);
    };
    autoHide();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      renderSafetyProof();
      renderFaqFromStructuredData();
    }, { once: true });
  } else {
    renderSafetyProof();
    renderFaqFromStructuredData();
  }

  global.STCommon = {
    formatBytes,
    fetchVerified,
    showToast,
    switchView,
    preventDefaults,
    setupDropzone,
    setupInlineCompare,
    renderSafetyProof,
    renderFaqFromStructuredData,
    showReceipt,
  };
})(window);
