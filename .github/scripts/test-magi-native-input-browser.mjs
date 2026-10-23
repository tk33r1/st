// B2画面を全通信模擬で確認する。実AI・音声・外部記事には送らない。
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { nativeFilesystemFixture } from './magi-native-filesystem-fixture.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = resolve(root, 'workers/.wrangler/magi-b2-20261020'); mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const report = [];
try {
 for (const native of [false, true]) {
  const context = await browser.newContext({ locale: 'ja-JP', viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const posts = [], errors = [], escaped = [];
  await context.route('**/*', async route => {
   const request = route.request(), url = new URL(request.url());
   if (url.origin === 'https://tk.st' && url.pathname.startsWith('/magi-app/www/')) {
    const file = url.pathname.slice('/magi-app/www/'.length) || 'index.html';
    if (!/^(?:[a-z0-9.-]+|vendor\/Readability\.js)$/.test(file)) return route.abort();
    return route.fulfill({ body: readFileSync(resolve(root, 'magi-app/www', file)), contentType: file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'image/png' });
   }
   if (url.pathname === '/magi2/models') return route.fulfill({ json: {} });
   if (url.pathname.endsWith('/releases/latest')) return route.fulfill({ json: { tag_name: 'v5.3' } });
   if (url.pathname === '/magi2/chat') {
    posts.push(request.postDataJSON());
    return route.fulfill({ contentType: 'text/event-stream', body: 'event: classification\ndata: {"version":1,"intent":"consult","mode":"consult","fresh":"no","votable":"no","site_pages":"no","magi_candidate":false,"reply_language":{"version":1,"code":"ja","source":"ui"}}\n\nevent: integrated\ndata: {"delta":"模擬回答です。"}\n\nevent: done\ndata: {}\n\n' });
   }
   escaped.push(url.origin); return route.abort();
  });
  await context.addInitScript('window.makeNativeFilesystemFixture = ' + nativeFilesystemFixture.toString());
  await context.addInitScript(({ native }) => {
   try { sessionStorage.setItem('magi_transport', 'sse'); } catch (_) {} // 既存の検証は SSE の経路を見る。WebSocket（読み上げ設計§6.3）は test-magi-ws-browser.mjs で確かめ、ここでは手元・本番のどちらへも開かない
   window.shareQueue = [{ text: '起動前に共有した文章', images: [] }]; window.voiceEvents = {}; window.voiceCalls = [];
   const tiny = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=';
   if (native) window.Capacitor = {
    isNativePlatform: () => true, getPlatform: () => 'android', convertFileSrc: () => tiny,
    Plugins: {
     Filesystem: window.makeNativeFilesystemFixture().fs,
     MagiShare: {
      addListener: async (_, fn) => { window.shareSignal = fn; return { remove() {} }; },
      takeShare: async () => ({ share: window.shareQueue.shift() }), releaseShare: async () => {},
      getArticle: async ({ url }) => ({ url, contentType: 'text/html; charset=utf-8', base64: btoa(unescape(encodeURIComponent('<html><head><title>共有記事</title></head><body><article><h1>共有記事</h1><p>' + '記事の本文です。'.repeat(1100) + '</p><script>window.sharedScriptRan=true</script><img src="https://never-load.invalid/pixel"></article></body></html>'))) })
     },
     SpeechRecognition: {
      available: async () => ({ available: true }), checkPermissions: async () => ({ speechRecognition: 'granted' }),
      getSupportedLanguages: async () => { throw new Error('Android 13+'); }, requestPermissions: async () => ({ speechRecognition: 'granted' }),
      start: async options => { window.voiceCalls.push(options); }, stop: async () => {},
      addListener: async (name, callback) => { window.voiceEvents[name] = event => callback({ sessionId: window.voiceCalls.at(-1)?.sessionId, ...event }); return { remove() {} }; }
     }
    }
   };
   localStorage.setItem('magi_saved_sessions', JSON.stringify([{ id: 'old', timestamp: 1, title: '既存の会話', history: [{ role: 'user', content: '古い質問' }, { role: 'assistant', content: '古い答え' }] }]));
  }, { native });
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto('https://tk.st/magi-app/www/');
  await page.waitForFunction(() => !historyLoading);
  if (!native) {
   assert.equal(await page.locator('#agent-voice').isVisible(), false); assert.equal(await page.locator('#agent-shared-tray').isVisible(), false);
   assert.equal(await page.evaluate(() => window.voiceCalls.length), 0);
  } else {
   await page.waitForFunction(() => document.getElementById('agent-input').value === '起動前に共有した文章');
   assert.equal(posts.length, 0);
   await page.evaluate(() => { shareQueue.push({ text: 'https://example.com/article', images: [] }); shareSignal(); });
   await page.waitForFunction(() => !!agentShared && !sharedLoading);
   assert.equal(await page.evaluate(() => agentShared.text.length), 6000);
   assert.equal(await page.evaluate(() => !!window.sharedScriptRan), false);
   assert.equal(posts.length, 0);
   await page.locator('#agent-shared-tray button').first().click();
   assert.ok((await page.locator('.shared-document-text').innerText()).includes('記事の本文'));
   await page.locator('.agent-panel-close').click();
   for (const question of ['この記事の要点は？', '続きも教えて']) {
    await page.locator('#agent-input').fill(question); await page.locator('#agent-send').click(); await page.waitForFunction(() => !agentBusy);
   }
   assert.equal(posts.length, 2); assert.deepEqual(posts[0].shared, posts[1].shared);
   const id = await page.evaluate(() => currentSessionId);
   assert.ok(id, 'shared conversation must have an ID');
   const savedShared = await page.evaluate(() => JSON.parse(safeGet('magi_saved_sessions') || '[]').map(s => ({ id: s.id, hasShared: !!s.shared, length: s.history.length })));
   assert.ok(savedShared.find(s => s.id === id)?.hasShared, JSON.stringify(savedShared));
   // 別の会話へ切り替えても、切替前の会話の資料・本文を上書きしない。
   const originalSessions = await page.evaluate(() => JSON.parse(safeGet('magi_saved_sessions')));
   await page.evaluate(() => loadSavedSession('old'));
   assert.equal(await page.evaluate(() => agentShared), null);
   assert.equal(await page.evaluate(() => safeGet('magi_current_shared')), null);
   await page.evaluate(id => loadSavedSession(id), id);
   assert.equal(await page.evaluate(() => agentShared.title), '共有記事');
   const restoredSessions = await page.evaluate(() => JSON.parse(safeGet('magi_saved_sessions')));
   for (const savedId of ['old', id]) {
    const before = originalSessions.find(s => s.id === savedId), after = restoredSessions.find(s => s.id === savedId);
    assert.deepEqual(after.history, before.history); assert.deepEqual(after.shared, before.shared);
   }
   await page.evaluate(() => { syncCurrentToSaved(); resetAgent(); });
   await page.evaluate(id => loadSavedSession(id), id);
   assert.equal(await page.evaluate(() => agentShared.title), '共有記事');
   await page.locator('#agent-shared-tray button').last().click();
   await page.locator('#agent-input').fill('資料を外した質問'); await page.locator('#agent-send').click(); await page.waitForFunction(() => !agentBusy);
   assert.equal(posts[2].shared, undefined);
   await page.evaluate(() => { shareQueue.push({ text: '画像の共有', images: Array.from({ length: 5 }, (_, i) => ({ path: 'image' + i, type: 'image/png' })), truncated: true }); shareSignal(); });
   await page.waitForFunction(() => attachments.length === 4 && !sharedLoading);
   assert.match(await page.locator('#agent-status').innerText(), /最初の4枚/);
   assert.equal(posts.length, 3);
   await page.evaluate(() => resetAgent());
   await page.locator('#agent-input').fill('入力済み'); await page.locator('#agent-voice').click();
   await page.waitForFunction(() => voiceCalls.length === 1);
   assert.equal(await page.evaluate(() => voiceCalls[0].language), 'ja-JP');
   await page.evaluate(() => voiceEvents.partialResults({ matches: ['音声の途中'] }));
   assert.equal(await page.locator('#agent-input').inputValue(), '入力済み');
   await page.evaluate(() => voiceEvents.partialResults({ matches: ['確定した声'], final: true }));
   assert.match(await page.locator('#agent-input').inputValue(), /入力済み\n確定した声/);
   assert.equal(posts.length, 3);
   // 音声入力の途中の送信は止めるだけ。確定した文を入力欄へ入れ、送らない。
   await page.locator('#agent-voice').click(); await page.waitForFunction(() => voiceCalls.length === 2);
   await page.evaluate(() => voiceEvents.partialResults({ matches: ['送信前の途中'] }));
   await page.locator('#agent-send').click();
   await page.evaluate(() => voiceEvents.partialResults({ matches: ['送信前の確定'], final: true }));
   assert.match(await page.locator('#agent-input').inputValue(), /確定した声\n送信前の確定$/);
   assert.equal(await page.locator('#agent-voice').getAttribute('aria-pressed'), 'false');
   assert.equal(posts.length, 3);
   await page.evaluate(() => { shareQueue.push({ text: '<script>表示文字列</script>'.repeat(80), images: [] }); shareSignal(); });
   await page.waitForFunction(() => !!agentShared && !sharedLoading);
   await page.locator('#agent-shared-tray button').first().click();
   assert.ok((await page.locator('.shared-document-text').innerText()).includes('<script>表示文字列</script>'));
   assert.equal(await page.locator('#agent-shared-panel script').count(), 0);
   await page.locator('.agent-panel-close').click();
   await page.screenshot({ path: resolve(out, 'b2-share-voice.png') });
  }
  assert.deepEqual(errors, []);
  assert.ok(!escaped.some(host => host.includes('never-load')));
  report.push({ native, pageErrors: errors, capturedChatPosts: posts.length, externalDocumentImagesLoaded: false });
  await context.close();
 }
 writeFileSync(resolve(out, 'browser.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
} finally { await browser.close(); }
