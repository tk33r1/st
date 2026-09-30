/* DJ の各画面で、モーダルの閉じ方と確認 UI をそろえる。 */
(function (global) {
  'use strict';

  function close(dialog) {
    if (dialog && dialog.open) dialog.close();
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

      // ::backdrop は要素ではないので、dialog 自身に届いた座標が枠外かで見分ける。
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const outside = event.clientX < rect.left || event.clientX > rect.right
        || event.clientY < rect.top || event.clientY > rect.bottom;
      if (outside) close(dialog);
    });

    return dialog;
  }

  function show(dialog) {
    bind(dialog);
    if (!dialog.open) dialog.showModal();
    return dialog;
  }

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
        ui.dialog.remove();
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
    input.value = opts.value || '';
    if (opts.placeholder) input.placeholder = opts.placeholder;
    if (opts.maxLength) input.maxLength = opts.maxLength;

    const actions = document.createElement('div');
    actions.className = 'dj-modal__actions';
    const cancel = button(opts.cancelText || 'キャンセル');
    cancel.dataset.djModalClose = '';
    const ok = button(opts.confirmText || '決定', opts.danger ? 'dj-modal__button--danger' : 'dj-modal__button--primary');
    ok.type = 'submit';
    actions.append(cancel, ok);
    form.append(input, actions);
    ui.body.appendChild(form);

    return new Promise(function (resolve) {
      let value = null;
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        value = input.value;
        close(ui.dialog);
      });
      ui.dialog.addEventListener('close', function () {
        ui.dialog.remove();
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
