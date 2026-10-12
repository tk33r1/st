// 先行改修計画§2の中継。ループバック専用・本文やキーを記録せず、本番へは接続しない。
// node .github/scripts/sse-buffer-proxy.mjs --mode full --upstream http://localhost:8789 --port 8787
import { createServer, request } from 'node:http';
import { pathToFileURL } from 'node:url';

export function createBufferProxy({ mode = 'pass', upstream = 'http://localhost:8789' } = {}) {
  if (!['pass', 'full', 'late', 'chunk', 'stall'].includes(mode)) throw new Error('invalid_mode');
  const target = new URL(upstream);
  if (target.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
    || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new Error('loopback_upstream_required');
  return createServer((req, res) => {
    const destination = new URL(req.url, target);
    if (destination.origin !== target.origin) { res.writeHead(400); res.end(); return; }
    // モデル情報・リアクション等はそのまま通し、チャットの受信だけを変える。
    const chat = req.url.split('?')[0] === '/magi2/chat';
    if (chat && mode === 'stall') { req.resume(); return; }
    let response, waiting = [], bytes = 0, immediate = mode === 'late' ? 4096 : 0;
    const out = request(destination, { method: req.method, headers: { ...req.headers, host: target.host } }, incoming => {
      response = incoming;
      const buffered = chat && incoming.statusCode === 200 && mode !== 'pass';
      const headers = { ...incoming.headers };
      delete headers['content-length']; delete headers['transfer-encoding'];
      const start = () => { if (!res.headersSent) { res.writeHead(incoming.statusCode, headers); res.flushHeaders(); } };
      if (!buffered || mode !== 'full') start();
      const flush = () => { if (bytes) { start(); res.write(Buffer.concat(waiting, bytes)); waiting = []; bytes = 0; } };
      incoming.on('data', chunk => {
        if (!buffered) { res.write(chunk); return; }
        if (immediate) {
          const length = Math.min(immediate, chunk.length); res.write(chunk.subarray(0, length));
          immediate -= length; chunk = chunk.subarray(length);
        }
        if (chunk.length) { waiting.push(chunk); bytes += chunk.length; }
        if (mode === 'chunk' && bytes >= 8192) flush();
      });
      incoming.on('end', () => { start(); flush(); res.end(); });
      incoming.on('error', () => res.destroy());
    });
    out.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    // 読み取り中の停止も上流へ伝え、AIの呼び出しを残さない。
    res.on('close', () => { response?.destroy(); out.destroy(); });
    req.on('aborted', () => out.destroy());
    req.pipe(out);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const option = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
  const mode = option('--mode', 'pass'), port = Number(option('--port', '8787'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid_port');
  const server = createBufferProxy({ mode, upstream: option('--upstream', 'http://localhost:8789') });
  server.listen(port, '127.0.0.1', () => console.log(`MAGI buffer proxy: ${mode}, 127.0.0.1:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.closeAllConnections(); server.close(); });
}
