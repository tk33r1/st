/**
 * 404 と日刊ブリーフの検索語を計測用に伏せ字にする（PRD 8.3）。通信は行わない。
 * メールアドレスと長い数字を伏せ、日付は残し、100コードポイントで切る。
 */
(function (w) {
  'use strict';

  var DATE_LIKE = /^(19|20)\d{2}([\s.\-]?)(0?[1-9]|1[0-2])\2(0?[1-9]|[12]\d|3[01])$/;
  function term(value) {
    // 全角の数字・記号を半角にしてから判定する。番号の区切りには長音やマイナスも含める。
    var masked = String(value || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').normalize('NFKC')
      .replace(/[^\s@]+@[^\s@]+/g, '[email]')
      .replace(/\+?\d[\d\s().\-\u2010-\u2015\u2212\u30fc]{6,}\d/g, function (m) { return DATE_LIKE.test(m) ? m : '[number]'; }).trim();
    return Array.from(masked).slice(0, 100).join('');
  }

  w.STSearchAnalytics = { term: term };
})(window);
