import { DEBATE, DEFAULTS, FACT_ANSWER, INTENT_CLASSIFY, LINE_CONTROL_RE, MAGI_MODE, MALICE_REPLY, MUSIC_CONSULT, PERSONAS, PERSONA_CONTEXT, PERSONA_GUIDE, PERSONA_TEMPERATURE, PRIVACY, PROVIDERS, REPLY_LANGUAGE, RESEARCH, SEARCH_CLICK, SHARED, SITE_GUIDE, SPEECH, SITE_RANK, SITE_SEARCH, STREAM, SUGGESTER, SYNTHESIZER, SYNTH_BIAS, TEXT_CONTROL_RE, TITLER } from '../personas.js';
import { cleanMotion, parseVote, magiTally, cleanMagiHistory, magiHistoryNote } from '../magi-mode.js';
import { billingFailureBody, chatPageEvent, getSitePages, getSiteSnapshot, isBillingFailure, readLimited, resolveSiteHistory, searchDeadline, searchFailure, searchSlice, selectSitePages, sha256, siteGuide, snapshotHash } from '../site-search.js';
import { rankCandidateHash, rankQuery, rankSearch, rankSiteUrl } from '../site-rank.js';
import { filterRankItems, getDailySnapshot, getRankSnapshot, isDailyScope, isSearchScope, normalizeScopeFilters, rankScopeConfig, rankScopeEnabled, scopeGeneration, searchScope } from '../search-scope.js';
import { classifyQuery, cleanReplyLanguage, classifySlice, exactKeys, languageNote, isLanguageLetter, isKanaLetter, isJapaneseLetter } from '../classification.js';
import { researchMessages, researchPlaceLabel, researchReader, researchSourceBlocks, readResearchSource, researchVerificationRequest, startSourceIcons, verifiedResearchResult } from '../research.js';
import { qaBudgetEnv } from '../qa-budget.js';
// デプロイ時点の人格カード。wrangler がデプロイ時にバンドルへ取り込む（config/ai-models.json と同じ）。
// 取得できないときの最後の拠り所で、デプロイし直すたびにその時点の最新に入れ替わる
import bundledContext from '../../../data/magi-context.json';
import { getVersionHistory } from '../versions.js';

import { speechLanguage, speechParts, speechSign, speechVerify } from '../speech.js';
import { chatPrivacy, privacyFeatures, personalizationNote } from '../privacy.js';

const ALLOWED_ORIGINS = ['https://tk.st', 'https://www.tk.st'];
// Native app shells (Capacitor/Ionic) and local dev all serve from a localhost
// origin fixed by the WebView — not spoofable from another web page — so we trust
// them like tk.st. Covers http/https/capacitor/ionic schemes. The MAGI mobile app
// (magi-app/) runs on https://localhost (capacitor.config iosScheme/androidScheme).
const APP_ORIGIN_RE = /^(https?|capacitor|ionic):\/\/localhost(:\d+)?$/;
const isAllowedOrigin = (o) => ALLOWED_ORIGINS.includes(o) || APP_ORIGIN_RE.test(o);
const utcDay = () => new Date().toISOString().slice(0, 10);
const requestIP = request => request.headers.get('CF-Connecting-IP') || 'unknown';

function corsHeaders(origin) {
  const allow = isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
  };
}

// --- 統一エラー設計: stage 付きエンベロープ + request_id ---
// stage は auth / bad_request / rate_limit / persona_call / synthesizer_call / upstream / internal
function stageError(stage, code, message, extra = {}) {
  const e = new Error(message);
  e.envelope = { stage, code, message, ...extra };
  return e;
}
function toEnvelope(err, requestId) {
  if (err && err.envelope) return { ...err.envelope, request_id: requestId };
  return {
    stage: 'internal', code: 'internal_error', message: '内部エラーが発生しました',
    detail: String(err && err.message || err).slice(0, 200), request_id: requestId, retryable: false,
  };
}
function jsonResponse(body, cors, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', ...headers, ...cors },
  });
}
function httpError(status, envelope, requestId, cors) {
  return jsonResponse({ error: { ...envelope, request_id: requestId } }, cors, status);
}
// 評価用の予算ガード（qa-budget.js）。未設定なら何もしない。予算で止めたときはチャットと404で同じ409を返す。
// D1の失敗などはガードの判定ではないので、各入口の503（unavailable）に任せ、内部のメッセージを応答に出さない
async function qaGuard(env, sample, { requestId, cors, log }, unavailable) {
  if (!env.MAGI_QA_PLAN) return { env };
  try { return { env: await qaBudgetEnv(env, sample()) }; }
  catch (error) {
    const refused = error.message.startsWith('qa_budget_');
    log('qa_budget', refused ? error.message : 'failed');
    return { response: refused
      ? httpError(409, { stage: 'evaluation', code: error.message, message: '評価用の送信を停止しました', retryable: false }, requestId, cors)
      : unavailable() };
  }
}
function inputError(err, requestId, cors) {
  return httpError(err.envelope?.http_status || 400, err.envelope || {
    stage: 'bad_request', code: 'invalid_json', message: 'リクエストボディの JSON が不正です', retryable: false,
  }, requestId, cors);
}

// 報告と明示的に選んだ画像だけをメールへ渡す。本文・画像はログやDBに保存しない。
function bugReportImages(images) {
  const invalid = () => stageError('bad_request', 'invalid_report_images', '画像はPNG・JPEG・WebPを3枚まで、1枚5MB・合計10MB以内で添付してください', { retryable: false });
  if (images === undefined) return [];
  if (!Array.isArray(images) || images.length > 3) throw invalid();
  let total = 0;
  return images.map((image, index) => {
    if (!image || typeof image.content !== 'string' || image.content.length > 6990508
      || !['image/png', 'image/jpeg', 'image/webp'].includes(image.type)
      || image.content.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.content)) throw invalid();
    const bytes = b64Bytes(image.content);
    if (!bytes || bytes > 5 * 1048576 || (total += bytes) > 10 * 1048576) throw invalid();
    const head = atob(image.content.slice(0, 16));
    const type = head.startsWith('\x89PNG\r\n\x1a\n') ? 'image/png'
      : head.startsWith('\xff\xd8\xff') ? 'image/jpeg'
      : head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP' ? 'image/webp' : null;
    if (type !== image.type) throw invalid();
    const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[type];
    return { filename: `bug-report-${index + 1}.${extension}`, content: image.content };
  });
}
async function handleBugReport(request, env, { requestId, cors }) {
  cors = { ...cors, 'Cache-Control': 'no-store' };
  let body;
  let attachments;
  try {
    body = await readJsonLimited(request, 14 * 1048576);
    attachments = bugReportImages(body.images);
    if (body.report_id !== undefined && (typeof body.report_id !== 'string'
      || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(body.report_id))) {
      throw stageError('bad_request', 'invalid_report_id', '報告の形式が不正です', { retryable: false });
    }
  }
  catch (error) { return inputError(error, requestId, cors); }
  if (typeof body.message !== 'string' || !body.message.trim() || Array.from(body.message).length > 2000) {
    return httpError(400, { stage: 'bad_request', code: 'invalid_report', message: '問題の内容を2000文字以内で入力してください', retryable: false }, requestId, cors);
  }
  if (!env.DB || !env.RESEND_API_KEY || !env.ALERT_FROM) {
    return httpError(503, { stage: 'internal', code: 'report_unavailable', message: '現在報告を送信できません。時間を置いてお試しください', retryable: true }, requestId, cors);
  }
  try {
    const day = utcDay();
    // 匿名の入口なので、IPごと5通・全体100通/日に制限する。
    if (await countUp(env.DB, `bug-report:${requestIP(request)}`, day, 5) == null
      || await countUp(env.DB, 'bug-report:global', day, 100) == null) {
      return httpError(429, { stage: 'rate_limit', code: 'report_limit', message: '送信の上限に達しました。時間を置いてお試しください', retryable: true }, requestId, cors);
    }
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json',
        ...(body.report_id ? { 'Idempotency-Key': `magi-bug:${body.report_id}` } : {}) },
      body: JSON.stringify({ from: env.ALERT_FROM, to: ['magi@tk.st'], subject: '[MAGI] バグ報告',
        text: `MAGIのバグ報告\n\n${body.message.trim()}`, ...(attachments.length ? { attachments } : {}) }),
    });
    if (!response.ok) throw new Error('mail_failed');
    return jsonResponse({ ok: true, images: attachments.length }, cors);
  } catch (_) {
    return httpError(503, { stage: 'internal', code: 'report_failed', message: '送信できませんでした。時間を置いて再試行してください', retryable: true }, requestId, cors);
  }
}

// Content-Length が無い場合も、JSON を展開する前に読み取り量を制限する。
// signal（省略できる）で止めたら、読み取り中の reader を止める（待つ Promise を打ち切るだけでは読み取りが残る）
const tooLarge = () => stageError('bad_request', 'request_too_large', 'リクエストサイズが上限を超えています', { http_status: 413, retryable: false });
// 文字列の UTF-8 でのバイト数。複製を作らずに数える（不正なサロゲートは数え方が少しずれるが、上限の判定には足りる）
function utf8Length(text) {
  let bytes = text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 0x7f) bytes += c > 0x7ff && (c < 0xd800 || c > 0xdfff) ? 2 : 1;
  }
  return bytes;
}
async function readJsonLimited(request, maxBytes, signal = null, metrics = null) {
  if (Number(request.headers.get('Content-Length')) > maxBytes) throw tooLarge();
  if (!request.body) throw stageError('bad_request', 'invalid_json', 'リクエストボディがありません', { retryable: false });
  const reader = request.body.getReader();
  const onAbort = () => { reader.cancel().catch(() => {}); };
  if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  const dec = new TextDecoder();
  let size = 0, text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw tooLarge(); }
      text += dec.decode(value, { stream: true });
    }
    if (metrics) metrics.bytes = size;
    const body = JSON.parse(text + dec.decode());
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid body');
    return body;
  } finally { signal?.removeEventListener('abort', onAbort); reader.releaseLock(); }
}

function checkText(text, maxChars, counters) {
  if (text.length > maxChars) throw stageError('bad_request', 'text_too_long', `本文は ${maxChars} 文字までです`, { retryable: false });
  counters.text += text.length;
  if (counters.text > DEFAULTS.input.history_max_chars) throw stageError('bad_request', 'history_too_long', '会話の履歴が文字数の上限を超えています', { retryable: false });
}


// rate_limit の (key, period) の数を1つ進めて返す。limit に達していたら進めずに null を返す
// （上限後はカウンターを書き換えず、同時リクエストにも原子的に制限を掛ける）。
// 回数制限（IP・全体・リアクション）と、通知メールの「今日はもう送った」印（limit = 1）に使う。
async function countUp(db, key, period, limit) {
  if (!(limit > 0)) return null; // 上限 0 は「止める」。行が無いときの最初の1回も通さない
  const row = await db.prepare(`INSERT INTO rate_limit (ip, day, count) VALUES (?1, ?2, 1)
    ON CONFLICT(ip, day) DO UPDATE SET count = count + 1 WHERE count < ?3 RETURNING count`)
    .bind(key, period, limit).first();
  return row ? row.count : null;
}

async function consumeReactionLimit(db, ip, now) {
  for (const [period, limit] of [[now.slice(0, 16), DEFAULTS.reactions.minute_limit], [now.slice(0, 10), DEFAULTS.reactions.daily_limit]]) {
    if (await countUp(db, `react:${ip}`, period, limit) == null) {
      throw stageError('rate_limit', 'reaction_limit_exceeded', 'リアクションの利用上限に達しました。時間を置いてお試しください', { http_status: 429, retryable: true });
    }
  }
}

// --- マルチモーダル入力（画像）---
// message.content は文字列のほか、OpenAI 互換のパート配列
// [{type:'text',text}, {type:'image_url',image_url:{url}}] を受け付ける。
// 画像は data: URL のみ許可する（外部 URL を許すと Worker を踏み台にした
// 任意フェッチになるため）。許容 MIME は正規表現側で固定。
const DATA_IMAGE_RE = /^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/;
const b64Bytes = (b64) => Math.floor(b64.length * 3 / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);

function normaliseImagePart(part, counters) {
  const url = part && part.image_url && typeof part.image_url.url === 'string' ? part.image_url.url.trim() : '';
  const m = DATA_IMAGE_RE.exec(url);
  if (!m) throw stageError('bad_request', 'invalid_image', '画像は data:image/(png|jpeg|webp|gif);base64,… 形式のみ受け付けます', { retryable: false });
  const bytes = b64Bytes(m[1]);
  if (m[1].length % 4 !== 0) throw stageError('bad_request', 'invalid_image', '画像の base64 が不正です', { retryable: false });
  if (bytes > DEFAULTS.vision.max_image_bytes) {
    throw stageError('bad_request', 'image_too_large', `画像は1枚あたり ${Math.round(DEFAULTS.vision.max_image_bytes / 1048576)}MB までです`, { retryable: false });
  }
  if (++counters.total > DEFAULTS.vision.max_images_total) {
    throw stageError('bad_request', 'too_many_images', `画像は1リクエストあたり ${DEFAULTS.vision.max_images_total} 枚までです`, { retryable: false });
  }
  counters.imageBytes += bytes;
  if (counters.imageBytes > DEFAULTS.vision.max_total_bytes) throw stageError('bad_request', 'images_too_large', '画像の合計サイズは8MBまでです', { retryable: false });
  return { type: 'image_url', image_url: { url } };
}

// 1メッセージを検証し {role, content} に正規化する。
// クライアントは表示用の付加キー（mid / debate / reactions）を持つ履歴をそのまま送ってくる。
// assistantのdebateはopinionsとして人格ごとの履歴に使い、clarifyは直後の回答の分類にだけ使う。
// 上流の生成APIへはroleとcontentしか送らない（requestBody）。
function normaliseMessage(m, counters) {
  if (!m || (m.role !== 'user' && m.role !== 'assistant')) {
    throw stageError('bad_request', 'invalid_message_shape', '各 message は role:"user"|"assistant" が必要です', { retryable: false });
  }
  if (typeof m.content === 'string') {
    // 画面・旧APKが保存した長い回答でも会話を続けられるよう、送り直す本文はここでも上限に収める。
    if (m.role === 'assistant') m = { ...m, content: classifySlice(m.content, DEFAULTS.input.assistant_max_chars) };
    checkText(m.content, m.role === 'user' ? DEFAULTS.input.user_max_chars : DEFAULTS.input.assistant_max_chars, counters);
    if (!m.content.trim()) throw stageError('bad_request', 'empty_content', 'メッセージが空です', { retryable: false });
    const opinions = m.role === 'assistant' && m.mode !== 'fact' ? normaliseDebate(m.debate) : null;
    if (opinions) for (const text of Object.values(opinions)) checkText(text, DEFAULTS.persona_history_max_chars, counters);
    const magi = m.role === 'assistant' && m.mode === 'magi' ? cleanMagiHistory(m.magi) : null;
    const clarify = m.role === 'assistant' && m.mode !== 'magi' && m.mode !== 'fact' ? cleanClarification(m.clarify) : null;
    return { role: m.role, content: m.content, ...(opinions ? { opinions } : {}), ...(magi ? { magi } : {}), ...(clarify ? { clarify } : {}) };
  }
  // 画像を含められるのは user メッセージのみ
  if (m.role !== 'user' || !Array.isArray(m.content) || m.content.length === 0 || m.content.length > 8) {
    throw stageError('bad_request', 'invalid_message_shape', '各 message の content は文字列、または user のパート配列が必要です', { retryable: false });
  }
  let images = 0;
  const parts = m.content.map((part) => {
    if (part && part.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text };
    if (part && part.type === 'image_url') {
      if (++images > DEFAULTS.vision.max_images_per_message) {
        throw stageError('bad_request', 'too_many_images', `画像は1メッセージあたり ${DEFAULTS.vision.max_images_per_message} 枚までです`, { retryable: false });
      }
      return normaliseImagePart(part, counters);
    }
    throw stageError('bad_request', 'invalid_part', 'content のパートは {type:"text"} か {type:"image_url"} のみです', { retryable: false });
  });
  checkText(parts.filter(p => p.type === 'text').map(p => p.text).join('\n'), DEFAULTS.input.user_max_chars, counters);
  if (!images && !parts.some(p => p.type === 'text' && p.text.trim())) {
    throw stageError('bad_request', 'empty_content', 'メッセージが空です', { retryable: false });
  }
  return { role: m.role, content: parts };
}

// パート配列から本文テキスト / 画像パートだけを取り出す
const contentText = (c) => typeof c === 'string' ? c : c.filter(p => p.type === 'text').map(p => p.text).join('\n').trim();
const contentImages = (c) => typeof c === 'string' ? [] : c.filter(p => p.type === 'image_url');
// 画像があれば「画像＋テキスト」のパート配列を、無ければ素の文字列を返す
const withImages = (text, images) => images.length ? [...images, { type: 'text', text }] : text;

// 人格が答えられなかった回に、画面のカードへ出す印（persona イベントの absent:true と一緒に送る）
const PERSONA_ABSENT = '[NO RESPONSE]';

// 過去の回の各人格の意見。画面は履歴の assistant に debate（{ codename: { round1, round2, followups } }）を付けて送ってくる。
// followups は統合人格が聞き返した第3回以降（[{ round, ask, text }]。聞かれた回だけ）。
// いちばん新しい意見を優先し、届かなかった回（'…'）や欠席の印は使わない。知らない人格名や文字列以外は捨てる
function normaliseDebate(debate) {
  if (!debate || typeof debate !== 'object') return null;
  const usable = (t) => typeof t === 'string' && t.trim() && t.trim() !== '…' && t.trim() !== PERSONA_ABSENT;
  const out = {};
  for (const p of PERSONAS) {
    const d = debate[p.codename];
    if (!d || typeof d !== 'object') continue;
    const later = Array.isArray(d.followups) ? d.followups.map(f => f && f.text).reverse() : [];
    const text = [...later, d.round2, d.round1].find(usable);
    if (text) out[p.codename] = text.trim().slice(0, DEFAULTS.persona_history_max_chars);
  }
  return Object.keys(out).length ? out : null;
}

// content（文字列かパート配列）同士をつなぐ / 頭に文を足す
const toParts = (c) => typeof c === 'string' ? [{ type: 'text', text: c }] : c;
const joinContent = (a, b) => typeof a === 'string' && typeof b === 'string' ? `${a}\n\n${b}` : [...toParts(a), ...toParts(b)];
const prependText = (text, c) => typeof c === 'string' ? text + c : [{ type: 'text', text }, ...c];

// 人格1人ぶんの会話の履歴を組む。3人格は一人の人間の中の面なので、記憶は共有する（過去の回のことは全員が知っている）。
// ただし渡し方を分ける。
//   - その人格自身の過去の意見 → assistant（自分の発言として、口調と立場を引き継ぐ）
//   - 他の2人格の過去の意見と、統合人格（Shinya Takeda）の過去の回答 → 次の user 発言の頭に、誰の言葉かを書いた
//     見出しを付けて文脈として渡す（自分の発言と取り違えて、他の面の口調を引き継がないように）
// 自分の意見が無い回（古い履歴・欠席した回）は user が続くので、同じ役割が続いたら1つにまとめる。
const personaLabel = (p) => `${p.codename}（${p.name}）`;
function personaThread(codename, history, lastContent) {
  const out = [];
  let recap = null; // 直前の回の、他の面の意見と統合の回答（次の user 発言の頭に付ける）
  const push = (role, content) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content = joinContent(last.content, content);
    else out.push({ role, content });
  };
  // 利用者の発言には毎回見出しを付ける（見出しが無いと、利用者に直接答える本人として書きやすい）
  const withRecap = (c) => prependText(`${recap || ''}〔ユーザーの今回の発言〕\n`, c);
  for (const m of history) {
    if (m.role === 'user') { push('user', withRecap(m.content)); recap = null; continue; }
    const own = m.opinions && m.opinions[codename];
    if (own) push('assistant', own);
    const others = PERSONAS.filter(p => p.codename !== codename && m.opinions && m.opinions[p.codename]);
    recap = (others.length
      ? `〔前回、${others.map(personaLabel).join('と')}が言ったこと〕\n${others.map(p => `- ${personaLabel(p)}: ${m.opinions[p.codename]}`).join('\n')}\n\n`
      : '')
      + `〔前回、3つの面の議論をまとめて Shinya Takeda が答えたこと〕\n${magiHistoryNote(m.magi)}${contentText(m.content)}\n\n`;
  }
  push('user', withRecap(lastContent));
  return out;
}

// 「120文字以内」の指定を数えて、末尾に「（109文字）」「(98 characters)」と書き足すモデルがある（以前のGeminiで確認）。
// プロンプトでも止めているが、書かれたときはここで落とす
const stripCharCount = (text) => text.replace(/\s*[（(]\s*\d+\s*(?:文字|字|characters?|chars?)\s*[）)]\s*$/i, '').trim();

