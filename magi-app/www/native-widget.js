/* B4: ホーム画面へ渡すのは直近の結論の小さい表示情報だけ。通信と送信は行わない。 */
(function (root) {
  'use strict';
  var idPattern = /^[a-zA-Z0-9_-]{1,160}$/;
  function text(value, limit) {
    return Array.from(String(value || '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\s]+/g, ' ').trim()).slice(0, limit).join('');
  }
  function latest(sessions) {
    for (var session of sessions) {
      if (!session || !idPattern.test(session.id) || !Array.isArray(session.history)) continue;
      var answer = session.history.slice().reverse().find(function (m) { return m.role === 'assistant' && !m.clarify && typeof m.content === 'string' && m.content.trim(); });
      if (answer) return { session: session, answer: answer };
    }
    return null;
  }
  function data(sessions, masked) {
    var row = latest(sessions), result = { masked: masked, sessionId: row ? row.session.id : '' };
    // 伏せているときは、題名・本文・決議を橋渡しへ渡さない。
    if (!masked) Object.assign(result, { title: row ? text(row.session.title, 200) : '', summary: row ? text(row.answer.content, 120) : '',
      verdict: row && row.answer.magi && ['approve', 'reject', 'hold'].indexOf(row.answer.magi.result) >= 0 ? row.answer.magi.result : '' });
    return result;
  }
  function pendingAnswer(sessions, rows) {
    var saved = latest(sessions), selected = null;
    rows.forEach(function (row) {
      if (row.status !== 'complete' || row.widgetAnswer === false || !idPattern.test(row.id) || !idPattern.test(row.sessionId)) return;
      var session = sessions.find(function (s) { return s.id === row.sessionId; });
      if (!session || session.history.some(function (m) { return m.role === 'assistant' && m.native_request === row.id; })) return;
      // 今まさに待っている往復だけは、会話を開き直した日時より回答の完了が前でも復元する。
      var last = session.history[session.history.length - 1];
      var waiting = saved && saved.session.id === row.sessionId && last && last.role === 'user' && last.native_request === row.id;
      if (saved && !waiting && (row.finishedAt || 0) < (saved.session.timestamp || 0)) return;
      if (!selected || (row.finishedAt || 0) > (selected.finishedAt || 0)) selected = row;
    });
    return selected;
  }
  function link(value) {
    try {
      var url = new URL(value), keys = Array.from(url.searchParams.keys());
      if (url.protocol !== 'magi:' || url.username || url.password || url.port || url.hash || url.pathname && url.pathname !== '/') return null;
      if ((url.hostname === 'new' || url.hostname === 'voice') && !keys.length) return { action: url.hostname };
      var ids = url.searchParams.getAll('id');
      if (url.hostname === 'open' && keys.length === 1 && keys[0] === 'id' && ids.length === 1 && idPattern.test(ids[0])) return { action: 'open', id: ids[0] };
    } catch (_) {}
    return null;
  }
  async function create(options) {
    var cap = options.cap;
    if (!cap || !cap.isNativePlatform() || cap.getPlatform() !== 'android') return null;
    var plugin = cap.Plugins && cap.Plugins.MagiWidget;
    if (!plugin) return null;
    var tail = Promise.resolve();
    function run(task) { var result = tail.then(task); tail = result.catch(function () {}); return result; }
    async function sync(attempt = 0) {
      // データを読む前の版を保持し、途中のネイティブ更新を確実に競合として扱う。
      var state = await plugin.information();
      await options.flush();
      var sessions = options.sessions(), pending = await options.pending();
      var payload = Object.assign(data(sessions, state.masked !== false), { revision: state.revision }), row = pendingAnswer(sessions, pending);
      if (row) Object.assign(payload, { pendingId: row.id, pendingSessionId: row.sessionId });
      try { await plugin.update(payload); }
      catch (error) { if (error.message !== 'widget_state_changed' || attempt >= 2) throw error; await sync(attempt + 1); }
    }
    return {
      // runは直前の処理の結果を引数に渡すため、再試行の回数は0から明示して始める。
      sync: function () { return run(function () { return sync(0); }); },
      state: function () { return run(function () { return plugin.information(); }); },
      setMasked: function (masked) { return run(async function () { await plugin.setMasked({ masked: masked }); await sync(0); }); },
      pin: function () { return plugin.pin(); }
    };
  }
  root.MagiNativeWidget = { create: create, data: data, link: link };
})(typeof window !== 'undefined' ? window : globalThis);
