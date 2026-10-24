// モデルIDの正本。wrangler がデプロイ時にバンドルへ取り込む。
import aiModels from '../../../config/ai-models.json';
import {callGameAnthropic} from '../anthropic.js';

const ALLOWED_ORIGINS = ['https://tk.st', 'https://www.tk.st', 'http://127.0.0.1:5500'];

function getCorsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

// ───────────────────────────────────────────────────────────────
// GPT 呼び出し（全ゲーム共通の実体）
//
// モデル・max_completion_tokens・reasoning_effort はここで固定する。Origin ヘッダは
// ブラウザ外から偽装できるので、料金に響くパラメータをクライアントに開けない。
// ───────────────────────────────────────────────────────────────
const GPT_MODEL = aiModels.openai.luna.id;
const MAX_HISTORY = 20;      // 会話履歴は際限なく伸びるので直近だけ通す
const MAX_CHARS = 4000;      // 1メッセージあたり

// 3つの旧・現行AI入口で共有する。Originは本人確認ではないため、費用の上限はD1で守る。
const MAX_AI_BODY_BYTES = 256 * 1024;
const AI_LIMIT_DEFAULTS = { GAME_AI_MINUTE_LIMIT: 30, GAME_AI_DAILY_LIMIT: 500, GAME_AI_GLOBAL_DAILY_LIMIT: 2000 };
function aiLimit(env, name) {
  const value = env[name] === undefined ? AI_LIMIT_DEFAULTS[name] : Number(env[name]);
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000000) throw new Error('invalid limit');
  return value;
}
function bodyError(status, message) { return Object.assign(new Error(message), { status }); }
async function readAiBody(request) {
  if ((request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw bodyError(415, 'application/json required');
  }
  if (Number(request.headers.get('Content-Length')) > MAX_AI_BODY_BYTES) throw bodyError(413, 'request too large');
  const reader = request.body?.getReader();
  if (!reader) throw bodyError(400, 'invalid JSON');
  const chunks = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_AI_BODY_BYTES) { await reader.cancel(); throw bodyError(413, 'request too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try {
    const bytes = new Uint8Array(length); let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw bodyError(400, 'invalid JSON'); }
}
async function reserveGameAi(request, env, ctx) {
  if (env.GAME_AI_ENABLED === 'false') return { ok: false, status: 503, error: 'AI temporarily unavailable' };
  const unavailable = { ok: false, status: 503, error: 'AI limit unavailable', retryAfter: 60 };
  if (!env.DB) return unavailable;
  try {
    const limits = Object.fromEntries(Object.keys(AI_LIMIT_DEFAULTS).map(name => [name, aiLimit(env, name)]));
    const now = Date.now(), minute = Math.floor(now / 60000), day = new Date(now).toISOString().slice(0, 10);
    const tomorrow = Date.parse(day + 'T00:00:00Z') + 86400000;
    const dayWait = Math.max(1, Math.ceil((tomorrow - now) / 1000));
    const rejected = seconds => ({ ok: false, status: 429, error: 'AI request limit reached', retryAfter: seconds });
    // 全体が満杯なら、新しいIPの行も作らない。最終的な上限は下の原子的UPSERTで守る。
    const global = await env.DB.prepare('SELECT count FROM game_ai_usage WHERE bucket = ? AND period = ?').bind('global', day).first();
    if (global && global.count >= limits.GAME_AI_GLOBAL_DAILY_LIMIT) return rejected(dayWait);
    // CF-Connecting-IPはCloudflareが付ける値。転送元ヘッダーや本文のIPは使わない。
    // IPを直接保存せず、日ごとに変わるhashを使う。取得できなければ全員で同じ枠を共有する。
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(day + ':' + ip));
    const key = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    const reserve = (bucket, period, limit, expires) => env.DB.prepare(
      `INSERT INTO game_ai_usage (bucket, period, count, expires_at) VALUES (?1, ?2, 1, ?4)
       ON CONFLICT(bucket, period) DO UPDATE SET count = count + 1 WHERE count < ?3 RETURNING count`
    ).bind(bucket, period, limit, expires).first();
    if (!await reserve('minute:' + key, String(minute), limits.GAME_AI_MINUTE_LIMIT, (minute + 1) * 60)) {
      return rejected(Math.max(1, Math.ceil(((minute + 1) * 60000 - now) / 1000)));
    }
    if (!await reserve('ip:' + key, day, limits.GAME_AI_DAILY_LIMIT, tomorrow / 1000)) return rejected(dayWait);
    const total = await reserve('global', day, limits.GAME_AI_GLOBAL_DAILY_LIMIT, tomorrow / 1000);
    if (!total) return rejected(dayWait);
    // 一度予約した枠は上流失敗でも戻さない（タイムアウト後に課金される場合もある）。
    if (total.count === 1) {
      const cleanup = env.DB.prepare('DELETE FROM game_ai_usage WHERE expires_at < ?').bind(Math.floor(now / 1000)).run()
        .catch(() => console.warn('game AI limit cleanup failed'));
      if (ctx?.waitUntil) ctx.waitUntil(cleanup); else await cleanup;
    }
    return null;
  } catch {
    console.warn('game AI limit unavailable');
    return unavailable;
  }
}