// 画面がカードに名前を出すのに、頭へ自分の名前の見出し（【BALTHASAR-2】・**Humanist（BALTHASAR-2）**:・Humanist：など）を
// 付けるモデルがある（Haikuで確認。プロンプトで止めても残る）。自分の名前の見出しだけを落とし、本文の「Humanistとして」は残す
const ownHeaderPattern = (p) => {
  const id = `(?:${[p.codename, p.name].map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`;
  const named = `${id}(?:\\s*[（(]\\s*${id}\\s*[)）])?`;
  return new RegExp(`^\\s*(?:【\\s*${named}\\s*】(?:\\s*[（(]\\s*${id}\\s*[)）])?|\\*\\*\\s*${named}\\s*\\*\\*|[[［]\\s*${named}\\s*[\\]］]|${named}\\s*(?=[:：]))\\s*[:：]?\\s*`, 'i');
};
const stripOwnHeader = (text, p) => text.replace(ownHeaderPattern(p), '').trim() || text;

// 会社ごとの呼び出し方の違いはここに閉じる（値は personas.js の DEFAULTS.models）。
function requestBody(cfg, { messages, stream, temperature, response_format }) {
  const sampling = { temperature: temperature != null ? temperature : DEFAULTS.temperature, top_p: DEFAULTS.top_p };
  // 上流へは role と content だけを送る（履歴に付けて持ち回っている opinions などは落とす）
  const base = { model: cfg.model, stream: !!stream, messages: messages.map(({ role, content }) => ({ role, content })) };
  switch (cfg.provider) {
    case 'openai':
      // reasoning_effort は省略すると medium になるので、非推論でも必ず送る。
      // temperature / top_p は非推論のときだけ受け付けられる（推論ありで送ると "Unsupported value" で 400）
      return {
        ...base, reasoning_effort: cfg.reasoning_effort, max_completion_tokens: cfg.max_tokens,
        ...(cfg.reasoning_effort === 'none' ? sampling : {}),
        ...(response_format ? { response_format, store: false } : {}),
      };
    case 'deepseek':
      // 推論の入り切りは thinking で明示する（省略すると推論あり）。推論ありだと temperature は黙って無視される
      return cfg.reasoning_effort === 'none'
        ? { ...base, thinking: { type: 'disabled' }, max_tokens: cfg.max_tokens, ...sampling }
        : { ...base, thinking: { type: 'enabled' }, reasoning_effort: cfg.reasoning_effort, max_tokens: cfg.max_tokens };
    case 'anthropic': {
      const system = [], turns = [];
      for (const { role, content } of base.messages) {
        if (role === 'system') { system.push(content); continue; }
        if (!['user', 'assistant'].includes(role)) throw stageError('internal', 'invalid_role', '上流の役割が不正です', { retryable: false });
        if (!turns.length && role === 'assistant') continue;
        // Anthropic は空白だけの text を受け付けないので落とす（入口は画像に空の text が付くのを許している）
        const parts = (typeof content === 'string' ? [{ type: 'text', text: content }] : content).flatMap(part => {
          if (part.type === 'text') return part.text.trim() ? [{ type: 'text', text: part.text }] : [];
          // 本体は入口（DATA_IMAGE_RE）で検査済みなので、数MBの base64 は走査し直さず形式だけ見る
          const url = part.image_url?.url || '', image = /^data:(image\/(?:png|jpeg|webp|gif));base64,(?=.)/.exec(url);
          if (!image) throw stageError('internal', 'invalid_image', '上流の画像が不正です', { retryable: false });
          return [{ type: 'image', source: { type: 'base64', media_type: image[1], data: url.slice(image[0].length) } }];
        });
        if (!parts.length) continue;
        if (turns.at(-1)?.role === role) turns.at(-1).content.push(...parts);
        else turns.push({ role, content: parts });
      }
      // reasoning_effort の 'none' は推論なし（effort は最低の low）、それ以外は適応的推論をその強さで。
      // system は自動ではキャッシュされないので末尾に目印を付ける（同じ人格の R1・R2・聞き返しで読み出せる。
      // 512トークン未満は黙って対象外になり、費用もかからない）
      const thinking = cfg.reasoning_effort === 'none' ? 'disabled' : 'adaptive';
      return { model: cfg.model, stream: !!stream, max_tokens: cfg.max_tokens,
        ...(system.length ? { system: [{ type: 'text', text: system.join('\n\n'), cache_control: { type: 'ephemeral' } }] } : {}), messages: turns,
        thinking: { type: thinking }, output_config: { effort: thinking === 'disabled' ? 'low' : cfg.reasoning_effort,
          ...(response_format ? { format: { type: 'json_schema', schema: anthropicSchema(response_format.json_schema.schema) } } : {}) },
      };
    }
    default:
      throw stageError('internal', 'unknown_provider', `未知の呼び出し先です: ${cfg.provider}`, { retryable: false });
  }
}

// 認証の付け方も会社ごとに違う。
const requestHeaders = (provider, key) => ({ 'Content-Type': 'application/json', ...(provider === 'anthropic'
  ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { 'Authorization': `Bearer ${key}` }) });

// Anthropic の停止理由を OpenAI の finish_reason に揃える（非ストリームとストリームで共通）。
const ANTHROPIC_STOP = { end_turn: 'stop', max_tokens: 'length', refusal: 'content_filter' };
const anthropicStop = (reason) => ANTHROPIC_STOP[reason] || reason || null;

// ストリームの data 行1つを { done, finish, delta } に読む。finish は OpenAI の finish_reason に揃える。
function streamEvent(provider, payload) {
  if (payload === '[DONE]' && provider !== 'anthropic') return { done: true };
  let data;
  try { data = JSON.parse(payload); }
  catch (_) { throw stageError('synthesizer_call', 'invalid_stream', '統合応答の形式が不正です', { retryable: true }); }
  if (data.error) throw stageError('synthesizer_call', 'stream_error', '統合応答の途中でエラーが発生しました', { retryable: true });
  if (provider === 'anthropic') return {
    done: data.type === 'message_stop',
    finish: data.type === 'message_delta' ? anthropicStop(data.delta?.stop_reason) : null,
    delta: data.type === 'content_block_delta' && data.delta?.type === 'text_delta' ? data.delta.text : null,
  };
  const choice = data.choices?.[0];
  return { finish: choice?.finish_reason, delta: choice?.delta?.content };
}

// 呼び出し本文の切り出しを使う監視も同じ変換を通す。元の制約は受信側で検査する。
function anthropicSchema(value) {
  if (Array.isArray(value)) return value.map(anthropicSchema);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['maxItems', 'minItems', 'maxLength', 'minLength', 'minimum', 'maximum'].includes(key))
    .map(([key, child]) => [key, anthropicSchema(child)]));
}

// 上流へのPOSTは通常の呼び出しとWeb検索で共通にする（認証・予算の予約・使用量の観測・課金障害の通知）。
// 再試行と応答の解析は用途ごとに呼び出し側が持つ。キーが無いときは missingKey() の例外を投げる。
async function postUpstream(env, cfg, { body, endpoint = PROVIDERS[cfg.provider].endpoint, stream, signal, missingKey }) {
  const key = env[PROVIDERS[cfg.provider].key];
  if (!key) throw missingKey();
  if (env.qaReserve) await env.qaReserve(cfg.provider, body);
  const res = await fetch(endpoint, { method: 'POST', headers: requestHeaders(cfg.provider, key), body: JSON.stringify(body), signal });
  if (typeof env.evalObserve === 'function') env.evalObserve(cfg.provider, cfg.model, res.clone(), !!stream);
  // 失敗は残高切れ・キーの失効でないかを見る（本文は呼び出し側も読むので複製を渡す）
  // 本文の分類を待つ。先に戻ると呼び出し側がabortし、複製した本文も読めなくなる。
  // メールの送信はフック内のwaitUntilで行うので、ここでは待たない。
  if (!res.ok && env.onUpstreamError) await env.onUpstreamError(cfg.provider, res.clone(), { signal });
  return res;
}

// replyLimitは非streamのAnthropicを読み替える前の本文にも上限を掛ける（{ bytes, ms }）。
async function callModel({ env, messages, cfg, stream, signal, temperature, response_format, replyLimit = null }) {
  const body = requestBody(cfg, { messages, stream, temperature, response_format });
  if (typeof env.evalObserve === 'function' && stream && cfg.provider !== 'anthropic') body.stream_options = { include_usage: true };
  const res = await postUpstream(env, cfg, { body, stream, signal,
    missingKey: () => stageError('internal', 'missing_api_key', `${PROVIDERS[cfg.provider].key} が未設定です`, { retryable: false }) });
  // 非ストリームは既存の読み取りへ正規化し、thinkingは一度も履歴へ入れない。
  // 観測には正規化前の応答を渡すので、評価用の使用量は元の形で残る。
  if (res.ok && cfg.provider === 'anthropic' && !stream) {
    const raw = replyLimit ? await readLimited(res, replyLimit.bytes, signal, replyLimit.ms) : null;
    // 上限付きの読み取りは中断でも途中の本文を返すので、解析の失敗より先に中断として返す。
    if (replyLimit && signal?.aborted) throw searchFailure('cancelled');
    const data = replyLimit ? JSON.parse(raw) : await res.json();
    const reason = anthropicStop(data.stop_reason);
    const text = (data.content || []).filter(block => block.type === 'text').map(block => block.text).join('');
    return Response.json({ choices: [{ finish_reason: reason, message: { content: reason === 'content_filter' ? '' : text } }],
      usage: { ...data.usage, total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0) } });
  }
  return res;
}

// --- 上流の会社の残高切れ・キーの失効をメールで知らせる ---
// 1人格の失敗は欠席（[NO RESPONSE]）として黙って進むので、チャージを使い切っても画面からは気づきにくい。
// 401・402・403 と、残高や枠の不足を示す 429 を拾う（ただの回数制限の 429 は拾わない）。
// 同じ会社・同じ状態は UTC の1日に1通（rate_limit の行を「送った」印に使う）。
// 宛先と送り元は secret（RESEND_API_KEY・ALERT_TO・ALERT_FROM）。どれかが無ければログに出すだけ。ALERT_TO はカンマ区切りで複数書ける。
const PROVIDER_NAMES = { openai: 'OpenAI', deepseek: 'DeepSeek', anthropic: 'Anthropic', typesafe: 'TypeSafe AI', fishaudio: 'Fish Audio' };
const PROVIDER_ROLES = {
  openai: 'OpenAI（CASPER-3・ライトの統合・討議判定の答え直し・ページ選び。統合と補助の役割の答え直しにも使用）',
  deepseek: 'DeepSeek（MELCHIOR-1）',
  anthropic: 'Anthropic（BALTHASAR-2・ダークの統合・両テーマの討議判定・タイトル・次の質問の予測・議題化。統合は本文の表示前に限りOpenAIで一度答え直す）',
  typesafe: 'TypeSafe AI（Jev。発言の分類・初回の言語判定・サイト内検索）',
  fishaudio: 'Fish Audio（統合人格の回答の読み上げ）',
};
// 外部APIの英語の本文をメールへ流さず、日本語の説明と調査用の識別子だけを載せる。
function upstreamFailureText(status, body = '') {
  const reasons = {
    credit_balance_exhausted: '利用残高を使い切りました。',
    insufficient_quota: '利用枠または残高が不足しています。',
    billing_hard_limit_reached: '課金額の上限に達しました。',
  };
  const code = Object.keys(reasons).find(value => body.includes(value));
  const states = { 200: '応答内のエラー', 401: '認証失敗', 402: '支払い・残高の問題', 403: 'アクセス拒否', 429: '利用枠・残高の不足' };
  return [`HTTP ${status}（${states[status] || '外部サービスのエラー'}）`,
    code ? `原因: ${reasons[code]}\nエラー識別子: ${code}` : '残高・利用枠、APIキーの有効期限と権限を確認してください。',
  ].join('\n');
}
async function alertUpstream(env, log, provider, res, ctx, signal) {
  // 判定に使う先頭500バイト（エラー本文はASCIIのJSONなので500文字）だけを最大2秒で読む（届いた部分とHTTPコードだけで判定する）。
  // 複製のcancelは元の本文が閉じるまで終わらないことがあるので、その完了は待たない。
  const body = await billingFailureBody(res, provider, 500, signal);
  if (body === null) return;
  const detail = env.privateChat ? '上流エラーの本文は非表示です。' : body;
  log('upstream_alert', provider, res.status, detail.slice(0, 200));
  const task = sendAlert(env, log, `alert:${provider}:${res.status}`, `[MAGI] ${PROVIDER_NAMES[provider] || provider} の呼び出しが HTTP ${res.status} で失敗しています`, [
    `MAGI（magi2）で、${PROVIDER_ROLES[provider] || provider} の API の呼び出しが失敗しています。`,
    '',
    upstreamFailureText(res.status, env.privateChat ? '' : body),
    '',
    '残高の不足（チャージ切れ）か、キーの失効・権限の問題の可能性があります。',
    provider === 'typesafe'
      ? '言語の判定は手元の規則に切り替えて、会話は続けます（英字の混ざった日本語に、他の言語で答えることがあります）。'
      : provider === 'fishaudio'
        ? '読み上げは画面に「読み上げできませんでした」と返します。有料のモデルへは切り替えません（無料版の公正利用の超過もこの形で届くことがあります）。'
        : 'この会社の人格は「応答なし」として、残りの人格で答え続けます。',
    '同じ会社・同じ状態のメールは、世界協定時（UTC）の1日に1通です。',
  ]);
  // 本文の判定は呼び出し側が待ち、メールの送信だけを裏で続ける。
  ctx.waitUntil(task.catch(e => log('upstream_alert', 'failed', e && e.message)));
}

// 通知メールを送る。key ごとに UTC の1日に1通（rate_limit に key の行を「送った」印として作る）。
// 送れなかったら印を消し、次の機会にまた試す。secret が無ければログに出すだけ。
// signal（省略できる）で止められる：印を取る前に止まっていれば何もしない。印を取った後に止まったら Resend を呼ばずに
// 印を消す。送信の途中で止まったら送信を中止して印を消す（D1 の後始末は止めずに最後まで行う）
async function sendAlert(env, log, key, subject, lines, redact = false, signal = null) {
  if (!env.DB || !env.RESEND_API_KEY || !env.ALERT_TO || !env.ALERT_FROM) { log('alert', 'mail skipped (secret missing)', key); return; }
  if (signal?.aborted) return;
  const day = utcDay();
  if (await countUp(env.DB, key, day, 1) == null) return; // 今日はもう送った
  let sent = false, res;
  try {
    if (signal?.aborted) return; // finally で印を消す
    res = await fetch('https://api.resend.com/emails', {
      ...(signal ? { signal } : {}),
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.ALERT_FROM,
        to: env.ALERT_TO.split(',').map(s => s.trim()).filter(Boolean), // カンマ区切りで複数可
        subject,
        text: lines.join('\n'),
      }),
    });
    sent = res.ok;
  } catch (err) {
    log('alert', 'mail failed', key, ...(redact ? [] : [err && err.message]));
  } finally {
    // HTTP エラーだけでなく、fetch 自体が通信例外で終わったときも次回に再試行できるよう戻す。
    if (!sent) await env.DB.prepare(`DELETE FROM rate_limit WHERE ip = ?1 AND day = ?2`).bind(key, day).run();
  }
  // 成功の本文は使わないので取り消す（本文が止まっても通信を残さない。送った印はそのまま）
  if (res && sent) await res.body?.cancel().catch(() => {});
  // エラー本文の受信が止まっても再試行を妨げないよう、印を解除してから本文を読む。
  if (res && !sent) {
    if (redact) { log('alert', 'mail failed', res.status); await res.body?.cancel().catch(() => {}); }
    else log('alert', 'mail failed', key, res.status, (await res.text().catch(() => '')).slice(0, 200));
  }
}

// 検索は本文を判定にだけ使い、例外・本文をログにも通知にも渡さない。
// signal を渡すと（②の通知）、その signal で止まる通知を待って返す。渡さなければ（③とチャット）いままでどおり
// ctx.waitUntil に任せて待たない。{ billingFailure: true } は、呼び出し元が課金障害と確かめ済みの印で、
// 本文を読まずに状態だけで通知する（②は Jev の期限の中で本文を読み、確かめてから呼ぶ）。
function searchUpstream(env, ctx, log, purpose, signal = null) {
  return Object.assign(Object.create(env), {
    onUpstreamError: async (provider, res, { billingFailure = false } = {}) => {
      if (!billingFailure && await billingFailureBody(res, provider, SITE_RANK.error_body_max_bytes, null) === null) return;
      log('site_search', 'upstream_alert', provider, res.status);
      const task = sendAlert(env, log, `alert:${provider}:${res.status}`, `[MAGI] ${PROVIDER_NAMES[provider] || provider} の呼び出しが HTTP ${res.status} で失敗しています`, [
        `用途: ${purpose}`, `会社: ${PROVIDER_NAMES[provider] || provider}`, upstreamFailureText(res.status),
      ], true, signal).catch(() => log('site_search', 'alert_failed'));
      if (signal) return task;
      ctx.waitUntil(task);
    },
  });
}

// ②の通知：要求の切断とは別の期限（SITE_RANK.alert_timeout_ms）で必ず終える。通知全体を1つの Promise として
// ctx.waitUntil に渡す（期限が来たら signal で中止し、sendAlert の後始末が終わるまで待つ）。通知の成否は②の結果に響かない
function alertWithDeadline(ctx, log, ms, task) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  ctx.waitUntil(Promise.resolve().then(() => task(ac.signal)).catch(() => log('site_rank', 'alert_failed')).finally(() => clearTimeout(timer)));
}

// 404の会話の検索語と回答から、続きの履歴の検査（cleanSiteHistory）で拒む文字を除く。
// 画面は送った検索語と受け取った回答をそのまま履歴にして送り返すので、ここで除かないと続きが毎回400になる。
// 検索語は1行なので改行・タブも除き、回答は改行・タブを残す。
const queryControls = new RegExp(TEXT_CONTROL_RE.source, 'g'), replyControls = new RegExp(LINE_CONTROL_RE.source, 'g');

