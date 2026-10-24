// 合成SSEだけで、両画面の非保存・設定・切替を確認する。外部APIは呼ばない。
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd(), out = resolve(root, 'workers/.wrangler/magi-privacy-browser');
mkdirSync(out, { recursive: true });
const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const language = { version: 1, code: 'ja', source: 'ui' };
const browser = await chromium.launch({ headless: true });
try {
  for (const mobile of [true, false]) {
    const context = await browser.newContext({ viewport: { width: mobile ? 390 : 1600, height: 900 } });
    await context.addInitScript(() => {
      localStorage.setItem('lang', 'ja'); sessionStorage.setItem('magi_transport', 'sse');
      const history = [{ role: 'user', content: 'NORMAL-A' }, { role: 'assistant', content: 'NORMAL-REPLY', mode: 'fact' }];
      const row = { id: 'session_A', title: 'NORMAL-TITLE', timestamp: 1, history };
      localStorage.setItem('magi_current_history', JSON.stringify(history)); localStorage.setItem('magi_current_session_id', row.id);
      localStorage.setItem('magi_current_title', row.title); localStorage.setItem('magi_saved_sessions', JSON.stringify([row]));
      window.privacyWrites = []; window.copied = [];
      const set = Storage.prototype.setItem, remove = Storage.prototype.removeItem, get = Storage.prototype.getItem;
      Storage.prototype.getItem = function (key) {
        if (key === 'magi_personalization_v1' && window.failPersonalizationRead) throw new DOMException('Synthetic denied read', 'SecurityError');
        return get.call(this, key);
      };
      Storage.prototype.setItem = function (key, value) {
        window.privacyWrites.push([key, value]);
        if (key === 'magi_personalization_v1' && window.failPersonalization) throw new DOMException('Synthetic quota', 'QuotaExceededError');
        return set.call(this, key, value);
      };
      Storage.prototype.removeItem = function (key) { window.privacyWrites.push([key, null]); return remove.call(this, key); };
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => window.copied.push(text) } });
      // 音声サービスとOS再生を模擬し、画面からのv2要求までを確認する。
      window.Audio = class extends EventTarget {
        play() { setTimeout(() => this.dispatchEvent(new Event('ended')), 10); return Promise.resolve(); }
        pause() {}
        removeAttribute() {}
      };
    });
    const requests = [], speechRequests = [], pageErrors = []; let featureStatus = 200, badSession = false;
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname === '/magi2/models') return route.fulfill({ status: featureStatus, json: { features: { privacy_contract: 1, temporary_chat: true, personalization: true, temporary_speech: true, speech: true } } });
      if (url.pathname === '/magi2/speech') {
        speechRequests.push(JSON.parse(request.postData()));
        return route.fulfill({ contentType: 'audio/mpeg', headers: { 'X-Speech-Parts': '1', 'Cache-Control': 'no-store' }, body: Buffer.from([0]) });
      }
      if (url.pathname === '/magi2/usage') return route.fulfill({ json: { used: 0, limit: 60 } });
      if (url.pathname === '/magi2/chat') {
        const body = JSON.parse(request.postData()); requests.push(body);
        let stream = body.privacy_contract ? event('session', { conversation_mode: badSession ? 'wrong' : body.conversation_mode, personalization_applied: !!(body.personalization && (body.personalization.preferred_name || body.personalization.custom_instructions)) }) : '';
        stream += event('classification', { version: 1, intent: 'research', mode: 'fact', fresh: 'no', votable: 'no', site_pages: 'no', magi_candidate: false, reply_language: language });
        stream += event('integrated', { delta: body.conversation_mode === 'temporary' ? 'TEMPORARY-ANSWER' : 'NORMAL-ANSWER' });
        stream += event('speech', { sig: 'a'.repeat(64), lang: 'ja', ...(body.privacy_contract ? { sig_version: 2, conversation_mode: body.conversation_mode } : {}) });
        stream += event('done', { request_id: 'synthetic' });
        return route.fulfill({ contentType: 'text/event-stream', body: stream });
      }
      if (url.pathname === '/magi2/react') throw new Error('temporary reaction must not be sent');
      if (url.hostname === 'tk.st') {
        const file = resolve(root, '.' + (url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname));
        if (file.startsWith(root + sep) && existsSync(file) && extname(file)) return route.fulfill({ body: readFileSync(file), contentType: ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' })[extname(file)] || 'application/octet-stream' });
      }
      return route.abort();
    });
    const page = await context.newPage(); page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto('https://tk.st/' + (mobile ? 'magi-app/www/' : ''));
    if (!mobile && await page.locator('#agentdock').evaluate(el => el.classList.contains('collapsed'))) await page.locator('[data-act="agent"]').click();
    await page.locator('#btn-temporary-agent').waitFor();
    await page.locator('#btn-more-agent').click(); await page.locator('#btn-personalization-agent').click();
    await page.locator('#personal-enabled').check(); await page.locator('#personal-name').fill('合成さん'); await page.locator('#personal-instructions').fill('SYNTHETIC-CUSTOM');
    await page.locator('.agent-personalization-form button[type="submit"]').click();
    assert.equal(await page.locator('#agent-personalization-panel').count(), 0);
    async function send(text) {
      await page.locator('#agent-input').fill(text); await page.locator('#agent-send').click();
      await page.waitForFunction(() => document.querySelector('#agent-log').textContent.includes('ANSWER') && !document.querySelector('#btn-temporary-agent').disabled);
    }
    await send('NORMAL-QUESTION');
    assert.equal(requests.at(-1).personalization.preferred_name, '合成さん');
    const normalStorage = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(k => /^magi_current_|magi_saved_sessions$/.test(k)).map(k => [k, localStorage.getItem(k)])));
    await page.locator('#agent-input').fill('NORMAL-DRAFT');
    await page.evaluate(() => { window.privacyWrites = []; });
    await page.locator('#btn-temporary-agent').click();
    await page.waitForFunction(() => document.querySelector('#btn-temporary-agent').getAttribute('aria-pressed') === 'true');
    assert.equal(await page.locator('#agent-log').innerText().then(t => t.includes('NORMAL-A')), false);
    await send('TEMPORARY-QUESTION');
    assert.equal(requests.at(-1).conversation_mode, 'temporary'); assert.equal('personalization' in requests.at(-1), false);
    assert.equal(JSON.stringify(requests.at(-1)).includes('NORMAL-'), false);
    assert.equal(await page.locator('#agent-log [data-act="rate"]').count(), 0);
    assert.equal(await page.locator('#agent-log [data-act="share"]').count(), 0);
    await page.locator('#agent-log .reply-bar [data-act="copy"]').last().click();
    assert.equal(await page.evaluate(() => window.copied.at(-1)), 'TEMPORARY-ANSWER');
    await page.locator('#agent-log .reply-bar [data-act="speak"]').last().click();
    await page.waitForFunction(() => document.querySelector('#agent-log [data-act="speak"]').dataset.state === 'idle');
    assert.equal(speechRequests.at(-1).conversation_mode, 'temporary');
    assert.equal(speechRequests.at(-1).sig_version, 2);
    assert.equal(speechRequests.at(-1).lang, 'ja');
    await page.locator('#agent-log .reply-bar [data-act="retry"]').last().click();
    await page.waitForFunction(() => Array.from(document.querySelectorAll('#agent-log .agent-turn')).filter(el => !el.hidden).length === 1);
    await page.waitForFunction(() => !document.querySelector('#btn-temporary-agent').disabled);
    await page.waitForTimeout(250);
    assert.equal(requests.at(-1).conversation_mode, 'temporary'); assert.equal('personalization' in requests.at(-1), false);
    assert.deepEqual(await page.evaluate(() => window.privacyWrites.filter(([key]) => /^magi_current_|magi_saved_sessions$/.test(key))), []);
    await page.screenshot({ path: resolve(out, mobile ? 'app-temporary.png' : 'web-temporary.png') });
    await page.locator('#btn-temporary-agent').click();
    await page.waitForFunction(() => document.querySelector('#btn-temporary-agent').getAttribute('aria-pressed') === 'false');
    assert.equal(await page.locator('#agent-input').inputValue(), 'NORMAL-DRAFT');
    assert.equal(await page.locator('#agent-log').innerText().then(t => t.includes('NORMAL-A')), true);
    assert.deepEqual(await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(k => /^magi_current_|magi_saved_sessions$/.test(k)).map(k => [k, localStorage.getItem(k)]))), normalStorage);
    // BFCacheから戻る場合も、一時のDOMや会話IDを復活させない。
    await page.locator('#btn-temporary-agent').click(); await send('TEMPORARY-BFCACHE');
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    assert.equal(await page.locator('#btn-temporary-agent').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('#agent-log').innerText().then(t => t.includes('TEMPORARY-')), false);
    assert.equal(await page.locator('#agent-log').innerText().then(t => t.includes('NORMAL-A')), true);
    assert.deepEqual(await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(k => /^magi_current_|magi_saved_sessions$/.test(k)).map(k => [k, localStorage.getItem(k)]))), normalStorage);
    featureStatus = 503; const beforeRequests = requests.length;
    await page.locator('#agent-input').fill('KEEP-DRAFT'); await page.locator('#agent-send').click();
    await page.waitForTimeout(150);
    assert.equal(requests.length, beforeRequests); assert.equal(await page.locator('#agent-input').inputValue(), 'KEEP-DRAFT');
    featureStatus = 200;
    // 設定の容量不足で既存履歴を減らさず、入力した設定も保持する。
    const beforeSettings = await page.evaluate(() => localStorage.getItem('magi_personalization_v1'));
    await page.evaluate(() => { window.failPersonalization = true; });
    await page.locator('#btn-more-agent').click(); await page.locator('#btn-personalization-agent').click();
    await page.locator('#personal-name').fill('保存に失敗する呼称'); await page.locator('.agent-personalization-form button[type="submit"]').click();
    assert.equal(await page.locator('#personal-name').inputValue(), '保存に失敗する呼称');
    assert.equal(await page.evaluate(() => localStorage.getItem('magi_personalization_v1')), beforeSettings);
    assert.deepEqual(await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(k => /^magi_current_|magi_saved_sessions$/.test(k)).map(k => [k, localStorage.getItem(k)]))), normalStorage);
    await page.locator('[data-personal="cancel"]').click(); await page.evaluate(() => { window.failPersonalization = false; });
    // 保存済み設定が読めない場合は送信も初期オフへの置換も行わない。
    const beforeReadFailure = requests.length;
    await page.evaluate(() => { window.failPersonalizationRead = true; });
    await page.locator('#agent-input').fill('KEEP-READ-FAILURE'); await page.locator('#agent-send').click();
    await page.waitForFunction(() => /Could not read personalization|設定を読み込めないため送信しませんでした/.test(document.getElementById('agent-status').textContent));
    assert.equal(requests.length, beforeReadFailure);
    assert.equal(await page.locator('#agent-input').inputValue(), 'KEEP-READ-FAILURE');
    await page.locator('#btn-more-agent').click(); await page.locator('#btn-personalization-agent').click();
    assert.equal(await page.locator('#agent-personalization-panel').count(), 0);
    await page.evaluate(() => { window.failPersonalizationRead = false; });
    assert.equal(await page.evaluate(() => localStorage.getItem('magi_personalization_v1')), beforeSettings);
    // 編集途中に読み込み不能になってもフォームの入力と旧設定を残す。
    await page.locator('#btn-more-agent').click(); await page.locator('#btn-personalization-agent').click();
    await page.locator('#personal-name').fill('READ-FAILURE-DRAFT');
    await page.evaluate(() => { window.failPersonalizationRead = true; });
    await page.locator('.agent-personalization-form button[type="submit"]').click();
    assert.equal(await page.locator('#personal-name').inputValue(), 'READ-FAILURE-DRAFT');
    assert.match(await page.locator('#personal-status').innerText(), /Could not save settings|設定を保存できません/);
    await page.locator('[data-personal="cancel"]').click();
    await page.evaluate(() => { window.failPersonalizationRead = false; });
    await send('READ-RECOVERED');
    assert.equal(requests.at(-1).personalization.preferred_name, '合成さん');
    // 同じ保存領域の別タブで通常Aを削除しても、一時解除で復活させない。
    await page.locator('#btn-temporary-agent').click();
    await page.waitForFunction(() => document.querySelector('#btn-temporary-agent').getAttribute('aria-pressed') === 'true');
    const other = await context.newPage(); await other.goto('https://tk.st/magi-app/www/');
    await other.evaluate(() => localStorage.setItem('magi_saved_sessions', '[]'));
    await page.waitForTimeout(50); await page.locator('#btn-temporary-agent').click();
    await page.waitForFunction(() => document.querySelector('#btn-temporary-agent').getAttribute('aria-pressed') === 'false');
    assert.equal(await page.locator('#agent-log').innerText().then(t => t.includes('NORMAL-A')), false);
    assert.equal(await page.evaluate(() => localStorage.getItem('magi_current_history')), null);
    await other.close();
    // 不一致のsessionは回答本文を表示しない。
    await page.locator('#btn-temporary-agent').click(); badSession = true;
    await page.locator('#agent-input').fill('REJECT-MISMATCH'); await page.locator('#agent-send').click();
    await page.waitForFunction(() => !document.querySelector('#btn-temporary-agent').disabled);
    assert.equal(await page.locator('#agent-log').innerText().then(t => t.includes('TEMPORARY-ANSWER')), false);
    badSession = false;
    await page.reload();
    await page.locator('#btn-temporary-agent').waitFor();
    assert.equal(await page.locator('#btn-temporary-agent').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('#agent-log').innerText().then(t => t.includes('TEMPORARY-QUESTION')), false);
    // 履歴選択と新規作成も、解除ボタンと同じく一時の内容を破棄する。
    await page.locator('#btn-temporary-agent').click(); await send('TEMPORARY-HISTORY-SWITCH');
    await page.locator('#btn-history-agent').click();
    await page.locator(mobile ? '.session-load[data-id="session_A"]' : '.btn-load-session[data-id="session_A"]').click();
    assert.equal(await page.locator('#btn-temporary-agent').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('#agent-log').innerText().then(t => t.includes('NORMAL-A')), true);
    assert.equal(await page.locator('#agent-log').innerText().then(t => t.includes('TEMPORARY-HISTORY-SWITCH')), false);
    await page.locator('#btn-temporary-agent').click(); await send('TEMPORARY-NEW-CHAT');
    if (mobile) { await page.locator('#btn-history-agent').click(); await page.locator('#btn-reset').click(); }
    else await page.locator('#btn-reset-agent').click();
    assert.equal(await page.locator('#btn-temporary-agent').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('#agent-log').innerText().then(t => /TEMPORARY-NEW-CHAT|NORMAL-A/.test(t)), false);
    assert.equal(await page.locator('#agent-input').inputValue(), '');
    assert.deepEqual(pageErrors, []);
    console.log(`${mobile ? 'app' : 'home'}: settings, isolation, copy/speech/retry, no persistence, restore, unsupported feature, storage write/read failure, deletion, contract mismatch, reload, history switch/new chat PASS`);
    await context.close();
  }
} finally { await browser.close(); }
