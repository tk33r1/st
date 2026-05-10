(function() {
  const script = document.currentScript || document.querySelector('script[data-article-id]');
  const ARTICLE_ID = script ? script.dataset.articleId : 'unknown';
  const API_URL = '/glitch/api/comments/' + ARTICLE_ID;

  // Footer year
  document.getElementById('footerYear').textContent = new Date().getFullYear();

  // Reading progress bar
  const progressBar = document.getElementById('progressBar');
  let ticking = false;
  window.addEventListener('scroll', () => {
    if (!ticking) {
      window.requestAnimationFrame(() => {
        const scrollTop = window.scrollY;
        const docHeight = document.documentElement.scrollHeight - window.innerHeight;
        const pct = docHeight > 0 ? (scrollTop / docHeight) * 100 : 0;
        progressBar.style.width = pct + '%';
        ticking = false;
      });
      ticking = true;
    }
  });

  // Copy code block
  window.copyCode = function(btn) {
    const pre = btn.closest('.code-block').querySelector('pre');
    navigator.clipboard.writeText(pre.innerText).then(() => {
      btn.textContent = 'copied!';
      setTimeout(() => btn.textContent = 'copy', 1800);
    });
  };

  // Copy URL
  window.copyUrl = function(btn) {
    navigator.clipboard.writeText(window.location.href).then(() => {
      btn.textContent = '✓ コピーしました';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = '🔗 URLをコピー';
        btn.classList.remove('copied');
      }, 2000);
    });
  };

  // --- Comments ---

  function renderComments(comments) {
    const list = document.getElementById('commentList');
    list.querySelectorAll('.comment-item.user-added').forEach(el => el.remove());
    comments.forEach(c => {
      const date = c.created_at ? c.created_at.split(' ')[0].replace(/-/g, '.') : '';

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

  async function loadComments() {
    try {
      const res = await fetch(API_URL);
      const data = await res.json();
      if (Array.isArray(data)) renderComments(data);
    } catch (e) {
      console.error('Failed to load comments:', e);
    }
  }

  window.submitComment = async function(e) {
    e.preventDefault();
    const handle = document.getElementById('commentHandle').value.trim() || 'anon';
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
      if (Array.isArray(data)) renderComments(data);
      document.getElementById('commentHandle').value = '';
      document.getElementById('commentText').value = '';
      btn.textContent = '送信しました ✓';
      setTimeout(() => { btn.textContent = origText; btn.disabled = false; }, 2000);
    } catch (e) {
      console.error('Failed to submit comment:', e);
      btn.textContent = '送信失敗 — 再試行';
      btn.disabled = false;
      setTimeout(() => { btn.textContent = origText; }, 3000);
    }
  };

  loadComments();
})();
