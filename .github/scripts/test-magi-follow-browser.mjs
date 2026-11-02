// 実際の受信間隔とスクロールで、長い3人格の検討内容と統合回答への追従を確認する。
// fetchの応答だけを合成し、画面・SSEパーサー・スクロールは本物を使う。外部通信は遮断する。
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';

const root = process.cwd(), out = resolve(root, 'workers/.wrangler/magi-chat-gate/follow');
mkdirSync(out, { recursive: true });
const ids = ['MELCHIOR-1', 'BALTHASAR-2', 'CASPER-3'];
const browser = await chromium.launch({ headless: true }), results = [];
try {
  for (const [surface, width, theme, motion] of [
    ['web', 1280, 'light', 'no-preference'], ['web', 390, 'dark', 'no-preference'],
    ['pwa', 390, 'dark', 'no-preference'], ['pwa', 320, 'light', 'reduce'],
  ]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width < 768,
      hasTouch: width < 768, locale: 'ja-JP', colorScheme: theme, reducedMotion: motion, serviceWorkers: 'block' });
    await context.addInitScript(() => {
      localStorage.setItem('st-analytics', 'off'); localStorage.setItem('magi_mode_enabled', '1'); sessionStorage.setItem('magi_transport', 'sse');
      const fetchOriginal = window.fetch;
      window.fetch = function (url, options) {
        if (!String(url).endsWith('/magi2/chat')) return fetchOriginal.apply(this, arguments);
        window.followRequest = JSON.parse(options.body);
        const encoder = new TextEncoder(); let controller;
        const body = new ReadableStream({ start(value) { controller = value; } });
        window.followPush = (event, data) => controller.enqueue(encoder.encode('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'));
        window.followClose = () => controller.close();
        return Promise.resolve(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
      };
    });
    await context.routeWebSocket('**/*', socket => socket.close());
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/magi2/models') return route.fulfill({ json: { features: { privacy_contract: 1, personalization: true, temporary_chat: true, temporary_personalization: true } } });
      if (url.pathname === '/magi2/usage') return route.fulfill({ json: { used: 0, limit: 60 } });
      if (url.origin === 'https://tk.st') {
        const file = resolve(root, '.' + (url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname));
        if (file.startsWith(root + sep) && existsSync(file)) return route.fulfill({ body: readFileSync(file),
          contentType: ({ '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' })[extname(file)] || 'application/octet-stream' });
      }
      return route.abort();
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('https://tk.st/' + (surface === 'pwa' ? 'magi-app/www/' : ''), { waitUntil: 'domcontentloaded' });
    if (surface === 'web' && !await page.locator('#agent-input').isVisible()) await page.locator('#activitybar [data-act="agent"]').click();
    await page.locator('#agent-input').fill('改修の提案を検討しています。'); await page.locator('#agent-send').click();
    await page.waitForFunction(() => typeof followPush === 'function');
    await page.evaluate(() => {
      if (followRequest.privacy_contract) followPush('session', { conversation_mode: followRequest.conversation_mode, personalization_applied: false });
      followPush('classification', { version: 1, intent: 'consult', mode: 'consult', fresh: 'no', votable: 'yes', site_pages: 'no', magi_candidate: true, reply_language: { version: 1, code: 'ja', source: 'ui' } });
      followPush('motion', { text: '改修を提案する', votable: true });
    });
    await page.waitForTimeout(500);
    for (const codename of ids) {
      await page.evaluate(codename => followPush('persona', { codename, round: 1,
        text: codename + 'の検討です。' + '異なる価値観からこの相談を考えています。'.repeat(22),
        vote: codename === 'BALTHASAR-2' ? 'reject' : 'approve', vote_state: 'final' }), codename);
      await page.waitForFunction(codename => document.querySelector('.persona-card[data-codename="' + codename + '"] .persona-text').textContent.includes('異なる価値観'), codename);
      await page.waitForTimeout(350);
    }
    // DOM上にあるだけでは合格にしない。最後の人格の末尾が、入力欄とフェードを除く画面内にあること。
    const assertVisibleTail = async selector => page.waitForFunction(selector => {
      const log = document.getElementById('agent-log'), target = log.querySelector(selector);
      if (!target) return false;
      const rect = target.getBoundingClientRect();
      const bounds = magiLogViewport(log);
      return rect.bottom >= bounds.top && rect.bottom <= bounds.bottom + 2;
    }, selector);
    await assertVisibleTail('.persona-card[data-codename="CASPER-3"]');
    await page.setViewportSize({ width, height: 700 });
    await assertVisibleTail('.persona-card[data-codename="CASPER-3"]');

    // 読み戻し中は、新しい人格の意見や統合回答が届いても位置を奪わない。
    const log = page.locator('#agent-log'), bounds = await log.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + Math.min(200, bounds.height / 2));
    await page.mouse.wheel(0, -450); await page.waitForTimeout(500);
    const historyTop = await log.evaluate(el => el.scrollTop);
    await page.evaluate(() => followPush('persona', { codename: 'CASPER-3', round: 2, text: 'SYNTHETIC-SECOND-ROUND', vote: 'approve', vote_state: 'final' }));
    await page.waitForFunction(() => document.querySelector('.persona-card[data-codename="CASPER-3"] .persona-round[data-round="2"]').textContent.includes('SYNTHETIC-SECOND-ROUND'));
    await page.waitForTimeout(150);
    assert.ok(Math.abs(await log.evaluate(el => el.scrollTop) - historyTop) <= 2, 'manual history position');
    await page.locator('#agent-scroll-bottom').click();
    await page.waitForFunction(() => { const log = document.getElementById('agent-log'); return log.scrollHeight - log.clientHeight - log.scrollTop < 2; });
    await page.evaluate(ids => {
      for (const codename of ids.slice(0, 2)) followPush('persona', { codename, round: 2, text: '更新した意見です。', vote: codename === 'BALTHASAR-2' ? 'reject' : 'approve', vote_state: 'final' });
      followPush('ask', { round: 3, questions: [{ codename: 'CASPER-3', text: '反対意見も踏まえて追加検討してください。' }] });
      followPush('persona', { codename: 'CASPER-3', round: 3, text: '追加の検討です。'.repeat(30), vote: 'approve', vote_state: 'final' });
    }, ids);
    await assertVisibleTail('.persona-card[data-codename="CASPER-3"]');

    await page.evaluate(ids => {
      followPush('verdict', { motion: '改修を提案する', result: 'approve', tally: { approve: 2, reject: 1, none: 0 }, rounds: 3,
        votes: Object.fromEntries(ids.map(codename => [codename, { vote: codename === 'BALTHASAR-2' ? 'reject' : 'approve', round: codename === 'CASPER-3' ? 3 : 2, state: 'voted' }])) });
      followPush('integrated', { delta: '葛藤を踏まえて、段階的に提案します。' });
      followPush('integrated_end', {}); followPush('done', {}); followClose();
    }, ids);
    await page.waitForFunction(() => !document.getElementById('agent-input').disabled);
    await assertVisibleTail('.agent-reply-body');
    assert.deepEqual(errors, []);
    const label = surface + '-' + width + '-' + theme;
    await page.screenshot({ path: resolve(out, label + '.png') });
    results.push({ label, pass: true }); console.log(label + ': live persona/reply viewport follow, resize, manual history and resume PASS');
    await context.close();
  }
} finally { await browser.close(); }
writeFileSync(resolve(out, 'results.json'), JSON.stringify(results, null, 2));
