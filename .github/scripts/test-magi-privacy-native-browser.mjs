// 一時チャットのレビュー指摘をAndroidの橋渡し・保存先を模擬して再現する。外部通信なし。
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';
import { nativeFilesystemFixture } from './magi-native-filesystem-fixture.mjs';

const root = process.cwd(), disk = nativeFilesystemFixture(), normalRequests = [], temporaryRequests = [];
const features = { privacy_contract: 1, temporary_chat: true, personalization: true, temporary_personalization: true, temporary_speech: false, speech: false };
const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const classification = { version: 1, intent: 'research', mode: 'fact', fresh: 'no', votable: 'no', site_pages: 'no',
  magi_candidate: false, reply_language: { version: 1, code: 'ja', source: 'ui' } };
function stream(body) {
  return (body.privacy_contract ? event('session', { conversation_mode: body.conversation_mode, personalization_applied: !!body.personalization }) : '')
    + event('classification', classification) + event('integrated', { delta: 'SYNTHETIC-ANSWER' }) + event('done', {});
}
const runs = new Map();
const methods = {
  information: async () => ({ test: false }), pending: async () => ({ runs: [] }),
  notificationPreference: async () => ({ enabled: false }),
  begin: async args => { const body = JSON.parse(args.body); normalRequests.push(body); runs.set(args.id, stream(body)); },
  read: async ({ id, offset }) => {
    const text = runs.get(id), bytes = Buffer.from(text).subarray(offset);
    return { status: 'complete', offset: offset + bytes.length, length: Buffer.byteLength(text), base64: bytes.toString('base64') };
  },
  cancel: async () => {}, acknowledge: async ({ id }) => { runs.delete(id); }
};
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, serviceWorkers: 'block' });
  await context.exposeBinding('privacyNativeBridge', async (_, method, args) => {
    try { return { value: method.startsWith('fs:') ? await disk.fs[method.slice(3)](args) : await methods[method](args) }; }
    catch (error) { return { error: { message: error.message, code: error.code } }; }
  });
  await context.addInitScript(() => {
    localStorage.setItem('magi_personalization_v1', JSON.stringify({ version: 1, enabled: false, preferred_name: 'NATIVE-NAME', custom_instructions: 'NATIVE-CUSTOM' }));
    localStorage.setItem('lang', 'ja'); sessionStorage.setItem('magi_transport', 'sse');
    window.privacyAppListeners = {}; window.privacyCapabilityAborts = 0;
    const call = async (method, args) => {
      const result = await window.privacyNativeBridge(method, args);
      if (result.error) throw Object.assign(new Error(result.error.message), result.error);
      return result.value;
    };
    const originalFetch = window.fetch;
    window.fetch = function (url, options) {
      if (String(url).includes('capabilities=1')) options.signal.addEventListener('abort', () => { window.privacyCapabilityAborts++; });
      return originalFetch.call(this, url, options);
    };
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {
      Filesystem: Object.fromEntries(['stat', 'readFile', 'writeFile', 'rename', 'deleteFile', 'readdir', 'getUri'].map(name => [name, args => call('fs:' + name, args)])),
      MagiConversation: Object.fromEntries(['information', 'pending', 'notificationPreference', 'begin', 'read', 'cancel', 'acknowledge'].map(name => [name, args => call(name, args)])),
      SystemBars: { setStyle: async () => {} },
      App: { addListener: async (name, callback) => { (window.privacyAppListeners[name] ||= []).push(callback); return { remove() {} }; }, getLaunchUrl: async () => null }
    } };
  });
  let holdFeatures = false, heldRoute = null;
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/magi2/models') {
      if (holdFeatures && url.searchParams.has('capabilities')) { heldRoute = route; return; }
      return route.fulfill({ json: { features } });
    }
    if (url.pathname === '/magi2/usage') return route.fulfill({ json: { used: 0, limit: 60 } });
    if (url.pathname === '/magi2/chat') { const body = JSON.parse(request.postData()); temporaryRequests.push(body); return route.fulfill({ contentType: 'text/event-stream', body: stream(body) }); }
    if (url.hostname === 'tk.st') {
      const file = resolve(root, '.' + (url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname));
      if (file.startsWith(root + sep) && existsSync(file) && extname(file)) return route.fulfill({ body: readFileSync(file),
        contentType: ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' })[extname(file)] || 'application/octet-stream' });
    }
    return route.abort();
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('https://tk.st/magi-app/www/');
  await page.waitForFunction(() => nativeHistory?.active && !historyLoading && nativeConversation && window.privacyAppListeners.appStateChange?.length);
  await page.evaluate(() => setSharedDocument({ title: 'SHARED-DOC', text: 'SYNTHETIC-DOCUMENT', url: '' }));
  await page.evaluate(() => nativeHistory.flush());
  assert.equal(await page.locator('#agent-shared-tray').isVisible(), true);
  await page.locator('#btn-temporary-agent').click();
  assert.equal(await page.locator('#agent-shared-tray').isVisible(), false);
  await page.locator('#btn-temporary-agent').click();
  assert.equal(await page.locator('#agent-shared-tray').isVisible(), true);
  assert.ok((await page.locator('#agent-shared-tray').innerText()).includes('SHARED-DOC'));
  async function send(text) {
    await page.locator('#agent-input').fill(text); await page.locator('#agent-send').click();
    await page.waitForFunction(() => !agentPrivacyState.preparing && !agentBusy && agentHistory.at(-1)?.role === 'assistant');
  }
  await send('NORMAL-WITH-DOCUMENT');
  assert.equal(normalRequests.at(-1).shared.title, 'SHARED-DOC');
  await page.evaluate(() => nativeHistory.flush());
  const beforeTemporary = JSON.stringify([...disk.files]);
  await page.locator('#btn-temporary-agent').click(); holdFeatures = true;
  await page.locator('#agent-input').fill('KEEP-BACKGROUND-DRAFT'); await page.locator('#agent-send').click();
  await page.waitForFunction(() => agentPrivacyState.preparing && agentPrivacyState.preflight);
  await page.evaluate(() => window.privacyAppListeners.appStateChange.forEach(callback => callback({ isActive: false })));
  await page.waitForFunction(() => !agentPrivacyState.preparing);
  assert.equal(await page.evaluate(() => window.privacyCapabilityAborts), 1);
  assert.equal(await page.locator('#agent-input').inputValue(), 'KEEP-BACKGROUND-DRAFT');
  assert.equal(temporaryRequests.length, 0);
  holdFeatures = false;
  if (heldRoute) await heldRoute.fulfill({ json: { features } });
  await page.evaluate(() => window.privacyAppListeners.appStateChange.forEach(callback => callback({ isActive: true })));
  await page.waitForTimeout(100);
  assert.equal(temporaryRequests.length, 0, '復帰だけでは再送しない');
  assert.equal(await page.locator('#agent-input').inputValue(), 'KEEP-BACKGROUND-DRAFT');
  await send('EXPLICIT-RETRY');
  assert.equal(temporaryRequests.length, 1);
  assert.equal(temporaryRequests[0].conversation_mode, 'temporary');
  assert.equal('shared' in temporaryRequests[0], false);
  await page.locator('#btn-more-agent').click(); await page.locator('#btn-temporary-settings-agent').click();
  await page.evaluate(() => window.privacyAppListeners.backButton.forEach(callback => callback({ canGoBack: false })));
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.locator('#btn-temporary-agent').getAttribute('aria-pressed'), 'true');
  await page.locator('#btn-more-agent').click(); await page.locator('#btn-temporary-settings-agent').click();
  await page.locator('input[value="on"]').check(); await page.locator('#agent-temporary-settings-form button[type="submit"]').click();
  await send('PERSONALIZED-TEMPORARY');
  assert.equal(temporaryRequests.at(-1).temporary_personalization, true);
  assert.equal(temporaryRequests.at(-1).personalization.preferred_name, 'NATIVE-NAME');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('magi_personalization_v1')).enabled), false);
  await page.evaluate(() => nativeHistory.flush());
  assert.equal(JSON.stringify([...disk.files]), beforeTemporary, '一時は端末ファイルを変更しない');
  await page.locator('#btn-temporary-agent').click();
  assert.equal(await page.locator('#agent-shared-tray').isVisible(), true);
  await page.locator('#agent-shared-tray button').last().click();
  assert.equal(await page.locator('#agent-shared-tray').isVisible(), false);
  await send('NORMAL-WITHOUT-DOCUMENT');
  assert.equal('shared' in normalRequests.at(-1), false);
  assert.deepEqual(errors, []);
  console.log('Android mock: document visibility/removal, background preflight cancellation, explicit retry and no temporary file writes PASS');
} finally { await browser.close(); }