// A5の履歴は3往復だけ。ページ名は入力の検査に使い、事実の根拠にはしない。
function cleanSiteHistory(value) {
  if (value === undefined) return [];
  const cfg = SITE_SEARCH.conversation;
  if (!Array.isArray(value) || value.length > cfg.history_limit || value.length % 2) return null;
  const text = (s, max) => typeof s === 'string' && !!s.trim() && Array.from(s).length <= max && !LINE_CONTROL_RE.test(s);
  const rows = [];
  for (const [i, row] of value.entries()) {
    const assistant = i % 2 === 1;
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(k => !['role','content','pages'].includes(k))
      || row.role !== (assistant ? 'assistant' : 'user') || !text(row.content, assistant ? cfg.assistant_chars : cfg.user_chars)
      || !assistant && row.pages !== undefined) return null;
    const pages = assistant && row.pages !== undefined ? row.pages : [];
    if (!Array.isArray(pages) || pages.length > 3 || pages.some(p => !p || Object.keys(p).length !== 2
      || !text(p.title, cfg.title_chars) || !text(p.url, cfg.url_chars) || !/^\/(?!\/)/.test(p.url)
      || /[\\\s?#]/.test(p.url) || new URL(p.url, 'https://tk.st').origin !== 'https://tk.st')) return null;
    rows.push({role:row.role, content:row.content, ...(assistant ? {pages:pages.map(p => ({title:p.title,url:p.url}))} : {})});
  }
  return rows;
}

async function handleSiteSearch(request, env, ctx, { requestId, cors, log }) {
  const fail = (status, code) => httpError(status, {
    stage: status === 429 ? 'rate_limit' : status < 500 ? 'bad_request' : 'upstream', code,
    message: status === 429 ? '本日の利用上限に達しました。明日またお試しください' : status < 500 ? '検索の入力が不正です' : 'いまは AI に聞けません',
    retryable: status === 503,
  }, requestId, cors);
  const started = Date.now();
  let rank = false; // ②の要求は site_rank の1行だけを残す（③の elapsed_ms に混ぜない）
  try {
    return await searchDeadline(SITE_SEARCH.request_timeout_ms, async signal => {
      if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return fail(400, 'invalid_json');
      // 本文の受け付けは②・③とも6秒まで（遅い本文で待ち続けない）。②の残りの時間は、受付からの経過を引いて数える
      let body;
      const url = new URL(request.url), params = url.searchParams, rankPath = url.pathname === '/search/api/rank';
      const siteChat = !rankPath && params.get('site_chat') === '1', metrics = {};
      try { body = await searchDeadline(SITE_RANK.request_timeout_ms, s => readJsonLimited(request,
        siteChat ? SITE_SEARCH.conversation.request_bytes : SITE_SEARCH.request_bytes, s, metrics), signal); }
      catch (err) { return fail(err.envelope?.http_status || 400, err.envelope?.code || (err.searchCode === 'timeout' ? 'request_timeout' : 'invalid_json')); }
      // mode のある要求は②。'rank' 以外の mode を③として動かさない
      if (Object.hasOwn(body, 'mode') || rankPath) {
        rank = true;
        if (metrics.bytes > SITE_SEARCH.request_bytes) return fail(413, 'request_too_large');
        return await handleSiteRank(request, env, ctx, { requestId, cors, log }, body, signal, started);
      }
      const allowed = siteChat ? ['query','locale','history','reply_language'] : ['query','locale'];
      if (Object.keys(body).some(k => !allowed.includes(k)) || typeof body.query !== 'string' || !['ja', 'en'].includes(body.locale)) return fail(400, 'invalid_query');
      const query = body.query.replace(queryControls, '').trim();
      if (!query || Array.from(body.query).length > SITE_SEARCH.query_max_chars) return fail(400, 'invalid_query');
      if ([...params.keys()].some(k => !['site_debate','site_chat'].includes(k) || params.getAll(k).length !== 1 || params.get(k) !== '1')) return fail(400, 'invalid_site_debate');
      if (!params.has('site_debate')) return httpError(409, { stage: 'bad_request', code: 'site_search_update_required',
        message: 'ページを再読み込みしてください', retryable: false }, requestId, cors);
      const history = siteChat ? cleanSiteHistory(body.history) : [];
      const replyLanguage = siteChat && body.reply_language !== undefined ? cleanReplyLanguage(body.reply_language) : null;
      if (!history || siteChat && (body.reply_language !== undefined && !replyLanguage || history.length && !replyLanguage)) return fail(400, 'invalid_history');
      const qa = await qaGuard(env, () => ({ kind: 'site', text: query, images: [], historyMessages: history.length }),
        { requestId, cors, log }, () => fail(503, 'search_unavailable'));
      if (qa.response) return qa.response;
      env = qa.env;
      if (env.SITE_SEARCH_ENABLED !== 'true' || !env.DB) return fail(503, 'search_unavailable');
      const [pages, cards] = await Promise.all([getSitePages(ctx, body.locale, signal), getPersonaCards(ctx, () => {})]);
      if (signal.aborted) throw searchFailure('cancelled');
      const day = utcDay();
      const ip = requestIP(request);
      // 続きの質問は通常チャットの回数、初回は AI 検索の回数で数える
      const quota = history.length > 0
        ? { ipKey: ip, globalKey: 'global', ipLimit: DEFAULTS.daily_limit, globalLimit: DEFAULTS.global_daily_limit,
          alert: 'alert:global', subject: '[MAGI] 本日のサイト全体の上限に達しました' }
        : { ipKey: 'search:' + ip, globalKey: 'search:global', ipLimit: SITE_SEARCH.daily_limit, globalLimit: SITE_SEARCH.global_daily_limit,
          alert: 'alert:site-search-global', subject: '[MAGI] AI検索の本日の全体上限に達しました' };
      if (await countUp(env.DB, quota.ipKey, day, quota.ipLimit) == null) return fail(429, 'daily_limit_exceeded');
      if (await countUp(env.DB, quota.globalKey, day, quota.globalLimit) == null) {
        ctx.waitUntil(sendAlert(env, log, quota.alert, quota.subject, [
          `UTC日付: ${day}`, `全体上限: ${quota.globalLimit}`,
        ], true).catch(() => log('site_search', 'alert_failed')));
        return fail(429, 'global_daily_limit_exceeded');
      }
      if (signal.aborted) throw searchFailure('cancelled');
      const upstream = searchUpstream(env, ctx, log, '404検索');
      let langNote = languageNote({ code: body.locale }), language = replyLanguage;
      // 新旧③の応答形をここで揃える。旧③には会話の言語・終了状態を足さない。
      const reply = (result, comment, closed = false) => jsonResponse({
        request_id: requestId, ...result, comment: comment.replace(replyControls, ''),
        ...(siteChat ? { reply_language: language, closed } : {}),
      }, cors, 200, { 'Cache-Control': 'no-store' });
      if (siteChat) {
        const input = {profile:'site-search', texts:[...history.filter(m => m.role === 'user').map(m => m.content), query],
          seed:history[0]?.content || query, replyLanguage, uiLanguage:body.locale};
        const classified = await withTimeout(INTENT_CLASSIFY.timeout_ms, s => classifyQuery(upstream, input, s, log), signal)
          .catch(err => { if (signal.aborted) throw err; return classifyQuery({}, input, signal, log); });
        langNote = classified.langNote; language = classified.classification.reply_language;
        if (classified.malice) {
          let comment = '';
          await replyToMalice({env:upstream,cards,classified,uiLanguage:body.locale,signal,
            send:(event, data) => {if(event === 'integrated') comment += data.delta;}, log});
          return reply({ status: 'no_results', results: [] }, comment, true);
        }
      }
      // 履歴のページ名は信頼せず、現行の索引で1回だけ照合して、ページ選びと回答の両方に使う
      const conversation = resolveSiteHistory(history, pages);
      const result = await selectSitePages({ query, locale: body.locale, pages, conversation, purpose: 'requested', signal, log,
        call: opts => callModel({ ...opts, env: upstream }) });
      const previousPages = conversation.flatMap(row => row.pages || []);
      const messages = [...(previousPages.length ? [{role:'system',content:SITE_SEARCH.history_answer_prompt + '\n' + JSON.stringify(previousPages)}] : []),
        ...history.map(row => ({role:row.role,content:row.content})), {role:'user',content:query}];
      const answer = await runFactAnswer({ upstream, cards, messages,
        langNote, pageChoice: result, siteOnly: true, signal, send: discardEvents, log: stage => log('site_search', stage) });
      return reply(result, answer);
    }, request.signal);
  } catch (_) {
    // ②がここに来るのは切断だけ（②の期限は内側で応答する）。②の記録は handleSiteRank の1行に任せる
    if (!rank) log('site_search', 'unavailable');
    return fail(503, 'search_unavailable');
  }
  finally { if (!rank) log('site_search', 'elapsed_ms', Date.now() - started); }
}

// 404 のサイト内検索の②（Jev の検索。assets/site-search-design.md 3章）。
// 応答はどれも { status, complete, reason, searched, results } の形。回数の上限は 429、要求の誤りは 400、ほかは 200。
// 検索語・候補の中身・上流の本文はログにも通知にも出さない
async function handleSiteRank(request, env, ctx, { requestId, cors, log }, body, signal, started) {
  const info = { total: null, candidates: null, judged: null, above: 0, indexMs: null, jevMs: null, indexHash: null, candidateHash: null };
  const scope = body.scope, daily = isDailyScope(scope);
  const contract=new URL(request.url).pathname==='/search/api/rank';
  let config, filters, generation;
  // 期限・切断で先に応答を返した後も、中の処理は signal の効かない待ち（D1 など）の間は進むので、ログは最初の1回だけ
  let logged = false;
  const reply = (httpStatus, r) => {
    if (!logged) log('site_rank', r.status, r.reason, info.total, info.candidates, info.judged, info.above, info.indexMs, info.jevMs, Date.now() - started,
      config?.revision ?? SITE_RANK.revision, info.indexHash, info.candidateHash, isSearchScope(scope) ? scope : 'invalid');
    logged = true;
    const newSearched=info.total===null?null:{scope,filters:filters || {},generation:info.generation,total:info.total,
      candidates:r.searched?.candidates ?? info.candidates ?? 0,judged:r.searched?.judged ?? info.judged ?? 0};
    return jsonResponse({ request_id: requestId, status: r.status, complete: r.complete, reason: r.reason, searched: contract?newSearched:r.searched, results: r.results,
      ...(daily || contract ? { cached: r.cached === true } : {}) },
      cors, httpStatus, { 'Cache-Control': 'no-store' });
  };
  const searched = () => info.total === null ? null : { total: info.total, candidates: info.candidates ?? 0, judged: info.judged ?? 0,
    ...(daily ? { generation: info.generation } : {}) };
  const fail = (reason, httpStatus = 200) => reply(httpStatus, { status: 'failed', complete: false, reason, searched: searched(), results: [] });
  const raw = body.query;
  const query = rankQuery(raw);
  if ((!contract && !['site','nitori','retail'].includes(scope)) || (contract && body.search_contract!==1)
    || Object.keys(body).some(k => !['query', 'locale', 'mode', 'scope', ...(contract?['search_contract','filters','generation']:daily ? ['filters', 'generation'] : [])].includes(k)) || body.mode !== 'rank'
    || !['ja', 'en'].includes(body.locale) || typeof raw !== 'string' || Array.from(raw).length > SITE_RANK.query_max_chars || !query
    || new URL(request.url).search) return fail('invalid_request', 400);
  try {
    config = rankScopeConfig(scope);
    if(contract && scope==='site' && body.filters!==undefined && (!body.filters || typeof body.filters!=='object'
      || Array.isArray(body.filters) || Object.keys(body.filters).length)) return fail('invalid_request',400);
    filters = normalizeScopeFilters(scope, contract && scope==='site'?undefined:body.filters); generation = scopeGeneration(scope, body.generation);
  } catch (_) { return fail('invalid_request', 400); }
  if (!rankScopeEnabled(env, scope)) return fail('disabled');
  // 本番測定中の媒体は専用キー付きの要求だけ許し、公開画面は停止したままにする。
  if ((daily || contract) && String(env.SITE_RANK_EVAL_SCOPES || '').split(',').map(s => s.trim()).includes(scope)
    && (!env.SITE_RANK_EVAL_KEY || request.headers.get('x-api-key') !== env.SITE_RANK_EVAL_KEY)) return fail('disabled');
  if (!env.DB || !env[SITE_RANK.key]) return fail('unavailable');
  try {
    return await searchDeadline(Math.max(1, SITE_RANK.request_timeout_ms - (Date.now() - started)), async s => {
      // signal を受け取らない待ち（ハッシュ・D1）の後で止まっていたら、回数も Jev も使わずに抜ける
      const stopped = () => { if (s.aborted) throw searchFailure('cancelled'); };
      const indexStarted = Date.now();
      let snapshot;
      try {
        if(contract) {
          const checked=await getRankSnapshot(scope,{ctx,generation,signal:s});snapshot=checked.snapshot;
          if(snapshot) {info.total=filterRankItems(snapshot,scope,filters).length;info.generation=checked.generation;}
          if(checked.updating || !snapshot) return fail('index_updating');
          if(daily && ((filters.category && !snapshot.categories.has(filters.category)) || (filters.month && !snapshot.months.has(filters.month)))) return fail('invalid_request',400);
          if(!daily && scope!=='site' && Object.keys(filters).length && info.total===0) return fail('invalid_request',400);
        } else snapshot = daily ? await getDailySnapshot(scope, { filters, generation, signal: s }) : await getSiteSnapshot(ctx, s);
      }
      catch (e) {
        if (e.searchCode === 'cancelled') throw e;
        const code = e.searchCode;
        return fail(code === 'invalid_request' || code === 'index_updating' ? code : 'index_unavailable', code === 'invalid_request' ? 400 : 200);
      }
      info.indexMs = Date.now() - indexStarted;
      [info.indexHash, info.candidateHash] = await Promise.all([snapshotHash(snapshot), rankCandidateHash(snapshot)]);
      stopped();
      if (!daily && !snapshot.rankReady) return fail('index_unavailable');
      // 新契約は版の照合の時点で数えてある
      if (daily && !contract) { info.total = filterRankItems(snapshot, scope, filters).length; info.generation = snapshot.generation; }
      // 回数は IP → 全体の順。IP で断った要求は全体を進めない。キャッシュから返すときも数える（キャッシュで上限を避けられない）
      const day = utcDay(), ip = requestIP(request);
      if (await countUp(env.DB, 'rank:' + ip, day, SITE_RANK.daily_limit) == null) return fail('rate_limited', 429);
      stopped();
      if (await countUp(env.DB, 'rank:global', day, SITE_RANK.global_daily_limit) == null) {
        alertWithDeadline(ctx, log, SITE_RANK.alert_timeout_ms, sig => sendAlert(env, log, 'alert:site-rank-global', '[MAGI] サイト内検索（Jev）の本日の全体上限に達しました', [
          `UTC日付: ${day}`, `全体上限: ${SITE_RANK.global_daily_limit}`,
        ], true, sig));
        return fail('rate_limited', 429);
      }
      stopped();
      if (!daily && !contract) info.total = filterRankItems(snapshot, scope, filters).length;
      // 課金障害と確かめた失敗だけ通知する。通知は要求の切断とは別の期限で終え、検索の結果と速さに響かせない
      const onBilling = status => alertWithDeadline(ctx, log, SITE_RANK.alert_timeout_ms,
        sig => searchUpstream(env, ctx, log, 'サイト内検索', sig).onUpstreamError('typesafe', { status }, { billingFailure: true }));
      const r = await rankSearch({ env, snapshot, query, locale: body.locale, signal: s, onBilling, progress: info, scope, filters: daily || contract ? filters : null });
      Object.assign(info, { candidates: r.searched?.candidates ?? null, judged: r.searched?.judged ?? null, above: r.above, jevMs: r.jevMs });
      return reply(200, r);
    }, signal);
  } catch (e) { return fail(e.searchCode === 'timeout' ? 'timeout' : 'unavailable'); }
}

// 共通検索の候補クリックを記録する（設定は personas.js の SEARCH_CLICK）。画面は sendBeacon で送り、応答を読まない。
// 押したページが今も公開されているかは集計（search-boost.py）で確かめる。ここでは形と画面の種類に合うかだけを見る。
// 対象と日刊の媒体のディレクトリは search-scope.js の SEARCH_SCOPES を正本にする。
const CLICK_LISTS = ['suggest', 'local', 'semantic'];
function clickHref(scope, value) {
  if (!isSearchScope(scope) || typeof value !== 'string' || Array.from(value).length > SEARCH_CLICK.href_max_chars) return null;
  if (isDailyScope(scope)) return new RegExp(`^/job/${searchScope(scope).media}/[1-9][0-9]{7}/#art-[1-9][0-9]*$`).test(value) ? value : null;
  const path = rankSiteUrl(value);
  if (path !== value || /%(?:2e|2f|5c)/i.test(value)) return null;
  return scope === 'site' || path.startsWith(`/${scope}/`) ? path : null;
}
async function handleSearchClick(request, env, { requestId, cors, log }) {
  const fail = (status, code) => httpError(status, { stage: status === 429 ? 'rate_limit' : 'bad_request', code, message: '記録できませんでした', retryable: false }, requestId, cors);
  if (env.SEARCH_CLICK_ENABLED !== 'true' || !env.DB) return new Response(null, { status: 204, headers: cors });
  // 塩が無いと IP のハッシュを総当たりで戻せるので、記録しない。
  if (!env.SEARCH_CLICK_SALT) { log('search_click', 'salt_missing'); return new Response(null, { status: 204, headers: cors }); }
  let body;
  try { body = await readJsonLimited(request, SEARCH_CLICK.request_bytes); } catch (err) { return fail(err.envelope?.http_status || 400, 'invalid_json'); }
  const { scope, query, list, position } = body || {};
  const href = clickHref(scope, body?.href);
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join() !== 'href,list,position,query,scope'
    || !href || !CLICK_LISTS.includes(list)
    || !Number.isSafeInteger(position) || position < 1 || position > SEARCH_CLICK.position_max
    || typeof query !== 'string' || query !== query.trim() || !query || Array.from(query).length > SEARCH_CLICK.query_max_chars
    || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(query)) return fail(400, 'invalid_click');
  const day = utcDay(), ip = requestIP(request);
  try {
    if (await countUp(env.DB, `click:${ip}`, day, SEARCH_CLICK.ip_daily_limit) == null
      || await countUp(env.DB, 'click:global', day, SEARCH_CLICK.global_daily_limit) == null) return fail(429, 'click_limit_exceeded');
    // 同じ人の重複は集計で除く。IP は secret を混ぜたハッシュの先頭だけを残す（日をまたいでも1人と数え、IP へは戻せない）。
    const visitor = (await sha256(`${env.SEARCH_CLICK_SALT}:${ip}`)).slice(0, 16);
    await env.DB.prepare(`INSERT INTO search_clicks (day, at, scope, query, href, list, position, visitor) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`)
      .bind(day, Date.now(), scope, query, href, list, position, visitor).run();
  } catch (_) { log('search_click', 'record_failed'); return fail(503, 'unavailable'); }
  return new Response(null, { status: 204, headers: cors });
}

// 1人格ぶんの呼び出し。空応答 / 5xx は1回だけ自動リトライ（リトライ後も不可なら throw）。
// temperature はテーマ依存の「揺らぎ」（未指定なら DEFAULTS.temperature）。
async function fetchPersonaText(env, p, messages, signal, log, round = 1, temperature) {
  const cfg = DEFAULTS.models.persona[p.codename];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await callModel({
      env, cfg, stream: false, signal, temperature,
      messages: [{ role: 'system', content: p.system_prompt }, ...messages],
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      log('persona_call', p.codename, cfg.provider, `r${round}`, `HTTP ${res.status}`, `attempt=${attempt}`, detail);
      if (res.status >= 500 && attempt < 2) continue; // 一時的なサーバ起因のみ再試行
      throw stageError('persona_call', `${cfg.provider}_http_${res.status}`, `${p.codename} への呼び出しが失敗しました (HTTP ${res.status})`, { persona: p.codename, round, detail, retryable: res.status >= 500 });
    }
    const choice = (await res.json()).choices?.[0] || {};
    const text = classifySlice(stripOwnHeader(stripCharCount((choice.message?.content || '').trim()), p), DEFAULTS.persona_response_max_chars);
    log('persona_call', p.codename, cfg.provider, `r${round}`, `finish_reason=${choice.finish_reason}`, `len=${text.length}`, `attempt=${attempt}`);
    // 採用するのは最後まで書いた（stop）か上限で切れた（length）本文だけ。安全フィルター（content_filter）や
    // 上流の資源不足などで打ち切られた途中の本文は、票の印を含んでいても意見・票にしない（欠席にする）
    const complete = choice.finish_reason === 'stop' || choice.finish_reason === 'length';
    if (text && complete) return p.magi && choice.finish_reason === 'length' ? text + '…' : text;
    // 空応答・途中の打ち切りは1回だけ再試行。安全フィルターで止められたなら同じ結果になるので試さない
    if (attempt < 2 && choice.finish_reason !== 'content_filter') continue;
    throw stageError('persona_call', text ? 'incomplete_persona_output' : 'empty_persona_output', `${p.codename} が${text ? '途中で打ち切られた' : '空の'}応答を返しました (finish_reason=${choice.finish_reason})`, { persona: p.codename, round, retryable: true });
  }
  // ループは attempt=2 で必ず return/throw に到達するためここには来ない（防御的）
  throw stageError('persona_call', 'unreachable', `${p.codename} の応答取得に失敗しました`, { persona: p.codename, round, retryable: true });
}

// 会話の初回ユーザー発言からチャットタイトルを要約生成（非クリティカル：失敗しても null）。
async function fetchTitle(env, lastContent, langNote, signal, log) {
  try {
    // lastContent は文字列か画像込みのパート配列。画像だけの発言でも題を付けられる。
    // 発言は見出しを付けて引用する（そのまま渡すと、モデルが題ではなく答えを書く）
    const quoted = `${TITLER.input_header}
${contentText(lastContent).trim() || '（文字なし。画像だけ）'}`;
    const res = await callAuxModel({
      env, cfg: DEFAULTS.models.titler, stream: false, signal,
      messages: [{ role: 'system', content: withLangNote(TITLER.system_prompt, langNote) }, { role: 'user', content: withImages(quoted, contentImages(lastContent)) }],
    }, log, 'title');
    if (!res.ok) { log('title_call', `HTTP ${res.status}`); return null; }
    const raw = ((await res.json()).choices?.[0]?.message?.content || '').trim();
    // タイトルは1行・記号類を除去し、保険として長さを制限（英語の4語が収まる長さ）
    const clean = raw.replace(/[\r\n"'`「」『』]/g, '').trim().slice(0, 40);
    log('title_call', `len=${clean.length}`);
    return clean || null;
  } catch (e) {
    log('title_call', 'failed', e && e.message);
    return null;
  }
}

// 出力の言語の指定（personas.js の REPLY_LANGUAGE）。言語の名前はコードで決めず、ユーザーの言葉を引用して
// 「この言語で書く」とだけ伝える（どの言語でもモデルが見分ける）。コードが選ぶのは引用する発言だけ：
// 画面が付けた状況説明を足す前の会話を新しい順に見て、言語が読み取れる最初の発言を使う。
// 英字だけの発言は3語以上、それ以外の文字（かな・漢字・ハングル・アラビア文字・エチオピア文字など）は2字以上で読み取れるとみなす。
// 「OK」や曲名だけ・画像だけの発言は飛ばす（日本語の会話の「Daft Punk?」で英語に切り替わらないように）。無ければ null。
// かなの文字があり、他言語の文字が混じらない発言だけは「日本語」と書く（漢字の多い日本語を中国語と取り違えないため）。
// 混在文は固有名詞だけで言語を決めず、引用した文の主言語をモデルに判断させる。
// 「・」「ー」や濁点など、Common/Inheritedの文字・記号は言語の根拠に数えない。
function replyLanguageNote(messages) {
  for (const m of [...messages].reverse()) {
    if (m.role !== 'user') continue;
    const text = contentText(m.content).trim();
    const words = (text.match(/[A-Za-z]+/g) || []).length;
    const languageLetters = [...text].filter(isLanguageLetter);
    const letters = languageLetters.filter(ch => ch.codePointAt(0) > 127).length;
    if (words >= 3 || letters >= 2) {
      if (languageLetters.some(isKanaLetter) && languageLetters.every(isJapaneseLetter)) return REPLY_LANGUAGE.ja;
      return REPLY_LANGUAGE.note(text.slice(0, REPLY_LANGUAGE.sample_chars));
    }
  }
  return null;
}
const withLangNote = (prompt, langNote) => langNote ? `${prompt}\n\n${langNote}` : prompt;


// 次の質問の予測（非クリティカル：失敗・時間切れでも null）。
// 会話は1本の文字起こしにして渡す（チャットの形のまま渡すと、モデルが AI の続きとして答えてしまう）。
// 画面が付けた状況説明（context）は、ユーザーの発言とは別の見出しで渡す。
// 出力の言語（langNote）は会話の後ろに付ける。
// 発言は末尾を残し（長い答えは最後の問いかけが大事）、状況説明は頭を残す（役割と場面が先に書いてある）
const tail = (t, max) => t.length > max ? '…' + t.slice(-max) : t;
const head = (t, max) => t.length > max ? t.slice(0, max) + '…' : t;

async function fetchSuggestion(env, convo, context, langNote, signal, log) {
  try {
    const transcript = convo.slice(-SUGGESTER.history_messages).map((m) => {
      const imgs = contentImages(m.content).length;
      const text = tail(contentText(m.content).trim(), SUGGESTER.message_max_chars) + (imgs ? ` [画像${imgs}枚]` : '');
      return `${m.role === 'user' ? 'ユーザー' : 'AI'}: ${text}`;
    }).join('\n');
    const input = [
      ...(context ? [SUGGESTER.context_header, head(context.trim(), SUGGESTER.context_max_chars), ''] : []),
      '【会話】', transcript, ...(langNote ? ['', langNote] : []),
    ].join('\n');
    const res = await callAuxModel({
      env, cfg: DEFAULTS.models.suggester, stream: false, signal, temperature: SUGGESTER.temperature,
      messages: [{ role: 'system', content: SUGGESTER.system_prompt }, { role: 'user', content: input }],
    }, log, 'suggest');
    if (!res.ok) { log('suggest_call', `HTTP ${res.status}`); return null; }
    const raw = ((await res.json()).choices?.[0]?.message?.content || '').trim();
    // 1行目だけを使い、話者の名乗りと、文全体を囲む引用符を落とす。
    // 囲みは対で1組だけ外す（「曲名」——説明 の頭の「 だけを剥がすと、閉じの 」 が残って崩れる）
    let line = (raw.split(/\r?\n/).find(l => l.trim()) || '')
      .replace(/^\s*(?:ユーザー|user)\s*[:：]\s*/i, '').trim();
    const close = { '「': '」', '『': '』', '"': '"', '“': '”', "'": "'" }[line[0]];
    if (close && line.length > 1 && line.endsWith(close) && !line.slice(1, -1).includes(close)) line = line.slice(1, -1).trim();
    line = line.slice(0, SUGGESTER.max_chars);
    log('suggest_call', `len=${line.length}`);
    return line || null;
  } catch (e) {
    log('suggest_call', 'failed', e && e.message);
    return null;
  }
}

// --- 討議の判定（personas.js の DEBATE）---
// 討議の記録。人格ごとに、これまでの回の意見を順に並べる（判定と統合で同じものを使う）。
// views は [{ round, text, ask }]。ask は統合人格がその人格に向けた問い（第3回以降）
const voteLabel = vote => vote === 'approve' ? '承認' : vote === 'reject' ? '否決' : '票なし';
const viewBody = v => v.absent ? PERSONA_ABSENT : v.text || '（理由なし）';
const viewLabel = (v) => v.round === 1 ? '初回' : v.round === 2 ? '討議後' : `第${v.round}回`;
const debateRecord = (opinions) => opinions.map(o => `- ${o.name}（${o.codename}）\n`
  + o.views.map(v => `  ${viewLabel(v)}${v.vote_state ? ` [${voteLabel(v.vote)}]` : ''}${v.ask ? `（自分の問い「${v.ask}」への答え）` : ''}: ${viewBody(v)}`).join('\n')).join('\n');

// 判定に渡す材料：画面の状況説明・今回より前の会話（直近）・今回の発言・討議の記録。
// 画像は渡さない（討議の文字だけで判定する。画像は聞かれた人格が見直す）
function judgeInput(plainMessages, context, opinions, langNote) {
  const earlier = plainMessages.slice(0, -1).slice(-DEBATE.transcript_messages)
    .map(m => `${m.role === 'user' ? 'ユーザー' : '自分'}: ${tail(contentText(m.content).trim(), DEBATE.message_max_chars)}`);
  const last = plainMessages[plainMessages.length - 1].content;
  const imgs = contentImages(last).length;
  return [
    ...(context ? ['【画面が付けた状況説明（ユーザーの発言ではない）】', head(context.trim(), DEBATE.context_max_chars), ''] : []),
    ...(earlier.length ? ['【ここまでの会話】', ...earlier, ''] : []),
    '【今回のユーザーの発言】', contentText(last).trim() + (imgs ? ` [画像${imgs}枚]` : ''), '',
    '【討議の記録】', debateRecord(opinions),
    ...(langNote ? ['', langNote] : []),
  ].join('\n');
}

const questionText = (text, max) => typeof text === 'string' && !!text.trim() && text.length <= max && !TEXT_CONTROL_RE.test(text);

function cleanUserQuestions(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) return null;
  const seen = new Set();
  const result = [];
  for (const q of value) {
    if (!exactKeys(q, ['question', 'options']) || !questionText(q.question, DEBATE.user_question_max_chars)
      || seen.has(q.question.trim()) || !Array.isArray(q.options) || q.options.length !== 3
      || q.options.some(o => !questionText(o, DEBATE.user_option_max_chars))
      || new Set(q.options.map(o => o.trim())).size !== 3) return null;
    seen.add(q.question.trim());
    result.push({ question: q.question.trim(), options: q.options.map(o => o.trim()) });
  }
  return result;
}

function cleanClarification(value) {
  if (!exactKeys(value, ['questions', 'intent', 'fresh']) || !['consult', 'music', 'site', 'research'].includes(value.intent)
    || !['yes', 'no'].includes(value.fresh)) return null;
  const questions = cleanUserQuestions(value.questions);
  return questions ? { questions, intent: value.intent, fresh: value.fresh } : null;
}

// JSON.parseが上書きしてしまう重複キー（エスケープ表記も含む）を、解析成功後に検出する。
function uniqueJSONKeys(text) {
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/g) || [], stack = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '{' || t === '[') stack.push(t === '{' ? new Set() : null);
    else if (t === '}' || t === ']') stack.pop();
    else if (t[0] === '"' && tokens[i + 1] === ':') {
      const key = JSON.parse(t), seen = stack.at(-1);
      if (seen?.has(key)) return false;
      seen?.add(key);
    }
  }
  return true;
}

