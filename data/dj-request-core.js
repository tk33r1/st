/* DJ リクエスト画面とブース画面で共有する、小さなブラウザ側ユーティリティ。 */
(function (global) {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

  // 秒を m:ss に。0 秒は 0:00 のまま出す（残り時間の表示用）
  function formatClock(sec) {
    const s = Math.max(0, Math.round(sec));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  // 曲の尺。値が無い曲は empty を返す
  function formatDurationMs(ms, empty = '') {
    const seconds = Math.round(Number(ms) / 1000);
    if (!Number.isFinite(seconds) || seconds <= 0) return empty;
    return formatClock(seconds);
  }

  /* D1 が入れる時刻は UTC の "YYYY-MM-DD HH:MM:SS"。文字列から切り出すと
     時差のぶんだけずれるので、必ず Date に通してから端末の時計で出す。 */
  function asDate(v) {
    const t = String(v || '').trim();
    if (!t) return null;
    const ms = Date.parse(/[Zz]$|[+-]\d{2}:?\d{2}$/.test(t) ? t : t.replace(' ', 'T') + 'Z');
    return Number.isFinite(ms) ? new Date(ms) : null;
  }
  const pad2 = (n) => String(n).padStart(2, '0');
  const hhmm = (v) => { const d = asDate(v); return d ? pad2(d.getHours()) + ':' + pad2(d.getMinutes()) : ''; };
  const ymd = (v) => { const d = asDate(v); return d ? d.getFullYear() + '.' + pad2(d.getMonth() + 1) + '.' + pad2(d.getDate()) : ''; };

  /* appleUrl は投稿時にブラウザから届く値。href や location に入れる前に、Apple Music の
     https URL であることを確かめる。それ以外（javascript: など）は空文字を返す。
     許すホストは Worker（workers/dj-request の URL_DOMAINS.apple）とそろえ、サブドメインも通す。
     そろっていないと、Worker が保存して返した URL のリンクがここで黙って消える。 */
  const APPLE_HOSTS = ['music.apple.com', 'itunes.apple.com'];
  function appleHref(url) {
    try {
      const u = new URL(String(url || ''));
      if (u.protocol !== 'https:' || u.username || u.password) return '';
      const h = u.hostname.toLowerCase();
      return APPLE_HOSTS.some((d) => h === d || h.endsWith('.' + d)) ? u.href : '';
    } catch { return ''; }
  }

  const bearer = (token) => (token ? { Authorization: 'Bearer ' + token } : {});

  /* json を渡すと Content-Type と body を組み立てる。
     ほかの fetch の指定（method / headers / signal）はそのまま通す。 */
  function createApi(base, networkMessage) {
    return async function apiJson(path, { json, ...options } = {}) {
      if (json !== undefined) {
        options.headers = { 'Content-Type': 'application/json', ...options.headers };
        options.body = JSON.stringify(json);
      }
      let response;
      try {
        response = await fetch(base + path, options);
      } catch {
        throw new Error(networkMessage);
      }

      let data = {};
      try { data = await response.json(); } catch { /* JSON でないエラー応答 */ }
      if (!response.ok) {
        const error = new Error(data.message || '通信に失敗しました');
        error.status = response.status;
        error.data = data;
        throw error;
      }
      return data;
    };
  }

  const storage = {
    getText(key, fallback = '') {
      try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
    },
    setText(key, value) {
      try { localStorage.setItem(key, String(value)); return true; } catch { return false; }
    },
    remove(key) {
      try { localStorage.removeItem(key); return true; } catch { return false; }
    },
    /* 形が既定値と違う値（壊れた "null" や、配列の場所にあるオブジェクト）は既定値に替える。
       呼び出し側は try を持たずに中身を触るので、ここで型までそろえて返す */
    getJSON(key, fallback) {
      try {
        const value = JSON.parse(localStorage.getItem(key));
        const sameShape = value !== null && typeof value === typeof fallback
          && Array.isArray(value) === Array.isArray(fallback);
        return sameShape ? value : fallback;
      } catch { return fallback; }
    },
    setJSON(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
    },
  };

  /* 30秒プレビューの再生器。鳴らせるのは常に1曲だけで、key はどの曲（どのプレイヤー）
     かを呼び出し側が決める。状態が変わるたびに onStateChange、再生中は interval ごとに
     onProgress を呼ぶ。 */
  function createPreviewController({ onStateChange, onProgress, interval = 200 } = {}) {
    let audio = null;
    let key = null;
    let url = '';
    let timer = null;

    const snapshot = () => {
      const duration = audio ? (audio.duration || 30) : 30;
      const currentTime = audio ? audio.currentTime : 0;
      return {
        active: !!audio,
        key,
        paused: !audio || audio.paused,
        progress: duration ? currentTime / duration : 0,
        remaining: Math.max(0, duration - currentTime),
      };
    };

    const emitState = () => { if (onStateChange) onStateChange(snapshot()); };
    const emitProgress = () => { if (onProgress) onProgress(snapshot()); };
    const stopTimer = () => { clearInterval(timer); timer = null; };

    // 頭出しまで戻す停止。別の曲に移るときと鳴り終わったときはこちら
    function stop(notify = true) {
      if (audio) {
        audio.pause();
        // 参照を捨てるだけだと裏で読み込みを続けるので、src を外して読み込みごと止める
        audio.removeAttribute('src');
        audio.load();
      }
      stopTimer();
      audio = null;
      key = null;
      url = '';
      if (notify) emitState();
    }

    // 読み込む前は duration が出ていないので、メタデータが来てから飛ばす
    function seek(ratio) {
      if (!audio) return;
      const target = audio;
      const apply = () => {
        if (audio !== target) return;
        const duration = target.duration || 30;
        target.currentTime = Math.max(0, Math.min(duration - 0.05, duration * ratio));
        emitProgress();
      };
      if (target.readyState > 0) apply();
      else target.addEventListener('loadedmetadata', apply, { once: true });
    }

    /* play() は呼んだ時点で paused を倒す。読み込みを待たずに描き直して、
       押した瞬間から「一時停止」の記号に変える（待つと「再開」に見える） */
    function resume() {
      if (!audio) return Promise.resolve();
      const target = audio;
      const playing = target.play();
      emitState();
      return playing.then(() => {
        if (audio !== target) return;
        stopTimer();
        timer = setInterval(emitProgress, interval);
      }).catch((error) => {
        if (audio !== target) return;
        // 読み込み中に一時停止された。止めたのは利用者なので、頭出しには戻さない
        if (error && error.name === 'AbortError' && target.paused) return;
        stop();
      });
    }

    function pause() {
      if (!audio) return;
      audio.pause();
      stopTimer();
      emitState();
    }

    function start(nextKey, nextUrl, ratio = 0) {
      stop(false);
      if (!nextUrl) { emitState(); return Promise.resolve(); }
      audio = new Audio(nextUrl);
      const target = audio;
      key = nextKey;
      url = nextUrl;
      target.addEventListener('ended', () => { if (audio === target) stop(); });
      if (ratio) seek(ratio);
      return resume();
    }

    // いま鳴らしている（あるいは一時停止している）のがこの key のこの曲か
    const holds = (wantedKey, wantedUrl) => !!audio && key === wantedKey && url === wantedUrl;

    // 同じ曲なら頭に戻さず、一時停止と再開を往復する
    function toggle(nextKey, nextUrl) {
      if (!holds(nextKey, nextUrl)) return start(nextKey, nextUrl);
      if (audio.paused) return resume();
      pause();
      return Promise.resolve();
    }

    // 止めている最中なら位置だけ動かして、止めたままにしておく
    function seekOrStart(nextKey, nextUrl, ratio) {
      if (holds(nextKey, nextUrl)) seek(ratio);
      else start(nextKey, nextUrl, ratio);
    }

    return { getState: snapshot, stop, toggle, seekOrStart };
  }

  global.DJRequestCore = {
    $, $$, appleHref, asDate, bearer, createApi, createPreviewController, escapeHTML, formatClock, formatDurationMs,
    hhmm, storage, ymd,
  };
})(window);
