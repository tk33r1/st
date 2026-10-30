// 実カメラAPIとChromiumの合成映像で、撮影・添付・解放と許可待ちの競合を検査する。
// 全通信はローカルファイル・固定応答に閉じ、本番のチャットAPIには送らない。
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = resolve(root, 'workers/.wrangler/magi-camera-browser');
mkdirSync(out, { recursive: true });
const sources = ['index.html', 'magi-app/www/app.js'].map(name => readFileSync(resolve(root, name), 'utf8'));
assert.equal(sources[0].match(/\/\/ CAMERA_BEGIN[\s\S]*?\/\/ CAMERA_END/)[0], sources[1].match(/\/\/ CAMERA_BEGIN[\s\S]*?\/\/ CAMERA_END/)[0]);
const browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
try {
  for (const target of ['web', 'pwa']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'en-US', serviceWorkers: 'block' });
    const errors = [], posts = [];
    await context.addInitScript(() => {
      localStorage.setItem('st-analytics', 'off'); sessionStorage.setItem('magi_transport', 'sse');
      const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      window.cameraMode = 'real'; window.cameraTracks = []; window.cameraCalls = [];
      const acquire = async constraints => { const stream = await real(constraints); window.cameraTracks.push(...stream.getTracks()); return stream; };
      navigator.mediaDevices.getUserMedia = constraints => {
        window.cameraCalls.push(constraints);
        if (window.cameraMode === 'deny') return Promise.reject(new DOMException('Synthetic denial', 'NotAllowedError'));
        if (window.cameraMode === 'missing') return Promise.reject(new DOMException('Synthetic missing camera', 'NotFoundError'));
        if (window.cameraMode === 'pending') return new Promise(resolve => { window.releaseCamera = async () => resolve(await acquire(constraints)); });
        return acquire(constraints);
      };
    });
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (request.method() === 'POST') { posts.push(url.pathname); return route.abort(); }
      if (url.hostname === 'workers.tk.st' && url.pathname === '/magi2/models') return route.fulfill({ json: { features: { privacy_contract: 1, personalization: true, temporary_chat: true, temporary_personalization: true } } });
      if (url.hostname === 'tk.st' && (url.pathname === '/' || url.pathname.startsWith('/magi-app/www/'))) {
        const file = resolve(root, '.' + (url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname));
        if (file.startsWith(root) && existsSync(file)) return route.fulfill({ path: file });
      }
      return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('https://tk.st/' + (target === 'pwa' ? 'magi-app/www/' : ''), { waitUntil: 'domcontentloaded' });
    if (target === 'web') await page.evaluate(() => document.querySelector('[data-act="agent"]').click());
    const panel = page.locator('#agent-camera-panel'), shoot = panel.locator('[data-camera="shoot"]');
    async function open() {
      await page.locator('#agent-attach').click();
      await page.locator('#agent-attach-menu [data-source="camera"]').click();
      await panel.waitFor({ state: 'visible' });
    }
    async function ready() { await page.waitForFunction(() => !document.querySelector('#agent-camera-panel [data-camera="shoot"]').disabled); }
    async function stopped() { await page.waitForFunction(() => window.cameraTracks.every(track => track.readyState === 'ended')); }
    // カメラは明示操作まで開かず、撮影で初めてサムネと送信用data URLが作られる。
    assert.equal(await page.evaluate(() => window.cameraCalls.length), 0);
    await open(); await ready();
    assert.equal(await page.locator('#agent-attach-tray img').count(), 0);
    const preview = await panel.locator('video').evaluate(video => ({ width: video.videoWidth, height: video.videoHeight }));
    assert.ok(preview.width > 0 && preview.height > 0);
    await panel.evaluate(el => Promise.all(el.getAnimations({ subtree: true }).map(a => a.finished)));
    const bounds = await shoot.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 390 && bounds.y + bounds.height <= 844, '撮影ボタンがスマホ画面内に収まる');
    await page.screenshot({ path: resolve(out, `${target}-preview.png`) });
    await shoot.click(); await panel.waitFor({ state: 'detached' }); await stopped();
    assert.equal(await page.locator('#agent-attach-tray img').count(), 1);
    const thumb = await page.locator('#agent-attach-tray img').getAttribute('src');
    assert.ok(thumb.startsWith('data:image/jpeg;base64,') && thumb.length > 100);
    // 前後切替は古いストリームを止める。EscとTabも撮影パネル内で扱う。
    await open(); await ready();
    const beforeSwitch = await page.evaluate(() => window.cameraTracks.length);
    await panel.locator('[data-camera="switch"]').click(); await ready();
    assert.equal(await page.evaluate(n => window.cameraTracks.slice(0, n).every(t => t.readyState === 'ended'), beforeSwitch), true);
    assert.equal(await page.evaluate(() => window.cameraCalls.at(-1).video.facingMode.ideal), 'user');
    await panel.locator('.agent-panel-close').focus(); await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.camera), 'photo');
    await page.keyboard.press('Escape'); await panel.waitFor({ state: 'detached' }); await stopped();
    assert.equal(await page.locator('#agent-attach-tray img').count(), 1);
    // 権限拒否・カメラ未搭載は説明と写真選択へ。自動でファイル選択へ飛ばさない。
    for (const mode of ['deny', 'missing']) {
      await page.evaluate(mode => { window.cameraMode = mode; }, mode);
      await open();
      await panel.locator('[data-camera="retry"]').waitFor({ state: 'visible' });
      assert.equal(await shoot.isDisabled(), true);
      assert.match(await panel.locator('[role="status"]').innerText(), mode === 'deny' ? /site settings/ : /No available camera/);
      if (mode === 'deny') {
        const picker = page.waitForEvent('filechooser');
        await panel.locator('[data-camera="photo"]').click();
        const input = (await picker).element();
        assert.equal(await input.getAttribute('capture'), null); assert.equal(await input.getAttribute('accept'), 'image/*');
      } else await panel.locator('.agent-panel-close').click();
    }
    // 許可待ちに閉じたあと届いたストリームも止め、画像を添付しない。
    await page.evaluate(() => { window.cameraMode = 'pending'; window.releaseCamera = null; });
    await open(); await page.waitForFunction(() => typeof window.releaseCamera === 'function');
    await panel.locator('.agent-panel-close').click();
    await page.evaluate(() => window.releaseCamera()); await stopped();
    assert.equal(await page.locator('#agent-attach-tray img').count(), 1);
    // タブが背面に回った場合も撮影画面を閉じてカメラを解放する。
    await page.evaluate(() => { window.cameraMode = 'real'; });
    await open(); await ready();
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await panel.waitFor({ state: 'detached' }); await stopped();
    await page.evaluate(() => { delete document.hidden; });
    // 会話を替えたあと、古い許可要求から別の会話へ添付しない。
    await page.evaluate(() => { window.cameraMode = 'pending'; window.releaseCamera = null; });
    await open(); await page.waitForFunction(() => typeof window.releaseCamera === 'function');
    await page.evaluate(() => resetAgent());
    await page.evaluate(() => window.releaseCamera()); await stopped();
    assert.equal(await page.locator('#agent-attach-tray img').count(), 0);
    // getUserMedia非対応のタッチ端末では説明を表示し、写真の添付を残す。
    await page.evaluate(() => { navigator.mediaDevices.getUserMedia = undefined; });
    await open();
    assert.match(await panel.locator('[role="status"]').innerText(), /cannot open the camera/);
    assert.equal(await shoot.isDisabled(), true);
    await panel.locator('.agent-panel-close').click();
    assert.deepEqual(posts, []); assert.deepEqual(errors, []);
    console.log(`${target}: capture, switch, errors, late permission, background, chat change and fallback passed`);
    await context.close();
  }
} finally { await browser.close(); }
