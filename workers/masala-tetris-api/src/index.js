const ALLOWED_ORIGINS = ['https://tk.st', 'https://www.tk.st'];

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

    // POST /api/gemini  ─── Gemini API プロキシ
    if (url.pathname === '/api/gemini' && request.method === 'POST') {
      try {
        const body = await request.json();
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${env.GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }
        );
        const data = await res.json();
        return json(data, res.status, cors);
      } catch (e) {
        return json({ error: e.message }, 500, cors);
      }
    }

    // GET /api/scores  ─── ランキング上位10件取得
    if (url.pathname === '/api/scores' && request.method === 'GET') {
      try {
        const { results } = await env.DB.prepare(
          'SELECT player_name, score, stage, created_at FROM scores ORDER BY score DESC LIMIT 10'
        ).all();
        return json(results, 200, cors);
      } catch (e) {
        return json({ error: e.message }, 500, cors);
      }
    }

    // POST /api/scores  ─── スコア保存
    if (url.pathname === '/api/scores' && request.method === 'POST') {
      try {
        const { playerName, score, stage } = await request.json();
        if (!playerName || score == null || stage == null) {
          return new Response('Bad Request', { status: 400, headers: cors });
        }
        await env.DB.prepare(
          'INSERT INTO scores (player_name, score, stage) VALUES (?, ?, ?)'
        ).bind(String(playerName).substring(0, 10), Number(score), Number(stage)).run();
        return json({ ok: true }, 200, cors);
      } catch (e) {
        return json({ error: e.message }, 500, cors);
      }
    }

    return new Response('Not Found', { status: 404, headers: cors });
  },
};