function parseJudgement(text, active, allowUser) {
  const v = JSON.parse(text);
  if (!uniqueJSONKeys(text) || !exactKeys(v, ['next_step', 'assessment', 'persona_questions', 'questions'])
    || !['answer', 'ask_personas', 'ask_user'].includes(v.next_step)
    || typeof v.assessment !== 'string' || v.assessment.length > DEBATE.assessment_max_chars
    || !Array.isArray(v.persona_questions) || !Array.isArray(v.questions)) throw new Error('invalid_judgement');
  if (v.next_step === 'answer' && (v.questions.length || v.persona_questions.length)) throw new Error('answer_with_questions');
  if (v.next_step === 'ask_user') {
    const questions = cleanUserQuestions(v.questions);
    if (!questions || v.persona_questions.length) throw new Error('invalid_user_questions');
    return allowUser ? { ...v, questions } : { ...v, next_step: 'answer', questions: [] };
  }
  if (v.next_step === 'ask_personas') {
    const seen = new Set(), texts = new Set(), known = PERSONAS.map(p => p.codename);
    if (v.questions.length || !v.persona_questions.length || v.persona_questions.length > 3) throw new Error('invalid_persona_questions');
    for (const q of v.persona_questions) {
      if (!exactKeys(q, ['target', 'question']) || !known.includes(q.target) || seen.has(q.target)
        || !questionText(q.question, DEBATE.ask_max_chars) || texts.has(q.question.trim())) throw new Error('invalid_persona_question');
      seen.add(q.target); texts.add(q.question.trim());
    }
    v.persona_questions = v.persona_questions.filter(q => active.includes(q.target)).map(q => ({ ...q, question: q.question.trim() }));
    if (!v.persona_questions.length) v.next_step = 'answer';
  }
  return v;
}

// 正本のスキーマは変えず、利用者への確認を許可しない入口だけnext_stepを絞る。
function judgementFormat(allowUser) {
  if (allowUser) return DEBATE.format;
  const format = JSON.parse(JSON.stringify(DEBATE.format));
  format.json_schema.schema.properties.next_step = { type: 'string', enum: ['answer', 'ask_personas'] };
  return format;
}

// 判定と質問を1コールで生成する。形式不正・HTTP失敗時だけ別会社へ1回切り替える。
// 呼び出し元の同じ20秒のsignalを使い、切替時に締切を延ばさない。
async function fetchJudgement(env, { system, input, active, allowUser = false }, signal, log) {
  const format = judgementFormat(allowUser);
  for (const cfg of [DEFAULTS.models.judge, DEFAULTS.models.judge_fallback]) {
    if (signal.aborted) return null;
    try {
      const res = await callModel({
        env, cfg, stream: false, signal, response_format: format,
        messages: [{ role: 'system', content: system }, { role: 'user', content: input }],
      });
      if (!res.ok) { await res.body?.cancel(); throw new Error(`HTTP ${res.status}`); }
      const choice = (await res.json()).choices?.[0] || {};
      if (choice.finish_reason !== 'stop') throw new Error(`finish_reason=${choice.finish_reason}`);
      return parseJudgement(choice.message?.content || '', active, allowUser);
    } catch (e) {
      log('debate', 'judge', cfg.provider, 'failed', e && (e.name || e.message));
    }
  }
  return null;
}

// --- 人格カード：サイト本文から自動生成した JSON を取り、人格の system プロンプトに足す ---
// isolate 内に保持する。起動直後はデプロイ時に同梱したカードで答えつつ、裏で最新を取りに行く。
// 取得できないときは直近のカード（同梱分を含む）のまま動くので、カード無し＝固定プロンプトだけで
// 答えることは、同梱分まで空のときを除いて起きない。カードが無くても会話は止めない。
//   expiresAt: 次に取り直す時刻。4枚そろえば ttl_ms 後、欠けや失敗なら retry_ms 後（起動時は 0 ＝すぐ取り直す）
//   refreshing: 裏での取り直しが進行中か（同時に来たリクエストが重ねて取りに行かないため）。
//     取得中の Promise は複数のリクエストで共有しない。先に来たリクエストが待たずに終わる（429 で返す等）と
//     取得が打ち切られ、共有して待つ側が止まりうるため。手元に同梱のカードがあるので、待つ必要もない。

// JSON（data/magi-context.json の形）から、人格ごとのカードを取り出す。1枚も無ければ null
function cardsFrom(data) {
  const cards = {};
  for (const [codename, v] of Object.entries((data && data.personas) || {})) {
    if (v && typeof v.card === 'string' && v.card.trim()) cards[codename] = v.card.trim().slice(0, PERSONA_CONTEXT.max_chars);
  }
  return Object.keys(cards).length ? cards : null;
}

const personaCards = { cards: cardsFrom(bundledContext), expiresAt: 0, refreshing: false };

async function refreshPersonaCards(log) {
  let cards = null;
  try {
    cards = await withTimeout(PERSONA_CONTEXT.fetch_timeout_ms, async (signal) => {
      const res = await fetch(PERSONA_CONTEXT.url, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // JSON として読めるかと、カードの有無で判定する
      const fetched = cardsFrom(await res.json());
      if (!fetched) throw new Error('no cards in JSON');
      return fetched;
    });
    log('persona_context', `cards=${Object.keys(cards).length}`);
  } catch (e) {
    cards = null;
    log('persona_context', 'failed', e && e.message);
  }
  // 人格ごとに上書きする。失敗・空の JSON・一部の人格が欠けた JSON でも、欠けた人格は
  // 直近のカードを保つ（まるごと置き換えると、欠けた人格だけ固定プロンプトに戻ってしまう）
  // そろうべきカードは3人格と統合人格の4枚
  const missing = cards ? [...PERSONAS.map(p => p.codename), SYNTHESIZER.codename].filter(c => !cards[c]) : [];
  if (missing.length) log('persona_context', 'missing', missing.join(','));
  const complete = !!cards && !missing.length;
  personaCards.expiresAt = Date.now() + (complete ? PERSONA_CONTEXT.ttl_ms : PERSONA_CONTEXT.retry_ms);
  if (cards) personaCards.cards = { ...personaCards.cards, ...cards };
  return personaCards.cards;
}

// 会話1回ぶんのカードを返す。期限切れでも手元にカードがあれば、それを返して裏で取り直す
// （会話を取得待ちにしない）。手元に何も無いとき（同梱分まで空のとき）だけ取得を待つ。
function getPersonaCards(ctx, log) {
  if (Date.now() < personaCards.expiresAt) return Promise.resolve(personaCards.cards);
  if (!personaCards.cards) return refreshPersonaCards(log);
  if (!personaCards.refreshing) {
    personaCards.refreshing = true;
    ctx.waitUntil(refreshPersonaCards(log).finally(() => { personaCards.refreshing = false; }));
  }
  return Promise.resolve(personaCards.cards);
}

const withCard = (p, cards, header = PERSONA_CONTEXT.header) => (cards && cards[p.codename])
  ? { ...p, system_prompt: `${p.system_prompt}\n\n${header}\n${cards[p.codename]}` }
  : p;

// 統合の本文と正常な終端の両方を確認する。EOF だけでは成功にしない。
async function readSynthesis(body, send, provider, signal) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '', answer = '', finished = false, finishReason = null;
  const line = (raw) => {
    if (!raw.startsWith('data:')) return;
    const { done, finish, delta } = streamEvent(provider, raw.slice(5).trim());
    if (finish) finishReason = finish;
    if (done) finished = true;
    if (typeof delta === 'string' && delta) { answer += delta; send('integrated', { delta }); }
  };
  const stop = () => { reader.cancel().catch(() => {}); };
  if (signal) { if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true }); }
  try {
    while (!finished) {
      const { done, value } = await reader.read();
      if (done) { if (buf.trim()) line(buf.trim()); break; }
      buf += dec.decode(value, { stream: true });
      let nl;
      while (!finished && (nl = buf.indexOf('\n')) >= 0) {
        line(buf.slice(0, nl).trim());
        buf = buf.slice(nl + 1);
      }
    }
    if (signal?.aborted) throw stageError('synthesizer_call', 'cancelled', '統合応答が中断されました', { retryable: true });
    if (!finished || finishReason !== 'stop') throw stageError('synthesizer_call', 'incomplete_output', '統合応答が最後まで生成されませんでした', { retryable: true });
    if (!answer.trim()) throw stageError('synthesizer_call', 'empty_output', '統合人格が空の応答を返しました', { retryable: true });
    return answer;
  } finally { signal?.removeEventListener('abort', stop); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

// 本文を利用者へ流さない呼び出し（404の③は最後に JSON でまとめて返す）の送り口。
const discardEvents = () => {};

// 統合は本文を送る前だけ、もう一方の会社で一度答え直す。用途ごとの呼び出しにも同じ規則を使う。
// 送り口が discardEvents なら何も見せていないので、本文の途中で失敗しても答え直す。
async function synthesize({ env, messages, theme, signal, send, log, reasoningEffort }) {
  const { synthesizer: light, synthesizer_dark: dark } = DEFAULTS.models;
  const [primary, alternate] = theme === 'dark' ? [dark, light] : [light, dark];
  let emitted = false;
  for (const [attempt, model] of [primary, alternate].entries()) {
    const cfg = reasoningEffort ? { ...model, reasoning_effort: reasoningEffort } : model;
    if (signal?.aborted) throw stageError('synthesizer_call', 'cancelled', '統合応答が中断されました', { retryable: false });
    try {
      return await withTimeout(DEFAULTS.timeouts.synthesizer_ms, async parent => {
        const { ac, detach } = linkAbort(parent);
        let noText = false;
        let first = setTimeout(() => { noText = true; ac.abort(); }, DEFAULTS.timeouts.synthesis_first_text_ms);
        const push = (event, value) => {
          if (ac.signal.aborted) return;
          if (event === 'integrated' && value.delta) { emitted = send !== discardEvents; clearTimeout(first); first = null; }
          send(event, value);
        };
        try {
          log('synthesizer_call', 'start', cfg.provider);
          const res = await callModel({ env, cfg, stream: true, signal: ac.signal, messages });
          if (ac.signal.aborted) { await res.body?.cancel().catch(() => {}); throw new Error('cancelled'); }
          if (!res.ok) {
            // 読まない本文は中止より先に閉じる（中止の後だと閉じる処理の失敗が誰にも拾われない）
            res.body?.cancel().catch(() => {}); ac.abort();
            throw stageError('synthesizer_call', `upstream_http_${res.status}`, `統合人格の呼び出しが失敗しました (HTTP ${res.status})`, { retryable: res.status >= 500 });
          }
          return await readSynthesis(res.body, push, cfg.provider, ac.signal);
        } catch (error) {
          if (noText) throw stageError('synthesizer_call', 'first_text_timeout', '統合応答の本文が始まりませんでした', { retryable: true });
          throw error;
        } finally { clearTimeout(first); detach(); ac.abort(); }
      }, signal);
    } catch (error) {
      if (attempt || emitted || signal?.aborted) throw error;
      log('fallback', 'synthesizer', cfg.provider, error.envelope?.code || error.name || 'failed');
    }
  }
}

// ページ選びは呼び出しの開始から chat_wait_ms だけ待ち、間に合わなければ手元の結果（fallback）のまま進む。
const awaitPageChoice = (pagesPromise, fallback, signal) =>
  searchDeadline(SITE_SEARCH.chat_wait_ms, () => pagesPromise, signal).catch(() => fallback);

// いま開いているページへのリンクは出さない（ページ選びにも選ばないよう伝えてあるが、念のため）。
// 除いて空になったら「見当たらない」として扱う（結果がある扱いのまま空の一覧を渡さない）
function withoutCurrentPage(choice, page) {
  if (!choice || !page) return choice;
  const results = choice.results.filter(p => p.url !== page);
  return { ...choice, results, status: choice.status === 'results' && !results.length ? 'no_results' : choice.status };
}

// 事実回答の入力は、本番と保存済み出典の評価で同じ順序から作る。
function factAnswerMessages({ cards, messages, langNote, theme = null, guide = null, personalization = null,
  pageChoice = null, siteOnly = false, research = false }) {
  return [
    { role: 'system', content: withLangNote(withCard(research ? { ...SYNTHESIZER, system_prompt: RESEARCH.system_prompt } : SYNTHESIZER,
      cards, PERSONA_CONTEXT.synth_header).system_prompt, langNote) },
    ...(theme && SYNTH_BIAS[theme] ? [{ role: 'system', content: SYNTH_BIAS[theme] }] : []),
    ...(guide ? [{ role: 'system', content: guide.synth }] : []),
    ...(pageChoice ? [{ role: 'system', content: siteSelectionNote(pageChoice) }] : []),
    { role: 'system', content: FACT_ANSWER.prompt + personalizationNote(personalization) },
    ...(siteOnly ? [{ role: 'system', content: FACT_ANSWER.site_prompt }] : []),
    { role: 'system', content: SYNTHESIZER.voice_rules },
    ...messages,
  ];
}

// 討議メモを渡さず、本人のカード・言語・検証済みページと会話だけで答える。
async function runFactAnswer({ upstream, cards, messages, langNote, theme = null, guide = null,
  pageChoice = null, pagesPromise = null, page = null, siteOnly = false, research = false, personalization = null, replyLanguage = null, ip = null, place = null, signal, send, log }) {
  // ページ選びの待ちは呼び出しの開始から数える。Webの回答はページの一覧を使わないので、待たずに始めてリンクだけ後で出す。
  const pagesWait = pagesPromise ? awaitPageChoice(pagesPromise, pageChoice, signal) : null;
  if (pagesWait && !research) pageChoice = await pagesWait;
  if (signal?.aborted) throw searchFailure('cancelled');
  const options = { cards, messages, langNote, theme, guide, pageChoice: withoutCurrentPage(pageChoice, page), siteOnly, personalization };
  const input = factAnswerMessages({ ...options, research });
  const answer = research
    ? await researchAnswer({ upstream, messages: input, fallbackMessages: factAnswerMessages(options), theme, replyLanguage, ip, place, signal, send, log })
    : await synthesize({ env: upstream, messages: input, theme, signal, send, log, reasoningEffort: FACT_ANSWER.reasoning_effort });
  if (pagesWait && research) pageChoice = await pagesWait;
  pageChoice = withoutCurrentPage(pageChoice, page);
  if (pageChoice?.results.length && !signal?.aborted) send('pages', chatPageEvent(pageChoice));
  return answer;
}

// 利用者の推定所在地（Cloudflare が通信元の IP から推定した市・地域・国）。精度は市や県の単位で、外れることがある。
// Web で調べるときだけ、場所の指定が無い質問（天気・近くの店など）の前提に使う。GPS は使わない
function requestPlace(request) {
  const place = placeFields(request && request.cf || {});
  return place.country && (place.city || place.region) ? place : null;
}

// 市・地域・国・タイムゾーンのうち、形の正しいものだけを返す（推定所在地と端末の所在地で共通）
function placeFields(value) {
  const place = {};
  for (const key of ['city', 'region']) {
    if (typeof value[key] === 'string' && /^[\p{L}\p{M}0-9 .'’-]{1,60}$/u.test(value[key].trim())) place[key] = value[key].trim();
  }
  if (typeof value.country === 'string' && /^[A-Z]{2}$/.test(value.country)) place.country = value.country;
  if (typeof value.timezone === 'string' && /^[A-Za-z_]+(?:\/[A-Za-z_+-]+){1,2}$/.test(value.timezone)) place.timezone = value.timezone;
  return place;
}

// 座標は検索用の構造化データに限定する。表示名に混ぜず、通常会話・保存用の履歴にも足さない。
function devicePlace(value, now = Date.now()) {
  const fresh = value && (Object.hasOwn(value, 'age_ms')
    ? Number.isFinite(value.age_ms) && value.age_ms >= 0 && value.age_ms <= 300000
    : Number.isFinite(value.timestamp) && now - value.timestamp <= 300000 && value.timestamp <= now + 10000);
  if (!value || typeof value !== 'object' || !Number.isFinite(value.latitude) || Math.abs(value.latitude) > 90
    || !Number.isFinite(value.longitude) || Math.abs(value.longitude) > 180
    || !Number.isFinite(value.accuracy) || value.accuracy < 0 || value.accuracy > 10000
    || !fresh) return null;
  return { source: 'device', coordinates: { latitude: Math.round(value.latitude * 10000) / 10000,
    longitude: Math.round(value.longitude * 10000) / 10000, accuracy: Math.ceil(value.accuracy) }, ...placeFields(value) };
}

// Web検索の本文には通常統合と同じ会話・画像を渡す。印や出典の履歴はrequestBodyで落とす。
function researchRequestBody(cfg, messages, place = null) {
  // 推定所在地が使えない・無効の場合は、検索の会社にも所在地を指定しない。
  const location = place && place.country ? { type: 'approximate', country: place.country, ...(place.city ? { city: place.city } : {}),
    ...(place.region ? { region: place.region } : {}), timezone: place.timezone || RESEARCH.location.timezone } : null;
  if (cfg.provider === 'anthropic') return { ...requestBody(cfg, { messages, stream: true }),
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: RESEARCH.max_uses, ...(location ? { user_location: location } : {}) },
      { ...RESEARCH.fetch, name: 'web_fetch', allowed_callers: ['direct'], use_cache: false, citations: { enabled: true } }] };
  const instructions = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const input = messages.filter(m => m.role !== 'system').map(({ role, content }) => ({ role,
    content: (typeof content === 'string' ? [{ type: 'text', text: content }] : content).map(part => part.type === 'text'
      ? { type: role === 'assistant' ? 'output_text' : 'input_text', text: part.text }
      : { type: 'input_image', image_url: part.image_url.url }) }));
  return { model: cfg.model, stream: true, store: false, instructions, input,
    reasoning: { effort: cfg.reasoning_effort }, max_output_tokens: cfg.max_tokens, max_tool_calls: RESEARCH.max_uses,
    tools: [{ type: 'web_search', ...(location ? { user_location: location } : {}) }], tool_choice: 'required', include: ['web_search_call.action.sources'] };
}

// pause_turnで送り返すassistantのcontentを、届いたブロックと差分からそのまま復元する。
async function readResearchResponse(body, reader, provider, signal) {
  const input = body.getReader(), decoder = new TextDecoder(), blocks = new Map(), partial = new Map();
  const cancel = () => { input.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  let buffer = '';
  const frame = text => {
    const data = text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    const e = JSON.parse(data);
    if (provider === 'anthropic') {
      if (e.type === 'content_block_start') blocks.set(e.index, JSON.parse(JSON.stringify(e.content_block)));
      if (e.type === 'content_block_delta') {
        const b = blocks.get(e.index), d = e.delta;
        if (!b) throw new Error('invalid_research_block');
        if (d.type === 'text_delta') b.text = (b.text || '') + d.text;
        if (d.type === 'thinking_delta') b.thinking = (b.thinking || '') + d.thinking;
        if (d.type === 'signature_delta') b.signature = (b.signature || '') + d.signature;
        if (d.type === 'citations_delta') { b.citations ||= []; b.citations.push(d.citation); }
        if (d.type === 'input_json_delta') partial.set(e.index, (partial.get(e.index) || '') + d.partial_json);
      }
      if (e.type === 'content_block_stop' && partial.has(e.index)) blocks.get(e.index).input = JSON.parse(partial.get(e.index));
    }
    reader.push(e);
  };
  const drain = () => { let end; while ((end = buffer.indexOf('\n\n')) >= 0) { frame(buffer.slice(0, end)); buffer = buffer.slice(end + 2); } };
  try {
    while (true) {
      if (signal.aborted) throw searchFailure('cancelled');
      const next = await input.read();
      if (signal.aborted) throw searchFailure('cancelled');
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true }).replace(/\r/g, ''); drain();
    }
    buffer += decoder.decode();
    if (buffer.trim()) { buffer += '\n\n'; drain(); }
    return [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, block]) => block);
  } finally { signal.removeEventListener('abort', cancel); input.cancel().catch(() => {}); input.releaseLock(); }
}

