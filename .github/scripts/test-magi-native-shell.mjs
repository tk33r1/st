// B0の画面を固定のネイティブ橋渡しで確認する。実機のinsets・戻る・AI完了の代わりにはしない。
// 全要求をローカルのファイルか固定応答に差し替え、有料API・計測への実通信は行わない。
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { nativeFilesystemFixture } from './magi-native-filesystem-fixture.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = resolve(root, 'workers/.wrangler/magi-b0-browser');
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const report = [];
try {
  for (const native of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-US', serviceWorkers: 'block' });
    const errors = [], posts = [];
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (req.method() === 'POST') posts.push(url.pathname);
      if (url.origin === 'https://tk.st' && url.pathname.startsWith('/magi-app/www/')) {
        const name = url.pathname.slice('/magi-app/www/'.length) || 'index.html';
        if (!/^(?:[a-z0-9.-]+|vendor\/Readability\.js)$/.test(name)) return route.abort();
        const contentType = name.endsWith('.html') ? 'text/html' : name.endsWith('.js') ? 'text/javascript' : name.endsWith('.png') ? 'image/png' : 'application/json';
        return route.fulfill({ body: readFileSync(resolve(root, 'magi-app/www', name)), contentType });
      }
      if (url.pathname === '/magi2/models') return route.fulfill({ json: {} });
      if (url.pathname.endsWith('/releases/latest')) return route.fulfill({ json: { tag_name: 'v5.2', draft: false, prerelease: false } });
      if (url.pathname === '/magi2/versions') return route.fulfill({ body: readFileSync(resolve(root, 'data/magi-versions.json')), contentType: 'application/json' });
      return route.abort();
    });
    await context.addInitScript('window.makeNativeFilesystemFixture = ' + nativeFilesystemFixture.toString());
    await context.addInitScript(({ native }) => {
      try { sessionStorage.setItem('magi_transport', 'sse'); } catch (_) {} // 既存の検証は SSE の経路を見る。WebSocket（読み上げ設計§6.3）は test-magi-ws-browser.mjs で確かめ、ここでは手元・本番のどちらへも開かない
      window.shellCalls = [];
      // 実際のAndroidはregisterPluginではなくPluginsと同期addListenerを注入する。
      if (native) window.Capacitor = {
        isNativePlatform: () => true, getPlatform: () => 'android',
        Plugins: {
          Filesystem: window.makeNativeFilesystemFixture().fs,
          Share: { share: async options => { window.sharedExport = options; } },
          App: { addListener(name, callback) { window.nativeBack = callback; return { remove: async () => {} }; }, exitApp: async () => { window.shellCalls.push('exit'); } },
          SystemBars: { setStyle: async options => { window.shellCalls.push(options.style); } },
          // アップデートの確認: 実機のダウンロード・照合・インストーラーの代わりに、進み具合を1回送って開いたことにする。
          MagiUpdate: {
            information: async () => { if (window.updateInfoFails) throw new Error('unavailable'); return { needsMainProfile: !!window.updateNeedsMainProfile }; },
            addListener: async (name, callback) => { window.updateProgress = callback; return { remove: async () => { window.updateProgress = null; } }; },
            install: async options => { window.updateInstallCalls = (window.updateInstallCalls || 0) + 1; window.updateInstall = options; window.updateProgress({ phase: 'download', received: 1, total: 2 }); return { state: window.updateResult || 'installer' }; },
          },
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
    assert.equal(await page.locator('#agent-history-panel #btn-update-check').count(), 0);
    if (native) await page.evaluate(() => window.nativeBack({ canGoBack: false }));
    else await page.locator('.agent-panel-close').click();
    assert.equal(await page.locator('.agent-panel').count(), 0);
    assert.equal(await page.locator('#agent-input').inputValue(), 'Unsent draft');
    await page.locator('#btn-history-agent').click();
    await page.locator('.session-load').click();
    assert.match(await page.locator('#agent-log').innerText(), /Saved answer/);
    await page.locator('#btn-more-agent').click();
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
    assert.equal(await page.evaluate(() => JSON.parse(safeGet('magi_saved_sessions')).length), 1);
    if (native) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('#btn-more-agent').click();
      await page.locator('#btn-settings-agent').click();
      await page.waitForFunction(() => document.querySelector('#history-storage-status').textContent.includes('MB'));
      await page.locator('#history-export').click();
      await page.waitForFunction(() => !!window.sharedExport);
      assert.match(await page.evaluate(() => window.sharedExport.files[0]), /magi-export.json$/);
      assert.equal(await page.evaluate(async () => JSON.parse((await Capacitor.Plugins.Filesystem.readFile({ directory: 'CACHE', path: 'magi-export.json' })).data).sessions.length), 1);
      page.once('dialog', dialog => dialog.accept());
      await page.locator('#history-clear').click();
      await page.waitForFunction(() => JSON.parse(safeGet('magi_saved_sessions') || '[]').length === 0 && !document.getElementById('agent-settings-panel'));
      assert.equal(await page.locator('.agent-splash').count(), 1);
      assert.equal(await page.evaluate(async () => {
        try { await Capacitor.Plugins.Filesystem.readFile({ directory: 'CACHE', path: 'magi-export.json' }); return false; }
        catch (e) { return e.code === 'OS-PLUG-FILE-0008'; }
      }), true);
      // ︙の「アップデートの確認」: 同じ版なら最新と出し、新しい版はSHA-256付きでネイティブへ渡す。
      await page.locator('#btn-more-agent').click();
      assert.doesNotMatch(await page.locator('#agent-more-dropdown').innerText(), /\bSettings\b/);
      await page.locator('#btn-about-agent').click(); await page.locator('[data-about="version"]').click();
      assert.match(await page.locator('#agent-more-dropdown').getAttribute('class'), /hidden/);
      await page.waitForFunction(() => document.querySelector('#app-update-status').textContent === 'You have the latest version.');
      assert.equal(await page.locator('#app-update-action').isVisible(), false);
      const sha256 = 'ab'.repeat(32);
      await page.route('**/releases/latest', route => route.fulfill({ json: { tag_name: 'v99.9', draft: false, prerelease: false,
        assets: [{ name: 'magi-android.apk', digest: 'sha256:' + sha256 }] } }));
      await page.locator('.agent-panel-close').click();
      await page.locator('#btn-more-agent').click();
      await page.locator('#btn-about-agent').click(); await page.locator('[data-about="version"]').click();
      await page.waitForFunction(() => document.querySelector('#app-update-status').textContent === 'Version 99.9 is available.');
      await page.locator('#app-update-action').click();
      await page.waitForFunction(() => document.querySelector('#app-update-status').textContent.startsWith('The installer is open.'));
      assert.deepEqual(await page.evaluate(() => window.updateInstall), { version: '99.9', sha256 });
      assert.equal(await page.locator('#app-update-page').isVisible(), false);
      await page.locator('.agent-panel-close').click();
      // 許可が反映されない場合に同じ設定画面へ誘導し続けない。
      for (const state of ['denied', 'profile']) {
        await page.evaluate(state => { window.updateResult = state; }, state);
        await page.locator('#btn-more-agent').click(); await page.locator('#btn-about-agent').click(); await page.locator('[data-about="version"]').click();
        await page.locator('#app-update-action').click();
        await page.waitForFunction(() => !document.querySelector('#app-update-page').hidden);
        assert.equal(await page.locator('#app-update-action').isVisible(), false);
        assert.match(await page.locator('#app-update-status').textContent(), /main profile/);
        await page.locator('.agent-panel-close').click();
      }
      // 複製側はパネルを開き直しても、取得・許可設定・インストーラーを呼ばない。
      await page.evaluate(() => { window.updateNeedsMainProfile = true; });
      const installs = await page.evaluate(() => window.updateInstallCalls);
      for (let i = 0; i < 2; i++) {
        await page.locator('#btn-more-agent').click(); await page.locator('#btn-about-agent').click(); await page.locator('[data-about="version"]').click();
        await page.waitForFunction(() => !document.querySelector('#app-update-page').hidden);
        assert.equal(await page.locator('#app-update-action').isVisible(), false);
        assert.equal(await page.evaluate(() => window.updateInstallCalls), installs);
        await page.locator('.agent-panel-close').click();
      }
      // 判定APIがない旧プラグインでも、通常の更新操作を維持する。
      await page.evaluate(() => { window.updateInfoFails = true; window.updateResult = 'installer'; });
      await page.locator('#btn-more-agent').click(); await page.locator('#btn-about-agent').click(); await page.locator('[data-about="version"]').click();
      await page.locator('#app-update-action').click();
      await page.waitForFunction(() => document.querySelector('#app-update-status').textContent.startsWith('The installer is open.'));
      await page.locator('.agent-panel-close').click();
    } else {
      assert.equal(await page.locator('#btn-settings-agent').isVisible(), false);
      await page.locator('#btn-history-agent').click();
      assert.equal(await page.locator('#btn-update-check').isVisible(), false);
      await page.locator('.agent-panel-close').click();
    }
    report.push({ nativeMock: native, savedChat: true, unsentDraft: true, insets: true, pageErrors: errors, aiPosts: posts.length });
    await context.close();
  }
  writeFileSync(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally { await browser.close(); }
