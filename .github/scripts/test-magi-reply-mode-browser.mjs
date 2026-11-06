// 返答のモード（討議 / 高速）・回答を待つ間の考え直し・話題の絵文字の実画面。トップページ（1280px）とアプリ（390px・320px）で、
// 固定のSSEとWorkerの模擬を使い、次を確かめる。AI・計測は呼ばない。
// - 入力欄の「討議 ∨」でモードを選べ、選んだモードを端末に保存する。高速の送信は reply_mode:'fast' を送り、人格の枠を出さず、
//   履歴に mode:'fast' を残す（開き直しても人格の枠を出さない）
// - 回答を待つ間も入力欄に打て、文字があれば■が送信ボタンに替わる。押すと今の回答を止め、送信中の質問と追加の文を1つにまとめて送り直す
// - 統合人格の絵文字は一覧の外（🎃）でも1つなら付く（prompt_reaction_open:true を送る）
// node .github/scripts/test-magi-reply-mode-browser.mjs [リポジトリのパス] [--screenshots]
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '.');
const shots = process.argv.includes('--screenshots');
const event = (ev, data) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`;
const classification = { version: 1, intent: 'consult', mode: 'consult', fresh: 'no', votable: 'no', site_pages: 'no', magi_candidate: false, reply_language: { version: 1, code: 'ja', source: 'ui' } };
const server = createServer((req, res) => {
  let path = new URL(req.url, 'http://localhost').pathname; if (path.endsWith('/')) path += 'index.html';
  const file = resolve(root, '.' + path);
  if (!file.startsWith(root + sep) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json' })[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ headless: true });
const until = async (check, label) => { for (let i = 0; i < 300; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('timeout: ' + label); };
const captures = resolve(root, 'workers/.wrangler/magi2-reply-mode/captures');
if (shots) mkdirSync(captures, { recursive: true });
let checked = 0;
try {
  for (const [name, path, width] of [['home', '/', 1280], ['app', '/magi-app/www/', 390], ['app-320', '/magi-app/www/', 320]]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ja-JP', serviceWorkers: 'block' });
    const page = await context.newPage(), errors = [], bodies = [];
    let hold = null; // 次の /magi2/chat を止めておく（回答を待つ間の状態を作る）
    let fail = 0; // 次の /magi2/chat を通信エラーにする回数
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => { localStorage.setItem('st-analytics', 'off'); sessionStorage.setItem('magi_transport', 'sse'); });
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      const headers = { 'Access-Control-Allow-Origin': origin };
      if (url.pathname === '/magi2/models') { await route.fulfill({ json: { personas: {}, synthesizer: {}, features: { speech: false } }, headers }); return; }
      if (url.pathname === '/magi2/usage') { await route.fulfill({ json: { used: 1, limit: 60, day: '2026-11-06', resets_at: '2026-11-07T00:00:00Z', global_full: false }, headers }); return; }
      if (url.pathname === '/magi2/chat') {
        const body = JSON.parse(route.request().postData()); bodies.push(body);
        if (hold) { const wait = hold; hold = null; await wait; await route.fulfill({ contentType: 'text/event-stream', headers, body: event('done', {}) }).catch(() => {}); return; }
        if (fail) { fail--; await route.abort('failed').catch(() => {}); return; }
        const fast = body.reply_mode === 'fast';
        const persona = fast ? '' : ['MELCHIOR-1', 'BALTHASAR-2', 'CASPER-3'].map(codename => event('persona', { round: 1, codename, name: codename, text: '意見' })
          + event('persona', { round: 2, codename, name: codename, text: '討議後' })).join('');
        await route.fulfill({ contentType: 'text/event-stream', headers, body: ': padding\n\n' + event('classification', classification) + persona
          + event('prompt_reaction', { emoji: '🎃' }) + event('integrated', { delta: fast ? '高速の答え' : '討議の答え' }) + event('done', {}) });
        return;
      }
      if (url.origin !== origin) { await route.fulfill({ status: 204, body: '' }); return; }
      await route.continue();
    });
    await page.goto(origin + path, { waitUntil: 'domcontentloaded' });
    if (name === 'home' && !(await page.locator('#agentdock:not(.collapsed)').count())) await page.locator('#activitybar [data-act="agent"]').click();
    const mode = page.locator('#agent-mode'), menu = page.locator('#agent-mode-menu');
    const done = async label => until(async () => (await page.locator('.agent-reply.streaming').count()) === 0 && !(await page.locator('#agent-send').getAttribute('data-stop')), label);

    // 既定は「討議」。入力欄の中に収まり、ページを横に溢れさせない（文言は画面の言語に従う）
    await mode.waitFor();
    const ja = (await page.evaluate(() => document.documentElement.lang)) === 'ja';
    const label = (jaText, en) => ja ? jaText : en;
    assert.equal((await mode.innerText()).trim(), label('討議', 'Debate'), name);
    const box = await page.evaluate(() => {
      const c = document.getElementById('agent-composer').getBoundingClientRect(), m = document.getElementById('agent-mode').getBoundingClientRect(), s = document.getElementById('agent-send').getBoundingClientRect();
      return { inside: m.left >= c.left && m.right <= c.right && m.bottom <= c.bottom + 1, beforeSend: m.right <= s.left + 1, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    assert.deepEqual(box, { inside: true, beforeSend: true, overflow: false }, name);

    // 討議：人格の枠を出し、reply_mode は送らない。絵文字は一覧の外（🎃）でも付く
    await page.locator('#agent-input').fill('ハロウィンの仮装を相談したい');
    await page.locator('#agent-send').click();
    await done(name + ' debate');
    assert.equal(bodies.at(-1).reply_mode, undefined); assert.equal(bodies.at(-1).prompt_reaction_open, true);
    assert.equal(await page.locator('.agent-turn').last().locator('.persona-card').count(), 3, name);
    await until(async () => (await page.locator('.agent-user').last().locator('.prompt-reaction').count()) === 1, name + ' reaction');
    const badge = await page.locator('.agent-user').last().locator('.prompt-reaction').evaluate(el => el.outerHTML + getComputedStyle(el, '::before').content + getComputedStyle(el, '::after').content);
    assert.ok(badge.includes('🎃'), name + ' 🎃 ' + badge);

    // Shinya Takeda の絵文字を押すと同じ絵文字で重なり（「🎃 2」）、もう一度押すと取り消す。端末の履歴にだけ残し、送信しない
    const pr = page.locator('.agent-user').last().locator('.prompt-reaction');
    const prState = async () => pr.evaluate(el => ({ text: getComputedStyle(el, '::before').content.replaceAll(String.fromCharCode(160), ' '), pressed: el.getAttribute('aria-pressed'), joined: el.dataset.count === ' 2' ? '1' : null }));
    // 重ねた絵文字は、質問への自分のリアクション（質問の項目の reactions.prompt）として端末に保存する
    const savedJoined = async () => page.evaluate(() => JSON.parse(localStorage.getItem('magi_current_history')).find(m => m.role === 'user').reactions?.prompt?.em === '🎃');
    const sentBefore = bodies.length;
    assert.deepEqual(await prState(), { text: '"🎃"', pressed: 'false', joined: null }, name + ' badge before');
    await pr.click();
    assert.deepEqual(await prState(), { text: '"🎃 2"', pressed: 'true', joined: '1' }, name + ' joined');
    assert.equal(await savedJoined(), true, name + ' joined saved');
    if (shots) { // 弾むアニメーションが終わってから、吹き出しと札の周りだけを撮る
      await page.waitForTimeout(800);
      const b = await page.locator('.agent-user').last().boundingBox();
      await page.screenshot({ path: resolve(captures, name + '-joined.png'), clip: { x: Math.max(0, b.x - 20), y: Math.max(0, b.y - 10), width: Math.min(width - Math.max(0, b.x - 20), b.width + 40), height: b.height + 40 } });
    }
    await pr.click();
    assert.deepEqual(await prState(), { text: '"🎃"', pressed: 'false', joined: null }, name + ' undone');
    assert.equal(await savedJoined(), false, name + ' undone saved');
    await pr.focus(); await page.keyboard.press('Enter');
    assert.equal((await prState()).joined, '1', name + ' keyboard');
    assert.equal(await page.locator('.agent-msg-menu, .prompt-menu').count(), 0, name + ' no bubble menu');
    assert.equal(bodies.length, sentBefore, name + ' nothing sent');

    // 高速を選ぶ：メニューから選んで印が替わり、端末に保存する
    await mode.click(); await menu.waitFor();
    if (shots) await page.screenshot({ path: resolve(captures, name + '-menu.png') });
    await menu.locator('[data-mode="fast"]').click();
    assert.equal(await menu.isHidden(), true); assert.equal((await mode.innerText()).trim(), label('高速', 'Fast'), name);
    assert.equal(await page.evaluate(() => localStorage.getItem('magi_reply_mode')), 'fast');
    await page.locator('#agent-input').fill('ジャズを聴き始めたい');
    await page.locator('#agent-send').click();
    await done(name + ' fast');
    assert.equal(bodies.at(-1).reply_mode, 'fast'); assert.equal(bodies.at(-1).classification_state, true);
    assert.ok(!JSON.stringify(bodies.at(-1).messages).includes('prompt_reaction'), name + ' no reaction in history');
    assert.equal(await page.locator('.agent-turn').last().locator('.persona-card').count(), 0, name + ' no persona cards');
    assert.match(await page.locator('.agent-reply-body').last().innerText(), /高速の答え/);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('magi_current_history')));
    assert.equal(saved.at(-1).mode, 'fast'); assert.equal(saved.at(-1).debate, undefined);
    if (shots) await page.screenshot({ path: resolve(captures, name + '-fast.png') });

    // 考え直し：回答を待つ間も打て、文字があれば■が送信ボタンに替わる。押すと止めて、まとめて送り直す
    let release; hold = new Promise(r => { release = r; });
    await page.locator('#agent-input').fill('京都で週末に行く場所');
    await page.locator('#agent-send').click();
    await until(async () => (await page.locator('#agent-send').getAttribute('data-stop')) === '1', name + ' busy');
    assert.equal(await page.locator('#agent-input').isDisabled(), false, name + ' input open while waiting');
    assert.equal(await page.locator('#agent-send').getAttribute('data-rethink'), '', name + ' stop while empty');
    await page.locator('#agent-input').fill('雨の日でも楽しめる所で');
    await until(async () => (await page.locator('#agent-send').getAttribute('data-rethink')) === '1', name + ' rethink button');
    assert.equal(await page.locator('#agent-send').getAttribute('title'), label('送信して考え直す', 'Send and rethink'));
    await page.mouse.move(1, 1); // 押した後のマウスがボタンに乗ったまま（:hover）だと薄く見える
    await until(async () => (await page.locator('#agent-send').evaluate(b => getComputedStyle(b).opacity)) === '1', name + ' opacity settled');
    assert.deepEqual(await page.locator('#agent-send').evaluate(b => [b.disabled, b.classList.contains('is-empty'), getComputedStyle(b).opacity]), [false, false, '1'], name + ' rethink button enabled');
    if (shots) await page.screenshot({ path: resolve(captures, name + '-rethink.png') });
    const before = bodies.length;
    await page.locator('#agent-send').click();
    await until(async () => bodies.length === before + 1, name + ' resent');
    release();
    await done(name + ' rethink');
    const merged = bodies.at(-1).messages.at(-1).content;
    assert.equal(merged, '京都で週末に行く場所\n\n雨の日でも楽しめる所で', name);
    assert.equal(bodies.at(-1).reply_mode, 'fast');
    assert.equal(await page.locator('#agent-input').inputValue(), '', name + ' input cleared');
    const users = await page.locator('.agent-user').allInnerTexts();
    assert.equal(users.length, 3, name + ' one bubble for the merged question');
    assert.match(users.at(-1), /京都で週末に行く場所[\s\S]*雨の日でも楽しめる所で/);
    const history = await page.evaluate(() => JSON.parse(localStorage.getItem('magi_current_history')));
    assert.deepEqual(history.map(m => m.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant'], name);

    // 考え直しの送り直しが失敗しても、まとめた質問は入力欄に戻る（消えない）
    const failed = async label => until(async () => (await page.locator('#agent-send').getAttribute('data-stop')) !== '1' && (await page.locator('.agent-user').count()) === 3, label);
    hold = new Promise(r => { release = r; });
    await page.locator('#agent-input').fill('週末の予定');
    await page.locator('#agent-send').click();
    await until(async () => (await page.locator('#agent-send').getAttribute('data-stop')) === '1', name + ' busy 2');
    await page.locator('#agent-input').fill('雨なら室内で');
    await until(async () => (await page.locator('#agent-send').getAttribute('data-rethink')) === '1', name + ' rethink button 2');
    fail = 1;
    await page.locator('#agent-send').click();
    release();
    await failed(name + ' rethink failed');
    assert.equal(await page.locator('#agent-input').inputValue(), '週末の予定\n\n雨なら室内で', name + ' merged question kept after failure');
    await page.locator('.agent-err').evaluateAll(list => list.forEach(el => el.remove()));

    // 待つ間に打った下書きがあるときに送信が失敗したら、質問の後ろに下書きをつないで戻す
    await page.locator('#agent-input').fill('夕食の候補');
    hold = new Promise(r => { release = r; });
    await page.locator('#agent-send').click();
    await until(async () => (await page.locator('#agent-send').getAttribute('data-stop')) === '1', name + ' busy 3');
    await page.locator('#agent-input').fill('辛くないもの');
    await page.route('**/magi2/chat', route => route.abort('failed'));
    release();
    await failed(name + ' draft failure');
    await page.unroute('**/magi2/chat');
    assert.equal(await page.locator('#agent-input').inputValue(), '夕食の候補\n\n辛くないもの', name + ' question and draft kept');
    await page.locator('.agent-err').evaluateAll(list => list.forEach(el => el.remove()));
    await page.locator('#agent-input').fill('');

    // 開き直しても、高速の回答には人格の枠を出さず、討議の回答には出す
    await page.reload({ waitUntil: 'domcontentloaded' });
    if (name === 'home' && !(await page.locator('#agentdock:not(.collapsed)').count())) await page.locator('#activitybar [data-act="agent"]').click();
    await until(async () => (await page.locator('.agent-turn').count()) === 3, name + ' restored');
    assert.deepEqual(await page.locator('.agent-turn').evaluateAll(list => list.map(t => t.querySelectorAll('.persona-card').length)), [3, 0, 0], name);
    assert.equal((await page.locator('#agent-mode').innerText()).trim(), label('高速', 'Fast'), name + ' mode kept');
    // 重ねた絵文字は開き直しても「🎃 2」のまま
    assert.equal(await page.locator('.agent-user').first().locator('.prompt-reaction').evaluate(el => getComputedStyle(el, '::before').content.replaceAll(String.fromCharCode(160), ' ') + el.getAttribute('aria-pressed')), '"🎃 2"true', name + ' joined restored');
    assert.deepEqual(errors, [], name);
    await context.close();
    checked++;
  }
  console.log(`ok: ${checked} screens`);
} finally {
  await browser.close();
  server.close();
}
