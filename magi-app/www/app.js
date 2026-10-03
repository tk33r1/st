'use strict';
/*
 * MAGI mobile — standalone client extracted from tk.st/index.html
 * The AI lives entirely server-side; this app only renders the chat and
 * streams from the existing Cloudflare Worker backend.
 *
 * NOTE ON CORS: the backend must allow this app's origin. In a Capacitor
 * build the origin is capacitor://localhost (iOS) / http://localhost (Android);
 * for a hosted PWA it is your served origin. See README.md.
 */

// ---- Config -----------------------------------------------------------------
// Defaults to the production backend so the standalone app (served locally, as a
// hosted PWA, or inside a Capacitor shell) works out of the box. To point at a
// local `wrangler dev` worker, pass ?api=http://localhost:8787 or set
// window.MAGI_API_BASE before this script loads.
// 本番ページとネイティブアプリは接続先を固定する。
// ローカル HTTP サーバーでの開発時だけ、ループバックの Worker を指定できる。
var API_BASE = (function () {
  var production = 'https://workers.tk.st';
  if (!/^https?:$/.test(location.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
      || (window.Capacitor && window.Capacitor.isNativePlatform())) return production;
  var candidate = new URLSearchParams(location.search).get('api') || window.MAGI_API_BASE;
  if (!candidate) return production;
  try {
    var url = new URL(String(candidate));
    if (!/^https?:$/.test(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return production;
    return url.origin;
  } catch (_) { return production; }
})();
var AGENT_API = API_BASE + '/magi2/chat';
var REACT_API = API_BASE + '/magi2/react';
var AGENT_MAX_HISTORY = 12;

// Persona names (shown on the debate cards and the splash buttons). The descriptions (temperament, context,
// theme) and the LLM behind each persona are not written here: they come from the Worker's /magi2/models
// (source of truth: PERSONA_GUIDE in workers/magi2/personas.js, shared with tk.st), so they can change
// without an app release.
var AGENT_PERSONAS = [
  { codename: 'MELCHIOR-1', name: 'ENTHUSIAST' },
  { codename: 'BALTHASAR-2', name: 'HUMANIST' },
  { codename: 'CASPER-3', name: 'STRATEGIST' },
];
// The integrated persona that writes the final answer, shown next to the three on the splash.
var AGENT_SYNTH = { codename: 'Shinya Takeda', name: 'INTEGRATED', synth: true };
// Fetched once, the first time a persona is opened on the splash (retried on the next open if it fails).
// undefined = loading, null = unavailable.
var MODELS_API = API_BASE + '/magi2/models';
var PROVIDER_LABEL = { openai: 'OpenAI', deepseek: 'DeepSeek', google: 'Google' };
var agentModels;
var agentModelsPromise = null;
function loadAgentModels() {
  if (!agentModelsPromise) {
    agentModelsPromise = fetch(MODELS_API)
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) { agentModels = j; return j; })
      .catch(function () { agentModelsPromise = null; agentModels = null; return null; });
  }
  return agentModelsPromise;
}
function personaDescHTML(p) {
  var m = agentModels && (p.synth ? agentModels.synthesizer : agentModels.personas && agentModels.personas[p.codename]);
  var head = '<span class="magi-desc-name">' + esc(p.codename) + ' · ' + esc(p.name) + '</span>';
  if (!m) return head + esc(agentModels === undefined ? '…' : 'Could not load the description.');
  function text(o) { return esc(o && o.en ? o.en : ''); }
  return head + text(m.desc)
    + '<dl class="magi-desc-meta">'
    + '<dt>LLM</dt><dd>' + esc((PROVIDER_LABEL[m.provider] || m.provider) + ' · ' + m.model) + '</dd>'
    + '<dt>Context</dt><dd>' + text(m.context) + '</dd>'
    + '<dt>Theme</dt><dd>' + text(m.theme) + '</dd>'
    + '</dl>';
}
var REACT_EMOJIS = ['👎', '❤️', '😂', '🎉', '🔥', '👏', '🙏', '💯', '🤔', '👀', '😮', '😢', '😍', '🤯', '🙌', '🥳', '😎', '😅', '🤝', '💪', '✨', '💡', '✅', '🚀', '👌', '🫡', '🤩', '😇', '🥹', '🫶'];

// ---- DOM / state ------------------------------------------------------------
var agentLog = document.getElementById('agent-log');
var agentInput = document.getElementById('agent-input');
var agentSendBtn = document.getElementById('agent-send');
var agentDegraded = document.getElementById('agent-degraded');
var barTitle = document.getElementById('bar-title');
var agentHistory = [], agentBusy = false, agentDead = false, agentTitle = '';
var pendingReactions = {};

// 次の質問の予測（Worker の suggest イベント）。入力欄が空で送れる状態のときだけ薄く重ね、
// › で入力欄に入れる（送信はしない）。会話を切り替える・送る・使うと消える。
var agentSuggestEl = document.getElementById('agent-suggest');
var agentSuggestText = document.getElementById('agent-suggest-text');
var agentSuggestUse = document.getElementById('agent-suggest-use');
var agentSuggestion = '';
function renderAgentSuggest() {
  var show = !!agentSuggestion && !agentInput.value && !agentInput.disabled;
  agentSuggestEl.hidden = !show;
  agentInput.classList.toggle('has-suggest', show);
  if (!show) return;
  agentSuggestText.textContent = agentSuggestion;
  agentSuggestUse.setAttribute('aria-label', 'Use the suggested question: ' + agentSuggestion);
}
function setAgentSuggestion(text) { agentSuggestion = String(text || '').trim(); renderAgentSuggest(); }
agentSuggestUse.addEventListener('click', function () {
  if (!agentSuggestion || agentInput.disabled) return;
  agentInput.value = agentSuggestion.slice(0, 1000);
  setAgentSuggestion('');
  fitAgentInput();
  agentInput.focus({ preventScroll: true });
  agentInput.setSelectionRange(agentInput.value.length, agentInput.value.length);
});
// 打ち始めたら隠し、全部消したらまた出す（予測は直前の答えに対するものなので、残しておいてよい）
agentInput.addEventListener('input', renderAgentSuggest);
// 入力欄は内容に合わせて伸び縮みさせる（上限は CSS の max-height。超えたら欄の中でスクロール）。
// コードから値を入れたとき（予測の › ・送信後の空欄・リセット）も呼ぶ。
function fitAgentInput() {
  agentInput.style.height = 'auto';
  var border = agentInput.offsetHeight - agentInput.clientHeight; // box-sizing: border-box なので枠を足す
  var max = parseFloat(getComputedStyle(agentInput).maxHeight) || Infinity;
  var want = agentInput.scrollHeight + border;
  agentInput.style.height = Math.min(want, max) + 'px';
  agentInput.style.overflowY = want > max ? 'auto' : 'hidden';
}
agentInput.addEventListener('input', fitAgentInput);
// 幅が変わると折り返しも変わる（画面の回転など）。高さの変化では呼ばないよう幅だけを見る
var agentInputWidth = 0;
new ResizeObserver(function (entries) {
  var w = Math.round(entries[0].contentRect.width);
  if (w !== agentInputWidth) { agentInputWidth = w; fitAgentInput(); }
}).observe(agentInput);

// ---- Helpers ----------------------------------------------------------------
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function safeParse(raw, fallback) { try { return raw ? JSON.parse(raw) : fallback; } catch (_) { return fallback; } }
// 画像サムネを持つ履歴は容量を食う。あふれたら古い保存セッションを捨てて1回だけ再試行する。
function safeStore(key, val) {
  var str = typeof val === 'string' ? val : JSON.stringify(val);
  try { localStorage.setItem(key, str); } catch (_) {
    try {
      var ss = safeParse(localStorage.getItem('magi_saved_sessions'), []);
      while (ss.length > 5) ss.pop();
      localStorage.setItem('magi_saved_sessions', JSON.stringify(ss));
      localStorage.setItem(key, str);
    } catch (__) { /* どうにもならない場合は黙って諦める */ }
  }
}
var genMid = function () { return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); };
var agentScroll = function () { agentLog.scrollTop = agentLog.scrollHeight; };
// 終わった往復とエラーを1回だけ読み上げる（#agent-log は読み上げ領域にしない。index.html の注記）。
// 保存した会話を開き直したときは読み上げない（自分で開いたものなので、ログを順にたどれる）。
var agentStatusEl = document.getElementById('agent-status');
var announceAgent = function (text) { agentStatusEl.textContent = text || ''; };

