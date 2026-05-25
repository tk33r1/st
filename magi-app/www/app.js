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
var API_BASE = (function () {
  var q = new URLSearchParams(location.search).get('api');
  if (q) return q.replace(/\/$/, '');
  if (window.MAGI_API_BASE) return String(window.MAGI_API_BASE).replace(/\/$/, '');
  return 'https://workers.tk.st';
})();
var AGENT_API = API_BASE + '/magi2/chat';
var REACT_API = API_BASE + '/magi2/react';
var AGENT_MAX_HISTORY = 12;

var AGENT_PERSONAS = [
  { codename: 'MELCHIOR-1', name: 'ENTHUSIAST', desc: 'The chaotic self. An impulsive, unpredictable geek who runs on instinct — fired up by Harleys, custom PCs, idols, wine, and above all, music.' },
  { codename: 'BALTHASAR-2', name: 'HUMANIST', desc: 'The compassionate self. A poetic, introverted dreamer who has internalized Fromm, Stoicism, and Buddhism. Always centered on humanity.' },
  { codename: 'CASPER-3', name: 'STRATEGIST', desc: 'The logical self. A data-driven strategist relentlessly solving for the optimal answer, embracing both reproducible tactics and novelty.' },
];
var REACT_EMOJIS = ['👎', '❤️', '😂', '🎉', '🔥', '👏', '🙏', '💯', '🤔', '👀', '😮', '😢', '😍', '🤯', '🙌', '🥳', '😎', '😅', '🤝', '💪', '✨', '💡', '✅', '🚀', '👌', '🫡', '🤩', '😇', '🥹', '🫶'];

// ---- DOM / state ------------------------------------------------------------
var agentLog = document.getElementById('agent-log');
var agentInput = document.getElementById('agent-input');
var agentSendBtn = document.getElementById('agent-send');
var agentDegraded = document.getElementById('agent-degraded');
var barTitle = document.getElementById('bar-title');
var agentHistory = [], agentBusy = false, agentDead = false, agentTitle = '';
var pendingReactions = {};

// ---- Helpers ----------------------------------------------------------------
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function safeParse(raw, fallback) { try { return raw ? JSON.parse(raw) : fallback; } catch (_) { return fallback; } }
var genMid = function () { return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); };
var agentScroll = function () { agentLog.scrollTop = agentLog.scrollHeight; };

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
  + '<div class="magi-ver">ver 2.3 <button type="button" id="btn-info-agent" class="magi-info-btn" title="System & Privacy"><svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg></button></div>'
  + '<div class="magi-nodes">' + AGENT_PERSONAS.map(function (p) { return '<button type="button" class="magi-node" data-codename="' + p.codename + '">' + p.codename.replace('-', '·') + '</button>'; }).join('') + '</div>'
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
function persistReactions() { localStorage.setItem('magi_current_history', JSON.stringify(agentHistory)); syncCurrentToSaved(); }

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
  var title = agentTitle || (firstUserMsg.content.slice(0, 30) + (firstUserMsg.content.length > 30 ? '...' : ''));
  var sessions = safeParse(localStorage.getItem('magi_saved_sessions'), []);
  if (currentSessionId) {
    sessions = sessions.filter(function (s) { return s.id !== currentSessionId; });
  } else {
    currentSessionId = 'session_' + Date.now();
    localStorage.setItem('magi_current_session_id', currentSessionId);
  }
  sessions.unshift({ id: currentSessionId, timestamp: Date.now(), title: title, history: agentHistory.slice() });
  if (sessions.length > 50) sessions.pop();
  localStorage.setItem('magi_saved_sessions', JSON.stringify(sessions));
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
var reId = function (v) { return (v && typeof v === 'object' ? v.id : undefined); };