// 本文を JavaScript で描くページ（気象庁の台風・天気など）は HTML に本文が無い。取れた本文がごく少ない HTML の出典を
// 1回答につき1件だけ、Cloudflare Browser Run の /markdown で描画して本文を取り直す（RESEARCH.render）。
// 無料枠は全体で10秒に1回・1日10分なので、429・上限・失敗は今までどおり読めなかった出典のまま進む。
// 描画するのは researchSourceUrl を通った公開ページの URL だけで、利用者の質問や回答は送らない
async function renderThinSource(env, evidence, signal, log) {
  const cfg = RESEARCH.render;
  if (!env.BROWSER_RUN_API_TOKEN || !env.BROWSER_RUN_ACCOUNT_ID) return;
  const thin = evidence.filter(e => e.html && e.textChars < cfg.min_chars).sort((a, b) => a.textChars - b.textChars)[0];
  if (!thin) return;
  if (env.DB && await countUp(env.DB, 'render:global', utcDay(), cfg.daily_limit) == null) { log('research', 'render_limit'); return; }
  try {
    const markdown = await searchDeadline(cfg.timeout_ms, async stop => {
      const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.BROWSER_RUN_ACCOUNT_ID}/browser-run/markdown`, {
        method: 'POST', signal: stop, headers: { Authorization: `Bearer ${env.BROWSER_RUN_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: thin.finalUrl || thin.url, gotoOptions: { waitUntil: 'networkidle2', timeout: cfg.page_ms }, rejectRequestPattern: cfg.reject_patterns }),
      });
      if (!res.ok) { res.body?.cancel().catch(() => {}); throw new Error('render_http_' + res.status); }
      const data = JSON.parse(await readLimited(res, cfg.max_bytes, stop, cfg.timeout_ms));
      return data && data.success === true && typeof data.result === 'string' ? data.result : null;
    }, signal);
    if (!markdown) return;
    // 見出しの前置き（front matter）・画像・リンク先の URL は本文にしない（リンクは文字だけ残す）
    const text = markdown.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    const content = researchSourceBlocks(text, false);
    const chars = content.blocks.reduce((n, b) => n + b.text.length, 0);
    if (chars <= thin.textChars) return;
    Object.assign(thin, content, { readable: true, textChars: chars, rendered: true });
    log('research', 'rendered', chars);
  } catch (e) {
    if (signal.aborted) throw searchFailure('cancelled');
    log('research', 'render_failed', e && (e.envelope?.code || e.message));
  }
}

async function verifyResearchAnswer({upstream, messages, verifiedNow, result, cfg, replyLanguage, place = null, signal, log = () => {}}) {
  const evidence = (await Promise.all(result.sources.items.map(item => readResearchSource(item, signal)))).filter(e => e.allowed);
  if (signal.aborted) throw searchFailure('cancelled');
  if (!evidence.length) throw stageError('upstream','research_no_public_source','公開された根拠を確認できませんでした',{retryable:true});
  await renderThinSource(upstream, evidence, signal, log);
  // アイコンは照合と並行して取り、照合が終わった時点で取れている分だけ付ける。取り残しは照合の終わりで止める
  const { ac: iconStop, detach: detachIcons } = linkAbort(signal);
  const iconFor = startSourceIcons(evidence, iconStop.signal);
  try { return withSourceIcons(await checkResearchEvidence({upstream, messages, verifiedNow, result, cfg, replyLanguage, place, signal, evidence}), iconFor); }
  finally { iconStop.abort(); detachIcons(); }
}

function withSourceIcons(verified, iconFor) {
  for (const item of verified.sources.items) { const icon = iconFor(item.url); if (icon) item.icon = icon; }
  return verified;
}

async function checkResearchEvidence({upstream, messages, verifiedNow, result, cfg, replyLanguage, place = null, signal, evidence}) {
  // 照合の材料からアイコンの候補と内部の印を外す（モデルへ送るのは出典の番号・題名・URL・本文の区画だけ）
  evidence = evidence.map(({icons, html, textChars, rendered, finalUrl, ...e}) => e);
  const limit = {bytes:RESEARCH.verify.reply_bytes, ms:RESEARCH.timeout_ms};
  const res = await callModel({env:upstream, ...researchVerificationRequest(cfg,messages,verifiedNow,result,evidence,replyLanguage,place),
    stream:false, signal, replyLimit:limit});
  if (!res.ok) {
    res.body?.cancel().catch(() => {});
    throw stageError('upstream','research_verification_http_'+res.status,'Web回答の根拠を確認できませんでした',{retryable:true});
  }
  const raw = await readLimited(res,limit.bytes,signal,limit.ms);
  if (signal.aborted) throw searchFailure('cancelled');
  const choice = JSON.parse(raw).choices?.[0], content = choice?.message?.content;
  if (choice?.finish_reason !== 'stop' || typeof content !== 'string') throw stageError('upstream','research_verification_incomplete','Web回答の根拠を確認できませんでした',{retryable:true});
  return verifiedResearchResult(JSON.parse(content),evidence,replyLanguage);
}

// fallbackMessagesはWebの指示を含まない事実回答の入力。Webを使えないときはこちらで答える。
async function researchAnswer({ upstream, messages, fallbackMessages = messages, theme, replyLanguage, ip, place = null, signal, send, log }) {
  const note = RESEARCH.limited_note[replyLanguage?.code] || RESEARCH.limited_note.en;
  const withoutWeb = async reason => {
    if (signal.aborted) throw searchFailure('cancelled');
    log('research', reason);
    send('integrated', { delta: note });
    return note + await synthesize({ env: upstream, messages: fallbackMessages, theme, signal, send, log, reasoningEffort: FACT_ANSWER.reasoning_effort });
  };
  if (upstream.DB) {
    const day = utcDay();
    if (signal.aborted) throw searchFailure('cancelled');
    if (await countUp(upstream.DB, 'research:' + ip, day, RESEARCH.daily_limit) == null) return withoutWeb('ip_limit');
    if (signal.aborted) throw searchFailure('cancelled');
    if (await countUp(upstream.DB, 'research:global', day, RESEARCH.global_daily_limit) == null) return withoutWeb('global_limit');
  }
  const verifiedNow = new Date(), verifiedAt = verifiedNow.toISOString();
  // 確認時刻はモデルに作らせず、本文と同じ履歴へ保存する。出典の時刻とは別。
  const checkedAt = (RESEARCH.checked_label[replyLanguage?.code] || RESEARCH.checked_label.en) + verifiedAt + ' (UTC)\n';
  const input = researchMessages(messages, verifiedNow, place);
  const { synthesizer: light, synthesizer_dark: dark } = DEFAULTS.models;
  const primary = RESEARCH.primary_provider[theme === 'dark' ? 'dark' : 'light'];
  let emitted = false;
  for (const [attempt, model] of (primary === 'anthropic' ? [dark, light] : [light, dark]).entries()) {
    const cfg = { ...model, reasoning_effort: RESEARCH.reasoning_effort };
    if (signal.aborted) throw searchFailure('cancelled');
    try {
      const result = await withTimeout(RESEARCH.timeout_ms, async stop => {
        // 原案を表示する前に出典の実本文と照合する。未確認の値を先にストリームへ漏らさない。
        const reader = researchReader(cfg.provider, () => {}, RESEARCH.sources_max);
        let body = researchRequestBody(cfg, input, place);
        for (let paused = 0; ; paused++) {
          if (stop.aborted) throw searchFailure('cancelled');
          const res = await postUpstream(upstream, cfg, { body, stream: true, signal: stop,
            endpoint: cfg.provider === 'openai' ? RESEARCH.openai_endpoint : PROVIDERS.anthropic.endpoint,
            missingKey: () => stageError('upstream', 'missing_api_key', 'Web検索のキーが未設定です', { retryable: false }) });
          if (!res.ok) {
            res.body?.cancel().catch(() => {});
            throw stageError('upstream', 'research_http_' + res.status, 'Web検索に失敗しました', { retryable: true });
          }
          const content = await readResearchResponse(res.body, reader, cfg.provider, stop);
          if (!reader.paused) return verifyResearchAnswer({upstream,messages:input,verifiedNow,result:reader.finish(),cfg,replyLanguage,place,signal:stop,log});
          if (paused >= RESEARCH.max_pause_turns) throw stageError('upstream', 'research_pause_limit', 'Web検索が完了しませんでした', { retryable: true });
          body = { ...body, messages: [...body.messages, { role: 'assistant', content }] };
          reader.beginTurn();
        }
      }, signal);
      if (signal.aborted) throw searchFailure('cancelled');
      emitted = true;
      // 推定所在地を前提に答えたときは、確認日時の次の行にその前提を出す（違えば場所を書いて聞き直せるように）
      const checked = checkedAt + (result.placeUsed && place
        ? researchPlaceLabel(place, replyLanguage?.code) + '\n' : '') + '\n';
      send('integrated',{delta:checked});
      if (signal.aborted) throw searchFailure('cancelled');
      send('integrated',{delta:result.text});
      if (signal.aborted) throw searchFailure('cancelled');
      if (result.sources.items.length) send('sources', { ...result.sources, marks: result.sources.marks.map(m => ({ ...m, at: m.at + checked.length })) });
      log('research', 'ok', cfg.provider, attempt, result.sources.items.length);
      return checked + result.text;
    } catch (error) {
      if (!signal.aborted && error.upstreamError && upstream.onUpstreamError) {
        const body = JSON.stringify({error:error.upstreamError});
        if (isBillingFailure(200, body, cfg.provider)) {
          await upstream.onUpstreamError(cfg.provider, new Response(body, {headers:{'Content-Type':'application/json'}}), {signal});
        }
      }
      if (signal.aborted || emitted) {
        if (error.name === 'ResearchStreamError') throw stageError('upstream', 'research_' + error.code, 'Web検索の回答を完了できませんでした', { retryable: true });
        throw error;
      }
      log('research', 'failed', cfg.provider, error.envelope?.code || error.code || error.name);
      if (attempt) return withoutWeb('both_failed');
    }
  }
}

// 悪意への返しには、ユーザーの本文・会話履歴・入力由来の言語sampleを渡さない。
// 両社失敗の固定文も、本文が始まる前だけ使う。closed/doneは正常完了後に呼び出し元が送る。
async function replyToMalice({ env, cards, classified, uiLanguage, theme, signal, send, log }) {
  const p = withCard({ ...SYNTHESIZER, system_prompt: MALICE_REPLY.system_prompt }, cards, PERSONA_CONTEXT.synth_header);
  const language = classified.classification.reply_language;
  const replyCode = language.code === 'other' ? uiLanguage : language.code;
  const langNote = language.code === 'other' ? languageNote({ code: replyCode }) : classified.langNote;
  let emitted = false;
  const push = (event, data) => { if (event === 'integrated' && data.delta) emitted = true; send(event, data); };
  try {
    await synthesize({ env, theme, signal, send: push, log, reasoningEffort: 'none',
      messages: [{ role: 'system', content: withLangNote(p.system_prompt + '\n\n' + MALICE_REPLY.output_rules, langNote) },
        { role: 'user', content: MALICE_REPLY.directions[classified.malice] }] });
  } catch (err) {
    if (emitted || signal.aborted) throw err;
    send('integrated', { delta: MALICE_REPLY.fallback[Object.hasOwn(MALICE_REPLY.fallback, replyCode) ? replyCode : 'en'] });
  }
}

// 非必須の役割は、HTTPの失敗と、応答の前の失敗（鍵の未設定・通信の失敗など）のとき、別の会社の答え直し先
// （DEFAULTS.models.aux_fallback）で一度呼び直す。利用者の停止・期限では呼び直さず、元のsignalの期限も延ばさない。
// 200で届いた応答（拒否・途中切れ・本文の解析の失敗）は呼び出し側の判定に任せる。
async function callAuxModel(options, log, purpose) {
  const fallback = DEFAULTS.models.aux_fallback;
  if (options.cfg.provider === fallback.provider) return callModel(options);
  // 複製したエラー本文が止まっても、元のHTTP接続を切ってから答え直す。
  // 非streamの成功はcallModel内で読み終わっているので、ここで接続を片付けられる。
  const { ac, detach } = linkAbort(options.signal);
  let failure;
  try {
    const res = await callModel({ ...options, signal: ac.signal });
    if (res.ok || options.signal?.aborted) return res;
    // 読まない本文は中止より先に閉じる
    res.body?.cancel().catch(() => {});
    failure = `http_${res.status}`;
  } catch (error) {
    // 解析の失敗は200の本文が壊れていたもの（callModel が Anthropic の応答を読み替えるとき）
    if (options.signal?.aborted || error.name === 'SyntaxError') throw error;
    failure = error.envelope?.code || error.name || 'failed';
  } finally { detach(); ac.abort(); }
  log('fallback', purpose, options.cfg.provider, failure);
  return callModel({ ...options, cfg: { ...fallback, max_tokens: options.cfg.max_tokens } });
}

// 処理全体にタイムアウトを掛け、成功・失敗のどちらでもタイマーを解除する。
// ストリームは fetch の完了だけでなく、本文を読み終わるまでこの中で扱う。
// stop（利用者が止めた・接続が切れた）を渡すと、時間切れの前でもそこで止める。
async function withTimeout(ms, run, stop) {
  const { ac, detach } = linkAbort(stop);
  const id = setTimeout(() => ac.abort(), ms);
  try { return await run(ac.signal); }
  finally { clearTimeout(id); detach(); }
}

// 親の signal（省略できる）が止まったら一緒に止まる AbortController。detach は親への登録だけを外し、子は止めない
function linkAbort(parent) {
  const ac = new AbortController(), abort = () => ac.abort();
  if (parent?.aborted) ac.abort(); else parent?.addEventListener('abort', abort, { once: true });
  return { ac, detach: () => parent?.removeEventListener('abort', abort) };
}

// リアクションの登録・取り消し。認可は入口で共通に確認する。
async function handleReaction(request, env, { requestId, cors, log }) {
  let body;
  try { body = await readJsonLimited(request, DEFAULTS.reactions.max_request_bytes); }
  catch (err) { return inputError(err, requestId, cors); }

  const op = body.op === 'remove' ? 'remove' : 'add';
  if (body.conversation_mode === 'temporary') return httpError(403, { stage: 'bad_request', code: 'temporary_reaction_forbidden', message: '一時チャットは評価できません', retryable: false }, requestId, cors);
  const target = typeof body.target === 'string' ? body.target.slice(0, 40) : '';
  if (![...PERSONAS.map(p => p.codename), 'integrated'].includes(target)) {
    return httpError(400, { stage: 'bad_request', code: 'invalid_target', message: 'リアクション対象が不正です', retryable: false }, requestId, cors);
  }
  if (!env.DB) {
    log('reaction', 'skipped (no DB binding)');
    return httpError(500, { stage: 'internal', code: 'no_db', message: 'DB binding がありません', retryable: false }, requestId, cors);
  }

  const ip = requestIP(request);
  const now = new Date().toISOString();
  try { await consumeReactionLimit(env.DB, ip, now); }
  catch (err) { return httpError(err.envelope?.http_status || 500, toEnvelope(err, requestId), requestId, cors); }

  // 取り消し：登録者だけが持つトークンのハッシュも照合する。IP の変化では所有権を失わない。
  if (op === 'remove') {
    const id = Number(body.id);
    const token = typeof body.delete_token === 'string' ? body.delete_token : '';
    if (!Number.isSafeInteger(id) || id < 1 || !/^[a-f0-9]{64}$/.test(token)) {
      return httpError(400, { stage: 'bad_request', code: 'invalid_remove', message: 'id と登録時の削除トークンが必要です', retryable: false }, requestId, cors);
    }
    try {
      const res = await env.DB.prepare(`DELETE FROM reactions WHERE id = ?1 AND target = ?2 AND delete_token_hash = ?3`).bind(id, target, await sha256(token)).run();
      const deleted = (res.meta && res.meta.changes) || 0;
      log('reaction', 'removed', target, id, `changes=${deleted}`);
      return jsonResponse({ ok: true, deleted, request_id: requestId }, cors);
    } catch (err) {
      log('reaction', 'db_error (remove)', err.message);
      return httpError(500, { stage: 'internal', code: 'reaction_db_error', message: 'リアクションの取り消しに失敗しました', detail: String(err.message).slice(0, 200), retryable: true }, requestId, cors);
    }
  }

  // 登録
  const reaction = typeof body.reaction === 'string' ? body.reaction.slice(0, 64) : '';
  const reqText = typeof body.request === 'string' ? body.request.slice(0, 8000) : '';
  const resText = typeof body.response === 'string' ? body.response.slice(0, 16000) : '';
  if (!reaction || !resText) {
    return httpError(400, { stage: 'bad_request', code: 'invalid_reaction', message: 'target, reaction, response は必須です', retryable: false }, requestId, cors);
  }
  try {
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
    const fingerprint = await sha256(JSON.stringify([target, reaction, reqText, resText]));
    const res = await env.DB.prepare(
      `INSERT INTO reactions (created_at, ip, target, reaction, request, response, delete_token_hash, fingerprint)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT(ip, fingerprint) DO NOTHING RETURNING id`
    ).bind(now, ip, target, reaction, reqText, resText, await sha256(token), fingerprint).first();
    // 重複時は元の登録者の ID・トークンを渡さない（共有 IP の別利用者にも取り消せない）。
    const id = res && res.id;
    log('reaction', target, reaction, `id=${id}`);
    return jsonResponse({ ok: true, ...(id ? { id, delete_token: token } : { duplicate: true }), request_id: requestId }, cors);
  } catch (err) {
    log('reaction', 'db_error', err.message);
    return httpError(500, { stage: 'internal', code: 'reaction_db_error', message: 'リアクションの保存に失敗しました', detail: String(err.message).slice(0, 200), retryable: true }, requestId, cors);
  }
}