var ICON_COPY = '<svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
var ICON_LIKE = '<svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>';
var ICON_REACT = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15.5 3.6a9 9 0 1 0 4.9 4.9"/><circle cx="9" cy="10" r="0.6" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="0.6" fill="currentColor" stroke="none"/><path d="M8.5 14.5a4 4 0 0 0 7 0"/><line x1="19.5" y1="2.5" x2="19.5" y2="7.5"/><line x1="17" y1="5" x2="22" y2="5"/></svg>';

function reactionBarHTML(target) {
  return '<div class="reaction-bar" data-target="' + esc(target) + '">'
    + '<button type="button" class="react-btn" data-act="copy" title="Copy">' + ICON_COPY + '</button>'
    + '<button type="button" class="react-btn" data-act="like" title="Like">' + ICON_LIKE + '</button>'
    + '<button type="button" class="react-btn" data-act="emoji" title="React">' + ICON_REACT + '</button>'
    + '</div>';
}

var AGENT_HINT = '<div class="agent-splash">'
  + '<svg aria-hidden="true" class="magi-emblem" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">'
  + '<line class="hl-bg" x1="51.5" y1="49" x2="43.5" y2="63"/><line class="hl-bg" x1="76.5" y1="63" x2="68.5" y2="49"/><line class="hl-bg" x1="52" y1="78" x2="68" y2="78"/>'
  + '<line class="hl-flow" x1="51.5" y1="49" x2="43.5" y2="63"/><line class="hl-flow" x1="76.5" y1="63" x2="68.5" y2="49"/><line class="hl-flow" x1="52" y1="78" x2="68" y2="78"/>'
  + '<polygon class="hx" points="60,14 77,24 77,44 60,54 43,44 43,24"/>'
  + '<polygon class="hx" points="35,58 52,68 52,88 35,98 18,88 18,68"/>'
  + '<polygon class="hx" points="85,58 102,68 102,88 85,98 68,88 68,68"/>'
  + '<text class="hn" x="60" y="39" text-anchor="middle">1</text>'
  + '<text class="hn" x="35" y="83" text-anchor="middle">2</text>'
  + '<text class="hn" x="85" y="83" text-anchor="middle">3</text>'
  + '</svg>'
  + '<div class="magi-title glow">MAGI</div>'
  + '<div class="magi-sub">Multi-Agent Generative Intelligence</div>'
  + '<div class="magi-ver">ver 3.8 <button type="button" id="btn-info-agent" class="magi-info-btn" title="System & Privacy"><svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg></button></div>'
  + '<div class="magi-nodes">' + AGENT_PERSONAS.map(function (p) { return '<button type="button" class="magi-node" data-codename="' + p.codename + '">' + p.codename.replace('-', '·') + '</button>'; }).join('')
  + '<button type="button" class="magi-node" data-codename="' + AGENT_SYNTH.codename + '">✦ ' + AGENT_SYNTH.codename.toUpperCase() + '</button>' + '</div>'
  + '<div class="magi-desc hidden" aria-live="polite"></div>'
  + '</div>';

// ---- Title ------------------------------------------------------------------
function setAgentTitle(text) {
  agentTitle = (text || '').trim();
  barTitle.textContent = agentTitle || 'MAGI';
  if (agentTitle) localStorage.setItem('magi_current_title', agentTitle);
  else localStorage.removeItem('magi_current_title');
}

// ---- Reactions persistence --------------------------------------------------
function reactionStoreFor(bar) {
  var turn = bar.closest('.agent-turn');
  var mid = turn && turn.dataset.mid;
  if (!mid) return null;
  var item = agentHistory.find(function (it) { return it.mid === mid; });
  if (item) { if (!item.reactions) item.reactions = {}; return item.reactions; }
  if (!pendingReactions[mid]) pendingReactions[mid] = {};
  return pendingReactions[mid];
}
function persistReactions() { safeStore('magi_current_history', agentHistory); syncCurrentToSaved(); }

// ---- Saved sessions (history) ----------------------------------------------
// One id per active conversation (reset on New conversation). The current
// conversation is synced into magi_saved_sessions in real time.
var currentSessionId = localStorage.getItem('magi_current_session_id') || null;
function archiveCurrentHistory() {
  currentSessionId = null;
  localStorage.removeItem('magi_current_session_id');
}
function syncCurrentToSaved() {
  if (!agentHistory || agentHistory.length === 0) return;
  var firstUserMsg = agentHistory.find(function (m) { return m.role === 'user'; });
  if (!firstUserMsg) return;
  var firstText = contentText(firstUserMsg.content) || 'Image';
  var title = agentTitle || (firstText.slice(0, 30) + (firstText.length > 30 ? '...' : ''));
  var sessions = safeParse(localStorage.getItem('magi_saved_sessions'), []);
  if (currentSessionId) {
    sessions = sessions.filter(function (s) { return s.id !== currentSessionId; });
  } else {
    currentSessionId = 'session_' + Date.now();
    localStorage.setItem('magi_current_session_id', currentSessionId);
  }
  sessions.unshift({ id: currentSessionId, timestamp: Date.now(), title: title, history: agentHistory.slice() });
  if (sessions.length > 50) sessions.pop();
  safeStore('magi_saved_sessions', sessions);
  if (document.getElementById('agent-history-list')) renderSavedSessionsList();
}
function applyReactionsToTurn(turn, reactions) {
  if (!reactions) return;
  Object.keys(reactions).forEach(function (target) {
    var em = reEmoji(reactions[target]);
    if (!em) return;
    var sel = (window.CSS && CSS.escape) ? CSS.escape(target) : target;
    var bar = turn.querySelector('.reaction-bar[data-target="' + sel + '"]');
    if (!bar) return;
    if (em === '👍') {
      var likeBtn = bar.querySelector('.react-btn[data-act="like"]');
      if (likeBtn) likeBtn.classList.add('liked');
    } else {
      var trigger = bar.querySelector('.react-btn[data-act="emoji"]');
      if (trigger) { trigger.classList.add('reacted'); trigger.textContent = em; }
    }
    bar.classList.add('locked');
  });
}
var reEmoji = function (v) { return (typeof v === 'string' ? v : (v && v.em) || ''); };

