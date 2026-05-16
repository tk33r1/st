/**
 * /glitch — 共通スクリプト
 *
 * 記事メタデータは /data/glitch.json に一元化されている。
 * このスクリプトは読み込まれたページの種類を判定して必要な処理を初期化する。
 *
 *   - 記事ページ（<script ... data-article-id="NNN">）
 *       progress bar / 記事ヘッダー描画 / コードコピー / シェア / コメント
 *   - インデックスページ（#articleGrid を含む）
 *       カード描画 / タグフィルタ / 検索 / ソート / 件数表示 / 招待コードコピー
 */
(function () {
  'use strict';

  // ─── データロード ───
  let _dataPromise = null;
  function loadData() {
    if (_dataPromise) return _dataPromise;
    _dataPromise = fetch('/data/glitch.json', { cache: 'no-cache' }).then((r) =>
      r.json()
    );
    return _dataPromise;
  }

  // ─── ユーティリティ ───
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function setFooterYear() {
    const el = document.getElementById('footerYear');
    if (el) el.textContent = new Date().getFullYear();
  }

  function formatDate(iso) {
    return iso ? iso.replace(/-/g, '.') : '';
  }

  // 指定スコープ配下の <img> がすべてロード（または失敗）した時点で resolve
  function whenImagesLoaded(scope) {
    const imgs = scope.querySelectorAll('img');
    if (imgs.length === 0) return Promise.resolve();
    return Promise.all(
      Array.from(imgs).map((img) => {
        if (img.complete) return Promise.resolve();
        return new Promise((resolve) => {
          img.addEventListener('load', resolve, { once: true });
          img.addEventListener('error', resolve, { once: true });
        });
      })
    );
  }

  function onWindowLoad(fn) {
    if (document.readyState === 'complete') fn();
    else window.addEventListener('load', fn, { once: true });
  }

  // ─── 記事ページ ───
  function initArticlePage(articleId) {
    initProgressBar();
    initCopyCode();
    initCopyUrl();

    loadData().then((data) => {
      const a = data.articles.find((x) => x.id === articleId);
      if (a) renderArticleHeader(a, data.author);
    });

    initComments(articleId);
  }

  function initProgressBar() {
    const progressBar = document.getElementById('progressBar');
    if (!progressBar) return;
    let ticking = false;
    window.addEventListener('scroll', () => {
      if (ticking) return;
      window.requestAnimationFrame(() => {
        const scrollTop = window.scrollY;
        const docHeight =
          document.documentElement.scrollHeight - window.innerHeight;
        const pct = docHeight > 0 ? (scrollTop / docHeight) * 100 : 0;
        progressBar.style.width = pct + '%';
        ticking = false;
      });
      ticking = true;
    });
  }

  // 記事のコードブロックコピーと、インデックスの招待コードコピーを兼ねるディスパッチャ。
  // ボタンが data-target を持っていれば招待コード、なければコードブロックとして扱う。
  function initCopyCode() {
    window.copyCode = function (btn) {
      if (btn.dataset && btn.dataset.target) {
        return copyReferralCode(btn);
      }
      const block = btn.closest('.code-block');
      if (!block) return;
      const pre = block.querySelector('pre');
      if (!pre) return;
      navigator.clipboard.writeText(pre.innerText).then(() => {
        btn.textContent = 'copied!';
        setTimeout(() => (btn.textContent = 'copy'), 1800);
      });
    };
  }

  function copyReferralCode(btn) {
    const codeEl = document.getElementById(btn.dataset.target);
    if (!codeEl) return;
    navigator.clipboard
      .writeText(codeEl.textContent)
      .then(() => {
        btn.textContent = 'copied!';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = 'copy';
          btn.classList.remove('copied');
        }, 2000);
      })
      .catch(() => {
        btn.textContent = 'error';
        setTimeout(() => (btn.textContent = 'copy'), 2000);
      });
  }

  function initCopyUrl() {
    window.copyUrl = function (btn) {
      navigator.clipboard.writeText(window.location.href).then(() => {
        btn.textContent = '✓ コピーしました';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = '🔗 URLをコピー';
          btn.classList.remove('copied');
        }, 2000);
      });
    };
  }

  function renderArticleHeader(a, author) {
    const breadcrumb = document.querySelector('.article-breadcrumb');
    if (breadcrumb) {
      breadcrumb.innerHTML = `<a href="../index.html">/glitch</a> <span>›</span> #${escapeHtml(
        a.id
      )}`;
    }

    const tagsEl = document.querySelector('.article-tags');
    if (tagsEl) {
      tagsEl.innerHTML = a.tags
        .map((t) => `<span class="article-tag">${escapeHtml(t)}</span>`)
        .join('');
    }

    const h1 = document.querySelector('.article-h1');
    if (h1) h1.innerHTML = a.titleHtml || escapeHtml(a.title);

    const metaRow = document.querySelector('.article-meta-row');
    if (metaRow) {
      const dateAttr = a.dateModified || a.datePublished;
      const isUpdated =
        a.dateModified && a.datePublished && a.dateModified !== a.datePublished;
      const dateLabel = (isUpdated ? '更新 ' : '') + formatDate(dateAttr);
      metaRow.innerHTML = `
        <span class="meta-item"><span class="dot">●</span> ${escapeHtml(author)}</span>
        <span class="meta-item"><time datetime="${escapeHtml(dateAttr)}">${escapeHtml(dateLabel)}</time></span>
        <span class="meta-item">⏱ ${escapeHtml(a.readTime)}</span>
      `;
    }

    const heroImg = document.querySelector('.article-hero-img img');
    if (heroImg) {
      heroImg.src = a.image;
      heroImg.alt = a.title;
    }
  }

  // ─── コメント ───
  function initComments(articleId) {
    const list = document.getElementById('commentList');
    if (!list) return;

    const API_URL = '/glitch/api/comments/' + articleId;

    function render(comments) {
      list
        .querySelectorAll('.comment-item.user-added')
        .forEach((el) => el.remove());
      comments.forEach((c) => {
        const date = c.created_at
          ? c.created_at.split(' ')[0].replace(/-/g, '.')
          : '';
        const div = document.createElement('div');
        div.className = 'comment-item user-added';
        div.setAttribute('data-id', c.id);
        const header = document.createElement('div');
        header.className = 'comment-header';
        const handle = document.createElement('span');
        handle.className = 'comment-handle';
        handle.textContent = c.handle;
        const dateEl = document.createElement('span');
        dateEl.className = 'comment-date';
        dateEl.textContent = date;
        const text = document.createElement('p');
        text.className = 'comment-text';
        text.textContent = c.text;
        header.appendChild(handle);
        header.appendChild(dateEl);
        div.appendChild(header);
        div.appendChild(text);
        list.appendChild(div);
      });
    }

    fetch(API_URL)
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d)) render(d);
      })
      .catch((e) => console.error('Failed to load comments:', e));

    window.submitComment = async function (e) {
      e.preventDefault();
      const handle =
        document.getElementById('commentHandle').value.trim() || 'anon';
      const text = document.getElementById('commentText').value.trim();
      if (!text) return;
      const btn = e.target.querySelector('.submit-btn');
      const origText = btn.textContent;
      btn.disabled = true;
      btn.textContent = '送信中...';
      try {
        const res = await fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ handle, text }),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (Array.isArray(data)) render(data);
        document.getElementById('commentHandle').value = '';
        document.getElementById('commentText').value = '';
        btn.textContent = '送信しました ✓';
        setTimeout(() => {
          btn.textContent = origText;
          btn.disabled = false;
        }, 2000);
      } catch (err) {
        console.error('Failed to submit comment:', err);
        btn.textContent = '送信失敗 — 再試行';
        btn.disabled = false;
        setTimeout(() => (btn.textContent = origText), 3000);
      }
    };
  }

  // ─── インデックスページ ───
  function initIndexPage() {
    const articleGrid = document.getElementById('articleGrid');
    if (!articleGrid) return;

    initCopyCode(); // 招待コードコピーも兼ねる

    loadData().then((data) => {
      renderArticleCards(data.articles);
      initIndexInteractions();
    });
  }

  function renderArticleCards(articles) {
    const articleGrid = document.getElementById('articleGrid');
    const noResults = document.getElementById('noResults');

    articles.forEach((a) => {
      const card = document.createElement('a');
      card.href = `${a.id}/index.html`;
      card.className = 'article-card' + (a.featured ? ' featured' : '');
      card.dataset.tags = a.tags.join(',');
      card.dataset.date = a.datePublished;

      const tagsHtml = a.tags
        .map((t) => `<span class="article-tag">${escapeHtml(t)}</span>`)
        .join('');
      const dateDisplay = formatDate(a.dateModified || a.datePublished);
      const featuredBadge = a.featured
        ? '<p class="featured-badge">// pinned</p>'
        : '';
      const excerpt =
        a.featured && a.excerpt
          ? `<p class="article-excerpt">${escapeHtml(a.excerpt)}</p>`
          : '';

      card.innerHTML = `
        <div class="article-thumb">
          <img decoding="async" src="${escapeHtml(a.image)}" alt="${escapeHtml(a.title)}">
        </div>
        <div class="article-body-wrap">
          <div>
            ${featuredBadge}
            <div class="article-meta">
              <span class="article-num">#${escapeHtml(a.id)}</span>
              ${tagsHtml}
              <span class="article-readtime">⏱ ${escapeHtml(a.readTime)}</span>
            </div>
            <h2 class="article-title">${escapeHtml(a.title)}</h2>
            ${excerpt}
          </div>
          <div class="article-footer-row">
            <span class="article-date">${escapeHtml(dateDisplay)}</span>
            <span class="article-arrow">→</span>
          </div>
        </div>
      `;

      articleGrid.insertBefore(card, noResults);
    });
  }

  function initIndexInteractions() {
    // タグを記事から動的生成
    const allCards = document.querySelectorAll('.article-card[data-tags]');
    const tagSet = new Set();
    allCards.forEach((card) => {
      (card.dataset.tags || '').split(',').forEach((t) => {
        const trimmed = t.trim();
        if (trimmed) tagSet.add(trimmed);
      });
    });
    const tagsBar = document.getElementById('tagsBar');
    tagSet.forEach((tagName) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tag';
      btn.dataset.tag = tagName;
      btn.textContent = tagName;
      btn.setAttribute('aria-pressed', 'false');
      tagsBar.appendChild(btn);
    });

    // フィルタ
    const tags = document.querySelectorAll('.tag');
    const cards = document.querySelectorAll('.article-card');
    const noResults = document.getElementById('noResults');
    let activeTag = 'all';

    function getSearchInput() {
      return (
        document.getElementById('searchInput') ||
        document.getElementById('menuSearchInput')
      );
    }

    function filterArticles() {
      const searchEl = getSearchInput();
      const query = (searchEl ? searchEl.value : '').toLowerCase();
      let visible = 0;
      cards.forEach((card) => {
        const cardTags = card.dataset.tags || '';
        const title =
          card.querySelector('.article-title')?.textContent.toLowerCase() ||
          '';
        const excerpt =
          card.querySelector('.article-excerpt')?.textContent.toLowerCase() ||
          '';
        const tagMatch = activeTag === 'all' || cardTags.includes(activeTag);
        const searchMatch =
          !query || title.includes(query) || excerpt.includes(query);
        if (tagMatch && searchMatch) {
          card.classList.remove('hidden');
          visible++;
        } else {
          card.classList.add('hidden');
        }
      });
      noResults.classList.toggle('visible', visible === 0);

      // 招待コード・おすすめ商品カード
      document.querySelectorAll('.referral-card').forEach((card) => {
        if (!query) {
          card.classList.remove('hidden');
        } else {
          const service =
            card.querySelector('.referral-service')?.textContent.toLowerCase() ||
            '';
          const benefit =
            card.querySelector('.referral-benefit')?.textContent.toLowerCase() ||
            '';
          const reason =
            card.querySelector('.referral-reason')?.textContent.toLowerCase() ||
            '';
          const match =
            service.includes(query) ||
            benefit.includes(query) ||
            reason.includes(query);
          card.classList.toggle('hidden', !match);
        }
      });

      document.querySelectorAll('.referral-category').forEach((cat) => {
        const hasVisible = cat.querySelector('.referral-card:not(.hidden)');
        cat.style.display = query && !hasVisible ? 'none' : '';
      });
    }

    tags.forEach((tag) => {
      tag.addEventListener('click', () => {
        tags.forEach((t) => {
          t.classList.remove('active');
          t.setAttribute('aria-pressed', 'false');
        });
        tag.classList.add('active');
        tag.setAttribute('aria-pressed', 'true');
        activeTag = tag.dataset.tag;
        filterArticles();
      });
    });

    function debounce(fn, delay) {
      let timer;
      return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
      };
    }
    const searchEl = getSearchInput();
    if (searchEl) {
      searchEl.addEventListener('input', debounce(filterArticles, 200));
    }

    const urlParams = new URLSearchParams(window.location.search);
    const initialQuery = urlParams.get('q');
    if (initialQuery && searchEl) {
      searchEl.value = initialQuery;
      filterArticles();
    }

    // ソート
    const articleGrid = document.getElementById('articleGrid');
    const sortSelect = document.getElementById('sortSelect');

    function sortArticles() {
      const order = sortSelect.value;
      const cardArray = Array.from(document.querySelectorAll('.article-card'));
      cardArray.sort((a, b) => {
        const pinnedA = a.classList.contains('featured') ? 0 : 1;
        const pinnedB = b.classList.contains('featured') ? 0 : 1;
        if (pinnedA !== pinnedB) return pinnedA - pinnedB;
        const dateA = a.dataset.date || '';
        const dateB = b.dataset.date || '';
        return order === 'new'
          ? dateB.localeCompare(dateA)
          : dateA.localeCompare(dateB);
      });
      cardArray.forEach((card) => articleGrid.insertBefore(card, noResults));
    }

    sortSelect.addEventListener('change', () => {
      sortArticles();
      fixThumbWidths();
    });
    sortArticles();

    // サムネ幅: 1200/630 比率を維持しつつ、カード高さに合わせて動的調整
    function fixThumbWidths() {
      const isMobile = window.innerWidth <= 600;
      document
        .querySelectorAll('.article-card:not(.featured)')
        .forEach((card) => {
          if (isMobile) {
            card.style.gridTemplateColumns = '';
          } else {
            const h = card.offsetHeight;
            const w = Math.round((h * 1200) / 630);
            card.style.gridTemplateColumns = w + 'px 1fr';
          }
        });
    }

    // 初回計算は画像ロード後に実施（offsetHeight が確定していないと幅が崩れる）
    whenImagesLoaded(articleGrid).then(fixThumbWidths);

    // モバイルでのスクロール時の URL バー出入りによる resize 発火を無視
    let lastResizeWidth = window.innerWidth;
    window.addEventListener('resize', () => {
      if (window.innerWidth === lastResizeWidth) return;
      lastResizeWidth = window.innerWidth;
      fixThumbWidths();
    });

    // カウント
    document.getElementById('articleCount').textContent =
      document.querySelectorAll('.article-card').length;
    document.getElementById('codeCount').textContent =
      document.querySelectorAll('.referral-card:not(.affiliate-card)').length;
    document.getElementById('recommendCount').textContent =
      document.querySelectorAll('.affiliate-card').length;

    // 新規タブで #hash 付き URL を開いた際のスクロール補正
    // 画像ロードによる高さ確定を待ってから位置計算（待たないと最終位置がずれる）
    if (window.location.hash) {
      onWindowLoad(() => {
        const el = document.querySelector(window.location.hash);
        if (el) {
          const y = el.getBoundingClientRect().top + window.scrollY - 56;
          window.scrollTo({ top: y, behavior: 'instant' });
        }
      });
    }
  }

  // ─── ハンバーガーメニュー ───
  function initMenu() {
    const isArticlePage = !!document.querySelector('script[data-article-id]');
    const basePath = isArticlePage ? '../' : '';

    if (!document.getElementById('menuToggle')) {
      const headerRight = document.querySelector('.header-right');
      if (!headerRight) return;
      headerRight.insertAdjacentHTML(
        'beforeend',
        '<button type="button" class="menu-toggle" id="menuToggle" aria-label="メニューを開く" aria-expanded="false" aria-controls="menuPanel">' +
          '<span class="menu-toggle-bar"></span>' +
          '<span class="menu-toggle-bar"></span>' +
          '<span class="menu-toggle-bar"></span>' +
          '</button>'
      );
      document.body.insertAdjacentHTML(
        'beforeend',
        '<div class="menu-overlay" id="menuOverlay" hidden></div>' +
          '<aside class="menu-panel" id="menuPanel" hidden aria-hidden="true" aria-label="メニュー">' +
          '<div class="menu-panel-header">' +
          '<span class="menu-panel-title">// menu</span>' +
          '<button type="button" class="menu-panel-close" id="menuPanelClose" aria-label="メニューを閉じる">×</button>' +
          '</div>' +
          '<div class="menu-panel-body">' +
          '<div class="menu-section">' +
          '<label for="menuSearchInput" class="menu-section-label"><span>//</span> 検索</label>' +
          '<div class="menu-search-wrap">' +
          '<span class="search-icon">⌕</span>' +
          '<input type="text" class="menu-search-input" id="menuSearchInput" placeholder="サイト内を検索..." autocomplete="off">' +
          '</div></div>' +
          '<div class="menu-section">' +
          '<span class="menu-section-label"><span>//</span> 記事</span>' +
          '<ul class="menu-link-list" id="menuArticleList"></ul>' +
          '</div>' +
          '<div class="menu-section">' +
          '<span class="menu-section-label"><span>//</span> 招待コード</span>' +
          '<ul class="menu-link-list">' +
          '<li><a href="' + basePath + 'index.html#referralSection" class="menu-link" data-menu-close><span class="menu-link-text">招待コード一覧へ</span></a></li>' +
          '</ul></div>' +
          '<div class="menu-section">' +
          '<span class="menu-section-label"><span>//</span> おすすめ商品</span>' +
          '<ul class="menu-link-list">' +
          '<li><a href="' + basePath + 'index.html#affiliateSection" class="menu-link" data-menu-close><span class="menu-link-text">おすすめ商品一覧へ</span></a></li>' +
          '</ul></div>' +
          '</div></aside>'
      );
    }

    const toggle = document.getElementById('menuToggle');
    const panel = document.getElementById('menuPanel');
    const overlay = document.getElementById('menuOverlay');
    const closeBtn = document.getElementById('menuPanelClose');
    const menuSearch = document.getElementById('menuSearchInput');
    const mainSearch = document.getElementById('searchInput');
    const articleList = document.getElementById('menuArticleList');
    if (!toggle || !panel || !overlay) return;

    function openMenu() {
      panel.hidden = false;
      overlay.hidden = false;
      requestAnimationFrame(() => {
        panel.classList.add('is-open');
        overlay.classList.add('is-open');
      });
      panel.setAttribute('aria-hidden', 'false');
      toggle.setAttribute('aria-expanded', 'true');
      toggle.setAttribute('aria-label', 'メニューを閉じる');
      document.body.classList.add('menu-open');
    }

    function closeMenu() {
      panel.classList.remove('is-open');
      overlay.classList.remove('is-open');
      panel.setAttribute('aria-hidden', 'true');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', 'メニューを開く');
      document.body.classList.remove('menu-open');
      setTimeout(() => {
        if (!panel.classList.contains('is-open')) {
          panel.hidden = true;
          overlay.hidden = true;
        }
      }, 260);
    }

    toggle.addEventListener('click', () => {
      if (toggle.getAttribute('aria-expanded') === 'true') closeMenu();
      else openMenu();
    });
    if (closeBtn) closeBtn.addEventListener('click', closeMenu);
    overlay.addEventListener('click', closeMenu);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') closeMenu();
    });
    panel.addEventListener('click', (e) => {
      const link = e.target.closest('a[href^="#"], a[data-menu-close]');
      if (link) closeMenu();
    });

    if (menuSearch && mainSearch) {
      menuSearch.addEventListener('input', () => {
        if (mainSearch.value === menuSearch.value) return;
        mainSearch.value = menuSearch.value;
        mainSearch.dispatchEvent(new Event('input', { bubbles: true }));
      });
      mainSearch.addEventListener('input', () => {
        if (menuSearch.value !== mainSearch.value) menuSearch.value = mainSearch.value;
      });
    } else if (menuSearch && isArticlePage) {
      menuSearch.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const q = menuSearch.value.trim();
        window.location.href = basePath + 'index.html' + (q ? '?q=' + encodeURIComponent(q) : '');
      });
    }

    if (articleList) {
      loadData()
        .then((data) => {
          if (!data || !data.articles) return;
          const sorted = data.articles
            .slice()
            .sort((a, b) => (b.datePublished || '').localeCompare(a.datePublished || ''));
          articleList.innerHTML = sorted
            .map(
              (a) =>
                '<li><a class="menu-link" href="' + basePath + escapeHtml(a.id) + '/index.html">' +
                '<span class="menu-link-num">#' + escapeHtml(a.id) + '</span>' +
                '<span class="menu-link-text">' + escapeHtml(a.title) + '</span>' +
                '</a></li>'
            )
            .join('');
        })
        .catch(() => {});
    }
  }

  function initHeaderAutoHide() {
    const header = document.querySelector('header');
    if (!header) return;
    const mql = window.matchMedia('(max-width: 600px)');
    const DELTA = 6;
    const TOP_LOCK = 80;
    let lastY = window.scrollY;
    let ticking = false;

    function update() {
      ticking = false;
      const body = document.body;
      if (!mql.matches) {
        body.classList.remove('header-hidden');
        lastY = window.scrollY;
        return;
      }
      const panel = document.getElementById('menuPanel');
      if (panel && panel.classList.contains('is-open')) {
        body.classList.remove('header-hidden');
        return;
      }
      const y = window.scrollY;
      const dy = y - lastY;
      if (Math.abs(dy) < DELTA) return;
      if (y < TOP_LOCK) {
        body.classList.remove('header-hidden');
      } else if (dy > 0) {
        body.classList.add('header-hidden');
      } else {
        body.classList.remove('header-hidden');
      }
      lastY = y;
    }

    window.addEventListener(
      'scroll',
      () => {
        if (ticking) return;
        window.requestAnimationFrame(update);
        ticking = true;
      },
      { passive: true }
    );

    const onMqlChange = () => {
      if (!mql.matches) document.body.classList.remove('header-hidden');
      lastY = window.scrollY;
    };
    if (mql.addEventListener) mql.addEventListener('change', onMqlChange);
    else if (mql.addListener) mql.addListener(onMqlChange);
  }

  // ─── Bootstrap ───
  function init() {
    setFooterYear();
    initMenu();
    initHeaderAutoHide();

    const script = document.querySelector('script[data-article-id]');
    const articleId = script ? script.dataset.articleId : null;

    if (articleId) {
      initArticlePage(articleId);
    } else if (document.getElementById('articleGrid')) {
      initIndexPage();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
