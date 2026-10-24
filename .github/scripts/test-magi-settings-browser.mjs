import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { chromium } from 'playwright';
const root = process.cwd();
const out = resolve(root, 'workers/.wrangler/magi-settings-browser'); mkdirSync(out, { recursive: true });
async function assertFocused(locator) { assert.equal(await locator.evaluate(el => document.activeElement === el), true); }
const browser = await chromium.launch({ headless: true });
try {
  for (const [mobile, width] of [[true, 320], [true, 360], [true, 390], [false, 360], [false, 1600]]) {
    const context = await browser.newContext({ viewport: { width, height: 850 } });
    await context.addInitScript(() => {
      localStorage.setItem('lang', 'ja');
      window.bugUrls = new Set();
      const originalFetch = window.fetch;
      window.fetch = function(url, options) { if(String(url).includes('/bug-report')) window.bugSignal = options.signal; return originalFetch.apply(this,arguments); };
      const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = value => { const url = create(value); bugUrls.add(url); return url; };
      URL.revokeObjectURL = url => { bugUrls.delete(url); revoke(url); };
    });
    let requests = [], status = 503, omitImageAck = false, deferReply = false;
    await context.route('**/*', async route => {
      const req = route.request(), u = new URL(req.url());
      if (u.pathname === '/magi2/bug-report') {
        const payload = JSON.parse(req.postData()); requests.push(payload);
        if (deferReply) await new Promise(resolve=>setTimeout(resolve,250));
        return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(status === 200 ? { ok: true, ...(omitImageAck ? {} : { images: payload.images?.length || 0 }) } : { error: { code: 'report_failed' } }) });
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
    if (!mobile && await page.locator('#agentdock').evaluate(e => innerWidth < 768 ? !e.classList.contains('open') : e.classList.contains('collapsed'))) await page.locator('[data-act="agent"]').click();
    await page.locator('#btn-more-agent').click();
    await page.screenshot({ path: resolve(out, mobile ? 'app-menu.png' : 'web-menu.png') });
    await page.locator('#btn-bug-report-agent').click();
    const input = page.locator('#agent-bug-message');
    const send = page.locator('#agent-bug-form [type="submit"]');
    const layout = await input.evaluate(e => {
      const r = e.getBoundingClientRect(), form = e.form.getBoundingClientRect();
      return { left: r.left, right: r.right, viewport: innerWidth, form: form.width, scroll: e.form.scrollWidth, client: e.form.clientWidth };
    });
    assert.ok(layout.left >= 0 && layout.right <= layout.viewport, JSON.stringify(layout));
    assert.ok(layout.scroll <= layout.client + 1, JSON.stringify(layout));
    assert.match(await page.locator('#agent-bug-note').innerText(), /^(Do not include passwords or other sensitive information\.|パスワードなどの機密情報は入力しないでください。)$/);
    assert.equal(await page.locator('#btn-bug-report-agent svg rect').count(), 1);

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
    assert.deepEqual(Object.keys(requests[0]), ['message', 'report_id']);
    assert.equal(requests[1].message, 'テストの報告です。');
    const imageBytes = Buffer.from(await page.evaluate(() => {
      const c=document.createElement('canvas');c.width=c.height=20;c.getContext('2d').fillRect(0,0,20,20);return c.toDataURL('image/png').split(',')[1];
    }), 'base64');
    const picker = page.locator('#agent-bug-files');
    const image = name => ({ name, mimeType: 'image/png', buffer: imageBytes });
    await picker.setInputFiles([image('画面の状態.png'), image('比較.png')]);
    await page.waitForFunction(() => document.querySelectorAll('#agent-bug-images li').length === 2);
    await page.locator('#agent-bug-images button').first().click();
    assert.equal(await page.locator('#agent-bug-images li').count(), 1);
    await picker.setInputFiles([image('追加1.png'),image('追加2.png'),image('追加3.png')]);
    await page.waitForFunction(() => /Could not attach|添付できません/.test(document.querySelector('#agent-bug-status').textContent));
    assert.equal(await page.locator('#agent-bug-images li').count(),1);
    await picker.setInputFiles({ name:'fake.png',mimeType:'image/png',buffer:Buffer.from('<svg></svg>') });
    await page.waitForFunction(() => !document.querySelector('#agent-bug-attach').disabled);
    assert.equal(await page.locator('#agent-bug-images li').count(),1);
    await picker.setInputFiles({ name:'broken.png',mimeType:'image/png',buffer:Buffer.from('89504e470d0a1a0a00000000','hex') });
    await page.waitForFunction(() => !document.querySelector('#agent-bug-attach').disabled);
    assert.equal(await page.evaluate(()=>bugUrls.size),1,'プレビュー失敗のURLを解放する');
    await picker.setInputFiles({ name:'large.png',mimeType:'image/png',buffer:Buffer.alloc(5*1048576+1) });
    await page.waitForFunction(() => !document.querySelector('#agent-bug-attach').disabled);
    assert.equal(await page.locator('#agent-bug-images li').count(),1);
    await input.fill('画像を添付した報告');status=503;
    await send.click();
    await page.waitForFunction(() => /Could not send|送信できません/.test(document.querySelector('#agent-bug-status').textContent));
    assert.equal(await page.locator('#agent-bug-images li').count(),1);
    const rowLayout=await page.locator('#agent-bug-images').evaluate(e=>({scroll:e.scrollWidth,client:e.clientWidth}));assert(rowLayout.scroll<=rowLayout.client+1);
    await page.screenshot({path:resolve(out,`${mobile?'app':'web'}-images-${width}.png`)});
    status=200; omitImageAck=true; await send.click();
    await page.waitForFunction(() => /Could not send|送信できません/.test(document.querySelector('#agent-bug-status').textContent));
    assert.equal(await page.locator('#agent-bug-images li').count(),1,'旧Workerの応答では添付済みと扱わない');
    omitImageAck=false; await send.click();
    await page.waitForFunction(() => document.querySelector('#agent-bug-message').value === '');
    assert.equal(requests[2].images[0].content,imageBytes.toString('base64'));
    assert.equal(requests[2].report_id,requests[3].report_id,'再試行で同じ報告IDを使う');
    assert.equal(requests[2].report_id,requests[4].report_id);
    assert.equal(await page.locator('#agent-bug-images li').count(),0);
    assert.equal(await page.evaluate(()=>bugUrls.size),0);
    // 無効な送信ボタンを飛ばし、情報画面の先頭・末尾でTabを循環させる。
    await input.focus();
    await page.keyboard.press('Tab');
    await assertFocused(page.locator('#agent-bug-attach'));
    await page.keyboard.press('Tab');
    await assertFocused(page.locator('#agent-bug-report-panel .agent-page-back'));
    await page.keyboard.press('Shift+Tab');
    await assertFocused(page.locator('#agent-bug-attach'));
    await picker.setInputFiles(image('閉じる前.png'));
    await page.waitForFunction(()=>document.querySelectorAll('#agent-bug-images li').length===1);
    await input.fill('閉じる間の送信'); deferReply=true; await send.click();
    await page.waitForFunction(()=>!!window.bugSignal);
    await page.locator('#agent-bug-report-panel .agent-page-back').click();
    assert.equal(await page.evaluate(()=>bugSignal.aborted),true,'閉じると送信を中止する');
    assert.equal(await page.evaluate(()=>bugUrls.size),0);
    assert.equal(await page.locator('#agent-bug-report-panel').count(), 0);
    await page.locator('#btn-more-agent').click();
    await page.locator('#btn-about-agent').click();
    const aboutBack = page.locator('#agent-about-panel .agent-page-back');
    await page.locator('[data-about="faq"]').click();
    assert.equal(await page.locator('#agent-faq-panel details').count(), 12);
    await page.locator('#agent-faq-panel .agent-page-back').click();

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
    console.log((mobile ? 'app' : 'web') + ' ' + width + ': passed');
  }
} finally { await browser.close(); }