// 新規送信と履歴復元で同じカードを使う。debate 未指定なら考え中として描画する。
function personaCardsHTML(debate) {
  var personas = AGENT_PERSONAS.map(function (p) {
    var d = (debate && debate[p.codename]) || { round1: '…', round2: '…' };
    var r2has = d.round2 && d.round2 !== '…';
    return '<div class="persona-card' + (debate ? '' : ' thinking') + '" data-codename="' + p.codename + '">'
      + '<div class="persona-head"><span class="persona-hex">⬡</span><span class="persona-code">' + p.codename + '</span><span class="persona-name">' + p.name + '</span></div>'
      + '<div class="persona-round" data-round="1"><span class="persona-round-label">Initial</span><div class="persona-text">' + esc(d.round1 || '…') + '</div></div>'
      + '<div class="persona-round" data-round="2"' + (r2has ? '' : ' hidden') + '><span class="persona-round-label">After debate</span><div class="persona-text">' + esc(d.round2 || '…') + '</div></div>'
      + reactionBarHTML(p.codename)
      + '</div>';
  }).join('');
  return '<div class="agent-personas">' + personas + '</div>';
}

// トップのインスクリプションとアプリ単体配布のため、4画面に同じ計時処理を内包する。
function setMagiThinkingLabel(el, seconds, finished) {
  el.className = 'magi-thinking';
  el.dataset.en = finished ? 'Thought for ' + seconds + 's' : 'Thinking for ' + seconds + 's';
  el.dataset.ja = seconds + (finished ? '秒考えました' : '秒考え中');
  el.textContent = document.documentElement.lang === 'ja' ? el.dataset.ja : el.dataset.en;
}
function magiThinkingHTML(seconds) {
  if (!Number.isInteger(seconds) || seconds < 0) return '';
  var el = document.createElement('span');
  setMagiThinkingLabel(el, seconds, true);
  return el.outerHTML;
}
function startMagiThinking(target, startedAt) {
  var el = document.createElement('span'), seconds = null;
  target.appendChild(el);
  // 経過時間から算出し、バックグラウンドで更新が間引かれても秒数を保つ。
  var elapsed = function () { return Math.max(0, Math.floor((performance.now() - startedAt) / 1000)); };
  var tick = function () { setMagiThinkingLabel(el, elapsed(), false); };
  tick();
  var timer = setInterval(tick, 1000);
  return {
    finish: function () {
      if (seconds === null) {
        clearInterval(timer);
        seconds = elapsed();
        setMagiThinkingLabel(el, seconds, true);
      }
      return seconds;
    },
    cancel: function () { clearInterval(timer); el.remove(); },
  };
}

// ---- Render persisted history ----------------------------------------------
function turnHTML(item) {
  return personaCardsHTML(item.debate || {})
    + '<div class="agent-reply"><span class="agent-who">✦ Shinya Takeda' + magiThinkingHTML(item.thinkingSeconds) + '</span><span class="agent-reply-body">' + esc(item.content || '') + '</span>' + reactionBarHTML('integrated') + '</div>';
}
function renderHistoryToLog(history) {
  agentLog.innerHTML = '';
  history.forEach(function (item) {
    if (item.role === 'user') {
      var u = document.createElement('div'); u.className = 'agent-user';
      u.innerHTML = '<span>' + userContentHTML(item.content) + '</span>';
      agentLog.appendChild(u);
    } else if (item.role === 'assistant') {
      var turn = document.createElement('div'); turn.className = 'agent-turn';
      if (!item.mid) item.mid = genMid();
      turn.dataset.mid = item.mid;
      turn.innerHTML = turnHTML(item);
      agentLog.appendChild(turn);
      applyReactionsToTurn(turn, item.reactions);
    }
  });
  agentScroll();
}

// ---- Lifecycle --------------------------------------------------------------
function showSplashIfEmpty() {
  if (!agentLog.children.length && !agentDead) agentLog.innerHTML = AGENT_HINT;
}
function initAgent() {
  agentHistory = safeParse(localStorage.getItem('magi_current_history'), []);
  setAgentTitle(localStorage.getItem('magi_current_title') || '');
  if (agentHistory && agentHistory.length > 0) renderHistoryToLog(agentHistory);
  else showSplashIfEmpty();
  updateAgentActionButtons();
}
var agentGen = 0, agentCtrl = null;
function dropAgentRequest() {
  agentGen++;
  if (agentCtrl) { agentCtrl.abort(); agentCtrl = null; }
  setAgentStopMode(false);
  setAgentSuggestion('');
}
function resetAgent() {
  dropAgentRequest();
  archiveCurrentHistory();
  agentHistory = []; agentBusy = false; agentDead = false;
  localStorage.removeItem('magi_current_history');
  localStorage.removeItem('magi_current_title');
  agentLog.innerHTML = '';
  agentDegraded.classList.add('hidden'); agentDegraded.textContent = '';
  announceAgent('');
  agentInput.disabled = false; agentSendBtn.disabled = false; agentInput.value = ''; fitAgentInput();
  attachBtn.disabled = false; attachments = []; attachNotice = ''; renderAttachTray();
  setAgentSuggestion('');
  closeAgentPanels();
  setAgentTitle('');
  showSplashIfEmpty();
  updateAgentActionButtons();
}
function agentDegrade(msg) {
  agentDead = true;
  agentDegraded.textContent = msg || 'MAGI is currently unreachable. Check your connection and try again.';
  agentDegraded.classList.remove('hidden');
  announceAgent(agentDegraded.textContent);
  agentInput.disabled = true; agentSendBtn.disabled = true; attachBtn.disabled = true;
  renderAgentSuggest();
}
function renderAgentError(env) {
  env = env || {};
  var div = document.createElement('div'); div.className = 'agent-err fade-in';
  var meta = [env.stage, env.code].filter(Boolean).join(' / ');
  var lines = [];
  if (meta) lines.push('<div class="agent-rid">' + esc(meta) + '</div>');
  if (env.request_id) lines.push('<div class="agent-rid">request_id: ' + esc(env.request_id) + '</div>');
  div.innerHTML = '⚠ ' + esc(env.message || 'An error occurred') + lines.join('');
  agentLog.appendChild(div);
  announceAgent(env.message || 'An error occurred');
  agentScroll();
}

