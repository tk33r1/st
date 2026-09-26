import { DEFAULTS, PERSONAS, PERSONA_CONTEXT, PERSONA_TEMPERATURE, PROVIDERS, SYNTHESIZER, SYNTH_BIAS, TITLER } from '../personas.js';

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
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
  };
}

// --- 統一エラー設計: stage 付きエンベロープ + request_id ---
const STAGES = ['auth', 'bad_request', 'rate_limit', 'persona_call', 'synthesizer_call', 'upstream', 'internal'];
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
function httpError(status, envelope, requestId, cors) {
  return new Response(JSON.stringify({ error: { ...envelope, request_id: requestId } }), {
    status, headers: { 'Content-Type': 'application/json', ...cors },
  });
}

// --- マルチモーダル入力（画像）---
// message.content は文字列のほか、OpenAI 互換のパート配列
// [{type:'text',text}, {type:'image_url',image_url:{url}}] を受け付ける。
// 画像は data: URL のみ許可する（外部 URL を許すと Worker を踏み台にした
// 任意フェッチになるため）。許容 MIME は正規表現側で固定。
const DATA_IMAGE_RE = /^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/;
const b64Bytes = (b64) => Math.floor(b64.length * 3 / 4);

function normaliseImagePart(part, counters) {
  const url = part && part.image_url && typeof part.image_url.url === 'string' ? part.image_url.url.trim() : '';
  const m = DATA_IMAGE_RE.exec(url);
  if (!m) throw stageError('bad_request', 'invalid_image', '画像は data:image/(png|jpeg|webp|gif);base64,… 形式のみ受け付けます', { retryable: false });
  if (b64Bytes(m[1]) > DEFAULTS.vision.max_image_bytes) {
    throw stageError('bad_request', 'image_too_large', `画像は1枚あたり ${Math.round(DEFAULTS.vision.max_image_bytes / 1048576)}MB までです`, { retryable: false });
  }
  if (++counters.total > DEFAULTS.vision.max_images_total) {
    throw stageError('bad_request', 'too_many_images', `画像は1リクエストあたり ${DEFAULTS.vision.max_images_total} 枚までです`, { retryable: false });
  }
  return { type: 'image_url', image_url: { url } };
}

