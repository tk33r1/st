import { DEBATE, DEFAULTS, INTENT_CLASSIFY, MAGI_MODE, MUSIC_CONSULT, PERSONAS, PERSONA_CONTEXT, PERSONA_GUIDE, PERSONA_TEMPERATURE, PROVIDERS, REPLY_LANGUAGE, SITE_GUIDE, SITE_SEARCH, SUGGESTER, SYNTHESIZER, SYNTH_BIAS, TITLER } from '../personas.js';
import { cleanMotion, parseVote, magiTally, cleanMagiHistory, magiHistoryNote } from '../magi-mode.js';
import { chatPageEvent, getSitePages, searchDeadline, searchFailure, searchSlice, selectSitePages, siteGuide } from '../site-search.js';
// デプロイ時点の人格カード。wrangler がデプロイ時にバンドルへ取り込む（config/ai-models.json と同じ）。
// 取得できないときの最後の拠り所で、デプロイし直すたびにその時点の最新に入れ替わる
import { classifyQuery, cleanReplyLanguage, classifySlice, languageNote } from '../classification.js';
import bundledContext from '../../../data/magi-context.json';

const ALLOWED_ORIGINS = ['https://tk.st', 'https://www.tk.st'];
// Native app shells (Capacitor/Ionic) and local dev all serve from a localhost
// origin fixed by the WebView — not spoofable from another web page — so we trust
// them like tk.st. Covers http/https/capacitor/ionic schemes. The MAGI mobile app
// (magi-app/) runs on https://localhost (capacitor.config iosScheme/androidScheme).
const APP_ORIGIN_RE = /^(https?|capacitor|ionic):\/\/localhost(:\d+)?$/;
const isAllowedOrigin = (o) => ALLOWED_ORIGINS.includes(o) || APP_ORIGIN_RE.test(o);

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
function inputError(err, requestId, cors) {
  return httpError(err.envelope?.http_status || 400, err.envelope || {
    stage: 'bad_request', code: 'invalid_json', message: 'リクエストボディの JSON が不正です', retryable: false,
  }, requestId, cors);
}

// Content-Length が無い場合も、JSON を展開する前に読み取り量を制限する。
async function readJsonLimited(request, maxBytes) {
  const tooLarge = () => stageError('bad_request', 'request_too_large', 'リクエストサイズが上限を超えています', { http_status: 413, retryable: false });
  if (Number(request.headers.get('Content-Length')) > maxBytes) throw tooLarge();
  if (!request.body) throw stageError('bad_request', 'invalid_json', 'リクエストボディがありません', { retryable: false });
  const reader = request.body.getReader();
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
    const body = JSON.parse(text + dec.decode());
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid body');
    return body;
  } finally { reader.releaseLock(); }
}

function checkText(text, maxChars, counters) {
  if (text.length > maxChars) throw stageError('bad_request', 'text_too_long', `本文は ${maxChars} 文字までです`, { retryable: false });
  counters.text += text.length;
  if (counters.text > DEFAULTS.input.history_max_chars) throw stageError('bad_request', 'history_too_long', '会話の履歴が文字数の上限を超えています', { retryable: false });
}

const sha256 = async (text) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('');

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
// そのうち assistant の debate（その回の各人格の意見）だけは opinions として残し、人格ごとの履歴に使う
// （personaThread）。上流の API へは role と content しか送らない（requestBody）。
function normaliseMessage(m, counters) {
  if (!m || (m.role !== 'user' && m.role !== 'assistant')) {
    throw stageError('bad_request', 'invalid_message_shape', '各 message は role:"user"|"assistant" が必要です', { retryable: false });
  }
  if (typeof m.content === 'string') {
    checkText(m.content, m.role === 'user' ? DEFAULTS.input.user_max_chars : DEFAULTS.input.assistant_max_chars, counters);
    if (!m.content.trim()) throw stageError('bad_request', 'empty_content', 'メッセージが空です', { retryable: false });
    const opinions = m.role === 'assistant' ? normaliseDebate(m.debate) : null;
    if (opinions) for (const text of Object.values(opinions)) checkText(text, DEFAULTS.persona_history_max_chars, counters);
    const magi = m.role === 'assistant' && m.mode === 'magi' ? cleanMagiHistory(m.magi) : null;
    return { role: m.role, content: m.content, ...(opinions ? { opinions } : {}), ...(magi ? { magi } : {}) };
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
  const withRecap = (c) => recap ? prependText(`${recap}〔ユーザーの今回の発言〕\n`, c) : c;
  for (const m of history) {
    if (m.role === 'user') { push('user', withRecap(m.content)); recap = null; continue; }
    const own = m.opinions && m.opinions[codename];
    if (own) push('assistant', own);
    const others = PERSONAS.filter(p => p.codename !== codename && m.opinions && m.opinions[p.codename]);
    recap = (others.length
      ? `〔前回、${others.map(personaLabel).join('と')}が言ったこと〕\n${others.map(p => `- ${personaLabel(p)}: ${m.opinions[p.codename]}`).join('\n')}\n\n`
      : '')
      + `〔前回、あなたたち3人の議論をまとめて Shinya Takeda が答えたこと〕\n${magiHistoryNote(m.magi)}${contentText(m.content)}\n\n`;
  }
  push('user', withRecap(lastContent));
  return out;
}

// 「120文字以内」の指定を数えて、末尾に「（109文字）」「(98 characters)」と書き足すモデルがある（Gemini）。
// プロンプトでも止めているが、書かれたときはここで落とす
const stripCharCount = (text) => text.replace(/\s*[（(]\s*\d+\s*(?:文字|字|characters?|chars?)\s*[）)]\s*$/i, '').trim();

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
    case 'google':
      // Gemini 3 系は推論を切れない（最低 minimal）。temperature / top_p は推論ありでも効く
      return { ...base, reasoning_effort: cfg.reasoning_effort, max_tokens: cfg.max_tokens, ...sampling };
    default:
      throw stageError('internal', 'unknown_provider', `未知の呼び出し先です: ${cfg.provider}`, { retryable: false });
  }
}