async function callGPT(request, env, { system, messages, maxTokens }, ctx) {
  const msgs = [];
  if (system) msgs.push({ role: 'system', content: String(system).slice(0, MAX_CHARS) });

  for (const m of (Array.isArray(messages) ? messages : []).slice(-MAX_HISTORY)) {
    // Gemini 系の 'model' も OpenAI の 'assistant' として受け付ける
    const role = (m?.role === 'assistant' || m?.role === 'model') ? 'assistant' : 'user';
    const content = String(m?.content ?? '').slice(0, MAX_CHARS);
    if (content) msgs.push({ role, content });
  }

  if (!msgs.some(m => m.role !== 'system')) {
    return { ok: false, status: 400, error: 'no message content' };
  }

  const denied = await reserveGameAi(request, env, ctx);
  if (denied) return denied;
  maxTokens = Number(maxTokens);
  maxTokens = Number.isFinite(maxTokens) ? Math.max(1, Math.min(Math.floor(maxTokens) || 200, 800)) : 200;

  // 比較とゲーム画面の確認を終えてから、サーバー設定だけで移行する。クライアントからは選べない。
  if (env.GAME_AI_PROVIDER === 'anthropic') return callGameAnthropic(env, {
    system:msgs.find(m=>m.role==='system')?.content,
    messages:msgs.filter(m=>m.role!=='system'),maxTokens,
  });

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    signal: AbortSignal.timeout(30000),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.GAME_OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: GPT_MODEL,
      messages: msgs,
      // ゲームの一言コメント／短い応答が用途。推論させる意味がないので速さと安さを取る。
      // Luna の既定は medium なので、省略すると黙って推論トークンを課金される
      reasoning_effort: 'none',
      max_completion_tokens: maxTokens,
      stream: false,
    }),
  });

  const data = await res.json();
  if (!res.ok) return { ok: false, status: res.status, error: 'upstream', detail: data };

  return { ok: true, status: 200, text: data?.choices?.[0]?.message?.content?.trim() ?? '' };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = getCorsHeaders(origin);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // Origin check
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return new Response('Forbidden', { status: 403 });
    }

    // POST /api/gpt  ─── 全ゲーム共通のAIエンドポイント
    // 受ける形は2通り:
    //   { prompt, system }                       … 1発の問い合わせ
    //   { messages: [{role, content}], system }   … 会話履歴つき（ascii-roguelike）
    //
    // /api/deepseek は旧パスの別名。中身は GPT で、ブラウザにキャッシュされた
    // 古いゲームHTMLを壊さないために残してある（/api/gemini と同じ扱い）。
    if ((url.pathname === '/api/gpt' || url.pathname === '/api/deepseek') && request.method === 'POST') {
      try {
        const { prompt, system, messages, maxTokens } = await readAiBody(request);
        const msgs = Array.isArray(messages) ? [...messages] : [];
        if (typeof prompt === 'string' && prompt) msgs.push({ role: 'user', content: prompt });

        const r = await callGPT(request, env, { system, messages: msgs, maxTokens }, ctx);
        if (!r.ok) return json({ error: r.error, detail: r.detail }, r.status, { ...cors, 'Cache-Control': 'no-store', ...(r.retryAfter ? { 'Retry-After': String(r.retryAfter) } : {}) });
        return json({ text: r.text }, 200, { ...cors, 'Cache-Control': 'no-store' });
      } catch (e) {
        return json({ error: e.status ? e.message : 'AI unavailable' }, e.status || 502, { ...cors, 'Cache-Control': 'no-store' });
      }
    }

    // POST /api/gemini  ─── 旧クライアント互換シム
    //
    // 中身は GPT。Gemini 形式で受けて Gemini 形式で返すだけの変換層で、
    // ブラウザにキャッシュされた古いゲームHTMLを壊さないために残してある。
    // 全ゲームのHTMLが行き渡ったと判断できたら、このブロックごと削除してよい。
    if (url.pathname === '/api/gemini' && request.method === 'POST') {
      try {
        const body = await readAiBody(request);
        if (body.contents != null && !Array.isArray(body.contents)) throw bodyError(400, 'invalid contents');
        const pick = (parts) => (Array.isArray(parts) ? parts : []).map(p => p?.text).filter(t => typeof t === 'string').join('\n');

        const messages = (body?.contents || []).map(c => ({
          role: c?.role === 'model' ? 'assistant' : 'user',
          content: pick(c?.parts),
        }));
        const system = pick(body?.systemInstruction?.parts);

        const r = await callGPT(request, env, { system, messages, maxTokens: 800 }, ctx);
        if (!r.ok) return json({ error: { message: r.error } }, r.status, { ...cors, 'Cache-Control': 'no-store', ...(r.retryAfter ? { 'Retry-After': String(r.retryAfter) } : {}) });

        // 旧クライアントがそのまま読めるよう Gemini のレスポンス形に詰め直す
        return json({
          candidates: [{ content: { role: 'model', parts: [{ text: r.text }] } }],
        }, 200, { ...cors, 'Cache-Control': 'no-store' });
      } catch (e) {
        return json({ error: { message: e.status ? e.message : 'AI unavailable' } }, e.status || 502, { ...cors, 'Cache-Control': 'no-store' });
      }
    }

    // GET /api/:game/scores  ─── ゲーム別ランキング取得
    const scoresMatch = url.pathname.match(/^\/api\/([^/]+)\/scores$/);
    if (scoresMatch) {
      const gameId = scoresMatch[1];

      if (request.method === 'GET') {
        try {
          const order = url.searchParams.get('order') === 'asc' ? 'ASC' : 'DESC';
          const { results } = await env.DB.prepare(
            `SELECT player_name, score, stage, created_at FROM scores WHERE game_id = ? ORDER BY score ${order} LIMIT 10`
          ).bind(gameId).all();
          return json(results, 200, cors);
        } catch (e) {
          return json({ error: e.message }, 500, cors);
        }
      }

      if (request.method === 'POST') {
        try {
          const { playerName, score, stage } = await request.json();
          if (!playerName || score == null || stage == null) {
            return new Response('Bad Request', { status: 400, headers: cors });
          }
          await env.DB.prepare(
            'INSERT INTO scores (game_id, player_name, score, stage) VALUES (?, ?, ?, ?)'
          ).bind(gameId, String(playerName).substring(0, 10), Number(score), Number(stage)).run();
          return json({ ok: true }, 200, cors);
        } catch (e) {
          return json({ error: e.message }, 500, cors);
        }
      }
    }

    return new Response('Not Found', { status: 404, headers: cors });
  },
};
