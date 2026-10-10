/**
 * Daily Brief 共通 UI インタラクション (job/assets/daily-ui.js)
 * Vanilla JS。検索語の計測は assets/search-analytics.js を先に読む。
 */
(function() {
  'use strict';

  const CHECK_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2.5" fill="none"><polyline points="20 6 9 17 4 12"></polyline></svg>';

  async function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (e) {}
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  function flashButton(btn, message, ok) {
    const originalHtml = btn.dataset.originalHtml || btn.innerHTML;
    btn.dataset.originalHtml = originalHtml;
    btn.classList.toggle('copied', ok);
    btn.innerHTML = (ok ? CHECK_ICON : '') + '<span>' + message + '</span>';
    window.setTimeout(function() {
      btn.classList.remove('copied');
      btn.innerHTML = originalHtml;
    }, 2000);
  }

  // ウォッチ中テーマは日次ページのフィルタとポータルの新着一覧が同時に読む。
  // 双方が同じ配列を見るように、localStorage への出入りをここに集約する。
  function createWatchStore() {
    const media = document.body.dataset.dailyMedia || 'daily';
    const topicsKey = 'daily_watch_topics:' + media;
    const seenKey = 'daily_watch_seen:' + media;
    const listeners = [];
    let topics = [];
    try {
      const parsed = JSON.parse(localStorage.getItem(topicsKey) || '[]');
      if (Array.isArray(parsed)) topics = parsed.filter(function(t) { return typeof t === 'string' && t; });
    } catch (e) {}

    return {
      list: function() { return topics.slice(); },
      size: function() { return topics.length; },
      has: function(topic) { return topics.indexOf(topic) !== -1; },
      matches: function(candidates) {
        if (!topics.length) return false;
        return (candidates || []).some(function(topic) { return topics.indexOf(topic) !== -1; });
      },
      toggle: function(topic) {
        const index = topics.indexOf(topic);
        if (index === -1) topics.push(topic); else topics.splice(index, 1);
        try { localStorage.setItem(topicsKey, JSON.stringify(topics)); } catch (e) {}
        listeners.forEach(function(fn) { fn(); });
      },
      onChange: function(fn) { listeners.push(fn); },
      seen: function() {
        try { return localStorage.getItem(seenKey) || ''; } catch (e) { return ''; }
      },
      markSeen: function(date) {
        try { localStorage.setItem(seenKey, String(date || '')); } catch (e) {}
      }
    };
  }

  function cardTopics(card) {
    return Array.from(card.querySelectorAll('[data-watch-topic]')).map(function(btn) {
      return btn.dataset.watchTopic;
    });
  }

  function initReadingProgress() {
    const progressBar = document.getElementById('readingProgress');
    if (!progressBar) return;
    window.addEventListener('scroll', function() {
      const h = document.documentElement;
      const total = h.scrollHeight - h.clientHeight;
      const progress = total > 0 ? (window.scrollY / total) * 100 : 0;
      progressBar.style.width = Math.min(100, Math.max(0, progress)) + '%';
    }, { passive: true });
  }

  function initHeaderMenu() {
    const button = document.getElementById('dailyMenuButton');
    const panel = document.getElementById('dailyMenuPanel');
    if (!button || !panel) return;

    function closeMenu(returnFocus) {
      if (panel.hidden) return;
      panel.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      button.setAttribute('aria-label', 'メニューを開く');
      if (returnFocus) button.focus();
    }

    button.addEventListener('click', function() {
      const opening = panel.hidden;
      panel.hidden = !opening;
      button.setAttribute('aria-expanded', opening ? 'true' : 'false');
      button.setAttribute('aria-label', opening ? 'メニューを閉じる' : 'メニューを開く');
      if (opening) {
        const firstLink = panel.querySelector('a');
        if (firstLink) firstLink.focus();
      }
    });
    panel.addEventListener('click', function(e) {
      if (e.target.closest('a')) closeMenu(false);
    });
    document.addEventListener('click', function(e) {
      if (!panel.hidden && !e.target.closest('.header-menu')) closeMenu(false);
    });
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && !panel.hidden) closeMenu(true);
    });
  }

  function initViewMode() {
    const btn = document.getElementById('viewModeToggle');
    const container = document.getElementById('articlesList');
    if (!btn || !container) return;
    const storageKey = 'daily_view_mode';
    let mode = 'detail';
    try { mode = localStorage.getItem(storageKey) || 'detail'; } catch (e) {}

    function apply(nextMode) {
      mode = nextMode;
      const compact = mode === 'compact';
      container.classList.toggle('compact-view', compact);
      container.classList.toggle('detail-view', !compact);
      btn.dataset.currentMode = mode;
      btn.setAttribute('aria-pressed', compact ? 'true' : 'false');
      try { localStorage.setItem(storageKey, mode); } catch (e) {}
    }
    apply(mode);
    btn.addEventListener('click', function() { apply(mode === 'detail' ? 'compact' : 'detail'); });
  }

  function initIssueFilters(watch) {
    const chips = Array.from(document.querySelectorAll('.filter-chip'));
    const cards = Array.from(document.querySelectorAll('.news-card'));
    if (!chips.length || !cards.length) return;

    const resetBtn = document.getElementById('filterResetBtn');
    const countEl = document.getElementById('visibleArticlesCount');
    const noResultsEl = document.getElementById('noResultsMsg');
    const watchChip = document.getElementById('watchFilterChip');
    const banner = document.getElementById('watchBanner');
    const bannerCount = document.getElementById('watchBannerCount');
    const state = { region: '', category: '', lane: '', watch: '' };
    const topicsByCard = new Map();
    cards.forEach(function(card) { topicsByCard.set(card, cardTopics(card)); });
    let scrollActiveChipIntoView = false;

    function watchedCardCount() {
      return cards.reduce(function(total, card) {
        return total + (watch.matches(topicsByCard.get(card)) ? 1 : 0);
      }, 0);
    }

    function refreshWatchUi() {
      const matched = watchedCardCount();
      if (watchChip) {
        watchChip.hidden = watch.size() === 0;
        const chipCount = watchChip.querySelector('.chip-count');
        if (chipCount) chipCount.textContent = String(matched);
      }
      if (banner) {
        banner.hidden = !(watch.size() > 0 && matched > 0 && !state.watch);
        if (bannerCount) bannerCount.textContent = String(matched);
      }
    }

    function updateLaneVisibility() {
      document.querySelectorAll('[data-lane-group]').forEach(function(group) {
        const hasVisible = Array.from(group.querySelectorAll('.news-card')).some(function(card) {
          return !card.classList.contains('is-hidden');
        });
        group.classList.toggle('is-empty', !hasVisible);
      });
    }

    function applyFilter(type, value) {
      if (type === 'all') {
        state.region = '';
        state.category = '';
        state.lane = '';
        state.watch = '';
      } else if (Object.prototype.hasOwnProperty.call(state, type)) {
        state[type] = state[type] === value ? '' : value;
      }
      if (state.watch && !watch.size()) state.watch = '';

      let visible = 0;
      chips.forEach(function(chip) {
        const chipType = chip.dataset.filterType;
        const active = chipType === 'all'
          ? !state.region && !state.category && !state.lane && !state.watch
          : state[chipType] === chip.dataset.filterVal;
        chip.classList.toggle('active', active);
        chip.setAttribute('aria-pressed', active ? 'true' : 'false');
        if (active && scrollActiveChipIntoView && chipType !== 'all') {
          try { chip.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' }); } catch (e) {}
        }
      });

      cards.forEach(function(card) {
        const matches = (!state.region || card.dataset.region === state.region) &&
          (!state.category || card.dataset.category === state.category) &&
          (!state.lane || card.dataset.lane === state.lane) &&
          (!state.watch || watch.matches(topicsByCard.get(card)));
        card.classList.toggle('is-hidden', !matches);
        if (matches) visible += 1;
      });
      updateLaneVisibility();
      refreshWatchUi();

      if (countEl) countEl.textContent = String(visible);
      if (resetBtn) resetBtn.style.display = visible === cards.length && !state.region && !state.category && !state.lane && !state.watch ? 'none' : 'inline-flex';
      if (noResultsEl) noResultsEl.style.display = visible === 0 ? 'block' : 'none';

      try {
        const url = new URL(window.location.href);
        url.searchParams.delete('filter');
        Object.keys(state).forEach(function(key) {
          if (state[key]) url.searchParams.set(key, state[key]);
          else url.searchParams.delete(key);
        });
        window.history.replaceState({}, '', url);
      } catch (e) {}
    }

    chips.forEach(function(chip) {
      chip.addEventListener('click', function() { applyFilter(chip.dataset.filterType, chip.dataset.filterVal); });
    });
    document.querySelectorAll('[data-filter-trigger]').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.preventDefault();
        applyFilter(btn.dataset.filterTrigger, btn.dataset.filterVal);
        const target = document.getElementById('articlesSection');
        if (target) target.scrollIntoView({ behavior: 'smooth' });
      });
    });
    if (resetBtn) resetBtn.addEventListener('click', function() { applyFilter('all', ''); });

    const bannerApply = document.getElementById('watchBannerApply');
    if (bannerApply) {
      bannerApply.addEventListener('click', function() {
        applyFilter('watch', 'on');
        const target = document.getElementById('articlesSection');
        if (target) target.scrollIntoView({ behavior: 'smooth' });
      });
    }
    // ☆ の付け外しは件数も絞り込み結果も変えるので、現在の状態で描き直す。
    watch.onChange(function() { applyFilter('', ''); });

    try {
      const params = new URLSearchParams(window.location.search);
      const legacy = params.get('filter');
      if (legacy && legacy.indexOf(':') > 0) {
        const parts = legacy.split(':');
        if (Object.prototype.hasOwnProperty.call(state, parts[0])) state[parts[0]] = parts.slice(1).join(':');
      }
      Object.keys(state).forEach(function(key) { if (params.get(key)) state[key] = params.get(key); });
      applyFilter('', '');
    } catch (e) {}
    scrollActiveChipIntoView = true;
  }

  function shareDataForButton(btn) {
    const card = btn.closest('.news-card');
    const data = card ? card.dataset : btn.dataset;
    return {
      prefix: document.body.dataset.sharePrefix || '',
      title: data.shareTitle || document.title,
      takeaway: data.shareTakeaway || '',
      url: data.shareUrl || window.location.href
    };
  }

  function shareText(data) {
    return data.prefix + data.title +
      '\n💡 要点: ' + data.takeaway + '\n🔗 ' + data.url;
  }

  async function shareOrCopy(payload, fallbackText, btn, successMessage) {
    if (navigator.share) {
      try {
        await navigator.share(payload);
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    const ok = await copyText(fallbackText);
    flashButton(btn, ok ? successMessage : '共有できませんでした', ok);
  }

  function initSharing() {
    document.querySelectorAll('.share-copy-btn').forEach(function(btn) {
      btn.addEventListener('click', async function() {
        const ok = await copyText(shareText(shareDataForButton(btn)));
        flashButton(btn, ok ? 'コピー完了！' : 'コピーできませんでした', ok);
      });
    });

    document.querySelectorAll('.native-share-btn').forEach(function(btn) {
      btn.addEventListener('click', async function() {
        const data = shareDataForButton(btn);
        const payload = { title: data.title, text: data.takeaway, url: data.url };
        const fallbackText = data.title + '\n💡 要点: ' + data.takeaway + '\n🔗 ' + data.url;
        await shareOrCopy(payload, fallbackText, btn, '共有文をコピー');
      });
    });
  }

  function normalizeSearch(value) {
    return String(value || '').toLocaleLowerCase('ja').replace(/\s+/g, '');
  }

  function createSearchResult(record, href) {
    const article = document.createElement('article');
    article.className = 'archive-result-card';
    const meta = document.createElement('p');
    meta.className = 'archive-result-meta';
    const date = record.date ? record.date.slice(0, 4) + '.' + record.date.slice(4, 6) + '.' + record.date.slice(6, 8) : '';
    meta.textContent = [date, record.region === 'GLOBAL' ? '海外' : '国内', record.category, record.source_kind, record.source].filter(Boolean).join(' / ');
    const title = document.createElement('h3');
    const link = document.createElement('a');
    link.href = href;
    link.textContent = record.title;
    title.appendChild(link);
    const summary = document.createElement('p');
    summary.className = 'archive-result-summary';
    summary.textContent = record.summary || record.takeaway || '';
    const tags = document.createElement('p');
    tags.className = 'archive-result-tags';
    tags.textContent = (record.tags || []).map(function(tag) { return '#' + tag; }).join(' ');
    article.append(meta, title, summary, tags);
    return article;
  }

  // 横断検索とウォッチ新着の索引。号が増えても1ファイルが育たないよう年ごとに分けてある
  // （daily_engine.py の build_search_index）。search-index.json に最新の年の記事と年の一覧
  // （years、新しい順）、それより前の年は search-index-<年>.json。同じ版の年別ファイルを共有する。
  const indexFiles = new Map();
  const media = location.pathname.split('/')[2];
  let indexEpoch = 0;
  function resetIndexFiles() { indexEpoch++; indexFiles.clear(); }
  async function fetchIndexFile(name) {
    const response = await fetch(name, { cache: 'no-cache' });
    if (!response.ok) throw new Error('Index HTTP ' + response.status);
    const payload = await response.json();
    if (!payload || !Array.isArray(payload.records) || typeof payload.generation !== 'string' ||
        !/^[a-f0-9]{1,32}$/i.test(payload.generation)) throw new Error('Invalid index');
    return payload;
  }

  // all が true なら全部の年（横断検索）。false なら最新の年だけで、1月は前の年も足す
  // （ウォッチ新着。年が明けた直後に一覧が空にならないように）。読めなければ null。
  async function loadSearchIndex(all) {
    const epoch = indexEpoch;
    try {
      // head は読み込みごとに一度だけ取り、年の Promise は媒体・版・ファイル名で分ける。
      const head = await fetchIndexFile('search-index.json');
      const years = head.years;
      if (head.media !== media || !Array.isArray(years) || years.length > 100 ||
          years.some(function(year, i) { return typeof year !== 'string' || !/^[0-9]{4}$/.test(year) || Number(year) < 1 || (i && years[i - 1] <= year); }) ||
          (!years.length && head.records.length)) throw new Error('Invalid years');
      const latest = head.records.reduce(function(max, record) { return String(record.date || '') > max ? String(record.date) : max; }, '');
      const older = all ? years.slice(1) : (latest.slice(4, 6) === '01' ? years.slice(1, 2) : []);
      const parts = await Promise.all(older.map(function(year) {
        const name = 'search-index-' + year + '.json';
        const key = JSON.stringify([media, head.generation, name]);
        if (!indexFiles.has(key)) indexFiles.set(key, fetchIndexFile(name));
        return indexFiles.get(key);
      }));
      if (epoch !== indexEpoch || parts.some(function(part) { return part.media !== media || part.generation !== head.generation; })) throw new Error('Mixed index');
      const hrefs = new Set();
      const records = [head].concat(parts).flatMap(function(part, i) {
        return part.records.map(function(record) {
          // ①・候補も、その年の実在する日付・媒体・記事アンカーだけを使う。
          const match = record && typeof record.url === 'string' && /^([0-9]{8})\/#art-([1-9][0-9]*)$/.exec(record.url);
          if (!match || typeof record.title !== 'string' || match[1] !== record.date ||
              record.date.slice(0, 4) !== years[i] || !Number.isSafeInteger(Number(match[2])) || hrefs.has(record.url) ||
              !Array.isArray(record.tags) || record.tags.some(function(tag) { return typeof tag !== 'string'; })) throw new Error('Invalid record');
          const date = record.date.slice(0, 4) + '-' + record.date.slice(4, 6) + '-' + record.date.slice(6);
          const parsed = new Date(date + 'T00:00:00Z');
          if (isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new Error('Invalid date');
          hrefs.add(record.url);
          return record;
        });
      });
      return { records: records, generation: head.generation, complete: all };
    } catch (_) {
      // 混在・欠落の年も Promise ごと捨て、次の明示操作まで取り直さない。
      if (epoch === indexEpoch) resetIndexFiles();
      return null;
    }
  }

  function initArchiveSearch() {
    const form = document.getElementById('archiveSearchForm');
    if (!form) return null;
    const query = document.getElementById('archiveSearchInput');
    const category = document.getElementById('archiveCategoryFilter');
    const region = document.getElementById('archiveRegionFilter');
    const month = document.getElementById('archiveMonthFilter');
    const filterControls = [category, region, month];
    const status = document.getElementById('archiveSearchStatus');
    const results = document.getElementById('archiveSearchResults');
    const keywordHeading = document.getElementById('archiveKeywordTitle');
    const suggestions = document.getElementById('archiveSuggestions');
    const rankArea = document.getElementById('archiveRank');
    const rankStatus = document.getElementById('archiveRankStatus');
    const archiveRows = Array.from(document.querySelectorAll('[data-archive-month]'));
    const archiveEmpty = document.getElementById('archiveEmpty');
    const scope = media === 'nitoridaily' ? 'nitori' : 'retail';
    const recordText = new WeakMap();
    let snapshot = null, pending = null, attempted = false, indexNeedsRefresh = false;
    let serial = 0, shown = null, matched = [], active = -1;
    let composing = false, imeEnterHeld = false, rank = null;
    let lastTracked = null;
    const locale = function() { return document.documentElement.lang === 'en' ? 'en' : 'ja'; };
    const searchTexts = {
      en: {
        heading: 'Search results', keyword: 'Keyword matches', loading: 'Looking for related articles…',
        stale: 'Press Enter to also find related articles.', failed: 'Search could not finish. Please try again.',
        rateLimited: 'The search limit has been reached. Please try again later.',
        indexUpdating: 'The latest issue is being added. Please try again in a little while.',
        generationMismatch: 'The search index versions differ. The index will be refreshed on your next search.', partial: 'Some candidates could not be judged.',
        count: function(n) { return n + ' related articles found.'; },
        coverage: function(s) { return 'Of ' + s.total + ' articles in this scope, ' + s.candidates + ' candidates were selected by wording and recency; ' + s.judged + ' were judged.'; },
        noResults: function(s) { return s.candidates === s.total ? 'No related articles were found in this scope.' : 'Of ' + s.total + ' articles in this scope, ' + s.candidates + ' candidates were checked by wording and recency, but no related articles were found.'; },
        noKeyword: 'No keyword matches. Press Enter to find related articles.',
        noKeywordPlain: 'No keyword matches.',
        indexLoading: 'Loading the search index…', indexFailed: 'Search data could not be loaded. Search again to retry.',
        keywordCount: function(n) { return n + ' articles found' + (n > 100 ? ' (first 100 shown)' : '') + '.'; }
      },
      ja: {
        heading: '検索結果', keyword: 'キーワードに一致', loading: '意味の近い記事を探しています…',
        stale: 'Enter で、意味の近い記事も探します。', failed: '検索を完了できませんでした。もう一度お試しください。',
        rateLimited: '検索の利用上限に達しました。時間をおいてお試しください。',
        indexUpdating: '最新の号を反映しています。少したってからもう一度お試しください。',
        generationMismatch: '検索索引の版が異なります。次の検索で読み直します。', partial: '一部の候補の判定がそろいませんでした。',
        count: function(n) { return n + '件見つかりました。'; },
        coverage: function(s) { return '対象 ' + s.total + ' 件のうち、文字の近い記事と新しい記事 ' + s.candidates + ' 件を候補に選び、' + s.judged + ' 件を判定しました。'; },
        noResults: function(s) { return s.candidates === s.total ? 'この条件の記事には、意味の近いものは見つかりませんでした。' : '対象 ' + s.total + ' 件のうち、文字の近い記事と新しい記事 ' + s.candidates + ' 件を調べましたが、意味の近い記事は見つかりませんでした。'; },
        noKeyword: 'キーワードに一致する記事はありません。Enter で、意味の近い記事を探します。',
        noKeywordPlain: 'キーワードに一致する記事はありません。',
        indexLoading: '検索インデックスを読み込んでいます…', indexFailed: '検索データを読み込めませんでした。もう一度検索すると読み直します。',
        keywordCount: function(n) { return n + '件見つかりました' + (n > 100 ? '（先頭100件を表示）' : '') + '。'; }
      }
    };
    const texts = function() { return searchTexts[locale()]; };
    const labels = { texts: texts(), kinds: { daily: '記事' } };
    // 日刊本文は原文のまま。検索欄の案内は②に渡す言語に合わせる。
    const translations = [
      [document.getElementById('archiveSearchTitle'), 'Search articles'],
      [form.querySelector('label[for="archiveSearchInput"]'), 'Keywords, companies or products'],
      [category.previousElementSibling, 'Category'], [region.previousElementSibling, 'Region'], [month.previousElementSibling, 'Month'],
      [document.getElementById('archiveSearchInfoTitle'), 'Search and privacy'],
      [document.getElementById('archiveRankInfo').firstChild, 'When you search (Enter or the magnifier), your query and public article information are sent to the TypeSafe AI (Jev) API to find related articles. Nothing is sent while you type. Inputs are not used to train models. The retention period is not specified. Processing takes place on servers in the United States. '],
      [document.querySelector('#archiveRankInfo a'), 'TypeSafe AI privacy policy'],
      [document.getElementById('archiveRankInfo').nextElementSibling, 'Search terms are recorded in Google Analytics, with email addresses and phone numbers masked. Nothing is sent if analytics is turned off.'],
      [document.getElementById('archiveRankPrivacy'), 'Your IP address is recorded to limit usage. Queries and replies are not stored in the site database, operational logs or notifications.']
    ].concat(filterControls.map(function(control) { return [control.options[0], 'All']; }),
      [[region.options[1], 'Domestic'], [region.options[2], 'Overseas']]);
    const originalTexts = translations.map(function(pair) { return pair[0].textContent; });
    const originalPlaceholder = query.placeholder;
    function updateLabels() {
      const en = locale() === 'en';
      labels.texts = texts(); labels.kinds.daily = en ? 'Article' : '記事';
      translations.forEach(function(pair, i) { pair[0].textContent = en ? pair[1] : originalTexts[i]; });
      query.placeholder = en ? 'e.g. self-checkout, Aeon, storage' : originalPlaceholder;
      form.querySelector('button[type="submit"]').setAttribute('aria-label', en ? 'Search' : '検索');
      suggestions.setAttribute('aria-label', en ? 'Keyword matches' : 'キーワードに一致する記事');
      document.getElementById('archiveSearchInfoOpen').setAttribute('aria-label', en ? 'About search and privacy' : '検索とプライバシーについて');
      document.getElementById('archiveSearchInfoClose').setAttribute('aria-label', en ? 'Close' : '閉じる');
    }
    function condition() {
      const filters = {};
      filterControls.forEach(function(control) { if (control.value) filters[control.dataset.filter] = control.value; });
      return { query: cleanQuery(query.value), locale: locale(), filters: filters, generation: snapshot ? snapshot.generation : undefined };
    }
    function rankCondition() {
      if (composing) return null;
      const c = condition();
      return c.query.replace(/[<>]/g, '').trim() ? c : null;
    }
    function viewKey() { const c = condition(); return JSON.stringify([c.query, c.locale, c.filters]); }
    function href(record) { return '/job/' + media + '/' + record.url; }
    function filtered(c = condition()) {
      const q = normalizeSearch(c.query);
      return snapshot ? snapshot.records.filter(function(record) {
        return (!q || recordText.get(record).indexOf(q) !== -1) && (!c.filters.category || record.category === c.filters.category) &&
          (!c.filters.region || record.region === c.filters.region) && (!c.filters.month || String(record.date).slice(0, 6) === c.filters.month);
      }) : [];
    }
    function filterArchiveByMonth() {
      let visible = 0;
      archiveRows.forEach(function(row) { row.hidden = !!month.value && row.dataset.archiveMonth !== month.value; if (!row.hidden) visible++; });
      if (archiveEmpty) archiveEmpty.hidden = visible > 0;
    }
    function closeSuggestions() {
      suggestions.hidden = true; active = -1;
      query.setAttribute('aria-expanded', 'false'); query.removeAttribute('aria-activedescendant');
      form.classList.remove('no-keyword');
    }
    function setActive(index) {
      const options = Array.from(suggestions.querySelectorAll('[role="option"]'));
      active = index;
      options.forEach(function(option, i) { option.setAttribute('aria-selected', String(i === index)); });
      if (options[index]) { query.setAttribute('aria-activedescendant', options[index].id); options[index].scrollIntoView({ block: 'nearest' }); }
      else query.removeAttribute('aria-activedescendant');
    }
    function renderSuggestions() {
      const c = condition();
      if (shown !== null || document.activeElement !== query || !c.query) { closeSuggestions(); return; }
      suggestions.replaceChildren();
      const rows = filtered(c).slice(0, 6);
      rows.forEach(function(record, i) {
        const li = document.createElement('li'), a = document.createElement('a');
        li.id = 'archive-option-' + i; li.setAttribute('role', 'option'); li.setAttribute('aria-selected', 'false');
        a.href = href(record); a.textContent = record.title; a.tabIndex = -1;
        // フォーカスは入力欄に保ち、マウスでも候補を開ける。
        a.addEventListener('mousedown', function(e) { e.preventDefault(); });
        li.appendChild(a); suggestions.appendChild(li);
      });
      if (!rows.length) {
        const li = document.createElement('li');
        if (snapshot) li.textContent = rank && rank.disabled ? texts().noKeywordPlain : texts().noKeyword;
        else li.textContent = attempted && !pending ? texts().indexFailed : texts().indexLoading;
        li.setAttribute('role', 'presentation'); suggestions.appendChild(li);
      }
      suggestions.hidden = false; query.setAttribute('aria-expanded', 'true'); setActive(-1);
      form.classList.toggle('no-keyword', !!snapshot && !rows.length);
    }
    async function ensureIndex(retry) {
      if (retry && indexNeedsRefresh) {
        snapshot = null; indexNeedsRefresh = false;
        resetIndexFiles();
      }
      if (snapshot) return snapshot;
      if (pending) return pending;
      if (attempted && !retry) return null;
      attempted = true;
      pending = loadSearchIndex(true);
      const data = await pending;
      if (data) data.records.forEach(function(record) {
        recordText.set(record, normalizeSearch([record.title, record.summary, record.takeaway, record.source, record.category].concat(record.tags || []).join(' ')));
      });
      snapshot = data; pending = null;
      return data;
    }
    function drawKeyword() {
      const visible = shown === viewKey();
      keywordHeading.hidden = !visible; results.hidden = !visible; status.hidden = !visible;
      if (!visible) return;
      // ②が届いても同じ記事へフォーカスを戻す。別アンカーは重複としない。
      const focused = results.contains(document.activeElement) ? document.activeElement.closest('a') : null;
      const focusedHref = focused && focused.getAttribute('href');
      const duplicates = new Set(rank ? rank.hrefs() : []);
      results.replaceChildren();
      matched.slice(0, 100).filter(function(record) { return !duplicates.has(href(record)); }).forEach(function(record) {
        results.appendChild(createSearchResult(record, href(record)));
      });
      keywordHeading.textContent = texts().keyword;
      status.textContent = snapshot ? texts().keywordCount(matched.length) : texts().indexFailed;
      if (focusedHref) {
        const same = Array.from(document.querySelectorAll('#archiveSearchResults a, #archiveRankList a')).find(function(a) { return a.getAttribute('href') === focusedHref; });
        (same || query).focus({ preventScroll: true });
      }
    }
    // 計測を止めていれば送らずに false を返す
    function track(event, values) {
      try { if (localStorage.getItem('st-analytics') === 'off') return false; } catch (_) {}
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push(Object.assign({ event: event }, values));
      return true;
    }
    function trackSearch(value, count) {
      const term = analyticsTerm(value);
      if (term && term !== lastTracked && track('daily_search', { search_term: term, count: Math.min(count, 6) })) lastTracked = term;
    }
    function analyticsTerm(value) { return window.STSearchAnalytics ? window.STSearchAnalytics.term(value) : ''; }
    if (window.STSiteSearch) rank = window.STSiteSearch.rank({
      scope: scope, labels: labels,
      condition: rankCondition,
      keywordState: function() { return snapshot && shown === viewKey() ? 'known' : 'failed'; },
      keywordCount: function() { return matched.length; },
      elements: { section: document.getElementById('archiveRankResults'), heading: document.getElementById('archiveRankTitle'),
        list: document.getElementById('archiveRankList'), note: document.getElementById('archiveRankNote'), status: rankStatus },
      onRun: closeSuggestions,
      onSettle: function(result) {
        // 確定済みの①は保ち、次の検索で索引を取り直す。版の大小はハッシュから判断できない。
        if (snapshot && result.searched && result.searched.generation !== snapshot.generation) indexNeedsRefresh = true;
      },
      onState: function() {
        rankArea.hidden = shown !== viewKey() || rank.disabled;
        document.getElementById('archiveRankInfo').hidden = rank.disabled;
        document.getElementById('archiveRankPrivacy').hidden = rank.disabled;
        drawKeyword();
      },
      track: function(event, values) {
        if (event === 'rank_run') {
          const term = analyticsTerm(condition().query);
          if (term) values = Object.assign({}, values, { search_term: term });
        }
        track('daily_' + event, values);
      }
    });
    async function runKeywordSearch(explicit) {
      const mine = ++serial, key = viewKey();
      shown = key; closeSuggestions(); filterArchiveByMonth();
      if (!explicit && rank) rank.cancel();
      results.replaceChildren(); results.hidden = true; keywordHeading.hidden = true;
      status.hidden = false; status.textContent = texts().indexLoading;
      rankArea.hidden = !rank || rank.disabled;
      if (!explicit && rank && !rank.disabled) rankStatus.textContent = texts().stale;
      const data = await ensureIndex(true);
      if (mine !== serial || key !== viewKey()) return false;
      matched = data ? filtered() : [];
      drawKeyword();
      if (data) trackSearch(condition().query, matched.length);
      return true;
    }
    async function runExplicitSearch() {
      if (imeEnterHeld || !rankCondition()) return;
      if (await runKeywordSearch(true) && rank) rank.run();
    }
    function changed() {
      if (shown === viewKey()) return;
      resetSearch(false);
    }
    function resetSearch(force) {
      serial++; shown = null;
      if (rank) { if (force) rank.cancel(); else rank.invalidate(); }
      rankArea.hidden = true; drawKeyword(); renderSuggestions();
    }
    function enterKey(e) { return e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter'; }
    form.addEventListener('submit', function(e) { e.preventDefault(); runExplicitSearch(); });
    query.addEventListener('input', changed);
    query.addEventListener('focus', async function() { renderSuggestions(); await ensureIndex(false); renderSuggestions(); });
    query.addEventListener('blur', function() { setTimeout(closeSuggestions, 120); });
    query.addEventListener('compositionstart', function() { composing = true; });
    query.addEventListener('compositionend', function() { composing = false; changed(); });
    document.addEventListener('keydown', function(e) {
      if (!enterKey(e)) return;
      if (!form.contains(e.target)) return;
      if (composing || e.isComposing || e.keyCode === 229) { imeEnterHeld = true; return; }
      if (imeEnterHeld || e.repeat) { e.preventDefault(); e.stopPropagation(); }
    }, true);
    document.addEventListener('keyup', function(e) { if (enterKey(e)) imeEnterHeld = false; });
    window.addEventListener('blur', function() { imeEnterHeld = false; });
    query.addEventListener('keydown', function(e) {
      if (composing || e.isComposing || e.keyCode === 229 || imeEnterHeld || e.repeat) return;
      if (e.key === 'Escape') { e.preventDefault(); closeSuggestions(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (shown === viewKey()) {
          const first = document.querySelector('#archiveRankList a, #archiveSearchResults a');
          if (first && e.key === 'ArrowDown') first.focus();
          return;
        }
        if (suggestions.hidden) renderSuggestions();
        const count = suggestions.querySelectorAll('[role="option"]').length;
        if (count) setActive((active + (e.key === 'ArrowDown' ? 1 : active < 0 ? 0 : -1) + count) % count);
      } else if (e.key === 'Enter' && !suggestions.hidden && active >= 0) {
        e.preventDefault(); suggestions.querySelectorAll('[role="option"] a')[active].click();
      }
    });
    document.addEventListener('mousedown', function(e) { if (!form.querySelector('.archive-searchbox').contains(e.target)) closeSuggestions(); });
    filterControls.forEach(function(control) {
      control.addEventListener('change', function() { if (rank) rank.invalidate(); runKeywordSearch(false); });
    });
    const dialog = document.getElementById('archiveSearchInfo');
    const info = document.getElementById('archiveSearchInfoOpen');
    info.addEventListener('click', function() { dialog.showModal(); });
    document.getElementById('archiveSearchInfoClose').addEventListener('click', function() { dialog.close(); });
    dialog.addEventListener('click', function(e) { if (e.target === dialog) dialog.close(); });
    new MutationObserver(function() {
      updateLabels();
      resetSearch(true);
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    updateLabels();
    drawKeyword(); rankArea.hidden = true;
    return function searchFor(text) {
      query.value = cleanQuery(text); if (rank) rank.cancel(); runKeywordSearch(false);
      document.getElementById('archiveSearch').scrollIntoView({ behavior: 'smooth' });
    };
  }

  // 検索語の取り出し（受け取る側の検査は head の処理。ここでは送る前に制御文字を除いて200文字に収める）
  function cleanQuery(value) {
    return Array.from(String(value || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()).slice(0, 200).join('');
  }

  // URL の q は head の同期処理（daily_engine.py）だけが扱い、確かめた検索語を window.STDailyHandoff に置く。
  // ヘッダー検索とタグは、ポータルならその場で検索し、号のページならポータルの #q= へ移る（?q= を作らない）
  function initSearchHandoff(searchFor) {
    const header = document.querySelector('.header-search');
    if (header) {
      header.addEventListener('submit', function(e) {
        e.preventDefault();
        const input = header.querySelector('input[type="search"]');
        const text = cleanQuery(input && input.value);
        if (searchFor) {
          if (text) searchFor(text);
          else document.getElementById('archiveSearch').scrollIntoView({ behavior: 'smooth' });
          return;
        }
        const portal = new URL(header.getAttribute('action') || './', window.location.href);
        window.location.href = portal.href.split('#')[0] + (text ? '#q=' + encodeURIComponent(text) : '#archiveSearch');
      });
    }
    if (!searchFor) return;
    document.querySelectorAll('a.topic-tag[href^="#q="]').forEach(function(link) {
      link.addEventListener('click', function(e) {
        let text = '';
        try { text = cleanQuery(decodeURIComponent(link.getAttribute('href').slice(3))); } catch (err) { return; }
        if (!text) return;
        e.preventDefault();
        searchFor(text);
      });
    });
    function takeHandoff() {
      const text = typeof window.STDailyHandoff === 'string' ? window.STDailyHandoff : '';
      window.STDailyHandoff = null;
      if (text) searchFor(text);
    }
    window.addEventListener('st-daily-handoff', takeHandoff);
    takeHandoff();
  }

  function initTopicWatch(watch, searchFor) {
    function refresh() {
      const watched = watch.list();
      document.querySelectorAll('.topic-watch-btn').forEach(function(btn) {
        const active = watch.has(btn.dataset.watchTopic);
        btn.textContent = active ? '★' : '☆';
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      const container = document.getElementById('watchTopics');
      if (!container) return;
      container.replaceChildren();
      if (!watched.length) {
        const empty = document.createElement('span');
        empty.className = 'watch-empty';
        empty.textContent = '上の注目テーマや記事タグの ☆ からテーマを登録できます。';
        container.appendChild(empty);
        return;
      }
      watched.forEach(function(topic) {
        const item = document.createElement('span');
        item.className = 'watch-topic-item';

        const search = document.createElement('button');
        search.type = 'button';
        search.className = 'watch-topic-search';
        search.textContent = '★ ' + topic;
        search.title = 'このテーマで検索';
        search.addEventListener('click', function() {
          if (searchFor) searchFor(topic);
        });

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'watch-topic-remove';
        remove.textContent = '×';
        remove.title = 'ウォッチを解除';
        remove.setAttribute('aria-label', topic + ' のウォッチを解除');
        remove.addEventListener('click', function() { watch.toggle(topic); });

        item.append(search, remove);
        container.appendChild(item);
      });
    }
    document.querySelectorAll('.topic-watch-btn').forEach(function(btn) {
      btn.addEventListener('click', function() { watch.toggle(btn.dataset.watchTopic); });
    });
    watch.onChange(refresh);
    refresh();
  }

  function initWatchFeed(watch) {
    const container = document.getElementById('watchFeed');
    const statusEl = document.getElementById('watchFeedStatus');
    const listEl = document.getElementById('watchFeedList');
    const seenBtn = document.getElementById('watchFeedSeen');
    if (!container || !statusEl || !listEl) return;
    const MAX_ROWS = 8;
    let records = null;
    let latestDate = '';

    function formatDate(value) {
      const date = String(value || '');
      return date.length === 8 ? date.slice(0, 4) + '.' + date.slice(4, 6) + '.' + date.slice(6, 8) : date;
    }

    function createRow(record, seen) {
      const item = document.createElement('li');
      item.className = 'watch-feed-item';
      const isNew = String(record.date) > seen;
      if (isNew) {
        item.classList.add('is-new');
        const badge = document.createElement('span');
        badge.className = 'watch-feed-new';
        badge.textContent = 'NEW';
        item.appendChild(badge);
      }
      const link = document.createElement('a');
      link.href = record.url;
      link.textContent = record.title;
      const meta = document.createElement('p');
      meta.className = 'watch-feed-meta';
      const hits = (record.tags || []).filter(function(tag) { return watch.has(tag); });
      meta.textContent = [formatDate(record.date)].concat(hits.map(function(tag) { return '#' + tag; })).join(' / ');
      item.append(link, meta);
      return item;
    }

    function render() {
      if (!records) return;
      if (!watch.size()) {
        container.hidden = true;
        return;
      }
      container.hidden = false;
      const matched = records
        .filter(function(record) { return watch.matches(record.tags || []); })
        .sort(function(a, b) { return String(b.date).localeCompare(String(a.date)); });
      const seen = watch.seen();
      const fresh = matched.filter(function(record) { return String(record.date) > seen; });

      if (fresh.length) statusEl.textContent = 'ウォッチ中のテーマに新着 ' + fresh.length + '件';
      else if (matched.length) statusEl.textContent = 'ウォッチ中のテーマの記事 ' + matched.length + '件（新着なし）';
      else statusEl.textContent = 'ウォッチ中のテーマに一致する記事はまだありません。';

      if (seenBtn) seenBtn.hidden = fresh.length === 0;
      listEl.replaceChildren();
      matched.slice(0, MAX_ROWS).forEach(function(record) { listEl.appendChild(createRow(record, seen)); });
    }

    if (seenBtn) {
      seenBtn.addEventListener('click', function() {
        watch.markSeen(latestDate);
        render();
      });
    }
    watch.onChange(render);
    loadSearchIndex(false).then(function(loaded) {
      // 読めなかったときは「新着なし」と見せない（横断検索と同じ。次にページを開いたときに読み直す）
      if (!loaded) {
        if (watch.size()) {
          container.hidden = false;
          statusEl.textContent = 'ウォッチ中のテーマの新着を読み込めませんでした。';
          listEl.replaceChildren();
          if (seenBtn) seenBtn.hidden = true;
        }
        return;
      }
      records = loaded.records;
      latestDate = records.reduce(function(max, record) {
        const date = String(record.date || '');
        return date > max ? date : max;
      }, '');
      // 初回は基準日を黙って記録する。登録直後の過去記事まで NEW 扱いにしないため。
      if (!watch.seen() && latestDate) watch.markSeen(latestDate);
      render();
    });
  }

  function initRssCopy() {
    document.querySelectorAll('[data-rss-copy]').forEach(function(btn) {
      btn.addEventListener('click', async function() {
        const ok = await copyText(btn.dataset.rssCopy || '');
        flashButton(btn, ok ? 'RSS URLをコピーしました' : 'コピーできませんでした', ok);
      });
    });
  }

  function initBackToTop() {
    const btn = document.getElementById('btnTop');
    if (!btn) return;
    window.addEventListener('scroll', function() { btn.classList.toggle('visible', window.scrollY > 300); }, { passive: true });
    btn.addEventListener('click', function(e) { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
  }

  function initDailyUI() {
    const watch = createWatchStore();
    initHeaderMenu();
    initReadingProgress();
    initViewMode();
    initIssueFilters(watch);
    initSharing();
    const searchFor = initArchiveSearch();
    initSearchHandoff(searchFor);
    initTopicWatch(watch, searchFor);
    initWatchFeed(watch);
    initRssCopy();
    initBackToTop();
    if (typeof DonationWidget !== 'undefined') {
      const container = document.getElementById('donation-button-container');
      if (container) new DonationWidget({ containerId: 'donation-button-container' }).init();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initDailyUI);
  else initDailyUI();
})();