// ---- SSE --------------------------------------------------------------------
async function parseSSE(body, handlers, onChunk) {
  const reader = body.getReader(), dec = new TextDecoder();
  let buf = '', skipLF = false;
  const block = (text) => {
    let ev = 'message', data = '';
    text.split('\n').forEach(line => {
      if (line.startsWith('event:')) ev = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).replace(/^ /, '') + '\n';
    });
    if (!data) return false;
    const parsed = JSON.parse(data.replace(/\n$/, ''));
    if (handlers[ev]) handlers[ev](parsed);
    return ev === 'done' || ev === 'error';
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (onChunk) onChunk();
      let chunk = dec.decode(value, { stream: true });
      if (!chunk) continue;
      if (skipLF && chunk[0] === '\n') chunk = chunk.slice(1);
      skipLF = chunk.endsWith('\r');
      buf += chunk.replace(/\r\n?/g, '\n');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const text = buf.slice(0, i); buf = buf.slice(i + 2);
        if (block(text)) return;
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

// ---- 画像添付（マルチモーダル入力）------------------------------------------
// 画像は data URL のまま Worker → 各人格の API（OpenAI・DeepSeek・Gemini）へ送る。送信用（長辺1024）と保存用
// サムネ（長辺320）を分けて作り、localStorage には軽いサムネだけを残す。
var ATTACH_MAX = 4;
var ATTACH_SEND_DIM = 1024;
var ATTACH_THUMB_DIM = 320;
// 受け入れは MIME で絞らず「ブラウザがデコードできる画像か」で判断する。
// どの形式でも送信前に JPEG へ再エンコードするので、iOS の HEIC も WebView が
// 読めればそのまま通る（読めなければ addAttachments の catch で弾かれる）。
function isImageFile(f) { return !!f && /^image\//.test(f.type || ''); }
var attachTray = document.getElementById('agent-attach-tray');
var attachBtn = document.getElementById('agent-attach');
var attachFile = document.getElementById('agent-file');
var attachments = [];
var attachNotice = '';

// content（文字列 or パート配列）からテキスト / 画像を取り出す
function contentText(c) {
  if (typeof c === 'string') return c;
  return c.filter(function (p) { return p.type === 'text'; }).map(function (p) { return p.text; }).join('\n');
}
function contentImages(c) {
  return typeof c === 'string' ? [] : c.filter(function (p) { return p.type === 'image_url'; });
}
function downscaleImage(img, max, quality) {
  var scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  var w = Math.max(1, Math.round(img.naturalWidth * scale));
  var h = Math.max(1, Math.round(img.naturalHeight * scale));
  var cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  var cx = cv.getContext('2d');
  cx.fillStyle = '#ffffff'; cx.fillRect(0, 0, w, h);
  cx.drawImage(img, 0, 0, w, h);
  return cv.toDataURL('image/jpeg', quality);
}
function loadImageFile(file) {
  return new Promise(function (resolve, reject) {
    var fr = new FileReader();
    fr.onerror = function () { reject(new Error('read failed')); };
    fr.onload = function () {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('decode failed')); };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}
function renderAttachTray() {
  if (!attachments.length && !attachNotice) { attachTray.classList.add('hidden'); attachTray.innerHTML = ''; return; }
  attachTray.classList.remove('hidden');
  attachTray.innerHTML = attachments.map(function (a, i) {
    return '<span class="attach-chip"><img src="' + a.thumb + '" alt="">'
      + '<button type="button" class="attach-x" data-i="' + i + '" aria-label="Remove attachment">×</button></span>';
  }).join('') + (attachNotice ? '<span class="attach-note">' + esc(attachNotice) + '</span>' : '');
}
function noticeAttach(msg) {
  attachNotice = msg; renderAttachTray();
  setTimeout(function () { attachNotice = ''; renderAttachTray(); }, 2500);
}
async function addAttachments(files) {
  if (agentDead) return;
  var list = Array.prototype.slice.call(files || []).filter(isImageFile);
  if (!list.length) return;
  for (var i = 0; i < list.length; i++) {
    if (attachments.length >= ATTACH_MAX) { noticeAttach('Up to ' + ATTACH_MAX + ' images'); break; }
    try {
      var img = await loadImageFile(list[i]);
      attachments.push({ url: downscaleImage(img, ATTACH_SEND_DIM, 0.82), thumb: downscaleImage(img, ATTACH_THUMB_DIM, 0.7) });
      renderAttachTray();
    } catch (_) { noticeAttach('Could not read that image'); }
  }
}
// ユーザー発言の吹き出し中身（サムネ＋本文）
function userContentHTML(content) {
  if (typeof content === 'string') return esc(content);
  var imgs = contentImages(content).map(function (p) {
    return '<img src="' + p.image_url.url + '" alt="Attached image" loading="lazy">';
  }).join('');
  return (imgs ? '<span class="agent-imgs">' + imgs + '</span>' : '') + esc(contentText(content));
}

attachBtn.addEventListener('click', function () { attachFile.click(); });
attachFile.addEventListener('change', function () { addAttachments(attachFile.files); attachFile.value = ''; });
attachTray.addEventListener('click', function (e) {
  var x = e.target.closest('.attach-x'); if (!x) return;
  attachments.splice(Number(x.dataset.i), 1); renderAttachTray();
});
// 画像はクリップボードからの貼り付けでも添付できる
agentInput.addEventListener('paste', function (e) {
  var files = Array.prototype.slice.call((e.clipboardData && e.clipboardData.files) || []);
  if (!files.length) return;
  e.preventDefault(); addAttachments(files);
});
// 送信済みサムネはタップで拡大／縮小
agentLog.addEventListener('click', function (e) {
  var img = e.target.closest('.agent-imgs img');
  if (img) img.classList.toggle('expanded');
});

// ---- Send -------------------------------------------------------------------
function renderAgentPages(replyEl, data) {
  // リンクはこの回答の表示だけ。履歴・次の質問・保存会話へは入れない。
  if (!data || !Array.isArray(data.pages) || data.pages.length > 3) return;
  var panel = document.createElement('div'); panel.className = 'agent-pages';
  function add(title, description, raw, daily) {
    if (typeof title !== 'string' || typeof description !== 'string' || typeof raw !== 'string') return;
    try {
      var u = new URL(raw);
      if (u.origin !== 'https://tk.st' || u.username || u.password) return;
      if (daily) {
        if (!['/job/nitoridaily/', '/job/retailtechdaily/'].includes(u.pathname) || u.hash !== '#archiveSearch'
          || Array.from(u.searchParams.keys()).join(',') !== 'q' || !u.searchParams.get('q')) return;
      } else if (u.search || u.hash) return;
      var a = document.createElement('a'); a.className = 'agent-page'; a.href = u.href;
      a.target = '_blank'; a.rel = 'noopener noreferrer';
      var name = document.createElement('strong'); name.textContent = title; a.appendChild(name);
      if (description) { var desc = document.createElement('span'); desc.textContent = description; a.appendChild(desc); }
      panel.appendChild(a);
    } catch (_) {}
  }
  data.pages.forEach(function (p) { if (p && ['tool', 'game', 'article', 'page'].includes(p.kind)) add(p.title, p.description, p.url, false); });
  var d = data.daily;
  if (d && ['nitori', 'retail'].includes(d.media) && typeof d.query === 'string') {
    var ja = document.documentElement.lang === 'ja';
    var name = d.media === 'nitori' ? (ja ? '日刊ニトリ' : 'Daily Nitori') : (ja ? '日刊リテールテック' : 'Daily Retail Tech');
    add(ja ? name + 'で「' + d.query + '」を探す →' : 'Search ' + name + ' for “' + d.query + '” →', '', d.url, true);
  }
  if (panel.children.length) replyEl.appendChild(panel);
}

function prepareAgentMessages(history, lastContent) {
  const messages = history.slice(-AGENT_MAX_HISTORY).map(({ thinkingSeconds, ...m }) => ({ ...m }));
  while (messages[0] && messages[0].role === 'assistant') messages.shift();
  messages[messages.length - 1].content = lastContent;
  let remaining = 8;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!Array.isArray(m.content)) continue;
    const kept = [];
    for (const part of m.content) {
      if (part.type !== 'image_url') kept.push(part);
      else if (remaining > 0) { kept.push(part); remaining--; }
    }
    // 画像だけだった古い質問も、会話上の位置は残す。
    m.content = kept.length ? kept : '[Earlier images omitted]';
  }
  return messages;
}

// While a reply is being generated the send button becomes a stop button (■). Pressing it drops the
// connection, and the Worker stops its remaining upstream calls too.
var AGENT_SEND_ICON = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22 11 13 2 9z"/></svg>';
var AGENT_STOP_ICON = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor"/></svg>';
function setAgentStopMode(on) {
  agentSendBtn.innerHTML = on ? AGENT_STOP_ICON : AGENT_SEND_ICON;
  agentSendBtn.title = agentSendBtn.ariaLabel = on ? 'Stop' : 'Send';
  if (on) agentSendBtn.disabled = false;
}
function agentStop() {
  if (!agentCtrl) return;
  agentCtrl.userStopped = true;
  agentCtrl.abort();
}

async function agentSend() {
  if (agentBusy || agentDead) return;
  var text = agentInput.value.trim().slice(0, 1000);
  var atts = attachments.slice();
  if (!text && !atts.length) return;
  var startedAt = performance.now();
  setAgentSuggestion('');
  agentInput.value = ''; fitAgentInput();
  attachments = []; renderAttachTray();
  // 送信は長辺1024、履歴に残すのはサムネ（端末のストレージを食い潰さないため）
  var partsOf = function (key) {
    return (text ? [{ type: 'text', text: text }] : []).concat(atts.map(function (a) {
      return { type: 'image_url', image_url: { url: a[key] } };
    }));
  };
  var sendContent = atts.length ? partsOf('url') : text;
  var storeContent = atts.length ? partsOf('thumb') : text;
  if (agentLog.children.length === 1 && agentLog.firstElementChild.classList.contains('agent-splash')) agentLog.innerHTML = '';

  var u = document.createElement('div'); u.className = 'agent-user fade-in'; u.innerHTML = '<span>' + userContentHTML(storeContent) + '</span>';
  agentLog.appendChild(u);

  var turn = document.createElement('div'); turn.className = 'fade-in agent-turn';
  var mid = genMid(); turn.dataset.mid = mid; pendingReactions[mid] = {};
  turn.innerHTML = personaCardsHTML();
  var replyEl = document.createElement('div'); replyEl.className = 'agent-reply streaming';
  replyEl.innerHTML = '<span class="agent-who">✦ Shinya Takeda</span><span class="agent-reply-body"></span>' + reactionBarHTML('integrated');
  turn.appendChild(replyEl);
  agentLog.appendChild(turn); agentScroll();
  var replyBody = replyEl.querySelector('.agent-reply-body');
  var thinking = startMagiThinking(replyEl.querySelector('.agent-who'), startedAt);

  agentHistory.push({ role: 'user', content: storeContent });
  safeStore('magi_current_history', agentHistory);

  agentBusy = true; agentInput.disabled = true; agentSendBtn.disabled = true; attachBtn.disabled = true;
  setAgentStopMode(true);
  var reply = '', errored = false, timedOut = false, suggestion = '', completed = false, sitePages = null;
  var debateData = {};
  AGENT_PERSONAS.forEach(function (p) { debateData[p.codename] = { round1: '…', round2: '…' }; });

  var ctrl = new AbortController();
  var gen = agentGen; agentCtrl = ctrl;
  ctrl.signal.addEventListener('abort', function () { thinking.cancel(); }, { once: true });
  var dropped = function () { return gen !== agentGen; };
  var idleTimer = null;
  var watch = function (ms) {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () { timedOut = true; ctrl.abort(); }, ms || 70000);
  };
  watch(30000);
  try {
    var theme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    var outbound = prepareAgentMessages(agentHistory, sendContent);
    var res = await fetch(AGENT_API, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: outbound, theme, suggest: true, site_pages: true }),
      signal: ctrl.signal,
    });
    if (dropped()) return;
    watch();
    if (!res.ok || !res.body) {
      var raw = await res.text().catch(function () { return ''; });
      if (dropped()) return;
      var env = null; try { env = JSON.parse(raw).error; } catch (_) { }
      if (!env) env = { message: ('HTTP ' + res.status + ' ' + (res.statusText || '')).trim(), code: 'http_' + res.status };
      console.error('[agent] request failed', AGENT_API, res.status, raw.slice(0, 800));
      turn.remove(); renderAgentError(env); errored = true;
    } else {
      await parseSSE(res.body, {
        title: function (d) { if (d && d.text && !dropped()) setAgentTitle(d.text); },
        persona: function (d) {
          if (dropped()) return;
          var cn = (window.CSS && CSS.escape) ? CSS.escape(d.codename) : d.codename;
          var card = turn.querySelector('.persona-card[data-codename="' + cn + '"]');
          if (!card) return;
          var slot = card.querySelector('.persona-round[data-round="' + (d.round || 1) + '"]');
          if (slot) { slot.hidden = false; slot.querySelector('.persona-text').textContent = d.text; }
          if (d.round === 2) card.classList.remove('thinking');
          agentScroll();
          if (debateData[d.codename]) {
            if (d.round === 2) debateData[d.codename].round2 = d.text;
            else debateData[d.codename].round1 = d.text;
          }
        },
        integrated: function (d) { if (dropped()) return; reply += d.delta || ''; if (reply.trim()) thinking.finish(); replyBody.textContent = reply; agentScroll(); },
        error: function (d) { if (dropped()) return; thinking.cancel(); errored = true; turn.querySelectorAll('.persona-card.thinking').forEach(function (c) { c.classList.remove('thinking'); }); replyEl.remove(); renderAgentError(d); },
        // 次の質問の予測。答えが最後まで届いたときだけ、下で入力欄に出す
        suggest: function (d) { suggestion = (d && typeof d.text === 'string') ? d.text : ''; },
        pages: function (d) { if (!dropped()) sitePages = d; },
        done: function () { completed = true; },
      }, watch);
      if (!dropped() && !errored && (!completed || !reply.trim())) {
        errored = true; turn.remove();
        renderAgentError({ message: 'The complete reply was not received. Please try again.', code: 'incomplete_reply' });
      }
    }
  } catch (err) {
    errored = true;
    if (dropped()) return;
    turn.remove();
    // Stopped with the stop button: no error; the question goes back into the input below.
    if (ctrl.userStopped) { }
    else if (timedOut || err.name === 'AbortError') { errored = true; renderAgentError({ message: 'Request timed out. Please try again.', code: 'timeout' }); }
    else { console.error('[agent] fetch failed', AGENT_API, err); agentDegrade(); }
  } finally {
    clearTimeout(idleTimer);
    if (!completed || errored || dropped()) thinking.cancel();
    if (agentCtrl === ctrl) agentCtrl = null;
    // A dropped request restores the button too, unless a newer send has already taken it over.
    if (!dropped() || !agentBusy) setAgentStopMode(false);
    if (dropped()) delete pendingReactions[mid];
    if (!dropped()) {
      replyEl.classList.remove('streaming');
      agentBusy = false;
      if (!agentDead) { agentInput.disabled = false; agentSendBtn.disabled = false; attachBtn.disabled = false; agentInput.focus({ preventScroll: true }); }
      else agentSendBtn.disabled = true;
    }
  }
  if (dropped()) { delete pendingReactions[mid]; return; }
  if (completed && reply.trim() && !errored) {
    renderAgentPages(replyEl, sitePages);
    announceAgent('MAGI replied. ' + reply);
    // この送信だけのオブジェクトで、ストリーム終了後は更新しないので、そのまま保存する。
    agentHistory.push({ role: 'assistant', content: reply, thinkingSeconds: thinking.finish(), debate: debateData, mid: mid, reactions: pendingReactions[mid] || {} });
    delete pendingReactions[mid];
    safeStore('magi_current_history', agentHistory);
    syncCurrentToSaved();
    updateAgentActionButtons();
    setAgentSuggestion(suggestion);
  } else {
    turn.remove(); u.remove(); delete pendingReactions[mid];
    var last = agentHistory[agentHistory.length - 1];
    if (last && last.role === 'user' && last.content === storeContent) agentHistory.pop();
    safeStore('magi_current_history', agentHistory); syncCurrentToSaved(); updateAgentActionButtons();
    // A stopped question goes back into the input so it can be edited and resent (unless something new was typed).
    if (ctrl.userStopped && !agentInput.value) { agentInput.value = text; attachments = atts; renderAttachTray(); fitAgentInput(); }
  }
}

