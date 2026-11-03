// 合成回答だけでホバーの位置・寸法不変・3人格のコピー削除・SPの長押し・絵文字の表示と復元を確認する。実APIは呼ばない。
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';
const root = resolve('.'), captures = resolve(root, 'workers/.wrangler/magi-hover-reactions');
mkdirSync(captures, { recursive: true });
const browser = await chromium.launch({ headless: true });
const cases = [
  ['web', 1280, false, 'dark'], ['web', 1280, false, 'light'], ['app', 1000, false, 'dark'],
  ['web', 390, true, 'dark'], ['web', 390, true, 'light'],
  ['app', 390, true, 'dark'], ['app', 390, true, 'light'], ['app', 320, true, 'dark']
];
try {
  for (const [surface, width, touch, theme] of cases) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, isMobile: touch, hasTouch: touch,
      locale: 'ja-JP', colorScheme: theme, serviceWorkers: 'block', reducedMotion: 'reduce' });
    const errors = [], reactions = []; let jsonRequests = 0;
    await context.addInitScript(() => { localStorage.setItem('st-analytics', 'off'); localStorage.setItem('magi_lang', 'ja'); });
    await context.routeWebSocket('**/*', socket => socket.close());
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.pathname === '/magi2/models') return route.fulfill({ json: { features: { speech: false } } });
      if (url.pathname === '/magi2/usage') return route.fulfill({ json: { used: 0, limit: 60 } });
      if (url.pathname === '/magi2/react') { reactions.push(req.postDataJSON()); return route.fulfill({ json: { ok: true, id: reactions.length, delete_token: 'a'.repeat(64) } }); }
      if (url.pathname.includes('/data/magi-emoji-')) jsonRequests++;
      if (url.origin === 'https://tk.st') {
        const file = resolve(root, '.' + (url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname));
        if (file.startsWith(root + sep) && existsSync(file) && extname(file)) return route.fulfill({ body: readFileSync(file),
          contentType: ({ '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' })[extname(file)] || 'application/octet-stream' });
      }
      return route.abort();
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto('https://tk.st/' + (surface === 'app' ? 'magi-app/www/' : ''));
    if (surface === 'web') await page.waitForFunction(() => !document.getElementById('input-line').classList.contains('hidden'));
    await page.waitForFunction(() => typeof personaCardsHTML === 'function');
    if (surface === 'web' && await page.locator('#agentdock').evaluate(el => el.classList.contains('collapsed'))) await page.locator('#activitybar [data-act="agent"]').click();
    await page.evaluate(theme => {
      document.documentElement.setAttribute('data-theme', theme); resetAgent(); ensureAgentConversation();
      const debate = Object.fromEntries(['MELCHIOR-1', 'BALTHASAR-2', 'CASPER-3'].map(k => [k, { round1: '週末は、気になる街を歩いてみよう。予定を詰めすぎず、寄り道を楽しんでもいい。', round2: '…' }]));
      const item = { role: 'assistant', mid: 'm_hover_fixture', content: '土曜の午後、気になっていた街を歩いてみよう。', debate };
      agentHistory.push({ role: 'user', content: '週末、少し気分を変えたい。' }, item);
      const log = document.getElementById('agent-log'); log.innerHTML = '';
      const turn = document.createElement('div'); turn.className = 'agent-turn'; turn.dataset.mid = item.mid;
      turn.innerHTML = personaCardsHTML(debate) + '<div class="agent-reply"><span class="agent-who">✦ Shinya Takeda</span><span class="agent-reply-body">' + item.content + '</span>' + replyBarHTML() + '</div>';
      log.appendChild(turn); setupReplyBar(turn, item); log.scrollTop = 0;
    }, theme);
    const key = surface + '-' + width + '-' + theme, cards = page.locator('.persona-card'), reply = page.locator('.agent-reply');
    assert.equal(await cards.locator('[data-act="copy"]').count(), 0);
    assert.equal(await reply.locator('[data-act="copy"]').count(), 1);
    assert.deepEqual(await cards.locator('.reaction-bar').evaluateAll(list => list.map(el => el.getBoundingClientRect().height)), [0, 0, 0]);
    const rects = () => page.locator('.persona-card, .agent-reply').evaluateAll(list => list.map(el => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }));
    const palette = page.locator('.agent-hover-reactions');
    if (!touch) {
      await page.mouse.move(0, 0); assert.equal(await palette.count(), 0);
      await cards.nth(1).scrollIntoViewIfNeeded(); const before = await rects(); await cards.nth(1).hover();
      await palette.waitFor({ state: 'visible' });
      assert.deepEqual(await palette.locator('button').allTextContents(), ['👍', '❤️', '😂', '😮', '😢', '🙏', '+']);
      assert.deepEqual(await rects(), before, key + ': hover must not move or resize any response');
      const box = await palette.boundingBox(); assert(box.x >= 0 && box.x + box.width <= width && box.y >= 0);
      await palette.locator('[data-rate="❤️"]').hover();
      assert.equal(await palette.evaluate(el => el.agentBar.dataset.target), 'BALTHASAR-2', 'バーへ移動しても対象が変わらない');
      await page.screenshot({ path: resolve(captures, key + '.png') });
      await palette.locator('[data-rate="❤️"]').click();
      await page.waitForFunction(() => document.querySelector('.persona-card[data-codename="BALTHASAR-2"] > .msg-reaction')?.dataset.emoji === '❤️');
      assert.equal(reactions.at(-1).target, 'BALTHASAR-2'); assert.equal(jsonRequests, 0);
      await reply.hover(); await palette.waitFor({ state: 'visible' });
      assert.equal(await palette.evaluate(el => el.agentBar.dataset.target), 'integrated');
      await palette.locator('[data-more]').click();
      await page.waitForFunction(() => document.querySelector('.emoji-option'));
      assert.equal(jsonRequests, 1); await page.keyboard.press('Escape');
      await page.mouse.move(0, 0); await page.waitForTimeout(220); assert.equal(await palette.count(), 0);
      // 回答の上端が会話欄の上に隠れていても、枠は会話欄の中に出し、ヘッダーの操作（一時チャットなど）に重ねない
      await reply.evaluate(el => {
        const log = document.getElementById('agent-log'), spacer = document.createElement('div'); spacer.id = 'hover-test-spacer'; spacer.style.cssText = 'flex: none; height: 2000px'; log.appendChild(spacer);
        log.scrollTo({ top: log.scrollTop + el.getBoundingClientRect().top - log.getBoundingClientRect().top + 40, behavior: 'instant' });
      });
      const replyBox = await reply.boundingBox(), logBox = await page.locator('#agent-log').boundingBox();
      assert(replyBox.y < logBox.y, key + ': reply top must be hidden above the chat');
      await page.mouse.move(replyBox.x + replyBox.width / 2, logBox.y + 24); await palette.waitFor({ state: 'visible' });
      const hidden = await palette.evaluate(el => {
        const r = el.getBoundingClientRect(), log = document.getElementById('agent-log').getBoundingClientRect(), temp = document.getElementById('btn-temporary-agent').getBoundingClientRect();
        return { inLog: r.top >= log.top && r.left >= log.left && r.right <= log.right,
          overTemp: !(r.right <= temp.left || r.left >= temp.right || r.bottom <= temp.top || r.top >= temp.bottom) };
      });
      assert.deepEqual(hidden, { inLog: true, overTemp: false }, key + ': hover palette stays inside the chat');
      await page.mouse.move(0, 0); await page.waitForTimeout(220); assert.equal(await palette.count(), 0);
      await reply.evaluate(() => document.getElementById('hover-test-spacer').remove());
      const access = reply.locator('[data-act="rate"]'); await access.focus(); await page.keyboard.press('Enter');
      await page.locator('.rate-pop').waitFor({ state: 'visible' });
      assert.equal(await page.locator('.rate-pop button').first().evaluate(el => el === document.activeElement), true, 'キーボードの選択中はホバー枠へ置き換えない');
      await page.keyboard.press('Escape'); assert.equal(await page.locator('.rate-pop').count(), 0);
      // ホバー枠とは別のキーボード用メニューも、最小幅のチャットで全候補とフォーカス先が見える。
      for (const panelWidth of surface === 'web' ? [220, 280, 360] : [320]) {
        if (surface === 'web') await page.evaluate(w => {
          const dock = document.getElementById('agentdock'); dock.style.transition = 'none'; dock.style.width = w + 'px';
        }, panelWidth);
        else await page.setViewportSize({ width: panelWidth, height: 1000 });
        for (const host of [cards.first(), reply]) {
          await page.mouse.move(0, 0); await host.scrollIntoViewIfNeeded();
          await host.locator('[data-act="rate"]').focus(); await page.keyboard.press('Enter');
          const pop = page.locator('.rate-pop'); await pop.waitFor({ state: 'visible' });
          assert.equal(await pop.locator('button').first().evaluate(el => el === document.activeElement), true);
          const geometry = await pop.evaluate(el => {
            const r = el.getBoundingClientRect(), log = document.getElementById('agent-log').getBoundingClientRect();
            return { menu: [r.left, r.top, r.right, r.bottom], log: [log.left, log.top, log.right, log.bottom],
              inLog: r.left >= log.left && r.right <= log.right && r.top >= log.top && r.bottom <= log.bottom,
              buttons: [...el.querySelectorAll('button')].map(b => {
                const p = b.getBoundingClientRect(); return b.contains(document.elementFromPoint(p.x + p.width / 2, p.y + p.height / 2));
              }) };
          });
          assert.equal(geometry.inLog, true, key + ': keyboard menu fits chat width ' + panelWidth + ': ' + JSON.stringify(geometry));
          assert.deepEqual(geometry.buttons, Array(7).fill(true), key + ': all keyboard choices are visible');
          await page.screenshot({ path: resolve(captures, key + '-keyboard-' + panelWidth + '.png') });
          await page.keyboard.press('Escape'); assert.equal(await pop.count(), 0);
        }
      }
      if (surface === 'web') await page.evaluate(() => document.getElementById('agentdock').style.width = '');
      else await page.setViewportSize({ width, height: 1000 });
    } else {
      await cards.first().hover(); assert.equal(await palette.count(), 0);
      const cdp = await context.newCDPSession(page);
      async function press(target) {
        await target.scrollIntoViewIfNeeded(); const r = await target.boundingBox(), x = r.x + 15, y = r.y + 15;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        await page.waitForTimeout(600); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.locator('.prompt-menu').waitFor();
      }
      await press(cards.first().locator('.persona-text').first());
      assert.equal(await page.locator('.prompt-menu [data-menu="copy"]').count(), 0);
      assert.equal(await page.locator('.prompt-menu-rate > button').count(), 7);
      await page.locator('.prompt-menu-rate [data-rate="😂"]').click(); assert.equal(reactions.at(-1).target, 'MELCHIOR-1');
      await press(reply.locator('.agent-reply-body')); assert.equal(await page.locator('.prompt-menu [data-menu="copy"]').count(), 1);
      await page.keyboard.press('Escape'); await page.screenshot({ path: resolve(captures, key + '.png') });
    }
    // DOMに札があるだけでは足りない。旧画面では位置の基準が無く、3枚ともログ下端に置かれて
    // カードのclip-pathで隠れた。3人格すべてを実際のメニューから選び、カードのそばに描かれることを確認する。
    const chosen = [['MELCHIOR-1', '👍'], ['BALTHASAR-2', '😮'], ['CASPER-3', '🙏']];
    const cdp = touch ? await context.newCDPSession(page) : null;
    for (const [codename, emoji] of chosen) {
      const card = page.locator('.persona-card[data-codename="' + codename + '"]');
      if (touch) {
        const text = card.locator('.persona-text').first(); await text.scrollIntoViewIfNeeded();
        const r = await text.boundingBox(), x = r.x + 15, y = r.y + 15;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        await page.waitForTimeout(600); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else await card.hover();
      await page.locator((touch ? '.prompt-menu-rate' : '.agent-hover-reactions') + ' [data-rate="' + emoji + '"]').click();
      await page.waitForFunction(({ codename, emoji }) => {
        const item = agentHistory.find(it => it.mid === 'm_hover_fixture'), reaction = item && item.reactions && item.reactions[codename];
        return reaction && reaction.em === emoji && reaction.id;
      }, { codename, emoji });
      assert.equal(reactions.at(-1).target, codename);
    }
    if (cdp) await cdp.detach();
    async function assertPersonaBadges() {
      for (const [codename, emoji] of chosen) {
        const badge = page.locator('.persona-card[data-codename="' + codename + '"] > .msg-reaction');
        await badge.scrollIntoViewIfNeeded(); assert.equal(await badge.isVisible(), true, key + ': ' + codename);
        const paint = await badge.evaluate(b => {
          const r = b.getBoundingClientRect(), card = b.parentElement.getBoundingClientRect(), log = document.getElementById('agent-log').getBoundingClientRect();
          return { emoji: b.dataset.emoji, glyph: getComputedStyle(b, '::before').content,
            besideCard: r.left >= card.left && r.right <= card.right && r.top >= card.top && r.bottom <= card.bottom + r.height,
            inLog: r.left >= log.left && r.right <= log.right && r.top >= log.top && r.bottom <= log.bottom };
        });
        assert.equal(paint.emoji, emoji); assert.equal(paint.glyph, JSON.stringify(emoji));
        assert.equal(paint.besideCard, true, key + ': ' + codename + ' badge must stay beside its card');
        assert.equal(paint.inLog, true, key + ': ' + codename + ' badge must be in the visible log');
      }
    }
    await assertPersonaBadges();
    await page.reload();
    if (surface === 'web') await page.waitForFunction(() => !document.getElementById('input-line').classList.contains('hidden'));
    if (surface === 'web' && await page.locator('#agentdock').evaluate(el => el.classList.contains('collapsed'))) await page.locator('#activitybar [data-act="agent"]').click();
    await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme);
    await assertPersonaBadges();
    await page.locator('.persona-card').first().scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0); await page.waitForTimeout(220);
    await page.screenshot({ path: resolve(captures, key + '-badges.png') });
    assert.deepEqual(errors, [], key); await context.close();
  }
  console.log(JSON.stringify({ pass: true, cases: cases.length, paidRequests: 0, captures }));
} finally { await browser.close(); }
