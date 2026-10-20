/* B3: 接続と耐久保存はAndroid、表示と会話JSONへの取り込みは既存の画面が担当する。 */
(function (root) {
  'use strict';
  var validId = /^[a-zA-Z0-9_-]{1,160}$/;
  function pause(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  function abortError() { return new DOMException('Stopped', 'AbortError'); }
  function watch() { return { chunk: function () {}, end: function () {}, finish: function () {}, isBuffered: function () { return false; } }; }
  async function create(options) {
    var cap = options.cap;
    if (!cap || !cap.isNativePlatform() || cap.getPlatform() !== 'android') return null;
    var plugin = cap.Plugins && cap.Plugins.MagiConversation;
    if (!plugin) return null;
    var information = await plugin.information(), asked = false;
    var notice = options.notice || function () {};
    async function permission() {
      var state = await plugin.checkPermissions();
      var previous = false; try { previous = root.localStorage.getItem('magi_notifications_asked') === '1'; } catch (_) {}
      if (!asked && !previous && /^prompt/.test(state.display)) {
        asked = true;
        notice('Notifications let you know when a reply arrives while MAGI is in the background. / アプリを離れても回答の到着を通知します。');
        try { root.localStorage.setItem('magi_notifications_asked', '1'); } catch (_) {}
        await plugin.requestPermissions();
      }
    }
    async function cancel(id) { if (validId.test(id)) await plugin.cancel({ id: id }); }
    async function acknowledge(id) {
      await cancel(id);
      for (var attempt = 0; attempt < 5; attempt++) {
        try { await plugin.acknowledge({ id: id }); return; }
        catch (error) { if (error.message !== 'conversation_busy' || attempt === 4) throw error; await pause(50); }
      }
    }
    return {
      id: function () { return 'request_' + Array.from(root.crypto.getRandomValues(new Uint8Array(16))).map(function (n) { return n.toString(16).padStart(2, '0'); }).join(''); },
      watch: watch,
      permission: function () { return plugin.checkPermissions(); },
      settings: function () { return plugin.openNotificationSettings(); },
      pending: async function () { var result = await plugin.pending(); return Array.isArray(result.runs) ? result.runs : []; },
      cancel: cancel,
      acknowledge: acknowledge,
      clear: async function (sessionId) {
        var rows = await this.pending();
        for (var row of rows) if (!sessionId || row.sessionId === sessionId) await acknowledge(row.id);
      },
      open: async function (body, request) {
        var signal = request.ctrl.signal, id = request.id, offset = 0, stopped = false, terminal = false;
        if (!validId.test(id) || signal.aborted) throw abortError();
        var abort = function () { stopped = true; cancel(id).catch(function () {}); };
        signal.addEventListener('abort', abort, { once: true });
        try {
          if (!request.resume) {
            await permission();
            if (signal.aborted) throw abortError();
            await plugin.begin({ id: id, sessionId: request.sessionId, mid: request.mid, title: request.title || 'MAGI', body: body, test: information.test === true });
          }
          if (signal.aborted) { await cancel(id); throw abortError(); }
        } catch (error) { signal.removeEventListener('abort', abort); throw error; }
        var stream = new ReadableStream({
          async pull(controller) {
            try {
              while (!stopped) {
                if (signal.aborted) throw abortError();
                var result = await plugin.read({ id: id, offset: offset });
                if (signal.aborted) throw abortError();
                var bytes = Uint8Array.from(atob(result.base64 || ''), function (ch) { return ch.charCodeAt(0); });
                if (!Number.isSafeInteger(result.offset) || result.offset !== offset + bytes.length || result.length < result.offset) throw new Error('invalid_stream_offset');
                offset = result.offset;
                if (bytes.length) { controller.enqueue(bytes); return; }
                if (result.status !== 'receiving') {
                  terminal = true; signal.removeEventListener('abort', abort);
                  if (result.status === 'complete') controller.close();
                  else if (result.status === 'stopped') { request.ctrl.userStopped = true; request.ctrl.abort(); controller.error(abortError()); }
                  else { var failure = new Error('Could not receive the complete reply'); failure.code = result.error; controller.error(failure); }
                  return;
                }
                await pause(150);
              }
              controller.error(abortError());
            } catch (error) {
              signal.removeEventListener('abort', abort); controller.error(error);
            }
          },
          cancel() {
            stopped = true; signal.removeEventListener('abort', abort);
            if (!terminal && signal.aborted) return cancel(id);
          }
        });
        return { ok: true, body: stream };
      }
    };
  }
  root.MagiNativeConversation = { create: create };
})(typeof window !== 'undefined' ? window : globalThis);
