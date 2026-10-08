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

// AGENT_CLASSIFY_BEGIN
var MAGI_LANGUAGE_CODES = ' aa ab ae af ak am an ar as av ay az ba be bg bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu ';
function cleanReplyLanguage(v) {
  if (!v || v.version !== 1 || typeof v.code !== 'string') return null;
  if (v.code === 'other') {
    if (v.source !== 'sample' || typeof v.sample !== 'string' || !v.sample.trim() || v.sample.length > 120
      || /[<>\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(v.sample)) return null;
    return { version: 1, code: 'other', source: 'sample', sample: v.sample };
  }
  if (v.code.length !== 2 || MAGI_LANGUAGE_CODES.indexOf(' ' + v.code + ' ') < 0 || ['jev','rule','ui'].indexOf(v.source) < 0
    || v.sample !== undefined || (v.source === 'ui' && ['ja','en'].indexOf(v.code) < 0)) return null;
  return { version: 1, code: v.code, source: v.source };
}
function classificationFields(history, language, ui, entry, panel) {
  var first = history.filter(function (m) { return m && m.role === 'user'; })[0];
  var text = first ? (typeof first.content === 'string' ? first.content : (first.content || []).filter(function (p) { return p.type === 'text'; }).map(function (p) { return p.text; }).join('\n')) : '';
  var seed = text.slice(0, 500);
  if (/[\uD800-\uDBFF]$/.test(seed)) seed = seed.slice(0, -1);
  var state = cleanReplyLanguage(language);
  return Object.assign({ entry: entry || 'chat', classification_state: true, ui_language: ui },
    entry === 'dj-request' ? {} : { magi_panel: panel === true },
    state ? { reply_language: state } : { language_seed: seed });
}
function receiveClassification(state, ev, d) {
  if (ev === 'title' || ev === 'error') return;
  if (ev === 'classification') {
    var language = cleanReplyLanguage(d && d.reply_language);
    if (state.started || state.classified || !d || d.version !== 1 || ['consult','site','music'].indexOf(d.intent) < 0
      || ['yes','no','uncertain'].indexOf(d.site_pages) < 0 || ['yes','no','uncertain'].indexOf(d.votable) < 0
      || typeof d.magi_candidate !== 'boolean' || d.magi_candidate && (!state.panel || d.votable !== 'yes') || !language
      || (state.language && JSON.stringify(language) !== JSON.stringify(state.language))) throw new Error('invalid_classification');
    state.classified = true; state.language = language; state.candidate = d.magi_candidate;
  } else {
    if (state.panel && typeof magiReceive === 'function') magiReceive(state, ev, d);
    else if (['motion','verdict','integrated_end'].indexOf(ev) >= 0) throw new Error('unexpected_magi_event');
    state.started = true;
  }
}
// AGENT_CLASSIFY_END

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
function safeGet(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }
function safeRemove(key) { try { localStorage.removeItem(key); } catch (_) {} }
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

// インストール済みのPWA・ネイティブアプリには追加の案内を出さない。
var WEB_INSTALL = !(window.Capacitor && window.Capacitor.isNativePlatform())
  && !navigator.standalone && !window.matchMedia('(display-mode: standalone)').matches;
var AGENT_HINT = '<div class="agent-splash">'
  + '<svg aria-hidden="true" class="magi-emblem" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">'
  + '<line class="hl-bg" x1="51.5" y1="49" x2="43.5" y2="63"/><line class="hl-bg" x1="76.5" y1="63" x2="68.5" y2="49"/><line class="hl-bg" x1="52" y1="78" x2="68" y2="78"/>'
  + '<line class="hl-flow" x1="51.5" y1="49" x2="43.5" y2="63"/><line class="hl-flow" x1="76.5" y1="63" x2="68.5" y2="49"/><line class="hl-flow" x1="52" y1="78" x2="68" y2="78"/>'
  + '<polygon class="hx" points="43,14 77,14 77,44 68,54 52,54 43,44"/>'
  + '<polygon class="hx" points="18,58 40,58 52,68 52,98 18,98"/>'
  + '<polygon class="hx" points="80,58 102,58 102,98 68,98 68,68"/>'
  + '<text class="hn" x="60" y="39" text-anchor="middle">2</text>'
  + '<text class="hn" x="35" y="83" text-anchor="middle">3</text>'
  + '<text class="hn" x="85" y="83" text-anchor="middle">1</text>'
  + '</svg>'
  + '<div class="magi-title">MAGI</div>'
  + '<div class="magi-sub">Multi-Agent Generative Intelligence</div>'
  + '<div class="magi-ver">ver 4.4 <button type="button" id="btn-info-agent" class="magi-info-btn" title="System & Privacy"><svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg></button></div>'
  + '<div class="magi-nodes">' + AGENT_PERSONAS.map(function (p) { return '<button type="button" class="magi-node" data-codename="' + p.codename + '">' + p.codename.replace('-', '·') + '</button>'; }).join('')
  + '<button type="button" class="magi-node" data-codename="' + AGENT_SYNTH.codename + '">✦ ' + AGENT_SYNTH.codename.toUpperCase() + '</button>' + '</div>'
  + '<div class="magi-desc hidden" aria-live="polite"></div>'
  + (WEB_INSTALL ? '<div class="magi-nodes"><button type="button" class="magi-node" data-install-agent>Add to Home Screen</button></div>' : '')
  + '</div>';

// ---- Title ------------------------------------------------------------------
function setAgentTitle(text) {
  agentTitle = (text || '').trim();
  barTitle.textContent = agentTitle || 'MAGI';
  if (agentTitle) safeStore('magi_current_title', agentTitle);
  else safeRemove('magi_current_title');
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
var currentSessionId = safeGet('magi_current_session_id') || null;
var agentLanguageMeta = safeParse(safeGet('magi_current_language'), {}) || {};
var agentReplyLanguage = currentSessionId && agentLanguageMeta.id === currentSessionId ? cleanReplyLanguage(agentLanguageMeta.reply_language) : null;
function ensureAgentConversation() {
  if (!currentSessionId) { currentSessionId = 'session_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); safeStore('magi_current_session_id', currentSessionId); }
  return currentSessionId;
}
function saveAgentLanguage(value) {
  agentReplyLanguage = cleanReplyLanguage(value);
  safeStore('magi_current_language', { id: currentSessionId, reply_language: agentReplyLanguage });
  syncCurrentToSaved();
}

function archiveCurrentHistory() {
  currentSessionId = null; agentReplyLanguage = null; safeRemove('magi_current_language');
  safeRemove('magi_current_session_id');
}
function syncCurrentToSaved() {
  if (!agentHistory || agentHistory.length === 0) return;
  var firstUserMsg = agentHistory.find(function (m) { return m.role === 'user'; });
  if (!firstUserMsg) return;
  var firstText = contentText(firstUserMsg.content) || 'Image';
  var title = agentTitle || (firstText.slice(0, 30) + (firstText.length > 30 ? '...' : ''));
  var sessions = safeParse(safeGet('magi_saved_sessions'), []);
  if (currentSessionId) {
    sessions = sessions.filter(function (s) { return s.id !== currentSessionId; });
  } else {
    currentSessionId = 'session_' + Date.now();
    safeStore('magi_current_session_id', currentSessionId);
  }
  sessions.unshift({ id: currentSessionId, timestamp: Date.now(), title: title, history: agentHistory.slice(), reply_language: cleanReplyLanguage(agentReplyLanguage) });
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

// 第3回以降の枠。統合人格がこの人格に聞き返した回だけ出す（debate の followups: [{ round, ask, text }]）
function followupHTML(f) {
  var n = Number(f.round) || 0;
  return '<div class="persona-round" data-round="' + n + '"><span class="persona-round-label">Round ' + (n || '') + '</span>'
    + '<div class="persona-ask">✦ ' + esc(f.ask || '') + '</div><div class="persona-text">' + esc(magiBody(f.text, f.vote, false) || '…') + '</div></div>';
}

// 新規送信と履歴復元で同じカードを使う。debate 未指定なら考え中として描画する。
function personaCardsHTML(debate) {
  var personas = AGENT_PERSONAS.map(function (p) {
    var d = (debate && debate[p.codename]) || { round1: '…', round2: '…' };
    var r2has = typeof d.round2 === 'string' && d.round2 !== '…';
    return '<div class="persona-card' + (debate ? '' : ' thinking') + '" data-codename="' + p.codename + '">'
      + '<div class="persona-head"><span class="persona-hex">⬡</span><span class="persona-code">' + p.codename + '</span><span class="persona-name">' + p.name + '</span></div>'
      + '<div class="persona-round" data-round="1"><span class="persona-round-label">Initial</span><div class="persona-text">' + esc(magiBody(d.round1, d.round1Vote, false) || '…') + '</div></div>'
      + '<div class="persona-round" data-round="2"' + (r2has ? '' : ' hidden') + '><span class="persona-round-label">After debate</span><div class="persona-text">' + esc(magiBody(d.round2, d.round2Vote, false) || '…') + '</div></div>'
      + (Array.isArray(d.followups) ? d.followups : []).map(followupHTML).join('')
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
  // 端末のスリープも待ち時間に含め、更新が間引かれても実時刻の差分で秒数を保つ。
  var elapsed = function () { return Math.max(0, Math.floor((Date.now() - startedAt) / 1000)); };
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
  cleanHistory(history).forEach(function (item) {
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
      if (item.magi) magiReplay(turn, item, { ja: document.documentElement.lang === 'ja', id: item.mid, log: agentLog });
      applyReactionsToTurn(turn, item.reactions);
    }
  });
  agentScroll();
}

// ---- Lifecycle --------------------------------------------------------------
function showSplashIfEmpty() {
  if (!agentLog.children.length && !agentDead) agentLog.innerHTML = AGENT_HINT;
}
function cleanHistory(history) {
  return Array.isArray(history) ? history.filter(function (m) {
    return m && (m.role === 'assistant' ? typeof m.content === 'string' : m.role === 'user'
      && (typeof m.content === 'string' || Array.isArray(m.content) && m.content.every(function (p) {
        return p && (p.type === 'text' ? typeof p.text === 'string' : p.type === 'image_url' && p.image_url && typeof p.image_url.url === 'string');
      })));
  }).map(magiCleanItem) : [];
}
function initAgent() {
  agentHistory = cleanHistory(safeParse(safeGet('magi_current_history'), []));
  setAgentTitle(safeGet('magi_current_title') || '');
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
  safeRemove('magi_current_history');
  safeRemove('magi_current_title');
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
// MAGI_PRESENTATION_CORE_BEGIN
var MAGI_IDS=["MELCHIOR-1","BALTHASAR-2","CASPER-3"],MAGI_TIME={slot:600,pulse:300,pause:600,catchup:2e3,flicker:[240,300,360],phase:60,tick:30,character:18},MAGI_COLORS={ground:"#000000",orange:"#c8662a",teal:"#5fa8a0",blue:"#4f7aaa",off:"#000000",approve:"#4f7aaa",reject:"#d96a70",approveCarried:"#8ba4be",rejectCarried:"#e5a0a4",gray:"#888888",hatch:"#b5b5b5",ink:"#000000"};
function magiBody(text,vote,ja){return text===""&&vote?ja?"（理由なし）":"(no reason given)":text}
function magiMotion(text){if(typeof text!="string"||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(text))return null;var s=text.trim().replace(/[\r\n\t]+/g," ");return s&&s.length<=120?s:null}
function magiClean(v){if(!v||typeof v!="object")return null;if(v.votable===!1){var reason=v.reason===void 0?"not_votable":v.reason;return v.motion===""&&["not_votable","failed"].indexOf(reason)>=0?{motion:"",votable:!1,reason}:null}var motion=magiMotion(v.motion),t=v.tally,count={approve:0,reject:0,none:0},votes={};if(!motion||!t||!Number.isInteger(v.rounds)||v.rounds<1||v.rounds>5||typeof v.reason_missing!="boolean"||!v.votes)return null;for(var i=0;i<3;i++){var k=MAGI_IDS[i],x=v.votes[k];if(!x||["voted","carried","unreadable","absent"].indexOf(x.state)<0)return null;if(x.state==="voted"||x.state==="carried"){if(["approve","reject"].indexOf(x.vote)<0||!Number.isInteger(x.round)||x.round<1||x.round>v.rounds||(x.state==="carried"?x.round>=v.rounds||["no_response","unreadable"].indexOf(x.issue)<0:x.issue!==void 0))return null}else if(x.vote!==null||x.round!==null||x.issue!==void 0)return null;votes[k]={vote:x.vote,round:x.round,state:x.state},x.issue&&(votes[k].issue=x.issue),count[x.vote||"none"]++}return!["approve","reject","none"].every(function(k2){return Number.isInteger(t[k2])&&t[k2]===count[k2]})||v.result!==(count.approve>=2?"approve":count.reject>=2?"reject":"hold")?null:{motion,result:v.result,tally:count,rounds:v.rounds,votes,reason_missing:v.reason_missing}}
function magiCleanItem(item){var out=Object.assign({},item);delete out.mode,delete out.magi;var m=item.mode==="magi"?magiClean(item.magi):null;return m&&(out.mode="magi",out.magi=m),out}
function magiMarkdown(m,debate){if(!m)return"";function escape(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/[\\`*_{}\[\]()#+.!|~-]/g,"\\$&")}if(m.votable===!1)return"**Motion dismissed:** "+m.reason+`

`;var out="**Motion:** "+escape(m.motion)+`

**Resolution:** `+m.result+" ("+m.tally.approve+" approve / "+m.tally.reject+" reject / "+m.tally.none+` no vote)

`;return MAGI_IDS.forEach(function(k){var x=m.votes[k],d=debate&&debate[k];if(out+="- "+k+": "+(x.vote||"no vote")+" / "+x.state+(x.round?" / round "+x.round:"")+(x.issue?" / "+x.issue:"")+`
`,d){var vs=[1,2].filter(function(r){return d["round"+r]!==void 0}).map(function(r){return d["round"+r+"Vote"]}).concat((d.followups||[]).map(function(f){return f.vote}));out+="  Votes: "+vs.map(function(v){return["approve","reject"].indexOf(v)>=0?v:"no vote"}).join(" → ")+`
`}}),out+`
`}
function magiReceive(s,ev,d){function fail(){throw new Error("invalid_magi_sequence")}if(ev==="classification"||ev==="title"||ev==="error")return;if(!s.motion){if(ev==="motion"){(s.started||!s.classified||!s.candidate||!d||typeof d.votable!="boolean")&&fail(),(d.votable?!magiMotion(d.text):["not_votable","failed"].indexOf(d.reason)<0)&&fail(),s.motion=d,s.records={},s.requested={},MAGI_IDS.forEach(function(k){s.requested[k]=1});return}(s.candidate||ev==="verdict"||ev==="integrated_end")&&fail();return}if(ev==="motion"&&fail(),!s.motion.votable){(ev==="verdict"||ev==="integrated_end")&&fail();return}var pending=Object.keys(s.records).some(function(k){return s.records[k].vote_state==="pending"});function allFinal(){return MAGI_IDS.every(function(k){var v2=s.records[s.requested[k]+":"+k];return v2&&v2.vote_state==="final"})}if((ev==="pages"||s.verdict&&["persona","ask","judge","verdict"].indexOf(ev)>=0)&&fail(),ev==="persona"){(!d||MAGI_IDS.indexOf(d.codename)<0||!Number.isInteger(d.round)||d.round<1||d.round>5||typeof d.text!="string"||["pending","final"].indexOf(d.vote_state)<0||[null,"approve","reject"].indexOf(d.vote)<0||d.vote_state==="pending"&&d.vote!==null||d.absent===!0&&(d.vote!==null||d.vote_state!=="final"))&&fail();var key=d.round+":"+d.codename,old=s.records[key];if(old){if((old.text!==d.text||!!old.absent!=!!d.absent)&&fail(),old.vote_state===d.vote_state&&old.vote===d.vote)return;(old.vote_state!=="pending"||d.vote_state!=="final")&&fail()}else d.round===2?(s.round2||((pending||!allFinal())&&fail(),s.round2=!0,MAGI_IDS.forEach(function(k){s.records["1:"+k].absent||(s.requested[k]=2)})),s.requested[d.codename]!==2&&fail()):s.requested[d.codename]!==d.round&&fail();s.records[key]=Object.assign({},d);return}if(ev==="ask"){(pending||!allFinal()||!d||d.round!==Math.max.apply(null,Object.values(s.requested))+1||d.round<3||d.round>5||!Array.isArray(d.questions)||!d.questions.length)&&fail();var seen={};d.questions.forEach(function(q){(!q||MAGI_IDS.indexOf(q.codename)<0||seen[q.codename]||typeof q.text!="string"||!q.text.trim()||d.round<=s.requested[q.codename])&&fail(),seen[q.codename]=!0,s.requested[q.codename]=d.round});return}if(ev==="judge"){(pending||!allFinal()||!d||d.round<2||d.round!==Math.max.apply(null,Object.values(s.requested)))&&fail();return}if(ev==="verdict"){(pending||!allFinal()||!d||d.rounds!==Math.max.apply(null,Object.values(s.requested)))&&fail();var v=magiClean(Object.assign({},d,{motion:s.motion.text,reason_missing:!1}));v||fail(),s.verdict=v;return}if(ev==="integrated"){(!s.verdict||s.integratedEnd||!d||typeof d.delta!="string")&&fail(),s.reason=(s.reason||"")+d.delta;return}if(ev==="integrated_end"){(!s.verdict||s.integratedEnd||!(s.reason||"").trim())&&fail(),s.integratedEnd=!0;return}if(ev==="suggest"||ev==="done"){s.integratedEnd||fail();return}}
function magiNode(d,old){return d.absent?old&&old.vote?{state:"carried",vote:old.vote,round:old.round,issue:"no_response"}:{state:"absent",vote:null,round:null}:d.vote_state==="pending"?{state:"debating",vote:old&&old.vote||null,round:old&&old.round||null,pending:!0}:d.round===1&&d.vote?{state:"debating",vote:d.vote,round:d.round}:d.vote?{state:"voted",vote:d.vote,round:d.round}:old&&old.vote?{state:"carried",vote:old.vote,round:old.round,issue:"unreadable"}:{state:"unreadable",vote:null,round:null}}
function magiStep(previous,input,now,visible,reduced){var s=previous?JSON.parse(JSON.stringify(previous)):{nodes:{},latest:{},queue:[],nextSlot:0,round:1,finalAt:null,verdictAt:null,result:null,serial:0,awaiting:!1,resumeAfter:0},instant=!visible||reduced,wasInstant=s.instant;if(s.instant=instant,input&&input.event==="applied"&&s.awaiting&&(s.finalAt=now,s.awaiting=!1),input&&input.event==="persona"){var d=input.data,k=d.codename,key=d.round+":"+k,stamp=JSON.stringify([d.text,d.vote,d.vote_state,!!d.absent]);if(s.seen=s.seen||{},s.seen[key]===stamp)input=null;else{s.seen[key]=stamp,s.round=Math.max(s.round,d.round),s.latest[k]=magiNode(d,s.latest[k]);var q=s.queue.filter(function(x){return x.key===key})[0];q?q.node=s.latest[k]:s.queue.push({key,id:k,node:s.latest[k],at:now})}}if(input&&input.event==="ask"&&(s.round=input.data.round,input.data.questions.forEach(function(q2){var k2=q2.codename,old=s.latest[k2]||{};s.latest[k2]={state:"debating",vote:old.vote||null,round:old.round||null},s.queue.push({key:s.round+":"+k2,id:k2,node:s.latest[k2],at:now})})),input&&input.event==="motion"&&(MAGI_IDS.forEach(function(k2){s.latest[k2]=s.nodes[k2]={state:"debating",vote:null,round:null}}),s.motionStart=now,s.motionLength=input.data.text.length,s.resumeAfter=now+MAGI_TIME.slot),input&&input.event==="verdict"&&(s.result=input.data,s.round=input.data.rounds,s.queue=[],MAGI_IDS.forEach(function(k2){s.latest[k2]=input.data.votes[k2],s.queue.push({key:"final:"+k2,id:k2,node:s.latest[k2],at:now})})),input&&input.event==="finish"&&(s.fast=!0),instant||s.fast)s.nodes=JSON.parse(JSON.stringify(s.latest)),s.queue=[],s.result&&(s.finalAt=now,s.verdictAt=now-MAGI_TIME.pulse),s.awaiting=!1;else{if(wasInstant&&(s.resumeAfter=now+MAGI_TIME.slot,s.nextSlot=Math.max(s.nextSlot,now+MAGI_TIME.slot)),s.queue.length&&now-s.queue[0].at>MAGI_TIME.catchup){var latest={};s.queue.forEach(function(q2){latest[q2.id]=q2}),s.queue=Object.keys(latest).map(function(k2){return latest[k2]})}if(s.queue.length&&now>=s.nextSlot){var q=s.queue.shift();s.nodes[q.id]=q.node,s.serial++,s.emphasis=q.id,s.emphasisAt=now,s.nextSlot=now+MAGI_TIME.slot,s.result&&!s.queue.length&&s.finalAt===null&&(s.awaiting=!0)}s.result&&s.finalAt!==null&&s.verdictAt===null&&now>=s.finalAt+MAGI_TIME.pause&&(s.verdictAt=now,s.emphasis="verdict",s.emphasisAt=now)}var frame={nodes:{},result:s.verdictAt!==null?s.result:null,round:s.round,explanation:s.verdictAt!==null&&(instant||s.fast||now>=s.verdictAt+MAGI_TIME.pulse),ack:s.awaiting,emphasis:null,motionChars:instant||s.fast||s.result?s.motionLength:Math.min(s.motionLength||0,Math.floor((now-(s.motionStart||0))/MAGI_TIME.character)+1)};!instant&&!s.fast&&s.emphasisAt!==void 0&&now-s.emphasisAt<MAGI_TIME.pulse&&(frame.emphasis=s.emphasis);var blinking=!instant&&!s.fast&&!s.result&&!s.queue.length&&!frame.emphasis&&now>=s.resumeAfter,t=now-(s.motionStart||0);MAGI_IDS.forEach(function(k2,i){var n=s.nodes[k2]||{state:"debating",vote:null,round:null},color=n.vote?MAGI_COLORS[n.vote+(n.state==="carried"?"Carried":"")]:n.state==="debating"?MAGI_COLORS.blue:MAGI_COLORS.gray;(n.state==="debating"||n.vote)&&blinking&&(t+i*MAGI_TIME.phase)%MAGI_TIME.flicker[i]<MAGI_TIME.flicker[i]/2&&(color=MAGI_COLORS.off),frame.nodes[k2]=Object.assign({},n,{color,ink:color===MAGI_COLORS.off?MAGI_COLORS.orange:MAGI_COLORS.ink})}),blinking&&t%MAGI_TIME.slot<MAGI_TIME.pulse&&(frame.emphasis="verdict");var next=instant||s.fast?null:Math.floor(now/MAGI_TIME.tick+1)*MAGI_TIME.tick;return s.queue.length&&(next=Math.min(next===null?1/0:next,Math.max(now+1,s.nextSlot))),s.result&&!s.queue.length&&s.finalAt!==null&&s.verdictAt===null&&(next=Math.min(next===null?1/0:next,s.finalAt+MAGI_TIME.pause)),frame.explanation?next=null:frame.motionChars<s.motionLength&&!instant&&!s.fast&&(next=Math.min(next,now+MAGI_TIME.character)),{state:s,frame,next}}
// MAGI_PRESENTATION_CORE_END

// MAGI_VIEW_BEGIN

function createMagiView(turn,options){options=Object.assign({},options,{id:String(options.id||"panel").replace(/[^a-z0-9_-]/gi,"")||"panel"});var ja=!!options.ja,alive=options.alive||function(){return!0},status=options.announce||function(){},log=options.log,box=document.createElement("section");box.className="magi-panel";var shapes=["M43 258H190L290 342V439H43Z","M226 50H440V250L374 303H291L226 250Z","M475 258H623V439H375V342Z"],centers=[[167,367],[333,222],[499,367]],order=["CASPER-3","BALTHASAR-2","MELCHIOR-1"],svg='<svg viewBox="0 0 700 470" role="img" xmlns="http://www.w3.org/2000/svg"><title></title><defs><pattern id="magi-hatch-'+options.id+'" width="12" height="12" patternUnits="userSpaceOnUse"><rect width="12" height="12" fill="var(--magi-gray)"/><path d="M-3 3L3-3M0 12L12 0M9 15L15 9" stroke="var(--magi-hatch)" stroke-width="4"/></pattern></defs><path class="magi-rule" d="M24 50H224V59H24ZM24 54.5H224M24 124H224V133H24ZM24 128.5H224M443 50H643V59H443ZM443 54.5H643M443 124H643V133H443ZM443 128.5H643"/><g class="magi-mincho"><text x="40" y="112" font-size="62" textLength="174" lengthAdjust="spacingAndGlyphs">提訴</text><text x="456" y="112" font-size="62" textLength="174" lengthAdjust="spacingAndGlyphs">決議</text></g><g class="magi-meta"><text x="40" y="163" font-size="30" textLength="146" lengthAdjust="spacingAndGlyphs">CODE : '+("000"+Math.floor(Math.random()*1e3)).slice(-3)+'</text><text x="68" y="187">FILE:MAGI_SYS</text><text x="68" y="203">EXTENTION:6008</text><text x="68" y="219">EX_MODE:OFF</text><text x="68" y="235">PRIORITY:AAA</text></g><path class="magi-link" d="M263 280L238 302M404 280L427 302M290 370H375"/><text class="magi-mincho" x="333" y="336" text-anchor="middle" font-size="34">MAGI</text>';order.forEach(function(k,i){var c=centers[i];svg+='<g data-magi-node="'+k+'"><path class="magi-node" d="'+shapes[i]+'"/><g text-anchor="middle"><text class="magi-code" textLength="'+[174,201,218][i]+'" lengthAdjust="spacingAndGlyphs" x="'+c[0]+'" y="'+c[1]+'">'+k.replace("-","·")+"</text></g></g>"}),svg+='<g data-magi-verdict=""><rect x="496" y="182" width="125" height="54"/><rect x="500" y="186" width="117" height="46"/><text class="magi-mincho" x="558.5" y="223" font-size="36" text-anchor="middle"></text></g></svg>',box.innerHTML=svg,Object.keys(MAGI_COLORS).forEach(function(k){box.style.setProperty("--magi-"+k,MAGI_COLORS[k])});var motionBox=document.createElement("div");motionBox.className="magi-motion";var motionText=document.createElement("span");motionBox.appendChild(motionText);var full=document.createElement("button");full.type="button",full.textContent=ja?"全文":"Full text",full.setAttribute("aria-expanded","false"),motionBox.appendChild(full),full.addEventListener("click",function(){var on=full.getAttribute("aria-expanded")!=="true";full.setAttribute("aria-expanded",String(on)),motionBox.classList.toggle("expanded",on)});var roundEl=document.createElement("span");roundEl.className="magi-round",motionBox.appendChild(roundEl);var details=document.createElement("details");details.className="magi-record";var summary=document.createElement("summary");details.appendChild(summary);var cards=turn.querySelector(".agent-personas");cards&&details.appendChild(cards);var reply=turn.querySelector(".agent-reply");turn.insertBefore(box,reply),turn.insertBefore(motionBox,reply),turn.appendChild(details);var state=null,timer=null,motion="",latestFrame=null,announced=!1,closed=!1,waiters=[],tracking=!0,programScroll=null,media=window.matchMedia("(prefers-reduced-motion: reduce)");function now(){return performance.now()}function scroll(){if(!(!log||!tracking||document.hidden)){var r=reply.getBoundingClientRect(),v=log.getBoundingClientRect();r.bottom>v.bottom&&(log.scrollTop+=Math.min(r.bottom-v.bottom,Math.max(0,r.top-v.top)),programScroll=log.scrollTop)}}function pin(){if(log&&tracking&&!document.hidden){log.scrollTop+=box.getBoundingClientRect().top-log.getBoundingClientRect().top;programScroll=log.scrollTop}}function onScroll(){programScroll!==log.scrollTop&&(tracking=log.scrollHeight-log.scrollTop-log.clientHeight<24);programScroll=null}function onToggle(){details.open&&(tracking=!1)}function resize(){var viewport=window.visualViewport?window.visualViewport.height:window.innerHeight;box.style.maxHeight="min(60vh,"+Math.max(0,Math.min(viewport,log?log.clientHeight:viewport)*.6)+"px)",state&&!latestFrame.explanation&&pin()}function note(n){return n.issue==="no_response"?ja?"応答なし":"No response":n.issue==="unreadable"?ja?"票を判定できない":"Unreadable vote":""}function label(n){return n.state==="debating"?n.pending?ja?"票を確認中":"Checking vote":n.vote?(n.round===1?ja?"初回: ":"Initial: ":ja?"第"+n.round+"回の票: ":"Round "+n.round+": ")+magiWord(n.vote,ja):ja?"審議中":"Deliberating":n.state==="absent"?"NO RESPONSE":n.state==="unreadable"?ja?"票を判定できない":"Unreadable vote":magiWord(n.vote,ja)+(n.state==="carried"?ja?"（第"+n.round+"回の票）":" (round "+n.round+")":"")}function render(frame){latestFrame=frame,motionText.textContent=motion.slice(0,full.getAttribute("aria-expanded")==="true"?motion.length:frame.motionChars),MAGI_IDS.forEach(function(k){var el=box.querySelector('[data-magi-node="'+k+'"]'),n=frame.nodes[k];el.querySelector(".magi-node").style.fill=n.state==="unreadable"?"url(#magi-hatch-"+options.id+")":n.color,el.style.color=n.ink,el.querySelector(".magi-node").style.strokeWidth=frame.emphasis===k?"4":"1.2"});var v=frame.result,r=v?v.result:null,ver=box.querySelector("[data-magi-verdict]"),fill=r==="hold"?MAGI_COLORS.orange:r?MAGI_COLORS[r]:MAGI_COLORS.ground;ver.style.color=r?MAGI_COLORS.ink:MAGI_COLORS.orange,ver.querySelectorAll("rect").forEach(function(el){el.style.fill=fill,el.style.strokeWidth=frame.emphasis==="verdict"?"3":"1.2"});var word=r==="approve"?"承認":r==="reject"?"否決":r==="hold"?"保留":"審議中";ver.querySelector(".magi-mincho").textContent=word;var desc=motion+" / "+(r?magiWord(r,ja):ja?word:"Deliberating")+" / "+MAGI_IDS.map(function(k){var n=frame.nodes[k],issue=note(n);return k+": "+label(n)+(issue&&n.state==="carried"?", "+issue:"")}).join(", ");box.querySelector("svg").setAttribute("aria-label",desc),box.querySelector("title").textContent=desc,roundEl.textContent=frame.round>=3?ja?"第"+frame.round+"回審議 "+frame.round+"/5":"Round "+frame.round+"/5":"",summary.textContent=ja?"審議記録（3人格・第"+frame.round+"回まで）":"Deliberation record (3 personas, "+frame.round+" round"+(frame.round>1?"s":"")+")",v&&!announced&&(announced=!0,status((ja?"MAGI の":"MAGI ")+magiSummary(v,ja))),frame.explanation&&options.explain&&(options.explain(),scroll())}function settle(){latestFrame&&latestFrame.explanation&&waiters.splice(0).forEach(function(resolve){resolve()})}function advance(input){if(closed||!alive()){dispose();return}clearTimeout(timer);var t=now(),out=magiStep(state,input,t,!document.hidden,media.matches);state=out.state,render(out.frame),out.frame.ack&&(out=magiStep(state,{event:"applied"},now(),!document.hidden,media.matches),state=out.state,render(out.frame)),settle(),out.next!==null&&(timer=setTimeout(function(){advance(null)},Math.max(1,out.next-now())))}function dispose(){closed||(closed=!0,clearTimeout(timer),document.removeEventListener("visibilitychange",changed),media.removeEventListener("change",changed),window.removeEventListener("resize",resize),window.visualViewport&&window.visualViewport.removeEventListener("resize",resize),log&&log.removeEventListener("scroll",onScroll),details.removeEventListener("toggle",onToggle),waiters.splice(0).forEach(function(resolve){resolve()}))}function changed(){advance(null)}return document.addEventListener("visibilitychange",changed),media.addEventListener("change",changed),window.addEventListener("resize",resize),window.visualViewport&&window.visualViewport.addEventListener("resize",resize),log&&log.addEventListener("scroll",onScroll,{passive:!0}),details.addEventListener("toggle",onToggle),resize(),{push:function(ev,d){ev==="motion"&&(motion=d.text,motionText.textContent=motion),advance({event:ev,data:d})},wait:function(){return latestFrame&&latestFrame.explanation?Promise.resolve():new Promise(function(resolve){waiters.push(resolve)})},finish:function(){advance({event:"finish"})},dispose,ready:function(){return!!(latestFrame&&latestFrame.explanation)},explanationChanged:scroll,start:pin}}
function magiDismiss(turn,reason,ja){var row=document.createElement("div");row.className="magi-dismiss",row.textContent=reason==="failed"?ja?"議題を整えられませんでした — 通常の回答に切り替えます":"Could not prepare the motion — answering normally":ja?"提訴却下 — 通常の回答に切り替えます":"Motion dismissed — answering normally",turn.insertBefore(row,turn.firstChild)}
function magiBadge(turn,d,ja){var card=turn.querySelector('.persona-card[data-codename="'+d.codename+'"]'),slot=card&&card.querySelector('.persona-round[data-round="'+d.round+'"]');if(!slot)return;var prev="",round=0;card.querySelectorAll(".persona-round").forEach(function(x){var r=+x.dataset.round;if(r<d.round&&r>round&&x.dataset.magiVote){prev=x.dataset.magiVote;round=r}});slot.dataset.magiVote=d.vote_state==="final"?d.vote||"":"";var b=slot.querySelector(".magi-vote-badge");b||(b=document.createElement("span"),b.className="magi-vote-badge",slot.appendChild(b));b.textContent=d.vote_state==="pending"?"…":d.vote?(prev&&prev!==d.vote?magiWord(prev,ja)+"→":"")+magiWord(d.vote,ja):d.absent?"NO RESPONSE":ja?"票なし":"NO VOTE"}
function magiWord(v,ja){return(ja?{approve:"承認",reject:"否決",hold:"保留"}:{approve:"APPROVED",reject:"REJECTED",hold:"HOLD"})[v]}
function magiSummary(m,ja){var t=m.tally,w=magiWord(m.result,ja);return(ja?"決議: ":"Resolution: ")+w+(ja?"（賛成"+t.approve+"・反対"+t.reject+"・票なし"+t.none+"）":" ("+t.approve+" approve / "+t.reject+" reject / "+t.none+" no vote)")}
function magiMissing(turn,ja){turn.querySelector(".agent-reply-body").textContent=ja?"決議の説明を取得できませんでした":"Could not retrieve the resolution explanation",turn.querySelector(".agent-reply .reaction-bar")?.remove()}
function magiReplay(turn,item,options){var m=magiClean(item.magi);if(m){if(m.votable===!1){magiDismiss(turn,m.reason,options.ja);return}var v=createMagiView(turn,options);if(v.push("motion",{text:m.motion}),v.push("verdict",m),v.finish(),v.dispose(),MAGI_IDS.forEach(function(k){var d=item.debate&&item.debate[k];d&&([1,2].forEach(function(r){d["round"+r]!==void 0&&magiBadge(turn,{codename:k,round:r,vote:d["round"+r+"Vote"],vote_state:"final",absent:d["round"+r]==="[NO RESPONSE]"},options.ja)}),(d.followups||[]).forEach(function(f){magiBadge(turn,{codename:k,round:f.round,vote:f.vote,vote_state:"final",absent:f.text==="[NO RESPONSE]"},options.ja)}))}),m.reason_missing)magiMissing(turn,options.ja)}}
// MAGI_VIEW_END

var agentSendSequence = 0;

async function parseSSE(body, handlers, onChunk) {
  const reader = body.getReader(), dec = new TextDecoder();
  let buf = '', skipLF = false;
      const classificationState = { started: false, classified: false, language: handlers.replyLanguage || null, panel: handlers.magiPanel === true };
  const block = (text) => {
    handlers.signal?.throwIfAborted();
    let ev = 'message', data = '';
    text.split('\n').forEach(line => {
      if (line.startsWith('event:')) ev = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).replace(/^ /, '') + '\n';
    });
    if (!data || ['classification','title','error','motion','persona','ask','judge','verdict','integrated','integrated_end','pages','suggest','done'].indexOf(ev) < 0) return false;
    const parsed = JSON.parse(data.replace(/\n$/, ''));
    receiveClassification(classificationState, ev, parsed);
        if (handlers[ev]) handlers[ev](parsed);
    return ev === 'done' || ev === 'error';
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      handlers.signal?.throwIfAborted();
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
      var href = u.href;
      if (daily) {
        // 日刊の受け渡しは #q=（assets/site-search-design.md 8.1）
        if (!['/job/nitoridaily/', '/job/retailtechdaily/'].includes(u.pathname)) return;
        var q;
        if (!u.search && u.hash.indexOf('#q=') === 0 && !/[&#]/.test(u.hash.slice(3))) q = decodeURIComponent(u.hash.slice(3));
        else return;
        q = q.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
        if (!q || q.length > 200) return;
        href = u.origin + u.pathname + '#q=' + encodeURIComponent(q);
      } else if (u.search || u.hash) return;
      var a = document.createElement('a'); a.className = 'agent-page'; a.href = href;
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
  const messages = cleanHistory(history).slice(-AGENT_MAX_HISTORY).map(({ thinkingSeconds, ...m }) => ({ ...m }));
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
  var startedAt = Date.now();
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
  var reply = '', errored = false, timedOut = false, suggestion = '', completed = false, sitePages = null, classified = false;
      var magiMeta = null, magiView = null, integratedEnd = false, magiRetained = false;
      var sendId = ++agentSendSequence;
  var debateData = {};
  AGENT_PERSONAS.forEach(function (p) { debateData[p.codename] = { round1: '…', round2: '…', followups: [] }; });

  var ctrl = new AbortController();
  var conversationId = ensureAgentConversation();
  var gen = agentGen; agentCtrl = ctrl;

  var dropped = function () { return gen !== agentGen || conversationId !== currentSessionId || sendId !== agentSendSequence; };
  var idleTimer = null;
  var watch = function (ms) {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () { timedOut = true; ctrl.abort(); }, ms || 70000);
  };
      // MAGI_SEND_BEGIN
      function isMagiJa() { return document.documentElement.lang === 'ja'; }
      function presentMagiReply() { if (!dropped() && magiView && magiView.ready()) { replyBody.textContent = reply; if (reply.trim()) thinking.finish(); } }
      function keepMagi() {
        if (!magiMeta || !magiMeta.result || dropped()) return false;
        turn.querySelectorAll('.persona-card.thinking').forEach(function (c) { c.classList.remove('thinking'); });
        magiRetained = true; magiMeta.reason_missing = !integratedEnd; if (magiView) magiView.finish();
        if (!integratedEnd) { reply = magiSummary(magiMeta, isMagiJa()); magiMissing(turn, isMagiJa()); } else replyBody.textContent = reply;
        return true;
      }
      ctrl.signal.addEventListener('abort', function () { if (magiView) { if (dropped()) magiView.dispose(); else magiView.finish(); } thinking.cancel(); }, { once: true });
      // MAGI_SEND_END

  watch(30000);
  try {
    var theme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    var outbound = prepareAgentMessages(agentHistory, sendContent);
    var res = await fetch(AGENT_API, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ messages: outbound, theme, suggest: true, site_pages: true, page: 'app', adaptive_debate: true }, classificationFields(agentHistory, agentReplyLanguage, 'en', 'chat', true))),
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
        replyLanguage: agentReplyLanguage, magiPanel: true, signal: ctrl.signal,
            // MAGI_EVENTS_BEGIN
            motion: function (d) {
              if (dropped()) return;
              if (!d.votable) { magiMeta = { motion: '', votable: false, reason: d.reason }; magiDismiss(turn, d.reason, isMagiJa()); return; }
              magiMeta = { motion: d.text };
              magiView = createMagiView(turn, { ja: isMagiJa(), id: mid, log: agentLog, alive: function () { return !dropped(); }, announce: announceAgent, explain: presentMagiReply });
              magiView.push('motion', d); magiView.start();
            },
            verdict: function (d) { if (dropped()) return; magiMeta = Object.assign({}, d, { motion: magiMeta.motion, reason_missing: false }); magiView.push('verdict', d); },
            integrated_end: function () { if (!dropped()) integratedEnd = true; },
            // MAGI_EVENTS_END
        classification: function (d) { if (!dropped()) { classified = true; saveAgentLanguage(d.reply_language); } },
        title: function (d) { if (d && d.text && !dropped()) setAgentTitle(d.text); },

        persona: function (d) {
          if (dropped()) return;
          var cn = (window.CSS && CSS.escape) ? CSS.escape(d.codename) : d.codename;
          var card = turn.querySelector('.persona-card[data-codename="' + cn + '"]');
          if (!card) return;
          var slot = card.querySelector('.persona-round[data-round="' + (Number(d.round) || 1) + '"]');
          if (slot) { slot.hidden = false; slot.querySelector('.persona-text').textContent = magiBody(d.text, d.vote, isMagiJa()); }
          if (d.round >= 2 || d.absent) card.classList.remove('thinking');
          if (classified && d.absent && d.round === 1) card.querySelector('.persona-round[data-round="2"]')?.remove();
          if (!magiView) agentScroll();
          var deb = debateData[d.codename];
          if (!deb) return;
          var later = d.round >= 3, key = later ? 'text' : d.round === 2 ? 'round2' : 'round1';
          var record = later ? deb.followups.find(function (x) { return x.round === d.round; }) : deb;
          if (record) { record[key] = d.text; if (magiView) record[later ? 'vote' : key + 'Vote'] = d.vote; }
          if (magiView) { magiBadge(turn, d, isMagiJa()); magiView.push('persona', d); }
        },
        // 統合人格が聞き返した（第3回以降）。問いを向けた人格のカードに枠を足し、考え中に戻す
        ask: function (d) {
          if (dropped() || !d || !Array.isArray(d.questions)) return;
          d.questions.forEach(function (q) {
            var qcn = (window.CSS && CSS.escape) ? CSS.escape(q.codename) : q.codename;
            var qcard = turn.querySelector('.persona-card[data-codename="' + qcn + '"]');
            var deb = debateData[q.codename];
            if (!qcard || !deb) return;
            var f = { round: Number(d.round) || 0, ask: String(q.text || ''), text: '…' };
            deb.followups.push(f);
            qcard.querySelector('.reaction-bar').insertAdjacentHTML('beforebegin', followupHTML(f));
            qcard.classList.add('thinking');
          });
          if (magiView) magiView.push('ask', d); else agentScroll();
        },
        integrated: function (d) {
              if (dropped()) return;
              turn.querySelectorAll('.persona-card.thinking').forEach(function (c) { c.classList.remove('thinking'); });
              reply += d.delta || '';
              if (magiView) { presentMagiReply(); if (magiView.ready()) magiView.explanationChanged(); }
              else { if (reply.trim()) thinking.finish(); replyBody.textContent = reply; agentScroll(); }
            },
            error: function (d) {
              if (dropped()) return; errored = true;
              if (keepMagi()) return;
              thinking.cancel(); turn.querySelectorAll('.persona-card.thinking').forEach(function (c) { c.classList.remove('thinking'); });
              replyEl.remove(); renderAgentError(d);
            },
            // 次の質問の予測。答えが最後まで届いたときだけ、下で入力欄に出す
        suggest: function (d) { suggestion = (d && typeof d.text === 'string') ? d.text : ''; },
        pages: function (d) { if (!dropped()) sitePages = d; },
        done: function () { completed = true; clearTimeout(idleTimer); },
      }, watch);
          if (magiView && completed && !errored && !dropped()) await magiView.wait();
      if (!dropped() && !errored && (!completed || !reply.trim())) {
        errored = true; if (!keepMagi()) turn.remove();
        if (!magiRetained) renderAgentError({ message: 'The complete reply was not received. Please try again.', code: 'incomplete_reply' });
      }
    }
  } catch (err) {
    errored = true;
    if (dropped()) return;
    if (!keepMagi()) turn.remove();
    // Stopped with the stop button: no error; the question goes back into the input below.
    if (!magiRetained && !ctrl.userStopped) {
      if (timedOut || err.name === 'AbortError') { renderAgentError({ message: 'Request timed out. Please try again.', code: 'timeout' }); }
      else { console.error('[agent] fetch failed', AGENT_API, err); renderAgentError({ message: 'Could not receive the reply. Check your connection and try again.', code: 'network_error' }); }
    }
  } finally {
    clearTimeout(idleTimer);
    if (magiView) magiView.dispose();
    if (!completed || errored || dropped()) thinking.cancel();
    if (agentCtrl === ctrl) agentCtrl = null;
    // A dropped request restores the button too, unless a newer send has already taken it over.
    if (!dropped() || !agentBusy) setAgentStopMode(false);
    if (dropped()) delete pendingReactions[mid];
    if (!dropped()) {
      replyEl.classList.remove('streaming');
      agentBusy = false;
      if (!agentDead) { agentInput.disabled = false; agentSendBtn.disabled = false; attachBtn.disabled = false; if (!document.hidden) agentInput.focus({ preventScroll: true }); }
      else agentSendBtn.disabled = true;
    }
  }
  if (dropped()) { delete pendingReactions[mid]; return; }
  if (completed && reply.trim() && !errored || magiRetained) {
    renderAgentPages(replyEl, sitePages);
    if (!magiView) announceAgent('MAGI replied. ' + reply);
    // この送信だけのオブジェクトで、ストリーム終了後は更新しないので、そのまま保存する。
    Object.keys(debateData).forEach(function (cn) { if (debateData[cn].round2 === '…') delete debateData[cn].round2; });
    agentHistory.push({ role: 'assistant', content: reply, thinkingSeconds: thinking.finish(), debate: debateData, ...(magiMeta ? { mode: 'magi', magi: magiMeta } : {}), mid: mid, reactions: pendingReactions[mid] || {} });
    delete pendingReactions[mid];
    safeStore('magi_current_history', agentHistory);
    syncCurrentToSaved();
    updateAgentActionButtons();
    setAgentSuggestion(completed && !magiMeta?.reason_missing ? suggestion : '');
  } else {
    turn.remove(); u.remove(); delete pendingReactions[mid];
    var last = agentHistory[agentHistory.length - 1];
    if (last && last.role === 'user' && last.content === storeContent) agentHistory.pop();
    safeStore('magi_current_history', agentHistory); syncCurrentToSaved(); updateAgentActionButtons();
    // 中断・通信失敗でも、質問と画像を戻して同じ会話で送り直せるようにする。
    if (!agentInput.value) { agentInput.value = text; attachments = atts; renderAttachTray(); fitAgentInput(); }
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
    // いちばん新しい回の意見（届いていない回は飛ばす。無ければ初回）
    if (card) {
      var texts = Array.prototype.map.call(card.querySelectorAll('.persona-round:not([hidden]) .persona-text'), function (el) { return el.textContent.trim(); });
      response = texts.slice(1).reverse().filter(function (t) { return t && t !== '…'; })[0] || texts[0] || '';
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
async function deleteReaction(target, receipt) {
  if (!receipt || !receipt.id || !receipt.delete_token) return true;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(REACT_API, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'remove', target, id: receipt.id, delete_token: receipt.delete_token }),
      keepalive: true, signal: ctrl.signal,
    });
    return res.ok && (await res.json()).ok === true;
  } catch (_) { return false; }
  finally { clearTimeout(timer); }
}
// 登録中の取り消しは、削除トークンを受け取ってから処理する。通信中の状態は保存しない。
const reactionRegistrations = new WeakMap();
const reactionRemovals = new WeakSet();
function registerReaction(bar, target, em, ctx) {
  const store = reactionStoreFor(bar);
  const cell = { em };
  if (store) { store[target] = cell; persistReactions(); }
  const pending = sendReaction(target, em, ctx.request, ctx.response).then(receipt => {
    if (!receipt) return;
    if (store && store[target] === cell) {
      cell.id = receipt.id; cell.delete_token = receipt.delete_token; persistReactions();
    } else deleteReaction(target, receipt);
  });
  reactionRegistrations.set(cell, pending);
}
async function unregisterReaction(bar, target) {
  const store = reactionStoreFor(bar);
  const receipt = store && store[target];
  if (!receipt) return true;
  if (typeof receipt === 'object') {
    if (reactionRemovals.has(receipt)) return false;
    reactionRemovals.add(receipt);
  }
  try {
    await reactionRegistrations.get(receipt);
    if (!await deleteReaction(target, receipt)) return false;
    if (store[target] === receipt) { delete store[target]; persistReactions(); }
    return true;
  } finally { if (typeof receipt === 'object') reactionRemovals.delete(receipt); }
}
async function undoReaction(bar, target, resetBtn) {
  // 見た目も削除成功後に戻す。失敗時はトークンと選択を保ち、もう一度押して再試行できる。
  if (bar.dataset.removing === 'true') return;
  bar.dataset.removing = 'true';
  try {
    if (await unregisterReaction(bar, target)) { resetBtn(); bar.classList.remove('locked'); }
    else renderAgentError({ message: 'Could not remove the reaction. Please try again.', code: 'reaction_remove_failed' });
  } finally { delete bar.dataset.removing; }
}
function flashReactBtn(btn, sym) {
  var orig = btn.innerHTML; btn.innerHTML = sym;
  setTimeout(function () { btn.innerHTML = orig; }, 1200);
}
function closeEmojiPops() { document.querySelectorAll('.emoji-pop').forEach(function (p) { p.remove(); }); }

// ---- Click delegation -------------------------------------------------------
agentLog.addEventListener('click', function (e) {
  if (e.target.closest('[data-install-agent]')) { showInstallPanel(); return; }
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
      undoReaction(bar2, ctx2.target, function () { btn.classList.remove('liked'); });
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
      undoReaction(bar2, ctx2.target, function () { btn.classList.remove('reacted'); btn.innerHTML = ICON_REACT; });
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
var AGENT_PANEL_IDS = ['agent-history-panel', 'agent-info-panel', 'agent-install-panel'];
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
function showInstallPanel() {
  var panel = makeAgentPanel('agent-install-panel', 'Use MAGI on iPhone',
    '<ul>'
    + '<li>Open <strong>tk.st/magi-app/www/</strong> in <strong>Safari</strong> on your iPhone.</li>'
    + '<li>Tap <strong>Share</strong> (the square with an upward arrow). Depending on the Safari layout, open the page menu first.</li>'
    + '<li>Choose <strong>Add to Home Screen</strong>. If it is missing, find it under <strong>Edit Actions</strong>.</li>'
    + '<li>If shown, turn on <strong>Open as Web App</strong>, then tap <strong>Add</strong>.</li>'
    + '<li>Launch MAGI from its new Home Screen icon. Chat requires an internet connection.</li>'
    + '</ul>');
  if (panel) panel.querySelector('.agent-panel-close').focus();
}
var ICON_TRASH = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
function renderSavedSessionsList() {
  var list = document.getElementById('agent-history-list');
  if (!list) return;
  var sessions = safeParse(safeGet('magi_saved_sessions'), []);
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
  var sessions = safeParse(safeGet('magi_saved_sessions'), []);
  var session = sessions.find(function (s) { return s.id === id; });
  if (!session) return;
  dropAgentRequest();
  agentBusy = false;
  agentHistory = cleanHistory(session.history);
  safeStore('magi_current_history', agentHistory);
  setAgentTitle(session.title || '');
  currentSessionId = session.id;
  safeStore('magi_current_session_id', currentSessionId);
  saveAgentLanguage(session.reply_language);
  agentDead = false; agentDegraded.classList.add('hidden'); agentDegraded.textContent = '';
  agentInput.disabled = false; agentSendBtn.disabled = false; attachBtn.disabled = false;
  setAgentSuggestion('');
  renderHistoryToLog(agentHistory);
  updateAgentActionButtons();
}
function deleteSavedSession(id) {
  if (currentSessionId === id) archiveCurrentHistory();
  var sessions = safeParse(safeGet('magi_saved_sessions'), []);
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
    + '<li>Ask a yes/no question such as "Should I go for ramen tonight?" MAGI automatically deliberates and votes on eligible questions. For an explanation without a vote, ask: "Without taking a vote, outline the factors to consider for the previous proposal."</li>'
    + '<li>Strict limits: max <strong>1,000 characters</strong> per input, limited output tokens, <strong>60 daily requests</strong>, and context from the latest <strong>12 messages</strong>.</li>'
    + '<li>Images can be attached (up to <strong>4 per message</strong>, resized on your device before sending) and are sent to the API just like text.</li>'
    + '<li>When site guidance is enabled, OpenAI also uses up to 500 characters of your latest message and the public page list to choose relevant tk.st links. These links are displayed for that reply and are not saved in chat history.</li>'
    + '<li>By default, inputs are <strong>not saved</strong> in the database, unless you <strong>react</strong> to a reply (👍/emoji) to help improve MAGI.</li>'
    + '<li>Your <strong>IP address</strong> is recorded in the database to enforce the usage limits (as a count per day), and is saved together with an exchange when you react to it.</li>'
    + '<li>Chat history is stored in your device\'s <strong>local storage</strong> (not permanent; please export important chats).</li>'
    + '<li>Powered by <strong>OpenAI API</strong>, <strong>DeepSeek API</strong> and <strong>Gemini API</strong>. Each persona runs on a different one, so every input (including images) is <strong>sent to all three</strong>.</li>'
    + '<li>OpenAI: sent to the US and retained up to 30 days for abuse monitoring; not used for AI training by default. Google (Gemini API, free tier): <strong>used to improve Google\'s products and train its models, and may be read by human reviewers</strong>. DeepSeek: <strong>stored on servers in China and may be used to train its models</strong>.</li>'
    + '<li>To classify each request, the latest user message and up to two earlier user messages are also sent to <strong>TypeSafe AI</strong> (Jev, a classification model); the first user message is used only to fix the conversation language. Images, AI replies and DJ context are excluded. The language is stored with the conversation in this browser; classification results are not stored in the site database. TypeSafe states that it does not train models on API inputs.</li>'
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
  cleanHistory(agentHistory).forEach(function (item) {
    if (item.role === 'user') {
      // 画像はサムネの data URL なので本文に埋め込まず、枚数だけ残す
      var n = contentImages(item.content).length;
      md += '## 🧑‍💻 User\n' + contentText(item.content) + (n ? '\n\n(' + n + ' image attachment' + (n > 1 ? 's' : '') + ')' : '') + '\n\n';
      return;
    }
    md += '## ✦ MAGI\n' + item.content + '\n\n';
    if (item.debate) {
      md += '### 🌐 MAGI Deliberation Process\n\n' + magiMarkdown(item.magi, item.debate);
      AGENT_PERSONAS.forEach(function (p) {
        var deb = item.debate[p.codename];
        if (!deb) return;
        md += '#### 🧬 ' + p.codename + ' (' + p.name + ')\n';
        if (deb.round1 && deb.round1 !== '…') md += '* **Initial View:** ' + deb.round1 + '\n';
        if (deb.round2 && deb.round2 !== '…') md += '* **After Debate:** ' + deb.round2 + '\n';
        (Array.isArray(deb.followups) ? deb.followups : []).forEach(function (f) {
          if (f && f.text && f.text !== '…') md += '* **Round ' + f.round + '** (asked: ' + f.ask + '): ' + f.text + '\n';
        });
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
var installBtn = document.getElementById('btn-install-agent');
installBtn.hidden = !WEB_INSTALL;
installBtn.addEventListener('click', showInstallPanel);

document.getElementById('btn-theme').addEventListener('click', function () {
  var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  safeStore('magi_theme', next);
});

// theme restore
(function () {
  var t = safeGet('magi_theme');
  if (t) document.documentElement.setAttribute('data-theme', t);
})();

// service worker (PWA)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () { }); });
}

initAgent();
if (WEB_INSTALL && location.hash === '#install') showInstallPanel();
