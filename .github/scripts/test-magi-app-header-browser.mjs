// アプリのヘッダー（☰の履歴シート・1行のタイトル・今日の利用回数の円グラフ・︙のメニュー）をスマホ幅で確かめる。
// 全要求をローカルのファイルか固定応答に差し替え、有料API・計測への実通信は行わない。
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = resolve(root, 'workers/.wrangler/magi-app-header-browser');
mkdirSync(out, { recursive: true });
const title = 'Androidのホーム画面ウィジェットに音声入力のボタンを置くときのデザインの考え方';
const usage = (used, extra = {}) => ({ used, limit: 60, day: '2026-10-22', resets_at: '2026-10-23T00:00:00.000Z', global_full: false, ...extra });
// 画面のファイルは手元から返し、Worker の入口は api（パス→応答を返す関数）に任せる。それ以外は止める。
function serve(context, api, posts = []) {
  return context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (req.method() === 'POST') posts.push(url.pathname);
    if (url.origin === 'https://tk.st' && url.pathname.startsWith('/magi-app/www/')) {
      const name = url.pathname.slice('/magi-app/www/'.length) || 'index.html';
      if (!/^(?:[a-z0-9.-]+|vendor\/Readability\.js)$/.test(name)) return route.abort();
      const contentType = name.endsWith('.html') ? 'text/html' : name.endsWith('.js') ? 'text/javascript' : name.endsWith('.png') ? 'image/png' : 'application/json';
      return route.fulfill({ body: readFileSync(resolve(root, 'magi-app/www', name)), contentType });
    }
    const reply = api[url.pathname];
    return reply ? route.fulfill(await reply()) : route.abort();
  });
}
const browser = await chromium.launch({ headless: true });
const report = [];
try {
  for (const scenario of [
    { name: 'low', scheme: 'dark', reply: usage(12), dash: '20.0 100', level: '' },
    { name: 'high', scheme: 'light', reply: usage(50), dash: '83.3 100', level: 'high' },
    { name: 'full', scheme: 'dark', reply: usage(60), dash: '100.0 100', level: 'full' },
    { name: 'global', scheme: 'light', reply: usage(3, { global_full: true }), dash: '100.0 100', level: 'full', warn: true },
    { name: 'old-worker', scheme: 'dark', status: 404 },
  ]) {
    const context = await browser.newContext({ viewport: { width: 360, height: 780 }, locale: 'en-US', colorScheme: scenario.scheme, serviceWorkers: 'block' });
    const errors = [], posts = [], usageCalls = [];
    let usageReply = scenario.reply, hold = null;
    await serve(context, {
      '/magi2/usage': async () => {
        usageCalls.push(Date.now());
        if (hold) await hold;
        return scenario.status ? { status: scenario.status, json: {} } : { json: usageReply };
      },
      '/magi2/models': () => ({ json: {} }),
    }, posts);
    await context.addInitScript(([t]) => {
      try { sessionStorage.setItem('magi_transport', 'sse'); } catch (_) {} // 既存の検証は SSE の経路を見る。WebSocket（読み上げ設計§6.3）は test-magi-ws-browser.mjs で確かめ、ここでは手元・本番のどちらへも開かない
      localStorage.setItem('magi_current_title', t);
      localStorage.setItem('magi_saved_sessions', JSON.stringify([
        { id: 'h1', title: '旅行の持ち物リスト', timestamp: '2026-10-21T00:00:00Z', history: [{ role: 'user', content: 'Saved question' }, { role: 'assistant', content: 'Saved answer', mid: 'm1' }] },
        { id: 'h2', title: 'とても長い会話のタイトルが入ったときにシートの中で切れることを確かめる', timestamp: '2026-10-20T00:00:00Z', history: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }] }]));
    }, [title]);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('https://tk.st/magi-app/www/', { waitUntil: 'domcontentloaded' });
    // 起動時の取得が終わるまで待つ
    await page.waitForFunction(() => !window.usageRequest && window.usageLoadedAt > 0);

    // タイトルは1行に収め、はみ出す分は … で切る
    const head = await page.evaluate(() => {
      const t = document.querySelector('#bar .title');
      return { lines: Math.round(t.getBoundingClientRect().height / parseFloat(getComputedStyle(t).lineHeight)), clipped: t.scrollWidth > t.clientWidth, tip: t.title };
    });
    assert.equal(head.lines, 1); assert.equal(head.clipped, true); assert.equal(head.tip, title);

    if (scenario.status) {
      // 旧Workerでは円グラフごと隠す
      assert.equal(await page.locator('.usage-wrap').isVisible(), false);
    } else {
      const ring = await page.evaluate(() => ({ dash: document.querySelector('.usage-fill').getAttribute('stroke-dasharray'),
        level: document.querySelector('.usage-wrap').dataset.level, label: document.getElementById('btn-usage').getAttribute('aria-label') }));
      assert.equal(ring.dash, scenario.dash); assert.equal(ring.level, scenario.level);
      assert.match(ring.label, new RegExp(`${scenario.reply.used} of 60`));
      await page.locator('#bar').screenshot({ path: resolve(out, `${scenario.name}-header.png`) });
      // 円グラフのポップアップと︙のメニューは、片方を開くともう片方が閉じる
      await page.locator('#btn-usage').click();
      const pop = await page.locator('#agent-usage-pop').innerText();
      assert.match(pop, new RegExp(`${scenario.reply.used}\\s*/ 60`)); assert.match(pop, /Resets daily at/);
      assert.equal(/site-wide daily limit/.test(pop), !!scenario.warn);
      assert.equal(await page.locator('#btn-usage').getAttribute('aria-expanded'), 'true');
      await page.screenshot({ path: resolve(out, `${scenario.name}-usage.png`), clip: { x: 0, y: 0, width: 360, height: 280 } });
      await page.locator('#btn-more-agent').click();
      assert.equal(await page.locator('#agent-usage-pop').isVisible(), false);
      assert.equal(await page.locator('#agent-more-dropdown').isVisible(), true);
      await page.locator('#btn-usage').click();
      assert.equal(await page.locator('#agent-more-dropdown').isVisible(), false);
      await page.locator('#agent-log').click({ position: { x: 20, y: 300 } });
      assert.equal(await page.locator('#agent-usage-pop').isVisible(), false);
    }

    // ︙ の中のテーマ切り替えは、切り替わる先を書く
    await page.locator('#btn-more-agent').click();
    const before = await page.locator('html').getAttribute('data-theme');
    assert.equal(await page.locator('#btn-theme-label').textContent(), before === 'dark' ? 'Light mode' : 'Dark mode');
    await page.locator('#btn-theme').click();
    assert.notEqual(await page.locator('html').getAttribute('data-theme'), before);
    assert.equal(await page.locator('#agent-more-dropdown').isVisible(), false);

    // ☰ のシート: 開くと「New chat」にフォーカス、Tab はシートの中で回り、Esc で閉じて ☰ に戻る
    await page.locator('#btn-history-agent').click();
    assert.equal(await page.locator('#btn-history-agent').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'btn-reset');
    await page.waitForTimeout(400);
    await page.screenshot({ path: resolve(out, `${scenario.name}-drawer.png`) });
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      assert.ok(await page.evaluate(() => !!document.activeElement.closest('#agent-history-panel')));
    }
    await page.keyboard.press('Shift+Tab');
    assert.ok(await page.evaluate(() => !!document.activeElement.closest('#agent-history-panel')));
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#agent-history-panel').count(), 0);
    assert.equal(await page.locator('#btn-history-agent').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'btn-history-agent');
    // 暗幕・✕ でも閉じ、印が戻る
    await page.locator('#btn-history-agent').click(); await page.mouse.click(350, 400);
    assert.equal(await page.locator('#agent-history-panel').count(), 0);
    assert.equal(await page.locator('#btn-history-agent').getAttribute('aria-expanded'), 'false');
    await page.locator('#btn-history-agent').click(); await page.locator('#agent-history-panel .agent-panel-close').click();
    assert.equal(await page.locator('#btn-history-agent').getAttribute('aria-expanded'), 'false');
    // 保存した会話はキーボードでも開ける
    await page.locator('#btn-history-agent').click();
    await page.locator('.session-load').first().focus(); await page.keyboard.press('Enter');
    assert.equal(await page.locator('#bar-title').textContent(), '旅行の持ち物リスト');
    assert.equal(await page.locator('#agent-history-panel').count(), 0);
    // 新しい会話
    await page.locator('#btn-history-agent').click(); await page.locator('#btn-reset').click();
    assert.equal(await page.locator('#bar-title').textContent(), 'MAGI');
    assert.equal(await page.locator('#btn-history-agent').getAttribute('aria-expanded'), 'false');

    if (scenario.name === 'low') {
      // 取得中に呼ばれたら、終わってからもう一度読む（送信の前の回数で終わらせない）
      let release; hold = new Promise(r => { release = r; });
      const calls = usageCalls.length;
      await page.evaluate(() => { loadUsage(); loadUsage(); });
      while (usageCalls.length === calls) await page.waitForTimeout(20);
      usageReply = usage(13); hold = null; release();
      await page.waitForFunction(() => document.querySelector('.usage-fill').getAttribute('stroke-dasharray') === '21.7 100');
      assert.equal(usageCalls.length, calls + 2);
      // 応答が返らなくても6秒で打ち切り、前の値を残して次の取得ができる
      hold = new Promise(() => {});
      const started = Date.now();
      await page.evaluate(() => loadUsage());
      await page.waitForFunction(() => !window.usageRequest, null, { timeout: 9000 });
      assert.ok(Date.now() - started < 9000);
      assert.equal(await page.locator('.usage-fill').getAttribute('stroke-dasharray'), '21.7 100');
      assert.equal(await page.locator('.usage-wrap').isVisible(), true);
      hold = null; usageReply = usage(14);
      await page.evaluate(() => loadUsage());
      await page.waitForFunction(() => document.querySelector('.usage-fill').getAttribute('stroke-dasharray') === '23.3 100');
      // 絵文字の吹き出しも、円グラフを押すと閉じる
      await page.locator('#btn-history-agent').click(); await page.locator('.session-load').first().click();
      const emoji = page.locator('.react-btn[data-act="emoji"]').first();
      assert.ok(await emoji.count());
      await emoji.click(); assert.equal(await page.locator('.emoji-pop').count(), 1);
      await page.locator('#btn-usage').click(); assert.equal(await page.locator('.emoji-pop').count(), 0);
    }
    assert.deepEqual(errors, []); assert.deepEqual(posts, []);
    report.push({ scenario: scenario.name, usageCalls: usageCalls.length, errors, posts: posts.length });
    await context.close();
  }

  // 言語: 端末が日本語なら日本語で始まり、︙で切り替えると画面・会話・開き直した後も切り替わる
  const context = await browser.newContext({ viewport: { width: 360, height: 780 }, locale: 'ja-JP', serviceWorkers: 'block' });
  const errors = [];
  await serve(context, {
    '/magi2/usage': () => ({ json: usage(7) }),
    '/magi2/models': () => ({ json: { personas: { 'MELCHIOR-1': { provider: 'deepseek', provider_label: 'DeepSeek', model: 'M', desc: { en: 'Desc EN', ja: '説明 JA' }, context: { en: 'Ctx EN', ja: '素材 JA' }, theme: { en: 'Th EN', ja: 'テーマ JA' } } } } }),
  });
  await context.addInitScript(() => {
    try { sessionStorage.setItem('magi_transport', 'sse'); } catch (_) {} // 既存の検証は SSE の経路を見る。WebSocket（読み上げ設計§6.3）は test-magi-ws-browser.mjs で確かめ、ここでは手元・本番のどちらへも開かない
    localStorage.setItem('magi_saved_sessions', JSON.stringify([{ id: 'l1', title: '保存した会話', timestamp: '2026-10-21T00:00:00Z',
      history: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a', mid: 'm1', debate: { 'MELCHIOR-1': { round1: 'r1', round2: 'r2' } } }] }]));
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('https://tk.st/magi-app/www/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !window.usageRequest && window.usageLoadedAt > 0);
  const labels = () => page.evaluate(() => ({ lang: document.documentElement.lang, placeholder: document.getElementById('agent-input').placeholder,
    menu: document.getElementById('agent-more-dropdown').innerText, chats: document.getElementById('btn-history-agent').getAttribute('aria-label'),
    attach: document.getElementById('agent-attach').getAttribute('aria-label'), usage: document.getElementById('btn-usage').getAttribute('aria-label') }));
  let l = await labels();
  assert.equal(l.lang, 'ja'); assert.equal(l.placeholder, '武田伸也AIに質問…'); assert.equal(l.chats, 'チャット'); assert.equal(l.attach, '画像を追加');
  assert.match(l.usage, /今日の利用 7 \/ 60回/);
  await page.locator('#btn-more-agent').click();
  l = await labels();
  for (const text of ['ライトモード|ダークモード', 'English', '会話を共有', 'Markdownで保存', '旧MAGI']) assert.match(l.menu, new RegExp(text));
  await page.screenshot({ path: resolve(out, 'lang-ja-menu.png'), clip: { x: 0, y: 0, width: 360, height: 360 } });
  await page.keyboard.press('Escape'); await page.locator('#agent-log').click({ position: { x: 20, y: 500 } });
  // スプラッシュの人格の説明も日本語
  await page.locator('.magi-node[data-codename="MELCHIOR-1"]').click();
  await page.waitForFunction(() => /説明 JA/.test(document.querySelector('.magi-desc').textContent));
  assert.match(await page.locator('.magi-desc').innerText(), /素材[\s\S]*素材 JA/);
  await page.locator('#btn-history-agent').click();
  assert.match(await page.locator('#agent-history-panel').innerText(), /新しいチャット[\s\S]*チャット[\s\S]*保存した会話/);
  await page.locator('.session-load').click();
  assert.match(await page.locator('#agent-log').innerText(), /初回[\s\S]*討議後/);
  // English に切り替える
  await page.locator('#btn-more-agent').click(); await page.locator('#btn-lang').click();
  l = await labels();
  assert.equal(l.lang, 'en'); assert.equal(l.placeholder, 'Ask Shinya Takeda AI...'); assert.equal(l.chats, 'Chats'); assert.equal(l.attach, 'Add an image');
  assert.match(l.usage, /Today's usage: 7 of 60/); assert.match(l.menu, /日本語/); assert.match(l.menu, /Share Log/);
  assert.match(await page.locator('#agent-log').innerText(), /Initial[\s\S]*After debate/);
  assert.equal(await page.evaluate(() => localStorage.getItem('magi_lang')), 'en');
  // 開き直しても選んだ言語のまま
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !window.usageRequest && window.usageLoadedAt > 0);
  l = await labels(); assert.equal(l.lang, 'en'); assert.equal(l.chats, 'Chats');
  await page.locator('#btn-more-agent').click(); await page.locator('#btn-lang').click();
  assert.equal((await labels()).placeholder, '武田伸也AIに質問…');
  assert.deepEqual(errors, []);
  report.push({ scenario: 'language', errors });
  await context.close();
} finally {
  await browser.close();
}
console.log(JSON.stringify(report));
