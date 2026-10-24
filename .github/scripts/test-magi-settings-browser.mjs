import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { chromium } from 'playwright';
const root = process.cwd();
const out = resolve(root, 'workers/.wrangler/magi-settings-browser'); mkdirSync(out, { recursive: true });
async function assertFocused(locator) { assert.equal(await locator.evaluate(el => document.activeElement === el), true); }
const browser = await chromium.launch({ headless: true });
try {
  for (const mobile of [true, false]) {
    const context = await browser.newContext({ viewport: { width: mobile ? 390 : 1600, height: 850 } });
    await context.addInitScript(() => localStorage.setItem('lang', 'ja'));
    let requests = [], status = 503;
    await context.route('**/*', async route => {
      const req = route.request(), u = new URL(req.url());
      if (u.pathname === '/magi2/bug-report') {
        requests.push(JSON.parse(req.postData()));
        return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(status === 200 ? { ok: true } : { error: { code: 'report_failed' } }) });
      }
      if (u.hostname === 'tk.st') {
        const name = u.pathname.endsWith('/') ? u.pathname + 'index.html' : u.pathname;
        const path = resolve(root, '.' + name);
        if (path.startsWith(root) && existsSync(path) && extname(path)) {
          const type = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png' }[extname(path)] || 'application/octet-stream';
          return route.fulfill({ body: readFileSync(path), contentType: type });
        }
      }
      if (u.pathname === '/magi2/usage') return route.fulfill({ json: { used: 0, limit: 60 } });
      return route.abort();
    });
    const page = await context.newPage();
    await page.goto('https://tk.st/' + (mobile ? 'magi-app/www/' : ''));
    if (!mobile && await page.locator('#agentdock').evaluate(e => e.classList.contains('collapsed'))) await page.locator('[data-act="agent"]').click();
    await page.locator('#btn-more-agent').click();
    await page.screenshot({ path: resolve(out, mobile ? 'app-menu.png' : 'web-menu.png') });
    await page.locator('#btn-bug-report-agent').click();
    const input = page.locator('#agent-bug-message');
    const send = page.locator('#agent-bug-form button');
    assert.equal(await send.isDisabled(), true);
    await input.fill('あ'.repeat(2001));
    assert.equal(Array.from(await input.inputValue()).length, 2000);
    await input.fill('😀'.repeat(2000));
    assert.equal(await page.locator('#agent-bug-count').innerText(), '2000 / 2000');
    await send.click();
    await page.waitForFunction(() => document.querySelector('#agent-bug-status').textContent.includes('Could not') || document.querySelector('#agent-bug-status').textContent.includes('できません'));
    assert.equal(Array.from(await input.inputValue()).length, 2000);
    status = 200;
    await input.fill('テストの報告です。');
    await page.screenshot({ path: resolve(out, mobile ? 'app-report.png' : 'web-report.png') });
    await send.click();
    await page.waitForFunction(() => document.querySelector('#agent-bug-message').value === '');
    assert.equal(requests.length, 2);
    assert.deepEqual(Object.keys(requests[0]), ['message']);
    assert.equal(requests[1].message, 'テストの報告です。');
    // 無効な送信ボタンを飛ばし、情報画面の先頭・末尾でTabを循環させる。
    await input.focus();
    await page.keyboard.press('Tab');
    await assertFocused(page.locator('#agent-bug-report-panel .agent-page-back'));
    await page.keyboard.press('Shift+Tab');
    await assertFocused(input);
    await page.locator('#agent-bug-report-panel .agent-page-back').click();
    assert.equal(await page.locator('#agent-bug-report-panel').count(), 0);
    await page.locator('#btn-more-agent').click();
    await page.locator('#btn-about-agent').click();
    const aboutBack = page.locator('#agent-about-panel .agent-page-back');
    const versionLink = page.locator('[data-about="version"]');
    await versionLink.focus();
    await page.keyboard.press('Tab');
    await assertFocused(aboutBack);
    await page.keyboard.press('Shift+Tab');
    await assertFocused(versionLink);
    await page.locator('[data-about="terms"]').click();
    const termsBack = page.locator('#agent-terms-panel .agent-page-back');
    for (const key of ['Tab', 'Tab', 'Shift+Tab', 'Shift+Tab']) {
      await page.keyboard.press(key); await assertFocused(termsBack);
    }
    await page.keyboard.press('Escape');
    await assertFocused(page.locator('[data-about="terms"]'));
    await versionLink.click();
    await page.locator('.agent-open-versions').click();
    const versionsBack = page.locator('#agent-versions-panel .agent-page-back');
    for (const key of ['Tab', 'Shift+Tab']) { await page.keyboard.press(key); await assertFocused(versionsBack); }
    await page.keyboard.press('Escape');
    await assertFocused(page.locator('.agent-open-versions'));
    await page.keyboard.press('Escape');
    await assertFocused(versionLink);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.agent-info-page').count(), 0);
    await assertFocused(page.locator('#btn-more-agent'));
    if (mobile) {
      await page.evaluate(async () => {
        nativeAndroid = true;
        nativeHistory = { active: true, usage: async () => 10 };
        let enabled = true;
        nativeConversation = { notificationState: async () => ({ enabled }), setNotifications: async value => { enabled = value; } };
        await showNativeSettings();
      });
      const location = page.locator('#native-location-toggle'), notifications = page.locator('#native-notification-toggle');
      await page.waitForFunction(() => !document.querySelector('#native-notification-toggle').disabled);
      assert.equal(await location.getAttribute('aria-checked'), 'true');
      await location.click();
      assert.equal(await page.evaluate(() => locationServiceEnabled()), false);
      await notifications.click();
      await page.waitForFunction(() => document.querySelector('#native-notification-toggle').getAttribute('aria-checked') === 'false');
      await page.waitForTimeout(200);
      await page.screenshot({ path: resolve(out, 'app-settings.png') });
      await page.locator('#agent-settings-panel .agent-page-back').click();
      await page.evaluate(() => showNativeSettings());
      assert.equal(await location.getAttribute('aria-checked'), 'false');
    }
    await context.close();
    console.log(mobile ? 'app: passed' : 'web: passed');
  }
} finally { await browser.close(); }