async function callModel({ env, messages, cfg, stream, signal, temperature, response_format }) {
  const provider = PROVIDERS[cfg.provider];
  const body = requestBody(cfg, { messages, stream, temperature, response_format });
  if (typeof env.evalObserve === 'function' && stream) body.stream_options = { include_usage: true };
  const key = env[provider.key];
  if (!key) throw stageError('internal', 'missing_api_key', `${provider.key} が未設定です`, { retryable: false });
  if (cfg.provider === 'google' && env.recordGoogleUsage) env.recordGoogleUsage(env.modelUsagePurpose || 'chat', 'attempt');
  const res = await fetch(provider.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify(body),
    signal,
  });
  if (cfg.provider === 'google' && res.status === 429 && env.recordGoogleUsage) env.recordGoogleUsage(env.modelUsagePurpose || 'chat', 'limited');
  if (typeof env.evalObserve === 'function') env.evalObserve(cfg.provider, cfg.model, res.clone(), !!stream);
  // 失敗は残高切れ・キーの失効でないかを見る（本文は呼び出し側も読むので複製を渡す）
  // 検索では本文の分類を待つ。先に戻ると検索の後処理がabortし、複製した本文も読めなくなる。
  // メールの送信はフック内のwaitUntilで行うので、ここでは待たない。
  if (!res.ok && env.onUpstreamError) await env.onUpstreamError(cfg.provider, res.clone());
  return res;
}

// --- 上流の会社の残高切れ・キーの失効をメールで知らせる ---
// 1人格の失敗は欠席（[NO RESPONSE]）として黙って進むので、チャージを使い切っても画面からは気づきにくい。
// 401・402・403 と、残高や枠の不足を示す 429 を拾う（ただの回数制限の 429 は拾わない）。
// 同じ会社・同じ状態は UTC の1日に1通（rate_limit の行を「送った」印に使う）。
// 宛先と送り元は secret（RESEND_API_KEY・ALERT_TO・ALERT_FROM）。どれかが無ければログに出すだけ。ALERT_TO はカンマ区切りで複数書ける。
const QUOTA_RE = /insufficient|quota|balance|billing|credit|exhausted/i;
const PROVIDER_ROLES = {
  openai: 'OpenAI（CASPER-3・統合・タイトル・次の質問の予測。統合が止まると会話全体が止まる）',
  deepseek: 'DeepSeek（MELCHIOR-1）',
  google: 'Google Gemini（BALTHASAR-2）',
  typesafe: 'TypeSafe AI（Jev。発言の言語の判定）',
};
async function alertUpstream(env, log, provider, res) {
  const body = (await res.text().catch(() => '')).slice(0, 500);
  const billing = [401, 402, 403].includes(res.status) || (res.status === 429 && QUOTA_RE.test(body));
  if (!billing) return;
  log('upstream_alert', provider, res.status, body.slice(0, 200));
  await sendAlert(env, log, `alert:${provider}:${res.status}`, `[MAGI] ${provider} の呼び出しが HTTP ${res.status} で失敗しています`, [
    `MAGI（magi2）で、${PROVIDER_ROLES[provider] || provider} の API の呼び出しが失敗しています。`,
    '',
    `HTTP ${res.status}`,
    body,
    '',
    '残高の不足（チャージ切れ）か、キーの失効・権限の問題の可能性があります。',
    provider === 'typesafe'
      ? '言語の判定は手元の規則に切り替えて、会話は続けます（英字の混ざった日本語に、他の言語で答えることがあります）。'
      : 'この会社の人格は [NO RESPONSE] のまま、残りの人格で答え続けます。',
    '同じ会社・同じ状態のメールは UTC の1日に1通です。',
  ]);
}