// ---- Reaction network -------------------------------------------------------
function getReactionContext(bar) {
  var target = bar.getAttribute('data-target');
  var turn = bar.closest('.agent-turn');
  var userEl = turn && turn.previousElementSibling;
  var request = (userEl && userEl.classList.contains('agent-user')) ? userEl.textContent.trim() : '';
  var response = '';
  if (target === 'integrated') {
    var body = turn && turn.querySelector('.agent-reply-body');
    response = body ? body.textContent.trim() : '';
  } else {
    var card = bar.closest('.persona-card');
    if (card) {
      var r2 = card.querySelector('.persona-round[data-round="2"]:not([hidden]) .persona-text');
      var r1 = card.querySelector('.persona-round[data-round="1"] .persona-text');
      var r2txt = r2 && r2.textContent.trim();
      response = (r2txt && r2txt !== '…') ? r2txt : (r1 ? r1.textContent.trim() : '');
    }
  }
  return { target: target, request: request, response: response };
}
async function sendReaction(target, reaction, request, response) {
  if (!response) return undefined;
  try {
    const res = await fetch(REACT_API, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target, reaction, request, response }),
    });
    if (!res.ok) return undefined;
    const j = await res.json();
    return j && j.id && typeof j.delete_token === 'string' ? { id: j.id, delete_token: j.delete_token } : undefined;
  } catch (_) { return undefined; }
}
// トークンを持たない旧データは、連番だけでの削除を試みない。
function deleteReaction(target, receipt) {
  if (!receipt || !receipt.id || !receipt.delete_token) return;
  try {
    fetch(REACT_API, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'remove', target, id: receipt.id, delete_token: receipt.delete_token }),
      keepalive: true,
    }).catch(() => {});
  } catch (_) {}
}
function registerReaction(bar, target, em, ctx) {
  const store = reactionStoreFor(bar);
  const cell = { em };
  if (store) { store[target] = cell; persistReactions(); }
  sendReaction(target, em, ctx.request, ctx.response).then(receipt => {
    if (!receipt) return;
    if (store && store[target] === cell) {
      cell.id = receipt.id; cell.delete_token = receipt.delete_token; persistReactions();
    } else deleteReaction(target, receipt);
  });
}
function unregisterReaction(bar, target) {
  const store = reactionStoreFor(bar);
  const receipt = store && store[target];
  if (store) { delete store[target]; persistReactions(); }
  deleteReaction(target, receipt);
}
function flashReactBtn(btn, sym) {
  var orig = btn.innerHTML; btn.innerHTML = sym;
  setTimeout(function () { btn.innerHTML = orig; }, 1200);
}
function closeEmojiPops() { document.querySelectorAll('.emoji-pop').forEach(function (p) { p.remove(); }); }

