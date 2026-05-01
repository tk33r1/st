const ALLOWED_ORIGINS = ['https://tk.st', 'https://www.tk.st'];

function getCorsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = getCorsHeaders(origin);
    const fromAllowedOrigin = ALLOWED_ORIGINS.includes(origin);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // 認証: tk.st のブラウザ → Origin で許可、それ以外 → APIキー必須
    if (!fromAllowedOrigin) {
      const clientKey = request.headers.get('x-api-key');
      if (clientKey !== env.CLIENT_API_KEY) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // POST /magi → 質問を投げて job_id をすぐ返す
    if (request.method === 'POST' && path === '/magi') {
      try {
        const { question, session_id, mode, image } = await request.json();

        const endpoint = image ? 'https://magi.tk.st/ask_with_image' : 'https://magi.tk.st/ask';
        const body = { question, session_id: session_id || 'default', mode: mode || 'magi' };
        if (image) body.image = image.replace(/^data:image\/\w+;base64,/, '');

        const askRes = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.MAGI_API_KEY,
          },
          body: JSON.stringify(body),
        });

        if (!askRes.ok) {
          const errText = await askRes.text();
          throw new Error(`Backend API Error (${askRes.status}): ${errText.substring(0, 200)}`);
        }

        const data = await askRes.json();
        return new Response(JSON.stringify({ job_id: data.job_id }), {
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
    }

    // GET /magi/{job_id} → 結果を返す
    const match = path.match(/^\/magi\/(.+)$/);
    if (request.method === 'GET' && match) {
      const job_id = match[1];
      try {
        const resultRes = await fetch(`https://magi.tk.st/result/${job_id}`, {
          headers: { 'x-api-key': env.MAGI_API_KEY },
        });

        if (!resultRes.ok) {
          const errText = await resultRes.text();
          throw new Error(`Backend API Error (${resultRes.status}): ${errText.substring(0, 200)}`);
        }

        const data = await resultRes.json();
        return new Response(JSON.stringify(data), {
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
    }

    return new Response(JSON.stringify({ error: 'Not Found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  },
}