// ---- Render persisted history ----------------------------------------------
function turnHTML(item) {
  var debate = item.debate || {};
  var personas = AGENT_PERSONAS.map(function (p) {
    var d = debate[p.codename] || { round1: '…', round2: '…' };
    var r2has = d.round2 && d.round2 !== '…';
    return '<div class="persona-card" data-codename="' + p.codename + '">'
      + '<div class="persona-head"><span class="persona-hex">⬡</span><span class="persona-code">' + p.codename + '</span><span class="persona-name">' + p.name + '</span></div>'
      + '<div class="persona-round" data-round="1"><span class="persona-round-label">Initial</span><div class="persona-text">' + esc(d.round1 || '…') + '</div></div>'
      + '<div class="persona-round" data-round="2"' + (r2has ? '' : ' hidden') + '><span class="persona-round-label">After debate</span><div class="persona-text">' + esc(d.round2 || '…') + '</div></div>'
      + reactionBarHTML(p.codename)
      + '</div>';
  }).join('');
  return '<div class="agent-personas">' + personas + '</div>'
    + '<div class="agent-reply"><span class="agent-who">✦ Shinya Takeda</span><span class="agent-reply-body">' + esc(item.content || '') + '</span>' + reactionBarHTML('integrated') + '</div>';
}
function renderHistoryToLog(history) {
  agentLog.innerHTML = '';
  history.forEach(function (item) {
    if (item.role === 'user') {
      var u = document.createElement('div'); u.className = 'agent-user';
      u.innerHTML = '<span>' + esc(item.content) + '</span>';
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
function resetAgent() {
  archiveCurrentHistory();
  agentHistory = []; agentBusy = false; agentDead = false;
  localStorage.removeItem('magi_current_history');
  localStorage.removeItem('magi_current_title');
  agentLog.innerHTML = '';
  agentDegraded.classList.add('hidden'); agentDegraded.textContent = '';
  agentInput.disabled = false; agentSendBtn.disabled = false; agentInput.value = '';
  closeAgentPanels();
  setAgentTitle('');
  showSplashIfEmpty();
  updateAgentActionButtons();
}
function agentDegrade(msg) {
  agentDead = true;
  agentDegraded.textContent = msg || 'MAGI is currently unreachable. Check your connection and try again.';
  agentDegraded.classList.remove('hidden');
  agentInput.disabled = true; agentSendBtn.disabled = true;
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
  agentScroll();
}

// ---- SSE --------------------------------------------------------------------
async function parseSSE(body, handlers) {
  var reader = body.getReader(); var dec = new TextDecoder(); var buf = '';
  while (true) {
    var r = await reader.read(); if (r.done) break;
    buf += dec.decode(r.value, { stream: true });
    var i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      var block = buf.slice(0, i); buf = buf.slice(i + 2);
      var ev = 'message', data = '';
      block.split('\n').forEach(function (line) {
        if (line.startsWith('event:')) ev = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).replace(/^ /, '') + '\n';
      });
      data = data.replace(/\n$/, '');
      if (!data) continue;
      var parsed; try { parsed = JSON.parse(data); } catch (_) { continue; }
      if (handlers[ev]) handlers[ev](parsed);
    }
  }
}

// ---- Send -------------------------------------------------------------------
async function agentSend() {
  if (agentBusy || agentDead) return;
  var text = agentInput.value.trim().slice(0, 1000); if (!text) return;
  agentInput.value = '';
  if (agentLog.children.length === 1 && agentLog.firstElementChild.classList.contains('agent-splash')) agentLog.innerHTML = '';

  var u = document.createElement('div'); u.className = 'agent-user fade-in'; u.innerHTML = '<span>' + esc(text) + '</span>';
  agentLog.appendChild(u);

  var turn = document.createElement('div'); turn.className = 'fade-in agent-turn';
  var mid = genMid(); turn.dataset.mid = mid; pendingReactions[mid] = {};
  turn.innerHTML = '<div class="agent-personas">' + AGENT_PERSONAS.map(function (p) {
    return '<div class="persona-card thinking" data-codename="' + p.codename + '">'
      + '<div class="persona-head"><span class="persona-hex">⬡</span><span class="persona-code">' + p.codename + '</span><span class="persona-name">' + p.name + '</span></div>'
      + '<div class="persona-round" data-round="1"><span class="persona-round-label">Initial</span><div class="persona-text">…</div></div>'
      + '<div class="persona-round" data-round="2" hidden><span class="persona-round-label">After debate</span><div class="persona-text">…</div></div>'
      + reactionBarHTML(p.codename)
      + '</div>';
  }).join('') + '</div>';
  var replyEl = document.createElement('div'); replyEl.className = 'agent-reply streaming';
  replyEl.innerHTML = '<span class="agent-who">✦ Shinya Takeda</span><span class="agent-reply-body"></span>' + reactionBarHTML('integrated');
  turn.appendChild(replyEl);
  agentLog.appendChild(turn); agentScroll();
  var replyBody = replyEl.querySelector('.agent-reply-body');

  agentHistory.push({ role: 'user', content: text });
  localStorage.setItem('magi_current_history', JSON.stringify(agentHistory));

  agentBusy = true; agentInput.disabled = true; agentSendBtn.disabled = true;
  var reply = '', errored = false, timedOut = false;
  var debateData = {};
  AGENT_PERSONAS.forEach(function (p) { debateData[p.codename] = { round1: '…', round2: '…' }; });

  var ctrl = new AbortController();
  var connectTimer = setTimeout(function () { timedOut = true; ctrl.abort(); }, 30000);
  try {
    var theme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    var res = await fetch(AGENT_API, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: agentHistory.slice(-AGENT_MAX_HISTORY), theme }),
      signal: ctrl.signal,
    });
    clearTimeout(connectTimer);
    if (!res.ok || !res.body) {
      var raw = await res.text().catch(function () { return ''; });
      var env = null; try { env = JSON.parse(raw).error; } catch (_) { }
      if (!env) env = { message: ('HTTP ' + res.status + ' ' + (res.statusText || '')).trim(), code: 'http_' + res.status };
      console.error('[agent] request failed', AGENT_API, res.status, raw.slice(0, 800));
      turn.remove(); renderAgentError(env); errored = true;
    } else {
      await parseSSE(res.body, {
        title: function (d) { if (d && d.text) { setAgentTitle(d.text); syncCurrentToSaved(); } },
        persona: function (d) {
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
        integrated: function (d) { reply += d.delta || ''; replyBody.textContent = reply; agentScroll(); },
        error: function (d) { errored = true; turn.querySelectorAll('.persona-card.thinking').forEach(function (c) { c.classList.remove('thinking'); }); replyEl.remove(); renderAgentError(d); },
        done: function () { },
      });
    }
  } catch (err) {
    clearTimeout(connectTimer);
    console.error('[agent] fetch failed', AGENT_API, err);
    turn.remove();
    if (timedOut || err.name === 'AbortError') { errored = true; renderAgentError({ message: 'Request timed out. Please try again.', code: 'timeout' }); }
    else agentDegrade();
  } finally {
    replyEl.classList.remove('streaming');
    agentBusy = false;
    if (!agentDead) { agentInput.disabled = false; agentSendBtn.disabled = false; agentInput.focus({ preventScroll: true }); }
  }
  if (reply && !errored) {
    agentHistory.push({ role: 'assistant', content: reply, debate: JSON.parse(JSON.stringify(debateData)), mid: mid, reactions: pendingReactions[mid] || {} });
    delete pendingReactions[mid];
    localStorage.setItem('magi_current_history', JSON.stringify(agentHistory));
    syncCurrentToSaved();
    updateAgentActionButtons();
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
    var res = await fetch(REACT_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: target, reaction: reaction, request: request, response: response }) });
    if (!res.ok) return undefined;
    var j = await res.json().catch(function () { return null; });
    return j && j.id;
  } catch (_) { return undefined; }
}
function deleteReaction(target, id) {
  if (id == null) return;
  try { fetch(REACT_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'remove', target: target, id: id }), keepalive: true }).catch(function () { }); } catch (_) { }
}
function registerReaction(bar, target, em, ctx) {
  var store = reactionStoreFor(bar);
  var cell = null;
  if (store) { cell = { em: em }; store[target] = cell; persistReactions(); }
  sendReaction(target, em, ctx.request, ctx.response).then(function (id) {
    if (id == null) return;
    if (store && store[target] === cell) { cell.id = id; persistReactions(); }
    else deleteReaction(target, id);
  });
}
function unregisterReaction(bar, target) {
  var store = reactionStoreFor(bar);
  var id = store ? reId(store[target]) : undefined;
  if (store) { delete store[target]; persistReactions(); }
  if (id != null) deleteReaction(target, id);
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
    var p = AGENT_PERSONAS.find(function (x) { return x.codename === node.dataset.codename; });
    node.classList.add('active');
    desc.innerHTML = '<span class="magi-desc-name">' + esc(p.codename) + ' · ' + esc(p.name) + '</span>' + esc(p.desc);
    desc.classList.remove('hidden');
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
  agentHistory = session.history.slice();
  localStorage.setItem('magi_current_history', JSON.stringify(agentHistory));
  setAgentTitle(session.title || '');
  currentSessionId = session.id;
  localStorage.setItem('magi_current_session_id', currentSessionId);
  agentDead = false; agentDegraded.classList.add('hidden'); agentDegraded.textContent = '';
  agentInput.disabled = false; agentSendBtn.disabled = false;
  renderHistoryToLog(agentHistory);
  updateAgentActionButtons();
}
function deleteSavedSession(id) {
  if (currentSessionId === id) { currentSessionId = null; localStorage.removeItem('magi_current_session_id'); }
  var sessions = safeParse(localStorage.getItem('magi_saved_sessions'), []);
  sessions = sessions.filter(function (s) { return s.id !== id; });
  localStorage.setItem('magi_saved_sessions', JSON.stringify(sessions));
  renderSavedSessionsList();
}
function showInfoPanel() {
  makeAgentPanel('agent-info-panel', 'System & Privacy',
    '<ul>'
    + '<li>A multi-agent system with 3 debating personas modeled on <strong>Shinya Takeda\'s personality</strong>.</li>'
    + '<li>Daily limit: <strong>24 requests</strong> and max <strong>12 rounds</strong> per session.</li>'
    + '<li>By default, inputs are <strong>not saved</strong> in the database, unless you <strong>react</strong> to a reply (👍/emoji) to help improve MAGI.</li>'
    + '<li>Chat history is stored in your device\'s <strong>local storage</strong> (not permanent; please export important chats).</li>'
    + '<li>Powered by <strong>DeepSeek API</strong> (inputs are sent to China and may be used for AI training).</li>'
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
    if (item.role === 'user') { md += '## 🧑‍💻 User\n' + item.content + '\n\n'; return; }
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
agentSendBtn.addEventListener('click', agentSend);
agentInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); agentSend(); } });
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
