// 評価専用中継の再現性。実APIには送らず、ループバックの固定SSEを中継する。
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createBufferProxy } from './sse-buffer-proxy.mjs';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
const tick = () => new Promise(resolve => setTimeout(resolve, 20));

test('中継はループバックのHTTPだけを許し、外部・認証・パスを拒否する', () => {
  for (const upstream of ['https://localhost:8789', 'http://example.test', 'http://user:password@localhost', 'http://localhost/path', 'http://localhost/?key=a']) {
    assert.throws(() => createBufferProxy({ upstream }), /loopback_upstream_required/);
  }
  assert.throws(() => createBufferProxy({ mode: 'unknown' }), /invalid_mode/);
});

for (const mode of ['pass', 'full', 'late', 'chunk', 'stall']) test('中継: ' + mode + 'のバッファ・終端・切断', async () => {
  let upstreamResponse, received = false;
  const source = createServer((req, res) => {
    req.resume(); upstreamResponse = res; received = true;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform' });
    res.write('x'.repeat(8192));
  });
  await listen(source);
  const proxy = createBufferProxy({ mode, upstream: 'http://127.0.0.1:' + source.address().port });
  await listen(proxy);
  const ctrl = new AbortController();
  let settled = false;
  const pending = fetch('http://127.0.0.1:' + proxy.address().port + '/magi2/chat', { method: 'POST', body: '{}', signal: ctrl.signal });
  pending.then(() => { settled = true; }, () => {});
  try {
    if (mode === 'stall') {
      await tick(); assert.equal(settled, false); assert.equal(received, false);
      ctrl.abort(); await assert.rejects(pending, error => error.name === 'AbortError'); return;
    }
    for (let i = 0; !received && i < 50; i++) await tick();
    assert.equal(received, true);
    if (mode === 'full') {
      await tick(); assert.equal(settled, false);
      upstreamResponse.end('end');
      assert.equal(await (await pending).text(), 'x'.repeat(8192) + 'end');
    } else {
      const res = await pending, reader = res.body.getReader();
      assert.equal(res.headers.get('Cache-Control'), 'no-cache, no-transform');
      const first = Buffer.from((await reader.read()).value);
      assert.equal(first.length, mode === 'late' ? 4096 : 8192);
      upstreamResponse.end('end');
      let rest = ''; for (;;) { const part = await reader.read(); if (part.done) break; rest += Buffer.from(part.value); }
      assert.equal(first.toString() + rest, 'x'.repeat(8192) + 'end');
    }
  } finally { ctrl.abort(); await close(proxy); await close(source); }
});
