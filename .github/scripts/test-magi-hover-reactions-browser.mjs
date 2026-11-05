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
      log.appendChild((typeof userBubbleEl === 'function' ? userBubbleEl : agentUserEl)('週末、少し気分を変えたい。', Date.now()));
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
      assert.deepEqual(await palette.locator('button').allTextContents(), ['👍', '❤️', '😂', '😮', '😢', '🙏', '+', '']);
      assert.equal(await palette.locator('[role="separator"]').count(), 1);
      assert((await palette.boundingBox()).height <= 36, key + ': compact desktop toolbar');
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
          await host.hover(); await palette.waitFor({ state: 'visible' });
          const narrow = await palette.evaluate(el => {
            const r = el.getBoundingClientRect(), log = document.getElementById('agent-log').getBoundingClientRect();
            return { fits: r.left >= log.left && r.right <= log.right, menu: [r.left, r.right], log: [log.left, log.right], maxWidth: el.style.maxWidth };
          });
          assert.equal(narrow.fits, true, key + ': hover toolbar fits narrow chat ' + panelWidth + ': ' + JSON.stringify(narrow));
          await page.mouse.move(0, 0); await page.waitForTimeout(220);
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
    // 自分のプロンプトにも同じ操作バーを出す。同じ絵文字はまとめ、自分の分だけ取り消す。
    const user = page.locator('.agent-user').first();
    async function react(host, emoji) {
      if (!touch) { await page.mouse.move(0, 0); await page.waitForTimeout(220); }
      await host.scrollIntoViewIfNeeded();
      if (touch) {
        const cdp = await context.newCDPSession(page), r = await host.boundingBox();
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x + r.width - 25, y: r.y + 12 }] });
        await page.waitForTimeout(600); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await cdp.detach();
      } else await host.hover();
      await page.locator((touch ? '.prompt-menu-rate' : '.agent-hover-reactions') + (emoji === '+' ? ' [data-more]' : ' [data-rate="' + emoji + '"]')).click();
      // 長押しから離した直後の合成clickを捨てる期間を過ぎてから、次のタップを行う。
      await page.waitForTimeout(450);
    }
    await page.evaluate(() => {
      const user = document.querySelector('.agent-user'), item = agentHistory.find(it => it.role === 'assistant');
      item.prompt_reaction = '👍';
      agentReactionBadge(user, 'prompt-reaction', '👍', false, 'Shinya Takeda'); persistReactions();
    });
    const beforePrompt = reactions.length;
    await react(user.locator(':scope > span'), '👍');
    assert.equal(reactions.length, beforePrompt, 'own prompt reaction is stored with the conversation, not sent as an answer rating');
    await page.evaluate(() => renderHistoryToLog(agentHistory));
    const promptBadge = user.locator('.prompt-reaction');
    assert.equal(await promptBadge.count(), 1);
    assert.equal(await promptBadge.getAttribute('data-count'), ' 2');
    assert.equal(await promptBadge.getAttribute('aria-pressed'), 'true');
    assert((await promptBadge.getAttribute('aria-label')).includes('Shinya Takeda'));
    if (!touch) {
      await user.hover(); await palette.locator('[data-rate="❤️"]').hover();
      const selected = await palette.locator('[data-rate="👍"]').evaluate(el => ({
        transform: getComputedStyle(el).transform, shadow: getComputedStyle(el).boxShadow,
        underline: getComputedStyle(el, '::after').height, background: getComputedStyle(el, '::after').backgroundColor,
      }));
      assert.equal(selected.transform, 'none'); assert.equal(selected.shadow, 'none'); assert.equal(selected.underline, '3px');
      assert.equal(selected.background, theme === 'dark' ? 'rgb(74, 222, 128)' : 'rgb(21, 128, 61)');
      for (const host of [user, reply, cards.first()]) {
        await host.scrollIntoViewIfNeeded(); await host.hover();
        const more = palette.locator('[data-actions]'); await more.hover();
        assert.equal(await page.locator('.message-actions-menu').count(), 0, 'ellipsis opens only on click');
        await more.click();
        const menu = page.locator('.message-actions-menu'); await menu.waitFor();
        assert.deepEqual(await menu.locator('[data-menu]').evaluateAll(list => list.map(b => b.dataset.menu)), ['copy', 'select', 'share']);
        await menu.locator('[data-menu="copy"]').focus();
        await page.keyboard.press('Escape');
        assert.equal(await more.evaluate(el => el === document.activeElement), true, 'Escape returns focus to the ellipsis');
        await page.keyboard.press('Enter'); await menu.waitFor();
        assert((await menu.boundingBox()).y >= (await more.boundingBox()).y + (await more.boundingBox()).height);
        const option = await menu.locator('[data-menu="select"]').boundingBox();
        await page.mouse.move(option.x + option.width / 2, option.y + option.height / 2, { steps: 12 });
        await page.waitForTimeout(250); assert.equal(await menu.isVisible(), true, 'menu stays open while choosing an action');
        if (host === user) await page.screenshot({ path: resolve(captures, key + '-prompt-menu.png') });
        await menu.locator('[data-menu="select"]').click();
        assert((await page.evaluate(() => getSelection().toString())).length > 0, key + ': select text from ' + await host.getAttribute('class'));
        if (host === user) {
          await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://tk.st' });
          await page.mouse.move(0, 0); await page.waitForTimeout(220); await user.hover();
          await more.click(); await menu.locator('[data-menu="copy"]').click();
          await page.waitForFunction(() => document.querySelector('.agent-toast'));
          assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '週末、少し気分を変えたい。');
          await page.mouse.move(0, 0); await page.waitForTimeout(220); await user.hover();
          await more.click();
          const [download] = await Promise.all([page.waitForEvent('download'), menu.locator('[data-menu="share"]').click()]);
          assert.match(download.suggestedFilename(), /\.png$/); await download.delete();
        }
        await page.keyboard.press('Escape');
      }
      // 回答の共有は、出典付きの完全な本文を使う。長文は省略画像にせず全文コピーへ戻す。
      await page.evaluate(() => {
        const item = agentHistory.find(it => it.role === 'assistant');
        window.shareFixture = { content: item.content, sources: item.sources };
        item.content = '出典付きの回答です。';
        item.sources = { items: [{ n: 1, url: 'https://example.com/source', title: '検証用の出典' }], marks: [{ n: 1, at: item.content.length }] };
        window.shareRenderOriginal = MagiShareImage.render;
        MagiShareImage.render = options => { window.shareRenderOptions = options; return shareRenderOriginal(options); };
      });
      async function openReplyShare() {
        await page.mouse.move(0, 0); await page.waitForTimeout(220); await reply.hover();
        await palette.locator('[data-actions]').click();
      }
      await openReplyShare();
      const [image] = await Promise.all([page.waitForEvent('download'), page.locator('.message-actions-menu [data-menu="share"]').click()]);
      await image.delete();
      const shared = await page.evaluate(() => shareRenderOptions);
      assert(shared.text.includes('https://example.com/source')); assert.equal(shared.truncate, false);
      await page.evaluate(() => { agentHistory.find(it => it.role === 'assistant').content = '省略しない長文の回答。'.repeat(2200) + '長文の終端'; });
      await openReplyShare(); await page.locator('.message-actions-menu [data-menu="share"]').click();
      await page.waitForFunction(async () => (await navigator.clipboard.readText()).includes('長文の終端'));
      const full = await page.evaluate(() => navigator.clipboard.readText());
      assert(full.includes('https://example.com/source'));
      await page.evaluate(() => {
        Object.assign(agentHistory.find(it => it.role === 'assistant'), shareFixture);
        MagiShareImage.render = shareRenderOriginal;
      });
    }
    if (touch) await promptBadge.tap(); else await promptBadge.click();
    assert.equal(await promptBadge.count(), 1); assert.equal(await promptBadge.getAttribute('data-count'), '');
    assert.equal(await promptBadge.isDisabled(), true, 'Shinya Takeda reaction remains');
    await react(user.locator(':scope > span'), '❤️');
    assert.equal(await promptBadge.count(), 2);
    assert.deepEqual(await promptBadge.evaluateAll(list => list.map(b => b.dataset.count)), ['', '']);
    // AI回答の札そのものを押して取り消し、所有トークン付きの削除を送る。
    await react(reply.locator('.agent-reply-body'), '👍');
    const replyBadge = reply.locator('.msg-reaction');
    await page.waitForFunction(() => agentHistory.find(it => it.role === 'assistant').reactions?.integrated?.id);
    assert.equal(await replyBadge.getAttribute('data-count'), '');
    if (touch) await replyBadge.tap(); else await replyBadge.click();
    await replyBadge.waitFor({ state: 'detached' });
    assert.equal(reactions.at(-1).op, 'remove'); assert.equal(reactions.at(-1).target, 'integrated');
    await page.reload();
    if (surface === 'web') await page.waitForFunction(() => !document.getElementById('input-line').classList.contains('hidden'));
    if (surface === 'web' && await page.locator('#agentdock').evaluate(el => el.classList.contains('collapsed'))) await page.locator('#activitybar [data-act="agent"]').click();
    await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme);
    await assertPersonaBadges();
    assert.deepEqual(await page.locator('.agent-user .prompt-reaction').evaluateAll(list => list.map(b => [b.dataset.emoji, b.dataset.count, b.disabled])), [['❤️', '', false], ['👍', '', true]], 'prompt reactions survive reload');
    await react(user.locator(':scope > span'), '+');
    await page.locator('.emoji-option[data-emoji="❤️"]').click();
    assert.deepEqual(await promptBadge.evaluateAll(list => list.map(b => [b.dataset.emoji, b.dataset.count, b.disabled])), [['👍', '', true]], 'full emoji picker also toggles own prompt reaction');
    await page.locator('.persona-card').first().scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0); await page.waitForTimeout(220);
    await page.screenshot({ path: resolve(captures, key + '-badges.png') });
    // 長文へ伸びた後も、3人格の輪郭と塗りを一つの閉じたパスで描く。
    await page.evaluate(() => document.querySelectorAll('.persona-card').forEach((card, index) => {
      card.querySelector('.persona-text').textContent = 'DJブースで曲の振り切りどころを見極め、フロアの熱と一体感を生み出す。'.repeat(index + 2);
      const later = card.querySelector('[data-round="2"]'); later.hidden = false;
      later.querySelector('.persona-text').textContent = '手元と機材周りは清潔に保ち、曲をつなぐ瞬間を大切にする。'.repeat(index + 2);
    }));
    await page.waitForFunction(() => [...document.querySelectorAll('.persona-card')].every(card => card.querySelector('.persona-cloud')?.dataset.size === card.clientWidth + ' ' + card.clientHeight));
    for (const card of await cards.all()) {
      assert.equal(await card.locator(':scope > .persona-cloud path').count(), 1);
      const cloud = await card.evaluate(el => {
        const path = el.querySelector('.persona-cloud path'), box = path.getBBox();
        return { closed: path.getAttribute('d').endsWith(' Z'), inside: box.x >= 0 && box.y >= 0 && box.x + box.width <= el.clientWidth && box.y + box.height <= el.clientHeight,
          mask: getComputedStyle(el, '::before').content };
      });
      assert.deepEqual(cloud, { closed: true, inside: true, mask: 'none' });
    }
    await cards.first().screenshot({ path: resolve(captures, key + '-cloud-fixed.png') });
    // 受信中（回答の履歴がまだ無い状態）の質問への反応も、再読み込みで失わない。
    await page.evaluate(async () => {
      closeRatePops(false); closePromptMenu();
      agentHistory = agentHistory.filter(it => it.role === 'user');
      document.querySelector('.agent-reply').classList.add('streaming');
      await rateReply(document.querySelector('.agent-user .reaction-bar'), '🔥');
    });
    await page.reload();
    await page.waitForFunction(() => document.querySelector('.agent-user .prompt-reaction')?.dataset.emoji === '🔥');
    assert.equal(await page.locator('.agent-user .prompt-reaction').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(errors, [], key); await context.close();
  }
  console.log(JSON.stringify({ pass: true, cases: cases.length, paidRequests: 0, captures }));
} finally { await browser.close(); }
