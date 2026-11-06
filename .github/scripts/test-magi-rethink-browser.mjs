// 採決の受信後に考え直すと、採決の保持より再送を優先する。通常の停止では採決を保持する。
// 実際の送信操作とSSEパーサーを通す。AI・計測・本番APIは呼ばない。
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {resolve, extname, sep} from 'node:path';
import {chromium} from 'playwright';

const root = resolve('.'), browser = await chromium.launch({headless: true});
let checked = 0;
try {
  for (const surface of ['web', 'pwa']) for (const action of ['rethink', 'stop']) {
    const context = await browser.newContext({viewport: {width: surface === 'web' ? 1280 : 390, height: 900},
      serviceWorkers: 'block', reducedMotion: 'reduce'});
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.addInitScript(() => {
      localStorage.setItem('st-analytics', 'off'); localStorage.setItem('magi_mode_enabled', '1');
      sessionStorage.setItem('magi_transport', 'sse');
      window.rethinkRequests = [];
      const realFetch = window.fetch;
      window.fetch = async function (url, options) {
        if (!String(url).endsWith('/magi2/chat')) return realFetch.apply(this, arguments);
        rethinkRequests.push(JSON.parse(options.body));
        const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
        const classification = {version: 1, intent: 'consult', mode: 'consult', fresh: 'no', votable: 'no',
          site_pages: 'no', magi_candidate: false, reply_language: {version: 1, code: 'en', source: 'ui'}};
        return new Response(new ReadableStream({start(controller) {
          if (rethinkRequests.length > 1) {
            controller.enqueue(new TextEncoder().encode(event('classification', classification)
              + event('integrated', {delta: 'Answer to the revised question.'}) + event('done', {})));
            controller.close(); return;
          }
          const ids = ['MELCHIOR-1', 'BALTHASAR-2', 'CASPER-3'];
          const verdict = {result: 'approve', tally: {approve: 3, reject: 0, none: 0}, rounds: 2, reason_missing: false,
            votes: Object.fromEntries(ids.map(id => [id, {vote: 'approve', round: 2, state: 'voted'}]))};
          controller.enqueue(new TextEncoder().encode(event('classification', {...classification, votable: 'yes', magi_candidate: true})
            + event('motion', {text: 'Proceed with the renovation', votable: true})
            + [1, 2].flatMap(round => ids.map(codename => event('persona', {round, codename, text: 'Reason', vote: 'approve', vote_state: 'final'}))).join('')
            + event('verdict', verdict)));
          options.signal.addEventListener('abort', () => controller.error(new DOMException('stopped', 'AbortError')), {once: true});
        }}), {headers: {'Content-Type': 'text/event-stream'}});
      };
    });
    await context.routeWebSocket('**/*', socket => socket.close());
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/magi2/models') return route.fulfill({json: {features: {speech: false}}});
      if (url.pathname === '/magi2/usage') return route.fulfill({json: {used: 0, limit: 60}});
      if (url.origin === 'https://tk.st') {
        const file = resolve(root, '.' + (url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname));
        if (file.startsWith(root + sep) && existsSync(file) && extname(file)) return route.fulfill({body: readFileSync(file),
          contentType: ({'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json'})[extname(file)] || 'application/octet-stream'});
      }
      return route.abort();
    });
    await page.goto('https://tk.st/' + (surface === 'pwa' ? 'magi-app/www/' : ''));
    if (surface === 'web' && await page.locator('#agentdock').evaluate(el => el.classList.contains('collapsed'))) await page.locator('#activitybar [data-act="agent"]').click();
    await page.locator('#agent-input').fill('Should I renovate?');
    await page.locator('#agent-send').click();
    // parseSSEは同じチャンクのverdictまで同期で受信してから次の読み取りを待つ。
    await page.waitForFunction(() => agentReplyLanguage?.code === 'en' && agentBusy && document.querySelector('.magi-panel'));
    if (action === 'rethink') await page.locator('#agent-input').fill('Keep the budget under 10,000 yen.');
    await page.locator('#agent-send').click();
    await page.waitForFunction(() => !agentBusy && !agentPrivacyState.preparing);
    const result = await page.evaluate(() => ({requests: rethinkRequests, history: agentHistory,
      draft: document.getElementById('agent-input').value, users: document.querySelectorAll('.agent-user').length}));
    assert.equal(result.requests.length, action === 'rethink' ? 2 : 1, surface + '/' + action);
    assert.equal(result.users, 1); assert.deepEqual(result.history.map(item => item.role), ['user', 'assistant']);
    if (action === 'rethink') {
      const merged = 'Should I renovate?\n\nKeep the budget under 10,000 yen.';
      assert.equal(result.requests[1].messages.at(-1).content, merged);
      assert.equal(result.history[0].content, merged); assert.equal(result.history[1].content, 'Answer to the revised question.');
      assert.equal(result.history[1].magi, undefined); assert.equal(result.draft, '');
    } else {
      assert.equal(result.history[1].mode, 'magi'); assert.equal(result.history[1].magi.reason_missing, true);
    }
    assert.deepEqual(errors, []); await context.close(); checked++;
  }
  console.log(JSON.stringify({pass: true, cases: checked, paidRequests: 0}));
} finally {await browser.close();}