// 1メッセージを検証し {role, content} だけに正規化する。
// クライアントは表示用の付加キー（mid / debate / reactions）を持つ履歴をそのまま
// 送ってくるので、上流へ渡す前にここで落とす。
function normaliseMessage(m, counters) {
  if (!m || (m.role !== 'user' && m.role !== 'assistant')) {
    throw stageError('bad_request', 'invalid_message_shape', '各 message は role:"user"|"assistant" が必要です', { retryable: false });
  }
  if (typeof m.content === 'string') return { role: m.role, content: m.content };
  // 画像を含められるのは user メッセージのみ
  if (m.role !== 'user' || !Array.isArray(m.content) || m.content.length === 0) {
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

// 「120文字以内」の指定を数えて、末尾に「（109文字）」「(98 characters)」と書き足すモデルがある（Gemini）。
// プロンプトでも止めているが、書かれたときはここで落とす
const stripCharCount = (text) => text.replace(/\s*[（(]\s*\d+\s*(?:文字|字|characters?|chars?)\s*[）)]\s*$/i, '').trim();

// 会社ごとの呼び出し方の違いはここに閉じる（値は personas.js の DEFAULTS.models）。
function requestBody(cfg, { messages, stream, temperature }) {
  const sampling = { temperature: temperature != null ? temperature : DEFAULTS.temperature, top_p: DEFAULTS.top_p };
  const base = { model: cfg.model, stream: !!stream, messages };
  switch (cfg.provider) {
    case 'openai':
      // reasoning_effort は省略すると medium になるので、非推論でも必ず送る。
      // temperature / top_p は非推論のときだけ受け付けられる（推論ありで送ると "Unsupported value" で 400）
      return {
        ...base, reasoning_effort: cfg.reasoning_effort, max_completion_tokens: cfg.max_tokens,
        ...(cfg.reasoning_effort === 'none' ? sampling : {}),
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

async function callModel({ env, messages, cfg, stream, signal, temperature }) {
  const provider = PROVIDERS[cfg.provider];
  const body = requestBody(cfg, { messages, stream, temperature });
  const key = env[provider.key];
  if (!key) throw stageError('internal', 'missing_api_key', `${provider.key} が未設定です`, { retryable: false });
  return fetch(provider.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify(body),
    signal,
  });
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
    const text = stripCharCount((choice.message?.content || '').trim());
    log('persona_call', p.codename, cfg.provider, `r${round}`, `finish_reason=${choice.finish_reason}`, `len=${text.length}`, `attempt=${attempt}`);
    if (text) return text;
    // 空応答は1回だけ再試行。安全フィルターで止められた（content_filter）なら同じ結果になるので試さない
    if (attempt < 2 && choice.finish_reason !== 'content_filter') continue;
    throw stageError('persona_call', 'empty_persona_output', `${p.codename} が空の応答を返しました (finish_reason=${choice.finish_reason})`, { persona: p.codename, round, retryable: true });
  }
  // ループは attempt=2 で必ず return/throw に到達するためここには来ない（防御的）
  throw stageError('persona_call', 'unreachable', `${p.codename} の応答取得に失敗しました`, { persona: p.codename, round, retryable: true });
}

// 会話の初回ユーザー発言からチャットタイトルを要約生成（非クリティカル：失敗しても null）。
async function fetchTitle(env, lastContent, signal, log) {
  try {
    const res = await callModel({
      env, cfg: DEFAULTS.models.titler, stream: false, signal,
      // lastContent は文字列か画像込みのパート配列。画像だけの発言でも題を付けられる
      messages: [{ role: 'system', content: TITLER.system_prompt }, { role: 'user', content: lastContent }],
    });
    if (!res.ok) { log('title_call', `HTTP ${res.status}`); return null; }
    const raw = ((await res.json()).choices?.[0]?.message?.content || '').trim();
    // タイトルは1行・記号類を除去し、保険として長さを制限
    const clean = raw.replace(/[\r\n"'`「」『』]/g, '').trim().slice(0, 24);
    log('title_call', `len=${clean.length}`);
    return clean || null;
  } catch (e) {
    log('title_call', 'failed', e && e.message);
    return null;
  }
}

// --- 人格カード：サイト本文から自動生成した JSON を取り、人格の system プロンプトに足す ---
// isolate 内に保持する。取得できないときは直近のカード、それも無ければカード無しで動く
// （＝従来どおり固定プロンプトのみ）。カードが無くても会話は止めない。
//   expiresAt: 次に取り直す時刻。3人格そろえば ttl_ms 後、欠けや失敗なら retry_ms 後
//   refreshing: 期限切れ後の裏での取り直しが進行中か（取り直しを重ねないため）。
//     isolate の起動直後で手元にカードが無い間は、同時に来たリクエストがそれぞれ取得する。
//     取得中の Promise を共有すれば1本にまとまるが、先に来たリクエストが待たずに終わる
//     （429 で返す等）と取得が打ち切られ、共有して待つ側が止まりうるので、あえて共有しない。
//     重なるのは起動直後の数本だけで、小さな JSON を余分に取るにとどまる。
const personaCards = { cards: null, expiresAt: 0, refreshing: false };

async function refreshPersonaCards(log) {
  const t = withTimeout(PERSONA_CONTEXT.fetch_timeout_ms);
  let cards = null;
  try {
    const res = await fetch(PERSONA_CONTEXT.url, { signal: t.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // tk.st は存在しないパスにもトップページを 200 で返すので、JSON として読めるかで判定する
    const data = await res.json();
    cards = {};
    for (const [codename, v] of Object.entries((data && data.personas) || {})) {
      if (v && typeof v.card === 'string' && v.card.trim()) cards[codename] = v.card.trim().slice(0, PERSONA_CONTEXT.max_chars);
    }
    if (!Object.keys(cards).length) throw new Error('no cards in JSON');
    log('persona_context', `cards=${Object.keys(cards).length}`);
  } catch (e) {
    cards = null;
    log('persona_context', 'failed', e && e.message);
  } finally { t.clear(); }
  // 人格ごとに上書きする。失敗・空の JSON・一部の人格が欠けた JSON でも、欠けた人格は
  // 直近のカードを保つ（まるごと置き換えると、欠けた人格だけ固定プロンプトに戻ってしまう）
  const missing = cards ? PERSONAS.map(p => p.codename).filter(c => !cards[c]) : [];
  if (missing.length) log('persona_context', 'missing', missing.join(','));
  const complete = !!cards && !missing.length;
  personaCards.expiresAt = Date.now() + (complete ? PERSONA_CONTEXT.ttl_ms : PERSONA_CONTEXT.retry_ms);
  if (cards) personaCards.cards = { ...personaCards.cards, ...cards };
  return personaCards.cards;
}

// 会話1回ぶんのカードを返す。期限切れでも手元にカードがあれば、それを返して裏で取り直す
// （会話を取得待ちにしない）。isolate の起動直後などで手元に何も無いときだけ取得を待つ。
function getPersonaCards(ctx, log) {
  if (Date.now() < personaCards.expiresAt) return Promise.resolve(personaCards.cards);
  if (!personaCards.cards) return refreshPersonaCards(log);
  if (!personaCards.refreshing) {
    personaCards.refreshing = true;
    ctx.waitUntil(refreshPersonaCards(log).finally(() => { personaCards.refreshing = false; }));
  }
  return Promise.resolve(personaCards.cards);
}

const withCard = (p, cards) => (cards && cards[p.codename])
  ? { ...p, system_prompt: `${p.system_prompt}\n\n${PERSONA_CONTEXT.header}\n${cards[p.codename]}` }
  : p;

// 指定 ms でアボートするタイマ付き signal
function withTimeout(ms) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, ac, clear: () => clearTimeout(id) };
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);
    const requestId = crypto.randomUUID();
    const log = (...a) => console.log(requestId, ...a);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);

    // --- リアクション保存: いいね/絵文字が付いたら request/response を DB に記録 ---
    if (request.method === 'POST' && url.pathname === '/magi2/react') {
      // chat と同じ認可（tk.st/localhost は Origin 許可、それ以外は x-api-key 必須）
      if (!isAllowedOrigin(origin)) {
        if (!env.CLIENT_API_KEY || request.headers.get('x-api-key') !== env.CLIENT_API_KEY) {
          log('auth', 'rejected (react)', origin);
          return httpError(401, { stage: 'auth', code: 'unauthorized', message: '許可されていない Origin です', retryable: false }, requestId, cors);
        }
      }
      let body;
      try { body = await request.json(); }
      catch (_) { return httpError(400, { stage: 'bad_request', code: 'invalid_json', message: 'リクエストボディの JSON が不正です', retryable: false }, requestId, cors); }

      const op = body.op === 'remove' ? 'remove' : 'add';
      const target = typeof body.target === 'string' ? body.target.slice(0, 40) : '';
      if (!env.DB) {
        log('reaction', 'skipped (no DB binding)');
        return httpError(500, { stage: 'internal', code: 'no_db', message: 'DB binding がありません', retryable: false }, requestId, cors);
      }

      // 取り消し：登録時に返した行 ID で該当行のみ削除（target を保険のフィルタに）
      if (op === 'remove') {
        const id = Number(body.id);
        if (!target || !Number.isFinite(id)) {
          return httpError(400, { stage: 'bad_request', code: 'invalid_remove', message: 'target と id（数値）が必要です', retryable: false }, requestId, cors);
        }
        try {
          const res = await env.DB.prepare(`DELETE FROM reactions WHERE id = ?1 AND target = ?2`).bind(id, target).run();
          const deleted = (res.meta && res.meta.changes) || 0;
          log('reaction', 'removed', target, id, `changes=${deleted}`);
          return new Response(JSON.stringify({ ok: true, deleted, request_id: requestId }), { status: 200, headers: { 'Content-Type': 'application/json', ...cors } });
        } catch (err) {
          log('reaction', 'db_error (remove)', err.message);
          return httpError(500, { stage: 'internal', code: 'reaction_db_error', message: 'リアクションの取り消しに失敗しました', detail: String(err.message).slice(0, 200), retryable: true }, requestId, cors);
        }
      }

      // 登録
      const reaction = typeof body.reaction === 'string' ? body.reaction.slice(0, 64) : '';
      const reqText = typeof body.request === 'string' ? body.request.slice(0, 8000) : '';
      const resText = typeof body.response === 'string' ? body.response.slice(0, 16000) : '';
      if (!target || !reaction || !resText) {
        return httpError(400, { stage: 'bad_request', code: 'invalid_reaction', message: 'target, reaction, response は必須です', retryable: false }, requestId, cors);
      }
      try {
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const res = await env.DB.prepare(
          `INSERT INTO reactions (created_at, ip, target, reaction, request, response) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
        ).bind(new Date().toISOString(), ip, target, reaction, reqText, resText).run();
        const id = res.meta && res.meta.last_row_id;
        log('reaction', target, reaction, `id=${id}`);
        return new Response(JSON.stringify({ ok: true, id, request_id: requestId }), { status: 200, headers: { 'Content-Type': 'application/json', ...cors } });
      } catch (err) {
        log('reaction', 'db_error', err.message);
        return httpError(500, { stage: 'internal', code: 'reaction_db_error', message: 'リアクションの保存に失敗しました', detail: String(err.message).slice(0, 200), retryable: true }, requestId, cors);
      }
    }

    if (!(request.method === 'POST' && url.pathname === '/magi2/chat')) {
      return httpError(404, { stage: 'bad_request', code: 'not_found', message: 'Not Found', retryable: false }, requestId, cors);
    }

    // 1) auth: tk.st/localhost は Origin で許可、それ以外は x-api-key 必須
    if (!isAllowedOrigin(origin)) {
      if (!env.CLIENT_API_KEY || request.headers.get('x-api-key') !== env.CLIENT_API_KEY) {
        log('auth', 'rejected', origin);
        return httpError(401, {
          stage: 'auth', code: 'unauthorized',
          message: `許可されていない Origin です（許可: ${ALLOWED_ORIGINS.join(', ')}, localhost）。外部利用は x-api-key が必要です`,
          retryable: false,
        }, requestId, cors);
      }
    }

    // 2) bad_request: body 検証
    let messages;
    let theme = null; // 'light' | 'dark'：統合の揺らぎに使用
    try {
      const body = await request.json();
      messages = body && body.messages;
      theme = (body && (body.theme === 'light' || body.theme === 'dark')) ? body.theme : null;
      if (!Array.isArray(messages) || messages.length === 0) {
        throw stageError('bad_request', 'invalid_messages', 'messages は1件以上の配列が必要です', { retryable: false });
      }
      // 検証の前に trim する（画像枚数の上限は実際に上流へ送るぶんに対して数える）
      if (messages.length > DEFAULTS.history_max_messages) messages = messages.slice(-DEFAULTS.history_max_messages);
      // content は文字列 or パート配列。ここで {role, content} だけに正規化される
      const counters = { total: 0 };
      messages = messages.map(m => normaliseMessage(m, counters));
      if (messages[messages.length - 1].role !== 'user') {
        throw stageError('bad_request', 'last_not_user', '最後の message は role:"user" である必要があります', { retryable: false });
      }
    } catch (err) {
      if (err.envelope) return httpError(400, err.envelope, requestId, cors);
      return httpError(400, { stage: 'bad_request', code: 'invalid_json', message: 'リクエストボディの JSON が不正です', retryable: false }, requestId, cors);
    }

    // 人格カードの取得は、レート制限の DB 処理と並行して始めておく（失敗しても reject しない）
    const cardsPromise = getPersonaCards(ctx, log);

    // 3) rate_limit: IP×UTC日次（DB 未設定の dev では skip）
    if (env.DB) {
      try {
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const day = new Date().toISOString().slice(0, 10);
        const row = await env.DB.prepare(
          `INSERT INTO rate_limit (ip, day, count) VALUES (?1, ?2, 1)
           ON CONFLICT(ip, day) DO UPDATE SET count = count + 1
           RETURNING count`
        ).bind(ip, day).first();
        const count = row && row.count || 1;
        log('rate_limit', ip, day, count);
        if (count > DEFAULTS.daily_limit) {
          return httpError(429, {
            stage: 'rate_limit', code: 'daily_limit_exceeded',
            message: `本日の利用上限（${DEFAULTS.daily_limit}回/日）に達しました`,
            retry_after_day: day, legacy_url: 'https://tk.st/magi/', retryable: false,
          }, requestId, cors);
        }
      } catch (err) {
        log('rate_limit', 'db_error', err.message);
        return httpError(500, { stage: 'internal', code: 'ratelimit_db_error', message: 'レート制限の記録に失敗しました', detail: String(err.message).slice(0, 200), retryable: true }, requestId, cors);
      }
    } else {
      log('rate_limit', 'skipped (no DB binding)');
    }

    // 4-5) SSE: 3人格（並列・欠けた人格は抜かして続ける。全員失敗でエラー）→ 統合（stream）
    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        let closed = false;
        const send = (event, data) => { if (closed) return; try { controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch (_) {} };
        const close = () => { if (!closed) { closed = true; try { controller.close(); } catch (_) {} } };

        try {
          const history = messages.slice(0, -1);
          const lastContent = messages[messages.length - 1].content;
          // 討議メモ・統合プロンプトに埋め込むのは本文テキストのみ。画像はパートとして
          // R2 / 統合にも同じものを添え直す（人格が途中で画像を見失わないように）。
          const lastUser = contentText(lastContent);
          const lastImages = contentImages(lastContent);
          if (lastImages.length) log('vision', `images=${lastImages.length}`);
          // 画像付きは上流の処理が重くなるぶん、人格側のタイムアウトを広げる
          const personaTimeoutMs = lastImages.length ? DEFAULTS.timeouts.persona_vision_ms : DEFAULTS.timeouts.persona_ms;

          // --- タイトル要約：会話の初回ユーザー発言時のみ、本流と並列で生成 ---
          let titlePromise = null;
          if (!history.some(m => m.role === 'assistant')) {
            const tt = withTimeout(personaTimeoutMs);
            titlePromise = fetchTitle(env, lastContent, tt.signal, log)
              .then(t => { tt.clear(); if (t) send('title', { text: t }); })
              .catch(() => { tt.clear(); });
          }

          // 揺らぎ：3人格の temperature を UI テーマで変える（light=1.0 / dark=1.3、未指定は既定）
          const personaTemp = theme ? PERSONA_TEMPERATURE[theme] : undefined;
          if (personaTemp != null) log('persona_call', 'temperature', theme, personaTemp);

          // 人格カード（サイト本文由来の「いまの中身」）を骨格プロンプトに足す。R2 は opinions 経由で同じものを使う
          const cards = await cardsPromise;
          const personas = PERSONAS.map(p => withCard(p, cards));

          // 人格ごとに呼び出し先の会社が違うので、1人格の失敗（相手側の障害・安全フィルター・時間切れ）では
          // 止めず、その人格を抜かして進める。画面のカードを「考え中」のまま残さないよう、欠けた回には印を送る。
          const absent = (p, round, reason) => {
            log('persona_call', p.codename, `r${round}`, 'dropped', reason && ((reason.envelope && reason.envelope.code) || reason.name || reason.message));
            send('persona', { round, codename: p.codename, name: p.name, text: PERSONA_ABSENT, absent: true });
          };

          // --- R1: 3人格が並列に初回意見（互いの意見は見ない）---
          log('persona_call', 'round1 start');
          const t1 = withTimeout(personaTimeoutMs);
          let r1;
          try {
            r1 = await Promise.allSettled(personas.map(async (p) => {
              const text = await fetchPersonaText(env, p, messages, t1.signal, log, 1, personaTemp);
              send('persona', { round: 1, codename: p.codename, name: p.name, text });
              return { ...p, r1: text };
            }));
          } finally { t1.clear(); }
          const opinions = [];
          r1.forEach((r, i) => {
            if (r.status === 'fulfilled') { opinions.push(r.value); return; }
            absent(personas[i], 1, r.reason);
            absent(personas[i], 2);
          });
          // 全員が失敗したときだけエラーにする（時間切れなら外側の catch が upstream timeout にする）
          if (!opinions.length) throw r1[0].reason;
          log('persona_call', 'round1 ok', `personas=${opinions.length}`);

          // --- R2: 各人格が他の人格のR1意見を踏まえて討議・更新 ---
          // 失敗した人格は初回意見のまま統合に回す。相手がいない（1人しか残っていない）ときは討議しない
          log('persona_call', 'round2 start');
          const t2 = withTimeout(personaTimeoutMs);
          try {
            await Promise.all(opinions.map(async (p) => {
              const others = opinions.filter(o => o.codename !== p.codename)
                .map(o => `- ${o.name}（${o.codename}）: ${o.r1}`).join('\n');
              if (!others) { absent(p, 2); return; }
              // 寄り添い寄りのモデルは他の意見に流されやすいので、賛同するにも自分の理由を求める
              const dmsg = `${lastUser}\n\n[あなたの初回意見]\n${p.r1}\n\n[討議メモ：他の人格の初回意見は以下。これを踏まえ、賛同・反論・補強のいずれかで自分の考えを更新せよ。賛同するなら自分の理由で述べ、自分の関心と価値観は手放さない。単なる繰り返しは避ける]\n${others}`;
              try {
                p.r2 = await fetchPersonaText(env, p, [...history, { role: 'user', content: withImages(dmsg, lastImages) }], t2.signal, log, 2, personaTemp);
                send('persona', { round: 2, codename: p.codename, name: p.name, text: p.r2 });
              } catch (e) { absent(p, 2, e); }
            }));
          } finally { t2.clear(); }
          log('persona_call', 'round2 ok', `personas=${opinions.filter(o => o.r2).length}`);

          // --- 統合コール（推論あり・stream）---
          const memo = opinions.map(o => `- ${o.name}（${o.codename}）\n  初回: ${o.r1}${o.r2 ? `\n  討議後: ${o.r2}` : ''}`).join('\n');
          const augmented = `${lastUser}\n\n[内部討議メモ：以下は各人格の初回意見と討議後の見解。これらを統合し、私(Shinya Takeda)として一人称で答える。人格名は出さない]\n${memo}`;
          // 揺らぎ：UI テーマに応じて優先人格を少し強める（light=Strategist / dark=Enthusiast）
          const bias = theme ? SYNTH_BIAS[theme] : null;
          if (bias) log('synthesizer_call', 'bias', theme);
          const synthMessages = [
            { role: 'system', content: SYNTHESIZER.system_prompt },
            ...(bias ? [{ role: 'system', content: bias }] : []),
            ...history,
            { role: 'user', content: withImages(augmented, lastImages) },
          ];

          const synthTimer = withTimeout(DEFAULTS.timeouts.synthesizer_ms);
          let synthRes;
          try {
            log('synthesizer_call', 'start');
            // 成功時は reader 完了後に clear。throw 時はここで確実に解除しておく
            synthRes = await callModel({ env, cfg: DEFAULTS.models.synthesizer, stream: true, signal: synthTimer.signal, messages: synthMessages });
          } catch (e) { synthTimer.clear(); throw e; }
          if (!synthRes.ok) {
            const detail = (await synthRes.text().catch(() => '')).slice(0, 200);
            synthTimer.clear();
            throw stageError('synthesizer_call', `gpt_http_${synthRes.status}`, `統合人格の呼び出しが失敗しました (HTTP ${synthRes.status})`, { detail, retryable: synthRes.status >= 500 });
          }

          // OpenAI の SSE をパースし、delta.content のみ中継（reasoning は出さない）
          const reader = synthRes.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line.startsWith('data:')) continue;
              const payload = line.slice(5).trim();
              if (payload === '[DONE]') continue;
              try {
                const j = JSON.parse(payload);
                const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
                if (delta) send('integrated', { delta });
              } catch (_) { /* 部分行は次ループで再構成 */ }
            }
          }
          synthTimer.clear();
          log('synthesizer_call', 'ok');
          // 並列生成したタイトルが未送出なら送出を待つ（通常は既に完了）
          if (titlePromise) { try { await titlePromise; } catch (_) {} }
          send('done', { request_id: requestId });
          close();
        } catch (err) {
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
        }
      },
    });

    return new Response(stream, {
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Request-Id': requestId, ...cors },
    });
  },
};