// ---- Click delegation -------------------------------------------------------
agentLog.addEventListener('click', function (e) {
  // splash: System & Privacy info button (next to the version string)
  if (e.target.closest('#btn-info-agent')) { e.preventDefault(); showInfoPanel(); return; }
  // splash persona node
  var node = e.target.closest('.magi-node');
  if (node) {
    var splash = node.closest('.agent-splash'); if (!splash) return;
    var desc = splash.querySelector('.magi-desc');
    var wasActive = node.classList.contains('active');
    splash.querySelectorAll('.magi-node').forEach(function (n) { n.classList.remove('active'); });
    if (wasActive) { desc.classList.add('hidden'); return; }
    var p = AGENT_PERSONAS.concat([AGENT_SYNTH]).find(function (x) { return x.codename === node.dataset.codename; });
    node.classList.add('active');
    desc.innerHTML = personaDescHTML(p);
    desc.classList.remove('hidden');
    // fetch the LLM names if not loaded yet, then redraw if the same persona is still open
    if (!agentModels) loadAgentModels().then(function () { if (node.classList.contains('active')) desc.innerHTML = personaDescHTML(p); });
    return;
  }
  // emoji selection
  var emo = e.target.closest('.emoji-pop button');
  if (emo) {
    var pop = emo.closest('.emoji-pop');
    var bar = pop.closest('.reaction-bar');
    var em = emo.textContent;
    var ctx = getReactionContext(bar);
    var trigger = bar.querySelector('.react-btn[data-act="emoji"]');
    trigger.classList.add('reacted'); trigger.textContent = em;
    bar.classList.add('locked');
    registerReaction(bar, ctx.target, em, ctx);
    closeEmojiPops();
    return;
  }
  var btn = e.target.closest('.react-btn');
  if (!btn) { closeEmojiPops(); return; }
  var bar2 = btn.closest('.reaction-bar');
  var act = btn.getAttribute('data-act');
  var ctx2 = getReactionContext(bar2);

  if (act === 'copy') {
    if (ctx2.response && navigator.clipboard) navigator.clipboard.writeText(ctx2.response).catch(function () { });
    flashReactBtn(btn, '✓');
    return;
  }
  if (act === 'like') {
    if (btn.classList.contains('liked')) { // cancel the like
      btn.classList.remove('liked'); bar2.classList.remove('locked');
      unregisterReaction(bar2, ctx2.target);
      return;
    }
    if (bar2.classList.contains('locked')) return; // an emoji is already selected
    btn.classList.add('liked'); bar2.classList.add('locked'); // mutually exclusive: disable the other
    registerReaction(bar2, ctx2.target, '👍', ctx2);
    return;
  }
  if (act === 'emoji') {
    if (btn.classList.contains('reacted')) {
      // toggle off existing emoji
      btn.classList.remove('reacted'); btn.innerHTML = ICON_REACT; bar2.classList.remove('locked');
      unregisterReaction(bar2, ctx2.target);
      return;
    }
    if (bar2.classList.contains('locked')) return; // a like is already selected
    if (bar2.querySelector('.emoji-pop')) { closeEmojiPops(); return; }
    closeEmojiPops();
    var pop2 = document.createElement('div'); pop2.className = 'emoji-pop';
    pop2.innerHTML = REACT_EMOJIS.map(function (x) { return '<button type="button">' + x + '</button>'; }).join('');
    bar2.appendChild(pop2);
    return;
  }
});
document.addEventListener('click', function (e) { if (!e.target.closest('.reaction-bar')) closeEmojiPops(); });

