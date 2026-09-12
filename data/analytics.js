/**
 * tk.st 共通計測タグローダー（Google Tag Manager + Ahrefs Analytics）
 *
 * 各ページに同じスニペットをコピペすると ID の変更漏れが出るため、ここに集約する。
 * 読み込み側は <script src="（相対パス）/data/analytics.js" async></script> の1行だけ。
 * <noscript> の GTM iframe は body 内に置く必要があるため各ページに残す。
 */
(function (w, d) {
  'use strict';

  var GTM_ID = 'GTM-59NWV9XK';
  var AHREFS_KEY = 'HKe6iphbuiskJsOdfXIOog';

  // GTM 本体より先に dataLayer と gtm.start を用意する（公式スニペットと同じ順序）
  w.dataLayer = w.dataLayer || [];
  w.dataLayer.push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });

  function loadScript(src, attrs) {
    var s = d.createElement('script');
    s.async = true;
    s.src = src;
    if (attrs) {
      for (var key in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, key)) {
          s.setAttribute(key, attrs[key]);
        }
      }
    }
    (d.head || d.documentElement).appendChild(s);
  }

  loadScript('https://www.googletagmanager.com/gtm.js?id=' + GTM_ID);
  loadScript('https://analytics.ahrefs.com/analytics.js', { 'data-key': AHREFS_KEY });
})(window, document);
