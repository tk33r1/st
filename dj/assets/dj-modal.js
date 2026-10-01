/* DJ の各画面で、モーダルの閉じ方と確認 UI をそろえる。 */
(function (global) {
  'use strict';

  const returnFocus = new WeakMap();
  const fallbackBackdrops = new WeakMap();
  const fallbackStack = [];
  const FOCUSABLE = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  function hasNativeDialog(dialog) {
    return typeof dialog.showModal === 'function' && typeof dialog.close === 'function';
  }

  function isOpen(dialog) {
    return hasNativeDialog(dialog) ? dialog.open : dialog.hasAttribute('open');
  }

  function focusableIn(dialog) {
    return Array.from(dialog.querySelectorAll(FOCUSABLE)).filter(function (element) {
      return !element.hidden && element.getAttribute('aria-hidden') !== 'true' && element.getClientRects().length;
    });
  }

  function syncFallbackLayers() {
    fallbackStack.forEach(function (dialog, index) {
      const backdrop = fallbackBackdrops.get(dialog);
      if (backdrop) backdrop.style.zIndex = String(1000 + index * 2);
      dialog.style.zIndex = String(1001 + index * 2);
    });
    document.documentElement.classList.toggle('dj-modal-fallback-active', fallbackStack.length > 0);
  }

  function showFallback(dialog) {
    const backdrop = document.createElement('div');
    backdrop.className = 'dj-modal-fallback-backdrop';
    backdrop.setAttribute('aria-hidden', 'true');
    backdrop.addEventListener('click', function () { close(dialog); });
    dialog.before(backdrop);
    fallbackBackdrops.set(dialog, backdrop);
    fallbackStack.push(dialog);

    dialog.classList.add('dj-modal--fallback-open');
    dialog.setAttribute('open', '');
    // 未対応ブラウザの dialog は通常の HTMLElement なので、既存コード用に open も持たせる。
    try { dialog.open = true; } catch { /* 属性を正本にする */ }
    if (!dialog.hasAttribute('role')) dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    syncFallbackLayers();

    const first = focusableIn(dialog)[0];
    if (first) first.focus();
    else {
      dialog.setAttribute('tabindex', '-1');
      dialog.focus();
    }
  }

  function closeFallback(dialog) {
    if (!dialog.hasAttribute('open')) return;
    dialog.removeAttribute('open');
    dialog.removeAttribute('aria-modal');
    try { dialog.open = false; } catch { /* 属性を正本にする */ }
    dialog.classList.remove('dj-modal--fallback-open');
    dialog.style.removeProperty('z-index');

    const backdrop = fallbackBackdrops.get(dialog);
    if (backdrop) backdrop.remove();
    fallbackBackdrops.delete(dialog);
    const index = fallbackStack.indexOf(dialog);
    if (index !== -1) fallbackStack.splice(index, 1);
    syncFallbackLayers();

    // ネイティブの close() と同じく、利用側の後片付けを close イベントへ集約する。
    dialog.dispatchEvent(new Event('close'));
  }

  function close(dialog) {
    if (!dialog || !isOpen(dialog)) return;
    if (hasNativeDialog(dialog)) dialog.close();
    else closeFallback(dialog);
  }

  function bind(dialog) {
    if (!dialog || dialog.dataset.djModalBound === 'true') return dialog;
    dialog.dataset.djModalBound = 'true';

    dialog.addEventListener('click', function (event) {
      const closeButton = event.target.closest('[data-dj-modal-close]');
      if (closeButton && dialog.contains(closeButton)) {
        close(dialog);
        return;
      }

      /* ネイティブの ::backdrop は要素ではなく、そこでのクリックは dialog 自身に届く。
         共通モーダルは padding: 0 でヘッダーと本文が枠内を覆うため、dialog 自身なら背景と判断できる。
         フォールバックには実体の backdrop があるので、そちらの click で閉じる。 */
      if (hasNativeDialog(dialog) && event.target === dialog) close(dialog);
    });

    dialog.addEventListener('close', function () {
      const target = returnFocus.get(dialog);
      returnFocus.delete(dialog);
      if (target && target.isConnected && typeof target.focus === 'function') target.focus({ preventScroll: true });
    });

    return dialog;
  }

  function show(dialog) {
    bind(dialog);
    if (!isOpen(dialog)) {
      returnFocus.set(dialog, document.activeElement);
      if (hasNativeDialog(dialog)) dialog.showModal();
      else showFallback(dialog);
    }
    return dialog;
  }

  /* dialog 未対応時の Esc とフォーカストラップ。背景のページへ Tab が抜けないよう、
     最前面のモーダルだけを対象にする。 */
  document.addEventListener('keydown', function (event) {
    if (!fallbackStack.length) return;
    const dialog = fallbackStack[fallbackStack.length - 1];
    if (event.key === 'Escape') {
      event.preventDefault();
      close(dialog);
      return;
    }
    if (event.key !== 'Tab') return;

    const items = focusableIn(dialog);
    if (!items.length) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = items[0], last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }, true);

  function button(label, className) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'dj-modal__button' + (className ? ' ' + className : '');
    el.textContent = label;
    return el;
  }

  function shell(title, message) {
    const dialog = document.createElement('dialog');
    dialog.className = 'dj-modal';
    dialog.setAttribute('aria-labelledby', 'dj-modal-title-' + Math.random().toString(36).slice(2));

    const head = document.createElement('div');
    head.className = 'dj-modal__head';
    const heading = document.createElement('h2');
    heading.className = 'dj-modal__title';
    heading.id = dialog.getAttribute('aria-labelledby');
    heading.textContent = title;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'dj-modal__close';
    x.dataset.djModalClose = '';
    x.setAttribute('aria-label', '閉じる');
    x.textContent = '×';
    head.append(heading, x);

    const body = document.createElement('div');
    body.className = 'dj-modal__body';
    if (message) {
      const text = document.createElement('p');
      text.className = 'dj-modal__message';
      text.textContent = message;
      body.appendChild(text);
    }

    dialog.append(head, body);
    document.body.appendChild(dialog);
    bind(dialog);
    return { dialog, body };
  }

  /* 使い捨てのモーダルは、閉じる演出（dj-modal.css の transition）が終わってから DOM から外す。
     結果は close の時点で返すので、呼び出し側の処理は演出を待たない。
     演出に対応しないブラウザでは走っている transition が無く、そのまま次のフレームで外れる。 */
  function removeAfterClose(dialog) {
    requestAnimationFrame(function () {
      const running = typeof dialog.getAnimations === 'function' ? dialog.getAnimations() : [];
      Promise.all(running.map(function (a) { return a.finished.catch(function () {}); }))
        .then(function () { dialog.remove(); });
    });
  }

  function confirmModal(options) {
    const opts = typeof options === 'string' ? { message: options } : (options || {});
    const ui = shell(opts.title || '確認', opts.message || '');
    const actions = document.createElement('div');
    actions.className = 'dj-modal__actions';
    const cancel = button(opts.cancelText || 'キャンセル');
    cancel.dataset.djModalClose = '';
    const ok = button(opts.confirmText || '決定', opts.danger ? 'dj-modal__button--danger' : 'dj-modal__button--primary');
    actions.append(cancel, ok);
    ui.body.appendChild(actions);

    return new Promise(function (resolve) {
      let accepted = false;
      ok.addEventListener('click', function () { accepted = true; close(ui.dialog); });
      ui.dialog.addEventListener('close', function () {
        removeAfterClose(ui.dialog);
        resolve(accepted);
      }, { once: true });
      show(ui.dialog);
      ok.focus();
    });
  }

  function promptModal(options) {
    const opts = typeof options === 'string' ? { message: options } : (options || {});
    const ui = shell(opts.title || '入力', opts.message || '');
    const form = document.createElement('form');
    const input = document.createElement('input');
    input.className = 'dj-modal__field';
    input.type = 'text';
    input.value = opts.value == null ? '' : String(opts.value);
    if (opts.placeholder) input.placeholder = opts.placeholder;
    if (opts.maxLength) input.maxLength = opts.maxLength;
    const label = document.createElement('label');
    label.className = 'dj-modal__label';
    label.textContent = opts.inputLabel || opts.title || '入力';
    label.appendChild(input);

    const actions = document.createElement('div');
    actions.className = 'dj-modal__actions';
    const cancel = button(opts.cancelText || 'キャンセル');
    cancel.dataset.djModalClose = '';
    const ok = button(opts.confirmText || '決定', opts.danger ? 'dj-modal__button--danger' : 'dj-modal__button--primary');
    ok.type = 'submit';
    actions.append(cancel, ok);
    form.append(label, actions);
    ui.body.appendChild(form);

    return new Promise(function (resolve) {
      let value = null;
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        value = input.value;
        close(ui.dialog);
      });
      ui.dialog.addEventListener('close', function () {
        removeAfterClose(ui.dialog);
        resolve(value);
      }, { once: true });
      show(ui.dialog);
      input.focus();
      input.select();
    });
  }

  document.querySelectorAll('dialog.dj-modal').forEach(bind);

  global.DJModal = { bind, close, confirm: confirmModal, prompt: promptModal, show };
})(window);
