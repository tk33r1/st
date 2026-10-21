// 描画前に端末のテーマを反映する。手動の選択は起動中だけ有効で保存しない。
(function () {
  'use strict';
  try { localStorage.removeItem('magi_theme'); } catch (_) {}
  var manual = false, dark, light;
  try {
    dark = window.matchMedia('(prefers-color-scheme: dark)');
    light = window.matchMedia('(prefers-color-scheme: light)');
  } catch (_) {}
  function apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.style.colorScheme = theme;
  }
  function follow() {
    if (manual) return;
    var hour = new Date().getHours();
    apply(dark && dark.matches ? 'dark' : light && light.matches ? 'light' : hour >= 6 && hour < 18 ? 'light' : 'dark');
  }
  [dark, light].forEach(function (media) {
    if (!media) return;
    if (media.addEventListener) media.addEventListener('change', follow);
    else if (media.addListener) media.addListener(follow);
  });
  window.MagiTheme = { choose: function (theme) { manual = true; apply(theme === 'dark' ? 'dark' : 'light'); } };
  follow();
})();

// 描画前に画面の言語を決める。︙のメニューで選んだ言語は保存し、無ければ端末の言語（日本語以外は英語）。
(function () {
  'use strict';
  var saved = null;
  try { saved = localStorage.getItem('magi_lang'); } catch (_) {}
  document.documentElement.lang = saved === 'ja' || saved === 'en' ? saved : /^ja(?:-|$)/i.test(navigator.language || '') ? 'ja' : 'en';
  window.MagiLanguage = { choose: function (lang) {
    document.documentElement.lang = lang === 'ja' ? 'ja' : 'en';
    try { localStorage.setItem('magi_lang', document.documentElement.lang); } catch (_) {}
  } };
})();