// ---- Overlay panels (saved chats / info) -----------------------------------
var AGENT_PANEL_IDS = ['agent-history-panel', 'agent-info-panel'];
function closeAgentPanels() { AGENT_PANEL_IDS.forEach(function (id) { var p = document.getElementById(id); if (p) p.remove(); }); }
function makeAgentPanel(id, title, bodyHTML) {
  if (document.getElementById(id)) { document.getElementById(id).remove(); return null; }
  closeAgentPanels();
  var panel = document.createElement('div');
  panel.id = id; panel.className = 'agent-panel fade-in';
  panel.innerHTML = '<div class="agent-panel-head"><span class="t">' + title + '</span>'
    + '<button type="button" class="agent-panel-close">✕ CLOSE</button></div>'
    + '<div class="agent-panel-body">' + bodyHTML + '</div>';
  document.getElementById('app').appendChild(panel);
  panel.querySelector('.agent-panel-close').addEventListener('click', function () { panel.remove(); });
  return panel;
}
function showHistoryPanel() {
  var panel = makeAgentPanel('agent-history-panel', 'Saved Chats', '<div id="agent-history-list" style="display:flex;flex-direction:column;gap:0.4rem;"></div>');
  if (!panel) return;
  renderSavedSessionsList();
}
var ICON_TRASH = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
function renderSavedSessionsList() {
  var list = document.getElementById('agent-history-list');
  if (!list) return;
  var sessions = safeParse(localStorage.getItem('magi_saved_sessions'), []);
  if (!sessions.length) { list.innerHTML = '<div class="agent-panel-empty">No saved conversations.</div>'; return; }
  list.innerHTML = sessions.map(function (s) {
    return '<div class="session-item" data-id="' + esc(s.id) + '">'
      + '<div class="session-load" data-id="' + esc(s.id) + '">'
      + '<div class="session-title">' + esc(s.title) + '</div>'
      + '<div class="session-time">' + esc(new Date(s.timestamp).toLocaleString()) + '</div></div>'
      + '<button type="button" class="session-del" data-id="' + esc(s.id) + '" title="Delete chat">' + ICON_TRASH + '</button>'
      + '</div>';
  }).join('');
  list.querySelectorAll('.session-load').forEach(function (el) {
    el.addEventListener('click', function () { loadSavedSession(el.dataset.id); closeAgentPanels(); });
  });
  list.querySelectorAll('.session-del').forEach(function (el) {
    el.addEventListener('click', function (e) { e.stopPropagation(); deleteSavedSession(el.dataset.id); });
  });
}
function loadSavedSession(id) {
  syncCurrentToSaved(); // keep the current conversation before switching
  var sessions = safeParse(localStorage.getItem('magi_saved_sessions'), []);
  var session = sessions.find(function (s) { return s.id === id; });
  if (!session) return;
  dropAgentRequest();
  agentBusy = false;
  agentHistory = session.history.slice();
  safeStore('magi_current_history', agentHistory);
  setAgentTitle(session.title || '');
  currentSessionId = session.id;
  localStorage.setItem('magi_current_session_id', currentSessionId);
  agentDead = false; agentDegraded.classList.add('hidden'); agentDegraded.textContent = '';
  agentInput.disabled = false; agentSendBtn.disabled = false; attachBtn.disabled = false;
  setAgentSuggestion('');
  renderHistoryToLog(agentHistory);
  updateAgentActionButtons();
}
function deleteSavedSession(id) {
  if (currentSessionId === id) { currentSessionId = null; localStorage.removeItem('magi_current_session_id'); }
  var sessions = safeParse(localStorage.getItem('magi_saved_sessions'), []);
  sessions = sessions.filter(function (s) { return s.id !== id; });
  safeStore('magi_saved_sessions', sessions);
  renderSavedSessionsList();
}
function showInfoPanel() {
  makeAgentPanel('agent-info-panel', 'System & Privacy',
    '<ul>'
    + '<li>A multi-agent system with 3 debating personas modeled on <strong>Shinya Takeda\'s personality</strong>.</li>'
    + '<li>Each persona, and the final answer, also draws on summaries of tk.st (pages, timeline and the personality tests in the profile). They are rebuilt automatically when the site changes, so MAGI keeps up with me.</li>'
    + '<li>This is a <strong>parody &amp; experimental system</strong> inspired by the MAGI system from <strong>Neon Genesis Evangelion</strong>. It is not intended for practical tasks like coding.</li>'
    + '<li>Strict limits: max <strong>1,000 characters</strong> per input, limited output tokens, <strong>60 daily requests</strong>, and context from the latest <strong>12 messages</strong>.</li>'
    + '<li>Images can be attached (up to <strong>4 per message</strong>, resized on your device before sending) and are sent to the API just like text.</li>'
    + '<li>When site guidance is enabled, OpenAI also uses up to 500 characters of your latest message and the public page list to choose relevant tk.st links. These links are displayed for that reply and are not saved in chat history.</li>'
    + '<li>By default, inputs are <strong>not saved</strong> in the database, unless you <strong>react</strong> to a reply (👍/emoji) to help improve MAGI.</li>'
    + '<li>Your <strong>IP address</strong> is recorded in the database to enforce the usage limits (as a count per day), and is saved together with an exchange when you react to it.</li>'
    + '<li>Chat history is stored in your device\'s <strong>local storage</strong> (not permanent; please export important chats).</li>'
    + '<li>Powered by <strong>OpenAI API</strong>, <strong>DeepSeek API</strong> and <strong>Gemini API</strong>. Each persona runs on a different one, so every input (including images) is <strong>sent to all three</strong>.</li>'
    + '<li>OpenAI: sent to the US and retained up to 30 days for abuse monitoring; not used for AI training by default. Google (Gemini API, free tier): <strong>used to improve Google\'s products and train its models, and may be read by human reviewers</strong>. DeepSeek: <strong>stored on servers in China and may be used to train its models</strong>.</li>'
    + '<li class="warn">DO NOT input any confidential or personal information.</li>'
    + '</ul>');
}

