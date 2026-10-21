// Androidの橋渡しとファイルをプロセスの外へ置き、画面が消えた後の復元を模擬する。
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { chromium } from 'playwright';
import { nativeFilesystemFixture } from './magi-native-filesystem-fixture.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), out = resolve(root, 'workers/.wrangler/magi-b3-native-20261020'); mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true }), context = await browser.newContext({ locale: 'en-US', serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
const storage = nativeFilesystemFixture(), runs = new Map(), calls = [], errors = [];
let completeImmediately = true, launchUrl = null;
const event = (name, data) => 'event: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n';
const prefix = event('classification', { version: 1, intent: 'consult', mode: 'consult', fresh: 'no', votable: 'no', site_pages: 'no', magi_candidate: false, reply_language: { version: 1, code: 'en', source: 'ui' } });
const answer = prefix + event('integrated', { delta: 'Durably received answer.' }) + event('done', {});
const methods = {
  information: async () => ({ test: false }), checkPermissions: async () => ({ display: 'denied' }),
  requestPermissions: async () => { throw Error('permission denied'); }, openNotificationSettings: async () => { calls.push(['settings']); },
  begin: async options => {
    calls.push(['begin', options]);
    runs.set(options.id, { ...options, startedAt: Date.now(), status: completeImmediately ? 'complete' : 'receiving', data: completeImmediately ? answer : prefix });
  },
  read: async ({ id, offset }) => { const run = runs.get(id); if (!run) throw Error('missing'); const bytes = Buffer.from(run.data).subarray(offset, offset + 1024);
    return { status: run.status, error: run.error || '', offset: offset + bytes.length, length: Buffer.byteLength(run.data), base64: bytes.toString('base64') }; },
  pending: async () => ({ runs: [...runs.values()].map(({ body, data, ...row }) => row) }),
  cancel: async ({ id }) => { calls.push(['cancel', id]); const run = runs.get(id); if (run?.status === 'receiving') run.status = 'stopped'; },
  acknowledge: async ({ id }) => { calls.push(['acknowledge', id]); runs.delete(id); },
};
await context.exposeBinding('bridge', async (_, method, args) => {
  try { return { value: method.startsWith('fs:') ? await storage.fs[method.slice(3)](args) : method === 'launch' ? { url: launchUrl } : await methods[method](args) }; }
  catch (error) { return { error: { message: error.message, code: error.code } }; }
});
await context.addInitScript(() => {
  const call = async (method, args) => { const result = await window.bridge(method, args); if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code }); return result.value; };
  window.magiOpenLink = null;
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {
    Filesystem: Object.fromEntries(['stat', 'readFile', 'writeFile', 'rename', 'deleteFile', 'readdir', 'rmdir', 'getUri'].map(name => [name, args => call('fs:' + name, args)])),
    MagiConversation: Object.fromEntries(['information', 'checkPermissions', 'requestPermissions', 'openNotificationSettings', 'begin', 'read', 'pending', 'cancel', 'acknowledge'].map(name => [name, args => call(name, args)])),
    App: { addListener: async (name, callback) => { if (name === 'appUrlOpen') window.magiOpenLink = callback; return { remove() {} }; }, getLaunchUrl: () => call('launch') }
  } };
});
let jsChatPosts = 0;
await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.pathname === '/magi2/chat') { jsChatPosts++; return route.abort(); }
  if (url.pathname === '/magi2/models') return route.fulfill({ json: {} });
  if (url.pathname.endsWith('/releases/latest')) return route.fulfill({ json: { tag_name: 'v5.5' } });
  if (url.origin === 'https://tk.st' && url.pathname.startsWith('/magi-app/www/')) {
    const name = url.pathname.slice('/magi-app/www/'.length) || 'index.html';
    if (!/^(?:[a-z0-9.-]+|vendor\/Readability\.js)$/.test(name)) return route.abort();
    return route.fulfill({ body: readFileSync(resolve(root, 'magi-app/www', name)), contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.html') ? 'text/html' : 'application/json' });
  }
  return route.abort();
});
async function page() {
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.goto('https://tk.st/magi-app/www/');
  await page.waitForFunction(() => !historyLoading && nativeConversation && window.magiOpenLink); return page;
}
async function send(page, text) { const sequence = await page.evaluate(() => agentSendSequence); await page.locator('#agent-input').fill(text); await page.locator('#agent-send').click(); await page.waitForFunction(sequence => agentSendSequence > sequence, sequence); }
async function idle(page) {
  for (let i = 0; i < 200; i++) {
    if (await page.evaluate(async () => { var rows = await nativeConversation.pending(); return !agentBusy && !rows.some(row => row.sessionId === currentSessionId); })) return;
    await page.waitForTimeout(50);
  }
  throw Error('native_conversation_not_idle');
}
const results = [];
try {
  let p = await page(); await send(p, 'First native question'); await idle(p);
  assert.equal(calls.filter(c => c[0] === 'begin').length, 1);
  assert.equal(await p.evaluate(() => agentHistory.length), 2); assert.equal(jsChatPosts, 0); results.push('native transport and durable acknowledgement');
  const firstId = await p.evaluate(() => currentSessionId);
  // ブラウザを閉じ、ネイティブだけで受信を終えた状態から、起動リンクで同じ会話へ復元する。
  completeImmediately = false; await p.evaluate(() => { syncCurrentToSaved(); resetAgent(); }); await send(p, 'Question before process death');
  await p.waitForFunction(() => agentBusy); await p.evaluate(() => nativeHistory.flush());
  await new Promise(resolve => setTimeout(resolve, 200));
  const pending = [...runs.values()].find(row => row.status === 'receiving'); assert(pending);
  await p.close(); pending.data = answer; pending.status = 'complete'; launchUrl = 'magi://open?id=' + pending.sessionId;
  p = await page(); await idle(p);
  assert.equal(await p.evaluate(() => agentHistory.length), 2); assert.equal(await p.evaluate(() => currentSessionId), pending.sessionId);
  assert.equal(calls.filter(c => c[0] === 'begin').length, 2); results.push('cold notification link replays once without HTTP retry');
  // 回答の無いプロセス終了では、未完了と質問を復元し、勝手に再送しない。
  await send(p, 'Interrupted question'); await p.waitForFunction(() => agentBusy); await p.evaluate(() => nativeHistory.flush());
  await new Promise(resolve => setTimeout(resolve, 200));
  const interrupted = [...runs.values()].find(row => row.status === 'receiving'); assert(interrupted);
  await p.close(); interrupted.status = 'failed'; interrupted.error = 'interrupted'; launchUrl = null;
  p = await page(); await idle(p);
  assert.equal(await p.locator('#agent-input').inputValue(), 'Interrupted question'); assert.equal(await p.evaluate(() => agentHistory.length), 2);
  assert.equal(calls.filter(c => c[0] === 'begin').length, 3); results.push('process death restores failed draft without resending');
  // 同じ会話の通知を開いても進行中の要求を止めない。違う会話へ移ると旧要求を取り消す。
  await send(p, 'Switching question'); await p.waitForFunction(() => agentBusy); await p.evaluate(() => nativeHistory.flush());
  await new Promise(resolve => setTimeout(resolve, 200));
  const switching = [...runs.values()].find(row => row.status === 'receiving'); assert(switching);
  await p.evaluate(id => magiOpenLink({ url: 'magi://open?id=' + id }), switching.sessionId); assert.equal(switching.status, 'receiving');
  await p.evaluate(id => magiOpenLink({ url: 'magi://open?id=' + id }), firstId);
  await p.waitForFunction(() => !agentBusy); await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(switching.status, 'stopped'); assert.equal(await p.evaluate(() => currentSessionId), firstId);
  assert.equal(await p.evaluate(() => agentHistory.length), 2); results.push('link ownership and conversation switch cancellation');
  // 会話JSONのrenameが失敗したら、受信済みの列は消さない。journal再適用後も二重に追加しない。
  await send(p, 'Question with a saving failure'); await p.evaluate(() => nativeHistory.flush());
  await new Promise(resolve => setTimeout(resolve, 200));
  const unsaved = [...runs.values()].find(row => row.status === 'receiving'); assert(unsaved);
  storage.setFailure((method, path) => method === 'rename' && path.startsWith('magi/sessions/'));
  unsaved.data = answer; unsaved.status = 'complete';
  await p.waitForFunction(() => document.getElementById('agent-status').textContent.includes('Could not finish saving'));
  assert(runs.has(unsaved.id)); const beforeRecovery = calls.filter(c => c[0] === 'begin').length;
  await p.close(); storage.setFailure(null); p = await page(); await idle(p);
  assert.equal(await p.evaluate(id => agentHistory.filter(m => m.role === 'assistant' && m.native_request === id).length, unsaved.id), 1);
  assert.equal(calls.filter(c => c[0] === 'begin').length, beforeRecovery); results.push('save failure keeps spool and recovery acknowledges exactly once');
  const originalName = 'a'.repeat(64) + '.png', original = readFileSync(resolve(root, 'magi-app/www/icon-192.png')).toString('base64');
  storage.files.set('DATA:magi/images/' + originalName, original);
  await p.evaluate(({ original, name }) => { attachments = [{ url: 'data:image/png;base64,' + original, thumb: 'data:image/png;base64,' + original, file: name }]; renderAttachTray(); }, { original, name: originalName });
  await send(p, 'Interrupted image question'); await p.evaluate(() => nativeHistory.flush()); await new Promise(resolve => setTimeout(resolve, 200));
  const imageRun = [...runs.values()].find(row => row.status === 'receiving'); assert(imageRun);
  await p.close(); imageRun.status = 'failed'; imageRun.error = 'interrupted'; p = await page(); await idle(p);
  const restoredImage = await p.evaluate(() => ({ count: attachments.length, file: attachments[0]?.file, jpeg: attachments[0]?.url.startsWith('data:image/jpeg;') }));
  assert.deepEqual(restoredImage, { count: 1, file: originalName, jpeg: true });
  assert(storage.files.has('DATA:magi/images/' + originalName)); results.push('interrupted image restores the original for a full-size retry');
  // 受信列を全削除の対象に含め、通知拒否の状態を画面へ出す。
  await p.evaluate(() => showNativeSettings()); assert.match(await p.locator('#native-notification-status').innerText(), /Notifications are off/);
  await p.locator('#native-notification-status button').click(); assert.ok(calls.some(c => c[0] === 'settings'));
  p.on('dialog', dialog => dialog.accept()); await p.locator('#history-clear').click(); await p.waitForFunction(() => agentHistory.length === 0);
  assert.equal(runs.size, 0); results.push('notification settings and deletion of pending streams');
  assert.equal(jsChatPosts, 0); assert.deepEqual(errors, []);
  writeFileSync(resolve(out, 'browser.json'), JSON.stringify({ results, errors, jsChatPosts, nativeRequests: calls.filter(c => c[0] === 'begin').length }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: results.length, errors, jsChatPosts }));
} finally { await context.close(); await browser.close(); }
