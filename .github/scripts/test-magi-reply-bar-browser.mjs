// 読み上げ設計の公開C1の実画面（読み上げ検証計画§2.1〜2.3）。トップページ（ライト・ダーク）とアプリ（390px・320px）で、
// 固定のSSEとWorkerの模擬を使い、操作列の並び・枠の無いボタン・日時・ソースの一覧・共有・読み上げの再生と停止・
// ［もう一度］（成功と失敗）・評価（Good / Bad の付け替え）・履歴からの復元を確かめる。
// AI・Fish Audio・計測は呼ばない。node .github/scripts/test-magi-reply-bar-browser.mjs [リポジトリのパス] [--screenshots]
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '.');
const event = (ev, data) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`;
const SIG = 'ab'.repeat(32);
const answer = '公式の案内では、開館は9時です。休館日は月曜です。';
// 16x16 の PNG（1色）。Worker が付けるアイコンと同じ data: URL の形
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==';
const sources = { items: [{ n: 1, title: '公式サイト', url: 'https://www.example.com/hours', icon: PNG }, { n: 2, title: 'お知らせ', url: 'https://news.example.org/a' }],
  marks: [{ at: 16, n: 1 }, { at: 25, n: 2 }] };
// 0.2秒の無音の WAV（読み上げの区切りの代わり。Chromium で鳴らせる形）
function wav(ms = 200) {
  const samples = Math.round(8000 * ms / 1000), b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples * 2, 40);
  return b;
}
const server = createServer((req, res) => {
  let path = new URL(req.url, 'http://localhost').pathname; if (path.endsWith('/')) path += 'index.html';
  const file = resolve(root, '.' + path);
  if (!file.startsWith(root + sep) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json' })[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const until = async (check, label) => { for (let i = 0; i < 300; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('timeout: ' + label); };
const captures = resolve(root, 'workers/.wrangler/magi2-speech/captures');
let checked = 0;
try {
  // 読み上げを止めていて出典の無い回答: PC で見えるのは［コピー］［もう一度］［評価］と日時だけで、空の枠を残さない。
  // 書いている途中のカーソルは本文の末尾に付き、操作列の下には出ない
  for (const [name, path, width] of [['home-off', '/', 1280], ['app-off', '/magi-app/www/', 390]]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ja-JP', serviceWorkers: 'block' });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => { localStorage.setItem('st-analytics', 'off'); sessionStorage.setItem('magi_transport', 'sse'); });
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/magi2/models') { await route.fulfill({ json: { personas: {}, synthesizer: {}, features: { speech: false } }, headers: { 'Access-Control-Allow-Origin': origin } }); return; }
      if (url.pathname === '/magi2/usage') { await route.fulfill({ json: { used: 1, limit: 60, day: '2026-10-23', resets_at: '2026-10-24T00:00:00Z', global_full: false }, headers: { 'Access-Control-Allow-Origin': origin } }); return; }
      if (url.pathname === '/magi2/chat') {
        await route.fulfill({ contentType: 'text/event-stream', headers: { 'Access-Control-Allow-Origin': origin }, body: ': padding\n\n'
          + event('classification', { version: 1, intent: 'research', mode: 'fact', fresh: 'no', votable: 'no', site_pages: 'no', magi_candidate: false, reply_language: { version: 1, code: 'ja', source: 'ui' } })
          + event('integrated', { delta: answer }) + event('done', {}) });
        return;
      }
      if (url.origin !== origin) { await route.fulfill({ status: 204, body: '' }); return; }
      await route.continue();
    });
    await page.goto(origin + path, { waitUntil: 'domcontentloaded' });
    if (name.startsWith('home') && !(await page.locator('#agentdock:not(.collapsed)').count())) await page.locator('#activitybar [data-act="agent"]').click();
    await page.locator('#agent-input').fill('開館時間を教えて');
    await page.locator('#agent-send').click();
    const bar = page.locator('.agent-reply .reply-bar').last();
    await until(async () => (await page.locator('.agent-reply.streaming').count()) === 0 && (await bar.count()) === 1, 'reply done');
    await page.waitForTimeout(300);
    assert.deepEqual(await bar.locator('button:visible').evaluateAll(list => list.map(b => b.dataset.act)), ['copy', 'retry', 'rate'], name);
    // ボタンは枠で囲わない。日時は操作列に出さない（プロンプトを送った時刻を、PC は会話の最上部、スマホは長押しのメニューに出す）
    for (const border of await bar.locator('button:visible').evaluateAll(list => list.map(b => getComputedStyle(b).borderTopColor))) assert.equal(border, 'rgba(0, 0, 0, 0)', name + ' border');
    assert.equal(await bar.locator('time.reply-time').count(), 0, name + ' no reply time');
    const cursor = await page.evaluate(() => {
      const reply = [...document.querySelectorAll('.agent-reply')].at(-1), body = reply.querySelector('.agent-reply-body');
      reply.classList.add('streaming');
      const out = { body: getComputedStyle(body, '::after').content, reply: getComputedStyle(reply, '::after').content };
      reply.classList.remove('streaming');
      return out;
    });
    assert.equal(cursor.body, '"\u{258C}"', name + ' cursor on body'); assert.equal(cursor.reply, 'none', name + ' no cursor below the bar');
    if (process.argv.includes('--screenshots')) { mkdirSync(captures, { recursive: true }); await page.screenshot({ path: resolve(captures, name + '-bar.png'), animations: 'disabled' }); }
    assert.deepEqual(errors, [], name + ' page errors');
    await context.close();
    checked++;
  }
  for (const [name, path, width, lang] of [['home-light', '/', 1280, 'ja-JP'], ['home-dark', '/', 1280, 'en-US'], ['home-touch', '/', 390, 'en-US'], ['app', '/magi-app/www/', 390, 'ja-JP'], ['app-320', '/magi-app/www/', 320, 'en-US']]) {
    // アプリの画面はスマホ相当（指で操作する端末）。共有シートはこのときだけ使い、PC ではコピーする
    const touch = name === 'home-touch' || !name.startsWith('home');
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: lang, serviceWorkers: 'block', isMobile: touch, hasTouch: touch });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    const page = await context.newPage(), errors = [], external = [], speech = [], chats = [], reacts = [];
    let chatFails = false, speechDelay = 0;
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
      (localStorage.setItem('st-analytics', 'off'),sessionStorage.setItem('magi_transport','sse'));
      window.__shared = [];
      Object.defineProperty(navigator, 'share', { configurable: true, value: data => { window.__shared.push(data); return Promise.resolve(); } });
    });
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname === '/magi2/models') { await route.fulfill({ json: { personas: {}, synthesizer: {}, features: { speech: true } }, headers: { 'Access-Control-Allow-Origin': origin } }); return; }
      if (url.pathname === '/magi2/usage') { await route.fulfill({ json: { used: 1, limit: 60, day: '2026-10-23', resets_at: '2026-10-24T00:00:00Z', global_full: false }, headers: { 'Access-Control-Allow-Origin': origin } }); return; }
      if (url.pathname === '/magi2/chat') {
        chats.push(JSON.parse(request.postData()));
        if (chatFails) { await route.fulfill({ status: 500, json: { error: { message: 'boom', code: 'internal' } }, headers: { 'Access-Control-Allow-Origin': origin } }); return; }
        await route.fulfill({ contentType: 'text/event-stream', headers: { 'Access-Control-Allow-Origin': origin }, body: ': padding\n\n'
          + event('classification', { version: 1, intent: 'research', mode: 'fact', fresh: 'yes', votable: 'no', site_pages: 'no', magi_candidate: false, reply_language: { version: 1, code: 'ja', source: 'ui' } })
          + event('integrated', { delta: chats.length > 1 ? answer.replace('9時', '9時半') : answer }) + event('sources', sources) + event('speech', { sig: SIG, lang: 'ja' }) + event('done', {}) });
        return;
      }
      if (url.pathname === '/magi2/react') {
        const body = JSON.parse(request.postData()); reacts.push(body);
        await route.fulfill({ json: body.op === 'remove' ? { ok: true, deleted: 1 } : { id: reacts.length, delete_token: 'c'.repeat(64) }, headers: { 'Access-Control-Allow-Origin': origin } });
        return;
      }
      if (url.pathname === '/magi2/speech') {
        const body = JSON.parse(request.postData()); speech.push(body);
        if (speechDelay) await new Promise(r => setTimeout(r, speechDelay));
        await route.fulfill({ status: 200, body: wav(), headers: { 'Content-Type': 'audio/mpeg', 'X-Speech-Parts': '2', 'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': 'X-Speech-Parts' } });
        return;
      }
      if (url.origin !== origin) { external.push(url.origin + url.pathname); await route.fulfill({ status: 204, body: '' }); return; }
      await route.continue();
    });
    await page.goto(origin + path, { waitUntil: 'domcontentloaded' });
    const home = name.startsWith('home');
    if (home && !(await page.locator('#agentdock:not(.collapsed)').count())) await page.locator('#activitybar [data-act="agent"]').click();
    if (name === 'home-dark') await page.locator('[data-act="settings"]').click();
    await page.locator('#agent-input').fill('開館時間を確認して');
    const sentAt = external.length;
    await page.locator('#agent-send').click();
    const bar = page.locator('.agent-reply .reply-bar').last();
    await until(async () => (await bar.locator('[data-act="sources"]:not([hidden])').count()) === 1, 'sources button');
    // スマホ（指の端末）は操作列を隠し、回答の長押しのメニューから同じ操作をする。PC は操作列のボタンを押す
    const cdp = touch ? await context.newCDPSession(page) : null;
    const longPress = async locator => {
      await locator.scrollIntoViewIfNeeded();
      const box = await locator.boundingBox(), x = box.x + Math.min(40, box.width / 2), y = box.y + Math.min(20, box.height / 2);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await page.waitForTimeout(600);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(450);
    };
    const replyMenu = async () => { await longPress(page.locator('.agent-reply').last().locator('.agent-reply-body')); await until(async () => (await page.locator('.prompt-menu').count()) === 1, 'reply menu'); };
    const act = async a => {
      if (!touch) { await page.locator('.agent-reply .reply-bar').last().locator(`[data-act="${a}"]`).click(); return; }
      await replyMenu(); await page.locator(`.prompt-menu [data-menu="${a}"]`).click();
    };

    // §2.1 並び: ［コピー］［🔊］［もう一度］［評価］と右寄せの［ソース］（PC）。スマホは操作列を出さず長押しのメニュー
    await until(async () => (await bar.locator('[data-act="speak"]:not([hidden])').count()) === 1, 'speak button');
    assert.equal(await bar.locator('time.reply-time').count(), 0, name + ' time');
    if (touch) {
      // スマホは「コピー」「選択」「共有」と回答の操作、評価の行を出す
      assert.equal(await bar.evaluate(b => b.getBoundingClientRect().width), 1, name + ' bar visually hidden');
      assert.notEqual(await bar.evaluate(b => getComputedStyle(b).display), 'none', name + ' bar remains accessible');
      // 出典の次のTabで操作列へ進め、フォーカス中は実際に見える。支援技術にもボタンを残す。
      await page.locator('.agent-reply-body a').last().focus();
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.dataset.act),'copy',name + ' keyboard entry');
      assert.ok(await bar.evaluate(b => b.getBoundingClientRect().width > 1),name + ' focused bar visible');
      await page.keyboard.press('Enter');
      assert.match(await page.evaluate(() => navigator.clipboard.readText()),/\[1\]/);
      await page.locator('#agent-input').focus();
      assert.equal(await bar.evaluate(b => b.getBoundingClientRect().width),1,name + ' bar hides after blur');
      await replyMenu();
      assert.deepEqual(await page.locator('.prompt-menu [data-menu]').evaluateAll(list => list.map(b => b.dataset.menu)), ['copy', 'select', 'share', 'speak', 'retry', 'sources'], name);
      const srcLabel = await bar.locator('[data-act="sources"]').getAttribute('aria-label');
      assert.deepEqual(await page.locator('.prompt-menu [data-menu]').allTextContents(), lang === 'ja-JP' ? ['コピー', '選択', '共有', '読み上げ', 'もう一度', srcLabel] : ['Copy', 'Select', 'Share', 'Read aloud', 'Try again', srcLabel]);
      assert.deepEqual(await page.locator('.prompt-menu-rate > button').allTextContents(), ['👍', '❤️', '😂', '😮', '😢', '🙏', '+']);
      if (process.argv.includes('--screenshots')) { mkdirSync(captures, { recursive: true }); await page.screenshot({ path: resolve(captures, name + '-menu.png'), animations: 'disabled' }); }
      await page.keyboard.press('Escape');
      await until(async () => (await page.locator('.prompt-menu').count()) === 0, 'menu closed');
    } else {
      const acts = await bar.locator('button:visible').evaluateAll(list => list.map(b => b.dataset.act));
      assert.deepEqual(acts, ['copy', 'speak', 'retry', 'rate', 'sources'], name);
      // 390px 以上は［ソース］まで1行に収める（それより狭い端末では［ソース］だけ2行目の右端へ回る）
      if (width >= 390) {
        const [copyTop, srcTop] = await Promise.all(['copy', 'sources'].map(act => bar.locator(`[data-act="${act}"]`).evaluate(b => b.getBoundingClientRect().top)));
        assert(Math.abs(copyTop - srcTop) < 2, name + ' one line ' + copyTop + ' ' + srcTop);
      }
      for (const box of await bar.locator('button:visible').evaluateAll(list => list.map(b => b.getBoundingClientRect().height))) assert(Math.round(box) >= 32, name + ' button height ' + box);
    }
    const src = bar.locator('[data-act="sources"]');
    assert.equal(await src.locator('img.src-icon').count(), 1); assert.equal(await src.locator('.src-letter').count(), 1);
    assert.equal(await page.locator('.agent-reply .agent-sources').count(), 0, '回答の下に旧い一覧を出さない');
    assert.equal(await page.locator('.agent-reply-body a').count(), 2, '本文の[n]は残す');
    const overflow = await page.evaluate(() => { const log = document.getElementById('agent-log'); return log.scrollWidth - log.clientWidth; });
    assert(overflow <= 1, name + ' horizontal overflow ' + overflow);
    if (process.argv.includes('--screenshots')) { mkdirSync(captures, { recursive: true }); await page.screenshot({ path: resolve(captures, name + '-bar.png'), animations: 'disabled' }); }

    // §2.2 ソースの一覧。Esc で閉じて［ソース］へ戻る。画面から出典のサイトへ取りに行かない
    await act('sources');
    const rows = page.locator(home ? '.src-list .src-row' : '#agent-sources-panel .src-row');
    await until(async () => (await rows.count()) === 2, 'source rows');
    assert.equal(await src.getAttribute('aria-expanded'), 'true');
    assert.deepEqual(await rows.evaluateAll(list => list.map(a => [a.target, a.rel, a.querySelector('.src-domain').textContent])),
      [['_blank', 'noopener noreferrer', 'example.com'], ['_blank', 'noopener noreferrer', 'news.example.org']]);
    if(home)assert(await rows.first().evaluate(a=>a===document.activeElement),'ソースを開いたら先頭の出典へフォーカスする');
    if (!home) {
      const close = page.locator('#agent-sources-panel .agent-panel-close');
      assert(await close.evaluate(btn => btn === document.activeElement), 'ソースのモーダルは閉じるボタンへフォーカスする');
      await page.keyboard.press('Shift+Tab');
      assert(await rows.last().evaluate(a => a === document.activeElement), 'Shift+Tab は背景へ抜けず最後の出典へ回る');
      await page.keyboard.press('Tab');
      assert(await close.evaluate(btn => btn === document.activeElement), '最後の出典の Tab は閉じるボタンへ戻る');
      await page.keyboard.press('Tab');
      assert(await rows.first().evaluate(a => a === document.activeElement), 'Tab は最初の出典へ進む');
    }
    if (process.argv.includes('--screenshots')) await page.screenshot({ path: resolve(captures, name + '-sources.png'), animations: 'disabled' });
    await page.keyboard.press('Escape');
    await until(async () => (await rows.count()) === 0, 'close sources');
    assert.equal(await src.getAttribute('aria-expanded'), 'false');
    if (!touch) assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.dataset.act), 'sources');
    assert.deepEqual(external.slice(sentAt), [], name + ' external requests');

    // §2.2 共有: 題名と本文（[n]と出典の一覧）を渡し、URL は渡さない。PC と、共有が無い環境ではコピーして知らせる
    // Windows のクリップボードは改行を CRLF にして返す
    const copied = async () => (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n');
    let sharedText;
    if (touch) {
      await page.evaluate(() => {
        Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>true});
        window.__images=[];
        const render=window.MagiShareImage.render;
        window.MagiShareImage.render=opts=>{window.__images.push(opts);return render(opts);};
      });
      await act('share');
      await until(async () => (await page.evaluate(() => window.__shared.length)) === 1,'image share');
      const image=await page.evaluate(()=>({type:window.__shared[0].files[0].type,size:window.__shared[0].files[0].size,options:window.__images[0]}));
      assert.equal(image.type,'image/png');assert.ok(image.size>0);
      assert.equal(image.options.truncate,false);
      assert.match(image.options.text,/\[1\]/);assert.match(image.options.text,/\[2\]/);
      for(const item of sources.items)assert.ok(image.options.text.includes(item.title)&&image.options.text.includes(item.url));
      if(process.argv.includes('--screenshots')) {
        mkdirSync(captures,{recursive:true});
        writeFileSync(resolve(captures,name+'-shared.png'),Buffer.from(await page.evaluate(async()=>Array.from(new Uint8Array(await window.__shared[0].files[0].arrayBuffer())))));
      }
      // 利用者のキャンセルはテキスト共有やコピーへ進めない。アプリはnative由来のcancel文も受ける。
      for(const error of [{name:'AbortError',message:'aborted'},...(!home?[{name:'Error',message:'Share cancelled'}]:[])]) {
        await page.evaluate(async error=>{
          window.__shareOriginal=navigator.share;window.__shareAttempts=0;
          await navigator.clipboard.writeText('unchanged after cancel');
          Object.defineProperty(navigator,'share',{configurable:true,value:()=>{
            window.__shareAttempts++;return Promise.reject(Object.assign(new Error(error.message),{name:error.name}));
          }});
        },error);
        await act('share');
        await until(async()=>await page.evaluate(()=>window.__shareAttempts)>0,'share cancellation');
        assert.equal(await page.evaluate(()=>window.__shareAttempts),1);
        assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'unchanged after cancel');
        await page.evaluate(()=>Object.defineProperty(navigator,'share',{configurable:true,value:window.__shareOriginal}));
      }
      // 長い回答・出典は画像から切り落とさず、全文のテキスト共有へ戻す。
      assert.equal(await page.evaluate(async()=>{
        try{await window.MagiShareImage.render({text:'long synthetic line\n'.repeat(1000),truncate:false});return false;}
        catch(e){return e.message==='share_image_too_long';}
      }),true);
      await page.evaluate(()=>{window.__shared=[];Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>false});});
      await act('share');
      await until(async () => (await page.evaluate(() => window.__shared.length)) === 1, 'share');
      const shared = await page.evaluate(() => window.__shared[0]);
      assert.deepEqual(Object.keys(shared).sort(), ['text', 'title']);
      sharedText = shared.text;
      await page.evaluate(() => { delete navigator.share; Object.defineProperty(navigator, 'share', { configurable: true, value: undefined }); });
      await act('share');
      await until(async () => (await page.locator('.reply-note').count()) === 1, 'copied note');
      assert.equal(await copied(), sharedText);
      assert.match(sharedText, /\[1\]/); assert.match(sharedText, /https:\/\/www\.example\.com\/hours/);
    } else assert.equal(await bar.locator('[data-act="share"]').count(), 0, 'PC では［共有］を出さない（コピーと同じになる）');

    // §2.3 読み上げ: 押すと区切り0と1を取り、鳴らし終えたら元に戻る。もう一度押すとすぐ止まる
    const speak = bar.locator('[data-act="speak"]');
    await act('speak');
    assert.equal(await speak.getAttribute('aria-pressed'), 'true');
    await until(async () => speech.length === 2, 'two parts');
    assert.deepEqual(speech.map(b => b.part), [0, 1]); assert.equal(speech[0].sig, SIG); assert.equal(speech[0].lang, 'ja'); assert.equal(speech[0].text, answer);
    await until(async () => (await speak.getAttribute('data-state')) === 'idle', 'played to the end');
    assert.equal(await speak.getAttribute('aria-pressed'), 'false');
    if (touch) {
      // スマホは読み込み中に長押しのメニューを開くと「読み上げを止める」になり、押すとすぐ止まる（音声の応答を遅らせて確かめる）
      speechDelay = 3000;
      await act('speak');
      await replyMenu();
      assert.equal(await page.locator('.prompt-menu [data-menu="speak"]').textContent(), lang === 'ja-JP' ? '読み上げを止める' : 'Stop reading');
      await page.locator('.prompt-menu [data-menu="speak"]').click();
      speechDelay = 0;
    } else { await act('speak'); await act('speak'); }
    assert.equal(await speak.getAttribute('data-state'), 'idle');
    assert.equal(await page.locator('audio').count(), 0, '<audio> は文書に挿さない');

    // ［もう一度］: 同じ質問だけを送り直し（前の回答は送らない）、新しい回答と入れ替える
    await act('retry');
    await until(async () => chats.length === 2 && (await page.locator('.agent-reply.streaming').count()) === 0
      && (await page.locator('.agent-reply-body').last().textContent()).includes('9時半'), 'retried');
    assert.deepEqual(chats[1].messages.map(m => [m.role, m.content]), [['user', '開館時間を確認して']]);
    assert.equal(await page.locator('.agent-user').count(), 1); assert.equal(await page.locator('.agent-turn').count(), 1);
    // 届かなければ前の往復を見せ直し、入力欄には戻さない
    chatFails = true;
    await act('retry');
    await until(async () => chats.length === 3 && (await page.locator('.agent-err').count()) === 1, 'retry failed');
    await until(async () => (await page.locator('.agent-turn:visible').count()) === 1, 'old reply back');
    assert.equal(await page.locator('.agent-user:visible').count(), 1);
    assert.match(await page.locator('.agent-reply-body').last().textContent(), /9時半/);
    assert.equal(await page.locator('#agent-input').inputValue(), '');
    // ふつうの送信が届かなかったときも、前の回答の［もう一度］を出し直す
    await page.locator('#agent-input').fill('休館日は？');
    await page.locator('#agent-send').click();
    await until(async () => chats.length === 4 && (await page.locator('#agent-input').inputValue()) === '休館日は？', 'send failed');
    await until(async () => (await page.locator('.agent-reply .reply-bar').last().locator('[data-act="retry"]:not([hidden])').count()) === 1, 'retry back');
    await page.locator('#agent-input').fill('');
    chatFails = false;

    // 評価: Good / Bad の2択。付け替えは前の評価を消してから付ける
    // スマホは長押しのメニューの評価の行、PC は操作列の評価のメニュー
    const latest = page.locator('.agent-reply .reply-bar').last(), rate = latest.locator('[data-act="rate"]');
    const pop = touch ? '.prompt-menu-rate' : '.rate-pop', openRate = async () => { if (touch) await replyMenu(); else await rate.click(); };
    await openRate();
    // よく使う6つと ＋。＋ でほかの絵文字を開く
    assert.deepEqual(await page.locator(pop + ' > button').allTextContents(), ['👍', '❤️', '😂', '😮', '😢', '🙏', '+']);
    assert.equal(await page.locator(pop + ' .react-more').isHidden(), true);
    await page.locator(pop + ' [data-more]').click();
    assert.equal(await page.locator(pop + ' .react-more').isVisible(), true);
    assert.ok((await page.locator(pop + ' .react-more button').count()) >= 16);
    if (process.argv.includes('--screenshots')) await page.screenshot({ path: resolve(captures, name + '-rate.png'), animations: 'disabled' });
    await page.locator(pop + ' [data-rate="👍"]').click();
    await until(async () => reacts.length === 1, 'rated good');
    assert.equal(reacts[0].reaction, '\u{1F44D}'); assert.equal(reacts[0].target, 'integrated');
    assert.equal(await page.locator(pop).count(), 0); assert.match(await rate.getAttribute('class'), /rated/);
    await openRate();
    assert.equal(await page.locator(pop + ' [data-rate="👍"]').getAttribute('aria-checked'), 'true');
    // 付けた絵文字は回答の角に札で出る（付けた瞬間は弾むアニメーション）
    assert.equal(await page.locator('.agent-reply').last().locator('.msg-reaction').getAttribute('data-emoji'), '👍');
    await page.locator(pop + ' [data-rate="😂"]').click();
    await until(async () => reacts.length === 3, 'rated bad');
    assert.deepEqual(reacts.slice(1).map(r => r.op || r.reaction), ['remove', '\u{1F602}']);
    await openRate(); await page.keyboard.press('Escape');
    assert.equal(await page.locator(pop).count(), 0);

    // 履歴から開き直しても、保存した署名で 🔊 と［ソース］が出る
    await page.reload({ waitUntil: 'domcontentloaded' });
    if (home && !(await page.locator('#agentdock:not(.collapsed)').count())) await page.locator('#activitybar [data-act="agent"]').click();
    const restored = page.locator('.agent-reply .reply-bar').last();
    await until(async () => (await restored.locator('[data-act="speak"]:not([hidden])').count()) === 1, 'restored speak');
    assert.equal(await restored.locator('[data-act="sources"]:not([hidden])').count(), 1);
    assert.match(await restored.locator('[data-act="rate"]').getAttribute('class'), /rated/, '評価を復元する');
    assert.equal(await restored.locator('[data-act="retry"]:not([hidden])').count(), 1, '開き直しても文字の質問は送り直せる');
    assert.equal(await restored.locator('time.reply-time:visible').count(), 0);
    assert.deepEqual(errors, [], name + ' page errors');
    await context.close();
    checked++;
  }
  console.log('reply bar browser checks passed:', checked);
} finally {
  await browser.close();
  server.close();
}
