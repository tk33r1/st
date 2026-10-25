// 送信・添付・遅れて完了する評価をWeb/PWA/Android保存先で再現する。HTTP/WSとも外部へ接続しない。
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, extname, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { nativeFilesystemFixture } from './magi-native-filesystem-fixture.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const image = readFileSync(resolve(root, 'magi-app/www/icon-192.png')).toString('base64');
const longReply = 'L'.repeat(3999) + '😀' + 'LONG-TAIL'.repeat(160);
const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const results = [], browser = await chromium.launch({ headless: true });
const classification = { version: 1, intent: 'consult', mode: 'consult', fresh: 'no', votable: 'no', site_pages: 'no',
  magi_candidate: false, reply_language: { version: 1, code: 'en', source: 'ui' } };
try {
  for (const surface of ['web', 'pwa', 'android-storage']) {
    const native = surface === 'android-storage', disk = nativeFilesystemFixture(), requests = [], reactions = [], runs = new Map(), errors = [];
    let heldRating, receiptId = 0;
    const context = await browser.newContext({ serviceWorkers: 'block', locale: 'en-US', reducedMotion: 'reduce', viewport: { width: surface === 'web' ? 1400 : 390, height: 900 } });
    function response(body) {
      requests.push(body);
      // 送信前に履歴を切り詰めていることを、Workerの救済とは独立して確かめる。
      assert(body.messages.filter(m => m.role === 'assistant').every(m => m.content.length <= 4000));
      const content = body.messages.at(-1).content;
      const text = typeof content === 'string' ? content : content.find(p => p.type === 'text')?.text;
      return event('classification', classification) + event('integrated', { delta: text === 'LONG-QUESTION' ? longReply : 'ANSWER-' + text }) + event('done', {});
    }
    const methods = {
      information: async () => ({ test: false }), notificationPreference: async () => ({ enabled: false }), pending: async () => ({ runs: [] }),
      begin: async args => runs.set(args.id, response(JSON.parse(args.body))),
      read: async ({ id, offset }) => {
        const data = runs.get(id), bytes = Buffer.from(data).subarray(offset);
        return { status: 'complete', offset: offset + bytes.length, length: Buffer.byteLength(data), base64: bytes.toString('base64') };
      },
      cancel: async () => {}, acknowledge: async ({ id }) => runs.delete(id)
    };
    await context.exposeBinding('reviewBridge', async (_, method, args) => {
      try { return { value: method.startsWith('fs:') ? await disk.fs[method.slice(3)](args) : await methods[method](args) }; }
      catch (error) { return { error: { message: error.message, code: error.code } }; }
    });
    await context.addInitScript(({ native }) => {
      sessionStorage.setItem('magi_transport', 'sse'); localStorage.setItem('st-analytics', 'off'); localStorage.setItem('magi_location_enabled', '0');
      if (!native) return;
      const call = async (method, args) => { const result = await reviewBridge(method, args); if (result.error) throw Object.assign(new Error(result.error.message), result.error); return result.value; };
      window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {
        Filesystem: Object.fromEntries(['stat', 'readFile', 'writeFile', 'rename', 'deleteFile', 'readdir', 'getUri'].map(name => [name, args => call('fs:' + name, args)])),
        MagiConversation: Object.fromEntries(['information', 'notificationPreference', 'pending', 'begin', 'read', 'cancel', 'acknowledge'].map(name => [name, args => call(name, args)])),
        App: { addListener: async () => ({ remove() {} }), getLaunchUrl: async () => null }, SystemBars: { setStyle: async () => {} }
      } };
    }, { native });
    await context.routeWebSocket('**/*', socket => socket.close());
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.pathname === '/magi2/chat') return route.fulfill({ contentType: 'text/event-stream', body: response(req.postDataJSON()) });
      if (url.pathname === '/magi2/react') {
        const body = req.postDataJSON(); reactions.push(body);
        if (body.op === 'remove') return route.fulfill({ json: { ok: true } });
        heldRating = route; return;
      }
      if (url.pathname === '/magi2/models') return route.fulfill({ json: { features: { speech: false } } });
      if (url.pathname === '/magi2/usage') return route.fulfill({ json: { used: 0, limit: 60 } });
      if (url.pathname.endsWith('/releases/latest')) return route.fulfill({ json: { tag_name: 'v7.02' } });
      if (url.origin === 'https://tk.st') {
        const file = resolve(root, '.' + (url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname));
        if (file.startsWith(root + sep) && existsSync(file) && extname(file)) return route.fulfill({ body: readFileSync(file),
          contentType: ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' })[extname(file)] || 'application/octet-stream' });
      }
      return route.abort();
    });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    async function ready() { await page.waitForFunction(native => typeof agentSend === 'function' && !agentBusy && (!native || nativeHistory?.active && nativeConversation && !historyLoading), native); }
    async function send(text) {
      const count = requests.length;
      await page.locator('#agent-input').fill(text); await page.locator('#agent-send').click();
      await page.waitForFunction(() => !agentBusy && !agentPrivacyState.preparing && agentHistory.at(-1)?.role === 'assistant');
      assert.equal(requests.length, count + 1);
      if (native) await page.evaluate(() => nativeHistory.flush());
    }
    async function reset() { await page.evaluate(() => { syncCurrentToSaved(); resetAgent(); }); }
    async function holdImages() {
      await page.evaluate(() => {
        window.reviewReads = [];
        const read = FileReader.prototype.readAsDataURL;
        FileReader.prototype.readAsDataURL = function (file) { reviewReads.push(() => read.call(this, file)); };
        window.releaseDecode = () => { FileReader.prototype.readAsDataURL = read; reviewReads.splice(0).forEach(start => start()); };
      });
    }
    async function beginRating() {
      heldRating = null;
      await page.locator('.agent-reply [data-act="rate"]').last().click(); await page.locator('.rate-pop [data-rate="good"]').click();
      const deadline = Date.now() + 5000;
      while (!heldRating && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
      assert(heldRating, '評価登録が始まっていない');
    }
    async function finishRating() {
      const id = ++receiptId, token = String(id).padStart(64, 'a');
      await heldRating.fulfill({ json: { id, delete_token: token } });
      await page.waitForFunction(() => reactionRegistrations.size === 0);
      if (native) await page.evaluate(() => nativeHistory.flush());
      return { id, token };
    }
    await page.goto('https://tk.st/' + (surface === 'web' ? '' : 'magi-app/www/'));
    if (surface === 'web' && await page.locator('#agentdock').evaluate(el => el.classList.contains('collapsed'))) await page.locator('[data-act="agent"]').click();
    await ready();
    await send('LONG-QUESTION'); assert.equal(await page.locator('.agent-reply-body').last().innerText(), longReply);
    await send('CONTINUATION'); assert.equal(requests.at(-1).messages.find(m => m.role === 'assistant').content.length, 3999);
    await page.reload(); await ready(); assert.equal(await page.locator('.agent-reply-body').first().innerText(), longReply);
    results.push(surface + '/long-reply-continues-and-full-text-survives');

    await reset();
    await holdImages();
    await page.evaluate(base64 => {
      window.reviewFile = new File([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], 'review.png', { type: 'image/png' });
      window.addingImages = addAttachments([reviewFile]);
    }, image);
    await page.waitForFunction(() => agentPrivacyState.attachmentJobs === 1);
    const beforeImage = requests.length;
    await page.locator('#agent-input').fill('IMAGE-QUESTION');
    assert.equal(await page.locator('#agent-send').isDisabled(), true);
    await page.evaluate(() => agentSend()); // Enter等の入口も同じガードを通す。
    assert.equal(requests.length, beforeImage); assert.equal(await page.locator('#agent-input').inputValue(), 'IMAGE-QUESTION');
    await page.evaluate(async () => { releaseDecode(); await addingImages; });
    assert.equal(await page.locator('#agent-send').isEnabled(), true);
    await send('IMAGE-QUESTION'); assert.equal(requests.at(-1).messages.at(-1).content.filter(p => p.type === 'image_url').length, 1);
    assert.equal(await page.evaluate(() => attachments.length), 0);
    results.push(surface + '/image-preparation-blocks-every-send-entry');

    await reset();
    await holdImages();
    await page.evaluate(() => {
      window.addingImages = addAttachments([reviewFile]); resetAgent();
    });
    await page.evaluate(async () => { releaseDecode(); await addingImages; });
    assert.equal(await page.evaluate(() => attachments.length), 0);
    results.push(surface + '/navigation-discards-obsolete-image');

    await page.evaluate(() => addAttachments([reviewFile, reviewFile, reviewFile]));
    await holdImages();
    await page.evaluate(async () => {
      const left = addAttachments([reviewFile]), right = addAttachments([reviewFile]);
      releaseDecode(); await Promise.all([left, right]);
    });
    assert.equal(await page.evaluate(() => attachments.length), 4);
    results.push(surface + '/concurrent-image-inputs-keep-four-image-limit');

    await reset(); await send('RATE-THEN-NAVIGATE'); const owner = await page.evaluate(() => currentSessionId);
    await beginRating(); await reset(); await send('OTHER-CHAT'); const other = await page.evaluate(() => currentSessionId);
    const firstReceipt = await finishRating();
    assert.equal(await page.evaluate(() => agentHistory.at(-1).reactions.integrated), undefined);
    assert.equal(await page.evaluate(() => currentSessionId), other);
    await page.evaluate(id => loadSavedSession(id), owner);
    await page.reload(); await ready();
    assert.equal(await page.evaluate(() => agentHistory.at(-1).reactions.integrated.delete_token), firstReceipt.token);
    await page.locator('.agent-reply [data-act="rate"]').last().click(); await page.locator('.rate-pop [data-rate="good"]').click();
    await page.waitForFunction(() => !agentHistory.at(-1).reactions.integrated);
    assert.equal(reactions.at(-1).delete_token, firstReceipt.token); assert.equal(reactions.at(-1).op, 'remove');
    results.push(surface + '/late-rating-stays-with-owner-and-removes-after-reload');

    await beginRating(); await reset(); await page.evaluate(id => loadSavedSession(id), owner);
    await page.locator('.agent-reply [data-act="rate"]').last().click(); await page.locator('.rate-pop [data-rate="good"]').click();
    const secondReceipt = await finishRating();
    await page.waitForFunction(() => !agentHistory.at(-1).reactions.integrated);
    assert.equal(reactions.at(-1).delete_token, secondReceipt.token);
    results.push(surface + '/reopened-pending-rating-waits-for-delete-token');

    await beginRating(); await page.evaluate(() => toggleAgentTemporary());
    const temporaryId = await page.evaluate(() => currentSessionId), temporaryReceipt = await finishRating();
    assert.equal(await page.evaluate(() => currentSessionId), temporaryId);
    assert.equal(await page.evaluate(() => agentHistory.length), 0);
    await page.evaluate(() => toggleAgentTemporary());
    assert.equal(await page.evaluate(() => agentHistory.at(-1).reactions.integrated.delete_token), temporaryReceipt.token);
    await page.locator('.agent-reply [data-act="rate"]').last().click(); await page.locator('.rate-pop [data-rate="good"]').click();
    await page.waitForFunction(() => !agentHistory.at(-1).reactions.integrated);
    assert.equal(reactions.at(-1).delete_token, temporaryReceipt.token);
    results.push(surface + '/temporary-chat-keeps-normal-rating-owner');

    await beginRating();
    await page.locator('.agent-reply [data-act="rate"]').last().click(); await page.locator('.rate-pop [data-rate="bad"]').click();
    const beforeReplacement = reactions.length;
    await reset(); await send('LEAVE-WHILE-CHANGING-RATING');
    const replacedReceipt = await finishRating();
    await page.waitForTimeout(50);
    assert.equal(reactions.length, beforeReplacement + 1); // 旧評価の削除だけ。移動先から新規登録しない。
    assert.equal(reactions.at(-1).delete_token, replacedReceipt.token);
    assert.equal(await page.evaluate(() => agentHistory.at(-1).reactions.integrated), undefined);
    results.push(surface + '/navigation-during-rating-change-does-not-register-from-new-chat');

    await page.evaluate(id => loadSavedSession(id), owner);
    await beginRating(); await page.evaluate(id => deleteSavedSession(id), owner);
    const deletedReceipt = await finishRating();
    assert.equal(reactions.at(-1).op, 'remove'); assert.equal(reactions.at(-1).delete_token, deletedReceipt.token);
    assert.equal(await page.evaluate(id => agentStoredSessions().some(s => s.id === id), owner), false);
    results.push(surface + '/deleted-owner-is-not-resurrected');
    assert.deepEqual(errors, []); await context.close();
  }
  const output = resolve(root, 'workers/.wrangler/magi-chat-gate/review-browser.json'); mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify({ pass: true, results, paidRequests: 0 }, null, 2) + '\n');
  console.log(JSON.stringify({ pass: true, cases: results.length, paidRequests: 0 }));
} finally { await browser.close(); }
