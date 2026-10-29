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
    const state = { region: '', category: '', watch: '' };
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
        state.watch = '';
      } else if (Object.prototype.hasOwnProperty.call(state, type)) {
        state[type] = state[type] === value ? '' : value;
      }
      if (state.watch && !watch.size()) state.watch = '';

      let visible = 0;
      chips.forEach(function(chip) {
        const chipType = chip.dataset.filterType;
        const active = chipType === 'all'
          ? !state.region && !state.category && !state.watch
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
          (!state.watch || watch.matches(topicsByCard.get(card)));
        card.classList.toggle('is-hidden', !matches);
        if (matches) visible += 1;
      });
      updateLaneVisibility();
      refreshWatchUi();

      if (countEl) countEl.textContent = String(visible);
      if (resetBtn) resetBtn.style.display = visible === cards.length && !state.region && !state.category && !state.watch ? 'none' : 'inline-flex';
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
      // ?filter=種類:値 は以前の形（配布済みのリンクのために読む。いまは ?category= などを作る）
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

  // 見出し・要点はカードの中身から、URL は canonical とカードの id から組み立てる（同じ値を属性に重ねて持たない）
  function shareDataForButton(btn) {
    const card = btn.closest('.news-card');
    const text = function(selector) {
      const el = card && card.querySelector(selector);
      return el ? el.textContent.trim() : '';
    };
    const canonical = document.querySelector('link[rel="canonical"]');
    const page = (canonical ? canonical.href : window.location.href).split('#')[0];
    return {
      prefix: document.body.dataset.sharePrefix || '',
      title: text('.card-title') || document.title,
      takeaway: text('.takeaway-text'),
      url: card ? page + '#' + card.id : page
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

  const media = document.body.dataset.dailyMedia;
  function searchArticleDate(record) {
    return record.date.slice(0,4)+'-'+record.date.slice(4,6)+'-'+record.date.slice(6,8);
  }

  // watchIndex は initWatchFeed の受け口。ウォッチ新着は横断検索が読んだ索引をそのまま使う（別に取りに行かない）。
  function initArchiveSearch(watchIndex) {
    const container = document.getElementById('archiveCommonSearch');
    if (!container || !window.STSearchUI || !window.STSearchData) return null;
    const locale = () => document.documentElement.lang === 'en' ? 'en' : 'ja';
    const scope = media === 'nitoridaily' ? 'nitori' : 'retail';
    const archiveRows = Array.from(document.querySelectorAll('[data-archive-month]'));
    const search = STSearchUI.mount(container, STSearchData.createAdapter(scope, {
      locale: locale(),input:document.querySelector('.header-search'),results:container,
      placeholder:{ja:'記事を検索',en:'Search articles'},filtersBeforeSearch:['month'],analyticsNotice:true,
      renderSuggestion:searchArticleDate,
      renderItem:renderSearchArticle,
      onData(records) { if (watchIndex) watchIndex.load(records); },
      onResults({open}) {
        const hint=document.getElementById('archiveSearchHint');if(hint) hint.hidden=open;
      },
      onConditions(condition) {
        let visible = 0;
        archiveRows.forEach(row => {
          row.hidden = !!condition.query || (!!condition.filters.month && row.dataset.archiveMonth !== condition.filters.month);
          if (!row.hidden) visible++;
        });
        const empty = document.getElementById('archiveEmpty');
        if (empty) empty.hidden = !!condition.query || visible > 0;
      },
      track(event, values) {
        try { if (localStorage.getItem('st-analytics') === 'off') return; } catch (_) {}
        if (event === 'rank_run') {
          const term = window.STSearchAnalytics ? STSearchAnalytics.term(search.state.query) : '';
          if (term) values = Object.assign({}, values, { search_term: term });
        }
        window.dataLayer = window.dataLayer || [];
        window.dataLayer.push(Object.assign({ event: 'daily_' + event }, values));
      }
    }));
    const info=document.getElementById('archiveSearchInfoOpen');
    info?.addEventListener('click',()=>search.openPrivacy(info));
    document.getElementById('archiveSearchHint')?.addEventListener('click',()=>search.focus());
    document.querySelector('.header-search')._stSearch=search;
    if (watchIndex) search.ready.then(function() { if (search.state.base === 'failed') watchIndex.fail(); });
    new MutationObserver(() => search.setLocale(locale())).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    // 号のページからの確定だけ、同じタブの一度きりの目印で明示操作として受け取る（書くのは initIssueSearch の onSubmit）。
    function explicitMarker(query) {
      try {
        const raw=sessionStorage.getItem('st-search-explicit');sessionStorage.removeItem('st-search-explicit');
        const marker=JSON.parse(raw),age=Date.now()-marker?.at;
        return marker?.scope===scope && marker.query===STJapaneseSearch.normalize(query).trim() && Number.isFinite(age) && age>=0 && age<=30000;
      } catch(_) {return false;}
    }
    return function searchFor(text,options) {
      const query=cleanQuery(text);
      search.setQuery(query,{explicit:!!options?.handoff && explicitMarker(query)});
      document.getElementById('archiveSearch').scrollIntoView({ behavior: 'smooth' });
    };
  }

  function renderSearchArticle(record,ctx) {
    const link=document.createElement('a');link.href=ctx.href;link.dataset.stPrimary='';link.className='archive-row';
    const date=document.createElement('time');date.className='archive-date';date.textContent=searchArticleDate(record);link.append(date);
    const body=document.createElement('span');body.className='archive-body';
    const title=document.createElement('span');title.className='archive-title';title.textContent=record.title;body.append(title);link.append(body);return link;
  }

  // 号のページは、欄に触れたときだけ共通検索と索引を読む。失敗時も従来の確定は使える。
  function initIssueSearch(header) {
    if(!header || document.getElementById('archiveCommonSearch')) return;
    // 読む資産と版は生成器（daily_engine.py の SEARCH_ASSETS）がヘッダーに書く。無い古いHTMLでは従来の確定だけを使う。
    const assets=(header.dataset.searchAssets || '').split(' ').filter(a=>/^[a-z-]+[.](?:js|css)[?]v=[0-9_]+$/.test(a));
    if(!assets.some(a=>a.startsWith('search-ui.js?'))) return;
    let started=false;
    async function load() {
      if(started) return;started=true;
      try {
        // 並べて取得し、JS は書いた順に実行する（async=false）。CSS も揃ってから取り付ける。
        await Promise.all(assets.map(file=>new Promise((resolve,reject)=>{
          const css=file.includes('.css?'),el=document.createElement(css?'link':'script');
          if(css) {el.rel='stylesheet';el.href='/assets/'+file;} else {el.async=false;el.src='/assets/'+file;}
          el.onload=resolve;el.onerror=reject;document.head.append(el);
        })));
        const scope=media==='nitoridaily'?'nitori':'retail',container=document.createElement('div');container.className='daily-header-search-runtime';header.after(container);
        const search=STSearchUI.mount(container,STSearchData.createAdapter(scope,{
          input:header,locale:document.documentElement.lang==='en'?'en':'ja',placeholder:{ja:'記事を検索',en:'Search articles'},analyticsNotice:true,
          renderSuggestion:searchArticleDate,
          onSubmit({query}) {
            const text=cleanQuery(query);
            if(text) {try {sessionStorage.setItem('st-search-explicit',JSON.stringify({scope,query:STJapaneseSearch.normalize(text).trim(),at:Date.now()}));}catch(_) {}}
            else {try {sessionStorage.removeItem('st-search-explicit');}catch(_) {}}
            goToPortal(header,text);
          }
        }));
        header._stSearch=search;
        new MutationObserver(()=>search.setLocale(document.documentElement.lang==='en'?'en':'ja')).observe(document.documentElement,{attributes:true,attributeFilter:['lang']});
      }catch(_) { /* 候補なしでポータルへ移る従来の動作を保つ。 */ }
    }
    const input=header.querySelector('input[type="search"]');input.addEventListener('focus',load,{once:true});input.addEventListener('input',load,{once:true});
    if(document.activeElement===input || input.value) load();
  }

  function goToPortal(header,text) {
    const portal=new URL(header.getAttribute('action') || './',location.href);
    location.href=portal.href.split('#')[0]+(text?'#q='+encodeURIComponent(text):'#archiveSearch');
  }

  // 検索語の取り出し（受け取る側の検査は head の処理。ここでは送る前に制御文字を除いて200文字に収める）
  function cleanQuery(value) {
    return Array.from(String(value || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()).slice(0, 200).join('');
  }

  // URL の q は head の同期処理（daily_engine.py）だけが扱い、確かめた検索語を window.STDailyHandoff に置く。
  // ヘッダー検索の IME と確定（号のページならポータルの #q= へ移る。?q= を作らない）は head の DAILY_EARLY_SEARCH_SCRIPT が受け持つ。
  // ポータルでは、そこで確定した語をここで受け取って検索する。タグも同じ。
  function initSearchHandoff(searchFor) {
    const header = document.querySelector('.header-search');
    if (header) {
      if (searchFor) {
        header._stSearchFor = function(text) {
          if (text) searchFor(text);
          else document.getElementById('archiveSearch').scrollIntoView({ behavior: 'smooth' });
        };
        if (typeof window.STDailyPendingSearch === 'string') {
          header._stSearchFor(window.STDailyPendingSearch); delete window.STDailyPendingSearch;
        }
      }
      initIssueSearch(header);
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
      if (text) searchFor(text,{handoff:true});
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
    if (!container || !statusEl || !listEl) return null;
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
      link.href = record.href;
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

    return {
      // 横断検索の全年の記事から、最新の年だけを使い、1月は前の年も足す（年が明けた直後に一覧が空にならないように）。
      load: function(all) {
        latestDate = all.reduce(function(max, record) { return record.date > max ? record.date : max; }, '');
        const years = Array.from(new Set(all.map(function(record) { return record.date.slice(0, 4); }))).sort().reverse();
        const keep = years.slice(0, latestDate.slice(4, 6) === '01' ? 2 : 1);
        records = all.filter(function(record) { return keep.indexOf(record.date.slice(0, 4)) !== -1; });
        // 初回は基準日を黙って記録する。登録直後の過去記事まで NEW 扱いにしないため。
        if (!watch.seen() && latestDate) watch.markSeen(latestDate);
        render();
      },
      // 読めなかったときは「新着なし」と見せない（次にページを開いたときに読み直す）
      fail: function() {
        if (records || !watch.size()) return;
        container.hidden = false;
        statusEl.textContent = 'ウォッチ中のテーマの新着を読み込めませんでした。';
        listEl.replaceChildren();
        if (seenBtn) seenBtn.hidden = true;
      }
    };
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
    const watchIndex = initWatchFeed(watch);
    const searchFor = initArchiveSearch(watchIndex);
    if (!searchFor && watchIndex) watchIndex.fail();
    initSearchHandoff(searchFor);
    initTopicWatch(watch, searchFor);
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