// 通知メールを送る。key ごとに UTC の1日に1通（rate_limit に key の行を「送った」印として作る）。
// 送れなかったら印を消し、次の機会にまた試す。secret が無ければログに出すだけ
async function sendAlert(env, log, key, subject, lines, redact = false) {
  if (!env.DB || !env.RESEND_API_KEY || !env.ALERT_TO || !env.ALERT_FROM) { log('alert', 'mail skipped (secret missing)', key); return; }
  const day = new Date().toISOString().slice(0, 10);
  if (await countUp(env.DB, key, day, 1) == null) return; // 今日はもう送った
  let sent = false, res;
  try {
    res = await fetch('https://api.resend.com/emails', {
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
  // エラー本文の受信が止まっても再試行を妨げないよう、印を解除してから本文を読む。
  if (res && !sent) {
    if (redact) { log('alert', 'mail failed', res.status); await res.body?.cancel().catch(() => {}); }
    else log('alert', 'mail failed', key, res.status, (await res.text().catch(() => '')).slice(0, 200));
  }
}

// 検索は本文を判定にだけ使い、例外・本文をログにも通知にも渡さない。
function searchUpstream(env, ctx, log, purpose) {
  return Object.assign(Object.create(env), {
    modelUsagePurpose: purpose === '404検索' ? '404' : 'chat',
    onUpstreamError: async (provider, res) => {
      let body = '';
      try { body = await searchDeadline(2000, () => res.text()); } catch (_) {}
      finally { if (!res.bodyUsed) await res.body?.cancel().catch(() => {}); }
      if (![401, 402, 403].includes(res.status) && !(res.status === 429 && QUOTA_RE.test(body))) return;
      log('site_search', 'upstream_alert', provider, res.status);
      ctx.waitUntil(sendAlert(env, log, `alert:${provider}:${res.status}`, `[MAGI] ${provider} HTTP ${res.status}`, [
        `用途: ${purpose}`, `会社: ${provider}`, `HTTP: ${res.status}`,
      ], true).catch(() => log('site_search', 'alert_failed')));
    },
  });
}

async function handleSiteSearch(request, env, ctx, { requestId, cors, log }) {
  const fail = (status, code) => httpError(status, {
    stage: status === 429 ? 'rate_limit' : status < 500 ? 'bad_request' : 'upstream', code,
    message: status === 429 ? '本日の利用上限に達しました。明日またお試しください' : status < 500 ? '検索の入力が不正です' : 'いまは AI に聞けません',
    retryable: status === 503,
  }, requestId, cors);
  const started = Date.now();
  try {
    return await searchDeadline(SITE_SEARCH.request_timeout_ms, async signal => {
      if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return fail(400, 'invalid_json');
      let body;
      try { body = await readJsonLimited(request, SITE_SEARCH.request_bytes); }
      catch (err) { return fail(err.envelope?.http_status || 400, err.envelope?.code || 'invalid_json'); }
      if (Object.keys(body).length !== 2 || typeof body.query !== 'string' || !['ja', 'en'].includes(body.locale)) return fail(400, 'invalid_query');
      const query = body.query.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
      if (!query || Array.from(body.query).length > SITE_SEARCH.query_max_chars) return fail(400, 'invalid_query');
      const params = new URL(request.url).searchParams;
      if ([...params.keys()].some(k => k !== 'site_debate') || params.getAll('site_debate').length > 1
        || (params.has('site_debate') && params.get('site_debate') !== '1')) return fail(400, 'invalid_site_debate');
      if (!params.has('site_debate')) return httpError(409, { stage: 'bad_request', code: 'site_search_update_required',
        message: 'ページを再読み込みしてください', retryable: false }, requestId, cors);
      if (env.SITE_SEARCH_ENABLED !== 'true' || !env.DB) return fail(503, 'search_unavailable');
      const [pages, cards] = await Promise.all([getSitePages(ctx, body.locale, signal), getPersonaCards(ctx, () => {})]);
      if (signal.aborted) throw searchFailure('cancelled');
      const day = new Date().toISOString().slice(0, 10);
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (await countUp(env.DB, 'search:' + ip, day, SITE_SEARCH.daily_limit) == null) return fail(429, 'daily_limit_exceeded');
      if (await countUp(env.DB, 'search:global', day, SITE_SEARCH.global_daily_limit) == null) {
        ctx.waitUntil(sendAlert(env, log, 'alert:site-search-global', '[MAGI] AI検索の本日の全体上限に達しました', [
          `UTC日付: ${day}`, `全体上限: ${SITE_SEARCH.global_daily_limit}`,
        ], true).catch(() => log('site_search', 'alert_failed')));
        return fail(429, 'global_daily_limit_exceeded');
      }
      if (signal.aborted) throw searchFailure('cancelled');
      const upstream = searchUpstream(env, ctx, log, '404検索');
      const result = await selectSitePages({ query, locale: body.locale, pages, cards, chat: true, purpose: 'requested', signal, log,
        call: opts => callModel({ ...opts, env: upstream }) });
      const answer = await runDiscussion({ upstream, cards, plainMessages: [{ role: 'user', content: query }],
        langNote: languageNote({ code: body.locale }), pageChoice: result, signal, send: () => {}, log: stage => log('site_search', stage) });
      return jsonResponse({ request_id: requestId, ...result, comment: answer }, cors, 200, { 'Cache-Control': 'no-store' });
    }, request.signal);
  } catch (_) { log('site_search', 'unavailable'); return fail(503, 'search_unavailable'); }
  finally { log('site_search', 'elapsed_ms', Date.now() - started); }
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
    const text = classifySlice(stripCharCount((choice.message?.content || '').trim()), DEFAULTS.persona_response_max_chars);
    log('persona_call', p.codename, cfg.provider, `r${round}`, `finish_reason=${choice.finish_reason}`, `len=${text.length}`, `attempt=${attempt}`);
    if (text) return round && p.magi && choice.finish_reason === 'length' ? text + '…' : text;
    // 空応答は1回だけ再試行。安全フィルターで止められた（content_filter）なら同じ結果になるので試さない
    if (attempt < 2 && choice.finish_reason !== 'content_filter') continue;
    throw stageError('persona_call', 'empty_persona_output', `${p.codename} が空の応答を返しました (finish_reason=${choice.finish_reason})`, { persona: p.codename, round, retryable: true });
  }
  // ループは attempt=2 で必ず return/throw に到達するためここには来ない（防御的）
  throw stageError('persona_call', 'unreachable', `${p.codename} の応答取得に失敗しました`, { persona: p.codename, round, retryable: true });
}

// 会話の初回ユーザー発言からチャットタイトルを要約生成（非クリティカル：失敗しても null）。
async function fetchTitle(env, lastContent, langNote, signal, log) {
  try {
    const res = await callModel({
      env, cfg: DEFAULTS.models.titler, stream: false, signal,
      // lastContent は文字列か画像込みのパート配列。画像だけの発言でも題を付けられる
      messages: [{ role: 'system', content: withLangNote(TITLER.system_prompt, langNote) }, { role: 'user', content: lastContent }],
    });
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
const isLanguageLetter = (ch) => /\p{L}/u.test(ch) && !/[\p{Script=Common}\p{Script=Inherited}]/u.test(ch);
const isKanaLetter = (ch) => /\p{L}/u.test(ch) && /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(ch);
const isJapaneseLetter = (ch) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(ch);
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
    const res = await callModel({
      env, cfg: DEFAULTS.models.suggester, stream: false, signal, temperature: SUGGESTER.temperature,
      messages: [{ role: 'system', content: SUGGESTER.system_prompt }, { role: 'user', content: input }],
    });
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
const viewLabel = (v) => v.round === 1 ? '初回' : v.round === 2 ? '討議後' : `第${v.round}回`;
const debateRecord = (opinions) => opinions.map(o => `- ${o.name}（${o.codename}）\n`
  + o.views.map(v => `  ${viewLabel(v)}${v.vote_state ? ` [${voteLabel(v.vote)}]` : ''}${v.ask ? `（自分の問い「${v.ask}」への答え）` : ''}: ${v.absent ? PERSONA_ABSENT : v.text || '（理由なし）'}`).join('\n')).join('\n');
const voteLabel = vote => vote === 'approve' ? '承認' : vote === 'reject' ? '否決' : '票なし';

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

// 統合人格（本人）として、いま答えを書けるか、聞き返すなら誰に何を聞くかを決める。
// 返すのは { assessment, questions }（questions が空なら答える）。questions の相手は、いま討議に残っている人格（active）に限る。
// 非クリティカル：失敗・時間切れ・形の崩れた JSON は null（その時点の討議で統合する）
async function fetchJudgement(env, { system, input, active }, signal, log) {
  try {
    const res = await callModel({
      env, cfg: DEFAULTS.models.judge, stream: false, signal, response_format: DEBATE.format,
      messages: [{ role: 'system', content: system }, { role: 'user', content: input }],
    });
    if (!res.ok) { log('debate', 'judge', `HTTP ${res.status}`); return null; }
    const choice = (await res.json()).choices?.[0] || {};
    if (choice.finish_reason !== 'stop') { log('debate', 'judge', `finish_reason=${choice.finish_reason}`); return null; }
    const v = JSON.parse(choice.message?.content || '');
    const seen = new Set();
    const questions = v.action === 'ask' && Array.isArray(v.questions) ? v.questions.flatMap(q => {
      const text = q && typeof q.question === 'string' ? q.question.trim().slice(0, DEBATE.ask_max_chars) : '';
      if (!text || !active.includes(q.target) || seen.has(q.target)) return [];
      seen.add(q.target);
      return [{ target: q.target, question: text }];
    }) : [];
    const assessment = typeof v.assessment === 'string' ? v.assessment.trim().slice(0, DEBATE.assessment_max_chars) : '';
    return { assessment, questions };
  } catch (e) {
    log('debate', 'judge', 'failed', e && (e.name || e.message));
    return null;
  }
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
async function readSynthesis(body, send) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '', answer = '', finished = false, finishReason = null;
  const line = (raw) => {
    if (!raw.startsWith('data:')) return;
    const payload = raw.slice(5).trim();
    if (payload === '[DONE]') { finished = true; return; }
    let data;
    try { data = JSON.parse(payload); }
    catch (_) { throw stageError('synthesizer_call', 'invalid_stream', '統合応答の形式が不正です', { retryable: true }); }
    if (data.error) throw stageError('synthesizer_call', 'stream_error', '統合応答の途中でエラーが発生しました', { retryable: true });
    const choice = data.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    const delta = choice?.delta?.content;
    if (typeof delta === 'string') { answer += delta; send('integrated', { delta }); }
  };
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
    if (!finished || finishReason !== 'stop') throw stageError('synthesizer_call', 'incomplete_output', '統合応答が最後まで生成されませんでした', { retryable: true });
    if (!answer.trim()) throw stageError('synthesizer_call', 'empty_output', '統合人格が空の応答を返しました', { retryable: true });
    return answer;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

// 処理全体にタイムアウトを掛け、成功・失敗のどちらでもタイマーを解除する。
// ストリームは fetch の完了だけでなく、本文を読み終わるまでこの中で扱う。
// stop（利用者が止めた・接続が切れた）を渡すと、時間切れの前でもそこで止める。
async function withTimeout(ms, run, stop) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), ms);
  const onStop = () => ac.abort();
  if (stop) { if (stop.aborted) ac.abort(); else stop.addEventListener('abort', onStop); }
  try { return await run(ac.signal); }
  finally { clearTimeout(id); if (stop) stop.removeEventListener('abort', onStop); }
}

// リアクションの登録・取り消し。認可は入口で共通に確認する。
async function handleReaction(request, env, { requestId, cors, log }) {
  let body;
  try { body = await readJsonLimited(request, DEFAULTS.reactions.max_request_bytes); }
  catch (err) { return inputError(err, requestId, cors); }

  const op = body.op === 'remove' ? 'remove' : 'add';
  const target = typeof body.target === 'string' ? body.target.slice(0, 40) : '';
  if (![...PERSONAS.map(p => p.codename), 'integrated'].includes(target)) {
    return httpError(400, { stage: 'bad_request', code: 'invalid_target', message: 'リアクション対象が不正です', retryable: false }, requestId, cors);
  }
  if (!env.DB) {
    log('reaction', 'skipped (no DB binding)');
    return httpError(500, { stage: 'internal', code: 'no_db', message: 'DB binding がありません', retryable: false }, requestId, cors);
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
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
async function readChatInput(request) {
  const body = await readJsonLimited(request, DEFAULTS.input.max_request_bytes);
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
  if (messages[messages.length - 1].role !== 'user') {
    throw stageError('bad_request', 'last_not_user', '最後の message は role:"user" である必要があります', { retryable: false });
  }
  // DJ の状況説明は本文に紛れ込ませず、専用の上限で検証してから先頭の質問へ添える。
  // 予測には添える前の会話と状況説明を別に渡す（ユーザーの発言に混ぜると、状況説明の回答ルールを予測がなぞる）
  // 出力の言語は状況説明を足す前の会話で決める（状況説明は日本語なので、足した後だと日本語に見える）
  const plainMessages = messages;
  const langNote = replyLanguageNote(plainMessages);
  let context = null;
  if (body.context != null) {
    if (typeof body.context !== 'string') throw stageError('bad_request', 'invalid_context', 'context は文字列である必要があります', { retryable: false });
    checkText(body.context, DEFAULTS.input.context_max_chars, counters);
    context = body.context;
    const first = messages.findIndex(m => m.role === 'user');
    messages = messages.map((m, i) => i === first ? { ...m, content: prependText(context + '\n', m.content) } : m);
  }
  const newContract = body.classification_state === true;
  const entry = body.entry === 'dj-request' ? 'dj-request' : 'chat';
  const replyLanguage = newContract ? cleanReplyLanguage(body.reply_language) : null;
  let seed = typeof body.language_seed === 'string' ? body.language_seed : classifySlice(contentText(plainMessages.find(m => m.role === 'user').content), INTENT_CLASSIFY.language_seed_max_chars);
  if (newContract && !replyLanguage) checkText(seed, INTENT_CLASSIFY.language_seed_max_chars, counters);
  if (!newContract || replyLanguage) seed = null;
  return { messages, plainMessages, context, langNote, theme, wantSuggest, wantSitePages, adaptive, page,
    newContract, magiPanel: body.magi_panel === true, entry, replyLanguage, seed, uiLanguage: body.ui_language === 'en' ? 'en' : 'ja' };
}

function siteSelectionNote(choice) {
  if (choice.status === 'failed') return SITE_SEARCH.failed_note;
  return SITE_SEARCH.synth_header + '\n' + SITE_SEARCH.answer_note + '\n' + JSON.stringify({
    status: choice.status, pages: choice.results.map(({ title, description }) => ({ title, description })),
    daily: choice.daily ? { media: choice.daily.media, query: choice.daily.query } : null,
  });
}

async function createMotion(env, plainMessages, langNote, signal, log) {
  try {
    const last = plainMessages.at(-1), ref = plainMessages.slice(-3, -1);
    const reference = ref.length === 2 && ref[0].role === 'user' && ref[1].role === 'assistant'
      && ref.every(m => contentText(m.content).length <= MAGI_MODE.motion_reference_max_chars)
      ? ref.map(m => ({ role: m.role, text: contentText(m.content) })) : [];
    const res = await callModel({ env, cfg: DEFAULTS.models.motion, stream: false, signal, response_format: MAGI_MODE.motion_format,
      messages: [{ role: 'system', content: withLangNote(MAGI_MODE.motion_prompt, langNote) },
        { role: 'user', content: JSON.stringify({ latest: contentText(last.content), has_image: !!contentImages(last.content).length, reference }) }] });
    if (!res.ok) throw new Error('motion_http');
    const c = (await res.json()).choices?.[0];
    if (c?.finish_reason !== 'stop') throw new Error('motion_incomplete');
    const v = JSON.parse(c.message.content);
    if (v.votable === false) return { text: '', votable: false, reason: 'not_votable' };
    const text = v.votable === true && cleanMotion(v.motion);
    if (!text) throw new Error('invalid_motion');
    return { text, votable: true };
  } catch (e) { log('motion', 'failed', e.name); return { text: '', votable: false, reason: 'failed' }; }
}

async function resolveVotes(env, opinions, round, motion, signal, send, log) {
  const pending = opinions.flatMap(p => {
    const v = p.views.find(v => v.round === round && v.vote_state === 'pending');
    return v ? [{ p, v }] : [];
  });
  if (!pending.length) return;
  let votes = [];
  try {
    votes = await withTimeout(MAGI_MODE.vote_reader_ms, async signal => {
      const res = await callModel({ env, cfg: DEFAULTS.models.vote_reader, stream: false, signal, response_format: MAGI_MODE.vote_reader_format,
        messages: [{ role: 'system', content: MAGI_MODE.vote_reader_prompt }, { role: 'user', content: JSON.stringify({ motion,
          responses: pending.map(({ p, v }) => ({ codename: p.codename, text: v.raw })) }) }] });
      if (!res.ok) return [];
      const c = (await res.json()).choices?.[0];
      const v = c?.finish_reason === 'stop' ? JSON.parse(c.message.content).votes : [];
      return Array.isArray(v) ? v : [];
    }, signal);
  } catch (e) { log('vote_reader', 'failed', e.name); }
  for (const { p, v } of pending) {
    const matches = votes.filter(x => x?.codename === p.codename);
    v.vote = matches.length === 1 && ['approve', 'reject'].includes(matches[0].vote) ? matches[0].vote : null;
    v.vote_state = 'final';
    send('persona', { round, codename: p.codename, name: p.name, text: v.text, vote: v.vote, vote_state: 'final' });
  }
}

async function runDiscussion({ upstream, cards, plainMessages, messages = plainMessages, context = null, langNote,
  theme = null, adaptive = false, shortDebate = true, newContract = true, guide = null, pageChoice = null,
  pagesPromise = null, page = null, music = false, motion = null, signal, send, log }) {
  const stop = { signal };
  const history = messages.slice(0, -1);
  const lastContent = messages.at(-1).content;
  const lastUser = contentText(lastContent), lastImages = contentImages(lastContent);
  const noteLang = c => langNote ? joinContent(c, langNote) : c;
  const personaTimeoutMs = lastImages.length ? DEFAULTS.timeouts.persona_vision_ms : DEFAULTS.timeouts.persona_ms;
  // 揺らぎ：3人格の temperature を UI テーマで変える（light=1.0 / dark=1.3、未指定は既定）
  const personaTemp = theme ? PERSONA_TEMPERATURE[theme] : undefined;
  if (personaTemp != null) log('persona_call', 'temperature', theme, personaTemp);

  // 人格カード（サイト本文由来の「いまの中身」）とサイト案内を骨格プロンプトに足す。R2 は opinions 経由で同じものを使う
  const personas = PERSONAS.map(p => withCard({ ...p, magi: !!motion, system_prompt: p.system_prompt + '\n' + p.role[motion ? 'magi' : 'chat'] }, cards))
    .map(p => guide ? { ...p, system_prompt: `${p.system_prompt}\n\n${guide.persona}` } : p)
    .map(p => ({ ...p, system_prompt: withLangNote(p.system_prompt
      + (music ? '\n\n' + MUSIC_CONSULT.system_note : '')
      + (pageChoice ? '\n\n' + siteSelectionNote(pageChoice) : ''), langNote) }));

  // 人格ごとに呼び出し先の会社が違うので、1人格の失敗（相手側の障害・安全フィルター・時間切れ）では
  // 止めず、その人格を抜かして進める。画面のカードを「考え中」のまま残さないよう、欠けた回には印を送る。
  const absent = (p, round, reason) => {
    log('persona_call', p.codename, `r${round}`, 'dropped', reason && ((reason.envelope && reason.envelope.code) || reason.name || reason.message));
    const v = { round, text: PERSONA_ABSENT, absent: true, ...(motion ? { vote: null, vote_state: 'final' } : {}) };
    if (motion) { (records[p.codename] ||= []).push(v); if (p.views) p.views.push(v); }
    send('persona', { ...v, codename: p.codename, name: p.name });
  };
  const records = {};
  const respond = (p, round, raw, ask) => {
    const v = { round, text: raw, ...(motion ? parseVote(raw) : {}), ...(ask ? { ask } : {}) };
    (records[p.codename] ||= []).push(v);
    send('persona', { round, codename: p.codename, name: p.name, text: v.text,
      ...(motion ? { vote: v.vote, vote_state: v.vote_state } : {}) });
    return v;
  };
  const votedText = v => motion ? `[${voteLabel(v.vote)}] ${v.absent ? PERSONA_ABSENT : v.text || '（理由なし）'}` : v.text;
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
      return { ...p, r1: v.text, views: [v] };
    })), stop.signal);
  const opinions = [];
  r1.forEach((r, i) => {
    if (r.status === 'fulfilled') { opinions.push(r.value); return; }
    absent(personas[i], 1, r.reason);
    if (!newContract) absent(personas[i], 2);
  });
  // 全員が失敗したときだけエラーにする（時間切れなら外側の catch が upstream timeout にする）
  if (!opinions.length) throw r1[0].reason;
  log('persona_call', 'round1 ok', `personas=${opinions.length}`);
  if (motion) await resolveVotes(upstream, opinions, 1, motion, stop.signal, send, log);

  // --- R2: 各人格が他の人格のR1意見を踏まえて討議・更新 ---
  // 失敗した人格は初回意見のまま統合に回す。相手がいない（1人しか残っていない）ときは討議しない
  log('persona_call', 'round2 start');
  await withTimeout(personaTimeoutMs, signal =>
    Promise.all(opinions.map(async (p) => {
      const others = opinions.filter(o => o.codename !== p.codename)
        .map(o => `- ${o.name}（${o.codename}）: ${votedText(o.views[0])}`).join('\n');
      if (!others) { if (!newContract) absent(p, 2); return; }
      // 寄り添い寄りのモデルは他の意見に流されやすいので、賛同するにも自分の理由を求める
      const dmsg = `${lastUser}${motion ? `\n【共通の議題】${motion}\n${MAGI_MODE.persona_rounds.debate}` : ''}\n\n[あなたの初回意見]\n${votedText(p.views[0])}\n\n[討議メモ：他の人格の初回意見は以下。これを踏まえ、賛同・反論・補強のいずれかで自分の考えを更新せよ。賛同するなら自分の理由で述べ、自分の関心と価値観は手放さない。単なる繰り返しは避ける]\n${others}`;
      try {
        const text = await fetchPersonaText(upstream, p, personaThread(p.codename, history, withImages(noteLang(dmsg), lastImages)), signal, log, 2, personaTemp);
        p.views.push(respond(p, 2, text));
      } catch (e) { absent(p, 2, e); }
    })), stop.signal);
  log('persona_call', 'round2 ok', `personas=${opinions.filter(o => o.views.length > 1).length}`);
  if (motion) await resolveVotes(upstream, opinions, 2, motion, stop.signal, send, log);

  // --- 第3回以降: 統合人格が回ごとの基準で判定し、掘る論点に答えられる人格にだけ聞き返す ---
  // 対応を宣言した画面だけ（DEBATE）。判定は第2〜4回の後で、第5回の後は判定せずに統合する。
  // 時間の予算を過ぎたら次の回を始めない。判定に失敗したらその時点の討議で統合する
  const maxRounds = (motion || adaptive && !shortDebate) && (!newContract || opinions.length > 1) ? DEBATE.max_rounds : 2;
  let assessment = '', lastRound = opinions.length > 1 ? 2 : 1;
  for (let round = 3; round <= maxRounds && !stop.signal.aborted; round++) {
    if (Date.now() - debateStarted > DEBATE.budget_ms) { log('debate', `r${round}`, 'over budget'); break; }
    const judgeSystem = withLangNote(withCard({ ...SYNTHESIZER, system_prompt: (motion ? MAGI_MODE.judge_prompt : DEBATE.system_prompt)(round - 1, maxRounds) }, cards, PERSONA_CONTEXT.synth_header).system_prompt, langNote);
    const judgement = await withTimeout(DEBATE.judge_ms, signal => fetchJudgement(upstream, {
      system: judgeSystem, input: (motion ? `【共通の議題】${motion}\n` : '') + judgeInput(plainMessages, context, opinions, langNote), active: opinions.map(o => o.codename),
    }, signal, log), stop.signal);
    if (judgement && judgement.assessment) assessment = judgement.assessment;
    log('debate', `after r${round - 1}`, !judgement ? 'judge failed' : judgement.questions.length ? `ask ${judgement.questions.map(q => q.target).join(',')}` : 'answer');
    // 答えるときも判定が済んだことを送る（画面の無通信の見張りは、何か届くたびに延びる。判定の待ちを統合の待ちに上乗せしない）
    if (!judgement || !judgement.questions.length) { send('judge', { round: round - 1, action: 'answer' }); break; }
    // 問いを先に画面へ出す（聞かれた人格のカードを「考え中」に戻す）
    const asked = judgement.questions.map(q => ({ p: opinions.find(o => o.codename === q.target), ask: q.question }));
    send('ask', { round, max_rounds: maxRounds, questions: asked.map(({ p, ask }) => ({ codename: p.codename, name: p.name, text: ask })) });
    await withTimeout(personaTimeoutMs, signal =>
      Promise.all(asked.map(async ({ p, ask }) => {
        const own = p.views.map(v => `${viewLabel(v)}: ${votedText(v)}`).join('\n');
        const others = opinions.filter(o => o.codename !== p.codename)
          .map(o => `- ${o.name}（${o.codename}）: ${votedText(o.views[o.views.length - 1])}`).join('\n');
        const qmsg = `${lastUser}${motion ? `\n【共通の議題】${motion}\n${MAGI_MODE.persona_rounds.followup}` : ''}\n\n[あなたのこれまでの意見]\n${own}`
          + (others ? `\n\n[他の人格のいまの意見]\n${others}` : '')
          + `\n\n[3人の議論をまとめる Shinya Takeda から、あなたへの問い（第${round}回）]\n${ask}`
          + '\n\n[この問いに、自分の関心と価値観から答えよ。考えが変わったなら変わったと言い、変わらないなら理由を足す。これまでの意見の繰り返しは避ける]';
        try {
          const text = await fetchPersonaText(upstream, p, personaThread(p.codename, history, withImages(noteLang(qmsg), lastImages)), signal, log, round, personaTemp);
          p.views.push(respond(p, round, text, ask));
        } catch (e) { absent(p, round, e); }
      })), stop.signal);
    lastRound = round;
    if (motion) await resolveVotes(upstream, opinions, round, motion, stop.signal, send, log);
  }

  const magiVerdict = motion ? magiTally(records, lastRound) : null;
  log('discussion', 'complete', lastRound);
  if (magiVerdict) send('verdict', magiVerdict);

  // --- 統合コール（推論あり・stream）---
  // 判定のメモ（一致・対立とその扱い）と、上限で打ち切ったことも添える
  const augmented = `${lastUser}\n\n[内部討議メモ：以下は各人格の初回意見と討議後の見解${lastRound > 2 ? '、自分が聞き返した問いへの答え' : ''}。これらを統合し、私(Shinya Takeda)として一人称で答える。人格名は出さない]\n${debateRecord(opinions)}`
    + (assessment ? `\n\n[討議を見た自分のメモ]\n${assessment}` : '')
    + (magiVerdict ? `\n\n【共通の議題と確定した採決】${motion}\n${JSON.stringify(magiVerdict)}\n採決は変更せず、その根拠を説明する。` : '')
    + ((motion || adaptive && !shortDebate) && lastRound === maxRounds ? `\n\n[${motion ? MAGI_MODE.synth_cap_note(maxRounds) : `討議は上限の${maxRounds}回で打ち切った。割れたままの点は、どれを取るか自分で決めて答える`}]` : '');
  // 揺らぎ：UI テーマに応じて優先人格を少し強める（light=Strategist / dark=Enthusiast）
  const bias = !motion && theme ? SYNTH_BIAS[theme] : null;
  if (bias) log('synthesizer_call', 'bias', theme);

  if (pagesPromise) {
    try { pageChoice = await searchDeadline(SITE_SEARCH.chat_wait_ms, () => pagesPromise, stop.signal); }
    catch (_) {  }
    if (stop.signal.aborted) throw searchFailure('cancelled');
  }
  // いま開いているページへのリンクは出さない（ページ選びにも選ばないよう伝えてあるが、念のため）
  if (pageChoice && page) pageChoice = { ...pageChoice, results: pageChoice.results.filter(p => p.url !== page) };
  const hasPages = pageChoice && (pageChoice.results.length || pageChoice.daily);
  const synthMessages = [
    // 統合人格のカード（自己像）があれば骨格の後ろに足す。無ければ骨格だけ
    { role: 'system', content: withCard({ ...SYNTHESIZER, system_prompt: SYNTHESIZER.system_prompt + '\n' + SYNTHESIZER.role[motion ? 'magi' : 'chat'] }, cards, PERSONA_CONTEXT.synth_header).system_prompt },
    ...(bias ? [{ role: 'system', content: bias }] : []),
    ...(guide ? [{ role: 'system', content: guide.synth }] : []),
    ...(pageChoice ? [{ role: 'system', content: siteSelectionNote(pageChoice) }] : []),
    ...(music ? [{ role: 'system', content: MUSIC_CONSULT.system_note }] : []),
    ...history.map(m => ({ ...m, content: prependText(magiHistoryNote(m.magi), m.content) })),
    { role: 'user', content: withImages(noteLang(augmented), lastImages) },
  ];

  const answer = await withTimeout(DEFAULTS.timeouts.synthesizer_ms, async (signal) => {
    log('synthesizer_call', 'start');
    const synthRes = await callModel({ env: upstream, cfg: DEFAULTS.models.synthesizer, stream: true, signal, messages: synthMessages });
    if (!synthRes.ok) {
      const detail = (await synthRes.text().catch(() => '')).slice(0, 200);
      throw stageError('synthesizer_call', `gpt_http_${synthRes.status}`, `統合人格の呼び出しが失敗しました (HTTP ${synthRes.status})`, { detail, retryable: synthRes.status >= 500 });
    }

    return readSynthesis(synthRes.body, send);
}, stop.signal);
log('synthesizer_call', 'ok');
if (motion) send('integrated_end', {});
if (hasPages && !stop.signal.aborted) send('pages', chatPageEvent(pageChoice));
return answer;}

