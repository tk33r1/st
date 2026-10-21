/* B4: ホーム画面のウィジェットは入口だけ。画面からは起動リンクの検査と「ホーム画面に追加」だけを行い、会話の内容は渡さない。 */
(function (root) {
  'use strict';
  var idPattern = /^[a-zA-Z0-9_-]{1,160}$/;
  // new・voice はチャット・音声入力、camera・album はネイティブが撮影・写真の選択を開き、結果は共有と同じ経路で届く。
  var actions = ['new', 'voice', 'camera', 'album'];
  function link(value) {
    try {
      var url = new URL(value), keys = Array.from(url.searchParams.keys());
      if (url.protocol !== 'magi:' || url.username || url.password || url.port || url.hash || url.pathname && url.pathname !== '/') return null;
      if (actions.indexOf(url.hostname) >= 0 && !keys.length) return { action: url.hostname };
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
    return {
      state: function () { return plugin.information(); },
      pin: function () { return plugin.pin(); }
    };
  }
  root.MagiNativeWidget = { create: create, link: link };
})(typeof window !== 'undefined' ? window : globalThis);
