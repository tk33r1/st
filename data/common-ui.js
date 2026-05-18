/* Shared UI helpers for ST TOOLS pages.
 * Exposes `window.STCommon` with utilities that the tool pages
 * (light-svg, nextgen-image, pdf-to-image, video-to-animation, ...)
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
  const VIEWS = ['view-upload', 'view-loading', 'view-result'];
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

  function isPrivateHost(hostname) {
    if (!hostname) return true;
    const h = hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
    if (h === '127.0.0.1' || h === '0.0.0.0' || h === '::1') return true;
    if (/^10\./.test(h)) return true;
    if (/^192\.168\./.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
    if (/^169\.254\./.test(h)) return true;
    if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true;
    return false;
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

    function syncAfterSize() {
      // Match the after image to the before image's rendered box so the
      // clip in .compare-after-wrap lines up pixel-for-pixel.
      const r = beforeImg.getBoundingClientRect();
      afterImg.style.width = r.width + 'px';
      afterImg.style.height = r.height + 'px';
    }

    function applyPercent(percent) {
      currentPercent = Math.max(0, Math.min(100, percent));
      afterWrap.style.width = currentPercent + '%';
      handle.style.left = currentPercent + '%';
      syncAfterSize();
    }

    function setFromClientX(clientX) {
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = ((clientX - rect.left) / rect.width) * 100;
      applyPercent(ratio);
    }

    beforeImg.src = opts.beforeUrl;
    afterImg.src = opts.afterUrl;

    let loaded = 0;
    const onLoad = () => {
      loaded += 1;
      if (loaded >= 2) applyPercent(initial);
    };
    beforeImg.addEventListener('load', onLoad);
    afterImg.addEventListener('load', onLoad);
    if (beforeImg.complete && beforeImg.naturalWidth > 0) onLoad();
    if (afterImg.complete && afterImg.naturalWidth > 0) onLoad();

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
    function onResize() { applyPercent(currentPercent); }

    container.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    container.addEventListener('touchstart', onDown, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onUp);
    window.addEventListener('resize', onResize);

    return function teardown() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
      window.removeEventListener('resize', onResize);
    };
  }

  global.STCommon = {
    formatBytes,
    showToast,
    switchView,
    isPrivateHost,
    preventDefaults,
    setupDropzone,
    setupInlineCompare,
  };
})(window);
