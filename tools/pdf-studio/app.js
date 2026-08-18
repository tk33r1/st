/* PDF Studio — client-side PDF editor for ST TOOLS.
 *
 * Everything happens in the browser: pdf.js renders (thumbnails, rasterisation)
 * and pdf-lib writes. No bytes ever leave the page.
 *
 * The editor keeps a flat `pages` array as the single source of truth — its
 * order *is* the output order. Each entry points back at a loaded document
 * rather than owning page data, so reordering and duplicating stay cheap.
 */
(function () {
  'use strict';

  const { formatBytes, showToast, switchView, setupDropzone, isPrivateHost } = window.STCommon;
  const { PDFDocument, degrees } = PDFLib;

  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  const MAX_FILE_SIZE = 300 * 1024 * 1024;
  const HEAVY_PAGE_COUNT = 400;
  const THUMB_WIDTH = 200;
  const THUMB_CONCURRENCY = 3;
  const THUMB_CACHE_LIMIT = 900;
  const HISTORY_LIMIT = 30;
  const MM_TO_PT = 72 / 25.4;
  const REDACTION_DPI = 300;
  const DRAG_THRESHOLD = 6;
  // Browsers cap both the side length and the total pixel count of a <canvas>.
  // Past either one the context comes back blank rather than throwing, so the
  // ceiling has to be applied before anything is drawn.
  const MAX_CANVAS_SIDE = 16384;
  const MAX_CANVAS_AREA = 128 * 1024 * 1024;

  // Sheet presets, all landscape, in PDF points.
  const SHEETS = {
    a4:     [841.89, 595.28],
    a3:     [1190.55, 841.89],
    b5:     [728.50, 515.91],
    letter: [792, 612],
  };

  // ---------------------------------------------------------------- state

  /** @type {Map<number, {id:number,name:string,bytes:Uint8Array,pdfjs:any,pdflib:any}>} */
  const docs = new Map();
  /** @type {Array<{uid:number,docId:number,src:number,rot:number,redactions:Array}>} */
  let pages = [];
  const selection = new Set();
  const history = [];
  const thumbCache = new Map();

  let docSeq = 0;
  let pageSeq = 0;
  let lastAnchor = null;      // uid of the last plain click, for shift-range select
  let activeUid = null;       // the one card that holds the grid's tab stop
  let suppressClick = false;  // set for the click that trails a finished drag
  let lastBlob = null;
  let lastFilename = '';
  let busy = false;
  let exportAbort = false;
  let scaleWasClamped = false;

  // ---------------------------------------------------------------- helpers

  const $ = (id) => document.getElementById(id);
  const norm360 = (n) => ((n % 360) + 360) % 360;

  function setView(id) {
    switchView(id);
    const isLanding = id === 'view-upload';
    $('hero').classList.toggle('hidden', !isLanding);
    $('tool-copy').classList.toggle('hidden', !isLanding);
  }

  function setProgress(ratio, msg, submsg) {
    const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
    $('progress-bar').style.width = pct + '%';
    $('progress-text').textContent = pct + '%';
    if (msg) $('loading-msg').textContent = msg;
    if (submsg) $('loading-submsg').textContent = submsg;
  }

  // Let the browser paint the progress bar between heavy synchronous chunks.
  const yieldToPaint = () => new Promise((r) => setTimeout(r, 0));

  /** The same breather, but it also lets the cancel button take effect. */
  async function yieldExport() {
    await yieldToPaint();
    if (!exportAbort) return;
    const err = new Error('cancelled by user');
    err.name = 'AbortByUser';
    throw err;
  }

  function setCancellable(on) {
    $('btn-cancel-export').classList.toggle('hidden', !on);
  }

  const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), '
    + 'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  let modalReturnFocus = null;

  function openModal(id) {
    const modal = $(id);
    modalReturnFocus = document.activeElement;
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    const first = modal.querySelector(FOCUSABLE);
    if (first) first.focus();
  }

  function closeModal(id) {
    const modal = $(id);
    // Focus has to leave before the dialog is hidden. An element inside a
    // hidden subtree still holds document.activeElement, which strands the
    // keyboard on a control nobody can see.
    if (document.activeElement && modal.contains(document.activeElement)) {
      document.activeElement.blur();
    }
    modal.classList.add('hidden');
    document.body.style.overflow = '';
    // The card that opened the dialog may have been rebuilt in the meantime.
    if (modalReturnFocus && modalReturnFocus.isConnected && modalReturnFocus !== document.body) {
      modalReturnFocus.focus();
    }
    modalReturnFocus = null;
  }

  // The backdrop is translucent, so without a trap the focus ring wanders into
  // the editor behind it while the dialog still looks like it owns the screen.
  function trapFocus(e) {
    if (e.key !== 'Tab') return;
    const modal = document.querySelector('.modal-backdrop:not(.hidden)');
    if (!modal) return;
    const items = [...modal.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function sanitizeFilename(name) {
    const cleaned = String(name || '').replace(/[\\/:*?"<>|]/g, '_').trim();
    return cleaned || 'pdf-studio';
  }

  function stripExtension(name) {
    return String(name || '').replace(/\.pdf$/i, '');
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // ---------------------------------------------------------------- history

  function snapshot() {
    history.push(pages.map((p) => ({ ...p, redactions: p.redactions.map((r) => ({ ...r })) })));
    if (history.length > HISTORY_LIMIT) {
      history.shift();
      pruneDocs();
    }
    $('btn-undo').disabled = false;
  }

  function undo() {
    if (!history.length) return;
    pages = history.pop();
    const alive = new Set(pages.map((p) => p.uid));
    [...selection].forEach((uid) => { if (!alive.has(uid)) selection.delete(uid); });
    $('btn-undo').disabled = history.length === 0;
    pruneDocs();
    renderGrid();
  }

  // ---------------------------------------------------------------- loading

  function isPdfFile(file) {
    return file && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name));
  }

  async function addFiles(fileList) {
    const files = Array.from(fileList).filter(isPdfFile);
    if (!files.length) {
      showToast('PDFファイルを選択してください。', 'error');
      return;
    }

    const oversized = files.find((f) => f.size > MAX_FILE_SIZE);
    if (oversized) {
      showToast(`ファイルサイズが大きすぎます（上限: ${formatBytes(MAX_FILE_SIZE)}）`, 'error');
      return;
    }

    const hadPages = pages.length > 0;
    if (hadPages) snapshot();

    setView('view-loading');
    setProgress(0, 'PDFを読み込んでいます...', `${files.length} 個のファイル`);

    let added = 0;
    const failures = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      setProgress(i / files.length, null, file.name);
      try {
        added += await loadOneFile(file);
      } catch (err) {
        failures.push({ name: file.name, err });
      }
      await yieldToPaint();
    }

    if (!pages.length) {
      setView('view-upload');
      reportFailures(failures);
      return;
    }

    setProgress(1);
    renderGrid();
    setView('view-preview');

    if (failures.length) {
      reportFailures(failures);
    } else if (hadPages) {
      showToast(`${added} ページを追加しました`);
    } else if (pages.length > HEAVY_PAGE_COUNT) {
      showToast(`${pages.length} ページ読み込みました。ページ数が多いため書き出しに時間がかかります。`);
    } else {
      showToast(`${pages.length} ページ読み込みました`);
    }
  }

  function reportFailures(failures) {
    if (!failures.length) return;
    const first = failures[0];
    const encrypted = first.err && (first.err.name === 'PasswordException' ||
      /encrypt/i.test(String(first.err && first.err.message)));
    const reason = encrypted
      ? 'パスワードで保護されているため読み込めません。先にパスワードを解除してください。'
      : 'PDFとして読み込めませんでした。ファイルが壊れている可能性があります。';
    const prefix = failures.length > 1 ? `${failures.length} 個のファイルを読み込めませんでした: ` : `${first.name}: `;
    showToast(prefix + reason, 'error');
  }

  async function loadOneFile(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());

    // pdf-lib refuses encrypted documents outright, which is the cleanest
    // place to detect them — pdf.js would only fail later, mid-render.
    const pdflib = await PDFDocument.load(bytes.slice(), { throwOnInvalidObject: false });
    // pdf.js takes ownership of whatever buffer it is handed, so give it a copy.
    const pdfjs = await pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;

    const id = ++docSeq;
    // `bytes` itself is not kept: pdf.js and pdf-lib each own a copy already,
    // and a third would cost a whole extra file's worth of memory per document.
    docs.set(id, { id, name: file.name, size: file.size, pdfjs, pdflib });

    const count = pdflib.getPageCount();
    for (let i = 0; i < count; i++) {
      pages.push({ uid: ++pageSeq, docId: id, src: i, rot: 0, redactions: [] });
    }
    return count;
  }

  /**
   * Release documents that no page points at any more, so a long
   * merge-then-delete session doesn't hold every PDF it ever opened. A document
   * still referenced by an undo snapshot has to stay: undo would otherwise
   * restore pages whose source is gone.
   */
  function pruneDocs() {
    const used = new Set();
    pages.forEach((p) => used.add(p.docId));
    history.forEach((snap) => snap.forEach((p) => used.add(p.docId)));
    docs.forEach((doc, id) => {
      if (used.has(id)) return;
      try { doc.pdfjs.destroy(); } catch (e) { /* already gone */ }
      docs.delete(id);
      // Otherwise the released document's thumbnails sit in the cache until
      // the LRU limit happens to push them out.
      const prefix = id + '|';
      [...thumbCache.keys()].forEach((k) => { if (k.startsWith(prefix)) thumbCache.delete(k); });
    });
  }

  /** Combined size of the source files the *current* pages actually came from. */
  function currentOriginalBytes() {
    const used = new Set(pages.map((p) => p.docId));
    let total = 0;
    used.forEach((id) => {
      const doc = docs.get(id);
      if (doc) total += doc.size;
    });
    return total;
  }

  // ---------------------------------------------------------------- url import

  let urlLoading = false;

  async function loadFromUrl(rawUrl) {
    const url = String(rawUrl || '').trim();
    if (!url || urlLoading) return;

    let target;
    try {
      target = new URL(url);
    } catch {
      showToast('URLの形式が正しくありません', 'error');
      return;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      showToast('http(s) のURLを指定してください', 'error');
      return;
    }
    if (isPrivateHost(target.hostname)) {
      showToast('ローカル/プライベートIPのURLは利用できません', 'error');
      return;
    }

    const fallbackView = pages.length ? 'view-preview' : 'view-upload';
    urlLoading = true;
    $('url-btn').disabled = true;
    setView('view-loading');
    setProgress(0, 'ダウンロード中...', 'PDFを取得しています');

    try {
      const file = await fetchPdfAsFile(url, target);
      $('url-input').value = '';
      await addFiles([file]);
    } catch (err) {
      if (!err || err.name !== 'AbortByUser') {
        console.error('URL load failed', err);
        showToast(`取得失敗: ${err && err.message ? err.message : 'unknown'}`, 'error');
      }
      setView(fallbackView);
    } finally {
      urlLoading = false;
      $('url-btn').disabled = false;
    }
  }

  async function fetchPdfAsFile(url, target) {
    let response;
    let usedProxy = false;

    try {
      response = await fetch(url, { mode: 'cors', credentials: 'omit' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (directError) {
      console.warn('direct fetch failed', directError);
      const ok = window.confirm(
        '直接のPDF取得に失敗しました。\n外部プロキシ経由で再試行しますか？\n\n'
        + '注意: プロキシ運営者にURLとPDFの内容が渡ります。'
      );
      if (!ok) {
        const cancelled = new Error('cancelled by user');
        cancelled.name = 'AbortByUser';
        throw cancelled;
      }
      usedProxy = true;
      const proxied = await fetch(`https://corsproxy.io/?url=${encodeURIComponent(url)}`,
        { mode: 'cors', credentials: 'omit' });
      if (!proxied.ok) throw new Error(`プロキシでも失敗 (HTTP ${proxied.status})`);
      response = proxied;
    }

    const blob = await response.blob();
    const type = (blob.type || response.headers.get('content-type') || '').toLowerCase();
    const looksLikePdf = type.includes('pdf')
      || type === 'application/octet-stream'
      || /\.pdf(?:$|\?)/i.test(target.pathname);
    if (!looksLikePdf) {
      throw new Error(`PDFではないデータを受信しました (${type || 'unknown'})`);
    }

    // Check the %PDF- magic too, so a redirected HTML error page can't slip
    // through the octet-stream / .pdf-path heuristics above.
    const head = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
    if (String.fromCharCode.apply(null, head) !== '%PDF-') {
      throw new Error('受信したデータがPDFではありません');
    }

    const last = target.pathname.split('/').pop();
    const filename = last && /\.pdf$/i.test(last) ? decodeURIComponent(last) : 'downloaded.pdf';
    if (usedProxy) showToast('プロキシ経由で取得しました');
    return new File([blob], filename, { type: 'application/pdf' });
  }

  // ---------------------------------------------------------------- geometry

  /** Total clockwise rotation a page is displayed at, source /Rotate included. */
  function totalRotation(page) {
    const doc = docs.get(page.docId);
    const base = doc.pdflib.getPage(page.src).getRotation().angle;
    return norm360(base + page.rot);
  }

  /** Visible size in PDF points, after rotation. */
  function visualSize(page) {
    const doc = docs.get(page.docId);
    // CropBox rather than MediaBox: pdf.js renders the crop region, so sizing
    // an output page by the media box stretches the bitmap on cropped PDFs
    // (trim marks, imposition proofs) where the two rectangles differ.
    const { width, height } = doc.pdflib.getPage(page.src).getCropBox();
    return totalRotation(page) % 180 === 0
      ? { width, height }
      : { width: height, height: width };
  }

  // ---------------------------------------------------------------- rendering

  /**
   * Render one editor page to a canvas at `scale`, with its redaction boxes
   * burned in. Used by thumbnails, the redaction modal and every raster export.
   */
  /**
   * Hold a requested scale down to what a <canvas> can actually hold. Oversized
   * bitmaps fail silently, so an A0 sheet at 4x has to be pulled back rather
   * than handed to the renderer and quietly lost.
   */
  function clampScale(base, scale) {
    const limit = Math.min(
      MAX_CANVAS_SIDE / base.width,
      MAX_CANVAS_SIDE / base.height,
      Math.sqrt(MAX_CANVAS_AREA / (base.width * base.height))
    );
    if (scale <= limit) return scale;
    scaleWasClamped = true;
    return limit;
  }

  async function renderPageToCanvas(page, scale, opts) {
    const settings = opts || {};
    const doc = docs.get(page.docId);
    const pdfPage = await doc.pdfjs.getPage(page.src + 1);
    const rotation = totalRotation(page);
    const safeScale = clampScale(pdfPage.getViewport({ scale: 1, rotation }), scale);
    const viewport = pdfPage.getViewport({ scale: safeScale, rotation });

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const ctx = canvas.getContext('2d', { alpha: false });

    // PDF pages are transparent by default; printing assumes paper white.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await pdfPage.render({ canvasContext: ctx, viewport }).promise;

    if (!settings.skipRedactions && page.redactions.length) {
      ctx.fillStyle = '#000000';
      page.redactions.forEach((r) => {
        ctx.fillRect(r.x * canvas.width, r.y * canvas.height, r.w * canvas.width, r.h * canvas.height);
      });
    }

    return canvas;
  }

  const thumbQueue = [];
  let thumbActive = 0;

  function queueThumb(page, imgEl) {
    thumbQueue.push({ page, imgEl });
    pumpThumbQueue();
  }

  function pumpThumbQueue() {
    while (thumbActive < THUMB_CONCURRENCY && thumbQueue.length) {
      const job = thumbQueue.shift();
      thumbActive++;
      renderThumb(job.page, job.imgEl).finally(() => {
        thumbActive--;
        pumpThumbQueue();
      });
    }
  }

  /**
   * Cache identity for a thumbnail: everything that changes how it looks. The
   * boxes have to be spelled out — moving a redaction without changing how many
   * there are still changes the picture.
   */
  function thumbKey(page) {
    const boxes = page.redactions
      .map((r) => `${r.x.toFixed(4)},${r.y.toFixed(4)},${r.w.toFixed(4)},${r.h.toFixed(4)}`)
      .join(';');
    return `${page.docId}|${page.src}|${totalRotation(page)}|${boxes}`;
  }

  async function renderThumb(page, imgEl) {
    const key = thumbKey(page);
    let url = thumbCache.get(key);
    if (!url) {
      try {
        const doc = docs.get(page.docId);
        const pdfPage = await doc.pdfjs.getPage(page.src + 1);
        const base = pdfPage.getViewport({ scale: 1, rotation: totalRotation(page) });
        const canvas = await renderPageToCanvas(page, THUMB_WIDTH / base.width);
        url = canvas.toDataURL('image/jpeg', 0.72);
        // Every rotation of every page gets its own entry; drop the oldest
        // rather than letting a long session grow without bound.
        if (thumbCache.size >= THUMB_CACHE_LIMIT) {
          thumbCache.delete(thumbCache.keys().next().value);
        }
        thumbCache.set(key, url);
      } catch (err) {
        console.warn('thumbnail render failed', err);
        return;
      }
    }
    // The grid may have been rebuilt while this job was queued.
    if (!imgEl.isConnected) return;
    imgEl.src = url;
    imgEl.classList.remove('hidden');
    const skeleton = imgEl.previousElementSibling;
    if (skeleton && skeleton.classList.contains('thumb-skeleton')) skeleton.remove();
  }

  // ---------------------------------------------------------------- grid

  const ICON = {
    rotCw:  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M21 13a9 9 0 1 1-3-7.7L21 8"/></svg>',
    rotCcw: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2v6h6"/><path d="M3 13a9 9 0 1 0 3-7.7L3 8"/></svg>',
    eraser: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 21-4.3-4.3a1 1 0 0 1 0-1.4l9.6-9.6a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4L13 21"/><path d="M22 21H7"/></svg>',
    trash:  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6"/></svg>',
    grip:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>',
  };

  const gridEl = $('page-grid');

  function renderGrid() {
    thumbQueue.length = 0;
    const frag = document.createDocumentFragment();
    const multiDoc = docs.size > 1;

    // The tab stop has to land on a page that still exists.
    if (!pages.some((p) => p.uid === activeUid)) {
      activeUid = pages.length ? pages[0].uid : null;
    }

    pages.forEach((page, index) => {
      frag.appendChild(createPageCard(page, index, multiDoc));
    });

    gridEl.replaceChildren(frag);
    updateToolbar();
  }

  /**
   * Roving tabindex: one tab stop for the whole grid, arrow keys inside it.
   * 300 pages would otherwise mean 1500 stops between here and the toolbar.
   */
  function setActiveCard(uid, focus) {
    activeUid = uid;
    gridEl.querySelectorAll('.page-card').forEach((el) => {
      el.tabIndex = Number(el.dataset.uid) === uid ? 0 : -1;
    });
    if (!focus) return;
    const card = gridEl.querySelector(`.page-card[data-uid="${uid}"]`);
    if (card) card.focus();
  }

  function columnCount() {
    const cols = getComputedStyle(gridEl).gridTemplateColumns;
    return Math.max(1, cols.split(' ').filter(Boolean).length);
  }

  function createPageCard(page, index, showSource) {
    const card = document.createElement('div');
    card.className = 'page-card' + (selection.has(page.uid) ? ' selected' : '');
    card.dataset.uid = String(page.uid);
    card.tabIndex = page.uid === activeUid ? 0 : -1;
    card.setAttribute('role', 'option');
    card.setAttribute('aria-selected', String(selection.has(page.uid)));

    const hasRedaction = page.redactions.length > 0;
    const sourceName = showSource ? docs.get(page.docId).name : '';
    // Without this the card announces as a bare "1" — the thumbnail carries no
    // text and the page number is the only thing in it.
    card.setAttribute('aria-label', `${index + 1}ページ目`
      + (sourceName ? `（${sourceName}）` : '')
      + (hasRedaction ? '、墨消しあり' : ''));

    card.innerHTML = `
      <div class="page-thumb-wrap">
        <div class="thumb-skeleton"></div>
        <img class="page-thumb hidden" alt="">
      </div>
      ${sourceName ? `<span class="page-badge" title="${escapeAttr(sourceName)}">${escapeHtml(sourceName)}</span>` : ''}
      ${hasRedaction ? '<span class="page-badge redacted">墨消し</span>' : ''}
      <div class="page-actions${hasRedaction ? ' has-redaction' : ''}">
        <button class="page-act" data-act="ccw" title="左に90°回転" aria-label="左に90°回転">${ICON.rotCcw}</button>
        <button class="page-act" data-act="cw" title="右に90°回転" aria-label="右に90°回転">${ICON.rotCw}</button>
        <button class="page-act" data-act="redact" title="墨消し" aria-label="墨消し">${ICON.eraser}</button>
        <button class="page-act danger" data-act="del" title="このページを削除" aria-label="このページを削除">${ICON.trash}</button>
      </div>
      <span class="page-grip" title="ドラッグして並べ替え" aria-hidden="true">${ICON.grip}</span>
      <span class="page-num">${index + 1}</span>
    `;
    card.querySelectorAll('.page-act').forEach((b) => { b.tabIndex = -1; });

    queueThumb(page, card.querySelector('.page-thumb'));
    return card;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (m) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));
  }
  const escapeAttr = escapeHtml;

  function updateToolbar() {
    $('page-count').textContent = String(pages.length);
    const selCount = selection.size;
    const selEl = $('sel-count');
    selEl.classList.toggle('hidden', selCount === 0);
    selEl.textContent = `${selCount} 選択中`;

    $('btn-select-none').disabled = selCount === 0;
    $('btn-rot-left').disabled = pages.length === 0;
    $('btn-rot-right').disabled = pages.length === 0;
    $('btn-delete').disabled = selCount === 0;
    $('btn-export').disabled = pages.length === 0;
    $('btn-interleave').disabled = docs.size < 2;
    $('btn-undo').disabled = history.length === 0;
  }

  function refreshCard(uid) {
    const card = gridEl.querySelector(`.page-card[data-uid="${uid}"]`);
    if (!card) return;
    const index = pages.findIndex((p) => p.uid === uid);
    if (index < 0) return;
    const replacement = createPageCard(pages[index], index, docs.size > 1);
    card.replaceWith(replacement);
    pumpThumbQueue();
  }

  // ---------------------------------------------------------------- selection

  function setSelected(uid, on) {
    if (on) selection.add(uid); else selection.delete(uid);
    const card = gridEl.querySelector(`.page-card[data-uid="${uid}"]`);
    if (card) {
      card.classList.toggle('selected', on);
      card.setAttribute('aria-selected', String(on));
    }
  }

  function selectRange(fromUid, toUid) {
    const a = pages.findIndex((p) => p.uid === fromUid);
    const b = pages.findIndex((p) => p.uid === toUid);
    if (a < 0 || b < 0) return;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) setSelected(pages[i].uid, true);
  }

  function selectedPages() {
    return pages.filter((p) => selection.has(p.uid));
  }

  /** Pages an action applies to: the selection, or everything when nothing is picked. */
  function targetPages() {
    return selection.size ? selectedPages() : pages;
  }

  // ---------------------------------------------------------------- edit ops

  function rotatePages(list, delta) {
    if (!list.length) return;
    snapshot();
    list.forEach((p) => {
      p.rot = norm360(p.rot + delta);
      refreshCard(p.uid);
    });
    updateToolbar();
  }

  function deletePages(list) {
    if (!list.length) return;
    if (list.length === pages.length) {
      showToast('すべてのページは削除できません。', 'error');
      return;
    }
    snapshot();
    const doomed = new Set(list.map((p) => p.uid));
    const firstGone = pages.findIndex((p) => doomed.has(p.uid));
    const keepFocus = gridEl.contains(document.activeElement);
    pages = pages.filter((p) => !doomed.has(p.uid));
    doomed.forEach((uid) => selection.delete(uid));
    pruneDocs();
    // Land on the page that slid into the deleted one's place, so keyboard
    // users aren't thrown back to the top of the document.
    const next = pages[Math.min(Math.max(firstGone, 0), pages.length - 1)];
    if (next) activeUid = next.uid;
    renderGrid();
    if (keepFocus && next) setActiveCard(next.uid, true);
    showToast(`${doomed.size} ページ削除しました`);
  }

  function movePage(fromIndex, toIndex) {
    if (fromIndex === toIndex || toIndex < 0 || fromIndex < 0) return;
    snapshot();
    const [moved] = pages.splice(fromIndex, 1);
    pages.splice(toIndex, 0, moved);
    renderGrid();
  }

  // ---------------------------------------------------------------- interleave

  function openInterleave() {
    if (docs.size < 2) {
      showToast('交互結合には2つ以上のPDFが必要です。「PDFを追加」から読み込んでください。', 'error');
      return;
    }
    const list = [...docs.values()];
    const options = list.map((d) =>
      `<option value="${d.id}">${escapeHtml(d.name)}（${d.pdflib.getPageCount()}ページ）</option>`).join('');
    $('il-odd').innerHTML = options;
    $('il-even').innerHTML = options;
    $('il-odd').value = String(list[0].id);
    $('il-even').value = String(list[1].id);
    openModal('modal-interleave');
  }

  function applyInterleave() {
    const oddId = Number($('il-odd').value);
    const evenId = Number($('il-even').value);
    if (oddId === evenId) {
      showToast('表面と裏面には別々のPDFを選んでください。', 'error');
      return;
    }

    const odd = pages.filter((p) => p.docId === oddId);
    const even = pages.filter((p) => p.docId === evenId);
    if (!odd.length || !even.length) {
      showToast('選んだPDFのページが編集画面に残っていません。', 'error');
      return;
    }
    if ($('il-reverse').checked) even.reverse();

    snapshot();
    const merged = [];
    const max = Math.max(odd.length, even.length);
    for (let i = 0; i < max; i++) {
      if (odd[i]) merged.push(odd[i]);
      if (even[i]) merged.push(even[i]);
    }
    // Pages from any other document keep their place at the end.
    const others = pages.filter((p) => p.docId !== oddId && p.docId !== evenId);
    pages = merged.concat(others);

    selection.clear();
    renderGrid();
    closeModal('modal-interleave');
    showToast(`${merged.length} ページを交互に組み直しました`);
  }

  // ---------------------------------------------------------------- redaction

  let redactTarget = null;
  let redactRects = [];
  let redactDrag = null;

  async function openRedact(uid) {
    const page = pages.find((p) => p.uid === uid);
    if (!page) return;

    redactTarget = page;
    redactRects = page.redactions.map((r) => ({ ...r }));
    $('redact-all-pages').checked = false;
    $('redact-page-label').textContent = `（${pages.indexOf(page) + 1} ページ目）`;

    const doc = docs.get(page.docId);
    const pdfPage = await doc.pdfjs.getPage(page.src + 1);
    const base = pdfPage.getViewport({ scale: 1, rotation: totalRotation(page) });
    const scale = Math.min(2, Math.max(0.5, 900 / base.width));
    const canvas = await renderPageToCanvas(page, scale, { skipRedactions: true });

    const target = $('redact-canvas');
    target.width = canvas.width;
    target.height = canvas.height;
    target.getContext('2d').drawImage(canvas, 0, 0);

    drawRedactOverlay();
    openModal('modal-redact');
  }

  function drawRedactOverlay() {
    const overlay = $('redact-overlay');
    overlay.replaceChildren();
    redactRects.forEach((rect, i) => {
      const el = document.createElement('div');
      el.className = 'redact-rect';
      el.style.left = rect.x * 100 + '%';
      el.style.top = rect.y * 100 + '%';
      el.style.width = rect.w * 100 + '%';
      el.style.height = rect.h * 100 + '%';
      el.innerHTML = '<button type="button" aria-label="この墨消しを削除">&times;</button>';
      el.querySelector('button').addEventListener('click', (e) => {
        e.stopPropagation();
        redactRects.splice(i, 1);
        drawRedactOverlay();
      });
      overlay.appendChild(el);
    });
  }

  function setupRedactDrawing() {
    const stage = $('redact-stage');
    const live = $('redact-live');

    const pointFrom = (e) => {
      const rect = stage.getBoundingClientRect();
      return {
        x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
        y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
      };
    };

    stage.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.redact-rect')) return;
      redactDrag = pointFrom(e);
      stage.setPointerCapture(e.pointerId);
      live.style.display = 'block';
      live.style.left = redactDrag.x * 100 + '%';
      live.style.top = redactDrag.y * 100 + '%';
      live.style.width = '0%';
      live.style.height = '0%';
    });

    stage.addEventListener('pointermove', (e) => {
      if (!redactDrag) return;
      const p = pointFrom(e);
      live.style.left = Math.min(redactDrag.x, p.x) * 100 + '%';
      live.style.top = Math.min(redactDrag.y, p.y) * 100 + '%';
      live.style.width = Math.abs(p.x - redactDrag.x) * 100 + '%';
      live.style.height = Math.abs(p.y - redactDrag.y) * 100 + '%';
    });

    const finish = (e) => {
      if (!redactDrag) return;
      const p = pointFrom(e);
      const rect = {
        x: Math.min(redactDrag.x, p.x),
        y: Math.min(redactDrag.y, p.y),
        w: Math.abs(p.x - redactDrag.x),
        h: Math.abs(p.y - redactDrag.y),
      };
      redactDrag = null;
      live.style.display = 'none';
      // Ignore stray clicks — a redaction has to actually cover something.
      if (rect.w > 0.004 && rect.h > 0.004) {
        redactRects.push(rect);
        drawRedactOverlay();
      }
    };

    stage.addEventListener('pointerup', finish);
    stage.addEventListener('pointercancel', () => { redactDrag = null; live.style.display = 'none'; });
  }

  function applyRedaction() {
    if (!redactTarget) return;
    const everyPage = $('redact-all-pages').checked;
    const copy = () => redactRects.map((r) => ({ ...r }));

    snapshot();
    if (everyPage) {
      // The rectangles are stored as fractions of the page, so the same band
      // lands in the same relative spot whatever the page size is.
      pages.forEach((p) => { p.redactions = copy(); });
      renderGrid();
    } else {
      redactTarget.redactions = copy();
      refreshCard(redactTarget.uid);
    }
    updateToolbar();
    closeModal('modal-redact');

    if (!redactRects.length) {
      showToast(everyPage ? 'すべてのページの墨消しを解除しました' : '墨消しを解除しました');
    } else if (everyPage) {
      showToast(`${pages.length} ページすべてに ${redactRects.length} 箇所の墨消しを設定しました`);
    } else {
      showToast(`${redactRects.length} 箇所を墨消しに設定しました（書き出し時に適用）`);
    }
    redactTarget = null;
  }

  // ---------------------------------------------------------------- building

  /**
   * Copy `list` into a fresh PDF. Pages keep their vector content unless they
   * carry redactions or `opts.compress` is set, in which case they are redrawn
   * as images — which is exactly what makes the redaction irreversible.
   */
  async function buildPdf(list, opts, onProgress) {
    const settings = opts || {};
    const out = await PDFDocument.create();
    const needsRaster = (p) => settings.compress || p.redactions.length > 0;

    // Copy in one call per source document: separate calls would duplicate
    // shared resources (fonts, images) and balloon the output.
    const copies = new Array(list.length);
    const groups = new Map();
    list.forEach((p, i) => {
      if (needsRaster(p)) return;
      if (!groups.has(p.docId)) groups.set(p.docId, []);
      groups.get(p.docId).push({ i, src: p.src });
    });
    for (const [docId, items] of groups) {
      const copied = await out.copyPages(docs.get(docId).pdflib, items.map((it) => it.src));
      items.forEach((it, k) => { copies[it.i] = copied[k]; });
    }

    for (let i = 0; i < list.length; i++) {
      const page = list[i];
      if (copies[i]) {
        const copied = copies[i];
        copied.setRotation(degrees(norm360(copied.getRotation().angle + page.rot)));
        out.addPage(copied);
      } else {
        await drawRasterPage(out, page, settings);
      }
      if (onProgress) onProgress((i + 1) / list.length);
      if (i % 4 === 3) await yieldExport();
    }

    if (settings.stripMetadata !== false) applyCleanMetadata(out);
    return out;
  }

  async function drawRasterPage(out, page, settings) {
    const dpi = settings.compress ? Number(settings.dpi) || 150 : REDACTION_DPI;
    const quality = settings.compress ? Number(settings.quality) || 0.8 : 0.92;
    const size = visualSize(page);

    const canvas = await renderPageToCanvas(page, dpi / 72);
    const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
    const embedded = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));

    const target = out.addPage([size.width, size.height]);
    target.drawImage(embedded, { x: 0, y: 0, width: size.width, height: size.height });
  }

  function canvasToBlob(canvas, mime, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error(`${mime} への変換に失敗しました`));
      }, mime, quality);
    });
  }

  // ---------------------------------------------------------------- encoders

  // <canvas> can only emit PNG, JPEG and lossy WebP. AVIF and lossless WebP
  // come from jsquash's WASM encoders, pulled in only when actually chosen.
  const IMAGE_FORMATS = {
    png:             { mime: 'image/png',  ext: 'png',  label: 'PNG',      useQuality: false },
    jpeg:            { mime: 'image/jpeg', ext: 'jpg',  label: 'JPEG',     useQuality: true },
    webp:            { mime: 'image/webp', ext: 'webp', label: 'WebP',     useQuality: true },
    'webp-lossless': { mime: 'image/webp', ext: 'webp', label: 'WebP可逆', useQuality: false, encoder: 'webp' },
    avif:            { mime: 'image/avif', ext: 'avif', label: 'AVIF',     useQuality: true,  encoder: 'avif' },
  };

  const encoderPromises = {};
  function loadEncoder(kind) {
    if (!encoderPromises[kind]) {
      const url = kind === 'avif'
        ? 'https://esm.sh/@jsquash/avif@2.1.1'
        : 'https://esm.sh/@jsquash/webp@1.4.0';
      encoderPromises[kind] = import(url).then((m) => m.encode).catch((err) => {
        encoderPromises[kind] = null; // let a later attempt retry the download
        console.warn(`${kind} encoder failed to load`, err);
        throw new Error(`${kind.toUpperCase()} エンコーダを読み込めませんでした（オフラインの可能性があります）`);
      });
    }
    return encoderPromises[kind];
  }

  async function encodeCanvas(canvas, format, quality) {
    const spec = IMAGE_FORMATS[format] || IMAGE_FORMATS.png;
    if (!spec.encoder) {
      return canvasToBlob(canvas, spec.mime, spec.useQuality ? quality : undefined);
    }
    const imageData = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    const encode = await loadEncoder(spec.encoder);
    const buffer = spec.encoder === 'avif'
      ? await encode(imageData, { quality: Math.round(quality * 100) })
      : await encode(imageData, { lossless: 1, quality: 100, exact: 1 });
    return new Blob([buffer], { type: spec.mime });
  }

  function applyCleanMetadata(out) {
    out.setTitle('');
    out.setAuthor('');
    out.setSubject('');
    out.setKeywords([]);
    out.setProducer('');
    out.setCreator('');
    const epoch = new Date(0);
    out.setCreationDate(epoch);
    out.setModificationDate(epoch);
  }

  // ---------------------------------------------------------------- imposition

  /**
   * Place an embedded page inside `box`, scaled to fit and centred, honouring
   * the source page's /Rotate — which `embedPage` deliberately ignores.
   */
  function placeEmbedded(target, embedded, rotationCw, box) {
    const naturalW = embedded.width;
    const naturalH = embedded.height;
    const swapped = rotationCw % 180 !== 0;
    const visW = swapped ? naturalH : naturalW;
    const visH = swapped ? naturalW : naturalH;

    const scale = Math.min(box.w / visW, box.h / visH);
    const drawW = visW * scale;
    const drawH = visH * scale;
    const originX = box.x + (box.w - drawW) / 2;
    const originY = box.y + (box.h - drawH) / 2;

    // pdf-lib rotates counter-clockwise about (x, y); /Rotate is clockwise.
    const ccw = norm360(360 - rotationCw);
    let x = originX;
    let y = originY;
    if (ccw === 90) { x = originX + drawW; }
    else if (ccw === 180) { x = originX + drawW; y = originY + drawH; }
    else if (ccw === 270) { y = originY + drawH; }

    target.drawPage(embedded, { x, y, xScale: scale, yScale: scale, rotate: degrees(ccw) });
  }

  /** Saddle-stitch sheet order: outermost sheet first, front then back. */
  function bookletOrder(count) {
    const padded = Math.ceil(count / 4) * 4;
    const order = [];
    for (let i = 0; i < padded / 4; i++) {
      order.push([padded - 1 - 2 * i, 2 * i]);       // front of sheet i
      order.push([2 * i + 1, padded - 2 - 2 * i]);   // back of sheet i
    }
    // Indices beyond the real page count are the blanks that pad the booklet.
    return order.map(([l, r]) => [l < count ? l : null, r < count ? r : null]);
  }

  async function buildImposedPdf(list, opts, onProgress) {
    // Bake rotation and redactions first, then impose from that flat document.
    const baked = await buildPdf(list, { stripMetadata: opts.stripMetadata }, (r) => {
      if (onProgress) onProgress(r * 0.5);
    });
    const bakedBytes = await baked.save();

    const source = await PDFDocument.load(bakedBytes);
    const sourcePages = source.getPages();
    const out = await PDFDocument.create();
    // pdf-lib defaults the embed box to the MediaBox anchored at (0, 0), which
    // both ignores a CropBox and shifts pages whose media box starts off zero.
    // Hand it the crop rectangle so what gets imposed is what a reader sees.
    const boxes = sourcePages.map((p) => {
      const { x, y, width, height } = p.getCropBox();
      return { left: x, bottom: y, right: x + width, top: y + height };
    });
    const embedded = await out.embedPages(sourcePages, boxes);
    const rotations = sourcePages.map((p) => norm360(p.getRotation().angle));

    const pairs = opts.mode === 'booklet'
      ? bookletOrder(embedded.length)
      : pairUp(embedded.length);

    const [sheetW, sheetH] = resolveSheet(opts.sheet, sourcePages[0], rotations[0]);
    const gutter = Number(opts.gutter || 0) * MM_TO_PT;

    for (let i = 0; i < pairs.length; i++) {
      let [left, right] = pairs[i];
      if (opts.binding === 'right') { const t = left; left = right; right = t; }

      const sheet = out.addPage([sheetW, sheetH]);
      const halfW = sheetW / 2 - gutter * 1.5;
      const boxH = sheetH - gutter * 2;

      if (left != null) {
        placeEmbedded(sheet, embedded[left], rotations[left], { x: gutter, y: gutter, w: halfW, h: boxH });
      }
      if (right != null) {
        placeEmbedded(sheet, embedded[right], rotations[right], { x: sheetW / 2 + gutter * 0.5, y: gutter, w: halfW, h: boxH });
      }

      if (onProgress) onProgress(0.5 + ((i + 1) / pairs.length) * 0.5);
      if (i % 4 === 3) await yieldExport();
    }

    if (opts.stripMetadata !== false) applyCleanMetadata(out);
    return out;
  }

  function pairUp(count) {
    const pairs = [];
    for (let i = 0; i < count; i += 2) {
      pairs.push([i, i + 1 < count ? i + 1 : null]);
    }
    return pairs;
  }

  function resolveSheet(preset, firstPage, rotationCw) {
    if (SHEETS[preset]) return SHEETS[preset];
    // "auto": two portrait pages side by side on one landscape sheet of the
    // same paper, so a 2-up A4 job still prints on A4.
    const { width, height } = firstPage.getCropBox();
    const visW = rotationCw % 180 === 0 ? width : height;
    const visH = rotationCw % 180 === 0 ? height : width;
    return visW <= visH ? [visH, visW] : [visW, visH];
  }

  // ---------------------------------------------------------------- export

  function readExportOptions() {
    return {
      mode: segValue('ex-mode', 'mode'),
      compress: segValue('ex-compress', 'v') === 'on',
      dpi: Number($('ex-dpi').value),
      quality: Number($('ex-quality').value) / 100,
      stripMetadata: $('ex-strip-meta').checked,
      splitMode: segValue('ex-split-mode', 'v'),
      splitN: Math.max(1, Number($('ex-split-n').value) || 1),
      splitStripMetadata: $('ex-split-strip-meta').checked,
      imposeMode: segValue('ex-impose-mode', 'v'),
      binding: segValue('ex-bind', 'v'),
      sheet: $('ex-sheet').value,
      gutter: Number($('ex-gutter').value),
      imageFormat: segValue('ex-img-format', 'v'),
      imageScale: Number($('ex-img-scale').value),
      imageQuality: Number($('ex-img-quality').value) / 100,
      filename: sanitizeFilename($('ex-filename').value || defaultFilename()),
    };
  }

  function segValue(containerId, attr) {
    const active = $(containerId).querySelector('.seg-btn.active');
    return active ? active.dataset[attr] : '';
  }

  function defaultFilename() {
    const first = docs.values().next().value;
    return first ? stripExtension(first.name) + '-edited' : 'pdf-studio';
  }

  async function runExport() {
    if (busy) return;
    const opts = readExportOptions();
    closeModal('modal-export');
    busy = true;
    exportAbort = false;
    scaleWasClamped = false;
    setCancellable(true);
    setView('view-loading');
    setProgress(0, '書き出しています...', 'ブラウザ内で処理しています');

    try {
      if (opts.mode === 'pdf') await exportSinglePdf(opts);
      else if (opts.mode === 'split') await exportSplit(opts);
      else if (opts.mode === 'impose') await exportImposed(opts);
      else await exportImages(opts);
      if (scaleWasClamped) {
        showToast('ページが非常に大きいため、ブラウザの上限に合わせて解像度を下げました。');
      }
    } catch (err) {
      setView('view-preview');
      if (err && err.name === 'AbortByUser') {
        showToast('書き出しを中止しました');
      } else {
        console.error(err);
        showToast(`書き出しに失敗しました: ${err && err.message ? err.message : '不明なエラー'}`, 'error');
      }
    } finally {
      busy = false;
      exportAbort = false;
      setCancellable(false);
    }
  }

  function showResult(blob, filename, formatLabel, compareBase) {
    lastBlob = blob;
    lastFilename = filename;
    $('result-name').textContent = filename;
    $('result-format').textContent = formatLabel;
    $('result-size').textContent = formatBytes(blob.size);

    const compare = $('result-compare');
    compare.classList.remove('hidden', 'compare-bad');
    if (!compareBase || compareBase <= 0) {
      compare.classList.add('hidden');
    } else if (blob.size < compareBase) {
      const saved = Math.round((1 - blob.size / compareBase) * 100);
      compare.textContent = `元のファイルより ${saved}% 小さくなりました（${formatBytes(compareBase)} → ${formatBytes(blob.size)}）`;
    } else {
      // Rasterising a text/vector PDF reliably makes it bigger. Say so rather
      // than quietly handing back a worse file than the one they started with.
      compare.classList.add('compare-bad');
      compare.textContent = `元のファイルより大きくなりました（${formatBytes(compareBase)} → ${formatBytes(blob.size)}）。`
        + '文字や図形が中心のPDFは画像化すると増えます。圧縮なしで書き出し直すことをおすすめします。';
    }

    setView('view-result');
    downloadBlob(blob, filename);
    showToast('書き出しが完了しました！');
  }

  async function exportSinglePdf(opts) {
    setProgress(0, 'PDFを作成しています...', opts.compress ? 'ページを再構成しています' : 'ページをコピーしています');
    const out = await buildPdf(pages, opts, (r) => setProgress(r * 0.95));
    const bytes = await out.save();
    setProgress(1);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    showResult(blob, `${opts.filename}.pdf`, 'PDF', opts.compress ? currentOriginalBytes() : 0);
  }

  async function exportSplit(opts) {
    const chunks = buildSplitChunks(opts);
    if (!chunks.length) {
      throw new Error('分割対象のページがありません');
    }

    if (chunks.length === 1) {
      setProgress(0, 'PDFを作成しています...');
      const out = await buildPdf(chunks[0].list, { stripMetadata: opts.splitStripMetadata }, (r) => setProgress(r * 0.95));
      const bytes = await out.save();
      const blob = new Blob([bytes], { type: 'application/pdf' });
      showResult(blob, `${opts.filename}-${chunks[0].label}.pdf`, 'PDF', 0);
      return;
    }

    const zip = new JSZip();
    for (let i = 0; i < chunks.length; i++) {
      setProgress(i / chunks.length, '分割しています...', `${i + 1} / ${chunks.length} ファイル`);
      const out = await buildPdf(chunks[i].list, { stripMetadata: opts.splitStripMetadata });
      zip.file(`${opts.filename}-${chunks[i].label}.pdf`, await out.save());
      await yieldExport();
    }

    setProgress(0.97, 'ZIPにまとめています...', `${chunks.length} ファイル`);
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    setProgress(1);
    showResult(blob, `${opts.filename}.zip`, `ZIP（${chunks.length}ファイル）`, 0);
  }

  function buildSplitChunks(opts) {
    const pad = (n) => String(n).padStart(String(pages.length).length, '0');

    if (opts.splitMode === 'selected') {
      const list = selectedPages();
      if (!list.length) throw new Error('ページが選択されていません。編集画面でページを選んでください。');
      return [{ list, label: `selected-${list.length}p` }];
    }

    const size = opts.splitMode === 'each' ? 1 : opts.splitN;
    const chunks = [];
    for (let i = 0; i < pages.length; i += size) {
      const list = pages.slice(i, i + size);
      const label = size === 1 ? `p${pad(i + 1)}` : `p${pad(i + 1)}-${pad(i + list.length)}`;
      chunks.push({ list, label });
    }
    return chunks;
  }

  async function exportImposed(opts) {
    setProgress(0, '面付けしています...', opts.imposeMode === 'booklet' ? '中綴じの並び順に組み替えています' : '2ページを1枚に配置しています');
    const out = await buildImposedPdf(pages, {
      mode: opts.imposeMode,
      binding: opts.binding,
      sheet: opts.sheet,
      gutter: opts.gutter,
      stripMetadata: opts.stripMetadata,
    }, (r) => setProgress(r * 0.95));

    const bytes = await out.save();
    setProgress(1);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const suffix = opts.imposeMode === 'booklet' ? 'booklet' : '2in1';
    showResult(blob, `${opts.filename}-${suffix}.pdf`, `PDF（${suffix}）`, 0);
  }

  async function exportImages(opts) {
    const spec = IMAGE_FORMATS[opts.imageFormat] || IMAGE_FORMATS.png;
    const pad = (n) => String(n).padStart(String(pages.length).length, '0');

    if (spec.encoder) {
      setProgress(0, '画像に変換しています...', `${spec.label} エンコーダを読み込んでいます`);
      await loadEncoder(spec.encoder);
    }

    if (pages.length === 1) {
      setProgress(0.3, '画像を作成しています...', `${spec.label} に変換しています`);
      const canvas = await renderPageToCanvas(pages[0], opts.imageScale);
      const blob = await encodeCanvas(canvas, opts.imageFormat, opts.imageQuality);
      setProgress(1);
      showResult(blob, `${opts.filename}.${spec.ext}`, spec.label, 0);
      return;
    }

    const zip = new JSZip();
    for (let i = 0; i < pages.length; i++) {
      setProgress(i / pages.length, '画像に変換しています...', `${i + 1} / ${pages.length} ページ（${spec.label}）`);
      const canvas = await renderPageToCanvas(pages[i], opts.imageScale);
      const blob = await encodeCanvas(canvas, opts.imageFormat, opts.imageQuality);
      zip.file(`${opts.filename}-${pad(i + 1)}.${spec.ext}`, blob);
      await yieldExport();
    }

    setProgress(0.97, 'ZIPにまとめています...', `${pages.length} ファイル`);
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    setProgress(1);
    showResult(blob, `${opts.filename}.zip`, `ZIP（${spec.label} ${pages.length}枚）`, 0);
  }

  // ---------------------------------------------------------------- wiring

  function bindSegmented(containerId, attr, onChange) {
    $(containerId).addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      $(containerId).querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      if (onChange) onChange(btn.dataset[attr]);
    });
  }

  function initDropzone() {
    setupDropzone({
      dropzone: $('dropzone'),
      fileInput: $('file-input'),
      onFiles: addFiles,
    });
    $('file-input').addEventListener('change', (e) => {
      if (e.target.files.length) addFiles(e.target.files);
      e.target.value = '';
    });

    $('url-btn').addEventListener('click', () => loadFromUrl($('url-input').value));
    $('url-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        loadFromUrl($('url-input').value);
      }
    });
  }

  function initGridInteraction() {
    gridEl.addEventListener('click', (e) => {
      const actionBtn = e.target.closest('.page-act');
      const card = e.target.closest('.page-card');
      if (!card) return;
      const uid = Number(card.dataset.uid);
      const page = pages.find((p) => p.uid === uid);
      if (!page) return;

      if (actionBtn) {
        e.stopPropagation();
        const act = actionBtn.dataset.act;
        if (act === 'cw') rotatePages([page], 90);
        else if (act === 'ccw') rotatePages([page], -90);
        else if (act === 'del') deletePages([page]);
        else if (act === 'redact') openRedact(uid);
        return;
      }
      if (suppressClick) return;

      setActiveCard(uid, false);
      if (e.shiftKey && lastAnchor != null) {
        selectRange(lastAnchor, uid);
      } else {
        setSelected(uid, !selection.has(uid));
        lastAnchor = uid;
      }
      updateToolbar();
    });

    initGridKeyboard();
    initPointerReorder();
  }

  function initGridKeyboard() {
    gridEl.addEventListener('focusin', (e) => {
      const card = e.target.closest('.page-card');
      if (card) activeUid = Number(card.dataset.uid);
    });

    gridEl.addEventListener('keydown', (e) => {
      const card = e.target.closest('.page-card');
      if (!card) return;
      const uid = Number(card.dataset.uid);
      const index = pages.findIndex((p) => p.uid === uid);
      if (index < 0) return;
      const page = pages[index];

      const step = {
        ArrowRight: 1, ArrowLeft: -1,
        ArrowDown: columnCount(), ArrowUp: -columnCount(),
      }[e.key];

      if (step) {
        e.preventDefault();
        const to = Math.min(pages.length - 1, Math.max(0, index + step));
        if (to === index) return;
        // Alt turns the arrows from "walk the grid" into "carry this page".
        if (e.altKey) movePage(index, to);
        setActiveCard(e.altKey ? uid : pages[to].uid, true);
        return;
      }

      if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        setActiveCard(pages[e.key === 'Home' ? 0 : pages.length - 1].uid, true);
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (e.shiftKey && lastAnchor != null) selectRange(lastAnchor, uid);
        else { setSelected(uid, !selection.has(uid)); lastAnchor = uid; }
        updateToolbar();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deletePages(selection.has(uid) ? selectedPages() : [page]);
        return;
      }

      const k = e.key.toLowerCase();
      if (k === 'r') {
        e.preventDefault();
        rotatePages([page], e.shiftKey ? -90 : 90);
        setActiveCard(uid, true);
      } else if (k === 'm') {
        e.preventDefault();
        openRedact(uid);
      }
    });
  }

  /**
   * Reordering on Pointer Events rather than HTML5 drag-and-drop, which mobile
   * browsers never fire for touch. A finger has to start on the grip so the
   * grid stays scrollable; a mouse can grab the card anywhere once it has moved
   * far enough to prove it isn't a click.
   */
  function initPointerReorder() {
    let armed = null;
    let dragUid = null;
    let dropTarget = null;
    let scrollStep = 0;
    let rafId = 0;

    function clearDropHint() {
      gridEl.querySelectorAll('.drop-before, .drop-after')
        .forEach((el) => el.classList.remove('drop-before', 'drop-after'));
      dropTarget = null;
    }

    function pumpScroll() {
      rafId = 0;
      if (!scrollStep) return;
      window.scrollBy(0, scrollStep);
      rafId = requestAnimationFrame(pumpScroll);
    }

    // Dragging to the far end of a 300-page grid needs the page to come along.
    function updateAutoScroll(clientY) {
      const margin = 90;
      scrollStep = clientY < margin ? -14
        : clientY > window.innerHeight - margin ? 14 : 0;
      if (scrollStep && !rafId) rafId = requestAnimationFrame(pumpScroll);
    }

    function stopAutoScroll() {
      scrollStep = 0;
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    }

    function beginDrag(uid) {
      dragUid = uid;
      const card = gridEl.querySelector(`.page-card[data-uid="${uid}"]`);
      if (card) card.classList.add('dragging');
      document.body.classList.add('dragging-page');
    }

    function finishDrag(commit) {
      stopAutoScroll();
      document.body.classList.remove('dragging-page');
      gridEl.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));

      if (commit && dragUid != null && dropTarget) {
        const fromIndex = pages.findIndex((p) => p.uid === dragUid);
        const overIndex = pages.findIndex((p) => p.uid === Number(dropTarget.card.dataset.uid));
        let toIndex = dropTarget.after ? overIndex + 1 : overIndex;
        if (fromIndex < toIndex) toIndex -= 1;
        clearDropHint();
        movePage(fromIndex, toIndex);
      } else {
        clearDropHint();
      }

      if (dragUid != null) {
        // Swallow the click the browser fires after the drop.
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 0);
      }
      dragUid = null;
      armed = null;
    }

    gridEl.addEventListener('pointerdown', (e) => {
      if (e.button) return;
      const card = e.target.closest('.page-card');
      if (!card || e.target.closest('.page-act')) return;
      const viaGrip = !!e.target.closest('.page-grip');
      if (!viaGrip && e.pointerType !== 'mouse') return;
      armed = { uid: Number(card.dataset.uid), x: e.clientX, y: e.clientY };
      if (viaGrip) {
        e.preventDefault();
        beginDrag(armed.uid);
      }
    });

    // On window, not the grid: no pointer capture is taken, so that a plain
    // click still reaches the card it started on.
    window.addEventListener('pointermove', (e) => {
      if (!armed) return;
      if (dragUid == null) {
        if (Math.abs(e.clientX - armed.x) < DRAG_THRESHOLD
          && Math.abs(e.clientY - armed.y) < DRAG_THRESHOLD) return;
        beginDrag(armed.uid);
      }
      e.preventDefault();
      updateAutoScroll(e.clientY);

      const under = document.elementFromPoint(e.clientX, e.clientY);
      const card = under && under.closest ? under.closest('.page-card') : null;
      if (!card || Number(card.dataset.uid) === dragUid) return;
      const rect = card.getBoundingClientRect();
      const after = e.clientX > rect.left + rect.width / 2;
      if (dropTarget && dropTarget.card !== card) clearDropHint();
      card.classList.toggle('drop-after', after);
      card.classList.toggle('drop-before', !after);
      dropTarget = { card, after };
    }, { passive: false });

    window.addEventListener('pointerup', () => { if (armed) finishDrag(true); });
    window.addEventListener('pointercancel', () => { if (armed) finishDrag(false); });
  }

  function initToolbar() {
    $('btn-select-all').addEventListener('click', () => {
      pages.forEach((p) => setSelected(p.uid, true));
      updateToolbar();
    });
    $('btn-select-none').addEventListener('click', () => {
      [...selection].forEach((uid) => setSelected(uid, false));
      lastAnchor = null;
      updateToolbar();
    });
    $('btn-rot-left').addEventListener('click', () => rotatePages(targetPages(), -90));
    $('btn-rot-right').addEventListener('click', () => rotatePages(targetPages(), 90));
    $('btn-delete').addEventListener('click', () => deletePages(selectedPages()));
    $('btn-undo').addEventListener('click', undo);
    $('btn-interleave').addEventListener('click', openInterleave);

    const addInput = document.createElement('input');
    addInput.type = 'file';
    addInput.accept = 'application/pdf';
    addInput.multiple = true;
    addInput.className = 'hidden';
    document.body.appendChild(addInput);
    addInput.addEventListener('change', (e) => {
      if (e.target.files.length) addFiles(e.target.files);
      e.target.value = '';
    });
    $('btn-add-file').addEventListener('click', () => addInput.click());

    $('btn-restart').addEventListener('click', () => {
      if (!confirm('読み込んだPDFと編集内容をすべて破棄して、最初からやり直しますか？')) return;
      resetAll();
    });

    $('btn-cancel-export').addEventListener('click', () => {
      if (!busy) return;
      exportAbort = true;
      setProgress(1, '中止しています...', '現在の処理が終わり次第停止します');
      setCancellable(false);
    });

    $('btn-export').addEventListener('click', openExport);
    $('btn-back-editor').addEventListener('click', () => setView('view-preview'));
    $('btn-download').addEventListener('click', () => {
      if (lastBlob) downloadBlob(lastBlob, lastFilename);
    });

    // Drop a PDF anywhere in the editor to merge it in. This has to live on
    // <body>: setupDropzone already stops propagation there, so a listener on
    // `document` would never see the event.
    ['dragover', 'drop'].forEach((name) => {
      document.body.addEventListener(name, (e) => {
        if ($('view-preview').classList.contains('hidden')) return;
        if (e.target.closest('.modal-backdrop')) return;
        e.preventDefault();
        if (name === 'drop' && e.dataTransfer && e.dataTransfer.files.length) {
          addFiles(e.dataTransfer.files);
        }
      });
    });
  }

  function resetAll() {
    docs.forEach((d) => { try { d.pdfjs.destroy(); } catch (e) { /* already gone */ } });
    docs.clear();
    pages = [];
    selection.clear();
    history.length = 0;
    thumbCache.clear();
    thumbQueue.length = 0;
    lastBlob = null;
    lastAnchor = null;
    activeUid = null;
    gridEl.replaceChildren();
    updateToolbar();
    setView('view-upload');
  }

  function openExport() {
    $('ex-page-count').textContent = String(pages.length);
    if (!$('ex-filename').value) $('ex-filename').value = defaultFilename();
    openModal('modal-export');
  }

  function initExportPanel() {
    bindSegmented('ex-mode', 'mode', (mode) => {
      document.querySelectorAll('.ex-panel').forEach((panel) => {
        const on = panel.dataset.panel === mode;
        panel.classList.toggle('hidden', !on);
        panel.classList.toggle('flex', on);
      });
    });

    bindSegmented('ex-compress', 'v', (v) => {
      const wrap = $('ex-compress-opts');
      wrap.classList.toggle('hidden', v !== 'on');
      wrap.classList.toggle('flex', v === 'on');
    });

    bindSegmented('ex-split-mode', 'v', (v) => {
      $('ex-split-every-wrap').classList.toggle('hidden', v !== 'every');
      $('ex-split-note').textContent = {
        each: '各ページを個別のPDFにして、ZIPでまとめてダウンロードします。',
        every: '指定した枚数ごとに区切ってPDFを作り、ZIPでまとめます。',
        selected: '選択したページだけを1つのPDFにまとめます（抽出）。',
      }[v];
    });

    bindSegmented('ex-impose-mode', 'v', (v) => {
      $('ex-impose-note').textContent = v === 'booklet'
        ? '中綴じの並び順に組み替えます。総ページ数は自動的に4の倍数に調整され、不足分は白紙になります。両面印刷して二つ折りにすると冊子になります。'
        : '2ページ分を1枚に並べます。文字は画像化せずベクターのまま配置されます。';
    });

    bindSegmented('ex-bind', 'v');

    bindSegmented('ex-img-format', 'v', (v) => {
      const spec = IMAGE_FORMATS[v] || IMAGE_FORMATS.png;
      const wrap = $('ex-img-quality-wrap');
      wrap.classList.toggle('hidden', !spec.useQuality);
      wrap.classList.toggle('flex', spec.useQuality);
      $('ex-img-note').textContent = spec.encoder
        ? `${spec.label} は初回のみエンコーダ（約1MB）を読み込みます。以降はオフラインでも変換できます。ページ数が多いと時間がかかります。`
        : '全ページを画像にしてZIPでまとめます。1ページだけの場合は画像ファイルを直接ダウンロードします。';
    });

    $('ex-quality').addEventListener('input', (e) => {
      $('ex-quality-val').textContent = e.target.value + '%';
    });
    $('ex-img-quality').addEventListener('input', (e) => {
      $('ex-img-quality-val').textContent = e.target.value + '%';
    });
    $('ex-gutter').addEventListener('input', (e) => {
      $('ex-gutter-val').textContent = e.target.value + ' mm';
    });

    $('ex-run').addEventListener('click', runExport);
  }

  function initModals() {
    document.querySelectorAll('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => closeModal(btn.dataset.close));
    });
    document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
      backdrop.addEventListener('mousedown', (e) => {
        if (e.target === backdrop) closeModal(backdrop.id);
      });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal-backdrop:not(.hidden)')
          .forEach((backdrop) => closeModal(backdrop.id));
      }
      // Ctrl/Cmd+Z is the editor's undo only while nothing else owns it: a
      // dialog is open, or the caret sits in a field that undoes its own typing.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        if ($('view-preview').classList.contains('hidden')) return;
        if (document.querySelector('.modal-backdrop:not(.hidden)')) return;
        const el = e.target;
        if (el && el.closest && el.closest('input, textarea, select, [contenteditable]')) return;
        e.preventDefault();
        undo();
      }
    });

    document.addEventListener('keydown', trapFocus);

    $('il-apply').addEventListener('click', applyInterleave);
    $('redact-apply').addEventListener('click', applyRedaction);
    $('redact-clear').addEventListener('click', () => {
      redactRects = [];
      drawRedactOverlay();
    });
    setupRedactDrawing();
  }

  // ---------------------------------------------------------------- boot

  lucide.createIcons();
  $('currentYear').textContent = new Date().getFullYear();

  initDropzone();
  initGridInteraction();
  initToolbar();
  initExportPanel();
  initModals();
  updateToolbar();

  // Nothing is stored anywhere, so a reload really does throw the edit away.
  window.addEventListener('beforeunload', (e) => {
    if (!pages.length) return;
    e.preventDefault();
    e.returnValue = '';
  });
})();