// ---- Export / share ---------------------------------------------------------
function updateAgentActionButtons() {
  var hasHistory = agentHistory && agentHistory.length > 0;
  var shareBtn = document.getElementById('btn-share-agent');
  var exportBtn = document.getElementById('btn-export-agent');
  if (shareBtn) shareBtn.disabled = !hasHistory;
  if (exportBtn) exportBtn.disabled = !hasHistory;
}
function getAgentChatMarkdown() {
  if (!agentHistory || agentHistory.length === 0) return '';
  var md = '# MAGI Chat Log\nGenerated on: ' + new Date().toLocaleString() + '\n\n---\n\n';
  agentHistory.forEach(function (item) {
    if (item.role === 'user') {
      // 画像はサムネの data URL なので本文に埋め込まず、枚数だけ残す
      var n = contentImages(item.content).length;
      md += '## 🧑‍💻 User\n' + contentText(item.content) + (n ? '\n\n(' + n + ' image attachment' + (n > 1 ? 's' : '') + ')' : '') + '\n\n';
      return;
    }
    md += '## ✦ MAGI\n' + item.content + '\n\n';
    if (item.debate) {
      md += '### 🌐 MAGI Deliberation Process\n\n';
      AGENT_PERSONAS.forEach(function (p) {
        var deb = item.debate[p.codename];
        if (!deb) return;
        md += '#### 🧬 ' + p.codename + ' (' + p.name + ')\n';
        if (deb.round1 && deb.round1 !== '…') md += '* **Initial View:** ' + deb.round1 + '\n';
        if (deb.round2 && deb.round2 !== '…') md += '* **After Debate:** ' + deb.round2 + '\n';
        md += '\n';
      });
      md += '---\n\n';
    }
  });
  md += '*Generated by MAGI (tk.st)*\n';
  return md;
}
async function shareAgentChat(btn) {
  var md = getAgentChatMarkdown();
  if (!md) return;
  var shareData = { title: 'MAGI Chat Log', text: md };
  if (navigator.share && navigator.canShare && navigator.canShare(shareData)) {
    try { await navigator.share(shareData); return; }
    catch (err) { if (err.name !== 'AbortError') console.error('Share failed', err); }
  }
  try {
    await navigator.clipboard.writeText(md);
    var orig = barTitle.textContent;
    barTitle.textContent = 'COPIED!';
    setTimeout(function () { barTitle.textContent = orig; }, 2000);
  } catch (err) { console.error('Clipboard copy failed', err); }
}
function exportAgentChat() {
  var md = getAgentChatMarkdown();
  if (!md) return;
  var blob = new Blob([md], { type: 'text/markdown;charset=utf-8;' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = 'magi_chat_' + new Date().toISOString().slice(0, 10) + '.md';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---- Wire up ----------------------------------------------------------------
agentSendBtn.addEventListener('click', function () { if (agentBusy) agentStop(); else agentSend(); });
// Enter で送信、Shift+Enter で改行（入力欄は textarea）。日本語入力の変換を確定する Enter では送らない
agentInput.addEventListener('keydown', function (e) {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); agentSend(); }
});
document.getElementById('btn-reset').addEventListener('click', resetAgent);
document.getElementById('btn-history-agent').addEventListener('click', showHistoryPanel);

// kebab dropdown
(function () {
  var moreBtn = document.getElementById('btn-more-agent');
  var moreDropdown = document.getElementById('agent-more-dropdown');
  if (!moreBtn || !moreDropdown) return;
  moreBtn.addEventListener('click', function (e) { e.stopPropagation(); moreDropdown.classList.toggle('hidden'); });
  document.addEventListener('click', function (e) {
    if (!moreDropdown.classList.contains('hidden') && !e.target.closest('.kebab-wrap')) moreDropdown.classList.add('hidden');
  });
  moreDropdown.querySelectorAll('button, a').forEach(function (item) {
    item.addEventListener('click', function () { moreDropdown.classList.add('hidden'); });
  });
})();
document.getElementById('btn-share-agent').addEventListener('click', function (e) { shareAgentChat(e.currentTarget); });
document.getElementById('btn-export-agent').addEventListener('click', exportAgentChat);

document.getElementById('btn-theme').addEventListener('click', function () {
  var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('magi_theme', next);
});

// theme restore
(function () {
  var t = localStorage.getItem('magi_theme');
  if (t) document.documentElement.setAttribute('data-theme', t);
})();

// service worker (PWA)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () { }); });
}

initAgent();
