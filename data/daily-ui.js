/**
 * Daily Brief 共通 UI インタラクション (data/daily-ui.js)
 * 依存ゼロ・Vanilla JS / 完全自給自足型
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

  function shareTextForButton(btn) {
    return (btn.dataset.sharePrefix || '') + (btn.dataset.shareTitle || '') +
      '\n💡 要点: ' + (btn.dataset.shareTakeaway || '') + '\n🔗 ' + (btn.dataset.shareUrl || '');
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
        const ok = await copyText(shareTextForButton(btn));
        flashButton(btn, ok ? 'コピー完了！' : 'コピーできませんでした', ok);
      });
    });

    document.querySelectorAll('.native-share-btn').forEach(function(btn) {
      btn.addEventListener('click', async function() {
        const payload = { title: btn.dataset.shareTitle || document.title, text: btn.dataset.shareTakeaway || '', url: btn.dataset.shareUrl || window.location.href };
        const fallbackText = payload.title + '\n💡 要点: ' + payload.text + '\n🔗 ' + payload.url;
        await shareOrCopy(payload, fallbackText, btn, '共有文をコピー');
      });
    });
  }

  function normalizeSearch(value) {
    return String(value || '').toLocaleLowerCase('ja').replace(/\s+/g, '');
  }

  function createSearchResult(record) {
    const article = document.createElement('article');
    article.className = 'archive-result-card';
    const meta = document.createElement('p');
    meta.className = 'archive-result-meta';
    const date = record.date ? record.date.slice(0, 4) + '.' + record.date.slice(4, 6) + '.' + record.date.slice(6, 8) : '';
    meta.textContent = [date, record.region === 'GLOBAL' ? '海外' : '国内', record.category, record.source_kind, record.source].filter(Boolean).join(' / ');
    const title = document.createElement('h3');
    const link = document.createElement('a');
    link.href = record.url;
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

  // 横断検索とウォッチ新着が同じ search-index.json を読むので、取得は一度だけにする。
  let searchIndexPromise = null;
  function loadSearchIndex() {
    if (!searchIndexPromise) {
      searchIndexPromise = fetch('search-index.json', { cache: 'no-cache' })
        .then(function(response) {
          if (!response.ok) throw new Error('HTTP ' + response.status);
          return response.json();
        })
        .then(function(payload) { return Array.isArray(payload.records) ? payload.records : []; })
        .catch(function() { return null; });
    }
    return searchIndexPromise;
  }

  function initArchiveSearch() {
    const form = document.getElementById('archiveSearchForm');
    if (!form) return;
    const query = document.getElementById('archiveSearchInput');
    const category = document.getElementById('archiveCategoryFilter');
    const region = document.getElementById('archiveRegionFilter');
    const month = document.getElementById('archiveMonthFilter');
    const status = document.getElementById('archiveSearchStatus');
    const results = document.getElementById('archiveSearchResults');
    const archiveRows = Array.from(document.querySelectorAll('[data-archive-month]'));
    const archiveEmpty = document.getElementById('archiveEmpty');
    let records = null;

    function filterArchiveByMonth() {
      const selected = month.value;
      let visible = 0;
      archiveRows.forEach(function(row) {
        const show = !selected || row.dataset.archiveMonth === selected;
        row.hidden = !show;
        if (show) visible += 1;
      });
      if (archiveEmpty) archiveEmpty.hidden = visible > 0;
    }

    async function ensureIndex() {
      if (records) return records;
      status.textContent = '検索インデックスを読み込んでいます…';
      const loaded = await loadSearchIndex();
      if (!loaded) status.textContent = '検索データを読み込めませんでした。';
      records = loaded || [];
      return records;
    }

    async function runSearch(e) {
      if (e) e.preventDefault();
      filterArchiveByMonth();
      const data = await ensureIndex();
      const q = normalizeSearch(query.value);
      const matched = data.filter(function(record) {
        const haystack = normalizeSearch([record.title, record.summary, record.takeaway, record.source, record.category].concat(record.tags || []).join(' '));
        return (!q || haystack.indexOf(q) !== -1) &&
          (!category.value || record.category === category.value) &&
          (!region.value || record.region === region.value) &&
          (!month.value || String(record.date).slice(0, 6) === month.value);
      });
      results.replaceChildren();
      matched.slice(0, 100).forEach(function(record) { results.appendChild(createSearchResult(record)); });
      status.textContent = matched.length + '件見つかりました' + (matched.length > 100 ? '（先頭100件を表示）' : '') + '。';
      try {
        const url = new URL(window.location.href);
        if (query.value) url.searchParams.set('q', query.value); else url.searchParams.delete('q');
        window.history.replaceState({}, '', url);
      } catch (err) {}
    }

    form.addEventListener('submit', runSearch);
    [category, region, month].forEach(function(control) { control.addEventListener('change', runSearch); });
    try {
      const initial = new URLSearchParams(window.location.search).get('q');
      if (initial) { query.value = initial; runSearch(); }
    } catch (e) {}
  }

  function initTopicWatch(watch) {
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
        empty.textContent = '記事タグの ☆ からテーマを登録できます。';
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
          const input = document.getElementById('archiveSearchInput');
          const form = document.getElementById('archiveSearchForm');
          if (input && form) {
            input.value = topic;
            form.requestSubmit();
            document.getElementById('archiveSearch').scrollIntoView({ behavior: 'smooth' });
          }
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
    loadSearchIndex().then(function(loaded) {
      records = loaded || [];
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
    initArchiveSearch();
    initTopicWatch(watch);
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
