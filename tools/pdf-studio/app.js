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
  const { PDFDocument, StandardFonts, degrees, rgb } = PDFLib;

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
  // Text is positioned by the top of its box; PDF positions it by the baseline.
  // One ratio for both the preview and the output keeps them in agreement.
  const TEXT_ASCENT = 0.8;
  const JP_FONT_FAMILY = 'PdfStudioJP';
  const JP_FONT_URL = 'https://cdn.jsdelivr.net/fontsource/fonts/noto-sans-jp@latest/japanese-400-normal.ttf';
  // ASCII-only labels are embedded as Helvetica, so the fallbacks after the
  // Japanese face have to be the same metrics — otherwise the preview and the
  // exported page disagree about how wide the text is.
  const textFont = (px) => `${px}px "${JP_FONT_FAMILY}", Helvetica, Arial, sans-serif`;
  const STAMP_MAX_SIDE = 2000;
  // Past this many pages, measuring the compressed size stops feeling instant,
  // so it waits to be asked instead of running on every slider nudge.
  const AUTO_SIZE_PAGE_LIMIT = 40;
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
  /** @type {Array<{uid:number,docId:number,src:number,rot:number,redactions:Array,stamps:Array,texts:Array}>} */
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
  // Size measurements build the whole document too. Their clamping says nothing
  // about the file the user is actually getting, so it must not raise the flag.
  let measuringDepth = 0;

  /** Uploaded stamp images, shared by every page that uses them. */
  const stampAssets = new Map();
  let stampSeq = 0;

  // ---------------------------------------------------------------- helpers

  const $ = (id) => document.getElementById(id);
  const norm360 = (n) => ((n % 360) + 360) % 360;

  function setView(id) {
    switchView(id);
    const isLanding = id === 'view-upload';
    $('hero').classList.toggle('hidden', !isLanding);
    $('tool-copy').classList.toggle('hidden', !isLanding);
    // The page tools only mean anything with pages loaded, so the toolbar
    // rides with the editor rather than sitting there inert.
    $('toolbar').classList.toggle('hidden', id !== 'view-preview');
    setStatus(
      id === 'view-preview' ? 'editing' :
      id === 'view-loading' ? 'working' :
      id === 'view-result' ? 'done' : 'ready',
      id === 'view-loading' ? '' : 'idle'
    );
  }

  // state: '' (working, pulsing), 'idle', 'err'
  function setStatus(text, state) {
    const t = $('status-text');
    const led = $('status-led');
    if (t) t.textContent = text;
    if (led) led.className = 'st-led' + (state ? ' ' + state : '');
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

  function abortError() {
    const err = new Error('cancelled by user');
    err.name = 'AbortByUser';
    return err;
  }

  /** The same breather, but it also lets a cancel request take effect. */
  async function breathe(check) {
    await yieldToPaint();
    if (check && check()) throw abortError();
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
    // A size measurement builds the whole document. Nobody is looking at the
    // result once the dialog is gone, and letting it run on competes with the
    // export the user just started.
    if (id === 'modal-export') sizeToken++;
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
    // Every annotation list needs its own copy — a spread would share the array
    // with the live page and let later edits rewrite the undo history.
    history.push(pages.map((p) => ({
      ...p,
      redactions: p.redactions.map((r) => ({ ...r })),
      stamps: p.stamps.map((r) => ({ ...r })),
      texts: p.texts.map((r) => ({ ...r })),
    })));
    if (history.length > HISTORY_LIMIT) {
      // The dropped snapshot may have been the last thing holding a deleted
      // stamp's bitmap alive.
      history.shift();
      pruneDocs();
      refreshStampAssets();
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
    refreshStampAssets();
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
      pages.push({ uid: ++pageSeq, docId: id, src: i, rot: 0, redactions: [], stamps: [], texts: [] });
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

  /**
   * Map a point given in the page as the reader sees it — origin bottom-left of
   * the *rotated* page, y up, in points — onto the PDF's own user space, where
   * /Rotate has not been applied and the crop box may not start at zero.
   *
   * Content drawn at the returned point and turned counter-clockwise by the
   * page's rotation ends up upright and in the right place for the reader.
   */
  function visualPointToUser(cropBox, rotationCw, visW, visH, vx, vy) {
    const { x: cx, y: cy } = cropBox;
    switch (rotationCw) {
      case 90:  return { x: cx + (visH - vy), y: cy + vx };
      case 180: return { x: cx + (visW - vx), y: cy + (visH - vy) };
      case 270: return { x: cx + vy,          y: cy + (visW - vx) };
      default:  return { x: cx + vx,          y: cy + vy };
    }
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
    if (!measuringDepth) scaleWasClamped = true;
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

    if (!settings.skipAnnotations) drawAnnotationsOnCanvas(ctx, page, canvas.width, canvas.height);

    return canvas;
  }

  /**
   * Paint texts, stamps and redactions onto a rendered page, in that order:
   * redactions go last because they are meant to hide whatever is under them.
   * Shared by thumbnails, the editing preview and every raster export.
   */
  function drawAnnotationsOnCanvas(ctx, page, w, h) {
    page.texts.forEach((t) => {
      const px = t.h * h;
      ctx.fillStyle = t.color || '#dc2626';
      ctx.font = textFont(px);
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(t.text, t.x * w, t.y * h + px * TEXT_ASCENT);
    });

    page.stamps.forEach((st) => {
      const asset = stampAssets.get(st.assetId);
      if (!asset || !asset.img.complete) return;
      ctx.drawImage(asset.img, st.x * w, st.y * h, st.w * w, st.h * h);
    });

    if (page.redactions.length) {
      ctx.fillStyle = '#000000';
      page.redactions.forEach((r) => {
        ctx.fillRect(r.x * w, r.y * h, r.w * w, r.h * h);
      });
    }
  }

  /** Everything about a page that changes how it looks, as one string. */
  function pageSignature(page) {
    const num = (v) => Number(v).toFixed(4);
    const boxes = page.redactions.map((r) => `${num(r.x)},${num(r.y)},${num(r.w)},${num(r.h)}`).join(';');
    const stamps = page.stamps.map((r) => `${r.assetId}@${num(r.x)},${num(r.y)},${num(r.w)},${num(r.h)}`).join(';');
    const texts = page.texts.map((t) => `${num(t.x)},${num(t.y)},${num(t.h)},${t.color},${t.text}`).join(';');
    return `${page.docId}|${page.src}|${totalRotation(page)}|${boxes}|${stamps}|${texts}`;
  }

  const thumbQueue = [];
  let thumbActive = 0;

  function showThumb(imgEl, url) {
    imgEl.src = url;
    imgEl.classList.remove('hidden');
    const skeleton = imgEl.previousElementSibling;
    if (skeleton && skeleton.classList.contains('thumb-skeleton')) skeleton.remove();
  }

  function queueThumb(page, imgEl) {
    // Straight from the cache when we can. Queuing it would run renderThumb to
    // completion synchronously, before the freshly built card has been put in
    // the document — and its isConnected guard would then discard the result,
    // which is what used to leave the skeleton spinning after a 360° rotation
    // or any other re-render of already-rendered pages.
    const cached = thumbCache.get(thumbKey(page));
    if (cached) {
      touchThumbCache(thumbKey(page), cached);
      showThumb(imgEl, cached);
      return;
    }
    thumbQueue.push({ page, imgEl });
    pumpThumbQueue();
  }

  /** Re-insert on use, so the eviction order is least-recently-used. */
  function touchThumbCache(key, url) {
    thumbCache.delete(key);
    thumbCache.set(key, url);
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
   * Cache identity for a thumbnail. Annotations have to be spelled out in full:
   * moving one without changing how many there are still changes the picture.
   */
  const thumbKey = pageSignature;

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
    // This path always awaited a render, so the card is in the document by now
    // unless the grid was rebuilt underneath us — in which case drop the result.
    if (!imgEl.isConnected) return;
    showThumb(imgEl, url);
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
    const hasMark = page.stamps.length > 0 || page.texts.length > 0;
    const sourceName = showSource ? docs.get(page.docId).name : '';
    // Without this the card announces as a bare "1" — the thumbnail carries no
    // text and the page number is the only thing in it.
    card.setAttribute('aria-label', `${index + 1}ページ目`
      + (sourceName ? `（${sourceName}）` : '')
      + (hasRedaction ? '、墨消しあり' : '')
      + (hasMark ? '、注釈あり' : ''));

    card.innerHTML = `
      <div class="page-thumb-wrap">
        <div class="thumb-skeleton"></div>
        <img class="page-thumb hidden" alt="">
      </div>
      ${sourceName ? `<span class="page-badge" title="${escapeAttr(sourceName)}">${escapeHtml(sourceName)}</span>` : ''}
      ${hasRedaction || hasMark
        ? `<span class="page-badge redacted">${hasRedaction ? '墨消し' : '注釈'}</span>`
        : ''}
      <div class="page-actions${hasRedaction || hasMark ? ' has-redaction' : ''}">
        <button class="page-act" data-act="ccw" title="左に90°回転" aria-label="左に90°回転">${ICON.rotCcw}</button>
        <button class="page-act" data-act="cw" title="右に90°回転" aria-label="右に90°回転">${ICON.rotCw}</button>
        <button class="page-act" data-act="redact" title="墨消し・スタンプ・テキスト" aria-label="墨消し・スタンプ・テキスト">${ICON.eraser}</button>
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

  // ---------------------------------------------------------------- annotations

  let redactTarget = null;
  let anTool = 'redact';
  let anDraft = { redactions: [], stamps: [], texts: [] };
  let redactDrag = null;
  let activeStampId = null;

  const anEmpty = () =>
    anDraft.redactions.length + anDraft.stamps.length + anDraft.texts.length === 0;

  // -------------------------------------------------- stamp library

  async function addStampFiles(fileList) {
    const files = Array.from(fileList).filter((f) => /^image\//.test(f.type));
    if (!files.length) {
      showToast('画像ファイルを選択してください。', 'error');
      return;
    }
    for (const file of files) {
      try {
        await addStampAsset(file);
      } catch (err) {
        console.warn('stamp load failed', err);
        showToast(`${file.name} を読み込めませんでした`, 'error');
      }
    }
    renderStampTray();
  }

  /**
   * Read the EXIF orientation tag out of a JPEG, or 1 when there is none.
   * pdf-lib embeds the JPEG bytes untouched and ignores EXIF, so a tagged file
   * has to be spotted here and redrawn with the rotation baked in.
   */
  function jpegOrientation(bytes) {
    try {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (view.getUint16(0) !== 0xffd8) return 1;
      let off = 2;
      while (off + 4 <= view.byteLength) {
        const marker = view.getUint16(off);
        if ((marker & 0xff00) !== 0xff00) return 1;
        if (marker === 0xffda || marker === 0xffd9) return 1;   // image data starts
        const len = view.getUint16(off + 2);
        if (marker === 0xffe1 && view.getUint32(off + 4) === 0x45786966) {   // "Exif"
          const tiff = off + 10;
          const little = view.getUint16(tiff) === 0x4949;
          const ifd = tiff + view.getUint32(tiff + 4, little);
          const count = view.getUint16(ifd, little);
          for (let i = 0; i < count; i++) {
            const entry = ifd + 2 + i * 12;
            if (view.getUint16(entry, little) === 0x0112) {
              return view.getUint16(entry + 8, little) || 1;
            }
          }
          return 1;
        }
        off += 2 + len;
      }
    } catch (err) {
      // A truncated or unusual header just means "assume upright".
    }
    return 1;
  }

  /**
   * Normalise every upload to something pdf-lib can embed. WebP, anything
   * oversized and anything rotated by an EXIF tag gets redrawn; JPEG stays
   * JPEG so photos keep their compression, everything else becomes PNG so
   * transparency survives.
   */
  async function addStampAsset(file) {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, STAMP_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const source = new Uint8Array(await file.arrayBuffer());
    const embeddable = /^image\/(png|jpeg)$/.test(file.type);
    const isJpeg = file.type === 'image/jpeg';
    const rotatedByExif = isJpeg && jpegOrientation(source) > 1;

    let bytes;
    let mime;
    if (scale < 1 || !embeddable || rotatedByExif) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      mime = isJpeg ? 'image/jpeg' : 'image/png';
      const blob = await canvasToBlob(canvas, mime, isJpeg ? 0.92 : undefined);
      bytes = new Uint8Array(await blob.arrayBuffer());
    } else {
      bytes = source;
      mime = file.type;
    }
    bitmap.close();

    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const img = new Image();
    img.src = url;
    await img.decode();

    const id = ++stampSeq;
    stampAssets.set(id, { id, name: file.name, bytes, mime, url, img });
    activeStampId = id;
    return id;
  }

  function stampUsageCount(assetId) {
    return pages.reduce((total, page) =>
      total + page.stamps.filter((st) => st.assetId === assetId).length, 0);
  }

  /** Undo can bring a deleted stamp back, so history counts as a reference. */
  function stampInHistory(assetId) {
    return history.some((snap) =>
      snap.some((page) => page.stamps.some((st) => st.assetId === assetId)));
  }

  function firstLiveStampId() {
    for (const asset of stampAssets.values()) if (!asset.retired) return asset.id;
    return null;
  }

  /**
   * Drop an asset the tray no longer shows. Its bitmap has to outlive the
   * deletion whenever undo can still put the stamp back — freeing it here
   * would leave the restored stamp pointing at nothing, and it would silently
   * vanish from the thumbnails and the export.
   */
  function releaseStampAsset(assetId) {
    const asset = stampAssets.get(assetId);
    if (!asset) return;
    if (stampInHistory(assetId) || stampUsageCount(assetId)) {
      asset.retired = true;
      return;
    }
    URL.revokeObjectURL(asset.url);
    stampAssets.delete(assetId);
  }

  /** Undo may have restored stamps, so retired assets get a second look. */
  function refreshStampAssets() {
    let changed = false;
    [...stampAssets.values()].forEach((asset) => {
      if (!asset.retired) return;
      if (stampUsageCount(asset.id)) {
        asset.retired = false;
        changed = true;
      } else if (!stampInHistory(asset.id)) {
        URL.revokeObjectURL(asset.url);
        stampAssets.delete(asset.id);
        changed = true;
      }
    });
    if (!changed) return;
    if (activeStampId === null) activeStampId = firstLiveStampId();
    renderStampTray();
  }

  function removeStampAsset(assetId) {
    const used = stampUsageCount(assetId);
    if (used && !confirm(`このスタンプは ${used} 箇所で使われています。まとめて削除しますか？`)) return;
    if (used) {
      snapshot();
      pages.forEach((page) => { page.stamps = page.stamps.filter((st) => st.assetId !== assetId); });
      renderGrid();
    }
    anDraft.stamps = anDraft.stamps.filter((st) => st.assetId !== assetId);
    releaseStampAsset(assetId);
    if (activeStampId === assetId) activeStampId = firstLiveStampId();
    renderStampTray();
    drawAnnotationOverlay();
  }

  function renderStampTray() {
    const tray = $('stamp-tray');
    const addBtn = $('stamp-add');
    tray.querySelectorAll('.stamp-chip').forEach((el) => el.remove());
    stampAssets.forEach((asset) => {
      // Retired assets are only still here so undo can restore their stamps.
      if (asset.retired) return;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'stamp-chip' + (asset.id === activeStampId ? ' active' : '');
      chip.style.setProperty('--thumb', `url("${asset.url}")`);
      chip.title = asset.name;
      chip.setAttribute('aria-label', asset.name);
      chip.innerHTML = '<span aria-hidden="true" title="このスタンプを削除">&times;</span>';
      chip.addEventListener('click', (e) => {
        if (e.target.closest('span')) {
          e.stopPropagation();
          removeStampAsset(asset.id);
          return;
        }
        activeStampId = asset.id;
        renderStampTray();
      });
      tray.insertBefore(chip, addBtn);
    });
    updateAnnotationHints();
  }

  // -------------------------------------------------- Japanese font, loaded on demand

  let jpFontPromise = null;
  let jpFontReady = false;

  function loadJpFont() {
    if (!jpFontPromise) {
      jpFontPromise = (async () => {
        const fontkit = (await import('https://esm.sh/@pdf-lib/fontkit@1.1.1')).default;
        const res = await fetch(JP_FONT_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buffer = await res.arrayBuffer();
        // The same face backs the on-screen preview, so what gets dragged into
        // place is what comes out in the PDF.
        const face = new FontFace(JP_FONT_FAMILY, buffer.slice(0));
        await face.load();
        document.fonts.add(face);
        jpFontReady = true;
        return { fontkit, bytes: new Uint8Array(buffer) };
      })().catch((err) => {
        jpFontPromise = null;   // let a later attempt retry the download
        console.warn('Japanese font failed to load', err);
        throw new Error('日本語フォントを読み込めませんでした（オフラインの可能性があります）');
      });
    }
    return jpFontPromise;
  }

  // Captured once: after a failed attempt the note holds an error message, and
  // restoring *that* on a later success would make the failure permanent.
  let textNoteDefault = null;

  async function ensureTextFontReady() {
    const note = $('an-text-note');
    if (textNoteDefault === null) textNoteDefault = note.textContent;
    note.textContent = '日本語フォント（約2.3MB）を読み込んでいます...';
    try {
      await loadJpFont();
      note.textContent = textNoteDefault;
    } catch (err) {
      note.textContent = err.message + ' 英数字のみであればこのまま追加できます。';
    }
  }

  // -------------------------------------------------- dialog

  async function openAnnotate(uid) {
    const page = pages.find((p) => p.uid === uid);
    if (!page) return;

    redactTarget = page;
    anDraft = {
      redactions: page.redactions.map((r) => ({ ...r })),
      stamps: page.stamps.map((r) => ({ ...r })),
      texts: page.texts.map((r) => ({ ...r })),
    };
    $('redact-all-pages').checked = false;
    $('redact-page-label').textContent = `（${pages.indexOf(page) + 1} ページ目）`;

    const doc = docs.get(page.docId);
    const pdfPage = await doc.pdfjs.getPage(page.src + 1);
    const base = pdfPage.getViewport({ scale: 1, rotation: totalRotation(page) });
    const scale = Math.min(2, Math.max(0.5, 900 / base.width));
    const canvas = await renderPageToCanvas(page, scale, { skipAnnotations: true });

    const target = $('redact-canvas');
    target.width = canvas.width;
    target.height = canvas.height;
    target.getContext('2d').drawImage(canvas, 0, 0);

    renderStampTray();
    // The overlay sizes text in pixels off the stage, which has no box until
    // the dialog is on screen — drawn any earlier, every label comes out 0px.
    openModal('modal-redact');
    drawAnnotationOverlay();
  }

  const measureCtx = document.createElement('canvas').getContext('2d');

  function drawAnnotationOverlay() {
    const overlay = $('redact-overlay');
    const stage = $('redact-stage').getBoundingClientRect();
    overlay.replaceChildren();

    const remove = (list, index) => (e) => {
      e.stopPropagation();
      list.splice(index, 1);
      drawAnnotationOverlay();
      updateAnnotationHints();
    };

    anDraft.texts.forEach((t, i) => {
      const px = t.h * stage.height;
      measureCtx.font = textFont(px);
      const width = measureCtx.measureText(t.text).width;
      const el = document.createElement('div');
      el.className = 'an-item text';
      el.style.left = t.x * 100 + '%';
      el.style.top = t.y * 100 + '%';
      el.style.width = (stage.width ? (width / stage.width) * 100 : 0) + '%';
      el.style.height = t.h * 100 + '%';
      const label = document.createElement('span');
      label.className = 'an-label';
      label.style.font = textFont(px);
      label.style.color = t.color;
      label.textContent = t.text;
      el.appendChild(label);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('aria-label', 'このテキストを削除');
      btn.innerHTML = '&times;';
      btn.addEventListener('click', remove(anDraft.texts, i));
      el.appendChild(btn);
      overlay.appendChild(el);
    });

    anDraft.stamps.forEach((st, i) => {
      const asset = stampAssets.get(st.assetId);
      const el = document.createElement('div');
      el.className = 'an-item stamp';
      el.style.left = st.x * 100 + '%';
      el.style.top = st.y * 100 + '%';
      el.style.width = st.w * 100 + '%';
      el.style.height = st.h * 100 + '%';
      if (asset) {
        const img = document.createElement('img');
        img.src = asset.url;
        img.alt = '';
        el.appendChild(img);
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('aria-label', 'このスタンプを削除');
      btn.innerHTML = '&times;';
      btn.addEventListener('click', remove(anDraft.stamps, i));
      el.appendChild(btn);
      overlay.appendChild(el);
    });

    anDraft.redactions.forEach((rect, i) => {
      const el = document.createElement('div');
      el.className = 'redact-rect';
      el.style.left = rect.x * 100 + '%';
      el.style.top = rect.y * 100 + '%';
      el.style.width = rect.w * 100 + '%';
      el.style.height = rect.h * 100 + '%';
      el.innerHTML = '<button type="button" aria-label="この墨消しを削除">&times;</button>';
      el.querySelector('button').addEventListener('click', remove(anDraft.redactions, i));
      overlay.appendChild(el);
    });
  }

  function setAnnotationTool(tool) {
    anTool = tool;
    $('an-opts-stamp').classList.toggle('hidden', tool !== 'stamp');
    $('an-opts-text').classList.toggle('hidden', tool !== 'text');
    $('redact-stage').classList.remove('tool-redact', 'tool-stamp', 'tool-text');
    $('redact-stage').classList.add('tool-' + tool);
    $('an-warn').classList.toggle('hidden', tool !== 'redact');
    if (tool === 'text') ensureTextFontReady();
    updateAnnotationHints();
  }

  function updateAnnotationHints() {
    $('redact-clear').disabled = anEmpty();
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
      if (e.target.closest('.redact-rect') || e.target.closest('.an-item')) return;
      if (anTool === 'stamp' && !stampAssets.get(activeStampId)) {
        showToast('先にスタンプ画像を追加してください。', 'error');
        return;
      }
      if (anTool === 'text' && !$('an-text-value').value.trim()) {
        showToast('先に追加する文字を入力してください。', 'error');
        return;
      }
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
      // Ignore stray clicks — an annotation has to actually cover something.
      if (rect.w <= 0.004 || rect.h <= 0.004) return;

      if (anTool === 'stamp') addStampAt(rect);
      else if (anTool === 'text') addTextAt(rect);
      else anDraft.redactions.push(rect);

      drawAnnotationOverlay();
      updateAnnotationHints();
    };

    stage.addEventListener('pointerup', finish);
    stage.addEventListener('pointercancel', () => { redactDrag = null; live.style.display = 'none'; });

    // The preview font size is in pixels, so a resized window has to redraw it.
    window.addEventListener('resize', () => {
      if (!$('modal-redact').classList.contains('hidden')) drawAnnotationOverlay();
    });
  }

  /** Fit the stamp inside the dragged box without distorting it. */
  function addStampAt(box) {
    const asset = stampAssets.get(activeStampId);
    if (!asset) return;
    const stage = $('redact-stage').getBoundingClientRect();
    if (!stage.width || !stage.height) return;

    // Normalised units are not square, so the fit has to happen in pixels.
    const scale = Math.min(
      (box.w * stage.width) / asset.img.naturalWidth,
      (box.h * stage.height) / asset.img.naturalHeight
    );
    const w = (asset.img.naturalWidth * scale) / stage.width;
    const h = (asset.img.naturalHeight * scale) / stage.height;
    anDraft.stamps.push({
      assetId: asset.id,
      x: box.x + (box.w - w) / 2,
      y: box.y + (box.h - h) / 2,
      w,
      h,
    });
  }

  /** The dragged box's height becomes the font size. */
  function addTextAt(box) {
    const text = $('an-text-value').value.trim();
    if (!text) return;
    anDraft.texts.push({
      x: box.x,
      y: box.y,
      h: box.h,
      text,
      color: $('an-text-color').value || '#dc2626',
    });
  }

  /**
   * A stamp's w/h are fractions of the page it was fitted on, so copying them
   * onto a page of a different shape stretches the image. Re-fit it inside the
   * same fractional box on the target page instead, keeping its centre.
   */
  function refitStamp(st, target) {
    const asset = stampAssets.get(st.assetId);
    const size = visualSize(target);
    if (!asset || !asset.img.naturalWidth || !size.width || !size.height) return { ...st };

    const scale = Math.min(
      (st.w * size.width) / asset.img.naturalWidth,
      (st.h * size.height) / asset.img.naturalHeight
    );
    const w = (asset.img.naturalWidth * scale) / size.width;
    const h = (asset.img.naturalHeight * scale) / size.height;
    return { ...st, x: st.x + (st.w - w) / 2, y: st.y + (st.h - h) / 2, w, h };
  }

  function applyAnnotations() {
    if (!redactTarget) return;
    const everyPage = $('redact-all-pages').checked;
    const clone = (page) => ({
      redactions: anDraft.redactions.map((r) => ({ ...r })),
      stamps: anDraft.stamps.map((st) => (page === redactTarget ? { ...st } : refitStamp(st, page))),
      texts: anDraft.texts.map((r) => ({ ...r })),
    });

    snapshot();
    if (everyPage) {
      // Everything is stored as fractions of the page, so the same mark lands
      // in the same relative spot whatever the page size is.
      pages.forEach((page) => Object.assign(page, clone(page)));
      renderGrid();
    } else {
      Object.assign(redactTarget, clone(redactTarget));
      refreshCard(redactTarget.uid);
    }
    updateToolbar();
    closeModal('modal-redact');

    const parts = [];
    if (anDraft.redactions.length) parts.push(`墨消し ${anDraft.redactions.length} 箇所`);
    if (anDraft.stamps.length) parts.push(`スタンプ ${anDraft.stamps.length} 個`);
    if (anDraft.texts.length) parts.push(`テキスト ${anDraft.texts.length} 件`);

    if (!parts.length) {
      showToast(everyPage ? 'すべてのページの注釈を解除しました' : '注釈を解除しました');
    } else if (everyPage) {
      showToast(`${pages.length} ページすべてに ${parts.join('・')} を設定しました`);
    } else {
      showToast(`${parts.join('・')} を設定しました（書き出し時に適用）`);
    }
    redactTarget = null;
  }

  // -------------------------------------------------- vector output

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return rgb(0.86, 0.15, 0.15);
    const value = parseInt(m[1], 16);
    return rgb(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255);
  }

  /**
   * Embed the fonts and images the vector pages need, once per output document.
   * The Japanese face is only fetched if some text actually needs it — a label
   * in ASCII rides on a standard font and downloads nothing. Once the face is
   * loaded it is used for ASCII too, so that the vector pages, the rasterised
   * ones and the on-screen preview all measure the text the same way.
   */
  async function prepareAnnotationResources(out, list) {
    const resources = { font: null, images: new Map() };

    const texts = list.flatMap((page) => page.texts);
    if (texts.length) {
      if (jpFontReady || texts.some((t) => /[^\x00-\x7F]/.test(t.text))) {
        const { fontkit, bytes } = await loadJpFont();
        out.registerFontkit(fontkit);
        resources.font = await out.embedFont(bytes, { subset: true });
      } else {
        resources.font = await out.embedFont(StandardFonts.Helvetica);
      }
    }

    const assetIds = new Set(list.flatMap((page) => page.stamps.map((st) => st.assetId)));
    for (const id of assetIds) {
      const asset = stampAssets.get(id);
      if (!asset) continue;
      resources.images.set(id, asset.mime === 'image/jpeg'
        ? await out.embedJpg(asset.bytes)
        : await out.embedPng(asset.bytes));
    }
    return resources;
  }

  /** Draw a page's stamps and texts as real PDF content — no rasterising. */
  function drawPageAnnotations(target, page, resources) {
    if (!page.stamps.length && !page.texts.length) return;

    const cropBox = target.getCropBox();
    const rotationCw = norm360(target.getRotation().angle);
    const flat = rotationCw % 180 === 0;
    const visW = flat ? cropBox.width : cropBox.height;
    const visH = flat ? cropBox.height : cropBox.width;
    const place = (vx, vy) => visualPointToUser(cropBox, rotationCw, visW, visH, vx, vy);

    if (resources.font) {
      page.texts.forEach((t) => {
        const size = t.h * visH;
        // Stored y is the top of the text box, measured downwards; PDF wants
        // the baseline, measured up from the bottom.
        const at = place(t.x * visW, visH - (t.y * visH + size * TEXT_ASCENT));
        target.drawText(t.text, {
          x: at.x,
          y: at.y,
          size,
          font: resources.font,
          color: hexToRgb(t.color),
          rotate: degrees(rotationCw),
        });
      });
    }

    page.stamps.forEach((st) => {
      const image = resources.images.get(st.assetId);
      if (!image) return;
      const width = st.w * visW;
      const height = st.h * visH;
      const at = place(st.x * visW, visH - (st.y * visH + height));
      target.drawImage(image, {
        x: at.x, y: at.y, width, height, rotate: degrees(rotationCw),
      });
    });
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

    // Pages that stay vector still need their stamps and text drawn on; the
    // rasterised ones already carry them, burned into the bitmap.
    const resources = await prepareAnnotationResources(out, list.filter((pg) => !needsRaster(pg)));

    for (let i = 0; i < list.length; i++) {
      const page = list[i];
      if (copies[i]) {
        const copied = copies[i];
        copied.setRotation(degrees(norm360(copied.getRotation().angle + page.rot)));
        out.addPage(copied);
        drawPageAnnotations(copied, page, resources);
      } else {
        await drawRasterPage(out, page, settings);
      }
      if (onProgress) onProgress((i + 1) / list.length);
      if (i % 4 === 3) await breathe(settings.abortCheck || (() => exportAbort));
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
      if (i % 4 === 3) await breathe(opts.abortCheck || (() => exportAbort));
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

  // ---------------------------------------------------------------- size preview

  // Both figures come from actually building the file, never from a sample:
  // page weight varies far too much for an extrapolation to be worth showing.
  let sizeToken = 0;
  let plainSizeCache = null;                 // { key, bytes }
  let plainSizeInflight = null;              // { key, promise, checks:Set }
  const compressedSizeCache = new Map();     // key -> bytes

  function docSignature() {
    return pages.map(pageSignature).join('~');
  }

  function plainSizeKey() {
    return docSignature() + '|' + $('ex-strip-meta').checked;
  }

  /** A plain build is only slow when pages have to be rasterised for redaction. */
  function plainSizeIsSlow() {
    return pages.length > AUTO_SIZE_PAGE_LIMIT || pages.some((p) => p.redactions.length > 0);
  }

  async function buildPlainSize(check) {
    measuringDepth++;
    try {
      const out = await buildPdf(pages, {
        stripMetadata: $('ex-strip-meta').checked,
        abortCheck: check,
      });
      return (await out.save()).length;
    } finally {
      measuringDepth--;
    }
  }

  /**
   * The dialog and the export's own baseline ask for the same number, so the
   * *promise* is shared, not just the finished value — otherwise the identical
   * build runs twice at once. A shared build only gives up once every waiter
   * has lost interest, so a stale dialog cannot cancel the export's baseline.
   */
  async function measurePlainSize(check) {
    const key = plainSizeKey();
    if (plainSizeCache && plainSizeCache.key === key) return plainSizeCache.bytes;
    if (plainSizeInflight && plainSizeInflight.key === key) {
      plainSizeInflight.checks.add(check);
      return plainSizeInflight.promise;
    }

    const checks = new Set([check]);
    const shared = () => exportAbort || [...checks].every((fn) => fn());
    const promise = buildPlainSize(shared).then((bytes) => {
      plainSizeCache = { key, bytes };
      return bytes;
    }).finally(() => {
      if (plainSizeInflight && plainSizeInflight.promise === promise) plainSizeInflight = null;
    });
    plainSizeInflight = { key, promise, checks };
    return promise;
  }

  async function measureCompressedSize(opts, check, onProgress) {
    const key = [docSignature(), opts.dpi, opts.quality, opts.stripMetadata].join('|');
    if (compressedSizeCache.has(key)) return compressedSizeCache.get(key);
    measuringDepth++;
    let out;
    try {
      out = await buildPdf(pages, {
        compress: true,
        dpi: opts.dpi,
        quality: opts.quality,
        stripMetadata: opts.stripMetadata,
        abortCheck: check,
      }, onProgress);
    } finally {
      measuringDepth--;
    }
    const bytes = (await out.save()).length;
    compressedSizeCache.set(key, bytes);
    return bytes;
  }

  function setSizeText(id, text, pending) {
    const el = $(id);
    el.textContent = text;
    el.classList.toggle('pending', !!pending);
  }

  function showSizeDelta(plain, compressed) {
    const delta = $('size-delta');
    if (!plain || !compressed) {
      delta.classList.add('hidden');
      return;
    }
    const ratio = 1 - compressed / plain;
    delta.classList.remove('hidden');
    delta.classList.toggle('bad', ratio <= 0);
    delta.textContent = ratio > 0
      ? `-${Math.round(ratio * 100)}%`
      : `+${Math.round(-ratio * 100)}%`;
  }

  /**
   * Refresh the two figures in the export dialog. Large documents wait to be
   * asked, because measuring them honestly means rendering every page.
   */
  async function refreshSizes(force) {
    if (!pages.length || $('modal-export').classList.contains('hidden')) return;
    const token = ++sizeToken;
    const stale = () => token !== sizeToken;
    const opts = readExportOptions();
    const measureBtn = $('size-measure');
    // The panel belongs to the PDF mode; the others ignore these figures and
    // must not pay for a full build just because the dialog opened.
    if (opts.mode !== 'pdf') return;

    $('size-delta').classList.add('hidden');

    // Redacted pages are rasterised at 300 DPI even without compression, so
    // the plain figure is no cheaper than the compressed one — it waits to be
    // asked for as well, rather than starting the moment the dialog opens.
    const cachedKey = plainSizeKey();
    const cachedPlain = plainSizeCache && plainSizeCache.key === cachedKey ? plainSizeCache.bytes : null;
    if (cachedPlain == null && plainSizeIsSlow() && !force) {
      setSizeText('size-plain', '未計測', true);
      setSizeText('size-compressed', opts.compress ? '未計測' : '圧縮なし', true);
      measureBtn.classList.remove('hidden');
      $('size-note').textContent = pages.length > AUTO_SIZE_PAGE_LIMIT
        ? `${pages.length} ページあるため自動計測は行いません。ボタンを押すと実際に書き出して測ります。`
        : '墨消しのあるページは画像化して書き出すため、自動計測は行いません。ボタンを押すと実際に書き出して測ります。';
      return;
    }

    setSizeText('size-plain', '計測中...', true);

    let plain;
    try {
      plain = await measurePlainSize(stale);
    } catch (err) {
      if (err && err.name === 'AbortByUser') return;
      console.warn('plain size failed', err);
      setSizeText('size-plain', '計測できません', true);
      return;
    }
    if (stale()) return;
    setSizeText('size-plain', formatBytes(plain), false);

    if (!opts.compress) {
      setSizeText('size-compressed', '圧縮なし', true);
      measureBtn.classList.add('hidden');
      $('size-note').textContent = 'ページを削除・追加・回転すると、この数値も更新されます。';
      return;
    }

    const key = [docSignature(), opts.dpi, opts.quality, opts.stripMetadata].join('|');
    const known = compressedSizeCache.get(key);
    if (known != null) {
      setSizeText('size-compressed', formatBytes(known), false);
      showSizeDelta(plain, known);
      measureBtn.classList.add('hidden');
      $('size-note').textContent = '実際に書き出して測った値です。推定ではありません。';
      return;
    }

    if (pages.length > AUTO_SIZE_PAGE_LIMIT && !force) {
      setSizeText('size-compressed', '未計測', true);
      measureBtn.classList.remove('hidden');
      $('size-note').textContent =
        `${pages.length} ページあるため自動計測は行いません。ボタンを押すと全ページを実際に圧縮して測ります。`;
      return;
    }

    measureBtn.classList.add('hidden');
    setSizeText('size-compressed', '計測中... 0%', true);
    $('size-note').textContent = '全ページを実際に圧縮して測っています。';
    try {
      const bytes = await measureCompressedSize(opts, stale, (r) => {
        if (!stale()) setSizeText('size-compressed', `計測中... ${Math.round(r * 100)}%`, true);
      });
      if (stale()) return;
      setSizeText('size-compressed', formatBytes(bytes), false);
      showSizeDelta(plain, bytes);
      $('size-note').textContent = '実際に書き出して測った値です。推定ではありません。';
    } catch (err) {
      if (err && err.name === 'AbortByUser') return;
      console.warn('compressed size failed', err);
      setSizeText('size-compressed', '計測できません', true);
      measureBtn.classList.remove('hidden');
    }
  }

  let sizeDebounce = 0;
  function scheduleSizeRefresh() {
    clearTimeout(sizeDebounce);
    sizeToken++;                     // drop whatever is already running
    sizeDebounce = setTimeout(() => refreshSizes(false), 250);
  }

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
    // The gauge shows the figure and its unit in two sizes, so the formatted
    // string has to be split rather than dropped in whole.
    const sizeParts = formatBytes(blob.size).split(' ');
    $('result-size').textContent = sizeParts[0];
    $('result-unit').textContent = sizeParts[1] || 'B';

    const compare = $('result-compare');
    compare.classList.remove('hidden', 'compare-bad');
    // The baseline is the same page set written out uncompressed, so the figure
    // reflects what compression did — not what deleting pages did.
    if (!compareBase || compareBase <= 0) {
      compare.classList.add('hidden');
    } else if (blob.size < compareBase) {
      const saved = Math.round((1 - blob.size / compareBase) * 100);
      compare.textContent = `圧縮なしで書き出した場合より ${saved}% 小さくなりました`
        + `（${formatBytes(compareBase)} → ${formatBytes(blob.size)}）`;
    } else {
      // Rasterising a text/vector PDF reliably makes it bigger. Say so rather
      // than quietly handing back a worse file than the one they started with.
      compare.classList.add('compare-bad');
      compare.textContent = `圧縮なしで書き出した場合より大きくなりました`
        + `（${formatBytes(compareBase)} → ${formatBytes(blob.size)}）。`
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

    // Comparing against the uncompressed build of the *same* pages keeps the
    // saving attributable to compression rather than to deleted pages.
    let baseline = 0;
    if (opts.compress) {
      try {
        baseline = await measurePlainSize(() => exportAbort);
      } catch (err) {
        // A measurement started for the dialog may already have been abandoned
        // when this joined it. Only a real cancel stops the export.
        if (err && err.name === 'AbortByUser' && exportAbort) throw err;
        console.warn('baseline measurement failed', err);
      }
    }

    setProgress(1);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    showResult(blob, `${opts.filename}.pdf`, 'PDF', baseline);
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
      await breathe(() => exportAbort);
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
      await breathe(() => exportAbort);
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
        else if (act === 'redact') openAnnotate(uid);
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
        openAnnotate(uid);
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
    sizeToken++;                 // abandon anything still measuring
    plainSizeCache = null;
    plainSizeInflight = null;
    compressedSizeCache.clear();
    stampAssets.forEach((asset) => URL.revokeObjectURL(asset.url));
    stampAssets.clear();
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
    refreshSizes(false);
  }

  function initExportPanel() {
    bindSegmented('ex-mode', 'mode', (mode) => {
      document.querySelectorAll('.ex-panel').forEach((panel) => {
        const on = panel.dataset.panel === mode;
        panel.classList.toggle('hidden', !on);
        panel.classList.toggle('flex', on);
      });
      if (mode === 'pdf') scheduleSizeRefresh();
      else sizeToken++;              // stop measuring for a mode that ignores it
    });

    bindSegmented('ex-compress', 'v', (v) => {
      const wrap = $('ex-compress-opts');
      wrap.classList.toggle('hidden', v !== 'on');
      wrap.classList.toggle('flex', v === 'on');
      scheduleSizeRefresh();
    });

    $('ex-dpi').addEventListener('change', scheduleSizeRefresh);
    $('ex-quality').addEventListener('change', scheduleSizeRefresh);
    $('ex-strip-meta').addEventListener('change', scheduleSizeRefresh);
    $('size-measure').addEventListener('click', () => refreshSizes(true));

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
    $('redact-apply').addEventListener('click', applyAnnotations);
    $('redact-clear').addEventListener('click', () => {
      anDraft = { redactions: [], stamps: [], texts: [] };
      drawAnnotationOverlay();
      updateAnnotationHints();
    });

    bindSegmented('an-tool', 'v', setAnnotationTool);
    $('stamp-add').addEventListener('click', () => $('stamp-file').click());
    $('stamp-file').addEventListener('change', (e) => {
      if (e.target.files.length) addStampFiles(e.target.files);
      e.target.value = '';
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