// チャットの入力検証。会話処理に入る前に送信量と履歴を確定する。
function cleanShared(value) {
  if (value == null) return null;
  const invalid = () => { throw stageError('bad_request', 'invalid_shared', '共有資料の形式または長さが不正です', { retryable: false }); };
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['title', 'url', 'text'].includes(k))) invalid();
  const out = {};
  for (const [key, limit] of [['title', SHARED.title_max_chars], ['url', SHARED.url_max_chars], ['text', SHARED.text_max_chars]]) {
    if (typeof value[key] !== 'string' || value[key].length > limit) invalid();
    out[key] = value[key].replace(replyControls, '').trim();
  }
  if (!out.title || !out.text) invalid();
  if (out.url) {
    try { const url = new URL(out.url); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) invalid(); }
    catch (_) { invalid(); }
  }
  return out;
}
function sharedNote(shared) { return SHARED.header + '\n' + JSON.stringify(shared) + '\n【今回の質問】\n'; }

// parsed（省略できる）は WebSocket の入口で読んだ本文。上限はそちらで確かめてある
async function readChatInput(request, parsed = null) {
  const body = parsed || await readJsonLimited(request, DEFAULTS.input.max_request_bytes);
  const privacy = chatPrivacy(body);
  let messages = body.messages;
  const theme = (body.theme === 'light' || body.theme === 'dark') ? body.theme : null;
  const wantSuggest = body.suggest === true;
  const wantSitePages = body.site_pages === true;
  // 討議の回数を判定で増やすか（DEBATE）。付けない画面は2回で止める
  const adaptive = body.adaptive_debate === true;
  // いま開いているページ（トップページは '/'、アプリは 'app'）。送った画面だけにサイト案内を足す。
  // 値はサイトの索引を引くのに使うだけで、プロンプトには入れない。形が違えば送らなかったものとして扱う
  const page = typeof body.page === 'string' && body.page.length <= SITE_GUIDE.page_max_chars
    && (body.page === 'app' || (body.page.startsWith('/') && /^[a-z0-9/-]+$/i.test(body.page))) ? body.page : null;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw stageError('bad_request', 'invalid_messages', 'messages は1件以上の配列が必要です', { retryable: false });
  }
  // 検証の前に trim する（画像枚数の上限は実際に上流へ送るぶんに対して数える）
  if (messages.length > DEFAULTS.history_max_messages) messages = messages.slice(-DEFAULTS.history_max_messages);
  // content は文字列 or パート配列。本文と人格の過去の意見を正規化する
  const counters = { total: 0, imageBytes: 0, text: 0 };
  messages = messages.map(m => normaliseMessage(m, counters));
  if (privacy.personalization) checkText(JSON.stringify(privacy.personalization), 10000, counters);
  if (messages[messages.length - 1].role !== 'user') {
    throw stageError('bad_request', 'last_not_user', '最後の message は role:"user" である必要があります', { retryable: false });
  }
  // DJ の状況説明は本文に紛れ込ませず、専用の上限で検証してから先頭の質問へ添える。
  // 予測には添える前の会話と状況説明を別に渡す（ユーザーの発言に混ぜると、状況説明の回答ルールを予測がなぞる）
  // 出力の言語は状況説明を足す前の会話で決める（状況説明は日本語なので、足した後だと日本語に見える）
  const plainMessages = messages;
  const shared = cleanShared(body.shared);
  const newContract = body.classification_state === true;
  const factMode = newContract && body.fact_mode === true;
  const langNote = newContract ? null : replyLanguageNote(plainMessages);
  let context = null;
  if (body.context != null) {
    if (typeof body.context !== 'string') throw stageError('bad_request', 'invalid_context', 'context は文字列である必要があります', { retryable: false });
    checkText(body.context, DEFAULTS.input.context_max_chars, counters);
    context = body.context;
    const first = messages.findIndex(m => m.role === 'user');
    messages = messages.map((m, i) => i === first ? { ...m, content: prependText(context + '\n', m.content) } : m);
  }
  const entry = body.entry === 'dj-request' ? 'dj-request' : 'chat';
  const replyLanguage = newContract ? cleanReplyLanguage(body.reply_language) : null;
  const seed = newContract && !replyLanguage
    ? typeof body.language_seed === 'string' ? body.language_seed : classifySlice(contentText(plainMessages.find(m => m.role === 'user').content), INTENT_CLASSIFY.language_seed_max_chars)
    : null;
  if (seed !== null) checkText(seed, INTENT_CLASSIFY.language_seed_max_chars, counters);
  // 共有資料は最後の発言の頭に添える。討議・議題は状況説明なしの会話に添え、サイト検索の語には含めない。
  const withShared = list => shared ? list.map((m, i) => i === list.length - 1 ? { ...m, content: prependText(sharedNote(shared), m.content) } : m) : list;
  const searchText = contentText(messages.at(-1).content);
  return { messages: withShared(messages), plainMessages, discussMessages: withShared(plainMessages), searchText, context, langNote, theme, wantSuggest, wantSitePages, adaptive, page,
    ...privacy, locationEnabled: body.location_enabled !== false,
    devicePlace: body.location_enabled === false ? null : devicePlace(body.device_location),
    shared, newContract, factMode, clarify: newContract && body.clarify === true, magiPanel: body.magi_panel === true, entry, replyLanguage, seed, uiLanguage: body.ui_language === 'en' ? 'en' : 'ja' };
}

function siteSelectionNote(choice) {
  if (choice.status === 'failed') return SITE_SEARCH.failed_note;
  return SITE_SEARCH.synth_header + '\n' + SITE_SEARCH.answer_note + '\n' + JSON.stringify({
    // usageの無いページはJSON.stringifyが項目ごと落とす
    status: choice.status, pages: choice.results.map(({ title, description, url }) => ({ title, description, usage: SITE_SEARCH.usage[url] })),
  });
}

const notVotable = reason => ({ text: '', votable: false, reason });

async function createMotion(env, plainMessages, langNote, signal, log) {
  try {
    const last = plainMessages.at(-1), ref = plainMessages.slice(-3, -1);
    const reference = ref.length === 2 && ref[0].role === 'user' && ref[1].role === 'assistant'
      && ref.every(m => contentText(m.content).length <= MAGI_MODE.motion_reference_max_chars)
      ? ref.map(m => ({ role: m.role, text: contentText(m.content) })) : [];
    const res = await callAuxModel({ env, cfg: DEFAULTS.models.motion, stream: false, signal, response_format: MAGI_MODE.motion_format,
      messages: [{ role: 'system', content: withLangNote(MAGI_MODE.motion_prompt, langNote) },
        { role: 'user', content: JSON.stringify({ latest: contentText(last.content), has_image: !!contentImages(last.content).length, reference }) }] }, log, 'motion');
    if (!res.ok) throw new Error('motion_http');
    const c = (await res.json()).choices?.[0];
    if (c?.finish_reason !== 'stop') throw new Error('motion_incomplete');
    const v = JSON.parse(c.message.content);
    if (v.votable === false) return notVotable('not_votable');
    const text = v.votable === true && cleanMotion(v.motion);
    if (!text) throw new Error('invalid_motion');
    return { text, votable: true };
  } catch (e) { log('motion', 'failed', e.name); return notVotable('failed'); }
}

// 討議の第2回：他の人格の初回意見を踏まえて、自分の考えを更新させる
function rebuttalText(lastUser, motion, own, others) {
  // 寄り添い寄りのモデルは他の意見に流されやすいので、賛同するにも自分の理由を求める
  return `${lastUser}${motion ? `\n【共通の議題】${motion}\n${MAGI_MODE.persona_rounds.debate}` : ''}\n\n[あなたの初回意見]\n${own}\n\n[討議メモ：他の人格の初回意見は以下。これを踏まえ、賛同・反論・補強のいずれかで自分の考えを更新せよ。賛同するなら自分の理由で述べ、自分の関心と価値観は手放さない。単なる繰り返しは避ける]\n${others}`;
}

// 討議の第3回以降：統合人格の問いに答えさせる
function followupText(lastUser, motion, round, own, others, ask) {
  return `${lastUser}${motion ? `\n【共通の議題】${motion}\n${MAGI_MODE.persona_rounds.followup}` : ''}\n\n[あなたのこれまでの意見]\n${own}`
    + (others ? `\n\n[他の人格のいまの意見]\n${others}` : '')
    + `\n\n[3人の議論をまとめる Shinya Takeda から、あなたへの問い（第${round}回）]\n${ask}`
    + '\n\n[この問いに、自分の関心と価値観から答えよ。考えが変わったなら変わったと言い、変わらないなら理由を足す。これまでの意見の繰り返しは避ける]';
}

// 第round回の前に討議を続けるかを決める判定のsystem。統合人格のカードと入力条件の検査を付ける
function judgeSystemPrompt({ motion, round, maxRounds, clarification, cards, langNote }) {
  const prompt = (motion ? MAGI_MODE.judge_prompt : DEBATE.system_prompt)(round - 1, maxRounds, !!clarification);
  return withLangNote(withCard({ ...SYNTHESIZER, system_prompt: prompt }, cards, PERSONA_CONTEXT.synth_header).system_prompt
    + '\n\n' + DEBATE.constraint_rules, langNote);
}

// 札が読めない発言は推測せず確定する。前回の有効票を使うかはmagiTallyが決める。
function resolveVotes(opinions, round, send) {
  for (const p of opinions) {
    const v = p.views.find(v => v.round === round && v.vote_state === 'pending');
    if (!v) continue;
    v.vote = null; v.vote_state = 'final';
    send('persona', { round, codename: p.codename, name: p.name, text: v.text, vote: null, vote_state: 'final' });
  }
}

// 人格の入力だけを組み立てる。呼び出し・回数・期限はrunDiscussionで管理する。
function discussionPersonas({ cards, motion, guide, music, pageChoice, personalization, langNote }) {
  const personaPageNote = pageChoice ? '\n\n' + siteSelectionNote(pageChoice) : '';
  return PERSONAS.map(p => {
    const base = withCard({ ...p, magi: !!motion, system_prompt: p.system_prompt + '\n\n' + p.role[motion ? 'magi' : 'chat'] }, cards);
    return { ...base, system_prompt: withLangNote(base.system_prompt
      + (guide ? '\n\n' + guide.persona : '')
      + (music ? '\n\n' + MUSIC_CONSULT.system_note : '')
      + personaPageNote + personalizationNote(personalization), langNote) };
  });
}

// 判定のメモと上限を含む討議記録。本文・改行の順序は統合への入力契約として保つ。
function discussionSynthesisText({ lastUser, lastRound, opinions, assessment, magiVerdict, motion, longDebate, maxRounds }) {
  return `${lastUser}\n\n[内部討議メモ：以下は各人格の初回意見と討議後の見解${lastRound > 2 ? '、自分が聞き返した問いへの答え' : ''}。これらを統合し、私(Shinya Takeda)として一人称で答える。人格名は出さない]\n${debateRecord(opinions)}`
    + (assessment ? `\n\n[討議を見た自分のメモ]\n${assessment}` : '')
    + (magiVerdict ? `\n\n【共通の議題と確定した採決】${motion}\n${JSON.stringify(magiVerdict)}\n採決は変更せず、その根拠を説明する。` : '')
    + (longDebate && lastRound === maxRounds ? `\n\n[${motion ? MAGI_MODE.synth_cap_note(maxRounds) : `討議は上限の${maxRounds}回で打ち切った。割れたままの点は、どれを取るか自分で決めて答える`}]` : '');
}

function discussionSynthesisMessages({ cards, motion, bias, guide, pageChoice, music, personalization, history, content }) {
  return [
    // 統合人格のカード（自己像）があれば骨格の後ろに足す。無ければ骨格だけ
    { role: 'system', content: withCard({ ...SYNTHESIZER, system_prompt: SYNTHESIZER.system_prompt + '\n' + SYNTHESIZER.role[motion ? 'magi' : 'chat'] }, cards, PERSONA_CONTEXT.synth_header).system_prompt },
    ...(bias ? [{ role: 'system', content: bias }] : []),
    ...(guide ? [{ role: 'system', content: guide.synth }] : []),
    ...(pageChoice ? [{ role: 'system', content: siteSelectionNote(pageChoice) }] : []),
    ...(music ? [{ role: 'system', content: MUSIC_CONSULT.system_note }] : []),
    { role: 'system', content: SYNTHESIZER.voice_rules },
    { role: 'system', content: SYNTHESIZER.constraint_rules + personalizationNote(personalization) },
    ...history.map(m => ({ ...m, content: prependText(magiHistoryNote(m.magi), m.content) })),
    { role: 'user', content },
  ];
}

async function runDiscussion({ upstream, cards, plainMessages, messages = plainMessages, context = null, langNote,
  theme = null, adaptive = false, shortDebate = true, newContract = true, guide = null, pageChoice = null,
  pagesPromise = null, page = null, music = false, motion = null, clarification = null, personalization = null, signal, send, log }) {
  const history = messages.slice(0, -1);
  const lastContent = messages.at(-1).content;
  const lastUser = contentText(lastContent), lastImages = contentImages(lastContent);
  // 日本語のカードやDJの状況説明で出力言語が変わらないよう、systemと今回の本文の両方に指定する。
  const noteLang = c => langNote ? joinContent(c, langNote) : c;
  const personaTimeoutMs = lastImages.length ? DEFAULTS.timeouts.persona_vision_ms : DEFAULTS.timeouts.persona_ms;
  if (lastImages.length) log('vision', `images=${lastImages.length}`);
  // 揺らぎ：3人格の temperature を UI テーマで変える（light=1.0 / dark=1.3、未指定は既定）
  const personaTemp = theme ? PERSONA_TEMPERATURE[theme] : undefined;
  if (personaTemp != null) log('persona_call', 'temperature', theme, personaTemp);

  // 人格カード（サイト本文由来の「いまの中身」）とサイト案内を骨格プロンプトに足す。R2 は opinions 経由で同じものを使う
  const personas = discussionPersonas({ cards, motion, guide, music, pageChoice, personalization, langNote });

  // 人格ごとに呼び出し先の会社が違うので、1人格の失敗（相手側の障害・安全フィルター・時間切れ）では
  // 止めず、その人格を抜かして進める。画面のカードを「考え中」のまま残さないよう、欠けた回には印を送る。
  const absent = (p, round, reason) => {
    log('persona_call', p.codename, `r${round}`, 'dropped', reason && ((reason.envelope && reason.envelope.code) || reason.name || reason.message));
    const v = { round, text: PERSONA_ABSENT, absent: true, ...(motion ? { vote: null, vote_state: 'final' } : {}) };
    // 初回に欠けた人格は views を持たない（採決では票なしの欠席になる）
    if (motion) p.views?.push(v);
    send('persona', { ...v, codename: p.codename, name: p.name });
  };
  const respond = (p, round, raw, ask) => {
    const v = { round, text: raw, ...(motion ? parseVote(raw) : {}), ...(ask ? { ask } : {}) };
    send('persona', { round, codename: p.codename, name: p.name, text: v.text,
      ...(motion ? { vote: v.vote, vote_state: v.vote_state } : {}) });
    return v;
  };
  const votedText = v => motion ? `[${voteLabel(v.vote)}] ${viewBody(v)}` : v.text;
  const initialContent = motion ? withImages(`${lastUser}\n\n【共通の議題】${motion}\n${MAGI_MODE.persona_rounds.first}`, lastImages) : lastContent;

  // --- R1: 3人格が並列に初回意見（互いの意見は見ない）---
  // 各人格の意見は回ごとに views（[{ round, text, ask }]）へ積む。最後の要素がいまの考え
  const debateStarted = Date.now();
  log('persona_call', 'round1 start');
  const r1 = await withTimeout(personaTimeoutMs, signal =>
    Promise.allSettled(personas.map(async (p) => {
      // 人格ごとの履歴（自分の過去の意見だけが assistant。統合人格の回答は前回の文脈として user 側に付ける）
      const text = await fetchPersonaText(upstream, p, personaThread(p.codename, history, noteLang(initialContent)), signal, log, 1, personaTemp);
      const v = respond(p, 1, text);
      return { ...p, views: [v] };
    })), signal);
  const opinions = [];
  // pの他の人格の意見（第2回は初回、第3回以降はいまの考え。採決で欠けた回は、集計と同じく前の回の意見を引き継ぐ）
  const othersText = (p, view) => opinions.filter(o => o.codename !== p.codename)
    .map(o => `- ${o.name}（${o.codename}）: ${votedText(view(o))}`).join('\n');
  r1.forEach((r, i) => {
    if (r.status === 'fulfilled') { opinions.push(r.value); return; }
    absent(personas[i], 1, r.reason);
    if (!newContract) absent(personas[i], 2);
  });
  // 全員が失敗したときだけエラーにする（時間切れなら外側の catch が upstream timeout にする）
  if (!opinions.length) throw r1[0].reason;
  log('persona_call', 'round1 ok', `personas=${opinions.length}`);
  if (motion) resolveVotes(opinions, 1, send);

  // --- R2: 各人格が他の人格のR1意見を踏まえて討議・更新 ---
  // 失敗した人格は初回意見のまま統合に回す。相手がいない（1人しか残っていない）ときは討議しない
  // 第2回以降の1回分。指定した人格に並列で聞き、失敗した人格はその回だけ欠ける。text が空なら呼ばない
  const runRound = async (round, asked, text) => {
    await withTimeout(personaTimeoutMs, signal =>
      Promise.all(asked.map(async ({ p, ask }) => {
        const msg = text(p, ask);
        if (!msg) return;
        try {
          const raw = await fetchPersonaText(upstream, p, personaThread(p.codename, history, withImages(noteLang(msg), lastImages)), signal, log, round, personaTemp);
          p.views.push(respond(p, round, raw, ask));
        } catch (e) { absent(p, round, e); }
      })), signal);
    if (motion) resolveVotes(opinions, round, send);
  };
  log('persona_call', 'round2 start');
  await runRound(2, opinions.map(p => ({ p })), p => {
    const others = othersText(p, o => o.views[0]);
    if (!others) { if (!newContract) absent(p, 2); return null; }
    return rebuttalText(lastUser, motion, votedText(p.views[0]), others);
  });
  log('persona_call', 'round2 ok', `personas=${opinions.filter(o => o.views.length > 1).length}`);

  // --- 第3回以降: 統合人格が回ごとの基準で判定し、掘る論点に答えられる人格にだけ聞き返す ---
  // 対応を宣言した画面だけ（DEBATE）。判定は第2〜4回の後で、第5回の後は判定せずに統合する。
  // 時間の予算を過ぎたら次の回を始めない。判定に失敗したらその時点の討議で統合する
  const longDebate = !!motion || adaptive && !shortDebate;
  const maxRounds = longDebate && (!newContract || opinions.length > 1) ? DEBATE.max_rounds : 2;
  let assessment = '', lastRound = opinions.length > 1 ? 2 : 1;
  for (let round = 3; round <= maxRounds && !signal.aborted; round++) {
    if (Date.now() - debateStarted > DEBATE.budget_ms) { log('debate', `r${round}`, 'over budget'); break; }
    const judgement = await withTimeout(DEBATE.judge_ms, signal => fetchJudgement(upstream, {
      system: judgeSystemPrompt({ motion, round, maxRounds, clarification, cards, langNote }), input: (motion ? `【共通の議題】${motion}\n` : '') + judgeInput(plainMessages, context, opinions, langNote), active: opinions.map(o => o.codename), allowUser: !!clarification,
    }, signal, log), signal).catch(e => { if (signal.aborted) throw e; log('debate', 'judge', 'timeout'); return null; });
    if (signal.aborted) throw searchFailure('cancelled');
    if (judgement && judgement.assessment) assessment = judgement.assessment;
    log('debate', `after r${round - 1}`, judgement?.next_step || 'judge failed');
    if (judgement?.next_step === 'ask_user' && clarification) {
      send('clarify', { questions: judgement.questions, ...clarification });
      return null; // このターンは質問だけ。統合・予測は行わない。
    }
    // 答えるときも判定が済んだことを送る（画面の無通信の見張りは、何か届くたびに延びる。判定の待ちを統合の待ちに上乗せしない）
    if (!judgement || judgement.next_step !== 'ask_personas') { send('judge', { round: round - 1, action: 'answer' }); break; }
    // 判定を待つ間に予算を過ぎたら、聞き返さずに統合へ進む（予算の確認が判定の前だけだと、もう1回分の人格の呼び出しが走る）
    if (Date.now() - debateStarted > DEBATE.budget_ms) { log('debate', `r${round}`, 'over budget after judge'); send('judge', { round: round - 1, action: 'answer' }); break; }
    // 問いを先に画面へ出す（聞かれた人格のカードを「考え中」に戻す）
    const asked = judgement.persona_questions.map(q => ({ p: opinions.find(o => o.codename === q.target), ask: q.question }));
    send('ask', { round, max_rounds: maxRounds, questions: asked.map(({ p, ask }) => ({ codename: p.codename, name: p.name, text: ask })) });
    await runRound(round, asked, (p, ask) => followupText(lastUser, motion, round,
      p.views.map(v => `${viewLabel(v)}: ${votedText(v)}`).join('\n'), othersText(p, o => o.views.findLast(v => !v.absent) || o.views.at(-1)), ask));
    lastRound = round;
  }

  const magiVerdict = motion ? magiTally(Object.fromEntries(opinions.map(o => [o.codename, o.views])), lastRound) : null;
  log('discussion', 'complete', lastRound);
  if (magiVerdict) send('verdict', magiVerdict);

  // --- 統合コール（推論あり・stream）---
  const augmented = discussionSynthesisText({ lastUser, lastRound, opinions, assessment, magiVerdict, motion, longDebate, maxRounds });
  // 揺らぎ：UI テーマに応じて優先人格を少し強める（light=Strategist / dark=Enthusiast）
  const bias = !motion && theme ? SYNTH_BIAS[theme] : null;
  if (bias) log('synthesizer_call', 'bias', theme);

  if (pagesPromise) {
    pageChoice = await awaitPageChoice(pagesPromise, pageChoice, signal);
    if (signal.aborted) throw searchFailure('cancelled');
  }
  pageChoice = withoutCurrentPage(pageChoice, page);
  const hasPages = pageChoice && pageChoice.results.length;
  const synthMessages = discussionSynthesisMessages({ cards, motion, bias, guide, pageChoice, music, personalization, history,
    content: withImages(noteLang(augmented), lastImages) });

  const answer = await synthesize({ env: upstream, messages: synthMessages, theme, signal, send, log });
  log('synthesizer_call', 'ok');
  if (motion) send('integrated_end', {});
  if (hasPages && !signal.aborted) send('pages', chatPageEvent(pageChoice));
  return answer;
}

