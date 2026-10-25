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
var APP_VERSION = '7.02';

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
  agentInput.placeholder = document.documentElement.lang === 'ja' ? (on ? '補足があれば入力' : 'MAGIに質問') : (on ? 'Add details if needed' : 'Ask MAGI');
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
// 保存・表示・引用位置は全文のまま、上流へ送り直すすべての回答の履歴を上限に収める。
function agentFactHistoryMessage(item) {
  if (item.role !== 'assistant' || typeof item.content !== 'string' || item.content.length <= 4000) return item;
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
      if (typeof item.icon === 'string' && item.icon.length <= 11000 && /^data:image\/(?:png|x-icon|vnd\.microsoft\.icon|jpeg|webp|gif);base64,[A-Za-z0-9+\/]+=*$/.test(item.icon)) row.icon = item.icon;
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
// 検査済みの引用位置に出典番号を挿入する（Markdown 書き出し・共有の本文で共用）。
function agentCitedText(text, marks) {
  var out = '', last = 0;
  marks.forEach(function (m) { out += text.slice(last, m.at) + '[' + m.n + ']'; last = m.at; });
  return out + text.slice(last);
}
function agentFactMarkdown(text, raw) {
  var data = cleanAgentSources(raw, text); if (!data) return text;
  var out = agentCitedText(text, data.marks) + '\n\n### Sources\n';
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
  delete out.speech_sig; delete out.speech_lang; delete out.speech_version; delete out.speech_mode;
  if (item.speech_version !== undefined && (item.speech_version !== 2 || !['normal', 'temporary'].includes(item.speech_mode))) return out;
  if (sig && item.closed !== true && !item.clarify) {
    out.speech_sig = sig; if (lang) out.speech_lang = lang;
    if (item.speech_version === 2) { out.speech_version = 2; out.speech_mode = item.speech_mode; }
  }
  return out;
}
// 新契約の音声はv2と宣言したモードが一致するときだけ使う。v1へ落としてキャッシュさせない。
function cleanAgentSpeechEvent(data, expectedMode) {
  if (!data || expectedMode && (data.sig_version !== 2 || data.conversation_mode !== expectedMode)) return {};
  if (data.sig_version === undefined && data.conversation_mode !== undefined) return {};
  return cleanAgentSpeechItem({ role: 'assistant', content: '', speech_sig: data.sig, speech_lang: data.lang,
    ...(data.sig_version !== undefined ? { speech_version: data.sig_version, speech_mode: data.conversation_mode } : {}) });
}
// 回答の評価（Good / Bad）。Worker へは以前のいいね・絵文字のリアクションと同じ形で 👍・👎 を送る。
// 保存した値は文字列（旧データ）か { em, id, delete_token }。ほかの絵文字（以前のリアクション）は評価として出さない
var AGENT_RATINGS = { good: '\u{1F44D}', bad: '\u{1F44E}' };
function agentRatingOf(stored) {
  var em = typeof stored === 'string' ? stored : stored && stored.em;
  return em === AGENT_RATINGS.good ? 'good' : em === AGENT_RATINGS.bad ? 'bad' : null;
}
// 回答の日時（ミリ秒）。保存した at を使い、無い回答は mid の先頭（送ったときの時刻を36進で8桁）から読む。
// 画面を開いた後（openedAt 以降）に付けた mid は、mid の無かった古い回答に後から付けたもので時刻を表さない
function agentReplyAt(item, openedAt) {
  var floor = Date.UTC(2024, 0, 1), at = item && item.at;
  if (Number.isSafeInteger(at) && at > floor && at < Date.now() + 864e5) return at;
  var m = item && typeof item.mid === 'string' ? /^m([0-9a-z]{8})/.exec(item.mid) : null, t = m ? parseInt(m[1], 36) : NaN;
  return t > floor && t < openedAt ? t : null;
}
// 操作列に収まる短い書き方（端末の時刻）。「今日 15:38」「昨日 15:38」「10/22(木) 15:38」「2025/10/22 15:38」、
// 英語は「Today 15:38」「Yesterday 15:38」「Oct 22, 15:38」「Oct 22, 2025, 15:38」。曜日まで書いた日時は title に出す
function agentReplyTimeText(at, ja, now) {
  var d = new Date(at), n = new Date(now), hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  var days = Math.round((new Date(n.getFullYear(), n.getMonth(), n.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5);
  if (days === 0) return (ja ? '今日 ' : 'Today ') + hm;
  if (days === 1) return (ja ? '昨日 ' : 'Yesterday ') + hm;
  var month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()] + ' ' + d.getDate();
  if (d.getFullYear() !== n.getFullYear()) return ja ? d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm : month + ', ' + d.getFullYear() + ', ' + hm;
  return ja ? (d.getMonth() + 1) + '/' + d.getDate() + '(' + '日月火水木金土'.charAt(d.getDay()) + ') ' + hm : month + ', ' + hm;
}
// ［もう一度］で送り直す質問（{ text, atts }）。文字だけの質問は保存した本文から作る。画像付きの質問は保存したのが縮小版なので、
// この画面で送った原寸（lastSend = { mid, atts }。その回答の mid のときだけ）があるときに限る。送れなければ null
function agentRetryInput(user, mid, lastSend) {
  if (!user || user.role !== 'user') return null;
  var c = user.content, parts = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
  var text = parts.filter(function (p) { return p && p.type === 'text'; }).map(function (p) { return p.text; }).join('\n');
  if (!parts.some(function (p) { return p && p.type === 'image_url'; })) return text.trim() ? { text: text, atts: [] } : null;
  return lastSend && lastSend.mid === mid && lastSend.atts.length ? { text: text, atts: lastSend.atts.slice() } : null;
}
// 以下は統合人格の回答の操作列（評価のメニュー・［もう一度］・日時）。画面の agentLog・agentHistory・ICON_*・agentItemFor・
// reactionStoreFor・getReactionContext・(un)registerReaction・agentLastSend・agentClosed・agentDead などを使う
// 評価の見た目（value = 'good' | 'bad' | null）
function showRating(bar, value) {
  var btn = bar.querySelector('[data-act="rate"]');
  if (!btn) return;
  btn.classList.toggle('rated', !!value);
  btn.innerHTML = value === 'good' ? ICON_GOOD : value === 'bad' ? ICON_BAD : ICON_RATE;
  var label = value ? tr('Rated ' + (value === 'good' ? 'Good' : 'Bad') + ' (press to change)', '評価: ' + (value === 'good' ? 'Good' : 'Bad') + '（押すと変更）') : tr('Rate this reply', '回答を評価');
  btn.title = label; btn.setAttribute('aria-label', label);
}
function closeRatePops(focus) {
  agentLog.querySelectorAll('.rate-pop').forEach(function (pop) {
    var btn = pop.parentElement.querySelector('[data-act="rate"]');
    pop.remove();
    if (btn) { btn.setAttribute('aria-expanded', 'false'); if (focus) btn.focus({ preventScroll: true }); }
  });
}
// 評価のボタンの上に Good / Bad を開く。いまの評価に印を付け、同じものを選ぶと取り消す
function openRatePop(btn, bar) {
  if (agentTemporary()) return;
  var open = bar.querySelector('.rate-pop');
  closeRatePops(false);
  if (open) return;
  var store = reactionStoreFor(bar), current = agentRatingOf(store && store[bar.dataset.target]);
  var pop = document.createElement('div'); pop.className = 'rate-pop'; pop.setAttribute('role', 'menu');
  pop.setAttribute('aria-label', tr('Rate this reply', '回答を評価'));
  [['good', ICON_GOOD], ['bad', ICON_BAD]].forEach(function (pair) {
    var item = document.createElement('button'); item.type = 'button'; item.dataset.rate = pair[0];
    item.setAttribute('role', 'menuitemradio'); item.setAttribute('aria-checked', String(current === pair[0]));
    item.innerHTML = pair[1]; item.append(pair[0] === 'good' ? 'Good' : 'Bad');
    pop.appendChild(item);
  });
  pop.style.left = btn.offsetLeft + 'px';
  bar.appendChild(pop); btn.setAttribute('aria-expanded', 'true');
  pop.querySelector('button').focus({ preventScroll: true });
}
// 評価を付ける・付け替える・取り消す。付いているもの（以前の絵文字のリアクションを含む）は消せてから次を付ける
async function rateReply(bar, value) {
  if (agentTemporary()) return;
  if (bar.dataset.removing === 'true') return;
  var ctx = getReactionContext(bar), store = reactionStoreFor(bar), current = store && store[ctx.target], owner = reactionOwner(bar);
  if (current) {
    bar.dataset.removing = 'true';
    try {
      if (!await unregisterReaction(bar, ctx.target)) { renderAgentError({ message: tr('Could not change the rating. Please try again.', '評価を変更できませんでした。もう一度お試しください。'), code: 'reaction_remove_failed' }); return; }
    } finally { delete bar.dataset.removing; }
    if (agentTemporary() || currentSessionId !== owner.sessionId || bar.isConnected === false) return;
    showRating(bar, null);
    if (agentRatingOf(current) === value) return;
  }
  showRating(bar, value);
  registerReaction(bar, ctx.target, AGENT_RATINGS[value], ctx);
}
// 日時の欄を書く。「今日」「昨日」は日付が変わると変わるので、画面に戻ったときと新しい回答が届いたときにも書き直す
function writeReplyTime(time, at) {
  var ja = document.documentElement.lang === 'ja';
  time.textContent = agentReplyTimeText(at, ja, Date.now());
  time.title = new Date(at).toLocaleString(ja ? 'ja-JP' : 'en-US', { dateStyle: 'full', timeStyle: 'short' });
}
function refreshReplyTimes() {
  agentLog.querySelectorAll('.reply-time[datetime]').forEach(function (t) { var at = Date.parse(t.dateTime); if (at) writeReplyTime(t, at); });
}
// ［もう一度］で送る内容（{ text, atts, mid（置き換える回答） }）。会話の最後の回答で、閉じていない会話のときだけ。送れなければ null
function agentRetryFor(btn) {
  var item = agentItemFor(btn);
  if (!item || item !== agentHistory[agentHistory.length - 1] || item.closed || item.clarify || agentClosed || agentDead) return null;
  var again = agentRetryInput(agentHistory[agentHistory.length - 2], item.mid, agentLastSend);
  return again && { text: again.text, atts: again.atts, mid: item.mid };
}
function syncRetryButtons() {
  agentLog.querySelectorAll('.reply-bar [data-act="retry"]').forEach(function (btn) { btn.hidden = !agentRetryFor(btn); });
}
// ［もう一度］で置き換える往復（回答の mid と、その直前の質問）。履歴の項目と画面の要素を、そのときの状態から探す
function agentRetryPair(mid) {
  var at = mid ? agentHistory.findIndex(function (it) { return it.role === 'assistant' && it.mid === mid; }) : -1;
  return at > 0 && agentHistory[at - 1].role === 'user' ? [agentHistory[at - 1], agentHistory[at]] : [];
}
function agentRetryEls(mid) {
  var turn = mid ? Array.prototype.find.call(agentLog.querySelectorAll('.agent-turn'), function (t) { return t.dataset.mid === mid; }) : null;
  var user = turn && turn.previousElementSibling;
  return turn ? (user && user.classList.contains('agent-user') ? [user, turn] : [turn]) : [];
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
  var out = agentCitedText(text, data.marks) + '\n\n' + (ja ? '出典' : 'Sources');
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
      body: JSON.stringify(Object.assign({ text: r.text, sig: r.sig, part: i }, r.lang ? { lang: r.lang } : {}, r.contract)) })
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
    toggle: function (btn, text, sig, lang, contract) {
      var same = run && run.btn === btn;
      stop();
      if (same) return;
      if (!audio) audio = new Audio();
      var r = run = { btn: btn, text: text, sig: sig, lang: lang, contract: contract || {}, ctrl: new AbortController(), urls: [], total: 1 };
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

// AGENT_TRANSPORT_BEGIN
// 回答の受信（読み上げ設計§6.3）。通信を溜めるプロキシの下でも少しずつ届くよう WebSocket で受け、開く前に失敗したら SSE に切り替える。
// 受けたイベントは SSE の文字列に組み直して Response の本文にし、今の parseSSE・まとめて届いたときの再生・保存をそのまま使う。
// 開いて要求を送った後に切れたら SSE で送り直さない（Worker が回数を数えて AI を呼び始めているかもしれない）。トップページとアプリで同じ中身
var AGENT_WS_OPEN_MS = 5000;
// 開く前の失敗が1回あったら、その画面を閉じるまで SSE を使う
var agentSSEOnly = false; // 保存が禁止されていても、この画面では切り替えを保持する
function agentPreferSSE(remember) {
  if (remember) agentSSEOnly = true;
  try {
    if (remember) sessionStorage.setItem('magi_transport', 'sse');
    agentSSEOnly = agentSSEOnly || sessionStorage.getItem('magi_transport') === 'sse';
  } catch (_) {}
  return agentSSEOnly;
}
function agentSocketUrl(api) { return api.replace(/^http/, 'ws').replace(/\/magi2\/chat$/, '/magi2/ws'); }
function openAgentChat(api, body, signal) {
  function sse() { return fetch(api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, signal: signal }); }
  if (typeof WebSocket !== 'function' || agentPreferSSE(false)) return sse();
  if (signal && signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise(function (resolve, reject) {
    var ws, opened = false, settled = false, timer = null, controller = null;
    function aborted() { return new DOMException('Aborted', 'AbortError'); }
    function stop() {
      try { if (ws.readyState === 1) ws.send('{"type":"stop"}'); } catch (_) {}
      try { ws.close(1000); } catch (_) {}
    }
    function onAbort() {
      stop();
      if (!settled) { settled = true; clearTimeout(timer); reject(aborted()); }
      else if (controller) { try { controller.error(aborted()); } catch (_) {} }
    }
    function fallback() {
      if (settled) return;
      settled = true; clearTimeout(timer);
      try { ws.close(); } catch (_) {}
      if (signal) signal.removeEventListener('abort', onAbort);
      agentPreferSSE(true);
      resolve(sse());
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try { ws = new WebSocket(agentSocketUrl(api)); } catch (_) { fallback(); return; }
    timer = setTimeout(fallback, AGENT_WS_OPEN_MS);
    ws.onerror = function () { if (!opened) fallback(); };
    ws.onclose = function () { if (!opened) fallback(); };
    ws.onopen = function () {
      if (settled) { try { ws.close(); } catch (_) {} return; }
      opened = true; settled = true; clearTimeout(timer);
      var enc = new TextEncoder();
      var stream = new ReadableStream({ start: function (c) { controller = c; }, cancel: function () { stop(); } });
      ws.onmessage = function (event) {
        var m; try { m = JSON.parse(event.data); } catch (_) { return; }
        if (!m || typeof m.event !== 'string' || !/^[a-z_]+$/.test(m.event)) return;
        try { controller.enqueue(enc.encode(m.event === 'ping' ? ': ping\n\n' : 'event: ' + m.event + '\ndata: ' + JSON.stringify(m.data === undefined ? {} : m.data) + '\n\n')); } catch (_) {}
      };
      ws.onclose = function () { if (signal) signal.removeEventListener('abort', onAbort); try { controller.close(); } catch (_) {} };
      ws.onerror = function () { try { controller.error(new Error('ws_error')); } catch (_) {} };
      ws.send('{"type":"chat","v":1,"body":' + body + '}');
      resolve(new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } }));
    };
  });
}
// AGENT_TRANSPORT_END


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
  if (agentPrivateStorage(key)) return;
  if (nativeHistory && nativeHistory.active && nativeHistory.owns(key)) { nativeHistory.remove(key); return; }
  try { localStorage.removeItem(key); } catch (_) {}
}
// 画像サムネを持つ履歴は容量を食う。あふれたら古い保存セッションを捨てて1回だけ再試行する。
function safeStore(key, val) {
  if (agentPrivateStorage(key)) return;
  if (key === 'magi_saved_sessions' && Array.isArray(val)) val = val.filter(function (session) { return session && session.mode !== 'temporary'; });
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
  var sessions = nativeHistory && nativeHistory.active ? nativeHistory.sessions() : safeParse(safeGet('magi_saved_sessions'), []);
  return Array.isArray(sessions) ? sessions.filter(function (session) { return session && session.mode !== 'temporary'; }) : [];
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
// 回答の評価。押すと Good / Bad を選ぶ（上下の親指を重ねた形）。選んだ後はその親指だけを出す
var ICON_RATE = '<svg aria-hidden="true" class="rate-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path vector-effect="non-scaling-stroke" transform="translate(-0.5 -0.5) scale(0.6)" d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/><path vector-effect="non-scaling-stroke" transform="translate(10.1 10.1) scale(0.6)" d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>';
var ICON_GOOD = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>';
var ICON_BAD = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>';
var ICON_RETRY = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 0 0-14.8-4.2L3 9"/><polyline points="3 4 3 9 8 9"/><path d="M4 13a8 8 0 0 0 14.8 4.2L21 15"/><polyline points="21 20 21 15 16 15"/></svg>';
function rateBtnHTML() { return '<button type="button" class="react-btn" data-act="rate" title="' + tr('Rate this reply', '回答を評価') + '" aria-label="' + tr('Rate this reply', '回答を評価') + '" aria-haspopup="menu" aria-expanded="false">' + ICON_RATE + '</button>'; }

// 各人格カードの操作列（target = 人格コードネーム）。［コピー］［評価］
function reactionBarHTML(target) {
  return '<div class="reaction-bar" data-target="' + esc(target) + '">'
    + '<button type="button" class="react-btn" data-act="copy" title="' + tr('Copy', 'コピー') + '" aria-label="' + tr('Copy', 'コピー') + '">' + ICON_COPY + '</button>'
    + rateBtnHTML()
    + '</div>';
}

// 統合人格の回答の操作列（読み上げ設計§4.1）。［コピー］［共有］［🔊］［もう一度］［評価］と日時、右寄せの［ソース］。
// 共有はアプリと、共有シートを開ける端末だけ（PC ではコピーと同じになるので出さない）。
// 🔊・［もう一度］・日時・［ソース］は回答がそろってから setupReplyBar で出す
var SPEECH_API = API_BASE + '/magi2/speech';
var ICON_SPEAK = '<svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
var ICON_SPEAK_STOP = '<svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>';
var ICON_SPEAK_WAIT = '<svg aria-hidden="true" class="speak-wait" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9"/></svg>';
var ICON_SHARE = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>';
function nativeShare() { return window.Capacitor && window.Capacitor.isNativePlatform() && window.Capacitor.Plugins && window.Capacitor.Plugins.Share; }
function agentCanShare() { return !!(nativeShare() || navigator.share && window.matchMedia && window.matchMedia('(pointer: coarse)').matches); }
function replyBarHTML() {
  function b(act, label, icon, extra) { return '<button type="button" class="react-btn" data-act="' + act + '" title="' + label + '" aria-label="' + label + '"' + (extra || '') + '>' + icon + '</button>'; }
  return '<div class="reaction-bar reply-bar" data-target="integrated">'
    + b('copy', tr('Copy', 'コピー'), ICON_COPY)
    + (agentCanShare() ? b('share', tr('Share', '共有'), ICON_SHARE) : '')
    + b('speak', tr('Read aloud', '読み上げ'), ICON_SPEAK, ' aria-pressed="false" hidden')
    + b('retry', tr('Try again', 'もう一度試す'), ICON_RETRY, ' hidden')
    + rateBtnHTML()
    + '<time class="reply-time" hidden></time>'
    + '<button type="button" class="react-btn reply-src" data-act="sources" hidden></button>'
    + '</div>';
}
var agentSpeechOn = false, agentSpeechPlayer = null;
var AGENT_OPENED_AT = Date.now(); // これより後に付けた mid は送った時刻を表さない（agentReplyAt）
var agentLastSend = null; // 画像付きの質問を送り直すための原寸。この画面で最後に送った質問の分だけ持つ
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
  var time = bar.querySelector('.reply-time'), at = agentReplyAt(item, AGENT_OPENED_AT);
  if (time && at) { time.hidden = false; time.dateTime = new Date(at).toISOString(); writeReplyTime(time, at); }
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
// 公式の Share プラグインで OS の共有シートへ渡す。ブラウザの共有シートは指で操作する端末だけで使い、
// PC（マウス・トラックパッド）には［共有］を出さない（Windows の共有画面は送り先のアプリによって本文が入らない・下に入る。
// コピーで足りる）。共有シートが開けなかったときはコピーする
async function shareAgentReply(btn, bar, item) {
  if (agentTemporary()) return;
  var text = agentShareText(item.content, item.sources, isJa()), title = agentTitle || 'MAGI';
  var native = nativeShare();
  try {
    if (native) { await native.share({ title: title, text: text, dialogTitle: tr('Share reply', '回答を共有') }); return; }
    if (agentCanShare()) { await navigator.share({ title: title, text: text }); return; }
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
  panel.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { e.preventDefault(); removeAgentPanel(panel); return; }
    if (e.key !== 'Tab') return;
    var items = panel.querySelectorAll('button:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])');
    var first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  panel.querySelector('.agent-panel-close').addEventListener('click', function () { removeAgentPanel(panel); });
  document.getElementById('app').appendChild(panel);
  btn.setAttribute('aria-expanded', 'true');
  panel.querySelector('.agent-panel-close').focus({ preventScroll: true });
}

// インストール済みのPWA・ネイティブアプリには追加の案内を出さない。
var WEB_INSTALL = !(window.Capacitor && window.Capacitor.isNativePlatform())
  && !navigator.standalone && !window.matchMedia('(display-mode: standalone)').matches;
// 言語を切り替えたら描き直すので、毎回組み立てる
// AGENT_MANAGEMENT_BEGIN
function locationServiceEnabled() {
  try { return localStorage.getItem('magi_location_enabled') !== '0'; }
  catch (_) { return false; }
}
function agentManagementNative() { return typeof nativeAndroid !== 'undefined' && nativeAndroid; }
function agentWebNotificationsEnabled() {
  try { return localStorage.getItem('magi_notifications_enabled') === '1'; } catch (_) { return false; }
}
async function agentWebNotificationSupport() {
  if (!window.isSecureContext || !window.Notification || typeof window.Notification.requestPermission !== 'function') return { supported: false };
  var registration = null;
  try { if (navigator.serviceWorker) registration = await navigator.serviceWorker.getRegistration(); } catch (_) {}
  var mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || /Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1;
  return { supported: !!(registration && registration.active && registration.showNotification) || !mobile, registration: registration };
}
var agentWebNotice = null;
async function agentNotifyWebReply() {
  if (agentManagementNative() || agentTemporary() || !agentWebNotificationsEnabled()
    || !document.hidden && (!document.hasFocus || document.hasFocus())) return;
  try {
    var support = await agentWebNotificationSupport();
    if (!support.supported || !agentWebNotificationsEnabled() || agentTemporary() || window.Notification.permission !== 'granted'
      || !document.hidden && (!document.hasFocus || document.hasFocus())) return;
    var options = { body: tr('Your reply is ready.', '回答が届きました。'), tag: 'magi-reply' };
    if (support.registration && support.registration.active) await support.registration.showNotification('MAGI', options);
    else {
      if (agentWebNotice) agentWebNotice.close();
      agentWebNotice = new window.Notification('MAGI', options);
      agentWebNotice.onclick = function () { this.close(); window.focus(); if (typeof openAgentDock === 'function') openAgentDock(); };
    }
  } catch (_) { announceAgent(tr('Could not show the notification. Check browser permissions.', '通知を表示できませんでした。ブラウザの許可を確認してください。')); }
}
function agentWebHistoryData() {
  var saved = JSON.parse(localStorage.getItem('magi_saved_sessions') || '[]');
  var history = JSON.parse(localStorage.getItem('magi_current_history') || '[]');
  if (!Array.isArray(saved) || !Array.isArray(history)) throw new Error('invalid_history');
  var id = localStorage.getItem('magi_current_session_id');
  var current = id && !id.startsWith('temporary_') ? { id: id, title: localStorage.getItem('magi_current_title') || '', history: history,
    language: JSON.parse(localStorage.getItem('magi_current_language') || 'null'), shared: JSON.parse(localStorage.getItem('magi_current_shared') || 'null') } : null;
  // サムネ・元画像の参照も除外し、通常会話の保存済みデータだけを書き出す。
  function withoutImages(value) {
    if (Array.isArray(value)) return value.map(withoutImages);
    if (!value || typeof value !== 'object') return value;
    if (value.type === 'image_url') return { type: 'text', text: '[Image omitted]' };
    var result = Object.create(null);
    Object.keys(value).forEach(function (key) { if (key !== 'file') result[key] = withoutImages(value[key]); });
    return result;
  }
  return { version: 1, exportedAt: new Date().toISOString(), sessions: withoutImages(saved.filter(function (row) { return row && row.mode !== 'temporary' && !(typeof row.id === 'string' && row.id.startsWith('temporary_')); })), current: withoutImages(current) };
}
function agentClearWebHistory() {
  var keys = ['magi_saved_sessions', 'magi_current_history', 'magi_current_session_id', 'magi_current_title', 'magi_current_language', 'magi_current_shared'];
  var previous = keys.map(function (key) { return localStorage.getItem(key); });
  try {
    keys.forEach(function (key) { localStorage.removeItem(key); });
    if (keys.some(function (key) { return localStorage.getItem(key) !== null; })) throw new Error('history_not_deleted');
    localStorage.setItem('magi_history_cleared', String(Date.now()) + '_' + Math.random().toString(36).slice(2));
  } catch (error) {
    keys.forEach(function (key, i) { try { if (previous[i] !== null) localStorage.setItem(key, previous[i]); } catch (_) {} });
    throw error;
  }
  agentInvalidateSuspended(null);
  if (!agentTemporary()) resetAgent(true);
  if (typeof renderSavedSessionsList === 'function') renderSavedSessionsList();
}
async function initAgentManagement(panel) {
  if (agentManagementNative()) { await initNativeSettings(panel); return; }
  panel.querySelector('#agent-native-settings').innerHTML =
    '<div class="agent-setting"><span id="native-location-label">' + tr('Location services', '位置情報サービス') + '</span><button type="button" role="switch" id="native-location-toggle" aria-labelledby="native-location-label" aria-describedby="native-location-note" aria-checked="false"><span></span></button></div>'
    + '<p id="native-location-note">' + tr('Use the city and region estimated from your IP address for location-based searches. This does not request GPS permission. Changes apply to your next message.', '場所に応じた検索に、IPアドレスから推定した市・地域を使います。GPSの許可は求めません。変更は次の送信から反映します。') + '</p><p id="native-location-status" role="status"></p>'
    + '<div class="agent-setting"><span id="native-notification-label">' + tr('Notifications', '通知') + '</span><button type="button" role="switch" id="native-notification-toggle" aria-labelledby="native-notification-label" aria-describedby="native-notification-status" aria-checked="false" disabled><span></span></button></div><p id="native-notification-status" role="status"></p>'
    + '<p>' + tr('Notify when a reply finishes while this page is open in the background. This does not keep receiving replies after the page is closed. Temporary chats are not notified.', 'この画面を開いたまま別のタブやアプリを見ているとき、受信が完了した回答を通知します。画面を閉じた後の受信には対応しません。一時チャットは通知しません。') + '</p>'
    + '<p id="history-storage-status" role="status"></p><p>' + tr('Export chats saved in this browser as JSON, without images. Temporary chats are excluded. Deleting chats keeps your personalization and other settings.', 'このブラウザに保存された会話を、画像を除くJSONで書き出します。一時チャットは対象外です。会話を削除してもパーソナライズなどの設定は残します。') + '</p>'
    + '<div class="native-settings-actions"><button type="button" id="history-export">' + tr('Export all chats', '全会話を書き出す') + '</button><button type="button" id="history-clear">' + tr('Delete all chats', '全会話を削除') + '</button></div>';
  var status = panel.querySelector('#history-storage-status'), locationToggle = panel.querySelector('#native-location-toggle');
  locationToggle.setAttribute('aria-checked', String(locationServiceEnabled()));
  locationToggle.addEventListener('click', function () {
    try {
      localStorage.setItem('magi_location_enabled', locationServiceEnabled() ? '0' : '1');
      locationToggle.setAttribute('aria-checked', String(locationServiceEnabled())); panel.querySelector('#native-location-status').textContent = '';
    } catch (_) { panel.querySelector('#native-location-status').textContent = tr('Could not save this setting.', '設定を保存できませんでした。'); }
  });
  function refreshHistory() {
    try {
      var data = agentWebHistoryData(), count = data.sessions.length;
      if (data.current && data.current.history.length && !data.sessions.some(function (row) { return row.id === data.current.id; })) count++;
      status.textContent = tr('Saved chats: ', '保存された会話：') + count;
    } catch (_) { status.textContent = tr('Could not read saved chats. Your existing data is kept.', '保存された会話を読み込めませんでした。既存のデータは保持しています。'); }
  }
  refreshHistory();
  panel.querySelector('#history-export').addEventListener('click', function () {
    if (agentBusy || agentPrivacyState.preparing) { status.textContent = tr('Export after the reply finishes.', '回答が終わってから書き出してください。'); return; }
    var url;
    try {
      var payload = agentWebHistoryData();
      url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
      var link = document.createElement('a'); link.href = url; link.download = 'magi-chats-' + new Date().toISOString().slice(0, 10) + '.json'; document.body.appendChild(link); link.click(); link.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000); refreshHistory();
    } catch (_) { if (url) URL.revokeObjectURL(url); status.textContent = tr('Could not export chats. Existing chats are kept.', '会話を書き出せませんでした。既存の会話は保持しています。'); }
  });
  panel.querySelector('#history-clear').addEventListener('click', function () {
    if (agentBusy || agentPrivacyState.preparing) { status.textContent = tr('Stop the reply before deleting.', '回答を停止してから削除してください。'); return; }
    if (!window.confirm(tr('Delete all chats saved in this browser? This cannot be undone. Temporary chats and settings are kept.', 'このブラウザに保存された全会話を削除しますか？ 元には戻せません。一時チャットと設定は保持します。'))) return;
    try { agentClearWebHistory(); refreshHistory(); }
    catch (_) { status.textContent = tr('Could not delete all chats. Check browser storage and try again.', '全会話を削除できませんでした。ブラウザの保存先を確認して再試行してください。'); }
  });
  var toggle = panel.querySelector('#native-notification-toggle'), note = panel.querySelector('#native-notification-status');
  var support = await agentWebNotificationSupport(); if (!panel.isConnected) return;
  function refreshNotifications() {
    var supported = support.supported;
    toggle.disabled = !supported;
    toggle.setAttribute('aria-checked', String(supported && window.Notification.permission === 'granted' && agentWebNotificationsEnabled()));
    note.textContent = !supported ? tr('This browser cannot show notifications here. On mobile, try the installed PWA.', 'このブラウザでは通知を使えません。モバイルではホーム画面に追加したPWAをお試しください。')
      : window.Notification.permission === 'denied' ? tr('Notifications are blocked in browser settings. Allow them there before turning this on.', 'ブラウザの設定で通知がブロックされています。許可してからオンにしてください。')
      : tr('Turn on to allow reply notifications. Browser permission is required.', 'オンにすると回答の到着を通知します。ブラウザ側の許可が必要です。');
  }
  refreshNotifications();
  function onFocus() { if (panel.isConnected) refreshNotifications(); }
  window.addEventListener('focus', onFocus);
  panel.onAgentClose = function () { window.removeEventListener('focus', onFocus); };
  toggle.addEventListener('click', async function () {
    toggle.disabled = true;
    try {
      if (toggle.getAttribute('aria-checked') === 'true') {
        localStorage.setItem('magi_notifications_enabled', '0');
        if (agentWebNotice) { agentWebNotice.close(); agentWebNotice = null; }
        if (support.registration && support.registration.getNotifications) (await support.registration.getNotifications({ tag: 'magi-reply' })).forEach(function (item) { item.close(); });
      } else {
        var permission = window.Notification.permission === 'default' ? await window.Notification.requestPermission() : window.Notification.permission;
        if (permission === 'granted') localStorage.setItem('magi_notifications_enabled', '1');
      }
      if (panel.isConnected) refreshNotifications();
    } catch (_) { if (panel.isConnected) { refreshNotifications(); note.textContent = tr('Could not change notification settings.', '通知の設定を変更できませんでした。'); } }
  });
}
// AGENT_MANAGEMENT_END

// AGENT_EPHEMERAL_BEGIN
// トップとアプリで同じ契約を使う。会話の保存と設定の保存を分離する。
var agentPrivacyState = { mode: 'normal', temporaryPersonalization: false, preparing: false, preflight: null, background: false, switching: false, attachmentJobs: 0, suspended: null, normalWrite: false, features: null };
function agentTemporary() { return !!agentPrivacyState && agentPrivacyState.mode === 'temporary'; }
function cancelAgentPrivacyPreparation() { if (agentPrivacyState.preflight) agentPrivacyState.preflight.abort(); }
function agentPrivateStorage(key) { return !!agentPrivacyState && (agentPrivacyState.renderOnly || agentTemporary() && !agentPrivacyState.normalWrite) && /^(magi_current_|magi_saved_sessions$)/.test(key); }
function agentNormalStorage(fn) {
  agentPrivacyState.normalWrite = true;
  var store = typeof nativeHistory !== 'undefined' && nativeHistory && agentTemporary() ? nativeHistory : null;
  if (store) store.resumeWrites();
  try { return fn(); } finally { agentPrivacyState.normalWrite = false; if (store) store.suspendWrites(); }
}
function cleanAgentPersonalization(value) {
  if (!value || value.version !== 1 || typeof value.enabled !== 'boolean') throw new Error('invalid_personalization');
  var name = value.preferred_name === undefined ? '' : value.preferred_name, instructions = value.custom_instructions;
  if (typeof name !== 'string' || typeof instructions !== 'string'
    || /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(name)
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(instructions)
    || Array.from(name.trim()).length > 50 || Array.from(instructions).length > 2000) throw new Error('invalid_personalization');
  return { version: 1, enabled: value.enabled, preferred_name: name.trim(), custom_instructions: instructions };
}
function readAgentPersonalization() {
  // 読めない場合は不正値と区別し、送信元に例外を返す。オンの設定を黙って外さない。
  var raw;
  try { raw = localStorage.getItem('magi_personalization_v1'); }
  catch (_) { throw new Error('personalization_read_unavailable'); }
  try { return cleanAgentPersonalization(JSON.parse(raw)); }
  catch (_) { return { version: 1, enabled: false, preferred_name: '', custom_instructions: '' }; }
}
function refreshAgentPersonalization() {
  try { return readAgentPersonalization(); }
  catch (_) { announceAgent(tr('Could not read personalization settings. Check storage and try again.', 'パーソナライズ設定を読み込めませんでした。保存先を確認して再試行してください。')); return null; }
}
function saveAgentPersonalization(value) {
  var next = cleanAgentPersonalization(value);
  // 容量不足時も履歴を削減しない。書き込み成功までは有効設定を変更しない。
  localStorage.setItem('magi_personalization_v1', JSON.stringify(next));
}
function showAgentSettings() {
  var panel = makeAgentPanel('agent-settings-panel', tr('App management', 'アプリ管理'),
    '<div class="agent-settings-content"><form class="agent-personalization-form"><div class="agent-setting"><span id="personal-enabled-label">' + tr('Personalization', 'パーソナライズ') + '</span><button id="personal-enabled" type="button" role="switch" aria-checked="false" aria-labelledby="personal-enabled-label" aria-describedby="personal-note"><span></span></button></div>'
    + '<label for="personal-name">' + tr('What should MAGI call you?', '何とお呼びすればよいですか？') + '</label><input id="personal-name" type="text" autocomplete="off"><small id="personal-name-count"></small>'
    + '<label for="personal-instructions">' + tr('Custom instructions', 'カスタム指示') + '</label><textarea id="personal-instructions" rows="5" autocomplete="off"></textarea><small id="personal-instructions-count"></small>'
    + '<p id="personal-note">' + tr('Saved on this device. Applied from your next normal message. Temporary chats have their own personalization choice.', 'この端末に保存し、通常チャットの次の送信から適用します。一時チャットでは、そのチャットの設定で切り替えます。') + '</p>'
    + '<div class="personal-actions"><button type="submit">' + tr('Save', '保存') + '</button><button type="button" data-personal="cancel">' + tr('Cancel', 'キャンセル') + '</button><button type="button" data-personal="delete">' + tr('Delete settings', '設定を削除') + '</button></div><p id="personal-status" role="status"></p></form><div id="agent-native-settings"></div></div>');
  if (!panel) return;
  initAgentManagement(panel).catch(function () { announceAgent(tr('Could not open app settings.', 'アプリの設定を開けませんでした。')); });
  var form = panel.querySelector('form'), enabled = panel.querySelector('#personal-enabled'), name = panel.querySelector('#personal-name'), instructions = panel.querySelector('#personal-instructions'), status = panel.querySelector('#personal-status');
  var current = refreshAgentPersonalization();
  if (!current) {
    status.textContent = tr('Could not read personalization settings. Close this screen, check storage and try again.', 'パーソナライズ設定を読み込めませんでした。この画面を閉じて保存先を確認し、再試行してください。');
    form.querySelectorAll('input, textarea, button:not([data-personal="cancel"])').forEach(function (control) { control.disabled = true; });
    panel.querySelector('[data-personal="cancel"]').addEventListener('click', function () { closeAgentPanels(); document.getElementById('btn-more-agent').focus(); });
    return;
  }
  enabled.setAttribute('aria-checked', String(current.enabled)); name.value = current.preferred_name; instructions.value = current.custom_instructions;
  var loaded = JSON.stringify(current);
  function count() {
    panel.querySelector('#personal-name-count').textContent = Array.from(name.value.trim()).length + ' / 50';
    panel.querySelector('#personal-instructions-count').textContent = Array.from(instructions.value).length + ' / 2000';
  }
  function save(deleting) {
    try {
      // 別タブの更新を未確認のまま上書きしない。読込失敗も入力を残して知らせる。
      if (JSON.stringify(readAgentPersonalization()) !== loaded) { status.textContent = tr('Settings changed in another tab. Reopen this panel.', '別のタブで設定が変更されました。この画面を開き直してください。'); return; }
      var next = deleting ? { version: 1, enabled: false, preferred_name: '', custom_instructions: '' }
        : { version: 1, enabled: enabled.getAttribute('aria-checked') === 'true', preferred_name: name.value, custom_instructions: instructions.value };
      saveAgentPersonalization(next); closeAgentPanels(); document.getElementById('btn-more-agent').focus();
      announceAgent(tr('Personalization saved.', 'パーソナライズを保存しました。'));
    } catch (error) { status.textContent = error.message === 'invalid_personalization' ? tr('Check the length and characters of your settings.', '設定の文字数と使用できる文字を確認してください。') : tr('Could not save settings. Existing chats and settings were kept.', '設定を保存できませんでした。既存の会話と設定は保持しています。'); }
  }
  enabled.addEventListener('click', function () { enabled.setAttribute('aria-checked', String(enabled.getAttribute('aria-checked') !== 'true')); });
  form.addEventListener('input', count); count();
  form.addEventListener('submit', function (event) { event.preventDefault(); save(false); });
  panel.querySelector('[data-personal="cancel"]').addEventListener('click', function () { closeAgentPanels(); document.getElementById('btn-more-agent').focus(); });
  panel.querySelector('[data-personal="delete"]').addEventListener('click', function () { save(true); });
}
function agentTemporaryPersonalizationLabel() {
  return agentPrivacyState.temporaryPersonalization ? tr('Personalized', 'パーソナライズ') : tr('Without personalization', 'パーソナライズなし');
}
function agentTemporaryHintHTML() {
  return '<div class="agent-splash agent-temporary-splash"><h2>' + tr('Temporary chat', '一時チャット') + '</h2>'
    + '<p>' + tr('This chat is not saved in your history.', 'このチャットは履歴に保存されません。') + '</p>'
    + '<button type="button" data-temporary-details>' + tr('Learn more', '詳細を見る') + '</button>'
    + '<button type="button" data-temporary-personalization aria-haspopup="dialog">' + agentTemporaryPersonalizationLabel() + ' ⌄</button></div>';
}
function closeAgentPrivacyDialog(immediate) {
  var dialog = document.getElementById('agent-privacy-dialog');
  if (!dialog) return false;
  if (immediate !== true && dialog.open && dialog.classList.contains('agent-temporary-settings-dialog')
    && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    if (dialog.classList.contains('is-closing')) return true;
    dialog.classList.add('is-closing');
    var timer = setTimeout(finish, 220);
    function finish() { clearTimeout(timer); dialog.close(); dialog.remove(); }
    dialog.addEventListener('animationend', function (event) {
      if (event.target === dialog && event.animationName === 'agent-settings-out') finish();
    }, { once: true });
    return true;
  }
  dialog.close(); dialog.remove(); return true;
}
function makeAgentPrivacyDialog(title, content, sheet) {
  closeAgentPrivacyDialog(true);
  var opener = document.activeElement, dialog = document.createElement('dialog');
  dialog.id = 'agent-privacy-dialog'; dialog.className = 'agent-privacy-dialog' + (sheet ? ' agent-temporary-settings-dialog' : ''); dialog.setAttribute('aria-labelledby', 'agent-privacy-dialog-title');
  dialog.innerHTML = '<div class="agent-privacy-dialog-head"><h2 id="agent-privacy-dialog-title">' + title + '</h2>'
    + '<button type="button" data-privacy-close aria-label="' + tr('Close', '閉じる') + '">✕</button></div>' + content;
  dialog.querySelector('[data-privacy-close]').addEventListener('click', closeAgentPrivacyDialog);
  dialog.addEventListener('click', function (event) { if (event.target === dialog) closeAgentPrivacyDialog(); });
  dialog.addEventListener('cancel', function (event) { event.preventDefault(); closeAgentPrivacyDialog(); });
  dialog.addEventListener('close', function () {
    dialog.remove();
    if (document.getElementById('agent-privacy-dialog')) return;
    var focus = opener && opener.isConnected && opener.getClientRects().length ? opener : document.getElementById('btn-temporary-agent');
    if (focus) focus.focus({ preventScroll: true });
  });
  document.body.appendChild(dialog); dialog.showModal();
  return dialog;
}
function showAgentTemporaryDetails() {
  if (!agentTemporary()) return;
  var dialog = makeAgentPrivacyDialog(tr('About temporary chats', '一時チャットについて'),
    '<div class="agent-temporary-details"><h3>' + tr('Not saved in MAGI', 'MAGIには会話を保存しません') + '</h3><p>'
    + tr('Messages and images stay only in this open chat. They are not saved to MAGI history, device files or its database. Ending the chat or reloading discards them. Daily usage counters remain.', 'メッセージと画像は、開いているチャットの中だけに保持します。MAGIの履歴・端末ファイル・データベースには保存せず、終了や再読み込みで破棄します。利用制限用の日ごとの回数などは記録します。') + '</p>'
    + '<h3>' + tr('Model training and external providers', 'モデル学習と外部サービス') + '</h3><p>'
    + tr('MAGI does not store these conversations for model training. Conversations still go to external AI providers under their own retention and training policies. MAGI cannot guarantee that all providers exclude training.', 'MAGIでは、この会話をモデル学習用に保存しません。ただし会話は外部AIへ送られ、各社の保存・学習方針が適用されます。すべての送信先で学習に使われないとは保証できません。') + '</p>'
    + '<p>' + tr('Read aloud sends the reply to Fish Audio, whose terms permit training use. Temporary audio is not cached by MAGI. Copying leaves text on the clipboard. Ratings and sharing are unavailable.', '読み上げでは回答本文をFish Audioに送ります。同社の規約は学習利用を認めています。一時チャットの音声はMAGIでキャッシュしません。コピー先には内容が残ります。評価・共有は利用できません。') + '</p>'
    + '<h3>' + tr('Your personalization choice', 'パーソナライズを選べます') + '</h3><p>'
    + tr('Choose whether this chat uses the preferred name and custom instructions saved in App management. This choice lasts only for this temporary chat and does not change normal-chat settings. Changes apply to the next message; messages already sent are not recalled.', 'アプリ管理に保存した呼び方・カスタム指示を、このチャットで使うか選べます。この選択は一時チャットの間だけ有効で、通常チャットの設定は変えません。変更は次の送信から反映し、すでに送った内容は取り消しません。') + '</p></div>');
  dialog.querySelector('[data-privacy-close]').focus();
}
function showAgentTemporarySettings() {
  if (!agentTemporary() || agentBusy || agentPrivacyState.preparing || agentPrivacyState.switching) return;
  var dialog = makeAgentPrivacyDialog(tr('Temporary chat settings', '一時チャットの設定'),
    '<form id="agent-temporary-settings-form"><fieldset><legend>' + tr('Personalization for this chat', 'このチャットのパーソナライズ') + '</legend>'
    + '<label><input type="radio" name="temporary-personalization" value="on"><span><strong>' + tr('Personalized', 'パーソナライズ') + '</strong><small>'
    + tr('Use the preferred name and custom instructions saved in App management.', 'アプリ管理に保存した呼び方・カスタム指示を参照します。') + '</small></span></label>'
    + '<label><input type="radio" name="temporary-personalization" value="off"><span><strong>' + tr('Without personalization', 'パーソナライズなし') + '</strong><small>'
    + tr('Do not use the saved name or custom instructions in the next request.', '次の送信では保存した呼び方・カスタム指示を使用しません。') + '</small></span></label></fieldset>'
    + '<p>' + tr('Only for this chat, from your next message. Normal-chat settings stay unchanged.', 'このチャットの次の送信から適用します。通常チャットの設定は変わりません。') + '</p>'
    + '<button type="submit">' + tr('Done', '完了') + '</button></form>', true);
  var selected = dialog.querySelector('input[value="' + (agentPrivacyState.temporaryPersonalization ? 'on' : 'off') + '"]');
  selected.checked = true; selected.focus();
  dialog.querySelector('form').addEventListener('submit', function (event) {
    event.preventDefault();
    if (!agentTemporary() || agentBusy || agentPrivacyState.preparing) return;
    agentPrivacyState.temporaryPersonalization = dialog.querySelector('input:checked').value === 'on';
    syncAgentPrivacyUI(); closeAgentPrivacyDialog(); announceAgent(agentTemporaryPersonalizationLabel());
  });
}
async function agentPrivacyRequest() {
  var temporary = agentTemporary(), useSettings = !temporary || agentPrivacyState.temporaryPersonalization;
  var settings = useSettings ? readAgentPersonalization() : null;
  if (!temporary && !settings.enabled) return null;
  var ctrl = new AbortController(); agentPrivacyState.preflight = ctrl;
  var timer = setTimeout(function () { ctrl.abort(); }, 10000);
  try {
    var response = await fetch(AGENT_API.replace(/\/chat$/, '/models?capabilities=1'), { cache: 'no-store', signal: ctrl.signal });
    if (!response.ok) throw new Error('privacy_unavailable');
    var features = (await response.json()).features;
    if (ctrl.signal.aborted) throw new Error('privacy_cancelled');
    if (!features || features.privacy_contract !== 1 || !(temporary ? features.temporary_chat : features.personalization)) throw new Error('privacy_unavailable');
    if (temporary && agentPrivacyState.temporaryPersonalization && (!features.temporary_personalization || !features.personalization)) throw new Error('privacy_unavailable');
    agentPrivacyState.features = features;
    var body = { privacy_contract: 1, conversation_mode: temporary ? 'temporary' : 'normal' };
    if (temporary && agentPrivacyState.temporaryPersonalization) body.temporary_personalization = true;
    if (!temporary || agentPrivacyState.temporaryPersonalization) body.personalization = { enabled: true, preferred_name: settings.preferred_name, custom_instructions: settings.custom_instructions };
    return body;
  } finally {
    clearTimeout(timer);
    if (agentPrivacyState.preflight === ctrl) agentPrivacyState.preflight = null;
  }
}
function agentPrivacyExpected(body) {
  return body ? { conversation_mode: body.conversation_mode,
    personalization_applied: !!(body.personalization && (body.personalization.preferred_name.trim() || body.personalization.custom_instructions.trim())) } : null;
}
function agentStoredSessions() {
  if (typeof nativeHistory !== 'undefined' && nativeHistory && nativeHistory.active) return nativeHistory.sessions();
  var raw = localStorage.getItem('magi_saved_sessions');
  var sessions = raw ? JSON.parse(raw) : [];
  if (!Array.isArray(sessions)) throw new Error('invalid_history');
  return sessions;
}
function agentInvalidateSuspended(id) {
  [agentPrivacyState.suspended, agentPrivacyState.recovery].forEach(function (saved) {
    if (!saved || id && saved.id !== id) return;
    saved.deleted = true; saved.history = []; saved.attachments = []; saved.draft = ''; saved.shared = null; saved.lastSend = null;
    // 一時中のcurrentSessionIdは別ID。保存先に残る通常会話の現在値も削除する。
    if (saved.id && safeGet('magi_current_session_id') === saved.id) agentNormalStorage(function () {
      ['magi_current_history','magi_current_title','magi_current_language','magi_current_session_id','magi_current_shared'].forEach(safeRemove);
    });
  });
}
// 一時中の通常履歴の明示削除。保存失敗を隠さず、容量回復用の履歴削減も使わない。
async function agentDeleteSavedDuringTemporary(id) {
  agentInvalidateSuspended(id);
  try {
    var list = agentStoredSessions().filter(function (session) { return session.id !== id && session.mode !== 'temporary'; });
    agentNormalStorage(function () {
      if (typeof nativeHistory !== 'undefined' && nativeHistory && nativeHistory.active) nativeHistory.setSessions(list);
      else localStorage.setItem('magi_saved_sessions', JSON.stringify(list));
    });
    if (typeof nativeHistory !== 'undefined' && nativeHistory && nativeHistory.active) await nativeHistory.flush();
    if (typeof nativeConversation !== 'undefined' && nativeConversation) await nativeConversation.clear(id);
  } catch (_) { announceAgent(tr('Could not finish deleting the saved chat. Check storage and try again.', '保存した会話の削除が完了しませんでした。保存先を確認して再試行してください。')); }
  renderSavedSessionsList();
}
function agentEndTemporary() {
  if (!agentTemporary()) return;
  cancelAgentPrivacyPreparation();
  dropAgentRequest(); if (agentSpeechPlayer) agentSpeechPlayer.stop();
  Object.keys(pendingReactions).forEach(function (key) { delete pendingReactions[key]; });
  agentLastSend = null; attachments = []; agentHistory = []; agentReplyLanguage = null; currentSessionId = null;
  agentInput.value = ''; agentBusy = false; agentDead = false; agentClosed = false;
  if (typeof agentShared !== 'undefined') { agentShared = null; renderSharedDocument(); }
  closeAgentPrivacyDialog(true);
  agentLog.replaceChildren(); agentPrivacyState.mode = 'normal'; agentPrivacyState.temporaryPersonalization = false;
  if (typeof nativeHistory !== 'undefined' && nativeHistory) nativeHistory.resumeWrites();
  syncAgentPrivacyUI();
  // 通常へ戻す場合は呼び出し側が先に退避を受け取る。破棄は終了処理に集約する。
  agentPrivacyState.suspended = null;
}
async function toggleAgentTemporary() {
  if (agentBusy || agentPrivacyState.preparing || agentPrivacyState.switching || agentPrivacyState.attachmentJobs) return;
  if (typeof historyLoading !== 'undefined' && historyLoading || typeof nativeAndroid !== 'undefined' && nativeAndroid && !(nativeHistory && nativeHistory.active)) return;
  agentPrivacyState.switching = true;
  try {
    if (agentTemporary()) {
      var saved = agentPrivacyState.suspended;
      agentEndTemporary();
      if (saved && !saved.deleted) {
        try {
          var latest = agentStoredSessions().find(function (session) { return session.id === saved.id; });
          if (saved.persisted && !latest) saved.deleted = true;
          else if (latest && JSON.stringify(latest) !== saved.revision) {
            saved.history = latest.history; saved.title = latest.title; saved.language = latest.reply_language; saved.shared = latest.shared || null;
          }
        } catch (_) {
          agentPrivacyState.recovery = saved; saved = null;
          announceAgent(tr('Could not verify saved chats. Unsaved data remains in memory; reopen after storage is available.', '保存履歴を確認できません。未保存分はメモリに保持しています。保存先を確認後、通常会話を再開してください。'));
        }
      }
      agentPrivacyState.renderOnly = true;
      if (saved && !saved.deleted) {
        agentHistory = cleanHistory(saved.history); currentSessionId = saved.id; agentReplyLanguage = saved.language;
        agentClosed = saved.closed; agentDead = saved.dead; agentInput.value = saved.draft; attachments = saved.attachments; agentLastSend = saved.lastSend;
        if (typeof agentShared !== 'undefined') { agentShared = saved.shared; renderSharedDocument(); }
        setAgentTitle(saved.title); renderHistoryToLog(agentHistory);
      } else { setAgentTitle(''); renderHistoryToLog([]); }
      agentPrivacyState.renderOnly = false;
    } else {
      if (typeof nativeInput !== 'undefined' && nativeInput) await nativeInput.stopVoice();
      var warning = false;
      if (typeof nativeHistory !== 'undefined' && nativeHistory && nativeHistory.active) {
        try { await nativeHistory.flush(); } catch (_) { warning = true; }
        nativeHistory.suspendWrites();
      }
      var row = null;
      try { row = agentStoredSessions().find(function (session) { return session.id === currentSessionId; }); } catch (_) { warning = true; }
      agentPrivacyState.suspended = { id: currentSessionId, history: agentHistory.slice(), title: agentTitle, language: agentReplyLanguage,
        closed: agentClosed, dead: agentDead, draft: agentInput.value, attachments: attachments.slice(), lastSend: agentLastSend, persisted: !!row, revision: row ? JSON.stringify(row) : null,
        shared: typeof agentShared !== 'undefined' ? agentShared : null };
      dropAgentRequest(); if (agentSpeechPlayer) agentSpeechPlayer.stop();
      agentPrivacyState.mode = 'temporary'; agentPrivacyState.temporaryPersonalization = false; currentSessionId = 'temporary_' + Date.now();
      agentHistory = []; attachments = []; agentReplyLanguage = null; agentBusy = false; agentDead = false; agentClosed = false; agentLastSend = null;
      if (typeof agentShared !== 'undefined') { agentShared = null; renderSharedDocument(); }
      agentInput.value = ''; agentLog.replaceChildren(); setAgentTitle(''); renderHistoryToLog([]);
      if (warning) announceAgent(tr('Normal chat has unsaved changes held in memory. Reloading will discard them.', '通常会話の未保存分はメモリに保持しています。再読み込みすると失われます。'));
    }
    agentDegraded.classList.add('hidden'); agentDegraded.textContent = '';
    renderAttachTray(); fitAgentInput(); setAgentControlsEnabled(!agentClosed && !agentDead); updateAgentActionButtons();
  } finally { agentPrivacyState.switching = false; syncAgentPrivacyUI(); }
}
function syncAgentPrivacyUI() {
  if (!agentPrivacyState) return;
  var temporary = agentTemporary(), button = document.getElementById('btn-temporary-agent');
  if (!agentBusy && !agentInput.disabled) agentSendBtn.disabled = agentPrivacyState.attachmentJobs > 0;
  if (button) {
    button.setAttribute('aria-pressed', String(temporary)); button.title = temporary ? tr('Return to normal chat', '通常チャットに戻る') : tr('Temporary chat', '一時チャット');
    button.setAttribute('aria-label', button.title); button.disabled = !!(agentBusy || agentPrivacyState.preparing || agentPrivacyState.switching || agentPrivacyState.attachmentJobs);
  }
  var host = agentLog.parentNode;
  host.classList.toggle('agent-temporary', temporary);
  if (temporary && !agentBusy && !agentLog.children.length) agentLog.innerHTML = agentTemporaryHintHTML();
  var recovery = document.getElementById('agent-normal-recovery');
  if (!recovery) {
    recovery = document.createElement('p'); recovery.id = 'agent-normal-recovery';
    var retry = document.createElement('button'); retry.type = 'button';
    retry.textContent = tr('Recheck unsaved chat', '未保存の通常会話の復元を再確認');
    retry.addEventListener('click', function () {
      if (agentBusy || agentPrivacyState.preparing || !agentPrivacyState.recovery) return;
      agentPrivacyState.suspended = agentPrivacyState.recovery; agentPrivacyState.recovery = null;
      agentPrivacyState.mode = 'temporary'; toggleAgentTemporary().catch(function () { announceAgent(tr('Could not restore the chat.', '会話を復元できませんでした。')); });
    });
    recovery.appendChild(retry); agentLog.before(recovery);
  }
  recovery.hidden = temporary || !agentPrivacyState.recovery || agentPrivacyState.recovery.deleted;
  var choice = agentLog.querySelector('[data-temporary-personalization]');
  if (choice) {
    var label = agentTemporaryPersonalizationLabel() + ' ⌄';
    if (choice.textContent !== label) choice.textContent = label;
    choice.disabled = !!(button && button.disabled);
  }
  ['btn-share-agent','btn-export-agent'].forEach(function (id) { var el = document.getElementById(id); if (el) el.hidden = temporary; });
  var voice = document.getElementById('agent-voice'); if (voice) { if (temporary) { if (!voice.hidden) voice.dataset.privacyAvailable = 'true'; voice.hidden = true; } else if (voice.dataset.privacyAvailable === 'true') voice.hidden = false; }
  var camera = document.querySelector('#agent-attach-menu [data-source="camera"]'); if (camera) camera.hidden = temporary || !(typeof nativeAndroid !== 'undefined' && nativeAndroid || matchMedia('(pointer: coarse)').matches);
  if (temporary) {
    agentLog.querySelectorAll('[data-act="rate"], [data-act="react"], [data-act="share"]').forEach(function (el) { el.remove(); });
    agentLog.querySelectorAll('[data-act="speak"]').forEach(function (el) { el.hidden = !(agentPrivacyState.features && agentPrivacyState.features.temporary_speech && agentItemFor(el)?.speech_sig); });
  }
}
function initAgentPrivacy() {
  refreshAgentPersonalization();
  document.getElementById('btn-temporary-agent').addEventListener('click', function () { toggleAgentTemporary().catch(function () { announceAgent(tr('Could not switch chats safely.', '会話を安全に切り替えられませんでした。')); }); });
  document.getElementById('btn-settings-agent').addEventListener('click', showAgentSettings);
  agentLog.addEventListener('click', function (event) {
    if (event.target.closest('[data-temporary-details]')) showAgentTemporaryDetails();
    else if (event.target.closest('[data-temporary-personalization]')) showAgentTemporarySettings();
  });
  window.addEventListener('storage', function (event) {
    if (event.key === 'magi_personalization_v1' || event.key === null) refreshAgentPersonalization();
    if (event.key === 'magi_history_cleared') { agentInvalidateSuspended(null); if (!agentTemporary()) resetAgent(true); }
    var saved = agentPrivacyState.suspended;
    if (saved && saved.persisted && (event.key === 'magi_saved_sessions' || event.key === null)) {
      try { if (!agentStoredSessions().some(function (s) { return s.id === saved.id; })) agentInvalidateSuspended(saved.id); } catch (_) {}
    }
  });
  window.addEventListener('pagehide', function () { if (agentTemporary()) { agentEndTemporary(); agentPrivacyState.recovery = null; } });
  window.addEventListener('pageshow', function (event) {
    if (!event.persisted) return;
    if (typeof loadCurrentSessionMeta === 'function') loadCurrentSessionMeta();
    else {
      currentSessionId = safeGet('magi_current_session_id') || null;
      var meta = safeParse(safeGet('magi_current_language'), {}) || {};
      agentReplyLanguage = meta.id === currentSessionId ? cleanReplyLanguage(meta.reply_language) : null;
    }
    if (typeof initAgent === 'function') initAgent(); else agentInitialState(true);
    syncAgentPrivacyUI();
  });
  if (typeof nativeAndroid !== 'undefined' && nativeAndroid && window.Capacitor.Plugins.App) {
    window.Capacitor.Plugins.App.addListener('appStateChange', function (state) {
      agentPrivacyState.background = !state.isActive;
      if (!agentPrivacyState.background || !agentTemporary()) return;
      if (agentPrivacyState.preparing) { cancelAgentPrivacyPreparation(); dropAgentRequest(); }
      if (agentCtrl) { agentCtrl.userStopped = true; agentCtrl.abort(); }
      if (agentSpeechPlayer) agentSpeechPlayer.stop();
    });
  }
  new MutationObserver(syncAgentPrivacyUI).observe(agentLog, { childList: true, subtree: true });
  syncAgentPrivacyUI();
}
setTimeout(initAgentPrivacy, 0);
// AGENT_EPHEMERAL_END

function agentHintHTML() { return agentTemporary() ? agentTemporaryHintHTML() : '<div class="agent-splash">'
  + '<svg aria-hidden="true" class="magi-emblem" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">'
  // 枠の形は表示とマスクで共用し、線と発光を半透明の枠の外だけに描く。
  + '<defs><g id="magi-emblem-frames"><polygon points="43,14 77,14 77,44 68,54 52,54 43,44"/><polygon points="18,58 40,58 52,68 52,98 18,98"/><polygon points="80,58 102,58 102,98 68,98 68,68"/></g><mask id="magi-emblem-links-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="120" height="120"><rect width="120" height="120" fill="white"/><use href="#magi-emblem-frames" fill="black" stroke="black" stroke-width="2"/></mask></defs>'
  + '<g mask="url(#magi-emblem-links-mask)">'
  + '<line class="hl-bg" x1="51.5" y1="49" x2="43.5" y2="63"/><line class="hl-bg" x1="76.5" y1="63" x2="68.5" y2="49"/><line class="hl-bg" x1="52" y1="78" x2="68" y2="78"/>'
  + '<line class="hl-flow" x1="51.5" y1="49" x2="43.5" y2="63"/><line class="hl-flow" x1="76.5" y1="63" x2="68.5" y2="49"/><line class="hl-flow" x1="52" y1="78" x2="68" y2="78"/>'
  + '</g>'
  + '<use class="hx" href="#magi-emblem-frames"/>'
  + '<text class="hn" x="60" y="39" text-anchor="middle">2</text>'
  + '<text class="hn" x="35" y="83" text-anchor="middle">3</text>'
  + '<text class="hn" x="85" y="83" text-anchor="middle">1</text>'
  + '</svg>'
  + '<div class="magi-title">MAGI</div>'
  + '<div class="magi-sub">Multi-Agent Generative Intelligence</div>'
      + '<button type="button" id="btn-versions-agent" class="magi-ver" title="' + tr('Version information', 'バージョン情報') + '">ver ' + APP_VERSION + '</button>'
  + '<div class="magi-nodes">' + AGENT_PERSONAS.map(function (p) { return '<button type="button" class="magi-node" data-codename="' + p.codename + '">' + p.codename.replace('-', '·') + '</button>'; }).join('')
  + '<button type="button" class="magi-node" data-codename="' + AGENT_SYNTH.codename + '">✦ ' + AGENT_SYNTH.codename.toUpperCase() + '</button>' + '</div>'
  + '<div class="magi-desc hidden" aria-live="polite"></div>'
  + (WEB_INSTALL ? '<div class="magi-nodes"><button type="button" class="magi-node" data-install-agent>' + tr('Add to Home Screen', 'ホーム画面に追加') + '</button></div>' : '')
  + '</div>'; }

// ---- Title ------------------------------------------------------------------
function setAgentTitle(text) {
  agentTitle = agentTemporary() ? tr('Temporary chat', '一時チャット') : (text || '').trim();
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
  if (agentTemporary()) return;
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
// 復元：保存済みの評価をターン内のバーに反映（以前の絵文字のリアクションは出さない）
function applyReactionsToTurn(turn, reactions) {
  if (!reactions) return;
  Object.keys(reactions).forEach(function (target) {
    var value = agentRatingOf(reactions[target]);
    var sel = (window.CSS && CSS.escape) ? CSS.escape(target) : target;
    var bar = value && turn.querySelector('.reaction-bar[data-target="' + sel + '"]');
    if (bar) showRating(bar, value);
  });
}

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
  syncRetryButtons();
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
  if (agentTemporary()) return;
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
      agentEndTemporary();
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
      let timer = null, wake = null, privacySeen = false;
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
        if (!data || ['session','classification','title','error','motion','persona','ask','judge','verdict','integrated','integrated_end','closed','clarify','sources','pages','suggest','speech','done'].indexOf(ev) < 0) return false;
        const parsed = JSON.parse(data.replace(/\n$/, ''));
        if (ev === 'session') {
          if (handlers.privacy && (privacySeen || parsed.conversation_mode !== handlers.privacy.conversation_mode || parsed.personalization_applied !== handlers.privacy.personalization_applied)) throw new Error('privacy_contract_mismatch');
          privacySeen = true; return false;
        }
        if (handlers.privacy && !privacySeen && ev !== 'error') throw new Error('privacy_contract_missing');

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
        if (handlers.privacy && !privacySeen) throw new Error('privacy_contract_missing');
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
  if (agentPrivacyState.switching || agentPrivacyState.preparing) return;
  agentPrivacyState.attachmentJobs++; syncAgentPrivacyUI();
  try { return await addAgentAttachments(files); }
  finally { agentPrivacyState.attachmentJobs--; syncAgentPrivacyUI(); }
}
async function addAgentAttachments(files) {
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
      var original = !agentTemporary() && nativeHistory && nativeHistory.active ? await nativeHistory.storeImage(list[i]) : null;
      if (generation !== agentGen) { if (original) nativeHistory.releaseImage(original); return; }
      // 別の選択・貼り付けがawait中に完了していても4枚を超えない。
      if (attachments.length >= ATTACH_MAX) {
        if (original && !attachments.some(function (a) { return a.file === original; })) nativeHistory.releaseImage(original);
        noticeAttach(tr('Up to ' + ATTACH_MAX + ' images', '画像は' + ATTACH_MAX + '枚までです')); break;
      }
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
  attachMenu.querySelector('[data-source="camera"]').hidden = agentTemporary() || !nativeAndroid && !matchMedia('(pointer: coarse)').matches;
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
  if (agentTemporary() && item.dataset.source === 'camera') return;
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
  // 考えた秒数・受信の印・読み上げの署名・回答の日時・送り直しの印は画面のためだけのもので、次の質問の API には送らない
  const messages = cleanHistory(history).slice(-AGENT_MAX_HISTORY).map(({ thinkingSeconds, native_request, speech_sig, speech_lang, speech_version, speech_mode, at, retry_of, ...m }) => agentFactHistoryMessage(m));
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
  if (agentPrivacyState) queueMicrotask(syncAgentPrivacyUI);
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

// retry: ［もう一度］のときの { text, atts, mid（置き換える回答） }。入力欄には触れない。
// 古い往復は隠して、送る履歴からだけ外す。新しい回答が届いたら履歴からも消し、届かなければ見せ直す
// （途中で開き直す・会話を切り替えても、古い回答は保存した履歴に残る）。質問に retry_of を付けて保存するので、
// 送り直しの最中にアプリが閉じても、受信の復元（recovered）で同じように置き換える
async function agentSend(recovered, retry) {
      if (agentPrivacyState.preparing || agentPrivacyState.switching || agentTemporary() && agentPrivacyState.background) return;
      if (agentPrivacyState.attachmentJobs) return;
      if (agentBusy || agentDead || agentClosed) return;
      var requestPrivacy = null, privacyGeneration = agentGen;
      agentPrivacyState.preparing = true; syncAgentPrivacyUI();
      try { requestPrivacy = recovered ? null : await agentPrivacyRequest(); }
      catch (error) {
        if (privacyGeneration !== agentGen) return;
        announceAgent(error && error.message === 'personalization_read_unavailable'
          ? tr('Could not read personalization settings, so nothing was sent. Your draft is kept. Check storage and try again.', 'パーソナライズ設定を読み込めないため送信しませんでした。入力は保持しています。保存先を確認して再試行してください。')
          : tr('This feature is unavailable. Your draft and settings are kept. Retry, or check this chat’s personalization setting.', 'この機能を確認できません。入力と設定は保持しています。再試行するか、このチャットのパーソナライズ設定を確認してください。'));
        return;
      }
      finally { agentPrivacyState.preparing = false; syncAgentPrivacyUI(); }
      if (privacyGeneration !== agentGen) return;

  if (agentSpeechPlayer) agentSpeechPlayer.stop();
  if (historyLoading || sharedLoading || agentBusy || agentDead || agentClosed) return;
  // 音声入力中の送信は確定だけにする。保存列の復元は新規送信と区別する。
  if (!recovered && !retry && nativeInput && nativeInput.listening()) { nativeInput.finishVoice(); return; }
  var savedUser = recovered ? agentHistory.at(-1) : null;
  if (recovered && (!nativeConversation || !savedUser || savedUser.role !== 'user' || savedUser.native_request !== recovered.id)) return;
  var draftText = recovered ? contentText(savedUser.content) : retry ? retry.text : agentInput.value;
  var text = recovered || retry ? draftText : agentClarifyAnswer(lastAgentTurn(), draftText.trim());
  if (text === null) { announceAgent(document.documentElement.lang === 'ja' ? '回答全体を1000文字以内、その他を100文字以内にしてください。' : 'Keep the full answer within 1,000 characters and Other within 100.'); return; }
  var atts = recovered ? contentImages(savedUser.content).map(function (p) { return { url: p.image_url.url, thumb: p.image_url.url, file: p.file }; }) : retry ? retry.atts : attachments.slice();
  if (!text && !atts.length) return;
  var retryOf = retry ? retry.mid : recovered && typeof savedUser.retry_of === 'string' ? savedUser.retry_of : null;
  agentRetryEls(retryOf).forEach(function (el) { el.hidden = true; });
  var sendHistory = function () { var pair = agentRetryPair(retryOf); return pair.length ? agentHistory.filter(function (it) { return pair.indexOf(it) < 0; }) : agentHistory; };
  var clarifyDraft = retry ? null : freezeAgentClarify();
  var startedAt = recovered ? recovered.startedAt : Date.now();
  setAgentSuggestion('');
  if (!retry) { agentInput.value = ''; fitAgentInput(); attachments = []; renderAttachTray(); }
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
  var nativeRunId = recovered ? recovered.id : !agentTemporary() && nativeConversation ? nativeConversation.id() : null;
  turn.innerHTML = personaCardsHTML();
  var replyEl = document.createElement('div'); replyEl.className = 'agent-reply streaming';
  replyEl.innerHTML = '<span class="agent-who">✦ Shinya Takeda</span><span class="agent-reply-body"></span>' + replyBarHTML();
  turn.appendChild(replyEl);
  agentLog.appendChild(turn); agentScroll();
  var replyBody = replyEl.querySelector('.agent-reply-body');
  var thinking = startMagiThinking(replyEl.querySelector('.agent-who'), startedAt);

  var userItem = recovered ? savedUser : { role: 'user', content: storeContent, ...(nativeRunId ? { native_request: nativeRunId } : {}), ...(retryOf ? { retry_of: retryOf } : {}) };
  if (!recovered) agentHistory.push(userItem);
  safeStore('magi_current_history', agentHistory);
  syncRetryButtons();
  if (!recovered && nativeHistory && nativeHistory.active) atts.forEach(function (a) { if (a.file) nativeHistory.releaseImage(a.file); });

  agentBusy = true; setAgentControlsEnabled(false);
  setAgentStopMode(true);
  var reply = '', errored = false, timedOut = false, suggestion = '', completed = false, sitePages = null, classified = false;
      var magiMeta = null, magiView = null, integratedEnd = false, magiRetained = false;
      var closedReply = false, factReply = false, replySources = null, clarifyReply = null, speechSig = null, speechLang = null, speechVersion = null, speechMode = null;
      var sendId = ++agentSendSequence;
  var debateData = {};
  AGENT_PERSONAS.forEach(function (p) { debateData[p.codename] = { round1: '…', round2: '…', followups: [] }; });

  var ctrl = new AbortController();
  var conversationId = ensureAgentConversation();
  var gen = agentGen; agentCtrl = ctrl;

  var dropped = function () { return gen !== agentGen || conversationId !== currentSessionId || sendId !== agentSendSequence; };
      const streamWatch = nativeRunId && nativeConversation ? nativeConversation.watch() : createMagiStreamWatch(ctrl, startedAt, {
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
    var history = sendHistory();
    var outbound = prepareAgentMessages(history, sendContent);
    var deviceLocation = !recovered ? await locationForMessage(ctrl.signal, turn) : null;
    if (dropped() || ctrl.signal.aborted) throw new DOMException('stopped', 'AbortError');
    var requestBody = JSON.stringify(Object.assign({ messages: outbound, theme, suggest: true, site_pages: true, page: 'app', adaptive_debate: true, location_enabled: locationServiceEnabled() }, locationServiceEnabled() && deviceLocation ? { device_location: deviceLocation } : {}, classificationFields(history, agentReplyLanguage, isJa() ? 'ja' : 'en', 'chat', true), nativeAndroid && agentShared ? { shared: agentShared } : {}, requestPrivacy || {}));
    if (nativeRunId && nativeConversation && !recovered) { syncCurrentToSaved(); await nativeHistory.flush(); }
    if (dropped() || ctrl.signal.aborted) throw new DOMException('stopped', 'AbortError');
    var res = nativeRunId && nativeConversation ? await nativeConversation.open(requestBody, { id: nativeRunId, sessionId: conversationId, mid: mid, title: agentTitle || text.slice(0, 80), ctrl: ctrl, resume: !!recovered }) : await openAgentChat(AGENT_API, requestBody, ctrl.signal); // Android はネイティブ受信の SSE のまま、ブラウザは WebSocket（読み上げ設計§6.3）
    if (dropped()) return;
    if (!res.ok || !res.body) {
      var raw = await res.text().catch(function () { return ''; });
      if (dropped()) return;
      var env = null; try { env = JSON.parse(raw).error; } catch (_) { }
      if (!env) env = { message: ('HTTP ' + res.status + ' ' + (res.statusText || '')).trim(), code: 'http_' + res.status };
      console.error('[agent] request failed', AGENT_API, res.status, requestPrivacy ? 'privacy_request' : raw.slice(0, 800));
      turn.remove(); renderAgentError(env); errored = true;
    } else {
      await parseSSE(res.body, {
        privacy: agentPrivacyExpected(requestPrivacy), replyLanguage: agentReplyLanguage, magiPanel: true, signal: ctrl.signal, streamWatch, alive: () => !dropped(),
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
        speech: function (d) { if (!dropped()) { var audioMeta = cleanAgentSpeechEvent(d, requestPrivacy && requestPrivacy.conversation_mode); speechSig = audioMeta.speech_sig; speechLang = audioMeta.speech_lang; speechVersion = audioMeta.speech_version; speechMode = audioMeta.speech_mode; } },
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
      else { console.error('[agent] fetch failed', AGENT_API, requestPrivacy ? 'privacy_request' : err); renderAgentError({ message: tr('Could not receive the reply. Check your connection and try again.', '返事を受け取れませんでした。接続を確認して、もう一度お試しください。'), code: 'network_error' }); }
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
    if (retryOf) { agentHistory = sendHistory(); agentRetryEls(retryOf).forEach(function (el) { el.remove(); }); delete userItem.retry_of; }
    agentHistory.push({ role: 'assistant', content: reply, thinkingSeconds: thinking.finish(), ...(closedReply ? { closed: true } : factReply ? { mode: "fact", sources: cleanAgentSources(replySources, reply) } : { debate: debateData }), ...(magiMeta ? { mode: 'magi', magi: magiMeta } : {}), ...(clarifyReply ? { clarify: clarifyReply } : {}), ...(nativeRunId ? { native_request: nativeRunId } : {}), ...(speechSig && !closedReply && !clarifyReply && completed ? { speech_sig: speechSig, ...(speechVersion === 2 ? { speech_version: 2, speech_mode: speechMode } : {}), ...(speechLang ? { speech_lang: speechLang } : {}) } : {}), mid: mid, at: Date.now(), reactions: pendingReactions[mid] || {} });
    delete pendingReactions[mid];
    // 受信復元のattsは保存用サムネイルなので、画像の再送には使わない。
    agentLastSend = !recovered && atts.length ? { mid: mid, atts: atts } : null;
    setupReplyBar(turn, agentHistory[agentHistory.length - 1]);
    syncRetryButtons(); refreshReplyTimes();
    refreshSpeechFeature();
    safeStore('magi_current_history', agentHistory);
    syncCurrentToSaved();
    updateAgentActionButtons();
    setAgentSuggestion(completed && !clarifyReply && !closedReply && !magiMeta?.reason_missing ? suggestion : '');
    if (completed && !errored) agentNotifyWebReply();
  } else {
    turn.remove(); u.remove(); delete pendingReactions[mid];
    if (!retry && nativeHistory && nativeHistory.active && !agentInput.value) atts.forEach(function (a) { if (a.file) nativeHistory.retainImage(a.file); });
    var last = agentHistory[agentHistory.length - 1];
    if (last && last.role === 'user' && last.content === storeContent) agentHistory.pop();
    // ［もう一度］が届かなければ前の往復を見せ直す（質問は入力欄に戻さない）。最後の回答の［もう一度］も出し直す
    agentRetryEls(retryOf).forEach(function (el) { el.hidden = false; });
    syncRetryButtons();
    safeStore('magi_current_history', agentHistory); syncCurrentToSaved(); updateAgentActionButtons();
    // 中断・通信失敗でも、質問と画像を戻して同じ会話で送り直せるようにする。
    if (!retry && !agentInput.value) { agentInput.value = clarifyDraft ? draftText : text; attachments = atts; renderAttachTray(); fitAgentInput(); }
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
  if (agentTemporary()) return null;
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
// 登録の識別子は保存し、通信中のPromiseだけをメモリに持つ。復元した同じ評価からも完了を待てる。
const reactionRegistrations = new Map();
const reactionRemovals = new WeakSet();
function reactionOwner(bar) {
  var turn = bar.closest('.agent-turn');
  return { sessionId: currentSessionId, mid: turn && turn.dataset.mid };
}
function persistOwnedReaction(owner, target, cell, remove) {
  if (!owner.sessionId || !owner.mid) return false;
  var matched = false;
  function same(value) {
    return value && (value === cell || cell.registration_id && value.registration_id === cell.registration_id
      || cell.id && value.id === cell.id && value.delete_token === cell.delete_token);
  }
  function update(item) {
    if (item.role !== 'assistant' || item.mid !== owner.mid || !same(item.reactions && item.reactions[target])) return item;
    matched = true;
    var reactions = item.reactions;
    if (remove) delete reactions[target]; else reactions[target] = cell;
    return Object.assign({}, item, { reactions: reactions });
  }
  if (!agentTemporary() && currentSessionId === owner.sessionId) {
    agentHistory = agentHistory.map(update);
    var pending = pendingReactions[owner.mid];
    if (!matched && pending && same(pending[target])) {
      matched = true;
      if (remove) delete pending[target]; else pending[target] = cell;
    }
    if (matched) persistReactions();
    return matched;
  }
  // 別の会話や一時チャットを開いていても、元の会話だけを更新する。削除済みなら復活させない。
  var sessions = agentStoredSessions().map(function (session) {
    if (session.id !== owner.sessionId) return session;
    var history = session.history.map(update);
    return matched ? Object.assign({}, session, { history: history }) : session;
  });
  if (matched) agentNormalStorage(function () {
    if (typeof nativeHistory !== 'undefined' && nativeHistory && nativeHistory.active) nativeHistory.setSessions(sessions);
    else safeStore('magi_saved_sessions', sessions);
  });
  return matched;
}
function registerReaction(bar, target, em, ctx) {
  const store = reactionStoreFor(bar), owner = reactionOwner(bar);
  const cell = { em, registration_id: genMid() };
  if (store) { store[target] = cell; persistReactions(); }
  const pending = sendReaction(target, em, ctx.request, ctx.response).then(async receipt => {
    if (!receipt) return;
    cell.id = receipt.id; cell.delete_token = receipt.delete_token;
    var saved = false;
    try { saved = persistOwnedReaction(owner, target, cell, false); } catch (_) {}
    if (!saved) await deleteReaction(target, receipt);
    return receipt;
  }).finally(() => reactionRegistrations.delete(cell.registration_id));
  reactionRegistrations.set(cell.registration_id, pending);
}
async function unregisterReaction(bar, target) {
  const store = reactionStoreFor(bar), owner = reactionOwner(bar);
  const receipt = store && store[target];
  if (!receipt) return true;
  if (typeof receipt === 'object') {
    if (reactionRemovals.has(receipt)) return false;
    reactionRemovals.add(receipt);
  }
  try {
    var registered = await reactionRegistrations.get(receipt.registration_id);
    if (registered) { receipt.id = registered.id; receipt.delete_token = registered.delete_token; }
    if (!await deleteReaction(target, receipt)) return false;
    persistOwnedReaction(owner, target, receipt, true);
    if (store[target] === receipt) delete store[target];
    return true;
  } finally { if (typeof receipt === 'object') reactionRemovals.delete(receipt); }
}
function flashReactBtn(btn, sym) {
  var orig = btn.innerHTML; btn.innerHTML = sym;
  setTimeout(function () { btn.innerHTML = orig; }, 1200);
}

// ---- Click delegation -------------------------------------------------------
agentLog.addEventListener('click', function (e) {
  if (e.target.closest('[data-install-agent]')) { showInstallPanel(); return; }
  // スプラッシュの版番号から更新履歴を開く
  if (e.target.closest('#btn-versions-agent')) { e.preventDefault(); showVersionInfoPanel(); return; }
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
  // 評価のメニューから Good / Bad を選ぶ
  var pick = e.target.closest('.rate-pop button');
  if (pick) {
    var bar = pick.closest('.reaction-bar');
    closeRatePops(true);
    rateReply(bar, pick.dataset.rate);
    return;
  }
  var btn = e.target.closest('.react-btn');
  if (!btn) return;
  var bar2 = btn.closest('.reaction-bar');
  var act = btn.getAttribute('data-act');
  if (agentTemporary() && ['rate','react','share'].includes(act)) return;

  if (act === 'rate') { openRatePop(btn, bar2); return; }
  if (act === 'retry') { var retry = agentRetryFor(btn); if (retry) agentSend(null, retry); return; }
  if (act === 'speak' || act === 'share' || act === 'sources') {
    var item = agentItemFor(bar2);
    if (!item) return;
    if (act === 'speak') { if (item.speech_sig) agentSpeech().toggle(btn, item.content, item.speech_sig, item.speech_lang || null, item.speech_version === 2 ? { sig_version: 2, conversation_mode: item.speech_mode } : {}); }
    else if (act === 'share') shareAgentReply(btn, bar2, item);
    else showAgentSourcesSheet(btn, item);
    return;
  }
  if (act === 'copy') {
    var ctx2 = getReactionContext(bar2);
    if (ctx2.response && navigator.clipboard) navigator.clipboard.writeText(ctx2.response).catch(function () { });
    flashReactBtn(btn, '✓');
  }
});
// 評価のメニューは、外を押したら閉じる。Esc でも閉じて評価のボタンへ戻る
document.addEventListener('click', function (e) { if (!e.target.closest('.rate-pop, [data-act="rate"]')) closeRatePops(false); });
agentLog.addEventListener('keydown', function (e) { if (e.key === 'Escape' && agentLog.querySelector('.rate-pop')) { e.preventDefault(); closeRatePops(true); } });
// 画面を離れたら読み上げを止める（バックグラウンドでは鳴らさない）
document.addEventListener('visibilitychange', function () { if (document.hidden) { if (agentSpeechPlayer) agentSpeechPlayer.stop(); } else refreshReplyTimes(); });

// ---- Overlay panels (saved chats / info) -----------------------------------
var AGENT_PANEL_IDS = ['agent-bug-report-panel', 'agent-history-panel', 'agent-versions-panel', 'agent-info-panel', 'agent-about-panel', 'agent-faq-panel', 'agent-terms-panel', 'agent-version-info-panel', 'agent-install-panel', 'agent-settings-panel', 'agent-update-panel','agent-image-panel', 'agent-shared-panel', 'agent-sources-panel'];
// パネルはどの閉じ方（✕・暗幕・Esc・戻る・別のパネル）でもここを通す。後始末は panel.onAgentClose が受け持つ。
function removeAgentPanel(panel) {
  if (!panel.isConnected) return;
  var hadFocus = panel.contains(document.activeElement);
  panel.remove();
  if (panel.onAgentClose) panel.onAgentClose(hadFocus);
}
function closeAgentPanels(keepPageStack) { if (!keepPageStack) agentPageStack = []; AGENT_PANEL_IDS.forEach(function (id) { var p = document.getElementById(id); if (p && !(keepPageStack && agentPageStack.indexOf(p) >= 0)) removeAgentPanel(p); }); }
// 情報画面は親を隠して保持し、画面左上・Esc・Androidの戻るで同じ一段を戻る。
var AGENT_PAGE_IDS = ['agent-bug-report-panel', 'agent-about-panel', 'agent-faq-panel', 'agent-terms-panel', 'agent-info-panel', 'agent-version-info-panel', 'agent-update-panel', 'agent-settings-panel', 'agent-versions-panel'];
var agentPageStack = [];
function prepareAgentPage(id) {
  if (id === 'agent-about-panel' || id === 'agent-settings-panel') { closeAgentPanels(); return; }
  var parent = document.querySelector('.agent-info-page:not([hidden])');
  if (parent) { parent.hidden = true; parent.inert = true; agentPageStack.push(parent); }
  closeAgentPanels(true);
}
function backAgentPage() {
  var panel = document.querySelector('.agent-info-page:not([hidden])');
  if (!panel) return false;
  var returnFocus = panel.agentReturnFocus;
  closeAgentPanels(true);
  var parent = agentPageStack.pop();
  if (parent) { parent.hidden = false; parent.inert = false; }
  var target = returnFocus && returnFocus.isConnected && returnFocus.getClientRects().length ? returnFocus
    : parent ? parent.querySelector('.agent-page-back') : document.getElementById('btn-more-agent');
  if (target) target.focus({ preventScroll: true });
  return true;
}
function agentPageHeader(title) {
  return '<div class="agent-panel-head agent-page-head"><button type="button" class="agent-page-back" aria-label="' + tr('Back', '戻る') + '">'
    + '<svg aria-hidden="true" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m12 8-4 4 4 4m-4-4h9"/></svg></button>'
    + '<h2 class="t agent-page-title">' + title + '</h2><span aria-hidden="true"></span></div>';
}
function bindAgentPage(panel, opener) {
  panel.agentReturnFocus = opener;
  panel.querySelector('.agent-page-back').addEventListener('click', backAgentPage);
  panel.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); backAgentPage(); return; }
    if (event.key !== 'Tab') return;
    // 無効・非表示の項目と、隠して保持している親画面はTabの対象にしない。
    var items = Array.from(panel.querySelectorAll('button, a[href], input, textarea, select, summary, [tabindex]')).filter(function (el) {
      return el.tabIndex >= 0 && !el.disabled && !el.closest('[hidden], [inert]') && el.getClientRects().length;
    });
    var first = items[0], last = items[items.length - 1];
    if (!first) { event.preventDefault(); return; }
    var target = event.shiftKey ? document.activeElement === first && last : document.activeElement === last && first;
    if (target) { event.preventDefault(); target.focus({ preventScroll: true }); }
  });
  panel.querySelector('.agent-page-back').focus({ preventScroll: true });
}

function makeAgentPanel(id, title, bodyHTML) {
  var existing = document.getElementById(id), isPage = AGENT_PAGE_IDS.indexOf(id) >= 0;
  if (existing) {
    if (!isPage) removeAgentPanel(existing);
    else if (!existing.hidden) backAgentPage();
    else { while (existing.hidden && backAgentPage()) {} }
    return null;
  }
  var opener = document.activeElement;
  if (isPage) prepareAgentPage(id); else closeAgentPanels();
  var panel = document.createElement('div');
  panel.id = id; panel.className = 'agent-panel fade-in' + (isPage ? ' agent-info-page' : '');
  panel.innerHTML = (isPage ? agentPageHeader(title) : '<div class="agent-panel-head"><span class="t">' + title + '</span>'
    + '<button type="button" class="agent-panel-close">' + tr('✕ CLOSE', '✕ 閉じる') + '</button></div>')
    + '<div class="agent-panel-body">' + bodyHTML + '</div>';
  document.getElementById('app').appendChild(panel);
  if (isPage) bindAgentPage(panel, opener);
  else panel.querySelector('.agent-panel-close').addEventListener('click', function () { removeAgentPanel(panel); });
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
    // 新しい会話は四角とペン（画像の追加の「＋」と見分ける。トップページと同じ形）
    + '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.4 2.6a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>'
    + '<span>' + tr('New chat', '新しいチャット') + '</span></button><div class="drawer-label">' + tr('Chats', 'チャット') + '</div><div id="agent-history-list"></div>'
    + '</div>';
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
  agentEndTemporary();
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
  if (agentTemporary()) return agentDeleteSavedDuringTemporary(id);
  agentInvalidateSuspended(id);
  if (currentSessionId === id) resetAgent();
  agentNormalStorage(function () { writeSavedSessions(readSavedSessions().filter(function (s) { return s.id !== id; })); });
  if (nativeConversation) nativeConversation.clear(id).catch(function () { announceAgent(tr('Could not remove pending reply data.', '受信データを削除できませんでした。')); });
  renderSavedSessionsList();
}
// AGENT_PRIVACY_BEGIN
// 未対応・未知の機能の段落は表示しない。APIの文章はHTMLとして解釈しない。
// data が undefined のときは取得中。null や形の違う応答は取得の失敗として案内を出す。
var AGENT_PRIVACY_FEATURES = ['classification_state', 'magi_panel', 'site_pages', 'close_on_malice', 'fact_mode', 'clarify', 'speech', 'temporary_chat', 'personalization'];
function renderAgentPrivacy(list, lang, data, nativeRows = []) {
  if (!list || !list.isConnected) return;
  var fallback = lang === 'ja'
    ? '入力は回答のため、外部のAIのAPIに送られます。送り先の最新の説明を取得できませんでした。接続を確かめて開き直してください。最新の説明は https://tk.st/ のMAGIのFAQにもあります。'
    : 'Inputs are sent to external AI APIs to answer you. Could not load the latest description of the recipients. Check your connection and reopen this panel. The latest description is also in the MAGI FAQ at https://tk.st/.';
  var rows = data && data.privacy && data.privacy[lang];
  rows = Array.isArray(rows) ? rows.filter(function (row) {
    return row && !(row.id === 'history' && nativeRows.length) && typeof row.text === 'string' && row.text.trim() && (row.requires === undefined
      || Array.isArray(row.requires) && row.requires.every(function (name) { return typeof name === 'string' && AGENT_PRIVACY_FEATURES.indexOf(name) >= 0; }));
  }) : [];
  list.replaceChildren();
  (data === undefined ? [{ text: lang === 'ja' ? '読み込み中…' : 'Loading…' }] : rows.length ? rows : [{ text: fallback }]).concat(nativeRows).forEach(function (row) {
    var li = document.createElement('li');
    if (typeof row.title === 'string' && row.title.trim()) {
      var title = document.createElement('strong'); title.textContent = row.title; li.appendChild(title);
      var text = document.createElement('span'); text.textContent = row.text; li.appendChild(text);
    } else li.textContent = row.text;
    list.appendChild(li);
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
  var list = panel.querySelector('.agent-versions-list');
  renderAgentVersions(list, lang, agentVersionsCache || undefined);
  loadAgentVersions().then(function (data) { if (panel.isConnected) renderAgentVersions(list, panel.dataset.lang, data); });
}
function showVersionsPanel() {
  var panel = makeAgentPanel('agent-versions-panel', '', '<div class="agent-versions-list"></div>');
  if (!panel) return;
  var title = panel.querySelector('.agent-page-title');
  title.classList.add('agent-versions-title');
  fillAgentVersionsPanel(panel, document.documentElement.lang === 'ja' ? 'ja' : 'en');
}
// AGENT_VERSIONS_END


// アプリ情報の導線。本文は文字で描き、Workerのプライバシー説明は従来どおり取得する。
function aboutBody(html) {
  return '<div class="agent-about-content">' + html + '</div>';
}
function showAboutPanel() {
  var panel = makeAgentPanel('agent-about-panel', tr('About MAGI', 'MAGIについて'), aboutBody(
    '<p class="agent-about-version">MAGI / ver ' + APP_VERSION + '</p><div class="agent-about-links">'
    + [['faq', 'FAQ', 'FAQ'], ['terms', 'Terms of Use', '利用規約'], ['privacy', 'Privacy Policy', 'プライバシーポリシー'], ['version', 'Version information', 'バージョン情報']].map(function (item) {
      return '<button type="button" data-about="' + item[0] + '"><span>' + tr(item[1], item[2]) + '</span><span aria-hidden="true">›</span></button>';
    }).join('') + '</div>'));
  if (!panel) return;
  var actions = { faq: showFAQPanel, terms: showTermsPanel, privacy: showInfoPanel, version: showVersionInfoPanel };
  panel.querySelectorAll('[data-about]').forEach(function (button) {
    button.addEventListener('click', actions[button.dataset.about]);
  });
  panel.querySelector('[data-about]').focus();
}
function showFAQPanel() {
  var rows = [
    [tr('What is MAGI?', 'MAGIとは？'), tr('An experimental parody inspired by Evangelion’s MAGI. Three personas draw on Shinya Takeda’s personality and tk.st to discuss questions and produce a final answer.', '「新世紀エヴァンゲリオン」のMAGIに着想を得た実験的なパロディです。武田伸也の人格とtk.stをもとにした3人格が討議し、回答をまとめます。')],
    [tr('Does every question start a debate?', 'どの質問でも討議する？'), tr('Factual questions and site guidance can be answered without debate. Eligible yes/no questions trigger a vote; add “without taking a vote” for an explanation only.', '事実の質問やサイト内の案内は、討議せず答えることがあります。賛否を問う質問では採決します。説明だけがほしいときは「採決なしで」と添えてください。')],
    [tr('What are the limits?', '利用上限は？'), tr('Up to 1,000 characters and four images per message, and 60 requests a day. Replies use the last 12 messages (about six exchanges). Additional search and voice limits are described in the Privacy Policy.', '入力は1回1,000文字・画像4枚まで、1日60回までです。回答には直近12メッセージ（約6往復）を使います。検索や読み上げの追加上限はプライバシーポリシーで確認できます。')],
    [tr('How do I save a conversation?', '会話を残すには？'), tr('Use “Save as Markdown” in the more menu. History is stored on your device; keep a separate copy of important chats.', '︙の「Markdownで保存」から書き出せます。履歴は端末に保存されるため、重要な会話は別途控えを残してください。')],
    [tr('Can I trust the answers?', '回答は正しい？'), tr('AI can make mistakes, even when the answer sounds confident. Check sources and dates for important information. If your question is about a particular place or time, include those details.', 'AIは断定的に答えていても間違えることがあります。重要な情報は出典と日時を確認してください。特定の場所や時期について聞くときは、その条件も書くと伝わりやすくなります。')],
    [tr('What if a reply stops or never arrives?', '回答が止まった・届かないときは？'), tr('Check your connection and wait briefly. Use the stop button if needed, then try again. On Android, replies can continue arriving in the background; on the Web or PWA, return to the screen to check progress. Keep a copy of a long question before reopening the app.', '接続を確認し、少し待ってください。必要なら停止ボタンで止めてから、もう一度試してください。Androidは別のアプリを使っている間も受信を続けます。Web・PWAは画面に戻って進み具合を確認してください。開き直す場合は、長い質問を控えておくと安心です。')],
    [tr('Can I use MAGI offline?', 'オフラインでも使える？'), tr('You need an internet connection to send a question and receive an answer. Previously saved conversations may still be available on the same device.', '質問の送信と回答の受信にはインターネット接続が必要です。同じ端末に保存済みの会話は、オフラインでも確認できる場合があります。')],
    [tr('Does history transfer to another device?', '別の端末でも履歴を使える？'), tr('History is saved on the device and does not sync automatically. Uninstalling the app or clearing browser data can erase it. Export important conversations before changing devices. Web, PWA and Android can export all saved chats from App management; exports do not include images or temporary chats.', '履歴は端末ごとに保存され、自動同期されません。アプリの削除やブラウザのデータ消去で失われることがあります。機種変更の前に大切な会話を書き出してください。Web・PWA・Androidの「アプリ管理」から保存された全会話を書き出せます。画像と一時チャットは含みません。')],
    [tr('What does Location services do?', '位置情報サービスは何に使う？'), tr('Android can use your device location when you send a message, with permission. Web and PWA use a city or region estimated from your connection. The location may be inaccurate, so specify a place when needed. Use App management to turn location use off. Web/PWA can also disable IP-based estimates there; changes apply to your next message.', 'Androidは許可を得て、送信時にGPSを優先して端末の現在地を使います。Web・PWAは通信元から推定した市・地域を使います。場所がずれることもあるので、必要なら地名を指定してください。Androidは「アプリ管理」で両方をオフにできます。Web・PWAも同じ画面でIP推定の利用を切り替えられ、次の送信から反映します。')],
    [tr('How do I turn notifications on or off?', '通知をオン・オフにするには？'), tr('On Android, open App management in the more menu and use the Notifications toggle. Android may also ask for permission. Turning alerts off does not stop receiving replies. The ongoing background task indicator is managed by Android. Web/PWA also offer a notification toggle for replies received while the page stays open in the background, subject to browser support and permission.', 'Androidは︙の「アプリ管理」にある「通知」で切り替えます。Android側の許可が必要な場合もあります。通知をオフにしても回答の受信は続きます。バックグラウンド受信中の表示はAndroidが管理します。Web・PWAも対応ブラウザでは通知を切り替えられますが、画面を開いて受信している間に限ります。')],
    [tr('How do I report a problem?', '不具合を見つけたら？'), tr('Choose Report a bug in the more menu and describe what you did, what happened and what you expected, in up to 2,000 characters. You can attach up to three PNG, JPEG or WebP images (5 MB each, 10 MB total). Do not include passwords or other sensitive information.', '︙の「バグを報告」から、行った操作・起きたこと・期待していた動作を2000文字以内で教えてください。PNG・JPEG・WebPの画像を3枚まで（1枚5MB・合計10MB）添付できます。パスワードなどの機密情報は入力しないでください。')],
    [tr('Where can I check for updates?', '更新はどこで確認する？'), tr('Open “Version information” under “About MAGI”. Android checks for app updates there; the Web and PWA versions show the current version and release history.', '「MAGIについて」の「バージョン情報」を開いてください。Androidではアプリの更新を確認でき、Web・PWAでは現在の版と更新履歴を確認できます。')]
  ];
  var panel = makeAgentPanel('agent-faq-panel', 'FAQ', aboutBody(rows.map(function (row) {
    return '<details><summary>' + row[0] + '</summary><p>' + row[1] + '</p></details>';
  }).join('')));
}
function showTermsPanel() {
  var panel = makeAgentPanel('agent-terms-panel', tr('Terms of Use', '利用規約'), aboutBody(
    '<p>' + tr('MAGI is an experimental parody operated by Shinya Takeda on tk.st. It is not intended for practical work.', 'MAGIは武田伸也がtk.stで運営する実験的なパロディです。実務での利用は想定していません。') + '</p>'
    + '<p>' + tr('AI answers may contain errors. Check important information yourself before using it.', 'AIの回答には誤りが含まれることがあります。重要な情報は、ご自身で確かめてから利用してください。') + '</p>'
    + '<p>' + tr('Do not enter confidential or personal information. Do not use the service for illegal activity, infringement of others’ rights, discrimination or violence.', '機密情報や個人情報を入力しないでください。違法行為、他者の権利の侵害、差別や暴力を助長する目的で利用しないでください。') + '</p>'
    + '<p>' + tr('Usage limits and reply restrictions apply. See the FAQ for usage and the Privacy Policy for recipients and data handling.', '利用回数や回答内容に制限があります。使い方はFAQ、入力の送信先やデータの扱いはプライバシーポリシーをご確認ください。') + '</p>'));
}
function showVersionInfoPanel() {
  if (nativeAndroid) { showAppUpdatePanel(); return; }
  var panel = makeAgentPanel('agent-version-info-panel', tr('Version information', 'バージョン情報'), aboutBody(
    '<p>MAGI / ver ' + APP_VERSION + '</p><p>' + tr('The Web and PWA versions fetch updates automatically. If a new version does not appear, finish your conversation and reopen the page or app. Updates may take time to appear.', 'Web・PWA版は自動で更新を取得します。新しい版が表示されない場合は、会話を終えてからページやアプリを開き直してください。反映に時間がかかることがあります。') + '</p><button type="button" class="agent-open-versions">' + tr('Release History', '更新履歴') + '</button>'));
  if (!panel) return;
  panel.querySelector('.agent-open-versions').addEventListener('click', showVersionsPanel);
}

function showInfoPanel() {
  var panel = makeAgentPanel('agent-info-panel', tr('Privacy Policy', 'プライバシーポリシー'), '<ul class="agent-privacy-list"></ul>');
  if (!panel) return;
  var list = panel.querySelector('.agent-privacy-list'), lang = isJa() ? 'ja' : 'en';
  var nativeRows = nativeAndroid ? [
    { title: tr("Android storage", "Androidの保存"), text: tr("Conversations and original images stay in this app. Automatic backup is disabled; history does not transfer to a new device. Export a copy without images from App management.", "会話と元の画像はアプリ内に保存します。自動バックアップは無効で、機種変更では引き継がれません。「アプリ管理」から画像を除く控えを書き出せます。") },
    { title: tr("URLs and voice input", "URLと音声入力"), text: tr("Your device fetches shared URLs without cookies. Voice input uses the device’s recognition service (often Google), which may receive audio if on-device recognition is unavailable. Audio is not sent to MAGI servers.", "共有URLは端末がCookieなしで読み込みます。音声入力は端末の認識サービス（多くはGoogle）を使い、端末内で認識できない場合は音声をそのサービスへ送ることがあります。音声はMAGIのサーバーに送りません。") },
    { title: tr("Replies and notifications", "受信と通知"), text: tr("Replies continue arriving while you use another app or turn off the display, and stay on your device until saved to the chat. If allowed, notifications show the chat title. Stop a request from its ongoing notification.", "別のアプリの使用中や画面消灯中も回答を受信し、会話へ保存するまで端末に残します。許可した通知には会話のタイトルが出ます。進行中の通知から送信を止められます。") },
    { title: tr("Widgets", "ウィジェット"), text: tr("Home widgets open MAGI. They show no chat contents and make no network requests themselves.", "ホーム画面からMAGIを開く入口です。会話の内容は表示せず、ウィジェット自体は通信しません。") }
  ] : [];
  renderAgentPrivacy(list, lang, undefined, nativeRows);
  loadAgentModels().then(function (data) { renderAgentPrivacy(list, lang, data, nativeRows); });
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

// Androidは送信時だけ測位する。オフなら端末・IPのどちらも検索に使わない。
async function locationForMessage(signal, turn) {
  if (!nativeAndroid || !locationServiceEnabled() || !window.MagiNativeLocation) return null;
  var value = await window.MagiNativeLocation.current(signal);
  if (signal.aborted || !locationServiceEnabled()) return null;
  if (!value) {
    var notice = tr('Device location unavailable. Searches will use the city and region estimated from your IP address.', '端末の現在地を取得できなかったため、検索にはIPアドレスから推定した市・地域を使います。');
    if (turn) {
      var note = document.createElement('p'); note.className = 'agent-location-notice'; note.textContent = notice;
      turn.appendChild(note);
    }
    announceAgent(notice);
  }
  return value;
}
// 共通のアプリ管理にAndroid専用の設定と履歴操作を追加する。
async function initNativeSettings(panel) {
  if (!nativeAndroid) return;
  var ja = isJa();
  panel.querySelector('#agent-native-settings').innerHTML =
    '<p id="history-storage-status" role="status">' + (ja ? '読み込み中…' : 'Loading…') + '</p>'
    + '<div class="agent-setting"><span id="native-location-label">' + tr('Location services', '位置情報サービス') + '</span><button type="button" role="switch" id="native-location-toggle" aria-labelledby="native-location-label" aria-describedby="native-location-note" aria-checked="false"><span></span></button></div>'
    + '<p id="native-location-note">' + tr('Get your device location, preferring GPS, when sending a message. Android permission is required. Coordinates and city/region go to MAGI and the search provider for location-based searches. If unavailable, use your IP-estimated city/region and show a notice. Turning this off disables both. Changes apply to your next message.', '送信時にGPSを優先して端末の現在地を取得します。Androidの許可が必要です。場所に応じた検索のため、座標と市・地域をMAGIと検索する会社へ送ります。取得できなければIP由来の市・地域を使い、その旨を表示します。オフでは両方を使いません。変更は次の送信から反映します。') + '</p><p id="native-location-status" role="status"></p>'
    + '<div class="agent-setting" id="native-notification-setting" hidden><span id="native-notification-label">' + tr('Notifications', '通知') + '</span><button type="button" role="switch" id="native-notification-toggle" aria-labelledby="native-notification-label" aria-describedby="native-notification-status" aria-checked="false" disabled><span></span></button></div><p id="native-notification-status" hidden></p>'
    + '<div id="native-widget-settings" hidden>'
    + '<p>' + (ja ? 'ホーム画面のウィジェット一覧から「MAGI に聞く」を追加できます。チャット・カメラ・アルバム・音声入力をすぐ開けます。' : 'Add “Ask MAGI” from your home screen’s widget picker to open chat, the camera, your album or voice input.') + '</p>'
    + '<button type="button" id="widget-pin" hidden>' + (ja ? 'ホーム画面に追加' : 'Add to home screen') + '</button><p id="widget-status" role="status"></p></div>'
    + '<p>' + (ja ? '履歴はこの端末内に保存します。機種変更では引き継がれません。書き出しには画像を含めません。' : 'History stays on this device and does not transfer automatically to a new device. Exports include text only, without images.') + '</p>'
    + '<div class="native-settings-actions"><button type="button" id="history-export">' + (ja ? '全会話を書き出す' : 'Export all chats') + '</button>'
    + '<button type="button" id="history-clear">' + (ja ? '全会話を削除' : 'Delete all chats') + '</button></div>';
  initNativeWidgetSettings(panel, ja);
  var locationToggle = panel.querySelector('#native-location-toggle');
  locationToggle.setAttribute('aria-checked', String(locationServiceEnabled()));
  locationToggle.addEventListener('click', async function () {
    try {
      localStorage.setItem('magi_location_enabled', locationServiceEnabled() ? '0' : '1');
      locationToggle.setAttribute('aria-checked', String(locationServiceEnabled()));
      panel.querySelector('#native-location-status').textContent = '';
      if (window.MagiNativeLocation) {
        if (!locationServiceEnabled()) { await window.MagiNativeLocation.cancel(); return; }
        locationToggle.disabled = true;
        try {
          var permission = await window.MagiNativeLocation.permission(true);
          if (panel.isConnected) panel.querySelector('#native-location-status').textContent = permission.precision === 'precise'
            ? tr('Precise location is allowed.', '正確な位置情報の利用が許可されています。') : permission.precision === 'approximate'
            ? tr('Android allows approximate location only.', 'Androidでおおよその位置情報のみ許可されています。')
            : tr('Location permission is unavailable. Searches will use your IP-estimated city and region.', '位置情報が許可されていないため、検索にはIP由来の市・地域を使います。');
        } catch (_) {
          if (panel.isConnected) panel.querySelector('#native-location-status').textContent = tr('Could not check location permission. Searches will use your IP-estimated city and region.', '位置情報の許可を確認できなかったため、検索にはIP由来の市・地域を使います。');
        } finally { locationToggle.disabled = false; }
      }
    } catch (_) { announceAgent(tr('Could not save this setting.', '設定を保存できませんでした。')); }
  });
  if (nativeConversation) {
    var notifications = panel.querySelector('#native-notification-status'); notifications.hidden = false;
    panel.querySelector('#native-notification-setting').hidden = false;
    var notificationToggle = panel.querySelector('#native-notification-toggle');
    async function refreshNotifications() {
      try {
        var value = await nativeConversation.notificationState();
        if (!panel.isConnected) return;
        notificationToggle.setAttribute('aria-checked', String(value.enabled));
        notificationToggle.disabled = false;
        notifications.textContent = tr('Reply arrival alerts. Android may require permission. The ongoing background task notification is managed by Android.', '回答の到着を通知します。Androidの許可が必要な場合があります。バックグラウンド受信中の表示はAndroidが管理します。');
      } catch (_) { notificationToggle.disabled = true; notifications.textContent = tr('Could not check notifications.', '通知の状態を確認できませんでした。'); }
    }
    notificationToggle.addEventListener('click', async function () {
      notificationToggle.disabled = true;
      try { await nativeConversation.setNotifications(notificationToggle.getAttribute('aria-checked') !== 'true'); }
      catch (_) { announceAgent(tr('Could not change notification settings.', '通知の設定を変更できませんでした。')); }
      await refreshNotifications();
    });
    function onVisible() {
      if (!document.hidden) refreshNotifications();
    }
    panel.onAgentClose = function () {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    refreshNotifications();
  }
  var status = panel.querySelector('#history-storage-status');
  var buttons = panel.querySelectorAll('.native-settings-actions button');
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
      agentInvalidateSuspended(null);
      await nativeHistory.clear();
      if (!agentTemporary()) resetAgent();
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
  if (agentTemporary()) return "";
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
// BUG_REPORT_BEGIN
function showBugReportPanel() {
  var panel = makeAgentPanel('agent-bug-report-panel', tr('Report a bug', 'バグを報告'),
    '<form id="agent-bug-form"><label for="agent-bug-message">' + tr('What problem did you experience?', 'どのような問題が発生しましたか？') + '</label>'
    + '<textarea id="agent-bug-message" rows="7" maxlength="4000" required aria-describedby="agent-bug-count agent-bug-note"></textarea>'
    + '<p id="agent-bug-count">0 / 2000</p>'
    + '<button type="button" id="agent-bug-attach">' + tr('Attach images', '画像を添付') + '</button>'
    + '<input id="agent-bug-files" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden>'
    + '<p id="agent-bug-limits">' + tr('PNG, JPEG or WebP. Up to 3 images, 5 MB each, 10 MB total.', 'PNG・JPEG・WebP、3枚まで。1枚5MB・合計10MB以内。') + '</p>'
    + '<ul id="agent-bug-images" aria-label="' + tr('Attached images', '添付画像') + '"></ul>'
    + '<p id="agent-bug-note">' + tr('Do not include passwords or other sensitive information.', 'パスワードなどの機密情報は入力しないでください。') + '</p>'
    + '<button type="submit" disabled>' + tr('Send', '送信') + '</button><p id="agent-bug-status" role="status"></p></form>');
  if (!panel) return;
  var form = panel.querySelector('form'), input = panel.querySelector('textarea');
  var count = panel.querySelector('#agent-bug-count'), status = panel.querySelector('#agent-bug-status');
  var button = form.querySelector('[type="submit"]'), picker = panel.querySelector('#agent-bug-files');
  var attach = panel.querySelector('#agent-bug-attach'), list = panel.querySelector('#agent-bug-images');
  var pending = false, reading = false, closed = false, images = [], candidateImages = [], reader = null, request = null, retryId = null;
  function update(event) {
    if (!event || !event.isComposing) input.value = Array.from(input.value).slice(0, 2000).join('');
    if (event) retryId = null;
    var length = Array.from(input.value).length;
    count.textContent = length + ' / 2000';
    button.disabled = pending || reading || !input.value.trim() || length > 2000;
    attach.disabled = pending || reading || images.length >= 3;
    picker.disabled = pending || reading;
    input.readOnly = pending;
    list.querySelectorAll('button').forEach(function (b) { b.disabled = pending || reading; });
  }
  function renderImages() {
    list.replaceChildren();
    images.forEach(function (item) {
      var row = document.createElement('li'), preview = document.createElement('img');
      preview.src = item.url; preview.alt = tr('Attached image: ', '添付画像: ') + item.file.name; preview.title = item.file.name;
      var remove = document.createElement('button'); remove.type = 'button';
      remove.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>';
      remove.setAttribute('aria-label', tr('Remove image: ', '画像を削除: ') + item.file.name); remove.title = tr('Remove image', '画像を削除');
      remove.addEventListener('click', function () {
        if (pending || reading) return;
        images = images.filter(function (value) { return value !== item; });
        URL.revokeObjectURL(item.url); retryId = null; renderImages(); update(); attach.focus();
      });
      row.append(preview, remove); list.appendChild(row);
    });
  }
  var oldClose = panel.onAgentClose;
  panel.onAgentClose = function (hadFocus) {
    closed = true;
    if (reader && reader.readyState === 1) reader.abort();
    if (request) request.abort();
    images.concat(candidateImages).forEach(function (item) { URL.revokeObjectURL(item.url); }); images = []; candidateImages = [];
    if (oldClose) oldClose(hadFocus);
  };
  attach.addEventListener('click', function () { picker.click(); });
  picker.addEventListener('change', async function () {
    if (pending || reading || closed) return;
    var files = Array.from(picker.files || []); picker.value = '';
    if (!files.length) return;
    var candidates = candidateImages = [], size = images.reduce(function (sum, item) { return sum + item.file.size; }, 0);
    reading = true; update(); status.textContent = tr('Loading images…', '画像を読み込み中…');
    try {
      if (images.length + files.length > 3) throw new Error('limits');
      for (var file of files) {
        size += file.size;
        if (!file.size || file.size > 5 * 1048576 || size > 10 * 1048576) throw new Error('limits');
        var head = Array.from(new Uint8Array(await file.slice(0, 12).arrayBuffer())).map(function (v) { return String.fromCharCode(v); }).join('');
        if (closed) return;
        var type = head.startsWith('\x89PNG\r\n\x1a\n') ? 'image/png' : head.startsWith('\xff\xd8\xff') ? 'image/jpeg'
          : head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP' ? 'image/webp' : null;
        if (!type || (file.type && file.type !== type)) throw new Error('format');
        var item = { file: file, type: type, url: URL.createObjectURL(file) }; candidates.push(item);
        var preview = new Image(); preview.src = item.url; await preview.decode();
        if (closed) return;
      }
      images = images.concat(candidates); candidates = []; candidateImages = []; retryId = null;
      renderImages(); status.textContent = '';
    } catch (_) {
      if (!closed) status.textContent = tr('Could not attach images. Choose readable PNG, JPEG or WebP files within the limits.', '画像を添付できませんでした。上限内の読み込めるPNG・JPEG・WebPを選んでください。');
    } finally {
      candidates.forEach(function (item) { URL.revokeObjectURL(item.url); });
      candidateImages = []; reading = false; if (!closed) update();
    }
  });
  input.addEventListener('input', update);
  input.addEventListener('compositionend', update);
  function readImage(item) {
    return new Promise(function (resolve, reject) {
      reader = new FileReader();
      reader.onload = function () { resolve({ type: item.type, content: String(reader.result).split(',')[1] }); };
      reader.onerror = reader.onabort = function () { reject(new Error('read_failed')); };
      reader.readAsDataURL(item.file);
    });
  }
  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (pending || reading || closed || !input.value.trim() || Array.from(input.value).length > 2000) return;
    pending = true; update(); status.textContent = tr('Sending…', '送信中…');
    var timer;
    try {
      if (!retryId) retryId = crypto.randomUUID();
      var payload = { message: input.value, report_id: retryId };
      if (images.length) {
        payload.images = [];
        for (var item of images) { payload.images.push(await readImage(item)); if (closed) return; }
      }
      request = new AbortController(); timer = setTimeout(function () { request.abort(); }, 30000);
      var response = await fetch(AGENT_API.replace(/\/chat$/, '/bug-report'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: request.signal
      });
      var result = await response.json();
      if (closed) return;
      if (!response.ok || result.ok !== true || (images.length && result.images !== images.length)) {
        status.textContent = response.status === 429 ? tr('Too many reports. Please try again later.', '送信の上限に達しました。時間を置いてお試しください。')
          : tr('Could not send. Your text and images are kept; please try again later.', '送信できませんでした。本文と画像は残っています。時間を置いて再試行してください。');
        return;
      }
      input.value = ''; retryId = null;
      images.forEach(function (item) { URL.revokeObjectURL(item.url); }); images = []; renderImages();
      status.textContent = tr('Thank you. Your report has been sent.', '報告を送信しました。ありがとうございます。');
    } catch (_) { if (!closed) status.textContent = tr('Could not send. Your text and images are kept; check your connection and try again.', '送信できませんでした。本文と画像は残っています。接続を確認して再試行してください。'); }
    finally { clearTimeout(timer); request = null; pending = false; if (!closed) update(); }
  });
  input.focus();
}
// BUG_REPORT_END

document.getElementById('btn-bug-report-agent').addEventListener('click', showBugReportPanel);
document.getElementById('btn-about-agent').addEventListener('click', showAboutPanel);
var installBtn = document.getElementById('btn-install-agent');
installBtn.hidden = !WEB_INSTALL;
installBtn.addEventListener('click', showInstallPanel);

document.getElementById('btn-theme').addEventListener('click', function () {
  var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  window.MagiTheme.choose(next);
});
// メニューの項目は、押すと切り替わる先のテーマを書く
function syncThemeLabel() {
  document.getElementById('btn-theme-label').textContent = document.documentElement.getAttribute('data-theme') === 'dark' ? tr('Switch to light mode', 'ライトモードに切替') : tr('Switch to dark mode', 'ダークモードに切替');
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
  langLabel.textContent = ja ? 'Englishに切替' : 'Switch to Japanese'; langLabel.lang = ja ? 'ja' : 'en';
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
    closeAgentPanels(); closeAttachMenu(); closeRatePops(false);
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
// ネイティブだけが公開Releaseを確認する。自動は1日1回、「MAGIについて」の「バージョン情報」は押すたび。遅延・失敗は会話に影響させない。
function releaseVersion(tag) {
  var match = typeof tag === 'string' && /^v(\d{1,2})\.(\d)([1-9])?$/.exec(tag);
  return match ? [Number(match[1]), match[2] + (match[3] || '')] : null;
}
function releaseCode(parts) { return parts[0] * 100 + Number(parts[1].padEnd(2, '0')); }
function newerRelease(parts, current) {
  var installed = typeof current === 'string' ? releaseVersion('v' + current) : null;
  return !!parts && !!installed && releaseCode(parts) > releaseCode(installed);
}
function updateStore(key, value) { try { localStorage.setItem(key, value); } catch (_) {} }
// 公開中の最新Releaseを5秒で諦めて取る。APKの添付にGitHubが記録したSHA-256があれば返し、ネイティブはそれと照合してから入れる。
async function fetchLatestRelease() {
  var controller = new AbortController(), timer;
  try {
    var data = await Promise.race([
      fetch('https://api.github.com/repos/tk33r1/st/releases/latest', { signal: controller.signal, headers: { Accept: 'application/vnd.github+json' } })
        .then(function (res) { if (!res.ok) throw new Error('release unavailable'); return res.json(); }),
      new Promise(function (_, reject) { timer = setTimeout(function () { controller.abort(); reject(new Error('release timeout')); }, 5000); })
    ]);
    var parts = releaseVersion(data && data.tag_name);
    if (!parts || data.draft || data.prerelease) return null;
    var apk = (Array.isArray(data.assets) ? data.assets : []).filter(function (a) { return a && a.name === 'magi-android.apk'; })[0];
    var digest = apk && typeof apk.digest === 'string' && /^sha256:([0-9a-f]{64})$/.exec(apk.digest);
    return { version: parts.join('.'), newer: newerRelease(parts, APP_VERSION), sha256: digest ? digest[1] : '' };
  } finally { clearTimeout(timer); }
}
async function checkAppUpdate() {
  try {
    if (!window.Capacitor || !window.Capacitor.isNativePlatform()) return;
    var now = Date.now(), last = Number(safeGet('magi_update_checked'));
    if (last > 0 && now >= last && now - last < 86400000) return;
    updateStore('magi_update_checked', String(now));
    var release = await fetchLatestRelease();
    if (!release || !release.newer) return;
    var version = release.version;
    if (safeGet('magi_update_dismissed') === version) return;
    var banner = document.getElementById('app-update');
    if (!banner) return;
    banner.dataset.version = version;
    labelAppUpdate(banner);
    var close = banner.querySelector('button');
    close.onclick = function () { banner.hidden = true; updateStore('magi_update_dismissed', version); };
    // アプリ内で入れられる版は、ブラウザへ出さずに同じパネルを開く。
    banner.querySelector('a').onclick = function (event) {
      if (!window.Capacitor.Plugins || !window.Capacitor.Plugins.MagiUpdate) return;
      event.preventDefault(); showAppUpdatePanel();
    };
    banner.hidden = false;
  } catch (_) { /* 機内モード・保存不可・壊れた応答でも起動を続ける */ }
}
// 「MAGIについて」の「バージョン情報」。新しい版はネイティブがAPKを落とし、SHA-256・署名・versionCodeを照合してからAndroidのインストーラーを開く。
// 照合用のSHA-256が無い・プラグインが無いときは、ダウンロードページへの案内だけにする。
function showAppUpdatePanel() {
  var plugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.MagiUpdate;
  var panel = makeAgentPanel('agent-update-panel', tr('Version information', 'バージョン情報'),
    '<p>' + tr('Installed: ', 'このアプリ: ') + 'ver ' + APP_VERSION + '</p><p id="app-update-status" role="status"></p>'
    + '<div class="native-settings-actions"><button type="button" id="app-update-action" hidden></button>'
    + '<a id="app-update-page" href="https://tk.st/magi-app/android/" target="_blank" rel="noopener noreferrer" hidden>' + tr('Open the download page', 'ダウンロードページを開く') + '</a></div>');
  if (!panel) return;
  var historyButton = document.createElement('button');
  historyButton.type = 'button'; historyButton.className = 'agent-open-versions';
  historyButton.textContent = tr('Release History', '更新履歴');
  historyButton.addEventListener('click', showVersionsPanel);
  panel.querySelector('.agent-panel-body').appendChild(historyButton);
  var status = panel.querySelector('#app-update-status'), action = panel.querySelector('#app-update-action'), page = panel.querySelector('#app-update-page');
  var release = null;
  function show(text, button, onclick, fallback) {
    status.textContent = text;
    action.hidden = !button; action.disabled = false; action.textContent = button || ''; action.onclick = onclick || null;
    page.hidden = !fallback;
  }
  function showInstallPermissionHelp(profile) {
    show(profile
      ? tr('This copy of MAGI cannot install updates from this profile. Open MAGI in your main profile and update it there. You can also download the APK in your main profile from the link below. Your chats stay in each profile.', 'このプロファイルではアプリ内から更新できません。通常側のMAGIを開いて更新するか、通常側で下のリンクからAPKを入手してください。会話はそれぞれのプロファイルに残ります。')
      : tr('Install permission was not granted to this copy of MAGI. If it already looks allowed, you may be viewing settings for another profile. Update from MAGI or the download page in your main profile. This screen will not reopen permission settings automatically.', 'このMAGIにはインストールの許可が反映されていません。許可済みに見える場合は、別のプロファイルの設定を開いている可能性があります。通常側のMAGI、またはダウンロードページから更新してください。許可画面へは自動で戻りません。'), '', null, true);
  }
  async function check() {
    show(tr('Checking…', '確認しています…'));
    try { release = await fetchLatestRelease(); } catch (_) { release = null; }
    if (!panel.isConnected) return;
    if (!release) return show(tr('Could not check for updates. Check your connection and try again.', 'アップデートを確認できませんでした。通信を確かめて、もう一度お試しください。'), tr('Try again', '再試行'), check);
    if (!release.newer) return show(tr('You have the latest version.', '最新のバージョンです。'));
    var found = tr('Version ' + release.version + ' is available.', '新しいバージョン（' + release.version + '）があります。');
    if (!plugin || !release.sha256) return show(found + tr(' Get it from the download page.', 'ダウンロードページから入手してください。'), '', null, true);
    // 旧APKのプラグインにはinformationが無い。取得失敗でも従来の更新操作は残す。
    if (typeof plugin.information === 'function') {
      try {
        var info = await plugin.information();
        if (!panel.isConnected) return;
        if (info.needsMainProfile) return showInstallPermissionHelp(true);
      } catch (_) { if (!panel.isConnected) return; }
    }
    show(found, tr('Update', 'アップデート'), install);
  }
  async function install() {
    // 入れ替えるとアプリが終了するので、回答の受信中は始めない。
    if (agentBusy) return show(tr('Update after the reply finishes.', '回答が終わってからアップデートしてください。'), tr('Update', 'アップデート'), install);
    action.disabled = true;
    status.textContent = tr('Downloading…', 'ダウンロードしています…');
    var listener = await plugin.addListener('progress', function (event) {
      if (!panel.isConnected) return;
      status.textContent = event.phase === 'permission'
        ? tr('Turn on “Allow from this source” for MAGI, then go back.', 'MAGIの「この提供元のアプリを許可」をオンにして、戻ってください。')
        : tr('Downloading… ', 'ダウンロードしています… ') + (event.total > 0 ? Math.min(100, Math.floor(event.received * 100 / event.total)) + '%' : (event.received / 1048576).toFixed(1) + ' MB');
    });
    try {
      var result = await plugin.install({ version: release.version, sha256: release.sha256 });
      if (!panel.isConnected) return;
      if (result.state === 'installer') show(tr('The installer is open. Follow the steps on screen, then reopen MAGI.', 'インストール画面を開きました。画面の案内に従って更新し、MAGIを開き直してください。'));
      else showInstallPermissionHelp(result.state === 'profile');
    } catch (error) {
      if (!panel.isConnected) return;
      show(error && error.code === 'busy' ? tr('The update is already downloading. Wait a moment and try again.', 'アップデートをダウンロード中です。少し待ってから、もう一度お試しください。')
        : tr('Could not download or verify the update. Try again, or use the download page.', 'アップデートを取得・確認できませんでした。もう一度お試しいただくか、ダウンロードページから入手してください。'), tr('Try again', '再試行'), install, true);
    } finally { listener.remove(); }
  }
  panel.querySelector('.agent-page-back').focus();
  check();
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
    beginShare: function () { agentEndTemporary(); syncCurrentToSaved(); resetAgent(); sharedLoading = true; announceAgent(readingShared); },
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
      if (!agentTemporary() && !agentBusy && !agentDead && !agentClosed && !sharedLoading) nativeInput.startVoice();
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
    if (closeAgentPrivacyDialog()) return;
    // パネルやメニューを閉じる操作で、会話や入力中の文は消さない。
    if (closeAttachMenu()) return;
    if (backAgentPage()) return;
    if (document.querySelector('.agent-panel')) { closeAgentPanels(); return; }
    if (closeUsagePop()) return;
    var menu = document.getElementById('agent-more-dropdown');
    if (menu && !menu.classList.contains('hidden')) { menu.classList.add('hidden'); return; }
    if (document.querySelector('.rate-pop')) { closeRatePops(true); return; }
    if (event.canGoBack) window.history.back();
    else app.exitApp().catch(function () {});
  });
})();
// NATIVE_SHELL_END
