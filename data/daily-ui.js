/**
 * Daily Brief 共通 UI インタラクション (data/daily-ui.js)
 * 依存ゼロ・Vanilla JS / 完全自給自足型
 */
(function() {
  'use strict';

  function initDailyUI() {
    // 1. 読了プログレスバー
    const progressBar = document.getElementById('readingProgress');
    if (progressBar) {
      window.addEventListener('scroll', function() {
        const h = document.documentElement;
        const total = h.scrollHeight - h.clientHeight;
        const progress = total > 0 ? (window.scrollY / total) * 100 : 0;
        progressBar.style.width = Math.min(100, Math.max(0, progress)) + '%';
      }, { passive: true });
    }

    // 2. 表示モード切替（詳細 ⇄ 3行コンパクト）
    const viewToggleBtn = document.getElementById('viewModeToggle');
    const articlesContainer = document.getElementById('articlesList');
    if (viewToggleBtn && articlesContainer) {
      const STORAGE_KEY = 'daily_view_mode';
      let currentMode = 'detail';
      try {
        currentMode = localStorage.getItem(STORAGE_KEY) || 'detail';
      } catch (e) {}

      function applyViewMode(mode) {
        currentMode = mode;
        const isCompact = mode === 'compact';
        articlesContainer.classList.toggle('compact-view', isCompact);
        articlesContainer.classList.toggle('detail-view', !isCompact);
        viewToggleBtn.setAttribute('data-current-mode', mode);
        viewToggleBtn.setAttribute('aria-pressed', isCompact ? 'true' : 'false');
        try {
          localStorage.setItem(STORAGE_KEY, mode);
        } catch (e) {}
      }

      applyViewMode(currentMode);

      viewToggleBtn.addEventListener('click', function() {
        applyViewMode(currentMode === 'detail' ? 'compact' : 'detail');
      });
    }

    // 3. 種別・地域・カテゴリ絞り込みフィルター
    const chips = document.querySelectorAll('.filter-chip');
    const cards = document.querySelectorAll('.news-card');
    const resetBtn = document.getElementById('filterResetBtn');
    const countEl = document.getElementById('visibleArticlesCount');
    const noResultsEl = document.getElementById('noResultsMsg');
    let scrollActiveChipIntoView = false;

    function applyFilter(type, val) {
      let visibleCount = 0;
      chips.forEach(function(c) {
        const cType = c.getAttribute('data-filter-type');
        const cVal = c.getAttribute('data-filter-val');
        const isActive = (type === 'all' && cType === 'all') || (cType === type && cVal === val);
        c.classList.toggle('active', isActive);
        c.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        if (isActive && scrollActiveChipIntoView && typeof c.scrollIntoView === 'function') {
          try {
            c.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
          } catch (e) {}
        }
      });

      cards.forEach(function(card) {
        let matched = false;
        if (type === 'all') {
          matched = true;
        } else if (type === 'region') {
          matched = card.getAttribute('data-region') === val;
        } else if (type === 'category') {
          matched = card.getAttribute('data-category') === val;
        }
        card.classList.toggle('is-hidden', !matched);
        if (matched) visibleCount++;
      });

      if (countEl) countEl.textContent = visibleCount;
      if (resetBtn) resetBtn.style.display = (type === 'all') ? 'none' : 'inline-flex';
      if (noResultsEl) noResultsEl.style.display = (visibleCount === 0) ? 'block' : 'none';

      try {
        const url = new URL(window.location);
        if (type === 'all') {
          url.searchParams.delete('filter');
        } else {
          url.searchParams.set('filter', type + ':' + val);
        }
        window.history.replaceState({}, '', url);
      } catch (e) {}
    }

    if (chips.length > 0) {
      chips.forEach(function(chip) {
        chip.addEventListener('click', function() {
          const type = chip.getAttribute('data-filter-type');
          const val = chip.getAttribute('data-filter-val');
          if (chip.classList.contains('active') && type !== 'all') {
            applyFilter('all', '');
          } else {
            applyFilter(type, val);
          }
        });
      });

      // カード内バッジクリック連動
      document.querySelectorAll('[data-filter-trigger]').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.preventDefault();
          const type = btn.getAttribute('data-filter-trigger');
          const val = btn.getAttribute('data-filter-val');
          applyFilter(type, val);
          const targetSec = document.getElementById('articlesSection');
          if (targetSec) targetSec.scrollIntoView({ behavior: 'smooth' });
        });
      });

      if (resetBtn) {
        resetBtn.addEventListener('click', function() {
          applyFilter('all', '');
        });
      }

      // 初回 URL パラメータ復元
      try {
        const params = new URLSearchParams(window.location.search);
        const f = params.get('filter');
        const sep = f ? f.indexOf(':') : -1;
        if (sep > 0) {
          const type = f.slice(0, sep);
          const val = f.slice(sep + 1);
          const known = Array.from(chips).some(function(chip) {
            return chip.getAttribute('data-filter-type') === type && chip.getAttribute('data-filter-val') === val;
          });
          if (known) applyFilter(type, val);
        }
      } catch (e) {}
      scrollActiveChipIntoView = true;
    }

    // 4. 社内共有コピーボタン（Slack / Teams用）
    const CHECK_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2.5" fill="none"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    document.querySelectorAll('.share-copy-btn').forEach(function(btn) {
      const originalHtml = btn.innerHTML;
      let restoreTimer = null;

      function flash(message, ok) {
        if (restoreTimer) clearTimeout(restoreTimer);
        btn.classList.toggle('copied', ok);
        btn.innerHTML = (ok ? CHECK_ICON : '') + '<span>' + message + '</span>';
        restoreTimer = setTimeout(function() {
          btn.classList.remove('copied');
          btn.innerHTML = originalHtml;
          restoreTimer = null;
        }, 2000);
      }

      btn.addEventListener('click', async function() {
        const title = btn.getAttribute('data-share-title');
        const takeaway = btn.getAttribute('data-share-takeaway');
        const url = btn.getAttribute('data-share-url');
        const prefix = btn.getAttribute('data-share-prefix') ||
          (url && url.includes('nitoridaily') ? '【ニトリ日刊速報】' : '【流通DX日刊速報】');
        const text = prefix + title + '\n💡 要点: ' + takeaway + '\n🔗 ' + url;

        let success = false;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          try {
            await navigator.clipboard.writeText(text);
            success = true;
          } catch (e) {}
        }

        if (!success) {
          try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            success = true;
          } catch (e) {}
        }

        flash(success ? 'コピー完了！' : 'コピーできませんでした', success);
      });
    });

    // 5. 最上部への追従アンカーリンク
    const btnTop = document.getElementById('btnTop');
    if (btnTop) {
      window.addEventListener('scroll', function() {
        if (window.scrollY > 300) {
          btnTop.classList.add('visible');
        } else {
          btnTop.classList.remove('visible');
        }
      }, { passive: true });

      btnTop.addEventListener('click', function(e) {
        e.preventDefault();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }

    // 6. 寄付ウィジェット初期化
    if (typeof DonationWidget !== 'undefined') {
      const donateContainer = document.getElementById('donation-button-container');
      if (donateContainer) {
        new DonationWidget({ containerId: 'donation-button-container' }).init();
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDailyUI);
  } else {
    initDailyUI();
  }
})();
