// B0の画面を固定のネイティブ橋渡しで確認する。実機のinsets・戻る・AI完了の代わりにはしない。
// 全要求をローカルのファイルか固定応答に差し替え、有料API・計測への実通信は行わない。
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = resolve(root, 'workers/.wrangler/magi-b0-browser');
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const report = [];
try {
  for (const native of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    const errors = [], posts = [];
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (req.method() === 'POST') posts.push(url.pathname);
      if (url.origin === 'https://tk.st' && url.pathname.startsWith('/magi-app/www/')) {
        const name = url.pathname.slice('/magi-app/www/'.length) || 'index.html';
        if (!/^[a-z0-9.-]+$/.test(name)) return route.abort();
        const contentType = name.endsWith('.html') ? 'text/html' : name.endsWith('.js') ? 'text/javascript' : name.endsWith('.png') ? 'image/png' : 'application/json';
        return route.fulfill({ body: readFileSync(resolve(root, 'magi-app/www', name)), contentType });
      }
      if (url.pathname === '/magi2/models') return route.fulfill({ json: {} });
      if (url.pathname.endsWith('/releases/latest')) return route.fulfill({ json: { tag_name: 'v5.2', draft: false, prerelease: false } });
      if (url.pathname === '/magi2/versions') return route.fulfill({ body: readFileSync(resolve(root, 'data/magi-versions.json')), contentType: 'application/json' });
      return route.abort();
    });
    await context.addInitScript(({ native }) => {
      window.shellCalls = [];
      // 実際のAndroidはregisterPluginではなくPluginsと同期addListenerを注入する。
      if (native) window.Capacitor = {
        isNativePlatform: () => true, getPlatform: () => 'android',
        Plugins: {
          App: { addListener(name, callback) { window.nativeBack = callback; return { remove: async () => {} }; }, exitApp: async () => { window.shellCalls.push('exit'); } },
          SystemBars: { setStyle: async options => { window.shellCalls.push(options.style); } },
        },
      };
      localStorage.setItem('magi_saved_sessions', JSON.stringify([{ id: 'b0-fixture', title: 'B0 saved chat', timestamp: '2026-10-17T00:00:00Z',
        history: [{ role: 'user', content: 'Saved question' }, { role: 'assistant', content: 'Saved answer' }] }]));
    }, { native });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('https://tk.st/magi-app/www/');
    await page.locator('#btn-versions-agent').waitFor();
    if (native) {
      await page.evaluate(() => {
        const style = document.documentElement.style;
        style.setProperty('--safe-area-inset-top', '24px');
        style.setProperty('--safe-area-inset-bottom', '24px');
      });
    }
    await page.locator('#agent-input').fill('Unsent draft');
    await page.locator('#btn-history-agent').click();
    assert.match(await page.locator('#agent-history-panel').innerText(), /B0 saved chat/);
    if (native) await page.evaluate(() => window.nativeBack({ canGoBack: false }));
    else await page.locator('.agent-panel-close').click();
    assert.equal(await page.locator('.agent-panel').count(), 0);
    assert.equal(await page.locator('#agent-input').inputValue(), 'Unsent draft');
    await page.locator('#btn-history-agent').click();
    await page.locator('.session-load').click();
    assert.match(await page.locator('#agent-log').innerText(), /Saved answer/);
    await page.locator('#btn-theme').click();
    if (native) {
      await page.waitForFunction(() => window.shellCalls.at(-1) === (document.documentElement.dataset.theme === 'dark' ? 'DARK' : 'LIGHT'));
      await page.locator('#btn-more-agent').click();
      await page.evaluate(() => window.nativeBack({ canGoBack: false }));
      assert.match(await page.locator('#agent-more-dropdown').getAttribute('class'), /hidden/);
    }
    for (const { width, height, bottom } of [{ width: 390, height: 844, bottom: 24 }, { width: 390, height: 430, bottom: 24 },
      ...(native ? [{ width: 780, height: 136, bottom: 0 }] : [])]) {
      if (native) await page.evaluate(bottom => document.documentElement.style.setProperty('--safe-area-inset-bottom', bottom + 'px'), bottom);
      await page.setViewportSize({ width, height });
      const bounds = await page.evaluate(() => {
        const header = document.querySelector('#bar').getBoundingClientRect();
        const input = document.querySelector('#agent-input').getBoundingClientRect();
        return { top: header.top, inputTop: input.top, inputBottom: input.bottom, height: innerHeight };
      });
      assert.ok(bounds.top >= 0 && bounds.inputTop > 0 && bounds.inputBottom <= bounds.height - (native ? bottom : 0), JSON.stringify(bounds));
      await page.screenshot({ path: resolve(out, `${native ? 'android-mock' : 'pwa'}-${height}.png`) });
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(posts, []);
    if (!native) assert.deepEqual(await page.evaluate(() => window.shellCalls), []);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('magi_saved_sessions')).length), 1);
    report.push({ nativeMock: native, savedChat: true, unsentDraft: true, insets: true, pageErrors: errors, aiPosts: posts.length });
    await context.close();
  }
  writeFileSync(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally { await browser.close(); }
