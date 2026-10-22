// 読み上げ設計の公開C1の実画面（読み上げ検証計画§2.1〜2.3）。トップページ（ライト・ダーク）とアプリ（390px・320px）で、
// 固定のSSEとWorkerの模擬を使い、操作列の並び・ソースの一覧・共有・読み上げの再生と停止・履歴からの復元を確かめる。
// AI・Fish Audio・計測は呼ばない。node .github/scripts/test-magi-reply-bar-browser.mjs [リポジトリのパス] [--screenshots]
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '.');
const event = (ev, data) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`;
const SIG = 'ab'.repeat(32);
const answer = '公式の案内では、開館は9時です。休館日は月曜です。';
// 16x16 の PNG（1色）。Worker が付けるアイコンと同じ data: URL の形
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==';
const sources = { items: [{ n: 1, title: '公式サイト', url: 'https://www.example.com/hours', icon: PNG }, { n: 2, title: 'お知らせ', url: 'https://news.example.org/a' }],
  marks: [{ at: 16, n: 1 }, { at: 25, n: 2 }] };
// 0.2秒の無音の WAV（読み上げの区切りの代わり。Chromium で鳴らせる形）
function wav(ms = 200) {
  const samples = Math.round(8000 * ms / 1000), b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples * 2, 40);
  return b;
}
const server = createServer((req, res) => {
  let path = new URL(req.url, 'http://localhost').pathname; if (path.endsWith('/')) path += 'index.html';
  const file = resolve(root, '.' + path);
  if (!file.startsWith(root + sep) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json' })[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const until = async (check, label) => { for (let i = 0; i < 300; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('timeout: ' + label); };
const captures = resolve(root, 'workers/.wrangler/magi2-speech/captures');
let checked = 0;
try {
  for (const [name, path, width, lang] of [['home-light', '/', 1280, 'ja-JP'], ['home-dark', '/', 1280, 'en-US'], ['app', '/magi-app/www/', 390, 'ja-JP'], ['app-320', '/magi-app/www/', 320, 'en-US']]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: lang, serviceWorkers: 'block' });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    const page = await context.newPage(), errors = [], external = [], speech = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
      localStorage.setItem('st-analytics', 'off');
      window.__shared = [];
      Object.defineProperty(navigator, 'share', { configurable: true, value: data => { window.__shared.push(data); return Promise.resolve(); } });
    });
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname === '/magi2/models') { await route.fulfill({ json: { personas: {}, synthesizer: {}, features: { speech: true } }, headers: { 'Access-Control-Allow-Origin': origin } }); return; }
      if (url.pathname === '/magi2/usage') { await route.fulfill({ json: { used: 1, limit: 60, day: '2026-10-23', resets_at: '2026-10-24T00:00:00Z', global_full: false }, headers: { 'Access-Control-Allow-Origin': origin } }); return; }
      if (url.pathname === '/magi2/chat') {
        await route.fulfill({ contentType: 'text/event-stream', headers: { 'Access-Control-Allow-Origin': origin }, body: ': padding\n\n'
          + event('classification', { version: 1, intent: 'research', mode: 'fact', fresh: 'yes', votable: 'no', site_pages: 'no', magi_candidate: false, reply_language: { version: 1, code: 'ja', source: 'ui' } })
          + event('integrated', { delta: answer }) + event('sources', sources) + event('speech', { sig: SIG, lang: 'ja' }) + event('done', {}) });
        return;
      }
      if (url.pathname === '/magi2/speech') {
        const body = JSON.parse(request.postData()); speech.push(body);
        await route.fulfill({ status: 200, body: wav(), headers: { 'Content-Type': 'audio/mpeg', 'X-Speech-Parts': '2', 'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': 'X-Speech-Parts' } });
        return;
      }
      if (url.origin !== origin) { external.push(url.origin + url.pathname); await route.fulfill({ status: 204, body: '' }); return; }
      await route.continue();
    });
    await page.goto(origin + path, { waitUntil: 'domcontentloaded' });
    const home = name.startsWith('home');
    if (home && !(await page.locator('#agentdock:not(.collapsed)').count())) await page.locator('#activitybar [data-act="agent"]').click();
    if (name === 'home-dark') await page.locator('[data-act="settings"]').click();
    await page.locator('#agent-input').fill('開館時間を確認して');
    const sentAt = external.length;
    await page.locator('#agent-send').click();
    const bar = page.locator('.agent-reply .reply-bar').last();
    await until(async () => (await bar.locator('[data-act="sources"]:not([hidden])').count()) === 1, 'sources button');

    // §2.1 並び: ［コピー］［🔊］［共有］［いいね］［︙］、右寄せの［ソース］。押せる大きさ
    const acts = await bar.locator('button:not([hidden])').evaluateAll(list => list.map(b => b.dataset.act));
    assert.deepEqual(acts, ['copy', 'speak', 'share', 'like', 'emoji', 'sources'], name);
    for (const box of await bar.locator('button:not([hidden])').evaluateAll(list => list.map(b => b.getBoundingClientRect().height))) assert(box >= 32, name + ' button height ' + box);
    const src = bar.locator('[data-act="sources"]');
    assert.equal(await src.locator('img.src-icon').count(), 1); assert.equal(await src.locator('.src-letter').count(), 1);
    assert.equal(await page.locator('.agent-reply .agent-sources').count(), 0, '回答の下に旧い一覧を出さない');
    assert.equal(await page.locator('.agent-reply-body a').count(), 2, '本文の[n]は残す');
    const overflow = await page.evaluate(() => { const log = document.getElementById('agent-log'); return log.scrollWidth - log.clientWidth; });
    assert(overflow <= 1, name + ' horizontal overflow ' + overflow);
    if (process.argv.includes('--screenshots')) { mkdirSync(captures, { recursive: true }); await page.screenshot({ path: resolve(captures, name + '-bar.png'), animations: 'disabled' }); }

    // §2.2 ソースの一覧。Esc で閉じて［ソース］へ戻る。画面から出典のサイトへ取りに行かない
    await src.click();
    const rows = page.locator(home ? '.src-list .src-row' : '#agent-sources-panel .src-row');
    await until(async () => (await rows.count()) === 2, 'source rows');
    assert.equal(await src.getAttribute('aria-expanded'), 'true');
    assert.deepEqual(await rows.evaluateAll(list => list.map(a => [a.target, a.rel, a.querySelector('.src-domain').textContent])),
      [['_blank', 'noopener noreferrer', 'example.com'], ['_blank', 'noopener noreferrer', 'news.example.org']]);
    if (process.argv.includes('--screenshots')) await page.screenshot({ path: resolve(captures, name + '-sources.png'), animations: 'disabled' });
    await page.keyboard.press('Escape');
    await until(async () => (await rows.count()) === 0, 'close sources');
    assert.equal(await src.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.dataset.act), 'sources');
    assert.deepEqual(external.slice(sentAt), [], name + ' external requests');

    // §2.2 共有: 題名と本文（[n]と出典の一覧）を渡し、URL は渡さない。共有が無ければコピーして知らせる
    await bar.locator('[data-act="share"]').click();
    await until(async () => (await page.evaluate(() => window.__shared.length)) === 1, 'share');
    const shared = await page.evaluate(() => window.__shared[0]);
    assert.deepEqual(Object.keys(shared).sort(), ['text', 'title']);
    assert.match(shared.text, /\[1\]/); assert.match(shared.text, /https:\/\/www\.example\.com\/hours/);
    await page.evaluate(() => { delete navigator.share; Object.defineProperty(navigator, 'share', { configurable: true, value: undefined }); });
    await bar.locator('[data-act="share"]').click();
    await until(async () => (await page.locator('.reply-note').count()) === 1, 'copied note');
    // Windows のクリップボードは改行を CRLF にして返す
    assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n'), shared.text);

    // §2.3 読み上げ: 押すと区切り0と1を取り、鳴らし終えたら元に戻る。もう一度押すとすぐ止まる
    const speak = bar.locator('[data-act="speak"]');
    await speak.click();
    assert.equal(await speak.getAttribute('aria-pressed'), 'true');
    await until(async () => speech.length === 2, 'two parts');
    assert.deepEqual(speech.map(b => b.part), [0, 1]); assert.equal(speech[0].sig, SIG); assert.equal(speech[0].lang, 'ja'); assert.equal(speech[0].text, answer);
    await until(async () => (await speak.getAttribute('data-state')) === 'idle', 'played to the end');
    assert.equal(await speak.getAttribute('aria-pressed'), 'false');
    await speak.click(); await speak.click();
    assert.equal(await speak.getAttribute('data-state'), 'idle');
    assert.equal(await page.locator('audio').count(), 0, '<audio> は文書に挿さない');

    // 履歴から開き直しても、保存した署名で 🔊 と［ソース］が出る
    await page.reload({ waitUntil: 'domcontentloaded' });
    if (home && !(await page.locator('#agentdock:not(.collapsed)').count())) await page.locator('#activitybar [data-act="agent"]').click();
    const restored = page.locator('.agent-reply .reply-bar').last();
    await until(async () => (await restored.locator('[data-act="speak"]:not([hidden])').count()) === 1, 'restored speak');
    assert.equal(await restored.locator('[data-act="sources"]:not([hidden])').count(), 1);
    assert.deepEqual(errors, [], name + ' page errors');
    await context.close();
    checked++;
  }
  console.log('reply bar browser checks passed:', checked);
} finally {
  await browser.close();
  server.close();
}
