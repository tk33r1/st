// 読み上げ設計の公開C2の実画面（読み上げ検証計画§2.4）。トップページとPWA（390px）で、WebSocket の Worker を模擬し、
// 少しずつ届くこと、SSE を溜める環境でも注記が出ないこと、開けないときだけ SSE で1回送ること、開いた後に切れても送り直さないこと、
// 停止で stop を送ること、DJ の画面は WebSocket を使わないことを確かめる。AI・計測は呼ばない。
// node .github/scripts/test-magi-ws-browser.mjs [リポジトリのパス]
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '.');
const event = (ev, data) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`;
const classification = { version: 1, intent: 'consult', votable: 'no', site_pages: 'no', magi_candidate: false, reply_language: { version: 1, code: 'ja', source: 'ui' } };
const ids = ['MELCHIOR-1', 'BALTHASAR-2', 'CASPER-3'];
const parts = ['少しずつ', '届く', '回答です。'];
const server = createServer((req, res) => {
  let path = new URL(req.url, 'http://localhost').pathname; if (path.endsWith('/')) path += 'index.html';
  const file = resolve(root, '.' + path);
  if (!file.startsWith(root + sep) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' })[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ headless: true });
const until = async (check, label, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('timeout: ' + label); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let checked = 0;
try {
  for (const [name, path, width] of [['home', '/', 1280], ['app', '/magi-app/www/?api=http://localhost:8787', 390]]) {
    for (const mode of ['stream', 'refused', 'cut', 'stop']) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, locale: 'ja-JP', serviceWorkers: 'block' });
      const errors = [], sse = [], wsMessages = [], sockets = [];
      let wsConnections = 0;
      page.on('pageerror', e => errors.push(e.message));
      page.on('websocket', ws => sockets.push(ws.url()));
      await page.addInitScript(() => localStorage.setItem('st-analytics', 'off'));
      if (mode !== 'refused') {
        await page.routeWebSocket('**/magi2/ws', ws => {
          wsConnections++;
          ws.onMessage(async text => {
            const message = JSON.parse(text); wsMessages.push(message);
            if (message.type !== 'chat') return;
            ws.send(JSON.stringify({ event: 'classification', data: classification }));
            for (const round of [1, 2]) for (const codename of ids) ws.send(JSON.stringify({ event: 'persona', data: { codename, round, text: '意見' + round } }));
            for (const [i, delta] of parts.entries()) {
              if (mode === 'cut' && i === 1) { ws.close({ code: 1011, reason: 'cut' }); return; }
              if (mode === 'stop' && i === 1) return; // 止めるまで待つ
              ws.send(JSON.stringify({ event: 'integrated', data: { delta } }));
              await sleep(400);
            }
            ws.send(JSON.stringify({ event: 'ping' }));
            ws.send(JSON.stringify({ event: 'done', data: { request_id: 'r' } }));
            ws.close({ code: 1000, reason: 'done' });
          });
        });
      }
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/magi2/chat') {
          sse.push(JSON.parse(route.request().postData()));
          // SSE を溜める環境：全部を 3 秒後にまとめて返す
          await sleep(3000);
          await route.fulfill({ contentType: 'text/event-stream', headers: { 'Access-Control-Allow-Origin': origin }, body: ': padding\n\n' + event('classification', classification)
            + [1, 2].flatMap(round => ids.map(codename => event('persona', { codename, round, text: '意見' + round }))).join('') + event('integrated', { delta: parts.join('') }) + event('done', {}) });
          return;
        }
        if (url.pathname === '/magi2/models') { await route.fulfill({ json: { personas: {}, synthesizer: {}, features: { speech: false } }, headers: { 'Access-Control-Allow-Origin': origin } }); return; }
        if (url.pathname === '/magi2/usage') { await route.fulfill({ json: { used: 1, limit: 60, day: '2026-10-23', resets_at: '2026-10-24T00:00:00Z', global_full: false }, headers: { 'Access-Control-Allow-Origin': origin } }); return; }
        if (url.origin !== origin) { await route.fulfill({ status: 204, body: '' }); return; }
        await route.continue();
      });
      await page.goto(origin + path, { waitUntil: 'domcontentloaded' });
      if (name === 'home' && !(await page.locator('#agentdock:not(.collapsed)').count())) await page.locator('#activitybar [data-act="agent"]').click();
      await page.locator('#agent-input').fill('受信の確認');
      await page.locator('#agent-send').click();
      const body = page.locator('.agent-reply-body').last();
      if (mode === 'stream') {
        // 1つ目の差分が出た時点で、まだ最後まで届いていない（少しずつ届いている）
        await until(async () => (await body.textContent()) === parts[0], 'first delta');
        assert.equal(await page.locator('.magi-stream-note').count(), 0, name + ': まとめて届いた注記を出さない');
        await until(async () => (await body.textContent()) === parts.join(''), 'full reply');
        await until(async () => !(await page.locator('#agent-input').isDisabled()), 'input enabled');
        assert.equal(sse.length, 0, name + ': SSE を使わない');
        assert.equal(wsConnections, 1);
        assert.equal(wsMessages[0].type, 'chat'); assert.equal(wsMessages[0].v, 1); assert.equal(wsMessages[0].body.messages.at(-1).content, '受信の確認');
        const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('magi_current_history')));
        assert.equal(saved.at(-1).content, parts.join(''));
      } else if (mode === 'refused') {
        // WebSocket が開けない（接続を拒否）→ SSE で1回だけ送り、最後まで表示する。その画面では次から SSE
        await until(async () => (await body.textContent()) === parts.join(''), 'sse reply', 12000);
        assert.equal(sse.length, 1);
        assert.equal(await page.evaluate(() => sessionStorage.getItem('magi_transport')), 'sse');
        await until(async () => !(await page.locator('#agent-input').isDisabled()), 'input enabled');
        const before = sockets.length;
        await page.locator('#agent-input').fill('2回目'); await page.locator('#agent-send').click();
        await until(async () => sse.length === 2, 'second via sse', 12000);
        assert.equal(sockets.length, before, '2回目は WebSocket を開かない');
      } else if (mode === 'cut') {
        // 開いて要求を送った後に切れた → SSE で送り直さず、今の切断と同じ表示
        await until(async () => (await page.locator('.agent-err').count()) === 1, 'cut error');
        assert.equal(sse.length, 0, name + ': 送り直さない');
        assert.equal(await page.locator('#agent-input').inputValue(), '受信の確認', '質問を入力欄に戻す');
      } else {
        await until(async () => (await body.textContent()) === parts[0], 'first delta before stop');
        await page.locator('#agent-send').click(); // 停止
        await until(async () => wsMessages.some(m => m.type === 'stop'), 'stop sent');
        assert.equal(sse.length, 0);
        assert.equal(await page.locator('.agent-err').count(), 0, '停止ではエラーを出さない');
      }
      assert.deepEqual(errors, [], `${name}/${mode} page errors`);
      console.log(`${name}/${mode}: OK`);
      await page.close();
      checked++;
    }
  }
  // DJ の画面は SSE のまま（WebSocket を開かない）
  const page = await browser.newPage({ viewport: { width: 390, height: 900 }, serviceWorkers: 'block' });
  const sockets = [];
  page.on('websocket', ws => sockets.push(ws.url()));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 204, body: '' }));
  await page.goto(origin + '/dj/request/', { waitUntil: 'domcontentloaded' });
  assert(!(await page.content()).includes('openAgentChat('));
  assert.equal(sockets.length, 0);
  await page.close();
  console.log('ws browser checks passed:', checked);
} finally {
  await browser.close();
  server.close();
}
