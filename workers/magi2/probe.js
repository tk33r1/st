// 読み上げ設計§6.5 の一時の測定。会社の PC で SSE と WebSocket の届き方を比べる。
// AI・D1・secret を使わない。PROBE_ENABLED が "true" のときだけ動き、測定が済んだらこのファイルと入口を外す。
import { STREAM } from './personas.js';

const PROBE = { interval_ms: 2000, duration_ms: 60000, max_streams: 6 };
const PROBE_ORIGIN = 'https://workers.tk.st';
let probeStreams = 0;  // isolate ごとの同時数。費用は掛からないので、絞りは乱用の目安で足りる

const PROBE_PAGE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>MAGI 通信の測定</title>
<style>
body{font:14px/1.6 system-ui,sans-serif;margin:16px;max-width:720px;background:#fff;color:#111}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}}
button{font:inherit;padding:10px 20px;margin:8px 0}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
pre{white-space:pre-wrap;font:12px/1.5 ui-monospace,monospace;margin:0}
h2{font-size:15px;margin:12px 0 4px}
</style></head><body>
<h1 style="font-size:18px">MAGI 通信の測定（SSE と WebSocket）</h1>
<p>AI は呼びません。［開始］を押すと、SSE と WebSocket で2秒ごとに番号を60秒受け取ります。終わったら画面全体を写して送ってください。結果はどこにも送信しません。</p>
<button id="start">開始</button>
<div id="env"></div>
<div class="grid"><div><h2>SSE</h2><pre id="sse"></pre></div><div><h2>WebSocket</h2><pre id="ws"></pre></div></div>
<h2>判定</h2><pre id="verdict"></pre>
<script>
const $ = id => document.getElementById(id);
$('env').textContent = new Date().toISOString() + ' / ' + navigator.userAgent;
function tracker(out) {
  const rows = []; let opened = null, done = false, error = '';
  const start = performance.now();
  return {
    open() { opened = Math.round(performance.now() - start); out.textContent += 'open ' + opened + 'ms\\n'; },
    item(msg) {
      const at = performance.now() - start;
      rows.push({ n: msg.n, at, t: msg.t });
      out.textContent += '#' + msg.n + ' +' + (at / 1000).toFixed(1) + 's\\n';
    },
    end(ok, why) { done = ok; error = why || ''; out.textContent += (ok ? 'done' : 'failed ' + error) + '\\n'; },
    summary() {
      let gap = 0, lag = 0;
      rows.forEach((r, i) => {
        if (i) gap = Math.max(gap, r.at - rows[i - 1].at);
        lag = Math.max(lag, (r.at - rows[0].at) - (r.t - rows[0].t));
      });
      return { opened: opened !== null, count: rows.length, first_s: rows.length ? rows[0].at / 1000 : null,
        max_gap_s: gap / 1000, max_lag_s: lag / 1000, done, error };
    },
  };
}
function runSSE() {
  const t = tracker($('sse'));
  return new Promise(resolve => {
    const es = new EventSource('/magi2/probe/sse');
    es.onopen = () => t.open();
    es.addEventListener('tick', e => t.item(JSON.parse(e.data)));
    es.addEventListener('done', () => { es.close(); t.end(true); resolve(t.summary()); });
    es.onerror = () => { es.close(); t.end(false, 'error'); resolve(t.summary()); };
  });
}
function runWS() {
  const t = tracker($('ws'));
  return new Promise(resolve => {
    let ws;
    try { ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/magi2/probe/ws'); }
    catch (e) { t.end(false, 'construct'); return resolve(t.summary()); }
    let finished = false;
    const finish = (ok, why) => { if (finished) return; finished = true; t.end(ok, why); resolve(t.summary()); };
    ws.onopen = () => t.open();
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.event === 'tick') t.item(m); else if (m.event === 'done') finish(true); };
    ws.onerror = () => finish(false, 'error');
    ws.onclose = e => finish(false, 'close ' + e.code);
  });
}
$('start').onclick = async () => {
  $('start').disabled = true; $('sse').textContent = ''; $('ws').textContent = ''; $('verdict').textContent = '測定中…';
  const [sse, ws] = await Promise.all([runSSE(), runWS()]);
  // 設計§6.5: SSE が20秒以上まとめて届き、WebSocket が開けて間隔が5秒以内なら、WebSocket に効果がある
  const sseBatched = sse.max_lag_s >= 20 || (sse.first_s !== null && sse.first_s >= 20);
  const wsSteady = ws.opened && ws.done && ws.max_gap_s <= 5;
  $('verdict').textContent = JSON.stringify({ sse, ws }, null, 1) + '\\n\\n'
    + (sseBatched && wsSteady ? '→ WebSocket に効果あり' : !ws.opened || !ws.done ? '→ WebSocket は使えない'
      : !sseBatched ? '→ SSE は少しずつ届いている（WebSocket は不要）' : '→ どちらも溜まる');
  $('start').disabled = false;
};
</script></body></html>`;

function probeTicks(send, finish) {
  const started = Date.now();
  let n = 0;
  const timer = setInterval(() => {
    n += 1;
    send({ n, t: Date.now() });
    if (Date.now() - started >= PROBE.duration_ms) { clearInterval(timer); finish(); }
  }, PROBE.interval_ms);
  return () => clearInterval(timer);
}

function probeSSE() {
  const enc = new TextEncoder();
  let closed = false, stop = () => {}, controller;
  const close = () => {
    if (closed) return;
    closed = true; stop(); probeStreams -= 1;
    try { controller.close(); } catch (_) {}
  };
  const stream = new ReadableStream({
    start(c) {
      controller = c;
      // チャットの SSE と同じ最初の合図（先行 3.2）で、本番の届き方に合わせる
      c.enqueue(enc.encode(':' + ' '.repeat(STREAM.padding_bytes - 3) + '\n\n'));
      stop = probeTicks(
        data => { try { c.enqueue(enc.encode(`event: tick\ndata: ${JSON.stringify(data)}\n\n`)); } catch (_) { close(); } },
        () => { try { c.enqueue(enc.encode('event: done\ndata: {}\n\n')); } catch (_) {} close(); });
    },
    cancel() { close(); },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', 'Connection': 'keep-alive' },
  });
}

function probeWebSocket() {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  let closed = false;
  const close = (code, reason) => {
    if (closed) return;
    closed = true; stop(); probeStreams -= 1;
    try { server.close(code, reason); } catch (_) {}
  };
  const stop = probeTicks(
    data => { try { server.send(JSON.stringify({ event: 'tick', ...data })); } catch (_) { close(1011, 'send'); } },
    () => { try { server.send(JSON.stringify({ event: 'done' })); } catch (_) {} close(1000, 'done'); });
  // compatibility_date が 2026-04-07 より前なので、相手の Close には自分で close() を返す
  server.addEventListener('close', () => close(1000, 'closed'));
  server.addEventListener('error', () => close(1011, 'error'));
  return new Response(null, { status: 101, webSocket: client });
}

// 測定の入口でなければ null を返す（呼び出し側はいつもの処理へ進む）
export function handleProbe(request, env) {
  const url = new URL(request.url), { pathname } = url;
  if (!pathname.startsWith('/magi2/probe')) return null;
  const notFound = () => new Response('Not Found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  if (env.PROBE_ENABLED !== 'true' || request.method !== 'GET') return notFound();
  if (pathname === '/magi2/probe') {
    return new Response(PROBE_PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
  }
  const isSSE = pathname === '/magi2/probe/sse', isWS = pathname === '/magi2/probe/ws';
  if (!isSSE && !isWS) return notFound();
  // 測定のページ（同じ Origin）からだけ受ける。EventSource の同一 Origin の GET は Origin を付けないので、Referer でも認める。
  // 手元の wrangler dev（loopback）では、その Origin を測定のページとみなす
  const self = ['localhost', '127.0.0.1'].includes(url.hostname) ? url.origin : PROBE_ORIGIN;
  const origin = request.headers.get('Origin') || '';
  const referer = request.headers.get('Referer') || '';
  if (origin ? origin !== self : !referer.startsWith(self + '/magi2/probe')) {
    return new Response('Forbidden', { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }
  if (isWS && request.headers.get('Upgrade') !== 'websocket') return new Response('Upgrade Required', { status: 426 });
  if (probeStreams >= PROBE.max_streams) return new Response('Too Many Requests', { status: 429, headers: { 'Cache-Control': 'no-store' } });
  probeStreams += 1;
  return isWS ? probeWebSocket() : probeSSE();
}