// チャットのサイト案内とページ選び。人格カード（cardsPromise）も待って一緒に返す。
// サイトの索引（data/site-search.json）は、ページ選びとサイト案内で同じものを使う。カードを待つ前に取り始める。
// 停止フラグ（SITE_SEARCH_ENABLED）が true でなければ索引を読まない（サイト案内は場面の説明だけになる）
// signal は会話全体の停止、pageSignal はページ選びの停止（会話の終わりでも止める）。
async function chatSitePages({ env, ctx, log, cardsPromise, classification, motion, newContract, entry, page, wantSitePages, searchText, signal, pageSignal }) {
  const searchOn = env.SITE_SEARCH_ENABLED === 'true';
  const allowPages = !motion && (!newContract || (entry !== 'dj-request' && classification.intent !== 'music' && classification.site_pages !== 'no' && wantSitePages));
  const wantPages = allowPages && wantSitePages && searchOn && env.DB && searchText.trim();
  const indexPromise = searchOn && (!newContract || env.DB) && ((allowPages && page) || wantPages) ? getSitePages(ctx, 'ja', pageSignal).catch(() => null) : null;
  const cards = await cardsPromise;
  // サイト案内（画面が page を送ったときだけ）。3人格を長く待たせないよう、索引は短い期限で待つ。
  // 取れなければ一覧なしで、場面の説明だけを足す
  let guide = null;
  if (!motion && page && (!newContract || classification.intent !== 'music')) {
    let pages = null;
    try { pages = await searchDeadline(SITE_GUIDE.wait_ms, () => indexPromise, signal); } catch (_) {}
    if (signal.aborted) throw searchFailure('cancelled');
    guide = siteGuide(page, pages);
    log('site_guide', page, guide.current ? 'known' : 'unknown', pages ? 'listed' : 'unlisted');
  }
  // ページ選びもこの分岐で始める。人格の討議は検索の取得待ちにしない。
  let pagesPromise = null;
  if (wantPages) {
    const searchEnv = searchUpstream(env, ctx, log, 'チャットのページ選び');
    pagesPromise = (async () => {
      const locale = newContract ? classification.reply_language.code === 'ja' ? 'ja' : 'en'
        : /[\u3040-\u30ff\u3400-\u9fff]/.test(searchText) ? 'ja' : 'en';
      // 索引は日英の名前でキャッシュしてある。取得は上の1回で済んでいるので、ここは言語を選ぶだけ
      if (!await indexPromise) throw searchFailure('list_fetch');
      const pages = await getSitePages(ctx, locale, pageSignal);
      return selectSitePages({ query: searchSlice(searchText, SITE_SEARCH.chat_query_max_chars), locale, pages, current: guide && guide.current,
        purpose: newContract && classification.intent === 'site' ? 'requested' : 'auxiliary',
        signal: pageSignal, log, call: opts => callModel({ ...opts, env: searchEnv }) });
    })().catch(() => { log('site_search', 'omitted'); return null; });
  }
  // サイトを尋ねた質問だけは、選んだページを待ってから答える。
  let pageChoice = null;
  if (!motion && newContract && classification.intent === 'site' && pagesPromise) {
    pageChoice = await pagesPromise || { status: 'failed', results: [] };
    pagesPromise = null;
  }
  return { cards, guide, pageChoice, pagesPromise };
}

// 新契約のチャットと v2 の読み上げのログ。段階と、数値・コード・状態の短い語（HTTP 状態・所要時間・人格・会社など）は残し、
// 本文が混ざりうる値（上流のエラー本文・例外の文。引用符・括弧・日本語・長い文を含む）は伏せる（一時チャット設計 §4.3）
const PRIVATE_LOG_TOKEN = /^[A-Za-z0-9_.:=/ -]{1,64}$/;
const privateLog = log => (stage, ...args) => log(stage, ...args.map(v => v == null || typeof v === 'number' || typeof v === 'boolean'
  || typeof v === 'string' && PRIVATE_LOG_TOKEN.test(v) ? v : '[redacted]'));

// transport（省略できる）を渡すと、SSE の代わりにその受け口へ同じイベントを送る（WebSocket の入口。読み上げ設計§6.2）。
// 受け口は { event(名前, data), comment(文字), end() }。入力の誤り・回数の超過は今と同じ HTTP の応答を返し、
// 受け口へ流し始めたら null を返す
async function handleChat(request, env, ctx, { requestId, cors, log, place = requestPlace(request), body = null }, transport = null) {
  let input;
  try { input = await readChatInput(request, body); }
  catch (err) { return inputError(err, requestId, cors); }
  if (input.privacyContract) log = privateLog(log);
  const features = privacyFeatures(env);
  if (input.privacyContract && (input.conversationMode === 'temporary' && !features.temporary_chat
    || input.personalization && !features.personalization
    || input.temporaryPersonalization && !features.temporary_personalization)) return httpError(409, { stage: 'bad_request', code: 'privacy_feature_unavailable', message: 'この会話機能は現在利用できません', retryable: true }, requestId, cors);
  place = input.locationEnabled ? input.devicePlace || place : null;
  const { messages, plainMessages, discussMessages, searchText, context, shared, theme, wantSuggest, wantSitePages, adaptive, page, newContract, factMode, clarify, magiPanel, entry, replyLanguage, seed, uiLanguage } = input;
  let langNote = input.langNote;
  const qa = await qaGuard(env, () => {
    const last = plainMessages.at(-1).content;
    return { kind: 'chat', text: contentText(last), images: contentImages(last).map(p => p.image_url.url), historyMessages: plainMessages.length - 1 };
  }, { requestId, cors, log }, () => httpError(503, { stage: 'internal', code: 'evaluation_unavailable',
    message: '評価用の確認を行えませんでした', retryable: true }, requestId, cors));
  if (qa.response) return qa.response;
  env = Object.assign(Object.create(qa.env), { privateChat: input.privacyContract });

  // 上流の呼び出しは、失敗を残高切れの通知に回す env で行う（bindings と secret は元の env から引き継ぐ）
  const upstream = Object.assign(Object.create(env), {
    onUpstreamError: (provider, res, { signal } = {}) => alertUpstream(env, log, provider, res, ctx, signal).catch(e => log('upstream_alert', 'failed', e && e.message)),
  });
  const { ac: stop, detach: detachRequest } = linkAbort(request.signal);
  // 公開カードだけを並行取得し、分類APIは利用制限の確認後に開始する。
  const cardsPromise = getPersonaCards(ctx, log);
  const refuse = res => {
    stop.abort();
    detachRequest();
    return res;
  };

  // 3) rate_limit: IP×UTC日次（DB 未設定の dev では skip）
  if (env.DB) {
    try {
      const ip = requestIP(request);
      const day = utcDay();
      const count = await countUp(env.DB, ip, day, DEFAULTS.daily_limit);
      log('rate_limit', ip, day, count ?? 'limit');
      if (count == null) {
        return refuse(httpError(429, {
          stage: 'rate_limit', code: 'daily_limit_exceeded',
          message: `本日の利用上限（${DEFAULTS.daily_limit}回/日）に達しました`,
          retry_after_day: day, legacy_url: 'https://tk.st/magi/', retryable: false,
        }, requestId, cors));
      }
      // 全利用者の合計にも1日の上限を掛ける。Origin は名乗れるので、IP を替えながら大量に呼ばれても費用に天井を作る。
      // 上限に達したらメールを送る（1日1通。ふだんの利用を大きく超えるので、使われ方を確かめる合図になる）
      if (await countUp(env.DB, 'global', day, DEFAULTS.global_daily_limit) == null) {
        log('rate_limit', 'global', day, 'limit');
        ctx.waitUntil(sendAlert(env, log, 'alert:global', `[MAGI] 本日のサイト全体の上限（${DEFAULTS.global_daily_limit}回）に達しました`, [
          `MAGI（magi2）への質問が、UTC の ${day} に全利用者の合計で ${DEFAULTS.global_daily_limit} 回を超えました。`,
          '今日（UTC）の残りは、どの利用者にも「本日の利用上限に達しました」と返しています。',
          'ふだんの利用を大きく超えているので、ログ（wrangler tail）で使われ方を確かめてください。',
          '上限は workers/magi2/personas.js の DEFAULTS.global_daily_limit です。',
        ]).catch(e => log('alert', 'failed', e && e.message)));
        return refuse(httpError(429, {
          stage: 'rate_limit', code: 'global_daily_limit_exceeded',
          message: '本日の利用上限に達しました。明日またお試しください',
          retry_after_day: day, retryable: false,
        }, requestId, cors));
      }
    } catch (err) {
      log('rate_limit', 'db_error', err.message);
      return refuse(httpError(500, { stage: 'internal', code: 'ratelimit_db_error', message: 'レート制限の記録に失敗しました', detail: String(err.message).slice(0, 200), retryable: true }, requestId, cors));
    }
  } else {
    log('rate_limit', 'skipped (no DB binding)');
  }

  const previousClarify = plainMessages.at(-2)?.role === 'assistant' ? plainMessages.at(-2).clarify : null;
  const originalQuestion = previousClarify && [...plainMessages.slice(0, -2)].reverse().find(m => m.role === 'user');
  const classifyPromise = withTimeout(INTENT_CLASSIFY.timeout_ms, signal => classifyQuery(upstream, {
    profile: newContract ? entry : 'legacy', texts: plainMessages.filter(m => m.role === 'user').map(m => contentText(m.content)),
    seed, replyLanguage, uiLanguage, fallback: langNote, factMode, sharedTitle: shared?.title,
    clarification: originalQuestion ? { original_question: classifySlice(contentText(originalQuestion.content), INTENT_CLASSIFY.latest_max_chars),
      questions: previousClarify.questions, prior: { intent: previousClarify.intent, fresh: previousClarify.fresh } } : null,
  }, signal, log), stop.signal).then(value => ({ value }), error => ({ error }));

  // 4-5) SSE: 3人格（並列・欠けた人格は抜かして続ける。全員失敗でエラー）→ 統合（stream）
  // 利用者が止めた（画面の停止ボタン・タブを閉じた）ら、続きの呼び出しをまとめて止める。払うのは止めた時点までの分だけ
  const { ac: pageStop, detach: detachPages } = linkAbort(stop.signal);
  // 送り方（SSE か WebSocket）に関わらない本体。sink は { event, comment, end }
  const run = sink => {
      let closed = false, clarified = false;
      // 画面が integrated の差分をつないで保存するのと同じ文字列（読み上げの署名の対象。読み上げ設計§5.2）
      let spoken = '';
      const send = (event, data) => {
        if (closed || clarified && event === 'title') return;
        if (event === 'clarify') clarified = true;
        try {
          sink.event(event, data);
          if (event === 'integrated' && typeof data.delta === 'string') spoken += data.delta;
        } catch (_) {}
      };
      let pingTimer = null;
      const stopPing = () => { clearInterval(pingTimer); pingTimer = null; };
      const close = () => {
        stopPing(); stop.signal.removeEventListener('abort', close);
        if (!closed) { closed = true; try { sink.end(); } catch (_) {} }
      };
      stop.signal.addEventListener('abort', close, { once: true });
      if (stop.signal.aborted) close();
      else {
        sink.comment(' '.repeat(STREAM.padding_bytes - 3));
        pingTimer = setInterval(() => {
          if (!closed) { try { sink.comment(' ping'); } catch (_) { close(); } }
        }, STREAM.ping_ms);
      }

      ctx.waitUntil((async () => { try {
        if (input.privacyContract) send('session', { conversation_mode: input.conversationMode, personalization_applied: !!input.personalization });
        // 出力の言語（3人格・統合・討議の判定・タイトル・予測の全部に同じものを付ける）
        const classificationResult = await classifyPromise;
        if (classificationResult.error) throw classificationResult.error;
        const classified = classificationResult.value;
        if (stop.signal.aborted) throw searchFailure('cancelled');
        langNote = classified.langNote;
        const classification = classified.classification;
        if (classification) classification.magi_candidate = !classified.malice && classification.mode !== 'fact' && env.MAGI_MODE_ENABLED === 'true' && newContract && magiPanel
          && entry === 'chat' && classification.votable === 'yes' && !!contentText(plainMessages.at(-1).content).trim();
        if (newContract) send('classification', classification);
        if (classified.malice) {
          log('malice', classified.malice, classified.maliceConfidence);
          const cards = await cardsPromise;
          await replyToMalice({ env: upstream, cards, classified, uiLanguage, theme, signal: stop.signal, send, log });
          if (stop.signal.aborted) throw searchFailure('cancelled');
          send('closed', { reason: 'malice' });
          send('done', { request_id: requestId });
          close();
          return;
        }
        const motionPromise = classification?.magi_candidate ? withTimeout(MAGI_MODE.motion_ms,
          signal => createMotion(upstream, discussMessages, langNote, signal, log), stop.signal)
          .catch(() => notVotable('failed')) : null;

        // --- タイトル要約：会話の初回ユーザー発言時のみ、本流と並列で生成 ---
        // 状況説明を足す前の発言から作る（足した後だと、状況説明の回答ルールに従って答えを書いてしまう）
        let titlePromise = null;
        if (input.conversationMode !== 'temporary' && !plainMessages.some(m => m.role === 'assistant')) {
          const titleTimeoutMs = contentImages(plainMessages.at(-1).content).length ? DEFAULTS.timeouts.persona_vision_ms : DEFAULTS.timeouts.persona_ms;
          titlePromise = withTimeout(titleTimeoutMs, signal => fetchTitle(upstream, plainMessages.at(-1).content, langNote, signal, log), stop.signal)
            .then(t => { if (t) send('title', { text: t }); })
            .catch(() => {});
        }

        const motionEvent = motionPromise ? await motionPromise : null;
        if (stop.signal.aborted) throw searchFailure('cancelled');
        if (motionEvent) send('motion', motionEvent);
        const motion = motionEvent?.votable ? motionEvent.text : null;
        const shortDebate = !motion && newContract && !factMode && ['site', 'music'].includes(classification.intent);

        const { cards, guide, pageChoice, pagesPromise } = await chatSitePages({ env, ctx, log, cardsPromise, classification, motion, newContract,
          entry, page, wantSitePages, searchText, signal: stop.signal, pageSignal: pageStop.signal });
        const answer = factMode && classification.mode === 'fact'
          ? await runFactAnswer({ upstream, cards, messages, langNote, theme, guide, pageChoice, pagesPromise, page, personalization: input.personalization,
              research: classification.intent === 'research' && classification.fresh === 'yes',
              replyLanguage: classification.reply_language, ip: requestIP(request), place, signal: stop.signal, send, log })
          : await runDiscussion({ upstream, cards, plainMessages: discussMessages, messages, context, langNote, theme, personalization: input.personalization,
              adaptive, shortDebate, newContract, guide, pageChoice, pagesPromise, page, motion, music: !motion && newContract && classification.intent === 'music',
              clarification: clarify && entry === 'chat' && !motion && !previousClarify
                ? { intent: classification.intent, fresh: classification.fresh || 'no' } : null,
              signal: stop.signal, send, log });
        // 次の質問の予測：答え全体を読んでから作るので、答えの後に1回だけ。失敗しても会話は終える
        if (wantSuggest && answer !== null) {
          const text = await withTimeout(DEFAULTS.timeouts.suggest_ms,
            signal => fetchSuggestion(upstream, [...plainMessages, { role: 'assistant', content: answer }], context, langNote, signal, log), stop.signal);
          if (text) send('suggest', { text });
        }
        // 並列生成したタイトルが未送出なら送出を待つ（通常は既に完了）。確認質問で終えた回はタイトルを捨てるので待たない
        if (titlePromise && !clarified) await titlePromise;
        // 読み上げの署名（読み上げ設計§5.2）。確認質問・DJ の相談・読み上げを止めているときは送らない
        if (speechReady(env) && entry !== 'dj-request' && !clarified && spoken.trim() && !stop.signal.aborted) {
          const lang = speechLanguage(classification?.reply_language?.code);
          const options = input.privacyContract ? { version: 2, mode: input.conversationMode, lang } : undefined;
          send('speech', { sig: await speechSign(env.SPEECH_SIGN_KEY, spoken, options),
            ...(options ? { sig_version: 2, conversation_mode: input.conversationMode } : {}), ...(lang ? { lang } : {}) });
        }
        send('done', { request_id: requestId });
        close();
      } catch (err) {
        // 利用者が止めたときは、もう誰も読んでいないので何も送らない
        if (stop.signal.aborted) { log('client', 'stopped', err && (err.name || err.message)); close(); return; }
        // タイムアウト(AbortError)は upstream として表現
        if (err && err.name === 'AbortError') {
          const env2 = stageError('upstream', 'timeout', 'AI の応答がタイムアウトしました', { retryable: true });
          log('error', 'upstream', 'timeout');
          send('error', toEnvelope(env2, requestId));
        } else {
          const e = toEnvelope(err, requestId);
          if (input.privacyContract) { delete e.detail; e.message = '回答を受信できませんでした'; }
          log('error', e.stage, e.code, e.message);
          send('error', e);
        }
        close();
      } finally {
        pageStop.abort();
        detachPages();
        detachRequest();
      } })());
  };
  if (transport) { run(transport); return null; }
  const stream = new ReadableStream({
    cancel() { log('client', 'cancelled'); stop.abort(); },
    start(controller) {
      const enc = new TextEncoder();
      run({
        event: (event, data) => controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)),
        comment: text => controller.enqueue(enc.encode(':' + text + '\n\n')),
        end: () => controller.close(),
      });
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', 'Connection': 'keep-alive', 'X-Request-Id': requestId, ...cors },
  });
}

