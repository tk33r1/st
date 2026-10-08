// 評価専用入口。本番入口からは読み込まない。ホスト側のAccessとCLIのAPIキーを併用する。
import worker from './index.js';
import { SITE_SEARCH } from '../personas.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.CLIENT_API_KEY || request.headers.get('x-api-key') !== env.CLIENT_API_KEY) {
      return Response.json({ error: { code: 'unauthorized' } }, { status: 401 });
    }
    if (url.pathname !== '/magi2/eval-delay') {
      const calls = [], pending = [];
      const observed = { ...env, evalObserve(provider, model, response, stream) {
        const record = { provider, model, status: response.status, usage: null }; calls.push(record);
        pending.push((async () => {
          try {
            if (!response.ok) { await response.body?.cancel(); return; }
            if (!stream) record.usage = (await response.json()).usage || null;
            else for (const line of (await response.text()).split('\n')) {
              if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
              const data = JSON.parse(line.slice(6)); if (data.usage) record.usage = data.usage;
            }
          } catch {}
        })());
      } };
      const result = await worker.fetch(request, observed, ctx);
      // JSONの検索評価だけを待つ。チャットのSSEを開始前に待たせない。
      if (url.pathname === '/magi2/site-search') {
        await Promise.all(pending);
        const headers = new Headers(result.headers); headers.set('x-magi-eval', btoa(JSON.stringify(calls)));
        return new Response(result.body, { status: result.status, headers });
      }
      ctx.waitUntil(Promise.all(pending)); return result;
    }
    const delay = Number(url.searchParams.get('ms'));
    if (request.method !== 'GET' || [...url.searchParams.keys()].some(k => k !== 'ms')
      || url.searchParams.getAll('ms').length !== 1 || ![149000, 151000].includes(delay)) {
      return Response.json({ error: { code: 'invalid_fixture' } }, { status: 400 });
    }
    const expired = delay > SITE_SEARCH.request_timeout_ms;
    await new Promise((resolve, reject) => {
      const done = () => { request.signal.removeEventListener('abort', stop); resolve(); };
      const timer = setTimeout(done, Math.min(delay, SITE_SEARCH.request_timeout_ms));
      const stop = () => { clearTimeout(timer); request.signal.removeEventListener('abort', stop); reject(new DOMException('Aborted', 'AbortError')); };
      if (request.signal.aborted) stop(); else request.signal.addEventListener('abort', stop, { once: true });
    });
    return Response.json(expired ? { error: { code: 'search_unavailable', retryable: true } }
      : { request_id: crypto.randomUUID(), status: 'no_results', results: [], comment: 'Evaluation fixture.' },
    { status: expired ? 503 : 200, headers: { 'Cache-Control': 'no-store' } });
  },
};