async function handleChat(request, env, ctx, { requestId, cors, log }) {
  let input;
  try { input = await readChatInput(request); }
  catch (err) { return inputError(err, requestId, cors); }
  let { messages, plainMessages, context, langNote, theme, wantSuggest, wantSitePages, adaptive, page, newContract, magiPanel, entry, replyLanguage, seed, uiLanguage } = input;

  // 上流の呼び出しは、失敗を残高切れの通知に回す env で行う（bindings と secret は元の env から引き継ぐ）
  const upstream = Object.assign(Object.create(env), {
    onUpstreamError: (provider, res) => ctx.waitUntil(alertUpstream(env, log, provider, res).catch(e => log('upstream_alert', 'failed', e && e.message))),
  });
  const stop = new AbortController();
  const stopRequest = () => stop.abort();
  if (request.signal.aborted) stop.abort();
  else request.signal.addEventListener('abort', stopRequest, { once: true });
  // カードと分類は利用回数の確認と並行する。拒否・切断時は分類も止める。
  const cardsPromise = getPersonaCards(ctx, log);
  const classifyPromise = withTimeout(INTENT_CLASSIFY.timeout_ms, signal => classifyQuery(upstream, {
    profile: newContract ? entry : 'legacy', texts: plainMessages.filter(m => m.role === 'user').map(m => contentText(m.content)),
    seed, replyLanguage, uiLanguage, fallback: langNote,
  }, signal, log), stop.signal).then(value => ({ value }), error => ({ error }));
  const refuse = res => {
    stop.abort();
    request.signal.removeEventListener('abort', stopRequest);
    return res;
  };

  // 3) rate_limit: IP×UTC日次（DB 未設定の dev では skip）
  if (env.DB) {
    try {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const day = new Date().toISOString().slice(0, 10);
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

  // 4-5) SSE: 3人格（並列・欠けた人格は抜かして続ける。全員失敗でエラー）→ 統合（stream）
  // 利用者が止めた（画面の停止ボタン・タブを閉じた）ら、続きの呼び出しをまとめて止める。払うのは止めた時点までの分だけ
  const pageStop = new AbortController();
  const stopPages = () => pageStop.abort();
  stop.signal.addEventListener('abort', stopPages, { once: true });
  const stream = new ReadableStream({
    cancel() { log('client', 'cancelled'); stop.abort(); },
    start(controller) {
      const enc = new TextEncoder();
      let closed = false;
      const send = (event, data) => { if (closed) return; try { controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch (_) {} };
      const close = () => { if (!closed) { closed = true; try { controller.close(); } catch (_) {} } };

      ctx.waitUntil((async () => { try {
        // 出力の言語（3人格・統合・討議の判定・タイトル・予測の全部に同じものを付ける）
        const classificationResult = await classifyPromise;
        if (classificationResult.error) throw classificationResult.error;
        const classified = classificationResult.value;
        if (stop.signal.aborted) throw searchFailure('cancelled');
        langNote = classified.langNote;
        const classification = classified.classification;
        if (classification) classification.magi_candidate = env.MAGI_MODE_ENABLED === 'true' && newContract && magiPanel
          && entry === 'chat' && classification.votable === 'yes' && !!contentText(plainMessages.at(-1).content).trim();
        if (newContract) send('classification', classification);
        const motionPromise = classification?.magi_candidate ? withTimeout(MAGI_MODE.motion_ms,
          signal => createMotion(upstream, plainMessages, langNote, signal, log), stop.signal)
          .catch(() => ({ text: '', votable: false, reason: 'failed' })) : null;
        const history = messages.slice(0, -1);
        const lastContent = messages[messages.length - 1].content;
        // 討議メモ・統合プロンプトに埋め込むのは本文テキストのみ。画像はパートとして
        // R2 / 統合にも同じものを添え直す（人格が途中で画像を見失わないように）。
        const lastUser = contentText(lastContent);
        const lastImages = contentImages(lastContent);
        // 出力の言語。指示とカードが日本語なので、英語の会話だと付けないと日本語で答える（3人格・統合・タイトル・予測の全部に付ける）。
        // 3人格と統合は今回の発言の後ろに付ける（system の後ろだけだと、その後に読む日本語のカードや見本に負けて、CASPER は英語の質問の半分近くを日本語で答えた）。
        // 3人格は system の後ろにも重ねる（DJ の相談のように日本語の状況説明が付くと、発言の後ろだけでは足りない）
        const noteLang = (c) => langNote ? joinContent(c, langNote) : c;
        if (lastImages.length) log('vision', `images=${lastImages.length}`);
        // 画像付きは上流の処理が重くなるぶん、人格側のタイムアウトを広げる
        const personaTimeoutMs = lastImages.length ? DEFAULTS.timeouts.persona_vision_ms : DEFAULTS.timeouts.persona_ms;

        // --- タイトル要約：会話の初回ユーザー発言時のみ、本流と並列で生成 ---
        // 状況説明を足す前の発言から作る（足した後だと、状況説明の回答ルールに従って答えを書いてしまう）
        let titlePromise = null;
        if (!history.some(m => m.role === 'assistant')) {
          titlePromise = withTimeout(personaTimeoutMs, signal => fetchTitle(upstream, plainMessages[plainMessages.length - 1].content, langNote, signal, log), stop.signal)
            .then(t => { if (t) send('title', { text: t }); })
            .catch(() => {});
        }

        const motionEvent = motionPromise ? await motionPromise : null;
        if (stop.signal.aborted) throw searchFailure('cancelled');
        if (motionEvent) send('motion', motionEvent);
        const motion = motionEvent?.votable ? motionEvent.text : null;
        const shortDebate = !motion && newContract && ['site', 'music'].includes(classification.intent);

        // サイトの索引（data/site-search.json）は、ページ選びとサイト案内で同じものを使う。カードを待つ前に取り始める。
        // 停止フラグ（SITE_SEARCH_ENABLED）が true でなければ索引を読まない（サイト案内は場面の説明だけになる）
        const searchOn = env.SITE_SEARCH_ENABLED === 'true';
        const allowPages = !motion && (!newContract || (entry !== 'dj-request' && classification.intent !== 'music' && classification.site_pages !== 'no' && wantSitePages));
        const wantPages = allowPages && wantSitePages && searchOn && env.DB && lastUser.trim();
        const indexPromise = searchOn && (!newContract || env.DB) && ((allowPages && page) || wantPages) ? getSitePages(ctx, 'ja', pageStop.signal).catch(() => null) : null;
        const cards = await cardsPromise;
        // サイト案内（画面が page を送ったときだけ）。3人格を長く待たせないよう、索引は短い期限で待つ。
        // 取れなければ一覧なしで、場面の説明だけを足す
        let guide = null;
        if (!motion && page && (!newContract || classification.intent !== 'music')) {
          let pages = null;
          try { pages = await searchDeadline(SITE_GUIDE.wait_ms, () => indexPromise, stop.signal); } catch (_) {}
          if (stop.signal.aborted) throw searchFailure('cancelled');
          guide = siteGuide(page, pages);
          log('site_guide', page, guide.current ? 'known' : 'unknown', pages ? 'listed' : 'unlisted');
        }
        // ページ選びもこの分岐で始める。人格の討議は検索の取得待ちにしない。
        let pagesPromise = null;
        if (wantPages) {
          const searchEnv = searchUpstream(env, ctx, log, 'チャットのページ選び');
          pagesPromise = (async () => {
            const locale = newContract ? classification.reply_language.code === 'ja' ? 'ja' : 'en'
              : /[\u3040-\u30ff\u3400-\u9fff]/.test(lastUser) ? 'ja' : 'en';
            // 索引は日英の名前でキャッシュしてある。取得は上の1回で済んでいるので、ここは言語を選ぶだけ
            if (!await indexPromise) throw searchFailure('list_fetch');
            const pages = await getSitePages(ctx, locale, pageStop.signal);
            return selectSitePages({ query: searchSlice(lastUser, SITE_SEARCH.chat_query_max_chars), locale, pages, chat: true, current: guide && guide.current,
              purpose: newContract && classification.intent === 'site' ? 'requested' : 'auxiliary',
              signal: pageStop.signal, log, call: opts => callModel({ ...opts, env: searchEnv }) });
          })().catch(() => { log('site_search', 'omitted'); return null; });
        }

        let pageChoice = null;
        if (!motion && newContract && classification.intent === 'site' && pagesPromise) {
          pageChoice = await pagesPromise || { status: 'failed', results: [], daily: null };
          pagesPromise = null;
        }
        const answer = await runDiscussion({ upstream, cards, plainMessages, messages, context, langNote, theme,
          adaptive, shortDebate, newContract, guide, pageChoice, pagesPromise, page, motion, music: !motion && newContract && classification.intent === 'music',
          signal: stop.signal, send, log });
        // 次の質問の予測：答え全体を読んでから作るので、答えの後に1回だけ。失敗しても会話は終える
        if (wantSuggest) {
          const text = await withTimeout(DEFAULTS.timeouts.suggest_ms,
            signal => fetchSuggestion(upstream, [...plainMessages, { role: 'assistant', content: answer }], context, langNote, signal, log), stop.signal);
          if (text) send('suggest', { text });
        }
        // 並列生成したタイトルが未送出なら送出を待つ（通常は既に完了）
        if (titlePromise) await titlePromise;
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
          log('error', e.stage, e.code, e.message);
          send('error', e);
        }
        close();
      } finally {
        pageStop.abort();
        stop.signal.removeEventListener('abort', stopPages);
        request.signal.removeEventListener('abort', stopRequest);
      } })());
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Request-Id': requestId, ...cors },
  });
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);
    const requestId = crypto.randomUUID();
    const log = (...a) => console.log(requestId, ...a);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);

    // --- スプラッシュの人格の説明：各人格がいま使っている LLM と、説明文（personas.js の PERSONA_GUIDE）---
    // モデルID・表示名の正本は config/ai-models.json で、週次の監視で更新されうるのでページには直書きしない。
    // 説明文も画面に持たせない（トップページとアプリで食い違わず、アプリのリリースなしで直せる）。
    // パスの名前はモデル名だけを返していた頃のまま（配布済みのアプリが provider / model を読みに来る）。
    // 公開して困る情報ではないので認可は付けない（読めるのは CORS で許した Origin のページだけ）
    if (request.method === 'GET' && url.pathname === '/magi2/models') {
      // 配布済みの画面も model を表示するので、ここで表示名を返す。API 呼び出しは cfg.model のまま。
      // 実際に指定しているモデルIDも model_id として返し、エイリアスとの対応を確認できるようにする。
      const describe = (codename, cfg) => ({ provider: cfg.provider, model: cfg.display_name, model_id: cfg.model, ...PERSONA_GUIDE[codename] });
      const body = {
        personas: Object.fromEntries(Object.entries(DEFAULTS.models.persona).map(([codename, cfg]) => [codename, describe(codename, cfg)])),
        synthesizer: describe(SYNTHESIZER.codename, DEFAULTS.models.synthesizer),
      };
      return jsonResponse(body, cors, 200, { 'Cache-Control': 'public, max-age=600' });
    }

    // 存在する POST の入口だけを、chat / react 共通の条件で認可する。
    const isChat = request.method === 'POST' && url.pathname === '/magi2/chat';
    const isReaction = request.method === 'POST' && url.pathname === '/magi2/react';
    const isSiteSearch = request.method === 'POST' && url.pathname === '/magi2/site-search';
    if (isSiteSearch) cors['Cache-Control'] = 'no-store';
    if (!isChat && !isReaction && !isSiteSearch) {
      return httpError(404, { stage: 'bad_request', code: 'not_found', message: 'Not Found', retryable: false }, requestId, cors);
    }
    if (!isAllowedOrigin(origin) && (!env.CLIENT_API_KEY || request.headers.get('x-api-key') !== env.CLIENT_API_KEY)) {
      if (isSiteSearch) log('auth', 'rejected (site-search)');
      else log('auth', isReaction ? 'rejected (react)' : 'rejected', origin);
      return httpError(401, {
        stage: 'auth', code: 'unauthorized',
        message: isReaction ? '許可されていない Origin です'
          : `許可されていない Origin です（許可: ${ALLOWED_ORIGINS.join(', ')}, localhost）。外部利用は x-api-key が必要です`,
        retryable: false,
      }, requestId, cors);
    }
    const context = { requestId, cors, log };
    // 入力・IPを含まないGeminiの試行数と429だけをUTC日単位で記録。記録失敗で回答を止めない。
    const usageEnv = Object.assign(Object.create(env), { recordGoogleUsage(purpose, state) {
      if (!env.DB) return;
      const task = countUp(env.DB, `usage:google:${purpose}:${state}`, new Date().toISOString().slice(0, 10), Number.MAX_SAFE_INTEGER)
        .catch(() => log('model_usage', 'record_failed', purpose, state));
      ctx.waitUntil(task);
    } });
    if (isSiteSearch) return handleSiteSearch(request, usageEnv, ctx, context);
    return isReaction ? handleReaction(request, env, context) : handleChat(request, usageEnv, ctx, context);
  },
};
