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

  function initIssueFilters() {
    const chips = Array.from(document.querySelectorAll('.filter-chip'));
    const cards = Array.from(document.querySelectorAll('.news-card'));
    if (!chips.length || !cards.length) return;

    const resetBtn = document.getElementById('filterResetBtn');
    const countEl = document.getElementById('visibleArticlesCount');
    const noResultsEl = document.getElementById('noResultsMsg');
    const state = { region: '', category: '', lane: '' };
    let scrollActiveChipIntoView = false;

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
      } else if (Object.prototype.hasOwnProperty.call(state, type)) {
        state[type] = state[type] === value ? '' : value;
      }

      let visible = 0;
      chips.forEach(function(chip) {
        const chipType = chip.dataset.filterType;
        const active = chipType === 'all'
          ? !state.region && !state.category && !state.lane
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
          (!state.lane || card.dataset.lane === state.lane);
        card.classList.toggle('is-hidden', !matches);
        if (matches) visible += 1;
      });
      updateLaneVisibility();

      if (countEl) countEl.textContent = String(visible);
      if (resetBtn) resetBtn.style.display = visible === cards.length && !state.region && !state.category && !state.lane ? 'none' : 'inline-flex';
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
        if (navigator.share) {
          try { await navigator.share(payload); return; } catch (e) { if (e && e.name === 'AbortError') return; }
        }
        const ok = await copyText(payload.title + '\n💡 要点: ' + payload.text + '\n🔗 ' + payload.url);
        flashButton(btn, ok ? '共有文をコピー' : '共有できませんでした', ok);
      });
    });

    const checks = Array.from(document.querySelectorAll('.share-select'));
    const bulkBar = document.getElementById('bulkShareBar');
    const bulkBtn = document.getElementById('shareSelectedBtn');
    const count = document.getElementById('selectedArticlesCount');
    if (!checks.length || !bulkBar || !bulkBtn) return;

    function selectedCards() {
      return checks.filter(function(check) { return check.checked; }).map(function(check) { return check.closest('.news-card'); });
    }
    function updateBulk() {
      const selected = selectedCards();
      count.textContent = String(selected.length);
      bulkBtn.disabled = selected.length === 0;
      bulkBar.classList.toggle('has-selection', selected.length > 0);
    }
    checks.forEach(function(check) { check.addEventListener('change', updateBulk); });
    bulkBtn.addEventListener('click', async function() {
      const selected = selectedCards();
      const prefix = bulkBtn.dataset.sharePrefix || '';
      const text = selected.map(function(card, index) {
        return (index + 1) + '. ' + card.dataset.shareTitle + '\n   💡 ' + card.dataset.shareTakeaway + '\n   ' + card.dataset.shareUrl;
      }).join('\n\n');
      const payload = { title: prefix.replace(/[【】]/g, '') + 'まとめ', text: text };
      if (navigator.share) {
        try { await navigator.share(payload); return; } catch (e) { if (e && e.name === 'AbortError') return; }
      }
      const ok = await copyText(prefix + '\n' + text);
      flashButton(bulkBtn, ok ? 'まとめをコピー完了' : '共有できませんでした', ok);
    });
    updateBulk();
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
      try {
        const response = await fetch('search-index.json', { cache: 'no-cache' });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const payload = await response.json();
        records = Array.isArray(payload.records) ? payload.records : [];
      } catch (e) {
        status.textContent = '検索データを読み込めませんでした。';
        records = [];
      }
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

  function initTopicWatch() {
    const media = document.body.dataset.dailyMedia || 'daily';
    const storageKey = 'daily_watch_topics:' + media;
    let watched = [];
    try { watched = JSON.parse(localStorage.getItem(storageKey) || '[]'); } catch (e) { watched = []; }
    if (!Array.isArray(watched)) watched = [];

    function save() {
      try { localStorage.setItem(storageKey, JSON.stringify(watched)); } catch (e) {}
    }
    function refresh() {
      document.querySelectorAll('.topic-watch-btn').forEach(function(btn) {
        const active = watched.indexOf(btn.dataset.watchTopic) !== -1;
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
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = '★ ' + topic;
        btn.addEventListener('click', function() {
          const input = document.getElementById('archiveSearchInput');
          const form = document.getElementById('archiveSearchForm');
          if (input && form) {
            input.value = topic;
            form.requestSubmit();
            document.getElementById('archiveSearch').scrollIntoView({ behavior: 'smooth' });
          }
        });
        container.appendChild(btn);
      });
    }
    document.querySelectorAll('.topic-watch-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        const topic = btn.dataset.watchTopic;
        const index = watched.indexOf(topic);
        if (index === -1) watched.push(topic); else watched.splice(index, 1);
        save();
        refresh();
      });
    });
    refresh();
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
    initHeaderMenu();
    initReadingProgress();
    initViewMode();
    initIssueFilters();
    initSharing();
    initArchiveSearch();
    initTopicWatch();
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
