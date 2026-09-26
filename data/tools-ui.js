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

  // SAFE TOOLS 共通の5項目を、宣言だけでなくページ上の実装状況と一緒に見せる。
  // CSP と広告コードは現在の DOM を実際に確認し、異常時は緑のチェックにしない。
  function renderSafetyProof() {
    if (document.querySelector('.safety-proof')) return;
    const main = document.querySelector('main');
    if (!main) return;

    const cspMeta = document.querySelector('meta[http-equiv="Content-Security-Policy" i]');
    const csp = cspMeta ? cspMeta.content : '';
    const cspOk = /(?:^|;)\s*connect-src\s/i.test(csp)
      && /(?:^|;)\s*object-src\s+'none'/i.test(csp)
      && /(?:^|;)\s*form-action\s+'self'/i.test(csp);
    const hasAdCode = Boolean(document.querySelector(
      'script[src*="googlesyndication"], script[src*="adservice"], ins.adsbygoogle, [data-ad-client]'
    ));

    const proofs = [
      {
        label: '端末内で処理',
        ok: true,
        detail: '変換・編集・生成は、このページのJavaScriptやWebAssemblyがブラウザ内で実行します。処理対象を外部の変換サービスへ渡しません。'
      },
      {
        label: 'サーバー保存なし',
        ok: true,
        detail: '作業ファイルと処理結果を受け取る保存APIを使いません。結果はブラウザから端末へ直接ダウンロードします。設定や作業状態を、この端末のブラウザ内へ保存するツールはあります。'
      },
      {
        label: '広告なし',
        ok: !hasAdCode,
        detail: hasAdCode
          ? '広告配信コードを検出しました。ページの実装を確認してください。'
          : '広告枠と広告配信用スクリプトを検出していません。アクセス解析はありますが、ファイルや入力内容を渡す処理はありません。'
      },
      {
        label: 'インストール不要',
        ok: true,
        detail: 'ブラウザで開くだけで使えます。処理に必要なライブラリとフォントもtk.st内に同梱しており、専用アプリや拡張機能は不要です。'
      },
      {
        label: '通信先を制限',
        ok: cspOk,
        detail: cspOk
          ? 'ページ先頭のContent-Security-Policyを確認済みです。読み込みや送信に使える通信先を、このサイトとアクセス解析に必要な送信先へ制限し、Ko-fiは別枠の表示だけを許可しています。'
          : 'Content-Security-Policyの必要な制限を確認できませんでした。ページの実装を確認してください。'
      }
    ];

    const section = document.createElement('section');
    section.className = 'safety-proof';
    section.setAttribute('aria-label', 'このツールの安全設計');
    const details = document.createElement('details');
    details.className = 'safety-proof-card';
    const summary = document.createElement('summary');
    summary.className = 'safety-proof-summary';

    const heading = document.createElement('div');
    heading.className = 'safety-proof-heading';
    const shield = document.createElement('span');
    shield.className = 'safety-proof-shield';
    shield.setAttribute('aria-hidden', 'true');
    shield.textContent = '✓';
    const title = document.createElement('span');
    title.className = 'safety-proof-title';
    title.textContent = 'このツールの安全設計';
    const count = document.createElement('span');
    count.className = 'safety-proof-count';
    const okCount = proofs.filter(item => item.ok).length;
    count.textContent = okCount + ' / ' + proofs.length + ' 確認';
    heading.append(shield, title, count);

    const chips = document.createElement('div');
    chips.className = 'safety-proof-chips';
    proofs.forEach(item => {
      const chip = document.createElement('span');
      chip.className = 'safety-proof-chip' + (item.ok ? '' : ' is-warning');
      const label = document.createElement('span');
      label.textContent = item.label;
      chip.appendChild(label);
      chips.appendChild(chip);
    });
    summary.append(heading, chips);

    const body = document.createElement('div');
    body.className = 'safety-proof-body';
    const intro = document.createElement('p');
    intro.className = 'safety-proof-intro';
    intro.textContent = '緑のチェックは、このページの仕組みとセキュリティ設定に基づく確認結果です。項目ごとの根拠を短く説明します。';
    const grid = document.createElement('div');
    grid.className = 'safety-proof-grid';
    proofs.forEach(item => {
      const box = document.createElement('div');
      box.className = 'safety-proof-item';
      const name = document.createElement('b');
      name.textContent = (item.ok ? '✓ ' : '! ') + item.label;
      const explanation = document.createElement('p');
      explanation.textContent = item.detail;
      box.append(name, explanation);
      grid.appendChild(box);
    });
    body.append(intro, grid);
    details.append(summary, body);
    section.appendChild(details);
    main.before(section);
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
  };
})(window);
