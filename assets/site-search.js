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
  var READ_STATUSES = [200, 429, 400]; // 本文を読む HTTP の状態（設計書 5.3）。ほかは読まずに failed（unavailable）
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
      var pattern = new RegExp('^/job/' + DAILY_DIRS[scope] + '/(\\d{8})/#art-([1-9]\\d*)$');
      var match = pattern.exec(value);
      if (!match || match[0] !== value || !Number.isSafeInteger(Number(match[2]))) return null;
      var date = match[1], iso = date.slice(0, 4) + '-' + date.slice(4, 6) + '-' + date.slice(6);
      var parsed = new Date(iso + 'T00:00:00Z');
      return Number(date.slice(0, 4)) > 0 && !isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso ? value : null;
    }
    return url.hash ? null : url.pathname;
  }

  // 応答の本文を画面に出せる形にする。1行でも合わなければ全体を failed にする（一部だけ描くと「ほかに無い」と読めるため）
  function readResult(data, scope) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return failed('unavailable');
    if (STATUSES.indexOf(data.status) < 0 || typeof data.complete !== 'boolean' || !Array.isArray(data.results) || data.results.length > MAX_RESULTS) return failed('unavailable');
    var daily = !!DAILY_DIRS[scope], searched = data.searched;
    if (daily) {
      if (typeof data.cached !== 'boolean' || (data.status === 'failed' && (data.complete || data.results.length))) return failed('unavailable');
      if (searched !== null || data.status !== 'failed') {
        if (!searched || !['total', 'candidates', 'judged'].every(function (k) { return Number.isSafeInteger(searched[k]) && searched[k] >= 0; })
          || searched.judged > searched.candidates || searched.candidates > searched.total || searched.candidates > 20
          || typeof searched.generation !== 'string' || !/^[a-f0-9]{1,32}$/i.test(searched.generation) || /[^a-f0-9]/i.test(searched.generation)
          || (data.status !== 'failed' && (data.complete !== (searched.judged === searched.candidates) || data.results.length > searched.judged))) return failed('unavailable');
      }
      if (data.status === 'no_results' && !data.complete) return failed('unavailable');
    }
    if (data.status === 'failed') return Object.assign(failed(typeof data.reason === 'string' ? data.reason : 'unavailable'), daily ? { searched: searched, cached: data.cached } : {});
    if (data.status === 'no_results' && data.results.length) return failed('unavailable');
    if (data.status === 'results' && !data.results.length) return failed('unavailable');
    var rows = [], hrefs = new Set();
    for (var i = 0; i < data.results.length; i++) {
      var row = data.results[i];
      if (!row || typeof row !== 'object' || KINDS[scope].indexOf(row.kind) < 0 || typeof row.title !== 'string' || typeof row.description !== 'string') return failed('unavailable');
      var href = resultHref(row.url, scope);
      if (!href || (daily && (!row.title.trim() || hrefs.has(href)))) return failed('unavailable');
      hrefs.add(href);
      rows.push({ kind: row.kind, title: row.title, description: row.description, href: href });
    }
    return Object.assign({ status: data.status, reason: null, complete: data.complete, rows: rows }, daily ? { searched: searched, cached: data.cached } : {});
  }

  // HTTP の状態と本文から、画面に出す結果を決める。429 の失敗は理由に関係なく rate_limited（評価もこれを使う）
  function readResponse(status, data, scope) {
    if (READ_STATUSES.indexOf(status) < 0) return failed('unavailable');
    var result = readResult(data, scope);
    if (status === 429 && result.status === 'failed') result.reason = 'rate_limited';
    return result;
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
    var hasRun = false;  // 以前②を実行したか（入力の変更で stale にするため）
    var settled = null;   // 最後に確定した結果 { key, status, reason, count, complete }

    function conditionNow() {
      var c = null;
      try { c = options.condition(); } catch (_) { c = null; }
      return c && typeof c.query === 'string' && c.query ? c : null;
    }
    function keyOf(c) { return c ? JSON.stringify([c.query, c.locale, c.filters || null].concat(DAILY_DIRS[scope] ? [c.generation || null] : [])) : null; }

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

    function render(result, condition) {
      clear();
      var texts = labels.texts;
      var generationNote = result.searched && condition.generation && condition.generation !== result.searched.generation ? texts.generationMismatch : '';
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
        var partial = [typeof texts.coverage === 'function' ? texts.coverage(result.searched) : '', result.complete ? '' : texts.partial, generationNote].filter(Boolean).join(' ');
        if (el.note) { el.note.textContent = partial; el.note.hidden = !partial; }
        setState('results', [texts.count(result.rows.length), el.note ? '' : partial].filter(Boolean).join(' '));
      } else if (result.status === 'no_results') {
        var none = typeof texts.noResults === 'function' ? texts.noResults(result.searched) : texts.noResults;
        setState('no_results', [none, generationNote].filter(Boolean).join(' '));
      } else {
        setState('failed', result.reason === 'rate_limited' ? texts.rateLimited : result.reason === 'index_updating' && texts.indexUpdating ? texts.indexUpdating : texts.failed);
      }
    }

    // 入力などが変わったとき（設計書 5.2）。前後の空白だけの違いなど、条件のキーが同じなら何もしない
    function reset(force) {
      // まだ②を送っていなければ、入力のたびにすることは無い
      if (!force && self.state === 'idle' && !hasRun && !controller) return;
      var c = conditionNow(), key = keyOf(c);
      if (!force && key !== null && key === shownKey) return;
      stop(); clear(); shownKey = null;
      if (self.disabled) { setState('idle'); return; }
      // 以前②を実行していれば、空でない入力では stale にして③と検索ボタンを使える状態を保つ。③に切り替えるときは文言を出さない
      if (c && hasRun) setState('stale', force ? '' : labels.texts.stale);
      else setState('idle');
    }

    self.run = function () {
      if (self.disabled) return;
      var c = conditionNow();
      if (!c) return;
      var key = keyOf(c);
      // 同じ条件で読み込み中・結果を出している間は送り直さない（Enter の連打で回数と Jev を使わない）。失敗の後は送り直せる
      if (key === shownKey && ['loading', 'results', 'no_results'].indexOf(self.state) >= 0) return;
      stop();
      var mine = generation;
      var ac = new AbortController(); controller = ac;
      clear(); shownKey = key; hasRun = true; settled = null;
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
      if (DAILY_DIRS[scope] && c.generation) body.generation = c.generation;
      timer = setTimeout(function () { ac.abort(); }, TIMEOUT_MS);
      var timedOut = function () { return ac.signal.aborted && mine === generation; };
      (async function () {
        var result;
        try {
          var res = await fetch(endpoint(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
            credentials: 'omit', referrerPolicy: 'no-referrer', signal: ac.signal });
          var data = null;
          if (READ_STATUSES.indexOf(res.status) >= 0) { try { data = await res.json(); } catch (e) { if (timedOut()) throw e; } }
          result = readResponse(res.status, data, scope);
        } catch (_) {
          result = failed(timedOut() ? 'timeout' : 'unavailable');
        }
        // 送ったときの世代と条件のままのときだけ描く（A → B → A でも最初の A の応答は描かない）
        if (mine !== generation) return;
        clearTimeout(timer); timer = null; controller = null;
        // 入力のイベント無しで条件が変わっていた（自動入力など）。描かずに stale にする（読み込み中のまま止めない）
        if (keyOf(conditionNow()) !== key) { self.invalidate(); return; }
        // 描く前に確定させる（描画の onState でページが settled() を読むため）
        settled = Object.assign({ key: key, status: result.status, reason: result.reason, count: result.rows.length, complete: result.complete }, DAILY_DIRS[scope] ? { searched: result.searched, cached: result.cached } : {});
        if (result.reason === 'disabled') {
          self.disabled = true; clear(); shownKey = null; hasRun = false;
          setState('idle');
        } else render(result, c);
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

  w.STSiteSearch = { rank: rank, readResponse: readResponse };
})(window);
