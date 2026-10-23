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
var APP_VERSION = '6.0';

// 画面の言語（en / ja）。app-theme.js が描画前に <html lang> を決め、︙のメニューで切り替える（applyLanguage）。
function isJa() { return document.documentElement.lang === 'ja'; }
function tr(en, ja) { return isJa() ? ja : en; }
// ネイティブの部品は「English / 日本語」の1文で知らせる。画面の言語の側だけを出す（日本語の側が無ければそのまま）。
function pickLang(text) {
  text = String(text || '');
  var at = text.indexOf(' / ');
  if (at < 0) return text;
  var ja = text.slice(at + 3);
  if (!Array.from(ja).some(function (c) { return c.charCodeAt(0) >= 0x3000; })) return text;
  return isJa() ? ja : text.slice(0, at);
}

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
  return Object.assign({ entry: entry || 'chat', classification_state: true, fact_mode: true, ui_language: ui },
    entry === 'dj-request' ? {} : { magi_panel: panel === true, close_on_malice: true, clarify: true },
    state ? { reply_language: state } : { language_seed: seed });
}
function cleanAgentClarify(v) {
  if (!v || Object.keys(v).length !== 3 || ['questions','intent','fresh'].some(function (k) { return !Object.prototype.hasOwnProperty.call(v,k); }) || ['consult','music','site','research'].indexOf(v.intent) < 0 || ['yes','no'].indexOf(v.fresh) < 0
    || !Array.isArray(v.questions) || !v.questions.length || v.questions.length > 3) return null;
  var seen = new Set(), questions = [];
  function text(s, max) { return typeof s === 'string' && s.trim() && s.length <= max
    && !/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(s); }
  for (var q of v.questions) {
    if (!q || Object.keys(q).length !== 2 || !Object.prototype.hasOwnProperty.call(q,'question') || !Object.prototype.hasOwnProperty.call(q,'options') || !text(q.question, 60) || seen.has(q.question.trim()) || !Array.isArray(q.options) || q.options.length !== 3
      || q.options.some(function (s) { return !text(s, 30); }) || new Set(q.options.map(function (s) { return s.trim(); })).size !== 3) return null;
    seen.add(q.question.trim()); questions.push({question:q.question.trim(), options:q.options.map(function (s) { return s.trim(); })});
  }
  return {questions:questions, intent:v.intent, fresh:v.fresh};
}
function receiveClassification(state, ev, d) {
  if (ev === 'title' || ev === 'error') return;
  if (ev === 'classification') {
    var language = cleanReplyLanguage(d && d.reply_language);
    if (state.started || state.classified || !d || d.version !== 1 || ['consult','site','music','research'].indexOf(d.intent) < 0
      || ['yes','no','uncertain'].indexOf(d.site_pages) < 0 || ['yes','no','uncertain'].indexOf(d.votable) < 0
      || typeof d.magi_candidate !== 'boolean' || d.magi_candidate && (!state.panel || d.votable !== 'yes') || !language
      || (state.language && JSON.stringify(language) !== JSON.stringify(state.language))) throw new Error('invalid_classification');
    if (d.mode !== undefined && (['fact','consult'].indexOf(d.mode) < 0 || d.mode === 'fact' && d.magi_candidate)
      || d.fresh !== undefined && ['yes','no'].indexOf(d.fresh) < 0) throw new Error('invalid_fact_classification');
    state.intent = d.intent; state.fresh = d.fresh || 'no'; state.mode = d.mode; state.classified = true; state.language = language; state.candidate = d.magi_candidate;
  } else {
    if (state.clarified && ev !== 'done') throw new Error('event_after_clarify');
    if (ev === 'clarify') {
      if (!state.classified || state.mode === 'fact' || state.candidate || state.reply || state.closed || !cleanAgentClarify(d) || d.intent !== state.intent || d.fresh !== state.fresh) throw new Error('invalid_clarify');
      state.clarified = true;
    }
    if (ev === 'sources') {
      if (state.mode !== 'fact' || state.candidate || !state.reply || state.sources) throw new Error('invalid_sources');
      state.sources = true;
    }
    if (ev === 'closed') {
      if (!state.classified || state.candidate || state.closed || !state.reply || !d || d.reason !== 'malice') throw new Error('invalid_closed');
      state.closed = true;
    } else if (state.closed && ev !== 'done') throw new Error('event_after_closed');
    if (ev === 'integrated' && d && typeof d.delta === 'string' && d.delta.trim()) state.reply = true;
    if (state.panel && typeof magiReceive === 'function') magiReceive(state, ev, d);
    else if (['motion','verdict','integrated_end'].indexOf(ev) >= 0) throw new Error('unexpected_magi_event');
    state.started = true;
  }
}
// AGENT_CLASSIFY_END

// AGENT_CLARIFY_BEGIN
// 確認質問も履歴に残す。HTMLとして解釈せず、古い質問は読み取り専用で再現する。
function cleanAgentClarifyItem(item) {
  var copy = Object.assign({}, item); delete copy.clarify;
  var clarify = item.role === 'assistant' && !item.closed && !item.mode ? cleanAgentClarify(item.clarify) : null;
  if (clarify) copy.clarify = clarify;
  return copy;
}
function agentClarifyText(v) {
  return v.questions.map(function (q, i) { return (i + 1) + '. ' + q.question; }).join('\n');
}
function agentClarifyPlaceholder(on) {
  agentInput.placeholder = document.documentElement.lang === 'ja' ? (on ? '補足があれば入力' : '武田伸也AIに質問…') : (on ? 'Add details if needed' : 'Ask Shinya Takeda AI...');
}
function lastAgentTurn() {
  return Array.from(agentLog.querySelectorAll('.agent-turn')).at(-1) || null;
}
function freezeAgentClarify() {
  var turn = lastAgentTurn(), draft = turn && turn._clarify;
  if (draft) {
    turn.querySelectorAll('.agent-clarify button,.agent-clarify input').forEach(function (el) { el.disabled = true; });
    turn._clarify = null;
  }
  agentClarifyPlaceholder(false);
  return draft;
}
function restoreAgentClarify(draft) {
  var item = agentHistory.at(-1), turn = lastAgentTurn();
  if (!item || !item.clarify || !turn) return;
  if (draft && turn.querySelector('.agent-clarify')) {
    turn._clarify = draft;
    turn.querySelectorAll('.agent-clarify button,.agent-clarify input').forEach(function (el) { el.disabled = false; });
    agentClarifyPlaceholder(true);
  } else renderAgentClarify(turn, item.clarify, true);
}
function agentClarifyAnswer(turn, extra) {
  var state = turn && turn._clarify;
  if (!state) return extra;
  var lines = [], missing = false;
  state.value.questions.forEach(function (q, i) {
    var pick = state.picks[i];
    if (pick === undefined) return;
    var answer = pick === 3 ? state.other[i].value.trim() : q.options[pick];
    if (pick === 3 && answer.length > 100) missing = true;
    else if (answer) lines.push(state.value.questions.length === 1 && pick < 3 ? answer : q.question + ': ' + answer);
  });
  if (missing) return null;
  if (extra) lines.push(extra);
  var text = lines.join('\n\n');
  return text.length <= 1000 ? text : null;
}
function renderAgentClarify(turn, raw, interactive) {
  var value = cleanAgentClarify(raw);
  if (!value) return;
  var old = turn.querySelector('.agent-clarify'); if (old) old.remove();
  var panel = document.createElement('div'); panel.className = 'agent-clarify';
  var state = {value:value, picks:[], other:[]}; turn._clarify = interactive ? state : null;
  var ja = document.documentElement.lang === 'ja';
  var active = function () { return interactive && !agentBusy && !agentDead && !agentClosed && lastAgentTurn() === turn; };
  value.questions.forEach(function (q, i) {
    var group = document.createElement('fieldset'), legend = document.createElement('legend');
    legend.textContent = (i + 1) + '. ' + q.question; group.appendChild(legend);
    var input = document.createElement('input'); input.type = 'text'; input.maxLength = 100;
    input.dataset.jaPh = '100文字以内で入力'; input.dataset.enPh = 'Up to 100 characters';
    input.placeholder = ja ? input.dataset.jaPh : input.dataset.enPh; input.hidden = true; input.disabled = !interactive;
    input.setAttribute('aria-label', q.question + ' — ' + (ja ? 'その他' : 'Other')); state.other[i] = input;
    var buttons = [];
    q.options.concat([ja ? 'その他（入力する）' : 'Other (type your own)']).forEach(function (option, n) {
      var button = document.createElement('button'); button.type = 'button'; button.textContent = (n + 1) + '. ' + option;
      if (n === 3) { button.dataset.ja = '4. その他（入力する）'; button.dataset.en = '4. Other (type your own)'; }
      button.disabled = !interactive; button.setAttribute('aria-pressed', 'false'); buttons.push(button); group.appendChild(button);
      button.addEventListener('click', function () {
        if (!active()) return;
        state.picks[i] = n; buttons.forEach(function (b, k) { b.setAttribute('aria-pressed', k === n ? 'true' : 'false'); });
        input.hidden = n !== 3;
        if (n === 3) input.focus();
        else if (value.questions.length === 1) agentSend();
      });
    });
    group.appendChild(input); panel.appendChild(group);
  });
  var send = document.createElement('button'); send.type = 'button'; send.textContent = ja ? '回答する' : 'Send answers'; send.disabled = !interactive;
  send.dataset.ja = '回答する'; send.dataset.en = 'Send answers';
  send.addEventListener('click', function () { if (active()) agentSend(); }); panel.appendChild(send);
  turn.querySelector('.agent-reply-body').textContent = '';
  turn.querySelector('.agent-reply').appendChild(panel);
  if (interactive) {
    agentClarifyPlaceholder(true);
    agentInput.classList.remove('has-suggest');
  }
}
// AGENT_CLARIFY_END

