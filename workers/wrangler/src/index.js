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
const GPT_MODEL = 'gpt-5.6-luna';
const MAX_HISTORY = 20;      // 会話履歴は際限なく伸びるので直近だけ通す
const MAX_CHARS = 4000;      // 1メッセージあたり

async function callGPT(env, { system, messages, maxTokens }) {
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

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.GAME_OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: GPT_MODEL,
      messages: msgs,
      // ゲームの一言コメント／短い応答が用途。推論させる意味がないので速さと安さを取る。
      // gpt-5.6 の既定は medium なので、省略すると黙って推論トークンを課金される
      reasoning_effort: 'none',
      max_completion_tokens: Math.min(Number(maxTokens) || 200, 800),
      stream: false,
    }),
  });

  const data = await res.json();
  if (!res.ok) return { ok: false, status: res.status, error: 'upstream', detail: data };

  return { ok: true, status: 200, text: data?.choices?.[0]?.message?.content?.trim() ?? '' };
}

export default {
  async fetch(request, env) {
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
        const { prompt, system, messages, maxTokens } = await request.json();
        const msgs = Array.isArray(messages) ? [...messages] : [];
        if (typeof prompt === 'string' && prompt) msgs.push({ role: 'user', content: prompt });

        const r = await callGPT(env, { system, messages: msgs, maxTokens });
        if (!r.ok) return json({ error: r.error, detail: r.detail }, r.status, cors);
        return json({ text: r.text }, 200, cors);
      } catch (e) {
        return json({ error: e.message }, 500, cors);
      }
    }

    // POST /api/gemini  ─── 旧クライアント互換シム
    //
    // 中身は GPT。Gemini 形式で受けて Gemini 形式で返すだけの変換層で、
    // ブラウザにキャッシュされた古いゲームHTMLを壊さないために残してある。
    // 全ゲームのHTMLが行き渡ったと判断できたら、このブロックごと削除してよい。
    if (url.pathname === '/api/gemini' && request.method === 'POST') {
      try {
        const body = await request.json();
        const pick = (parts) => (parts || []).map(p => p?.text).filter(Boolean).join('\n');

        const messages = (body?.contents || []).map(c => ({
          role: c?.role === 'model' ? 'assistant' : 'user',
          content: pick(c?.parts),
        }));
        const system = pick(body?.systemInstruction?.parts);

        const r = await callGPT(env, { system, messages, maxTokens: 800 });
        if (!r.ok) return json({ error: { message: r.error } }, r.status, cors);

        // 旧クライアントがそのまま読めるよう Gemini のレスポンス形に詰め直す
        return json({
          candidates: [{ content: { role: 'model', parts: [{ text: r.text }] } }],
        }, 200, cors);
      } catch (e) {
        return json({ error: { message: e.message } }, 500, cors);
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
