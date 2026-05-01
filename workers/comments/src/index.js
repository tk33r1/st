const ALLOWED_ORIGINS = ['https://tk.st', 'https://www.tk.st'];

function getCorsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = getCorsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // DELETE — コメント削除  /glitch/api/comments/:articleId/:commentId
    const delMatch = url.pathname.match(/^\/glitch\/api\/comments\/(\d+)\/(\d+)$/);
    if (delMatch && request.method === 'DELETE') {
      try {
        await env.DB.prepare(
          'DELETE FROM comments WHERE id = ? AND article_id = ?'
        ).bind(Number(delMatch[2]), delMatch[1]).run();

        const { results } = await env.DB.prepare(
          'SELECT id, handle, text, created_at FROM comments WHERE article_id = ? ORDER BY created_at ASC'
        ).bind(delMatch[1]).all();
        return json(results, 200, cors);
      } catch (e) {
        return json({ error: e.message }, 500, cors);
      }
    }

    // GET / POST — /glitch/api/comments/:articleId
    const match = url.pathname.match(/^\/glitch\/api\/comments\/(\d+)$/);
    if (!match) {
      return new Response('Not Found', { status: 404, headers: cors });
    }

    const articleId = match[1];

    if (request.method === 'GET') {
      try {
        const { results } = await env.DB.prepare(
          'SELECT id, handle, text, created_at FROM comments WHERE article_id = ? ORDER BY created_at ASC'
        ).bind(articleId).all();
        return json(results, 200, cors);
      } catch (e) {
        return json({ error: e.message }, 500, cors);
      }
    }

    if (request.method === 'POST') {
      try {
        const { handle, text } = await request.json();
        if (!handle || !text) {
          return new Response('Bad Request', { status: 400, headers: cors });
        }
        const safeHandle = escHtml(String(handle).substring(0, 40));
        const safeText = escHtml(String(text).substring(0, 2000));

        await env.DB.prepare(
          'INSERT INTO comments (article_id, handle, text) VALUES (?, ?, ?)'
        ).bind(articleId, safeHandle, safeText).run();

        const { results } = await env.DB.prepare(
          'SELECT id, handle, text, created_at FROM comments WHERE article_id = ? ORDER BY created_at ASC'
        ).bind(articleId).all();
        return json(results, 200, cors);
      } catch (e) {
        return json({ error: e.message }, 500, cors);
      }
    }

    return new Response('Method Not Allowed', { status: 405, headers: cors });
  },
};