// --- WebSocket の入口（読み上げ設計§6.2）。通信を溜めるプロキシの下でも少しずつ届くよう、SSE と同じイベントを WebSocket で送る ---
// 開いた後の最初のメッセージ { type: 'chat', v: 1, body: <POST /magi2/chat と同じ JSON> } を1回だけ受け、今の handleChat に渡す。
// 各イベントは { event, data } のテキスト、10秒ごとに { event: 'ping' }。done・error の後は 1000 で閉じる。
// 入力の誤り・回数の超過は今の封筒（http_status を含む）を error で送ってから 1008 で閉じる。
// 画面の { type: 'stop' }・切断・エラーは、どれも SSE の切断と同じく続きの呼び出しを止める
function handleChatSocket(request, env, ctx, { requestId, cors, log }) {
  if (request.headers.get('Upgrade') !== 'websocket') return new Response('Upgrade Required', { status: 426, headers: cors });
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  const ac = new AbortController();
  let closed = false, started = false;
  const close = (code, reason) => {
    if (closed) return;
    closed = true; clearTimeout(firstTimer); ac.abort();
    try { server.close(code, reason); } catch (_) {}
  };
  const sendJSON = value => { if (closed) return; try { server.send(JSON.stringify(value)); } catch (_) { close(1011, 'send'); } };
  const fail = (envelope, httpStatus) => {
    sendJSON({ event: 'error', data: { ...envelope, http_status: httpStatus, request_id: requestId } });
    close(1008, 'error');
  };
  const firstTimer = setTimeout(() => {
    log('ws', 'no_request');
    fail({ stage: 'bad_request', code: 'ws_no_request', message: '要求が届きませんでした', retryable: true }, 408);
  }, STREAM.ws_first_message_ms);
  // compatibility_date が 2026-04-07 より前なので、相手の Close には自分で close() を返す
  server.addEventListener('close', () => { if (!closed) log('client', 'closed (ws)'); close(1000, 'closed'); });
  server.addEventListener('error', () => close(1011, 'error'));
  server.addEventListener('message', event => {
    // 画像付きの要求は数MBになるので、parse の前に POST と同じ上限で断る（文字数はバイト数以下なので、文字数で超えれば必ず超える）
    const data = typeof event.data === 'string' ? event.data : null, max = DEFAULTS.input.max_request_bytes;
    if (data && (data.length > max || data.length * 3 > max && utf8Length(data) > max)) {
      log('ws', 'too_large');
      fail(tooLarge().envelope, 413);
      return;
    }
    let message = null;
    try { message = data === null ? null : JSON.parse(data); } catch (_) {}
    if (message && message.type === 'stop') { log('client', 'stopped (ws)'); close(1000, 'stopped'); return; }
    if (started || !message || message.type !== 'chat' || message.v !== 1 || !message.body || typeof message.body !== 'object' || Array.isArray(message.body)) {
      log('ws', started ? 'duplicate_request' : 'invalid_message');
      fail({ stage: 'bad_request', code: started ? 'ws_duplicate_request' : 'ws_invalid_message', message: 'WebSocket の要求が不正です', retryable: false }, 400);
      return;
    }
    started = true; clearTimeout(firstTimer);
    // 入力の検査・回数は POST と同じ処理に任せる（本文は今の POST と同じ JSON。読み直さないよう parse 済みのまま渡す）
    const headers = { Origin: request.headers.get('Origin') || '' };
    if (request.headers.get('CF-Connecting-IP')) headers['CF-Connecting-IP'] = request.headers.get('CF-Connecting-IP');
    const chat = new Request(new URL('/magi2/chat', request.url), { method: 'POST', headers, signal: ac.signal });
    // 作り直した要求には通信元の情報（cf）が無いので、開いたときの要求から推定所在地を渡す
    ctx.waitUntil(handleChat(chat, env, ctx, { requestId, cors, log, place: requestPlace(request), body: message.body }, {
      event: (name, data) => sendJSON({ event: name, data }),
      comment: text => { if (text.trim() === 'ping') sendJSON({ event: 'ping' }); },
      end: () => close(1000, 'done'),
    }).then(async res => {
      if (!res) return;
      let envelope = null;
      try { envelope = (await res.json()).error; } catch (_) {}
      fail(envelope || { stage: 'internal', code: 'internal_error', message: '内部エラーが発生しました', retryable: true }, res.status);
    }, err => {
      log('ws', 'failed', err && err.message);
      fail({ stage: 'internal', code: 'internal_error', message: '内部エラーが発生しました', retryable: true }, 500);
    }));
  });
  return new Response(null, { status: 101, webSocket: client });
}

// --- 読み上げ（読み上げ設計§5.4）。Worker が署名した統合人格の回答だけを、区切りごとに Fish Audio で音声にする ---
// 音声は端末に保存させない（no-store）。同じ区切りは Cache API に入れ、2回目からは Fish Audio を呼ばず回数にも数えない。
// ログには区切りの数・バイト数・キャッシュの当否・所要時間だけを出し、文・署名・キーは出さない
const speechReady = env => env.SPEECH_ENABLED === 'true' && !!env.MAGI_FISH_AUDIO_API_KEY && !!env.SPEECH_SIGN_KEY;
const speechCache = () => typeof caches !== 'undefined' && caches.default ? caches.default : null;
async function handleSpeech(request, env, ctx, { requestId, cors, log }) {
  const headers = { ...cors, 'Cache-Control': 'no-store', 'Access-Control-Expose-Headers': 'X-Speech-Parts' };
  const fail = (status, stage, code, message, retryable = false) => httpError(status, { stage, code, message, retryable }, requestId, headers);
  if (!speechReady(env)) return fail(503, 'internal', 'speech_unavailable', '読み上げできませんでした', true);
  let body;
  try { body = await readJsonLimited(request, SPEECH.request_bytes); }
  catch (err) { return inputError(err, requestId, headers); }
  const { text, sig, part } = body && typeof body === 'object' ? body : {};
  if (typeof text !== 'string' || !text.trim() || typeof sig !== 'string' || !Number.isInteger(part) || body.lang != null && typeof body.lang !== 'string') {
    return fail(400, 'bad_request', 'invalid_speech_request', '読み上げの要求が不正です');
  }
  const speechOptions = body.sig_version === undefined && body.conversation_mode === undefined ? undefined
    : { version: body.sig_version, mode: body.conversation_mode, lang: body.lang };
  if (speechOptions && (speechOptions.version !== 2 || !['normal', 'temporary'].includes(speechOptions.mode))) return fail(400, 'bad_request', 'invalid_speech_contract', '読み上げの要求が不正です');
  if (speechOptions?.mode === 'temporary' && !privacyFeatures(env).temporary_chat) return fail(409, 'bad_request', 'privacy_feature_unavailable', '一時チャットの読み上げは現在利用できません');
  if (!await speechVerify(env.SPEECH_SIGN_KEY, text, sig, speechOptions)) {
    log('speech', 'unsigned');
    return fail(403, 'auth', 'speech_unsigned', 'この回答は読み上げできません');
  }
  const lang = speechLanguage(body.lang);
  if (speechOptions) { env = Object.assign(Object.create(env), { privateChat: true }); log = privateLog(log); }
  const parts = speechParts(text, lang);
  if (part < 0 || part >= parts.length) return fail(400, 'bad_request', 'speech_part_out_of_range', '読み上げの区切りが範囲外です');
  headers['X-Speech-Parts'] = String(parts.length);
  const started = Date.now();
  const cache = speechOptions?.mode === 'temporary' ? null : speechCache();
  const key = cache && new Request('https://workers.tk.st/magi2/speech-cache/'
    + await sha256([SPEECH.model, SPEECH.voice_id, SPEECH.params_version, lang || '', parts[part]].join('|')));
  if (cache) {
    const hit = await cache.match(key).catch(() => null);
    if (hit) {
      log('speech', 'cache_hit', part, parts.length, Date.now() - started);
      return new Response(hit.body, { headers: { ...headers, 'Content-Type': 'audio/mpeg', 'X-Speech-Cache': 'hit' } });
    }
  }

  // 回数は Fish Audio へ実際に送る区切りだけを数える（チャットの回数とは別。設計§5.5）
  if (env.DB) {
    try {
      const ip = requestIP(request), day = utcDay();
      if (await countUp(env.DB, 'speech:' + ip, day, SPEECH.ip_daily_limit) == null) {
        log('speech', 'ip_limit', day);
        return fail(429, 'rate_limit', 'speech_limit_exceeded', '本日の読み上げの上限に達しました');
      }
      if (await countUp(env.DB, 'speech:global', day, SPEECH.global_daily_limit) == null) {
        log('speech', 'global_limit', day);
        ctx.waitUntil(sendAlert(env, log, 'alert:speech-global', `[MAGI] 本日の読み上げの全体の上限（${SPEECH.global_daily_limit}区切り）に達しました`, [
          `MAGI（magi2）の読み上げが、UTC の ${day} に全利用者の合計で ${SPEECH.global_daily_limit} 区切りを超えました。`,
          '今日（UTC）の残りは、どの利用者にも「本日の読み上げの上限に達しました」と返しています。',
          '無料版の公正利用の範囲を超えていないか、ログ（wrangler tail）で使われ方を確かめてください。',
          '上限は workers/magi2/personas.js の SPEECH.global_daily_limit です。',
        ]).catch(e => log('alert', 'failed', e && e.message)));
        return fail(429, 'rate_limit', 'speech_global_limit_exceeded', '本日の読み上げの上限に達しました');
      }
    } catch (err) {
      log('speech', 'db_error', err && err.message);
      return fail(500, 'internal', 'speech_db_error', '読み上げできませんでした', true);
    }
  }

  // 最初の音声まで first_byte_ms・全体で total_ms。利用者が切ったら上流も止める
  const { ac: stop, detach: detachClient } = linkAbort(request.signal);
  const totalTimer = setTimeout(() => stop.abort(), SPEECH.total_ms);
  let firstTimer = setTimeout(() => stop.abort(), SPEECH.first_byte_ms);
  const cleanup = () => { clearTimeout(totalTimer); clearTimeout(firstTimer); detachClient(); };
  const upstreamFailed = (status, code) => { cleanup(); log('speech', 'failed', code, Date.now() - started); return fail(status, 'upstream', code, '読み上げできませんでした', true); };
  const call = () => fetch(SPEECH.endpoint, {
    method: 'POST', signal: stop.signal,
    headers: { Authorization: `Bearer ${env.MAGI_FISH_AUDIO_API_KEY}`, 'Content-Type': 'application/json', model: SPEECH.model },
    body: JSON.stringify({ text: parts[part], reference_id: SPEECH.voice_id, ...SPEECH.params, ...(lang ? { language: lang } : {}) }),
  });
  let res;
  try {
    res = await call();
    // 同時実行の上限（429）は1回だけ送り直す。有料のモデルへは切り替えない
    if (res.status === 429) {
      res.body?.cancel().catch(() => {});
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, SPEECH.retry_429_ms);
        stop.signal.addEventListener('abort', () => { clearTimeout(t); reject(stop.signal.reason); }, { once: true });
      });
      res = await call();
    }
  } catch (err) {
    return upstreamFailed(request.signal.aborted ? 499 : 504, request.signal.aborted ? 'speech_cancelled' : 'speech_timeout');
  }
  if (!res.ok || !res.body) {
    if ([401, 402, 403, 429].includes(res.status)) await alertUpstream(env, log, 'fishaudio', res.clone(), ctx, stop.signal).catch(e => log('upstream_alert', 'failed', e && e.message));
    // 声のモデルが消えた・非公開になった（400 {"message":"Reference not found"}。実装前確認§0.2）
    else if (res.status === 400 && /reference not found/i.test(await readLimited(res.clone(), 500, stop.signal, 2000))) {
      log('speech', 'voice_missing');
      ctx.waitUntil(sendAlert(env, log, 'alert:fishaudio:voice', '[MAGI] 読み上げの声のモデルが見つかりません', [
        `MAGI（magi2）の読み上げで、Fish Audio が声のモデル（${SPEECH.voice_id}）を見つけられませんでした（HTTP 400：参照先が見つかりません）。`,
        '声のモデルが消えたか、非公開になった可能性があります。読み上げは画面に「読み上げできませんでした」と返しています。',
        '声のモデルを作り直したら workers/magi2/personas.js の SPEECH.voice_id を直して出してください。止めるときは SPEECH_ENABLED を "false" にします。',
        '同じ通知は UTC の1日に1通です。',
      ]).catch(e => log('alert', 'failed', e && e.message)));
    }
    res.body?.cancel().catch(() => {});
    return upstreamFailed(502, 'speech_http_' + res.status);
  }

  // 上流の本文を溜めずに流し、最後までそろったときだけキャッシュに入れる（途中で切れたものは入れない）
  const reader = res.body.getReader(), chunks = [];
  // 期限・切断で止めたら、上流が本文を閉じなくても読み取りを打ち切る（止めた後の終わりを完了と取り違えない）
  const aborted = new Promise((_, reject) => {
    const onAbort = () => reject(new Error('speech_aborted'));
    if (stop.signal.aborted) onAbort(); else stop.signal.addEventListener('abort', onAbort, { once: true });
  });
  aborted.catch(() => {});
  let bytes = 0, finished = false;
  const finish = complete => {
    if (finished) return;
    finished = true; cleanup();
    log('speech', complete ? 'ok' : 'incomplete', part, parts.length, bytes, Date.now() - started);
    if (!complete || !cache) return;
    const audio = new Uint8Array(bytes); let at = 0;
    for (const c of chunks) { audio.set(c, at); at += c.byteLength; }
    ctx.waitUntil(cache.put(key, new Response(audio, { headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': `public, max-age=${SPEECH.cache_seconds}` } }))
      .catch(e => log('speech', 'cache_failed', e && e.message)));
  };
  const out = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await Promise.race([reader.read(), aborted]);
        if (done) { controller.close(); finish(true); return; }
        clearTimeout(firstTimer);
        bytes += value.byteLength;
        if (cache) chunks.push(value);
        controller.enqueue(value);
      } catch (err) {
        reader.cancel().catch(() => {});
        finish(false);
        controller.error(err);
      }
    },
    cancel() { stop.abort(); reader.cancel().catch(() => {}); finish(false); },
  });
  return new Response(out, { headers: { ...headers, 'Content-Type': 'audio/mpeg', 'X-Speech-Cache': 'miss' } });
}

// POSTの入口と、認可時に必要な違いだけを定義する。GET・WebSocketはそれぞれの契約で扱う。
const POST_ROUTES = new Map([
  ['/magi2/chat', { handle: handleChat }],
  ['/magi2/react', { handle: (request, env, _ctx, context) => handleReaction(request, env, context), reaction: true }],
  ['/magi2/bug-report', { handle: (request, env, _ctx, context) => handleBugReport(request, env, context) }],
  ['/magi2/site-search', { handle: handleSiteSearch, search: true }],
  ['/search/api/rank', { handle: handleSiteSearch, search: true }],
  ['/search/api/click', { handle: (request, env, _ctx, context) => handleSearchClick(request, env, context), search: true }],
  // 止めているときは、認可より先に入口ごと無いものとして扱う。
  ['/magi2/speech', { handle: handleSpeech, enabled: env => env.SPEECH_ENABLED === 'true' }],
]);

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);
    const requestId = crypto.randomUUID();
    const log = (...a) => console.log(requestId, ...a);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    // WebSocket の入口（読み上げ設計§6.2）。WS_ENABLED が "true" のときだけ開く。ブラウザの WebSocket は見出しを足せないので
    // x-api-key は使わず、許可した Origin だけを受ける（Cookie を使わないので、Origin の確認が CSWSH の対策を兼ねる）
    if (request.method === 'GET' && url.pathname === '/magi2/ws') {
      if (env.WS_ENABLED !== 'true') return httpError(404, { stage: 'bad_request', code: 'not_found', message: 'Not Found', retryable: false }, requestId, cors);
      if (!isAllowedOrigin(origin)) {
        log('auth', 'rejected (ws)', origin);
        return httpError(403, { stage: 'auth', code: 'forbidden_origin', message: '許可されていない Origin です', retryable: false }, requestId, cors);
      }
      return handleChatSocket(request, env, ctx, { requestId, cors, log });
    }
    // 許可した Origin のページか、サイト外から API キーを付けた呼び出し（利用回数と POST の入口で使う）
    const authorized = isAllowedOrigin(origin) || !!env.CLIENT_API_KEY && request.headers.get('x-api-key') === env.CLIENT_API_KEY;

    // --- 更新履歴（data/magi-versions.json）。tk.st からも同梱分からも読めなければ、CORS 付きの 503 で返す
    // （例外のまま返すと CORS ヘッダーの無い 500 になり、画面では原因の見えない失敗になる）---
    if (request.method === 'GET' && url.pathname === '/magi2/versions') {
      try {
        const history = await getVersionHistory();
        // 配布済みのAPKはX.Yだけを受け付ける。キャッシュは完全な履歴を共有し、応答時だけ絞る。
        const data = url.searchParams.get('format') === '2' ? history
          : { versions: history.versions.filter(row => row.version === 'earlier' || /^\d{1,2}\.\d$/.test(row.version)) };
        return jsonResponse(data, cors, 200, { 'Cache-Control': 'public, max-age=600', Vary: 'Origin' });
      } catch (err) {
        log('versions', 'unavailable', err && err.message);
        return httpError(503, { stage: 'internal', code: 'versions_unavailable', message: '更新履歴を読み込めませんでした', retryable: true }, requestId, cors);
      }
    }
    // --- スプラッシュの人格の説明：各人格がいま使っている LLM と、説明文（personas.js の PERSONA_GUIDE）---
    // モデルID・表示名の正本は config/ai-models.json で、週次の監視で更新されうるのでページには直書きしない。
    // 説明文も画面に持たせない（トップページとアプリで食い違わず、アプリのリリースなしで直せる）。
    // パスの名前はモデル名だけを返していた頃のまま（配布済みのアプリが provider / model を読みに来る）。
    // 公開して困る情報ではないので認可は付けない（読めるのは CORS で許した Origin のページだけ）
    if (request.method === 'GET' && url.pathname === '/magi2/models') {
      // 配布済みの画面も model を表示するので、ここで表示名を返す。API 呼び出しは cfg.model のまま。
      // 実際に指定しているモデルIDも model_id として返し、エイリアスとの対応を確認できるようにする。
      const describe = (codename, cfg) => ({ provider: cfg.provider, provider_label: PROVIDERS[cfg.provider].label, model: cfg.display_name, model_id: cfg.model, ...PERSONA_GUIDE[codename] });
      const body = {
        personas: Object.fromEntries(Object.entries(DEFAULTS.models.persona).map(([codename, cfg]) => [codename, describe(codename, cfg)])),
        synthesizer: describe(SYNTHESIZER.codename, DEFAULTS.models.synthesizer),
        themes: { light: describe(SYNTHESIZER.codename, DEFAULTS.models.synthesizer), dark: describe(SYNTHESIZER.codename, DEFAULTS.models.synthesizer_dark) },
        privacy: PRIVACY,
        // 画面はこれを見て読み上げのボタンを出す（読み上げ設計§7）。Worker の設定だけで全画面に出し入れできる
        features: { speech: speechReady(env), ...privacyFeatures(env), temporary_speech: speechReady(env) && privacyFeatures(env).temporary_speech },
      };
      return jsonResponse(body, cors, 200, { 'Cache-Control': url.searchParams.get('capabilities') === '1' ? 'no-store' : 'public, max-age=600' });
    }
    // --- 今日の利用回数（IP×UTC日、通常チャットの上限）。アプリのヘッダーの円グラフが読む。数えずに読むだけ。
    // 全利用者の合計の上限に達した日は、IPの回数が残っていても送れないので global_full で知らせる ---
    if (request.method === 'GET' && url.pathname === '/magi2/usage') {
      const noStore = { ...cors, 'Cache-Control': 'no-store' };
      if (!authorized) {
        return httpError(401, { stage: 'auth', code: 'unauthorized', message: '許可されていない Origin です', retryable: false }, requestId, noStore);
      }
      const unavailable = () => httpError(503, { stage: 'internal', code: 'usage_unavailable', message: '利用回数を読み込めませんでした', retryable: true }, requestId, noStore);
      if (!env.DB) return unavailable();
      try {
        const day = utcDay(), limit = DEFAULTS.daily_limit;
        const read = key => env.DB.prepare('SELECT count FROM rate_limit WHERE ip = ?1 AND day = ?2').bind(key, day).first();
        const [row, total] = await Promise.all([read(requestIP(request)), read('global')]);
        const resets = new Date(day + 'T00:00:00Z'); resets.setUTCDate(resets.getUTCDate() + 1);
        return jsonResponse({ used: Math.min(row ? row.count : 0, limit), limit, day, resets_at: resets.toISOString(),
          global_full: !!total && total.count >= DEFAULTS.global_daily_limit }, noStore);
      } catch (err) {
        log('usage', 'db_error', err && err.message);
        return unavailable();
      }
    }

    // 存在する POST の入口だけを、chat / react 共通の条件で認可する。
    const route = request.method === 'POST' ? POST_ROUTES.get(url.pathname) : null;
    if (!route || route.enabled && !route.enabled(env)) {
      return httpError(404, { stage: 'bad_request', code: 'not_found', message: 'Not Found', retryable: false }, requestId, cors);
    }
    if (route.search) cors['Cache-Control'] = 'no-store';
    if (!authorized) {
      if (route.search) log('auth', 'rejected (site-search)');
      else log('auth', route.reaction ? 'rejected (react)' : 'rejected', origin);
      return httpError(401, {
        stage: 'auth', code: 'unauthorized',
        message: route.reaction ? '許可されていない Origin です'
          : `許可されていない Origin です（許可: ${ALLOWED_ORIGINS.join(', ')}, localhost）。外部利用は x-api-key が必要です`,
        retryable: false,
      }, requestId, cors);
    }
    const context = { requestId, cors, log };
    return route.handle(request, env, ctx, context);
  },
};