// AGENT_FACT_BEGIN
// 保存・表示・引用位置は全文のまま、上流へ送り直す事実回答の履歴だけ上限に収める。
function agentFactHistoryMessage(item) {
  if (item.role !== 'assistant' || item.mode !== 'fact' || typeof item.content !== 'string' || item.content.length <= 4000) return item;
  var text = item.content.slice(0, 4000);
  if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  return Object.assign({}, item, {content:text});
}
function cleanAgentSources(value, text) {
  if (!value || !Array.isArray(value.items) || !Array.isArray(value.marks) || typeof text !== 'string') return null;
  var items = [], numbers = new Set(), urls = new Set();
  value.items.slice(0, 5).forEach(function (item) {
    if (!item || !Number.isInteger(item.n) || item.n < 1 || item.n > 5 || numbers.has(item.n)
      || typeof item.url !== 'string' || item.url.length > 4096) return;
    try {
      var u = new URL(item.url);
      if (!['http:','https:'].includes(u.protocol) || urls.has(u.href)) return;
      numbers.add(item.n); urls.add(u.href);
      var row = { n: item.n, url: u.href, title: typeof item.title === 'string' && item.title.trim() ? item.title.slice(0, 300) : u.href };
      // 出典のアイコンは Worker が取った data: URL の画像だけを通し、<img src> にだけ入れる（読み上げ設計§4.4）
      if (typeof item.icon === 'string' && item.icon.length <= 6144 && /^data:image\/(?:png|x-icon|vnd\.microsoft\.icon|jpeg|webp|gif);base64,[A-Za-z0-9+\/]+=*$/.test(item.icon)) row.icon = item.icon;
      items.push(row);
    } catch (_) {}
  });
  var marks = [], seen = new Set();
  value.marks.slice(0, 200).forEach(function (m) {
    if (!m || !Number.isInteger(m.at) || m.at < 0 || m.at > text.length || !numbers.has(m.n)) return;
    if (m.at > 0 && /[\uD800-\uDBFF]/.test(text[m.at - 1]) && /[\uDC00-\uDFFF]/.test(text[m.at])) return;
    var key = m.at + ':' + m.n;
    if (!seen.has(key)) { seen.add(key); marks.push({ at: m.at, n: m.n }); }
  });
  marks.sort(function (a, b) { return a.at - b.at || a.n - b.n; });
  return items.length && marks.length ? { items: items, marks: marks } : null;
}
function renderAgentSources(body, replyEl, text, raw, ja, panel) {
  var data = cleanAgentSources(raw, text);
  if (!data || !body || !replyEl) return;
  body.replaceChildren();
  var last = 0;
  data.marks.forEach(function (mark) {
    body.appendChild(document.createTextNode(text.slice(last, mark.at))); last = mark.at;
    var item = data.items.find(function (row) { return row.n === mark.n; });
    var a = document.createElement('a'); a.textContent = '[' + mark.n + ']'; a.href = item.url;
    a.target = '_blank'; a.rel = 'noopener noreferrer'; a.style.cssText = 'margin-inline:2px;text-decoration:underline';
    a.setAttribute('aria-label', (ja ? '出典 ' : 'Source ') + mark.n + ': ' + item.title); body.appendChild(a);
  });
  body.appendChild(document.createTextNode(text.slice(last)));
  var previous = replyEl.querySelector('.agent-sources'); if (previous) previous.remove();
  // 操作列の［ソース］から一覧を開く画面（トップページ・アプリ）は、回答の下に一覧を置かない
  if (panel === false) return;
  var panel = document.createElement('div'); panel.className = 'agent-sources';
  panel.style.cssText = 'display:grid;gap:6px;margin-top:12px;font-size:12px;line-height:1.6;overflow-wrap:anywhere';
  var label = document.createElement('strong'); label.textContent = ja ? '出典' : 'Sources'; panel.appendChild(label);
  data.items.forEach(function (item) {
    var a = document.createElement('a'); a.textContent = '[' + item.n + '] ' + item.title; a.href = item.url;
    a.target = '_blank'; a.rel = 'noopener noreferrer'; panel.appendChild(a);
  });
  replyEl.appendChild(panel);
}
function agentFactMarkdown(text, raw) {
  var data = cleanAgentSources(raw, text); if (!data) return text;
  var out = '', last = 0;
  data.marks.forEach(function (m) { out += text.slice(last, m.at) + '[' + m.n + ']'; last = m.at; });
  out += text.slice(last) + '\n\n### Sources\n';
  data.items.forEach(function (item) {
    var title = item.title.replace(/([\\\[\]<>*`_])/g, '\\$1');
    out += '[' + item.n + '] ' + title + ' (<'+ item.url +'>)\n';
  });
  return out;
}
// AGENT_FACT_END

// AGENT_SPEECH_BEGIN
// 統合人格の回答の操作列の共通部分（読み上げ設計書 4・5章）。トップページとアプリで同じ中身にする（テストで照合）。
function cleanSpeechSig(value) { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : null; }
function cleanSpeechLang(value) { return typeof value === 'string' && /^[a-z]{2}$/.test(value) ? value : null; }
// 保存した回答の署名を確かめる。確認質問・短い返答で閉じた回答と、形の違う値は落とす
function cleanAgentSpeechItem(item) {
  if (!item || item.role !== 'assistant' || !('speech_sig' in item || 'speech_lang' in item)) return item;
  var out = Object.assign({}, item), sig = cleanSpeechSig(item.speech_sig), lang = cleanSpeechLang(item.speech_lang);
  delete out.speech_sig; delete out.speech_lang;
  if (sig && item.closed !== true && !item.clarify) { out.speech_sig = sig; if (lang) out.speech_lang = lang; }
  return out;
}
// 出典のドメイン（www. を除く）と、アイコンの無い出典に出す頭文字の丸。色はドメインから決める
function agentSourceDomain(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return ''; } }
function agentSourceBadge(item) {
  var domain = agentSourceDomain(item.url), hue = 0;
  for (var i = 0; i < domain.length; i++) hue = (hue * 31 + domain.charCodeAt(i)) % 360;
  // 国際化ドメイン（xn--）は表示用の文字に戻せないので、題名の頭文字を使う
  var seed = domain && domain.indexOf('xn--') !== 0 ? domain : String(item.title || '?');
  return { letter: (Array.from(seed.trim())[0] || '?').toUpperCase(), color: 'hsl(' + hue + ' 42% 40%)' };
}
function agentSourceIconEl(item) {
  if (item.icon) {
    var img = document.createElement('img');
    img.className = 'src-icon'; img.src = item.icon; img.alt = ''; img.width = 16; img.height = 16;
    return img;
  }
  var badge = agentSourceBadge(item), span = document.createElement('span');
  span.className = 'src-icon src-letter'; span.textContent = badge.letter; span.style.background = badge.color;
  span.setAttribute('aria-hidden', 'true');
  return span;
}
// 出典の一覧の1行（アイコン・題名・ドメイン）。新しいタブで開く
function agentSourceRowEl(item) {
  var a = document.createElement('a');
  a.className = 'src-row'; a.href = item.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
  var text = document.createElement('span'); text.className = 'src-text';
  var title = document.createElement('span'); title.className = 'src-title'; title.textContent = item.title;
  var domain = document.createElement('span'); domain.className = 'src-domain'; domain.textContent = agentSourceDomain(item.url);
  text.appendChild(title); text.appendChild(domain);
  a.appendChild(agentSourceIconEl(item)); a.appendChild(text);
  return a;
}
// 操作列の［ソース］の中身（アイコンを最大3つ重ね、「ソース」と書く）。出典が無ければ隠す
function renderAgentSourceButton(btn, text, raw, ja) {
  var data = cleanAgentSources(raw, text);
  btn.hidden = !data; btn.replaceChildren();
  if (!data) return null;
  var icons = document.createElement('span'); icons.className = 'src-icons';
  data.items.slice(0, 3).forEach(function (item) { icons.appendChild(agentSourceIconEl(item)); });
  var label = document.createElement('span'); label.textContent = ja ? 'ソース' : 'Sources';
  btn.appendChild(icons); btn.appendChild(label);
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-label', (ja ? 'ソース（' : 'Sources (') + data.items.length + (ja ? '件）' : ')'));
  return data;
}
// 共有する文。本文（出典の [n] 入り。コピーと同じ）と出典の一覧で、会話の URL は付けない
function agentShareText(text, raw, ja) {
  var data = cleanAgentSources(raw, text);
  if (!data) return text;
  var out = '', last = 0;
  data.marks.forEach(function (m) { out += text.slice(last, m.at) + '[' + m.n + ']'; last = m.at; });
  out += text.slice(last) + '\n\n' + (ja ? '出典' : 'Sources');
  data.items.forEach(function (item) { out += '\n[' + item.n + '] ' + item.title + '\n' + item.url; });
  return out;
}
// 読み上げ（設計§5.6）。<audio> は画面に1つだけで、区切りを順に取り、鳴らしている間に次を取る。
// 音声は Blob の URL で鳴らし、使い終わったら解放する（端末に保存しない）。hooks.state(btn, 'idle'|'loading'|'playing')、
// hooks.notice(btn, code) で画面に知らせる
function createAgentSpeech(api, hooks) {
  var audio = null, run = null;
  // 1サンプルの無音の WAV。iPhone は利用者の操作の中で一度鳴らした要素なら、その後も続けて鳴らせる
  function silence() {
    var b = new ArrayBuffer(46), v = new DataView(b);
    var put = function (at, t) { for (var i = 0; i < t.length; i++) v.setUint8(at + i, t.charCodeAt(i)); };
    put(0, 'RIFF'); v.setUint32(4, 38, true); put(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); put(36, 'data'); v.setUint32(40, 2, true);
    return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
  }
  function drop(r, url) { var at = r.urls.indexOf(url); if (at >= 0) { r.urls.splice(at, 1); URL.revokeObjectURL(url); } }
  function stop() {
    var r = run;
    if (!r) return;
    run = null; r.ctrl.abort();
    if (audio) { audio.pause(); audio.removeAttribute('src'); }
    r.urls.splice(0).forEach(function (url) { URL.revokeObjectURL(url); });
    hooks.state(r.btn, 'idle');
  }
  function fetchPart(r, i) {
    return fetch(api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: r.ctrl.signal,
      body: JSON.stringify(Object.assign({ text: r.text, sig: r.sig, part: i }, r.lang ? { lang: r.lang } : {})) })
      .then(function (res) {
        if (!res.ok) return res.json().catch(function () { return null; }).then(function (j) {
          var err = new Error('speech_failed'); err.code = j && j.error && typeof j.error.code === 'string' ? j.error.code : 'http_' + res.status; throw err;
        });
        var n = Number(res.headers.get('X-Speech-Parts'));
        if (Number.isInteger(n) && n > 0 && n <= 30) r.total = n;
        return res.blob();
      })
      .then(function (blob) {
        if (run !== r) throw new Error('speech_stopped');
        var url = URL.createObjectURL(blob); r.urls.push(url); return url;
      });
  }
  function ended(r) {
    return new Promise(function (resolve, reject) {
      function done() { off(); resolve(); }
      function fail() { off(); var err = new Error('speech_audio'); err.code = 'speech_audio'; reject(err); }
      function off() { audio.removeEventListener('ended', done); audio.removeEventListener('error', fail); r.ctrl.signal.removeEventListener('abort', done); }
      audio.addEventListener('ended', done); audio.addEventListener('error', fail); r.ctrl.signal.addEventListener('abort', done);
    });
  }
  async function play(r) {
    var next = fetchPart(r, 0), i = 0;
    try {
      while (run === r) {
        var url = await next;
        if (run !== r) return;
        // 鳴らしている間に次の区切りを取る（取り終わっていれば途切れずにつながる）
        next = i + 1 < r.total ? fetchPart(r, i + 1) : null;
        if (next) next.catch(function () {});
        audio.src = url;
        var playing = ended(r);
        await audio.play();
        if (run !== r) return;
        hooks.state(r.btn, 'playing');
        await playing;
        if (run !== r) return;
        drop(r, url);
        if (!next) { stop(); return; }
        i++;
      }
    } catch (err) {
      if (run !== r) return;
      var btn = r.btn;
      stop();
      hooks.notice(btn, err && err.code || 'speech_failed');
    }
  }
  return {
    // 同じボタンをもう一度押すと止める。別の回答を押したら前を止めて、新しい回答を区切り 0 から読む
    toggle: function (btn, text, sig, lang) {
      var same = run && run.btn === btn;
      stop();
      if (same) return;
      if (!audio) audio = new Audio();
      var r = run = { btn: btn, text: text, sig: sig, lang: lang, ctrl: new AbortController(), urls: [], total: 1 };
      var unlock = silence(); r.urls.push(unlock);
      audio.src = unlock;
      var p = audio.play(); if (p && p.catch) p.catch(function () {});
      hooks.state(btn, 'loading');
      play(r);
    },
    stop: stop,
    active: function () { return run ? run.btn : null; },
  };
}
// AGENT_SPEECH_END


// AGENT_CLOSED_BEGIN
// 予測の描画・フォーカスは呼び出し元が行う。ここでは3つの操作の状態だけを揃える。
function setAgentControlsEnabled(on) {
  agentInput.disabled = agentSendBtn.disabled = attachBtn.disabled = !on;
}
// 終了状態は会話ごとの履歴から復元する。古い送信はaliveの検査でここへ来ない。
function closeAgentConversation(turn) {
  agentClosed = true;
  setAgentControlsEnabled(false);
  setAgentSuggestion('');
  if (!turn || turn.querySelector('.agent-closed')) return;
  var ja = document.documentElement.lang === 'ja';
  var box = document.createElement('div'); box.className = 'agent-closed';
  var text = document.createElement('p');
  text.dataset.en = 'This conversation has ended. Please start a new conversation.';
  text.dataset.ja = 'この会話はここまでです。新しい会話を始めてください。';
  text.textContent = ja ? text.dataset.ja : text.dataset.en;
  var button = document.createElement('button'); button.type = 'button';
  button.dataset.en = 'New conversation'; button.dataset.ja = '新しい会話';
  button.textContent = ja ? button.dataset.ja : button.dataset.en;
  button.addEventListener('click', function () { resetAgent(true); });
  box.appendChild(text); box.appendChild(button); turn.appendChild(box);
}
// AGENT_CLOSED_END

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
var USAGE_API = API_BASE + '/magi2/usage';
var PROVIDER_LABEL = { openai: 'OpenAI', deepseek: 'DeepSeek', anthropic: 'Anthropic' };
var agentModels;
var agentModelsPromise = null;
var agentModelsExpires = 0;
function loadAgentModels() {
  if (Date.now() >= agentModelsExpires && agentModels) { agentModelsPromise = null; agentModels = undefined; }
  if (!agentModelsPromise) {
    agentModelsPromise = fetch(MODELS_API)
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) { agentModelsExpires = Date.now() + 600000; agentModels = j; return j; })
      .catch(function () { agentModelsPromise = null; agentModels = null; return null; });
  }
  return agentModelsPromise;
}
function personaDescHTML(p) {
  var m = agentModels && (p.synth ? agentModels.synthesizer : agentModels.personas && agentModels.personas[p.codename]);
  var head = '<span class="magi-desc-name">' + esc(p.codename) + ' · ' + esc(p.name) + '</span>';
  if (!m) return head + esc(agentModels === undefined ? '…' : tr('Could not load the description.', '説明を取得できませんでした。'));
  function text(o) { return esc(o ? (isJa() && o.ja) || o.en || '' : ''); }
  return head + text(m.desc)
    + '<dl class="magi-desc-meta">'
    + '<dt>LLM</dt><dd>' + (p.synth && agentModels.themes && agentModels.themes.light && agentModels.themes.dark
      ? ['light', 'dark'].map(function (theme) { var model = agentModels.themes[theme]; return esc((model.provider_label || PROVIDER_LABEL[model.provider] || model.provider) + ' · ' + model.model + (theme === 'light' ? tr(' (Light)', '（ライト）') : tr(' (Dark)', '（ダーク）'))); }).join('<br>')
      : esc((m.provider_label || PROVIDER_LABEL[m.provider] || m.provider) + ' · ' + m.model)) + '</dd>'
    + '<dt>' + tr('Context', '素材') + '</dt><dd>' + text(m.context) + '</dd>'
    + '<dt>' + tr('Theme', 'テーマ') + '</dt><dd>' + text(m.theme) + '</dd>'
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
var agentClosed = false;
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
  agentSuggestUse.setAttribute('aria-label', tr('Use the suggested question: ', '予測した質問を入れる：') + agentSuggestion);
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
// 送るもの（文字・画像・確認質問の選択）が無いときは送信ボタンを薄くする。停止ボタンのときは常に濃く出す。
function updateSendState() {
  var turn = lastAgentTurn(), clarify = turn && turn._clarify;
  var ready = !!agentInput.value.trim() || !!(attachments && attachments.length) || !!(clarify && clarify.picks.some(function (p) { return p !== undefined; }));
  agentSendBtn.classList.toggle('is-empty', !ready && !agentSendBtn.dataset.stop);
}
function fitAgentInput() {
  updateSendState();
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
var nativeHistory = null;
var nativeAndroid = !!(window.Capacitor && window.Capacitor.isNativePlatform() && window.Capacitor.getPlatform() === 'android');
var historyLoading = nativeAndroid;
var agentShared = null, nativeInput = null, sharedLoading = false;
var nativeConversation = null;
var nativeWidget = null, nativeInputReady = Promise.resolve();
// 共有資料はAndroidだけ。ほかの画面では常にnullにする。
function cleanAgentShared(value) {
  if (!nativeAndroid || !value || typeof value.title !== 'string' || typeof value.url !== 'string' || typeof value.text !== 'string'
    || value.title.length > 200 || value.url.length > 2000 || value.text.length > 6000 || !value.title.trim() || !value.text.trim()) return null;
  if (value.url) { try { if (!/^https?:$/.test(new URL(value.url).protocol)) return null; } catch (_) { return null; } }
  return { title: value.title, url: value.url, text: value.text };
}
function renderSharedDocument() {
  var tray = document.getElementById('agent-shared-tray'); if (!tray) return;
  tray.replaceChildren(); tray.hidden = !agentShared;
  if (tray.hidden) return;
  var open = document.createElement('button'); open.type = 'button';
  open.textContent = tr('Shared document: ', '共有資料: ') + agentShared.title + ' (' + agentShared.text.length.toLocaleString() + ')';
  open.addEventListener('click', function () {
    var panel = makeAgentPanel('agent-shared-panel', tr('Shared document', '共有資料'), '<pre class="shared-document-text"></pre>');
    if (panel) panel.querySelector('pre').textContent = agentShared.title + '\n' + agentShared.url + '\n\n' + agentShared.text;
  });
  var remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.ariaLabel = tr('Remove shared document', '共有資料を外す');
  remove.addEventListener('click', function () { setSharedDocument(null); });
  tray.append(open, remove);
}
function persistSharedDocument() {
  if (agentShared) safeStore('magi_current_shared', agentShared); else safeRemove('magi_current_shared');
  renderSharedDocument();
}
function setSharedDocument(value) {
  agentShared = cleanAgentShared(value);
  persistSharedDocument(); syncCurrentToSaved();
}
function safeGet(key) {
  if (nativeHistory && nativeHistory.active && nativeHistory.owns(key)) return nativeHistory.get(key);
  try { return localStorage.getItem(key); } catch (_) { return null; }
}
function safeRemove(key) {
  if (nativeHistory && nativeHistory.active && nativeHistory.owns(key)) { nativeHistory.remove(key); return; }
  try { localStorage.removeItem(key); } catch (_) {}
}
// 画像サムネを持つ履歴は容量を食う。あふれたら古い保存セッションを捨てて1回だけ再試行する。
function safeStore(key, val) {
  var str = typeof val === 'string' ? val : JSON.stringify(val);
  if (nativeHistory && nativeHistory.active && nativeHistory.owns(key)) { nativeHistory.set(key, str); return; }
  try { localStorage.setItem(key, str); } catch (_) {
    // Androidの移行に失敗している間も、古い会話を容量で捨てない。
    if (nativeAndroid) { announceAgent(tr('Could not save this conversation. Free some device storage and reopen MAGI.', 'この会話を保存できませんでした。端末の空き容量を増やして、MAGIを開き直してください。')); return; }
    try {
      var ss = safeParse(localStorage.getItem('magi_saved_sessions'), []);
      while (ss.length > 5) ss.pop();
      localStorage.setItem('magi_saved_sessions', JSON.stringify(ss));
      localStorage.setItem(key, str);
    } catch (__) { /* どうにもならない場合は黙って諦める */ }
  }
}
// Androidの履歴は会話を物のまま渡し、変わった会話だけを書き直させる（中の会話は書き換えず、新しい物で置き換える）。
function readSavedSessions() {
  return nativeHistory && nativeHistory.active ? nativeHistory.sessions() : safeParse(safeGet('magi_saved_sessions'), []);
}
function writeSavedSessions(sessions) {
  if (nativeHistory && nativeHistory.active) nativeHistory.setSessions(sessions); else safeStore('magi_saved_sessions', sessions);
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
    + '<button type="button" class="react-btn" data-act="copy" title="' + tr('Copy', 'コピー') + '">' + ICON_COPY + '</button>'
    + '<button type="button" class="react-btn" data-act="like" title="' + tr('Like', 'いいね') + '">' + ICON_LIKE + '</button>'
    + '<button type="button" class="react-btn" data-act="emoji" title="' + tr('React', 'リアクション') + '">' + ICON_REACT + '</button>'
    + '</div>';
}

// 統合人格の回答の操作列（読み上げ設計§4.1）。［コピー］［🔊］［共有］［いいね］［︙］と、右寄せの［ソース］。
// いいね・絵文字の data-act と保存は人格のカードと共通。🔊 と［ソース］は回答がそろってから setupReplyBar で出す
var SPEECH_API = API_BASE + '/magi2/speech';
var ICON_SPEAK = '<svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
var ICON_SPEAK_STOP = '<svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>';
var ICON_SPEAK_WAIT = '<svg aria-hidden="true" class="speak-wait" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9"/></svg>';
var ICON_SHARE = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>';
var ICON_MORE = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>';
function replyBarHTML() {
  function b(act, label, icon, extra) { return '<button type="button" class="react-btn" data-act="' + act + '" title="' + label + '" aria-label="' + label + '"' + (extra || '') + '>' + icon + '</button>'; }
  return '<div class="reaction-bar reply-bar" data-target="integrated">'
    + b('copy', tr('Copy', 'コピー'), ICON_COPY)
    + b('speak', tr('Read aloud', '読み上げ'), ICON_SPEAK, ' aria-pressed="false" hidden')
    + b('share', tr('Share', '共有'), ICON_SHARE)
    + b('like', tr('Like', 'いいね'), ICON_LIKE)
    + b('emoji', tr('More: reactions', 'その他（リアクション）'), ICON_MORE, ' data-more="1" aria-haspopup="true"')
    + '<button type="button" class="react-btn reply-src" data-act="sources" hidden></button>'
    + '</div>';
}
// 絵文字を付けた・外したときの見た目。［︙］は記号を残して右に絵文字を出し、人格のカードはボタンを絵文字に置き換える
function showReactEmoji(trigger, em) {
  trigger.classList.add('reacted');
  if (!trigger.dataset.more) { trigger.textContent = em; return; }
  trigger.innerHTML = ICON_MORE;
  var picked = document.createElement('span'); picked.className = 'react-picked'; picked.textContent = em; trigger.appendChild(picked);
}
function clearReactEmoji(trigger) { trigger.classList.remove('reacted'); trigger.innerHTML = trigger.dataset.more ? ICON_MORE : ICON_REACT; }
var agentSpeechOn = false, agentSpeechPlayer = null;
function agentSpeech() {
  return agentSpeechPlayer || (agentSpeechPlayer = createAgentSpeech(SPEECH_API, {
    state: function (btn, s) {
      btn.dataset.state = s; btn.setAttribute('aria-pressed', String(s !== 'idle'));
      btn.innerHTML = s === 'idle' ? ICON_SPEAK : s === 'loading' ? ICON_SPEAK_WAIT : ICON_SPEAK_STOP;
      var label = s === 'idle' ? tr('Read aloud', '読み上げ') : s === 'loading' ? tr('Loading audio (press to stop)', '読み込み中（押すと止まります）') : tr('Stop reading', '読み上げを止める');
      btn.title = label; btn.setAttribute('aria-label', label);
    },
    notice: function (btn, code) {
      var bar = btn.closest('.reaction-bar');
      if (bar) showReplyNote(bar, code === 'speech_unsigned' ? tr('This reply cannot be read aloud.', 'この回答は読み上げできません')
        : /limit_exceeded$/.test(code) ? tr("Today's read-aloud limit has been reached.", '本日の読み上げの上限に達しました')
        : tr('Could not read the reply aloud.', '読み上げできませんでした'));
    },
  }));
}
function showReplyNote(bar, text) {
  bar.parentElement.querySelectorAll('.reply-note').forEach(function (n) { n.remove(); });
  var note = document.createElement('div'); note.className = 'reply-note'; note.setAttribute('role', 'status'); note.textContent = text;
  bar.after(note); setTimeout(function () { note.remove(); }, 4000);
}
function agentItemFor(el) {
  var turn = el.closest('.agent-turn'), mid = turn && turn.dataset.mid;
  return mid ? agentHistory.find(function (it) { return it.mid === mid && it.role === 'assistant'; }) : null;
}
function setupReplyBar(turn, item) {
  var bar = turn.querySelector('.agent-reply .reply-bar');
  if (!bar || !item) return;
  var speak = bar.querySelector('[data-act="speak"]'); if (speak) speak.hidden = !(agentSpeechOn && item.speech_sig);
  var src = bar.querySelector('[data-act="sources"]'); if (src) renderAgentSourceButton(src, item.content, item.sources, isJa());
}
function syncSpeakButtons() {
  if (!agentSpeechOn && agentSpeechPlayer) agentSpeechPlayer.stop();
  agentLog.querySelectorAll('.reply-bar [data-act="speak"]').forEach(function (btn) { var item = agentItemFor(btn); btn.hidden = !(agentSpeechOn && item && item.speech_sig); });
}
// 🔊 を出すかは Worker の /magi2/models の features.speech で決める（Worker の設定だけで全画面から出し入れできる）
function refreshSpeechFeature() {
  loadAgentModels().then(function (j) { var on = !!(j && j.features && j.features.speech); if (on !== agentSpeechOn) { agentSpeechOn = on; syncSpeakButtons(); } });
}
// 共有は回答の本文と出典だけ。会話は公開しないので URL は付けない。Android の WebView は navigator.share を持たないので
// 公式の Share プラグインで OS の共有シートへ渡す。共有できない環境ではコピーする
async function shareAgentReply(btn, bar, item) {
  var text = agentShareText(item.content, item.sources, isJa()), title = agentTitle || 'MAGI';
  var native = window.Capacitor && window.Capacitor.isNativePlatform() && window.Capacitor.Plugins && window.Capacitor.Plugins.Share;
  try {
    if (native) { await native.share({ title: title, text: text, dialogTitle: tr('Share reply', '回答を共有') }); return; }
    if (navigator.share) { await navigator.share({ title: title, text: text }); return; }
  } catch (err) {
    if (err && (err.name === 'AbortError' || /cancel/i.test(String(err.message || '')))) return;
  }
  try { await navigator.clipboard.writeText(text); flashReactBtn(btn, '✓'); showReplyNote(bar, tr('Copied.', 'コピーしました')); }
  catch (_) { showReplyNote(bar, tr('Could not share the reply.', '共有できませんでした')); }
}
// ［ソース］の一覧は下からのシート。アイコンは Worker が付けたものだけで、画面から出典のサイトへ取りに行かない
function showAgentSourcesSheet(btn, item) {
  var open = document.getElementById('agent-sources-panel');
  if (open) { removeAgentPanel(open); return; }
  var data = cleanAgentSources(item.sources, item.content);
  if (!data) return;
  closeAgentPanels();
  var panel = document.createElement('div');
  panel.id = 'agent-sources-panel'; panel.className = 'agent-panel agent-sheet fade-in';
  panel.innerHTML = '<div class="agent-sheet-body" role="dialog" aria-modal="true" aria-label="' + tr('Sources', 'ソース') + '">'
    + '<div class="agent-panel-head"><span class="t">' + tr('Sources', 'ソース') + '</span><button type="button" class="agent-panel-close" aria-label="' + tr('Close', '閉じる') + '">✕</button></div>'
    + '<div class="src-list"></div></div>';
  var list = panel.querySelector('.src-list');
  data.items.forEach(function (it) { list.appendChild(agentSourceRowEl(it)); });
  panel.onAgentClose = function () { btn.setAttribute('aria-expanded', 'false'); if (btn.isConnected) btn.focus({ preventScroll: true }); };
  panel.addEventListener('click', function (e) { if (e.target === panel) removeAgentPanel(panel); });
  panel.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); removeAgentPanel(panel); } });
  panel.querySelector('.agent-panel-close').addEventListener('click', function () { removeAgentPanel(panel); });
  document.getElementById('app').appendChild(panel);
  btn.setAttribute('aria-expanded', 'true');
  panel.querySelector('.agent-panel-close').focus({ preventScroll: true });
}

// インストール済みのPWA・ネイティブアプリには追加の案内を出さない。
var WEB_INSTALL = !(window.Capacitor && window.Capacitor.isNativePlatform())
  && !navigator.standalone && !window.matchMedia('(display-mode: standalone)').matches;
// 言語を切り替えたら描き直すので、毎回組み立てる
function agentHintHTML() { return '<div class="agent-splash">'
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
  + '<div class="magi-sub">Multi-Agent Generative Intelligence<button type="button" id="btn-info-agent" class="magi-info-btn" title="' + tr('System & Privacy', 'システムとプライバシー') + '"><svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg></button></div>'
      + '<button type="button" id="btn-versions-agent" class="magi-ver" title="' + tr('Release History', '更新履歴') + '">ver ' + APP_VERSION + '</button>'
  + '<div class="magi-nodes">' + AGENT_PERSONAS.map(function (p) { return '<button type="button" class="magi-node" data-codename="' + p.codename + '">' + p.codename.replace('-', '·') + '</button>'; }).join('')
  + '<button type="button" class="magi-node" data-codename="' + AGENT_SYNTH.codename + '">✦ ' + AGENT_SYNTH.codename.toUpperCase() + '</button>' + '</div>'
  + '<div class="magi-desc hidden" aria-live="polite"></div>'
  + (WEB_INSTALL ? '<div class="magi-nodes"><button type="button" class="magi-node" data-install-agent>' + tr('Add to Home Screen', 'ホーム画面に追加') + '</button></div>' : '')
  + '</div>'; }

// ---- Title ------------------------------------------------------------------
function setAgentTitle(text) {
  agentTitle = (text || '').trim();
  barTitle.textContent = agentTitle || 'MAGI';
  barTitle.parentNode.title = agentTitle;
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
var currentSessionId = null;
var agentLanguageMeta = {}, agentReplyLanguage = null;
// Androidは履歴ファイルを開いた後に読み直す。
function loadCurrentSessionMeta() {
  currentSessionId = safeGet('magi_current_session_id') || null;
  agentLanguageMeta = safeParse(safeGet('magi_current_language'), {}) || {};
  agentReplyLanguage = currentSessionId && agentLanguageMeta.id === currentSessionId ? cleanReplyLanguage(agentLanguageMeta.reply_language) : null;
}
loadCurrentSessionMeta();
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
  var firstText = contentText(firstUserMsg.content) || tr('Image', '画像');
  var title = agentTitle || (firstText.slice(0, 30) + (firstText.length > 30 ? '...' : ''));
  var sessions = readSavedSessions();
  if (currentSessionId) {
    sessions = sessions.filter(function (s) { return s.id !== currentSessionId; });
  } else {
    currentSessionId = 'session_' + Date.now();
    safeStore('magi_current_session_id', currentSessionId);
  }
  sessions.unshift({ id: currentSessionId, timestamp: Date.now(), title: title, history: agentHistory.slice(), reply_language: cleanReplyLanguage(agentReplyLanguage), ...(agentShared ? { shared: agentShared } : {}) });
  if (!nativeAndroid && sessions.length > 50) sessions.pop();
  writeSavedSessions(sessions);
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
      if (trigger) showReactEmoji(trigger, em);
    }
    bar.classList.add('locked');
  });
}
var reEmoji = function (v) { return (typeof v === 'string' ? v : (v && v.em) || ''); };

// 第3回以降の枠。統合人格がこの人格に聞き返した回だけ出す（debate の followups: [{ round, ask, text }]）
function followupHTML(f) {
  var n = Number(f.round) || 0;
  return '<div class="persona-round" data-round="' + n + '"><span class="persona-round-label">' + tr('Round ' + (n || ''), '第' + (n || '') + '回') + '</span>'
    + '<div class="persona-ask">✦ ' + esc(f.ask || '') + '</div><div class="persona-text">' + esc(magiBody(f.text, f.vote, isJa()) || '…') + '</div></div>';
}

// 新規送信と履歴復元で同じカードを使う。debate 未指定なら考え中として描画する。
function personaCardsHTML(debate) {
  var personas = AGENT_PERSONAS.map(function (p) {
    var d = (debate && debate[p.codename]) || { round1: '…', round2: '…' };
    var r2has = typeof d.round2 === 'string' && d.round2 !== '…';
    return '<div class="persona-card' + (debate ? '' : ' thinking') + '" data-codename="' + p.codename + '">'
      + '<div class="persona-head"><span class="persona-hex">⬡</span><span class="persona-code">' + p.codename + '</span><span class="persona-name">' + p.name + '</span></div>'
      + '<div class="persona-round" data-round="1"><span class="persona-round-label">' + tr('Initial', '初回') + '</span><div class="persona-text">' + esc(magiBody(d.round1, d.round1Vote, isJa()) || '…') + '</div></div>'
      + '<div class="persona-round" data-round="2"' + (r2has ? '' : ' hidden') + '><span class="persona-round-label">' + tr('After debate', '討議後') + '</span><div class="persona-text">' + esc(magiBody(d.round2, d.round2Vote, isJa()) || '…') + '</div></div>'
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
  return (item.closed === true || item.mode === 'fact' ? '' : personaCardsHTML(item.debate || {}))
    + '<div class="agent-reply"><span class="agent-who">✦ Shinya Takeda' + magiThinkingHTML(item.thinkingSeconds) + '</span><span class="agent-reply-body">' + esc(item.content || '') + '</span>' + replyBarHTML() + '</div>';
}
function renderHistoryToLog(history) {
  if (agentSpeechPlayer) agentSpeechPlayer.stop();
  agentClosed = false;
  if (!agentDead) setAgentControlsEnabled(true);
  agentLog.innerHTML = '';
  agentClarifyPlaceholder(false);
  var cleanHistoryItems = cleanHistory(history), cleanHistoryLast = cleanHistoryItems.at(-1);
  cleanHistoryItems.forEach(function (item) {
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
      renderAgentSources(turn.querySelector(".agent-reply-body"), turn.querySelector(".agent-reply"), item.content, item.sources, document.documentElement.lang === "ja", false);
      setupReplyBar(turn, item);
      if (item.clarify) { renderAgentClarify(turn, item.clarify, item === cleanHistoryLast); turn.querySelector('.agent-reply .reaction-bar')?.remove(); }
      if (item.magi) magiReplay(turn, item, { ja: document.documentElement.lang === 'ja', id: item.mid, log: agentLog });
      applyReactionsToTurn(turn, item.reactions);
      if (item.closed === true) closeAgentConversation(turn);
    }
  });
  agentScroll();
  refreshSpeechFeature();
}

// ---- Lifecycle --------------------------------------------------------------
function showSplashIfEmpty() {
  if (!agentLog.children.length && !agentDead) agentLog.innerHTML = agentHintHTML();
}
function cleanHistory(history) {
  return Array.isArray(history) ? history.filter(function (m) {
    return m && (m.role === 'assistant' ? typeof m.content === 'string' : m.role === 'user'
      && (typeof m.content === 'string' || Array.isArray(m.content) && m.content.every(function (p) {
        return p && (p.type === 'text' ? typeof p.text === 'string' : p.type === 'image_url' && p.image_url && typeof p.image_url.url === 'string');
      })));
  }).map(magiCleanItem).map(cleanAgentClarifyItem).map(cleanAgentSpeechItem) : [];
}
function initAgent() {
  agentHistory = cleanHistory(safeParse(safeGet('magi_current_history'), []));
  agentShared = cleanAgentShared(safeParse(safeGet('magi_current_shared'), null));
  renderSharedDocument();
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
  if (agentSpeechPlayer) agentSpeechPlayer.stop();
  if (nativeInput) nativeInput.stopVoice();
  sharedLoading = false; agentShared = null; persistSharedDocument();
  archiveCurrentHistory();
  agentHistory = []; agentBusy = false; agentDead = false; agentClosed = false;
  safeRemove('magi_current_history');
  safeRemove('magi_current_title');
  agentLog.innerHTML = '';
  agentClarifyPlaceholder(false);
  agentDegraded.classList.add('hidden'); agentDegraded.textContent = '';
  announceAgent('');
  setAgentControlsEnabled(true); agentInput.value = ''; fitAgentInput();
  if (nativeHistory && nativeHistory.active) attachments.forEach(function (a) { if (a.file) nativeHistory.releaseImage(a.file); });
  attachments = []; attachNotice = ''; renderAttachTray();
  setAgentSuggestion('');
  closeAgentPanels();
  setAgentTitle('');
  showSplashIfEmpty();
  updateAgentActionButtons();
}
function agentDegrade(msg) {
  agentDead = true;
  agentDegraded.textContent = msg || tr('MAGI is currently unreachable. Check your connection and try again.', 'MAGIに接続できません。接続を確認して、もう一度お試しください。');
  agentDegraded.classList.remove('hidden');
  announceAgent(agentDegraded.textContent);
  setAgentControlsEnabled(false);
  renderAgentSuggest();
}
function renderAgentError(env) {
  env = env || {};
  var div = document.createElement('div'); div.className = 'agent-err fade-in';
  var meta = [env.stage, env.code].filter(Boolean).join(' / ');
  var lines = [];
  if (meta) lines.push('<div class="agent-rid">' + esc(meta) + '</div>');
  if (env.request_id) lines.push('<div class="agent-rid">request_id: ' + esc(env.request_id) + '</div>');
  div.innerHTML = '⚠ ' + esc(env.message || tr('An error occurred', 'エラーが発生しました')) + lines.join('');
  agentLog.appendChild(div);
  announceAgent(env.message || tr('An error occurred', 'エラーが発生しました'));
  agentScroll();
}

// ---- SSE --------------------------------------------------------------------
// MAGI_PRESENTATION_CORE_BEGIN
var MAGI_IDS=["MELCHIOR-1","BALTHASAR-2","CASPER-3"],MAGI_TIME={slot:600,pulse:300,pause:600,catchup:2e3,flicker:[240,300,360],phase:60,tick:30,character:18},MAGI_COLORS={ground:"#000000",orange:"#c8662a",teal:"#5fa8a0",blue:"#4f7aaa",off:"#000000",approve:"#4f7aaa",reject:"#d96a70",approveCarried:"#8ba4be",rejectCarried:"#e5a0a4",gray:"#888888",hatch:"#b5b5b5",ink:"#000000"};
function magiBody(text,vote,ja){return text===""&&vote?ja?"（理由なし）":"(no reason given)":text}
function magiMotion(text){if(typeof text!="string"||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(text))return null;var s=text.trim().replace(/[\r\n\t]+/g," ");return s&&s.length<=120?s:null}
function magiClean(v){if(!v||typeof v!="object")return null;if(v.votable===!1){var reason=v.reason===void 0?"not_votable":v.reason;return v.motion===""&&["not_votable","failed"].indexOf(reason)>=0?{motion:"",votable:!1,reason}:null}var motion=magiMotion(v.motion),t=v.tally,count={approve:0,reject:0,none:0},votes={};if(!motion||!t||!Number.isInteger(v.rounds)||v.rounds<1||v.rounds>5||typeof v.reason_missing!="boolean"||!v.votes)return null;for(var i=0;i<3;i++){var k=MAGI_IDS[i],x=v.votes[k];if(!x||["voted","carried","unreadable","absent"].indexOf(x.state)<0)return null;if(x.state==="voted"||x.state==="carried"){if(["approve","reject"].indexOf(x.vote)<0||!Number.isInteger(x.round)||x.round<1||x.round>v.rounds||(x.state==="carried"?x.round>=v.rounds||["no_response","unreadable"].indexOf(x.issue)<0:x.issue!==void 0))return null}else if(x.vote!==null||x.round!==null||x.issue!==void 0)return null;votes[k]={vote:x.vote,round:x.round,state:x.state},x.issue&&(votes[k].issue=x.issue),count[x.vote||"none"]++}return!["approve","reject","none"].every(function(k2){return Number.isInteger(t[k2])&&t[k2]===count[k2]})||v.result!==(count.approve>=2?"approve":count.reject>=2?"reject":"hold")?null:{motion,result:v.result,tally:count,rounds:v.rounds,votes,reason_missing:v.reason_missing}}
function magiCleanItem(item){var out=Object.assign({},item);delete out.mode,delete out.magi;delete out.sources;if(item.role==="assistant"&&item.mode==="fact"){out.mode="fact";delete out.debate;var sources=cleanAgentSources(item.sources,item.content);if(sources)out.sources=sources;return out}var m=item.mode==="magi"?magiClean(item.magi):null;return m&&(out.mode="magi",out.magi=m),out}
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
      let buf = '', skipLF = false, receivedEnd = false, playback = null, playbackError = null;
      let timer = null, wake = null;
      const queue = [], settings = magiStreamSettings();
      const alive = () => !handlers.alive || handlers.alive();
      const classificationState = { started: false, classified: false, language: handlers.replyLanguage || null, panel: handlers.magiPanel === true };
      const dispatch = item => { if (alive() && handlers[item.ev]) handlers[item.ev](item.data); };
      // 停止・期限・切断は受信済みの列を先に反映する。会話切り替えだけは古い列を捨てる。
      const flush = () => {
        clearTimeout(timer); timer = null;
        try { while (queue.length) dispatch(queue.shift()); }
        finally {
          queue.length = 0;
          if (wake) { const resolve = wake; wake = null; resolve(); }
        }
      };
      const abort = () => {
        try { flush(); } catch (err) { playbackError = err; }
        reader.cancel().catch(() => {});
      };
      const check = () => {
        if (playbackError) throw playbackError;
        if (!alive()) throw new Error('stale_stream');
        if (!receivedEnd) handlers.signal?.throwIfAborted();
      };
      const pump = () => {
        if (playback || !queue.length) return;
        playback = (async () => {
          while (queue.length) {
            check();
            const item = queue[0];
            if (item.wait) await new Promise(resolve => { wake = resolve; timer = setTimeout(resolve, item.wait); });
            timer = null; wake = null;
            check();
            // 待つ間の停止で flush されたものを二重に渡さない。
            if (queue[0] === item) { queue.shift(); dispatch(item); }
          }
        })().catch(err => { playbackError = err; reader.cancel().catch(() => {}); })
          .finally(() => { playback = null; if (queue.length && !playbackError) pump(); });
      };
      const block = text => {
        check();
        let ev = 'message', data = '';
        text.split('\n').forEach(line => {
          if (line.startsWith('event:')) ev = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).replace(/^ /, '') + '\n';
        });
        if (!data || ['classification','title','error','motion','persona','ask','judge','verdict','integrated','integrated_end','closed','clarify','sources','pages','suggest','speech','done'].indexOf(ev) < 0) return false;
        const parsed = JSON.parse(data.replace(/\n$/, ''));
        // 契約の検査は受信時に行い、表示の遅延で終端や決議の検査を遅らせない。
        receiveClassification(classificationState, ev, parsed);
        const terminal = ev === 'done' || ev === 'error';
        if (terminal) { receivedEnd = true; if (handlers.streamWatch) handlers.streamWatch.end(); }
        if (!handlers.streamWatch?.isBuffered() || ev === 'classification' || ev === 'title') dispatch({ ev, data: parsed });
        else if (ev === 'integrated' && typeof parsed.delta === 'string') {
          const chars = Array.from(parsed.delta);
          for (let i = 0; i < chars.length; i += settings.text_chars) {
            queue.push({ ev, data: { ...parsed, delta: chars.slice(i, i + settings.text_chars).join('') }, wait: settings.text_ms });
          }
        } else queue.push({ ev, data: parsed, wait: ['motion','persona','ask','judge','verdict'].includes(ev) ? settings.event_ms : 0 });
        return terminal;
      };
      handlers.signal?.addEventListener('abort', abort, { once: true });
      try {
        check();
        while (true) {
          const { done, value } = await reader.read();
          check();
          if (done) break;
          if (onChunk) onChunk();
          if (handlers.streamWatch) handlers.streamWatch.chunk();
          check();
          let chunk = dec.decode(value, { stream: true });
          if (!chunk) continue;
          if (skipLF && chunk[0] === '\n') chunk = chunk.slice(1);
          skipLF = chunk.endsWith('\r');
          buf += chunk.replace(/\r\n?/g, '\n');
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const text = buf.slice(0, i); buf = buf.slice(i + 2);
            if (block(text)) break;
          }
          // 塊の再生を20秒以内に収める。読み取りは再生と並行して進める。
          const duration = queue.reduce((sum, item) => sum + item.wait, 0);
          if (duration > settings.batch_ms) queue.forEach(item => { item.wait *= settings.batch_ms / duration; });
          pump();
          if (receivedEnd) break;
        }
        if (!receivedEnd) flush(); // EOF でも受信済みの決議は残す（done の欠落は呼び出し側が扱う）。
        while (playback) await playback;
        check();
      } catch (err) {
        flush();
        throw err;
      } finally {
        handlers.signal?.removeEventListener('abort', abort);
        clearTimeout(timer);
        await reader.cancel().catch(() => {}); reader.releaseLock();
      }
    }

    // 3画面で同じ値を使う。トップページのインスクリプション版のため外部資産へ分離しない。
    function magiStreamSettings() {
      return { deadline_ms: 300000, gap_ms: 15000, event_ms: 700, text_chars: 12, text_ms: 30, batch_ms: 20000 };
    }
    function createMagiStreamWatch(ctrl, startedAt, options) {
      const settings = magiStreamSettings();
      let buffered = false, ended = false, lastChunk = startedAt, gapTimer = null;
      const deadlineTimer = setTimeout(() => { options.timeout(); ctrl.abort(); }, Math.max(0, settings.deadline_ms - (Date.now() - startedAt)));
      const show = value => { if (options.alive()) options.notice(value); };
      const gap = () => {
        clearTimeout(gapTimer);
        gapTimer = setTimeout(() => { buffered = true; show(true); }, settings.gap_ms);
      };
      const finish = () => { clearTimeout(deadlineTimer); clearTimeout(gapTimer); show(false); };
      gap();
      return {
        chunk() {
          if (Date.now() - lastChunk >= settings.gap_ms) buffered = true;
          lastChunk = Date.now(); show(false); if (!ended) gap();
        },
        end() { ended = true; finish(); if (buffered && options.alive()) options.replaying(); },
        finish,
        isBuffered() { return buffered; },
      };
    }
    function magiStreamNotice(target, visible, ja) {
      let note = target.querySelector('.magi-stream-note');
      if (!visible) { if (note) note.remove(); return; }
      if (!note) {
        note = document.createElement('div'); note.className = 'magi-stream-note';
        note.style.cssText = 'font-size:12px;line-height:1.6;opacity:.75;margin-top:8px';
        note.setAttribute('role', 'status'); target.appendChild(note);
      }
      note.textContent = ja ? 'この環境では途中経過がまとめて届くようです。最後まで待って表示します（最大5分）'
        : 'Progress seems to arrive all at once on this network. Waiting for the full reply (up to 5 minutes).';
    }

// ---- 画像添付（マルチモーダル入力）------------------------------------------
// 画像は data URL のまま Worker → 各人格の API（OpenAI・DeepSeek・Anthropic）へ送る。送信用（長辺1024）と保存用
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
  updateSendState();
  if (!attachments.length && !attachNotice) { attachTray.classList.add('hidden'); attachTray.innerHTML = ''; return; }
  attachTray.classList.remove('hidden');
  attachTray.innerHTML = attachments.map(function (a, i) {
    return '<span class="attach-chip"><img src="' + a.thumb + '" alt="">'
      + '<button type="button" class="attach-x" data-i="' + i + '" aria-label="Remove attachment"><span aria-hidden="true">×</span></button></span>';
  }).join('') + (attachNotice ? '<span class="attach-note">' + esc(attachNotice) + '</span>' : '');
}
function noticeAttach(msg) {
  attachNotice = msg; renderAttachTray();
  setTimeout(function () { attachNotice = ''; renderAttachTray(); }, 2500);
}
async function addAttachments(files) {
  if (agentDead || agentClosed) return;
  var generation = agentGen;
  var list = Array.prototype.slice.call(files || []).filter(isImageFile);
  // ファイルの一覧では画像以外も選べるので、黙って捨てずに知らせる
  if (!list.length) { if (files && files.length) noticeAttach(tr('Only images can be attached', '画像だけを添付できます')); return; }
  for (var i = 0; i < list.length; i++) {
    if (attachments.length >= ATTACH_MAX) { noticeAttach(tr('Up to ' + ATTACH_MAX + ' images', '画像は' + ATTACH_MAX + '枚までです')); break; }
    try {
      var img = await loadImageFile(list[i]);
      if (generation !== agentGen) return;
      var original = nativeHistory && nativeHistory.active ? await nativeHistory.storeImage(list[i]) : null;
      if (generation !== agentGen) { if (original) nativeHistory.releaseImage(original); return; }
      if (original) nativeHistory.retainImage(original);
      attachments.push({ url: downscaleImage(img, ATTACH_SEND_DIM, 0.82), thumb: downscaleImage(img, ATTACH_THUMB_DIM, 0.7), file: original });
      renderAttachTray();
    } catch (_) { noticeAttach(tr('Could not read that image', 'その画像を読み込めませんでした')); }
  }
}
// ユーザー発言の吹き出し中身（サムネ＋本文）
function userContentHTML(content) {
  if (typeof content === 'string') return esc(content);
  var imgs = contentImages(content).map(function (p) {
    return '<img src="' + esc(p.image_url.url) + '"' + (nativeAndroid && p.file ? ' data-original="' + esc(p.file) + '" role="button" tabindex="0" aria-label="Open original image"' : '') + ' alt="Attached image" loading="lazy">';
  }).join('');
  return (imgs ? '<span class="agent-imgs">' + imgs + '</span>' : '') + esc(contentText(content));
}

// ＋ から添付元を選ぶ。カメラは capture で撮影アプリを開く（Android は Capacitor が開き、カメラの権限は持たない）。
// 写真は画像の選択画面、ファイルは端末のファイル一覧から選ぶ。どれも addAttachments が画像だけを受け付ける。
var attachMenu = document.getElementById('agent-attach-menu');
var ATTACH_SOURCES = {
  camera: { accept: 'image/*', capture: 'environment', multiple: false },
  photo: { accept: 'image/*', multiple: true },
  file: { accept: '*/*', multiple: true },
};
function setAttachMenu(open) {
  attachMenu.hidden = !open;
  attachBtn.setAttribute('aria-expanded', String(open));
  if (!open) return;
  // 撮影できない PC ではカメラを出さない
  attachMenu.querySelector('[data-source="camera"]').hidden = !nativeAndroid && !matchMedia('(pointer: coarse)').matches;
  attachMenu.querySelector('[data-source]:not([hidden])').focus();
}
// 開いていたら閉じて true を返す（Android の戻るボタンも使う）
function closeAttachMenu() {
  if (attachMenu.hidden) return false;
  setAttachMenu(false); return true;
}
attachBtn.addEventListener('click', function () { setAttachMenu(attachMenu.hidden); });
attachMenu.addEventListener('click', function (e) {
  var item = e.target.closest('[data-source]'); if (!item) return;
  var source = ATTACH_SOURCES[item.dataset.source];
  attachFile.accept = source.accept; attachFile.multiple = source.multiple;
  if (source.capture) attachFile.setAttribute('capture', source.capture); else attachFile.removeAttribute('capture');
  setAttachMenu(false); attachFile.click();
});
attachMenu.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') { setAttachMenu(false); attachBtn.focus(); return; }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  var items = Array.prototype.filter.call(attachMenu.querySelectorAll('[data-source]'), function (item) { return !item.hidden; });
  var next = items.indexOf(document.activeElement) + (e.key === 'ArrowDown' ? 1 : -1);
  e.preventDefault(); items[(next + items.length) % items.length].focus();
});
document.addEventListener('pointerdown', function (e) {
  if (!attachMenu.hidden && !e.target.closest('#agent-attach-menu, #agent-attach')) setAttachMenu(false);
});
attachFile.addEventListener('change', function () { addAttachments(attachFile.files); attachFile.value = ''; });
attachTray.addEventListener('click', function (e) {
  var x = e.target.closest('.attach-x'); if (!x) return;
  var removed = attachments.splice(Number(x.dataset.i), 1)[0];
  if (removed && removed.file && nativeHistory && nativeHistory.active && !attachments.some(function (a) { return a.file === removed.file; })) nativeHistory.releaseImage(removed.file);
  renderAttachTray();
});
// 画像はクリップボードからの貼り付けでも添付できる
agentInput.addEventListener('paste', function (e) {
  var files = Array.prototype.slice.call((e.clipboardData && e.clipboardData.files) || []);
  if (!files.length) return;
  e.preventDefault(); addAttachments(files);
});
// 確認質問の選択肢を押したあと、送信ボタンの濃さを見直す
agentLog.addEventListener('click', updateSendState);
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
  function add(title, description, raw) {
    if (typeof title !== 'string' || typeof description !== 'string' || typeof raw !== 'string') return;
    try {
      var u = new URL(raw);
      if (u.origin !== 'https://tk.st' || u.username || u.password || u.search || u.hash) return;
      var a = document.createElement('a'); a.className = 'agent-page'; a.href = u.href;
      a.target = '_blank'; a.rel = 'noopener noreferrer';
      var name = document.createElement('strong'); name.textContent = title; a.appendChild(name);
      if (description) { var desc = document.createElement('span'); desc.textContent = description; a.appendChild(desc); }
      panel.appendChild(a);
    } catch (_) {}
  }
  data.pages.forEach(function (p) { if (p && ['tool', 'game', 'article', 'page'].includes(p.kind)) add(p.title, p.description, p.url); });
  if (panel.children.length) replyEl.appendChild(panel);
}

function prepareAgentMessages(history, lastContent) {
  // 考えた秒数・受信の印・読み上げの署名は画面のためだけのもので、次の質問の API には送らない
  const messages = cleanHistory(history).slice(-AGENT_MAX_HISTORY).map(({ thinkingSeconds, native_request, speech_sig, speech_lang, ...m }) => agentFactHistoryMessage(m));
  while (messages[0] && messages[0].role === 'assistant') messages.shift();
  messages[messages.length - 1].content = lastContent;
  let remaining = 8;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!Array.isArray(m.content)) continue;
    const kept = [];
    for (const part of m.content) {
      if (part.type !== 'image_url') kept.push(part);
      else if (remaining > 0) { var imagePart = Object.assign({}, part); delete imagePart.file; kept.push(imagePart); remaining--; }
    }
    // 画像だけだった古い質問も、会話上の位置は残す。
    m.content = kept.length ? kept : '[Earlier images omitted]';
  }
  return messages;
}

// While a reply is being generated the send button becomes a stop button (■). Pressing it drops the
// connection, and the Worker stops its remaining upstream calls too.
var AGENT_SEND_ICON = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
var AGENT_STOP_ICON = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor"/></svg>';
function labelSendButton() {
  agentSendBtn.title = agentSendBtn.ariaLabel = agentSendBtn.dataset.stop ? tr('Stop', '停止') : tr('Send', '送信');
}
function labelVoiceButton() {
  var voice = document.getElementById('agent-voice');
  voice.title = voice.getAttribute('aria-pressed') === 'true' ? tr('Stop voice input', '音声入力を止める') : tr('Voice input', '音声入力');
}
function setAgentStopMode(on) {
  agentSendBtn.innerHTML = on ? AGENT_STOP_ICON : AGENT_SEND_ICON;
  agentSendBtn.dataset.stop = on ? '1' : '';
  labelSendButton();
  if (on) agentSendBtn.disabled = false;
  updateSendState();
}
function agentStop() {
  if (!agentCtrl) return;
  agentCtrl.userStopped = true;
  agentCtrl.abort();
}

async function agentSend(recovered) {
  if (agentSpeechPlayer) agentSpeechPlayer.stop();
  if (historyLoading || sharedLoading || agentBusy || agentDead || agentClosed) return;
  // 音声入力中の送信は確定だけにする。保存列の復元は新規送信と区別する。
  if (!recovered && nativeInput && nativeInput.listening()) { nativeInput.finishVoice(); return; }
  var savedUser = recovered ? agentHistory.at(-1) : null;
  if (recovered && (!nativeConversation || !savedUser || savedUser.role !== 'user' || savedUser.native_request !== recovered.id)) return;
  var draftText = recovered ? contentText(savedUser.content) : agentInput.value;
  var text = recovered ? draftText : agentClarifyAnswer(lastAgentTurn(), draftText.trim());
  if (text === null) { announceAgent(document.documentElement.lang === 'ja' ? '回答全体を1000文字以内、その他を100文字以内にしてください。' : 'Keep the full answer within 1,000 characters and Other within 100.'); return; }
  var atts = recovered ? contentImages(savedUser.content).map(function (p) { return { url: p.image_url.url, thumb: p.image_url.url, file: p.file }; }) : attachments.slice();
  if (!text && !atts.length) return;
  var clarifyDraft = freezeAgentClarify();
  var startedAt = recovered ? recovered.startedAt : Date.now();
  setAgentSuggestion('');
  agentInput.value = ''; fitAgentInput();
  attachments = []; renderAttachTray();
  // 送信は長辺1024、履歴に残すのはサムネ（端末のストレージを食い潰さないため）
  var partsOf = function (key) {
    return (text ? [{ type: 'text', text: text }] : []).concat(atts.map(function (a) {
      var part = { type: 'image_url', image_url: { url: a[key] } };
      if (key === 'thumb' && a.file) part.file = a.file;
      return part;
    }));
  };
  var sendContent = atts.length ? partsOf('url') : text;
  var storeContent = recovered ? savedUser.content : atts.length ? partsOf('thumb') : text;
  if (agentLog.children.length === 1 && agentLog.firstElementChild.classList.contains('agent-splash')) agentLog.innerHTML = '';
  agentClarifyPlaceholder(false);

  var u = recovered ? agentLog.lastElementChild : document.createElement('div');
  if (!recovered) { u.className = 'agent-user fade-in'; u.innerHTML = '<span>' + userContentHTML(storeContent) + '</span>'; agentLog.appendChild(u); }

  var turn = document.createElement('div'); turn.className = 'fade-in agent-turn';
  var mid = recovered ? recovered.mid : genMid(); turn.dataset.mid = mid; pendingReactions[mid] = {};
  var nativeRunId = recovered ? recovered.id : nativeConversation ? nativeConversation.id() : null;
  turn.innerHTML = personaCardsHTML();
  var replyEl = document.createElement('div'); replyEl.className = 'agent-reply streaming';
  replyEl.innerHTML = '<span class="agent-who">✦ Shinya Takeda</span><span class="agent-reply-body"></span>' + replyBarHTML();
  turn.appendChild(replyEl);
  agentLog.appendChild(turn); agentScroll();
  var replyBody = replyEl.querySelector('.agent-reply-body');
  var thinking = startMagiThinking(replyEl.querySelector('.agent-who'), startedAt);

  if (!recovered) agentHistory.push({ role: 'user', content: storeContent, ...(nativeRunId ? { native_request: nativeRunId } : {}) });
  safeStore('magi_current_history', agentHistory);
  if (!recovered && nativeHistory && nativeHistory.active) atts.forEach(function (a) { if (a.file) nativeHistory.releaseImage(a.file); });

  agentBusy = true; setAgentControlsEnabled(false);
  setAgentStopMode(true);
  var reply = '', errored = false, timedOut = false, suggestion = '', completed = false, sitePages = null, classified = false;
      var magiMeta = null, magiView = null, integratedEnd = false, magiRetained = false;
      var closedReply = false, factReply = false, replySources = null, clarifyReply = null, speechSig = null, speechLang = null;
      var sendId = ++agentSendSequence;
  var debateData = {};
  AGENT_PERSONAS.forEach(function (p) { debateData[p.codename] = { round1: '…', round2: '…', followups: [] }; });

  var ctrl = new AbortController();
  var conversationId = ensureAgentConversation();
  var gen = agentGen; agentCtrl = ctrl;

  var dropped = function () { return gen !== agentGen || conversationId !== currentSessionId || sendId !== agentSendSequence; };
      const streamWatch = nativeConversation ? nativeConversation.watch() : createMagiStreamWatch(ctrl, startedAt, {
        alive: () => !dropped(), timeout: () => { timedOut = true; },
        notice: visible => magiStreamNotice(replyEl, visible, document.documentElement.lang === 'ja'),
        replaying: () => { agentSendBtn.title = agentSendBtn.ariaLabel = document.documentElement.lang === 'ja' ? 'すぐに全部表示' : 'Show all now'; },
      });
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
      // parser の同期 flush が済んでから、表示の演出も最終状態へ進める。
      ctrl.signal.addEventListener('abort', function () {
        Promise.resolve().then(function () {
          if (magiView) { if (dropped()) magiView.dispose(); else magiView.finish(); }
          if (!completed) thinking.cancel();
        });
      }, { once: true });
      // MAGI_SEND_END

  try {
    if (dropped()) return;
    if (ctrl.signal.aborted) throw new DOMException('stopped', 'AbortError');
    var theme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    var outbound = prepareAgentMessages(agentHistory, sendContent);
    var requestBody = JSON.stringify(Object.assign({ messages: outbound, theme, suggest: true, site_pages: true, page: 'app', adaptive_debate: true }, classificationFields(agentHistory, agentReplyLanguage, isJa() ? 'ja' : 'en', 'chat', true), nativeAndroid && agentShared ? { shared: agentShared } : {}));
    if (nativeConversation && !recovered) { syncCurrentToSaved(); await nativeHistory.flush(); }
    if (dropped() || ctrl.signal.aborted) throw new DOMException('stopped', 'AbortError');
    var res = nativeConversation ? await nativeConversation.open(requestBody, { id: nativeRunId, sessionId: conversationId, mid: mid, title: agentTitle || text.slice(0, 80), ctrl: ctrl, resume: !!recovered }) : await fetch(AGENT_API, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: requestBody,
      signal: ctrl.signal,
    });
    if (dropped()) return;
    if (!res.ok || !res.body) {
      var raw = await res.text().catch(function () { return ''; });
      if (dropped()) return;
      var env = null; try { env = JSON.parse(raw).error; } catch (_) { }
      if (!env) env = { message: ('HTTP ' + res.status + ' ' + (res.statusText || '')).trim(), code: 'http_' + res.status };
      console.error('[agent] request failed', AGENT_API, res.status, raw.slice(0, 800));
      turn.remove(); renderAgentError(env); errored = true;
    } else {
      await parseSSE(res.body, {
        replyLanguage: agentReplyLanguage, magiPanel: true, signal: ctrl.signal, streamWatch, alive: () => !dropped(),
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
            closed: function () { if (!dropped()) { closedReply = true; turn.querySelector('.agent-personas')?.remove(); } },
            // MAGI_EVENTS_END
        classification: function (d) { if (!dropped()) { classified = true; saveAgentLanguage(d.reply_language); factReply = d.mode === "fact"; if (factReply) turn.querySelector(".agent-personas")?.remove(); } },
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
        clarify: function (d) { if (!dropped()) { clarifyReply = cleanAgentClarify(d); reply = agentClarifyText(clarifyReply); thinking.finish(); } },
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
        sources: function (d) { if (!dropped()) replySources = d; },
        // 読み上げの署名（読み上げ設計§5.2）。Worker が書いた回答の本文に対するもので、履歴に保存する
        speech: function (d) { if (!dropped()) { speechSig = cleanSpeechSig(d && d.sig); speechLang = cleanSpeechLang(d && d.lang); } },
        done: function () { completed = true; streamWatch.finish(); },
      });
          if (magiView && completed && !errored && !dropped()) await magiView.wait();
      if (!dropped() && !errored && (!completed || !reply.trim())) {
        errored = true; if (!keepMagi()) turn.remove();
        if (!magiRetained) renderAgentError({ message: tr('The complete reply was not received. Please try again.', '返事を最後まで受け取れませんでした。もう一度お試しください。'), code: 'incomplete_reply' });
      }
    }
  } catch (err) {
    errored = true;
    if (err.code === 'timeout') timedOut = true;
    if (dropped()) return;
    if (!keepMagi()) turn.remove();
    // Stopped with the stop button: no error; the question goes back into the input below.
    if (!magiRetained && !ctrl.userStopped) {
      if (timedOut || err.name === 'AbortError') { renderAgentError({ message: tr('Request timed out. Please try again.', 'リクエストがタイムアウトしました。もう一度お試しください。'), code: 'timeout' }); }
      else if (err.code === 'interrupted') { renderAgentError({ message: document.documentElement.lang === 'ja' ? '前の接続が終了し、回答を受け取れませんでした。質問を確認して再送してください。' : 'The previous connection ended before the reply was received. Review your question and send it again.', code: 'interrupted' }); }
      else { console.error('[agent] fetch failed', AGENT_API, err); renderAgentError({ message: tr('Could not receive the reply. Check your connection and try again.', '返事を受け取れませんでした。接続を確認して、もう一度お試しください。'), code: 'network_error' }); }
    }
  } finally {
    if (nativeConversation && nativeRunId && (!completed || errored || dropped())) await nativeConversation.cancel(nativeRunId).catch(function () {});
    streamWatch.finish();
    if (magiView) magiView.dispose();
    if (!completed || errored || dropped()) thinking.cancel();
    if (agentCtrl === ctrl) agentCtrl = null;
    // A dropped request restores the button too, unless a newer send has already taken it over.
    if (!dropped() || !agentBusy) setAgentStopMode(false);
    if (dropped()) delete pendingReactions[mid];
    if (!dropped()) {
      replyEl.classList.remove('streaming');
      agentBusy = false;
      loadUsage();
      // 短い返しで閉じる会話は、下の closeAgentConversation が閉じる。ここで開けてフォーカスすると
      // スマホでキーボードが一瞬開く
      if (agentDead) agentSendBtn.disabled = true;
      else if (!(closedReply && completed && !errored)) { setAgentControlsEnabled(true); if (!document.hidden) agentInput.focus({ preventScroll: true }); }
    }
  }
  if (dropped()) return; // 予約したリアクションは finally で消してある
  if (completed && reply.trim() && !errored || magiRetained) {
    renderAgentPages(replyEl, sitePages);
        renderAgentSources(replyBody, replyEl, reply, replySources, document.documentElement.lang === "ja", false);
    if (!magiView) announceAgent(tr('MAGI replied. ', 'MAGIが回答しました。') + reply);
    // この送信だけのオブジェクトで、ストリーム終了後は更新しないので、そのまま保存する。
    Object.keys(debateData).forEach(function (cn) { if (debateData[cn].round2 === '…') delete debateData[cn].round2; });
    if (closedReply) closeAgentConversation(turn);
    if (clarifyReply) { renderAgentClarify(turn, clarifyReply, true); replyEl.querySelector('.reaction-bar')?.remove(); }
    agentHistory.push({ role: 'assistant', content: reply, thinkingSeconds: thinking.finish(), ...(closedReply ? { closed: true } : factReply ? { mode: "fact", sources: cleanAgentSources(replySources, reply) } : { debate: debateData }), ...(magiMeta ? { mode: 'magi', magi: magiMeta } : {}), ...(clarifyReply ? { clarify: clarifyReply } : {}), ...(nativeRunId ? { native_request: nativeRunId } : {}), ...(speechSig && !closedReply && !clarifyReply && completed ? { speech_sig: speechSig, ...(speechLang ? { speech_lang: speechLang } : {}) } : {}), mid: mid, reactions: pendingReactions[mid] || {} });
    delete pendingReactions[mid];
    setupReplyBar(turn, agentHistory[agentHistory.length - 1]);
    refreshSpeechFeature();
    safeStore('magi_current_history', agentHistory);
    syncCurrentToSaved();
    updateAgentActionButtons();
    setAgentSuggestion(completed && !clarifyReply && !closedReply && !magiMeta?.reason_missing ? suggestion : '');
  } else {
    turn.remove(); u.remove(); delete pendingReactions[mid];
    if (nativeHistory && nativeHistory.active && !agentInput.value) atts.forEach(function (a) { if (a.file) nativeHistory.retainImage(a.file); });
    var last = agentHistory[agentHistory.length - 1];
    if (last && last.role === 'user' && last.content === storeContent) agentHistory.pop();
    safeStore('magi_current_history', agentHistory); syncCurrentToSaved(); updateAgentActionButtons();
    // 中断・通信失敗でも、質問と画像を戻して同じ会話で送り直せるようにする。
    if (!agentInput.value) { agentInput.value = clarifyDraft ? draftText : text; attachments = atts; renderAttachTray(); fitAgentInput(); }
    restoreAgentClarify(clarifyDraft);
    if (recovered && attachments === atts && atts.some(function (a) { return a.file; })) {
      sharedLoading = true;
      var restored = await restoreNativeRequestImages(atts);
      if (!dropped()) {
        sharedLoading = false;
        if (attachments === atts) { attachments = restored; renderAttachTray(); }
      }
    }
  }
  if (nativeConversation && nativeRunId) {
    try { await nativeHistory.flush(); await nativeConversation.acknowledge(nativeRunId); }
    catch (_) { announceAgent(tr('Could not finish saving the reply. Reopen MAGI to recover it.', '保存を完了できませんでした。開き直すと受信データから復元します。')); }
  }
}

async function restoreNativeRequestImages(items) {
  var restored = [];
  for (var item of items) {
    if (!item.file) { restored.push(item); continue; }
    try {
      if (!/^[a-f0-9]{64}\.(?:jpg|png|gif|webp|heic|heif|avif)$/.test(item.file)) throw new Error('invalid_image');
      var raw = await window.Capacitor.Plugins.Filesystem.readFile({ directory: 'DATA', path: 'magi/images/' + item.file });
      var bytes = Uint8Array.from(atob(raw.data), function (ch) { return ch.charCodeAt(0); });
      var img = await loadImageFile(new Blob([bytes], { type: 'image/' + item.file.split('.').pop().replace('jpg', 'jpeg') }));
      restored.push({ url: downscaleImage(img, ATTACH_SEND_DIM, 0.82), thumb: item.thumb, file: item.file });
    } catch (_) { restored.push(item); announceAgent(tr('Could not reopen an original image; the saved preview is available.', '元画像を開けないため、保存したプレビューを使います。')); }
  }
  return restored;
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
    else renderAgentError({ message: tr('Could not remove the reaction. Please try again.', 'リアクションを取り消せませんでした。もう一度お試しください。'), code: 'reaction_remove_failed' });
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
  if (e.target.closest('#btn-versions-agent')) { e.preventDefault(); showVersionsPanel(); return; }
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
    if (!agentModels || Date.now() >= agentModelsExpires) loadAgentModels().then(function () { if (node.classList.contains('active')) desc.innerHTML = personaDescHTML(p); });
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
    showReactEmoji(trigger, em);
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

  if (act === 'speak' || act === 'share' || act === 'sources') {
    var item = agentItemFor(bar2);
    if (!item) return;
    if (act === 'speak') { if (item.speech_sig) agentSpeech().toggle(btn, item.content, item.speech_sig, item.speech_lang || null); }
    else if (act === 'share') shareAgentReply(btn, bar2, item);
    else showAgentSourcesSheet(btn, item);
    return;
  }
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
      undoReaction(bar2, ctx2.target, function () { clearReactEmoji(btn); });
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
// 画面を離れたら読み上げを止める（バックグラウンドでは鳴らさない）
document.addEventListener('visibilitychange', function () { if (document.hidden && agentSpeechPlayer) agentSpeechPlayer.stop(); });

// ---- Overlay panels (saved chats / info) -----------------------------------
var AGENT_PANEL_IDS = ['agent-history-panel', 'agent-versions-panel', 'agent-info-panel', 'agent-install-panel', 'agent-settings-panel', 'agent-image-panel', 'agent-shared-panel', 'agent-sources-panel'];
// パネルはどの閉じ方（✕・暗幕・Esc・戻る・別のパネル）でもここを通す。後始末は panel.onAgentClose が受け持つ。
function removeAgentPanel(panel) {
  if (!panel.isConnected) return;
  var hadFocus = panel.contains(document.activeElement);
  panel.remove();
  if (panel.onAgentClose) panel.onAgentClose(hadFocus);
}
function closeAgentPanels() { AGENT_PANEL_IDS.forEach(function (id) { var p = document.getElementById(id); if (p) removeAgentPanel(p); }); }
function makeAgentPanel(id, title, bodyHTML) {
  if (document.getElementById(id)) { removeAgentPanel(document.getElementById(id)); return null; }
  closeAgentPanels();
  var panel = document.createElement('div');
  panel.id = id; panel.className = 'agent-panel fade-in';
  panel.innerHTML = '<div class="agent-panel-head"><span class="t">' + title + '</span>'
    + '<button type="button" class="agent-panel-close">' + tr('✕ CLOSE', '✕ 閉じる') + '</button></div>'
    + '<div class="agent-panel-body">' + bodyHTML + '</div>';
  document.getElementById('app').appendChild(panel);
  panel.querySelector('.agent-panel-close').addEventListener('click', function () { removeAgentPanel(panel); });
  return panel;
}
// ☰ で左から出す。新しい会話と保存した会話の一覧を並べ、外側の暗幕・✕・Esc・戻るで閉じる。
// 開いている間は Tab をシートの中で回し、閉じたらフォーカスを ☰ に戻す。
function showHistoryPanel() {
  var menuBtn = document.getElementById('btn-history-agent');
  var open = document.getElementById('agent-history-panel');
  if (open) { removeAgentPanel(open); return; }
  closeAgentPanels();
  var panel = document.createElement('div');
  panel.id = 'agent-history-panel'; panel.className = 'agent-panel agent-drawer fade-in';
  panel.innerHTML = '<div class="agent-drawer-sheet" role="dialog" aria-modal="true" aria-label="' + tr('Chats', 'チャット') + '">'
    + '<div class="agent-panel-head"><span class="t glow">✦ MAGI</span><button type="button" class="agent-panel-close" aria-label="' + tr('Close', '閉じる') + '">✕</button></div>'
    + '<button type="button" id="btn-reset" class="drawer-new">'
    + '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>'
    + '<span>' + tr('New chat', '新しいチャット') + '</span></button><div class="drawer-label">' + tr('Chats', 'チャット') + '</div><div id="agent-history-list"></div></div>';
  panel.onAgentClose = function (hadFocus) {
    menuBtn.setAttribute('aria-expanded', 'false');
    if (hadFocus) menuBtn.focus({ preventScroll: true });
  };
  panel.addEventListener('click', function (e) { if (e.target === panel) removeAgentPanel(panel); });
  panel.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { e.preventDefault(); removeAgentPanel(panel); return; }
    if (e.key !== 'Tab') return;
    var items = panel.querySelectorAll('button:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])');
    var first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  panel.querySelector('.agent-panel-close').addEventListener('click', function () { removeAgentPanel(panel); });
  panel.querySelector('#btn-reset').addEventListener('click', function () { resetAgent(); closeAgentPanels(); });
  document.getElementById('app').appendChild(panel);
  menuBtn.setAttribute('aria-expanded', 'true');
  renderSavedSessionsList();
  panel.querySelector('#btn-reset').focus({ preventScroll: true });
}
function showInstallPanel() {
  var steps = [
    ['Open <strong>tk.st/magi-app/www/</strong> in <strong>Safari</strong> on your iPhone.', 'iPhoneの<strong>Safari</strong>で<strong>tk.st/magi-app/www/</strong>を開きます。'],
    ['Tap <strong>Share</strong> (the square with an upward arrow). Depending on the Safari layout, open the page menu first.', '<strong>共有</strong>（上向きの矢印の付いた四角）を押します。Safariのレイアウトによっては、先にページのメニューを開きます。'],
    ['Choose <strong>Add to Home Screen</strong>. If it is missing, find it under <strong>Edit Actions</strong>.', '<strong>ホーム画面に追加</strong>を選びます。見当たらなければ<strong>アクションを編集</strong>の中を探します。'],
    ['If shown, turn on <strong>Open as Web App</strong>, then tap <strong>Add</strong>.', '表示されたら<strong>Webアプリとして開く</strong>をオンにして、<strong>追加</strong>を押します。'],
    ['Launch MAGI from its new Home Screen icon. Chat requires an internet connection.', 'ホーム画面の新しいアイコンからMAGIを開きます。チャットにはインターネット接続が必要です。'],
  ];
  var panel = makeAgentPanel('agent-install-panel', tr('Use MAGI on iPhone', 'iPhoneでMAGIを使う'),
    '<ul>' + steps.map(function (step) { return '<li>' + tr(step[0], step[1]) + '</li>'; }).join('') + '</ul>');
  if (panel) panel.querySelector('.agent-panel-close').focus();
}
var ICON_TRASH = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
function renderSavedSessionsList() {
  var list = document.getElementById('agent-history-list');
  if (!list) return;
  var sessions = readSavedSessions();
  if (!sessions.length) { list.innerHTML = '<div class="agent-panel-empty">' + tr('No saved conversations.', '保存したチャットはありません。') + '</div>'; return; }
  list.innerHTML = sessions.map(function (s) {
    return '<div class="session-item" data-id="' + esc(s.id) + '">'
      + '<button type="button" class="session-load" data-id="' + esc(s.id) + '">'
      + '<span class="session-title">' + esc(s.title) + '</span>'
      + '<span class="session-time">' + esc(new Date(s.timestamp).toLocaleString()) + '</span></button>'
      + '<button type="button" class="session-del" data-id="' + esc(s.id) + '" title="' + tr('Delete chat', 'チャットを削除') + '">' + ICON_TRASH + '</button>'
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
  var sessions = readSavedSessions();
  var session = sessions.find(function (s) { return s.id === id; });
  if (!session) return;
  dropAgentRequest();
  agentBusy = false;
  if (nativeInput) nativeInput.stopVoice();
  sharedLoading = false;
  agentHistory = cleanHistory(session.history);
  agentShared = cleanAgentShared(session.shared);
  persistSharedDocument();
  safeStore('magi_current_history', agentHistory);
  setAgentTitle(session.title || '');
  currentSessionId = session.id;
  safeStore('magi_current_session_id', currentSessionId);
  saveAgentLanguage(session.reply_language);
  agentDead = false; agentDegraded.classList.add('hidden'); agentDegraded.textContent = '';
  setAgentSuggestion('');
  renderHistoryToLog(agentHistory);
  updateAgentActionButtons();
  if (nativeConversation) recoverNativeConversation(id).catch(function () { announceAgent('Could not recover the pending reply. / 未保存の回答を復元できませんでした。'); });
}
function deleteSavedSession(id) {
  if (currentSessionId === id) resetAgent();
  writeSavedSessions(readSavedSessions().filter(function (s) { return s.id !== id; }));
  if (nativeConversation) nativeConversation.clear(id).catch(function () { announceAgent(tr('Could not remove pending reply data.', '受信データを削除できませんでした。')); });
  renderSavedSessionsList();
}
// AGENT_PRIVACY_BEGIN
// 未対応・未知の機能の段落は表示しない。APIの文章はHTMLとして解釈しない。
// data が undefined のときは取得中。null や形の違う応答は取得の失敗として案内を出す。
var AGENT_PRIVACY_FEATURES = ['classification_state', 'magi_panel', 'site_pages', 'close_on_malice', 'fact_mode', 'clarify'];
function renderAgentPrivacy(list, lang, data) {
  if (!list || !list.isConnected) return;
  var fallback = lang === 'ja'
    ? '入力は回答のため、外部のAIのAPIに送られます。送り先の最新の説明を取得できませんでした。接続を確かめて開き直してください。最新の説明は https://tk.st/ のMAGIのFAQにもあります。'
    : 'Inputs are sent to external AI APIs to answer you. Could not load the latest description of the recipients. Check your connection and reopen this panel. The latest description is also in the MAGI FAQ at https://tk.st/.';
  var rows = data && data.privacy && data.privacy[lang];
  rows = Array.isArray(rows) ? rows.filter(function (row) {
    return row && typeof row.text === 'string' && row.text.trim() && (row.requires === undefined
      || Array.isArray(row.requires) && row.requires.every(function (name) { return typeof name === 'string' && AGENT_PRIVACY_FEATURES.indexOf(name) >= 0; }));
  }) : [];
  list.replaceChildren();
  (data === undefined ? [{ text: lang === 'ja' ? '読み込み中…' : 'Loading…' }] : rows.length ? rows : [{ text: fallback }]).forEach(function (row) {
    var li = document.createElement('li'); li.textContent = row.text; list.appendChild(li);
  });
}
// AGENT_PRIVACY_END

// AGENT_VERSIONS_BEGIN
// トップとアプリで同じ、文字だけの更新履歴。チャットの状態には触れない。
var agentVersionsCache = null, agentVersionsAt = 0, agentVersionsPending = null;
function validAgentVersions(data) {
  return data && Array.isArray(data.versions) && data.versions.length > 0 && data.versions.length <= 60
    && data.versions.every(function (row) { return row && typeof row.version === 'string'
      && (/^\d{1,2}\.\d[1-9]?$/.test(row.version) || row.version === 'earlier')
      && (row.version === 'earlier' ? row.date === null : typeof row.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.date))
      && row.changes && ['ja','en'].every(function (lang) { return Array.isArray(row.changes[lang])
        && row.changes[lang].length >= 2 && row.changes[lang].length <= 4
        && row.changes[lang].every(function (text) { return typeof text === 'string' && text.length > 0 && Array.from(text).length <= 200; }); }); });
}
function loadAgentVersions() {
  if (agentVersionsCache && Date.now() - agentVersionsAt < 600000) return Promise.resolve(agentVersionsCache);
  if (agentVersionsPending) return agentVersionsPending;
  var controller = new AbortController(), timer = setTimeout(function () { controller.abort(); }, 6000);
  agentVersionsPending = fetch(AGENT_API.replace(/\/chat$/, '/versions?format=2'), {signal:controller.signal})
    .then(function (response) { if (!response.ok) throw new Error('versions_unavailable'); return response.json(); })
    .then(function (data) { if (!validAgentVersions(data)) throw new Error('versions_invalid');
      agentVersionsCache = data; agentVersionsAt = Date.now(); return data; })
    .catch(function () { return null; }).finally(function () { clearTimeout(timer); agentVersionsPending = null; });
  return agentVersionsPending;
}
function renderAgentVersions(list, lang, data) {
  list.replaceChildren(); list.lang = lang;
  if (!data) {
    var status = document.createElement('p'); status.setAttribute('role', 'status');
    status.textContent = data === undefined ? (lang === 'ja' ? '読み込み中…' : 'Loading…')
      : (lang === 'ja' ? '更新履歴を取得できませんでした。閉じてから、もう一度お試しください。' : 'Could not load the release history. Close this panel and try again.');
    list.appendChild(status); return;
  }
  data.versions.forEach(function (row) {
    var section = document.createElement('section'), title = document.createElement('h3');
    title.textContent = row.version === 'earlier' ? (lang === 'ja' ? 'それ以前' : 'Earlier releases') : 'ver ' + row.version;
    section.appendChild(title);
    if (row.date) { var date = document.createElement('time'); date.dateTime = row.date; date.textContent = row.date; section.appendChild(date); }
    var changes = document.createElement('ul');
    row.changes[lang].forEach(function (text) { var li = document.createElement('li'); li.textContent = text; changes.appendChild(li); });
    section.appendChild(changes); list.appendChild(section);
  });
}
function fillAgentVersionsPanel(panel, lang) {
  panel.dataset.lang = lang;
  panel.querySelector('.agent-versions-title').textContent = lang === 'ja' ? '更新履歴' : 'Release History';
  panel.querySelector('.agent-panel-close').textContent = lang === 'ja' ? '✕ 閉じる' : '✕ CLOSE';
  var list = panel.querySelector('.agent-versions-list');
  renderAgentVersions(list, lang, agentVersionsCache || undefined);
  loadAgentVersions().then(function (data) { if (panel.isConnected) renderAgentVersions(list, panel.dataset.lang, data); });
}
function showVersionsPanel() {
  var panel = makeAgentPanel('agent-versions-panel', '', '<div class="agent-versions-list"></div>');
  if (!panel) return;
  var title = panel.querySelector('.agent-panel-head .t') || panel.firstElementChild.querySelector('span');
  title.classList.add('agent-versions-title');
  fillAgentVersionsPanel(panel, document.documentElement.lang === 'ja' ? 'ja' : 'en');
}
// AGENT_VERSIONS_END


function showInfoPanel() {
  var panel = makeAgentPanel('agent-info-panel', tr('System & Privacy', 'システムとプライバシー'), '<ul class="agent-privacy-list"></ul>');
  if (!panel) return;
  var list = panel.querySelector('.agent-privacy-list'), lang = isJa() ? 'ja' : 'en';
  renderAgentPrivacy(list, lang, undefined);
  loadAgentModels().then(function (data) { renderAgentPrivacy(list, lang, data); });
  if (nativeAndroid) {
    var nativeNote = document.createElement('p');
    nativeNote.textContent = tr('On Android, conversations and original images stay in this app on this device. Android automatic backup is disabled. They will not transfer to another device automatically. Export conversations in Settings to keep a text copy; images are not included. Shared documents are sent to the same recipients as the conversation with each question. Your device fetches shared URLs without cookies. Voice input uses the device speech recognition service (often Google), which may receive audio when offline recognition is unavailable. Audio is not sent to MAGI servers. An Android foreground service receives replies while you use another app or turn off the display. Received data stays on this device until it is saved to the conversation. If allowed, arrival notifications show the conversation title. You can stop a request from its ongoing notification. Home widgets only open MAGI and show no chat contents. Widgets do not connect to the network themselves.',
      'Androidでは、会話と元の画像はこの端末のアプリ内に保存します。Androidの自動バックアップは無効で、ほかの端末へ自動では移りません。文字の控えは設定から書き出せます（画像は含みません）。共有した資料は、質問のたびに会話と同じ送り先へ送られます。共有されたURLは端末がCookieなしで読み込みます。音声入力は端末の音声認識サービス（多くはGoogle）を使い、端末内で認識できないときは音声がそのサービスに送られることがあります。音声はMAGIのサーバーには送りません。ほかのアプリを使っている間や画面を消している間は、Androidのフォアグラウンドサービスが回答を受け取ります。受け取ったデータは、会話に保存されるまでこの端末に残ります。許可すると、到着の通知に会話のタイトルが出ます。進行中の通知から送信を止められます。ホーム画面のウィジェットはMAGIを開くだけで、会話の内容は表示しません。ウィジェット自体は通信しません。');
    panel.querySelector('.agent-panel-body').appendChild(nativeNote);
  }
}

// 設定パネルの「ホーム画面に追加」を受け持つ。ウィジェットは入口だけで、設定は持たない。
function initNativeWidgetSettings(panel, ja) {
  if (!nativeWidget) return;
  var widgetBox = panel.querySelector('#native-widget-settings'), widgetStatus = panel.querySelector('#widget-status');
  widgetBox.hidden = false;
  nativeWidget.state().then(function (value) {
    if (panel.isConnected) panel.querySelector('#widget-pin').hidden = !value.canPin;
  }).catch(function () {});
  panel.querySelector('#widget-pin').addEventListener('click', function () {
    nativeWidget.pin().then(function (value) { if (!value.requested) widgetStatus.textContent = ja ? 'ホーム画面のウィジェット一覧から追加してください。' : 'Add it from your home screen’s widget picker.'; })
      .catch(function () { widgetStatus.textContent = 'Could not open the widget picker. / 追加画面を開けませんでした。'; });
  });
}

// 設定はAndroidだけ。ウィジェット・通知と履歴の操作をまとめる。
async function showNativeSettings() {
  if (!nativeAndroid) return;
  var ja = isJa();
  var panel = makeAgentPanel('agent-settings-panel', ja ? '設定' : 'Settings',
    '<p id="history-storage-status" role="status">' + (ja ? '読み込み中…' : 'Loading…') + '</p><p id="native-notification-status" hidden></p>'
    + '<div id="native-widget-settings" hidden>'
    + '<p>' + (ja ? 'ホーム画面のウィジェット一覧から「MAGI に聞く」を追加できます。チャット・カメラ・アルバム・音声入力をすぐ開けます。' : 'Add “Ask MAGI” from your home screen’s widget picker to open chat, the camera, your album or voice input.') + '</p>'
    + '<button type="button" id="widget-pin" hidden>' + (ja ? 'ホーム画面に追加' : 'Add to home screen') + '</button><p id="widget-status" role="status"></p></div>'
    + '<p>' + (ja ? '履歴はこの端末内に保存します。機種変更では引き継がれません。書き出しには画像を含めません。' : 'History stays on this device and does not transfer automatically to a new device. Exports include text only, without images.') + '</p>'
    + '<div class="native-settings-actions"><button type="button" id="history-export">' + (ja ? '全会話を書き出す' : 'Export all chats') + '</button>'
    + '<button type="button" id="history-clear">' + (ja ? '全会話を削除' : 'Delete all chats') + '</button></div>');
  if (!panel) return;
  initNativeWidgetSettings(panel, ja);
  if (nativeConversation) {
    var notifications = panel.querySelector('#native-notification-status'); notifications.hidden = false;
    nativeConversation.permission().then(function (value) {
      if (!panel.isConnected) return;
      notifications.textContent = value.display === 'granted' ? tr('Notifications are allowed.', '通知は許可されています。') : tr('Notifications are off; chat still works.', '通知は許可されていません。会話は引き続き使えます。');
      var button = document.createElement('button'); button.type = 'button'; button.textContent = tr('Notification settings', '通知の設定');
      button.addEventListener('click', function () { nativeConversation.settings().catch(function () { announceAgent(tr('Could not open notification settings.', '通知の設定を開けませんでした。')); }); });
      notifications.appendChild(button);
    }).catch(function () { notifications.textContent = tr('Could not check notifications.', '通知の状態を確認できませんでした。'); });
  }
  var status = panel.querySelector('#history-storage-status');
  var buttons = panel.querySelectorAll('.agent-panel-body button');
  if (!nativeHistory || !nativeHistory.active) {
    status.textContent = tr('Moving your history has not finished. Check free storage and reopen the app. Your existing chats are kept.', '履歴の移し替えは未完了です。空き容量を確かめ、アプリを開き直してください。既存の会話は残しています。');
    buttons.forEach(function (b) { b.disabled = true; }); return;
  }
  async function refresh() {
    var bytes = await nativeHistory.usage();
    if (panel.isConnected) status.textContent = tr('Storage: ', '使用量: ') + (bytes / 1048576).toFixed(2) + ' MB';
  }
  async function action(task) {
    buttons.forEach(function (b) { b.disabled = true; });
    try { await task(); }
    catch (_) { status.textContent = tr('Could not finish. Check free storage and try again.', '操作を完了できませんでした。空き容量を確かめて再試行してください。'); }
    finally { buttons.forEach(function (b) { b.disabled = false; }); }
  }
  panel.querySelector('#history-export').addEventListener('click', function () {
    action(async function () {
      if (agentBusy) { status.textContent = tr('Export after the reply finishes.', '回答が終わってから書き出してください。'); return; }
      syncCurrentToSaved();
      var payload = await nativeHistory.exportData();
      var fs = window.Capacitor.Plugins.Filesystem, share = window.Capacitor.Plugins.Share;
      var path = 'magi-export.json';
      // Share公式プラグインで渡せるcache領域。毎回同じファイルを置き換える。
      await fs.writeFile({ directory: 'CACHE', path: path, encoding: 'utf8', data: JSON.stringify(payload), recursive: true });
      var uri = (await fs.getUri({ directory: 'CACHE', path: path })).uri;
      // 共有先が非同期に読む場合に備え、直後には消さない。次の書き出しで置き換える。
      await share.share({ title: 'MAGI conversations', files: [uri], dialogTitle: 'Export MAGI conversations' });
      await refresh();
    });
  });
  panel.querySelector('#history-clear').addEventListener('click', function () {
    action(async function () {
      if (agentBusy) { status.textContent = tr('Stop the reply before deleting.', '回答を停止してから削除してください。'); return; }
      if (!window.confirm(tr('Delete all conversations and saved images? This cannot be undone.', 'すべての会話と保存画像を削除します。元には戻せません。'))) return;
      try { await window.Capacitor.Plugins.Filesystem.deleteFile({ directory: 'CACHE', path: 'magi-export.json' }); }
      catch (error) { if (error.code !== 'OS-PLUG-FILE-0008' && error.code !== 'ENOENT') throw error; }
      if (nativeConversation) await nativeConversation.clear();
      await nativeHistory.clear();
      resetAgent();
      await nativeHistory.flush();
    });
  });
  try { await refresh(); } catch (_) { status.textContent = tr('Could not read storage usage. Check the saved data.', '使用量を読み込めませんでした。保存状態を確認してください。'); }
}

async function openOriginalImage(target) {
  if (!nativeHistory || !nativeHistory.active) return;
  try {
    var uri = await nativeHistory.imageUri(target.dataset.original);
    var panel = makeAgentPanel('agent-image-panel', tr('Original image', '元の画像'), '<img alt="' + tr('Original attachment', '添付した元の画像') + '" style="max-width:100%;height:auto">');
    if (panel) panel.querySelector('img').src = window.Capacitor.convertFileSrc(uri);
  } catch (_) { announceAgent(tr('Could not open the original image.', '元の画像を開けませんでした。')); }
}
agentLog.addEventListener('click', function (event) {
  var image = event.target.closest('[data-original]');
  if (image) openOriginalImage(image);
});
agentLog.addEventListener('keydown', function (event) {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-original]')) { event.preventDefault(); openOriginalImage(event.target); }
});

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
    md += '## ✦ MAGI\n' + agentFactMarkdown(item.content, item.sources) + '\n\n';
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
// 物理キーボードのある環境（マウス・トラックパッドが主の入力）だけ Enter で送信、Shift+Enter で改行。
// スマホ・タブレットの Enter は改行のまま（チャットの一般的な動き）で、送信はボタン。Ctrl/⌘+Enter はどこでも送信。
// 日本語入力の変換を確定する Enter では送らない
agentInput.addEventListener('keydown', function (e) {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key !== 'Enter' || e.shiftKey) return;
  var fine = !!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches);
  if (fine || e.ctrlKey || e.metaKey) { e.preventDefault(); agentSend(); }
});
document.getElementById('btn-history-agent').addEventListener('click', showHistoryPanel);

// ---- 今日の利用回数 ---------------------------------------------------------------
// Worker の上限（IP×UTC日）を読むだけで数えない。旧 Worker や通信の失敗では円グラフごと隠す。
var usageWrap = document.querySelector('.usage-wrap'), usagePop = document.getElementById('agent-usage-pop');
var usageBtn = document.getElementById('btn-usage'), agentUsage = null, usageLoadedAt = 0, usageRequest = null, usageAgain = false;
function renderUsage() {
  if (!agentUsage) { usageWrap.hidden = true; closeUsagePop(); return; }
  var ja = isJa(), used = agentUsage.used, limit = agentUsage.limit, globalFull = agentUsage.global_full;
  // 全体の上限に達した日は、自分の回数が残っていても送れないので満杯の赤で出す
  var ratio = globalFull ? 1 : Math.min(1, used / limit);
  usageWrap.hidden = false;
  usageWrap.dataset.level = used >= limit || globalFull ? 'full' : ratio >= 0.8 ? 'high' : '';
  usageWrap.querySelector('.usage-fill').setAttribute('stroke-dasharray', (ratio * 100).toFixed(1) + ' 100');
  var label = (ja ? '今日の利用 ' + used + ' / ' + limit + '回' : "Today's usage: " + used + ' of ' + limit)
    + (globalFull ? (ja ? '（全体の上限に達しました）' : ' (site-wide limit reached)') : '');
  usageBtn.title = label; usageBtn.setAttribute('aria-label', label);
  var reset = new Date(agentUsage.resets_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  usagePop.innerHTML = '<div class="usage-label">' + (ja ? '今日の利用' : "Today's usage") + '</div>'
    + '<div class="usage-count"><b>' + used + '</b> / ' + limit + (ja ? ' 回' : '') + '</div>'
    + '<p>' + esc(ja ? 'IPアドレスごとに1日' + limit + '回まで送れます。毎日 ' + reset + ' に戻ります。'
      : 'Each IP address can send ' + limit + ' messages a day. Resets daily at ' + reset + '.') + '</p>'
    + (globalFull ? '<p class="usage-warn">' + esc(ja ? '今日は全利用者の合計の上限に達したため、' + reset + ' まで送れません。'
      : 'The site-wide daily limit has been reached. You can send again at ' + reset + '.') + '</p>' : '');
}
// 取得中に呼ばれたら（送信の直後など）、その取得は送信の前の回数かもしれないので、終わってからもう一度読む。
// Worker が応じない（旧版の404・形の違う応答）なら隠し、通信の失敗・6秒の打ち切りでは前の値を残す。
function loadUsage() {
  if (usageRequest) { usageAgain = true; return usageRequest; }
  var controller = new AbortController(), timer = setTimeout(function () { controller.abort(); }, 6000);
  usageRequest = fetch(USAGE_API, { cache: 'no-store', signal: controller.signal })
    .then(function (r) {
      if (!r.ok) { agentUsage = null; return; }
      return r.json().then(function (j) {
        var ok = j && Number.isInteger(j.used) && Number.isInteger(j.limit) && j.limit > 0 && j.used >= 0 && !isNaN(Date.parse(j.resets_at));
        agentUsage = ok ? { used: Math.min(j.used, j.limit), limit: j.limit, resets_at: j.resets_at, global_full: j.global_full === true } : null;
      });
    })
    .catch(function () {})
    .then(function () {
      clearTimeout(timer); usageLoadedAt = Date.now(); usageRequest = null; renderUsage();
      if (usageAgain) { usageAgain = false; loadUsage(); }
    });
  return usageRequest;
}
function closeUsagePop() {
  if (usagePop.classList.contains('hidden')) return false;
  usagePop.classList.add('hidden'); usageBtn.setAttribute('aria-expanded', 'false');
  return true;
}
usageBtn.addEventListener('click', function () {
  if (closeUsagePop()) return;
  usagePop.classList.remove('hidden'); usageBtn.setAttribute('aria-expanded', 'true');
  loadUsage();
});
document.addEventListener('click', function (e) { if (!e.target.closest('.usage-wrap')) closeUsagePop(); });
// 日をまたいだり、ほかの端末で使ったりした分は、画面に戻ったときに取り直す
document.addEventListener('visibilitychange', function () { if (!document.hidden && Date.now() - usageLoadedAt > 60000) loadUsage(); });
loadUsage();

// kebab dropdown
(function () {
  var moreBtn = document.getElementById('btn-more-agent');
  var moreDropdown = document.getElementById('agent-more-dropdown');
  if (!moreBtn || !moreDropdown) return;
  moreBtn.addEventListener('click', function () { moreDropdown.classList.toggle('hidden'); });
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
  window.MagiTheme.choose(next);
});
// メニューの項目は、押すと切り替わる先のテーマを書く
function syncThemeLabel() {
  document.getElementById('btn-theme-label').textContent = document.documentElement.getAttribute('data-theme') === 'dark' ? tr('Light mode', 'ライトモード') : tr('Dark mode', 'ダークモード');
}
// 固定の文言は data-ja（文字）・data-ja-title・data-ja-aria・data-ja-ph（入力欄の例文）に日本語を持たせ、英語は最初の値を data-en* に控える。
// JavaScript が毎回決める名前（送信・音声・利用回数のボタン）は HTML に日本語を持たせず、ここで呼ぶ関数が決める。
// 描いた後の会話とスプラッシュは描き直す。回答の途中なら会話は描き直さず、これから出る分から切り替わる。
function applyStaticLanguage() {
  var ja = isJa();
  [['data-ja', 'ja', 'en', null], ['data-ja-title', 'jaTitle', 'enTitle', 'title'], ['data-ja-aria', 'jaAria', 'enAria', 'aria-label'], ['data-ja-ph', 'jaPh', 'enPh', 'placeholder']].forEach(function (row) {
    var jaKey = row[1], enKey = row[2], target = row[3];
    document.querySelectorAll('[' + row[0] + ']').forEach(function (el) {
      if (el.dataset[enKey] === undefined) el.dataset[enKey] = target ? el.getAttribute(target) || '' : el.textContent;
      var value = ja ? el.dataset[jaKey] : el.dataset[enKey];
      if (target) el.setAttribute(target, value); else el.textContent = value;
    });
  });
  var langLabel = document.getElementById('btn-lang-label');
  langLabel.textContent = ja ? 'English' : '日本語'; langLabel.lang = ja ? 'en' : 'ja';
  syncThemeLabel();
  agentClarifyPlaceholder(['補足があれば入力', 'Add details if needed'].indexOf(agentInput.placeholder) >= 0);
  labelSendButton(); labelVoiceButton();
  renderAgentSuggest(); renderUsage();
  var banner = document.getElementById('app-update');
  if (banner && banner.dataset.version) labelAppUpdate(banner);
}
function applyLanguage() {
  applyStaticLanguage();
  if (!agentBusy) {
    closeAgentPanels(); closeAttachMenu(); closeEmojiPops();
    if (agentHistory.length) renderHistoryToLog(agentHistory);
    else if (agentLog.querySelector('.agent-splash')) agentLog.innerHTML = agentHintHTML();
  }
}
document.getElementById('btn-lang').addEventListener('click', function () {
  window.MagiLanguage.choose(isJa() ? 'en' : 'ja');
  applyLanguage();
});
new MutationObserver(syncThemeLabel).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
applyStaticLanguage();

// service worker (PWA)
if ('serviceWorker' in navigator) {
  if (!nativeAndroid) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () { }); });
  } else {
    // APKのwwwを毎回使う。同版候補の上書きでもPWAキャッシュを引き継がない。
    navigator.serviceWorker.getRegistrations().then(function (registrations) {
      return Promise.all(registrations.map(function (registration) { return registration.unregister(); }));
    }).then(function () { return caches.keys(); }).then(function (keys) {
      return Promise.all(keys.filter(function (key) { return key.indexOf('magi-shell-') === 0; }).map(function (key) { return caches.delete(key); }));
    }).catch(function () {});
  }
}

// APP_UPDATE_BEGIN
// ネイティブだけが公開Releaseを1日1回確認する。遅延・失敗は会話に影響させない。
function releaseVersion(tag) {
  var match = typeof tag === 'string' && /^v(\d{1,2})\.(\d)$/.exec(tag);
  if (!match) return null;
  var parts = [Number(match[1]), Number(match[2])];
  return parts.every(Number.isSafeInteger) ? parts : null;
}
function newerRelease(parts, current) {
  var installed = typeof current === 'string' && /^(\d{1,2})\.(\d)([1-9])?$/.exec(current);
  return !!parts && !!installed && parts[0] * 100 + parts[1] * 10
    > Number(installed[1]) * 100 + Number(installed[2]) * 10 + Number(installed[3] || 0);
}
function updateStore(key, value) { try { localStorage.setItem(key, value); } catch (_) {} }
async function checkAppUpdate() {
  try {
    if (!window.Capacitor || !window.Capacitor.isNativePlatform()) return;
    var now = Date.now(), last = Number(safeGet('magi_update_checked'));
    if (last > 0 && now >= last && now - last < 86400000) return;
    updateStore('magi_update_checked', String(now));
    var controller = new AbortController(), timer;
    try {
      var data = await Promise.race([
        fetch('https://api.github.com/repos/tk33r1/st/releases/latest', { signal: controller.signal, headers: { Accept: 'application/vnd.github+json' } })
          .then(function (res) { if (!res.ok) throw new Error('release unavailable'); return res.json(); }),
        new Promise(function (_, reject) { timer = setTimeout(function () { controller.abort(); reject(new Error('release timeout')); }, 5000); })
      ]);
      var parts = releaseVersion(data && data.tag_name);
      if (!parts || data.draft || data.prerelease || !newerRelease(parts, APP_VERSION)) return;
      var version = parts.join('.');
      if (safeGet('magi_update_dismissed') === version) return;
      var banner = document.getElementById('app-update');
      if (!banner) return;
      banner.dataset.version = version;
      labelAppUpdate(banner);
      var close = banner.querySelector('button');
      close.onclick = function () { banner.hidden = true; updateStore('magi_update_dismissed', version); };
      banner.hidden = false;
    } finally { clearTimeout(timer); }
  } catch (_) { /* 機内モード・保存不可・壊れた応答でも起動を続ける */ }
}
function labelAppUpdate(banner) {
  var ja = document.documentElement.lang === 'ja', version = banner.dataset.version;
  banner.querySelector('.app-update-text').textContent = ja ? '新しいバージョン（' + version + '）があります' : 'Version ' + version + ' is available';
  banner.querySelector('a').textContent = ja ? 'ダウンロード' : 'Download';
  banner.querySelector('button').setAttribute('aria-label', ja ? 'この版の通知を閉じる' : 'Dismiss this version');
}
// APP_UPDATE_END

async function initNativeInputs() {
  if (!nativeAndroid || !window.MagiNativeInput) return;
  var cap = window.Capacitor, voice = document.getElementById('agent-voice');
  if (!cap.Plugins.MagiShare && !cap.Plugins.SpeechRecognition) return;
  if (cap.Plugins.MagiShare && AGENT_PRIVACY_FEATURES.indexOf('share') < 0) AGENT_PRIVACY_FEATURES.push('share');
  var readingShared = tr('Reading shared data…', '共有された内容を読み込み中…');
  nativeInput = window.MagiNativeInput.create({ cap: cap,
    generation: function () { return agentGen; },
    beginShare: function () { syncCurrentToSaved(); resetAgent(); sharedLoading = true; announceAgent(readingShared); },
    endShare: function (token) {
      if (token !== agentGen) return;
      sharedLoading = false;
      if (agentStatusEl.textContent === readingShared) announceAgent(tr('Shared content is ready.', '共有された内容を入力しました。'));
    },
    setDraft: function (text) { agentInput.value = text; fitAgentInput(); },
    setShared: setSharedDocument,
    attach: addAttachments,
    // 読み上げだけでなく、添付の欄にも短く出して画面で分かるようにする。
    notice: function (text) { text = pickLang(text); announceAgent(text); noticeAttach(text); },
    appendDraft: function (text) { agentInput.value += (agentInput.value && text ? '\n' : '') + text; fitAgentInput(); },
    interim: function (text) { document.getElementById('agent-voice-interim').textContent = text; },
    voiceState: function (on) { voice.setAttribute('aria-pressed', String(on)); labelVoiceButton(); }
  });
  await nativeInput.init();
  document.addEventListener('visibilitychange', function () { if (document.hidden) nativeInput.finishVoice(); });
  // 音声認識のサービスが無い環境（セキュアフォルダなど）ではマイクを出さない。
  if (cap.Plugins.SpeechRecognition && await nativeInput.voiceAvailable()) {
    voice.hidden = false;
    voice.addEventListener('click', function () {
      if (!agentBusy && !agentDead && !agentClosed && !sharedLoading) nativeInput.startVoice();
    });
  }
}
async function recoverNativeConversation(id) {
  if (!nativeConversation || agentBusy || historyLoading || id !== currentSessionId) return;
  var rows = await nativeConversation.pending();
  if (agentBusy || id !== currentSessionId) return;
  for (var row of rows.filter(function (r) { return r.sessionId === id; }).sort(function (a, b) { return a.startedAt - b.startedAt; })) {
    if (agentHistory.some(function (m) { return m.role === 'assistant' && m.native_request === row.id; })) {
      await nativeHistory.flush(); await nativeConversation.acknowledge(row.id); continue;
    }
    var last = agentHistory.at(-1);
    if (last && last.role === 'user' && last.native_request === row.id) { await agentSend(row); return; }
    // 削除・古い版からの変更で対応する往復が無い列を、新しい質問として送らない。
    announceAgent(tr('A pending reply could not be matched to this conversation.', '受信データと会話の対応を確認できませんでした。'));
  }
}
function openNativeConversationLink(value) {
  var target = window.MagiNativeWidget.link(value), id = target && target.id;
  // カメラ・アルバムはネイティブが開く。選ばれた画像は共有と同じく新しい会話に入るので、取り消したときは今の会話のまま。
  if (target && (target.action === 'camera' || target.action === 'album')) return;
  if (target && (target.action === 'new' || target.action === 'voice')) {
    syncCurrentToSaved(); resetAgent(); agentInput.focus({ preventScroll: true });
    if (target.action === 'voice') {
      var generation = agentGen;
      nativeInputReady.then(function () {
        function start() {
          if (generation === agentGen && nativeInput && !agentBusy && !agentClosed && !sharedLoading) nativeInput.startVoice();
        }
        if (!document.hidden) start();
        else document.addEventListener('visibilitychange', function visible() {
          if (!document.hidden) { document.removeEventListener('visibilitychange', visible); start(); }
        });
      });
    }
    return;
  }
  var sessions = readSavedSessions();
  if (!id || !sessions.some(function (s) { return s.id === id; })) { syncCurrentToSaved(); resetAgent(); return; }
  closeAgentPanels();
  if (id !== currentSessionId) loadSavedSession(id);
  else if (!agentBusy) recoverNativeConversation(id).catch(function () { announceAgent(tr('Could not recover the pending reply.', '未保存の回答を復元できませんでした。')); });
}
async function initNativeConversationLinks() {
  var app = window.Capacitor.Plugins.App;
  if (app) {
    await app.addListener('appUrlOpen', function (event) { if (event && typeof event.url === 'string') openNativeConversationLink(event.url); });
    var launch = app.getLaunchUrl ? await app.getLaunchUrl() : null;
    if (launch && launch.url) openNativeConversationLink(launch.url);
  }
  await recoverNativeConversation(currentSessionId);
}
async function initHistoryStorage() {
  if (!nativeAndroid) { initAgent(); return; }
  var appRoot = document.getElementById('app');
  appRoot.inert = true;
  announceAgent(tr('Opening saved conversations…', '保存した会話を開いています…'));
  try {
    var fs = window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem;
    if (!fs || !window.MagiNativeHistory) throw new Error('history_plugin_unavailable');
    nativeHistory = window.MagiNativeHistory.create({
      fs: fs, legacy: localStorage, cleanHistory: cleanHistory,
      onError: function () { announceAgent(tr('Could not save your history. Check free storage and reopen the app. No existing chats were deleted.', '履歴を保存できませんでした。空き容量を確かめ、アプリを開き直してください。既存の会話は削除していません。')); }
    });
    var migrated = await nativeHistory.init();
    loadCurrentSessionMeta();
    initAgent();
    if (window.MagiNativeConversation && nativeHistory.active) {
      nativeConversation = await window.MagiNativeConversation.create({ cap: window.Capacitor, notice: function (text) { text = pickLang(text); announceAgent(text); noticeAttach(text); } });
    }
    historyLoading = false; appRoot.inert = false;
    announceAgent(migrated ? '' : tr('Could not move your history. Chats are opened from the previous storage. Check free storage and reopen the app.', '履歴を移し替えられませんでした。会話は元の保存先から開いています。空き容量を確かめ、アプリを開き直してください。'));
    var settings = document.getElementById('btn-settings-agent');
    if (settings) { settings.hidden = false; settings.addEventListener('click', showNativeSettings); }
    nativeInputReady = initNativeInputs().catch(function () { announceAgent('Could not initialize sharing or voice input. / 共有・音声入力を準備できませんでした。'); });
    if (window.MagiNativeWidget && nativeHistory.active) {
      nativeWidget = await window.MagiNativeWidget.create({ cap: window.Capacitor });
    }
    if (nativeConversation) initNativeConversationLinks().catch(function () { announceAgent('Could not recover the pending reply. / 未保存の回答を復元できませんでした。'); });
  } catch (_) {
    // 移行済みファイルが読めないときは、新規データで上書きしない。
    announceAgent(tr('Could not open your saved history. Reopen the app.', '保存した履歴を開けませんでした。アプリを開き直してください。'));
  }
}
initHistoryStorage();
checkAppUpdate();
if (WEB_INSTALL && location.hash === '#install') showInstallPanel();

// NATIVE_SHELL_BEGIN
// Androidだけで、ビルド時に注入される橋渡しを使う。Web/PWAでは触らない。
(function () {
  var cap = window.Capacitor;
  if (!cap || !cap.isNativePlatform() || cap.getPlatform() !== 'android') return;
  var app = cap.Plugins && cap.Plugins.App, bars = cap.Plugins && cap.Plugins.SystemBars;
  if (!app || !bars) return;
  function syncBars() {
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    bars.setStyle({ style: dark ? 'DARK' : 'LIGHT' }).catch(function () {});
  }
  new MutationObserver(syncBars).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  syncBars();
  app.addListener('backButton', function (event) {
    // パネルやメニューを閉じる操作で、会話や入力中の文は消さない。
    if (closeAttachMenu()) return;
    if (document.querySelector('.agent-panel')) { closeAgentPanels(); return; }
    if (closeUsagePop()) return;
    var menu = document.getElementById('agent-more-dropdown');
    if (menu && !menu.classList.contains('hidden')) { menu.classList.add('hidden'); return; }
    if (document.querySelector('.emoji-pop')) { closeEmojiPops(); return; }
    if (event.canGoBack) window.history.back();
    else app.exitApp().catch(function () {});
  });
})();
// NATIVE_SHELL_END
