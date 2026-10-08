/**
 * サイト内検索の②（TypeSafe AI で並べ替える検索）の共通部品（assets/site-search-design.md 5章）。
 * 送信・状態と世代・応答の検査・描画・計測を受け持ち、①（キーワードの一致）と③（Shinya Takeda AI）はページが持つ。
 *
 *   const rank = STSiteSearch.rank({ scope, condition, keywordState, keywordCount, elements, labels, onRun, onSettle, onState, track });
 *   rank.run();         // 検索ボタン・Enter
 *   rank.invalidate();  // 入力・言語・絞り込みが変わったとき
 *   rank.cancel();      // ③を始めるとき
 *   rank.state;         // 'idle' | 'loading' | 'results' | 'no_results' | 'failed' | 'stale'
 *
 * 描くのは textContent と href だけ（innerHTML は使わない）。計測には検索語・URL・題名を渡さない。
 */
(function (w) {
  'use strict';

  var TIMEOUT_MS = 8000; // Worker の6秒に通信の余裕を足す（設計書 5.2）
  var MAX_RESULTS = 5;
  var KINDS = { site: ['page', 'tool', 'game', 'article'], tools: ['tool'], game: ['game'], nitori: ['daily'], retail: ['daily'] };
  var DAILY_DIRS = { nitori: 'nitoridaily', retail: 'retailtechdaily' };
  var STATUSES = ['results', 'no_results', 'failed'];
  function failed(reason) { return { status: 'failed', reason: reason, complete: false, rows: [] }; }

  function endpoint() {
    var host = w.location.hostname;
    return (host === 'localhost' || host === '127.0.0.1' ? 'http://localhost:8787' : 'https://workers.tk.st') + '/magi2/site-search';
  }

  // 結果の URL の検査（設計書 5.3）。合えば href に入れる値を返し、合わなければ null
  function resultHref(value, scope) {
    if (typeof value !== 'string' || !/^\/(?!\/)/.test(value) || /[\\\u0000- \u007f]/.test(value)) return null;
    var url;
    try { url = new URL(value, 'https://tk.st'); } catch (_) { return null; }
    if (url.origin !== 'https://tk.st' || url.search) return null;
    if (DAILY_DIRS[scope]) {
      var pattern = new RegExp('^/job/' + DAILY_DIRS[scope] + '/\\d{8}/$');
      return pattern.test(url.pathname) && /^#art-\d+$/.test(url.hash) ? url.pathname + url.hash : null;
    }
    return url.hash ? null : url.pathname;
  }

  // 応答の本文を画面に出せる形にする。1行でも合わなければ全体を failed にする（一部だけ描くと「ほかに無い」と読めるため）
  function readResult(data, scope) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return failed('unavailable');
    if (STATUSES.indexOf(data.status) < 0 || typeof data.complete !== 'boolean' || !Array.isArray(data.results) || data.results.length > MAX_RESULTS) return failed('unavailable');
    if (data.status === 'failed') return failed(typeof data.reason === 'string' ? data.reason : 'unavailable');
    if (data.status === 'no_results' && data.results.length) return failed('unavailable');
    if (data.status === 'results' && !data.results.length) return failed('unavailable');
    var rows = [];
    for (var i = 0; i < data.results.length; i++) {
      var row = data.results[i];
      if (!row || typeof row !== 'object' || KINDS[scope].indexOf(row.kind) < 0 || typeof row.title !== 'string' || typeof row.description !== 'string') return failed('unavailable');
      var href = resultHref(row.url, scope);
      if (!href) return failed('unavailable');
      rows.push({ kind: row.kind, title: row.title, description: row.description, href: href });
    }
    return { status: data.status, reason: null, complete: data.complete, rows: rows };
  }

  function rank(options) {
    var scope = options.scope;
    if (!KINDS[scope]) throw new Error('Unknown scope');
    var el = options.elements, labels = options.labels;
    var call = function (name, value) { if (typeof options[name] === 'function') { try { options[name](value); } catch (_) { /* ページの処理の失敗で部品を止めない */ } } };
    var track = function (event, values) { if (typeof options.track === 'function') { try { options.track(event, values); } catch (_) { /* 計測は画面から独立 */ } } };
    var self = { state: 'idle', disabled: false };
    var generation = 0, controller = null, timer = null;
    var shownKey = null;  // いま描いている（または読み込み中の）条件のキー
    var ranKey = null;    // 最後に②を実行した条件のキー
    var settled = null;   // 最後に確定した結果 { key, status, reason, count, complete }

    function conditionNow() {
      var c = null;
      try { c = options.condition(); } catch (_) { c = null; }
      return c && typeof c.query === 'string' && c.query ? c : null;
    }
    function keyOf(c) { return c ? JSON.stringify([c.query, c.locale, c.filters || null]) : null; }

    function clear() {
      el.list.replaceChildren();
      el.heading.hidden = true;
      el.section.hidden = true;
      if (el.note) { el.note.textContent = ''; el.note.hidden = true; }
    }
    function setState(next, message) {
      self.state = next;
      el.status.textContent = message || '';
      call('onState', next);
    }
    function stop() {
      generation++;
      if (controller) controller.abort();
      controller = null;
      clearTimeout(timer); timer = null;
    }

    function render(result) {
      clear();
      var texts = labels.texts;
      if (result.status === 'results') {
        result.rows.forEach(function (row, index) {
          var li = document.createElement('li'), a = document.createElement('a'), content = document.createElement('span');
          var title = document.createElement('span'), kind = document.createElement('span');
          a.href = row.href; a.className = 'result-link'; a.dataset.rankPosition = String(index + 1);
          title.className = 'result-title'; title.textContent = row.title; content.appendChild(title);
          if (row.description) { var desc = document.createElement('span'); desc.className = 'description'; desc.textContent = row.description; content.appendChild(desc); }
          kind.className = 'kind'; kind.textContent = labels.kinds[row.kind] || '';
          a.appendChild(content); a.appendChild(kind); li.appendChild(a); el.list.appendChild(li);
        });
        el.heading.textContent = texts.heading; el.heading.hidden = false; el.section.hidden = false;
        var partial = result.complete ? '' : texts.partial;
        if (el.note) { el.note.textContent = partial; el.note.hidden = !partial; }
        setState('results', [texts.count(result.rows.length), el.note ? '' : partial].filter(Boolean).join(' '));
      } else if (result.status === 'no_results') {
        setState('no_results', texts.noResults);
      } else {
        setState('failed', result.reason === 'rate_limited' ? texts.rateLimited : texts.failed);
      }
    }

    // 入力などが変わったとき（設計書 5.2）。前後の空白だけの違いなど、条件のキーが同じなら何もしない
    function reset(force) {
      // まだ②を送っていなければ、入力のたびにすることは無い
      if (!force && self.state === 'idle' && ranKey === null && !controller) return;
      var c = conditionNow(), key = keyOf(c);
      if (!force && key !== null && key === shownKey) return;
      stop(); clear(); shownKey = null;
      if (self.disabled) { setState('idle'); return; }
      // 以前②を実行していれば、空でない入力では stale にして③と検索ボタンを使える状態を保つ。③に切り替えるときは文言を出さない
      if (c && ranKey !== null) setState('stale', force ? '' : labels.texts.stale);
      else setState('idle');
    }

    self.run = function () {
      if (self.disabled) return;
      var c = conditionNow();
      if (!c) return;
      stop();
      var mine = generation, key = keyOf(c);
      var ac = new AbortController(); controller = ac;
      clear(); shownKey = key; ranKey = key; settled = null;
      call('onRun');
      var keywordState = 'known';
      try { keywordState = options.keywordState(); } catch (_) { keywordState = 'failed'; }
      var runValues = { keyword_state: keywordState };
      if (keywordState === 'known') {
        var count = null;
        try { count = options.keywordCount(); } catch (_) { count = null; }
        if (typeof count === 'number') runValues.keyword_count = Math.min(count, 6);
      }
      track('rank_run', runValues);
      setState('loading', labels.texts.loading);
      var body = { query: c.query, locale: c.locale, mode: 'rank', scope: scope };
      if (c.filters) body.filters = c.filters;
      timer = setTimeout(function () { ac.abort(); }, TIMEOUT_MS);
      var timedOut = function () { return ac.signal.aborted && mine === generation; };
      (async function () {
        var result;
        try {
          var res = await fetch(endpoint(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
            credentials: 'omit', referrerPolicy: 'no-referrer', signal: ac.signal });
          if ([200, 429, 400].indexOf(res.status) < 0) result = failed('unavailable');
          else {
            var data;
            try { data = await res.json(); } catch (e) { if (timedOut()) throw e; data = null; }
            result = readResult(data, scope);
            if (res.status === 429 && result.status === 'failed') result.reason = 'rate_limited';
          }
        } catch (_) {
          result = failed(timedOut() ? 'timeout' : 'unavailable');
        }
        // 送ったときの世代と条件のままのときだけ描く（A → B → A でも最初の A の応答は描かない）
        if (mine !== generation || keyOf(conditionNow()) !== key) return;
        clearTimeout(timer); timer = null; controller = null;
        // 描く前に確定させる（描画の onState でページが settled() を読むため）
        settled = { key: key, status: result.status, reason: result.reason, count: result.rows.length, complete: result.complete };
        if (result.reason === 'disabled') {
          self.disabled = true; clear(); shownKey = null; ranKey = null;
          setState('idle');
        } else render(result);
        track('rank_result', { status: result.status, reason: result.reason, count: result.rows.length, complete: result.complete });
        call('onSettle', settled);
      })();
    };
    self.invalidate = function () { reset(false); };
    self.cancel = function () { reset(true); };
    // いまの条件と同じ②の確定結果（③の計測の after に使う。設計書 6.5）。入力が変わった後や未実行なら null
    self.settled = function () {
      return settled && self.state !== 'stale' && self.state !== 'loading' && settled.key === keyOf(conditionNow()) ? settled : null;
    };
    // いま描いている②の URL（①から重複を除くため）
    self.hrefs = function () { return Array.from(el.list.querySelectorAll('a'), function (a) { return a.getAttribute('href'); }); };

    function recordClick(event) {
      var a = event.target.closest && event.target.closest('a[data-rank-position]');
      if (!a || (event.type === 'auxclick' && event.button !== 1)) return;
      track('rank_click', { position: Number(a.dataset.rankPosition) });
    }
    el.list.addEventListener('click', recordClick);
    el.list.addEventListener('auxclick', recordClick);
    clear();
    return self;
  }

  w.STSiteSearch = { rank: rank, readResult: readResult, resultHref: resultHref };
})(window);
