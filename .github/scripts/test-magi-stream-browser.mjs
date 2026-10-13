// 先行0と対話改修A1の実画面。固定SSEで注記・再生・停止・保存・会話終了を確認する。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';
const root = resolve(process.argv[2] || '.'), event = (ev, data) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`;
const ids = ['MELCHIOR-1','BALTHASAR-2','CASPER-3'];
const answer = '固定回答として受信と再生を確認します。'.repeat(15);
const activeEvent = { open: true, code: 'ABC123', title: 'ローカル確認', genres: [] };
const server = createServer((req, res) => {
  let path = new URL(req.url, 'http://localhost').pathname; if (path.endsWith('/')) path += 'index.html';
  const file = resolve(root, '.' + path);
  if (!file.startsWith(root + sep) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': ({'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.json':'application/json'})[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ headless: true });
async function until(check) { for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('browser_condition_timeout'); }
try {
  for (const [name, path, width] of [['home-light','/',1280],['home-dark','/',1280],['app','/magi-app/www/',390],['dj','/dj/request/',390]]) {
    if (process.argv.includes('--dj-only') && name !== 'dj') continue;
    const modes = process.argv.includes('--malice-only') ? ['malice-pass','malice-full','malice-stop']
      : name === 'dj' ? ['pass','full','stop'] : ['pass','full','stop','magi-full','magi-stop'];
    for (const mode of modes) {
      const malice = mode.startsWith('malice'), buffered = !mode.endsWith('pass');
      const page = await browser.newPage({ viewport: { width, height: 900 }, serviceWorkers: 'block' }), errors = [];
      page.on('pageerror', e => errors.push(e.message));
      let release, posted = false;
      const gate = new Promise(r => { release = r; });
      await page.addInitScript(() => localStorage.setItem('st-analytics','off'));
      await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.pathname === '/magi2/chat') {
          posted = true; if (buffered) await gate;
          const dj = name === 'dj', magi = mode.startsWith('magi');
          const classification = { version:1, intent:dj?'music':'consult', votable:magi?'yes':'no', site_pages:'no', magi_candidate:magi, reply_language:{version:1,code:'ja',source:'ui'} };
          await route.fulfill({ contentType:'text/event-stream', headers:{'Access-Control-Allow-Origin':origin}, body:': padding\n\n' + event('classification',classification)
            + (magi ? event('motion',{text:'改修を進める',votable:true}) : '')
            + (malice ? '' : [1,2].flatMap(round => ids.map(codename => event('persona',{codename,round,text:'固定意見'+round,...(magi?{vote:codename==='BALTHASAR-2'?'reject':'approve',vote_state:'final'}:{})}))).join(''))
            + (magi ? event('verdict',{motion:'改修を進める',result:'approve',tally:{approve:2,reject:1,none:0},rounds:2,reason_missing:false,votes:Object.fromEntries(ids.map(codename=>[codename,{vote:codename==='BALTHASAR-2'?'reject':'approve',round:2,state:'voted'}]))}) : '')
            + event('integrated',{delta:answer}) + (magi ? event('integrated_end',{}) : '') + (malice ? event('closed',{reason:'malice'}) : event('suggest',{text:'次の相談'})) + event('done',{}) }); return;
        }
        if (url.pathname === '/magi2/models') { await route.fulfill({json:{personas:{},synthesizer:{}}}); return; }
        if (url.pathname === '/dj/api/req/event') { await route.fulfill({json:activeEvent}); return; }
        if (url.pathname === '/dj/api/req/board') { await route.fulfill({json:{event:activeEvent,played:[],waiting:[]}}); return; }
        if (url.origin !== origin) { await route.fulfill({status:200,body:''}); return; }
        await route.continue();
      });
      try {
        await page.clock.install({time:new Date('2026-10-12T00:00:00Z')});
        await page.clock.pauseAt(new Date('2026-10-12T00:10:00Z'));
        await page.goto(origin + path, {waitUntil:'domcontentloaded'});
        if (name === 'home-dark') await page.locator('[data-act="settings"]').click();
        if (name === 'dj') await page.locator('[data-tab="consult"]').click();
        const input = name === 'dj' ? '#chatInput' : '#agent-input', send = name === 'dj' ? '#chatSend' : '#agent-send';
        await page.clock.runFor(5000); // テーマ切り替えのtoastが消えてから時計を止める。
        await page.locator(input).fill('受信確認の相談');
        await page.locator(send).click(); await until(() => posted);
        if (buffered) {
          await page.clock.runFor(15001); assert.equal(await page.locator('.magi-stream-note').count(),1);
          if (mode === 'full' && process.argv.includes('--screenshots')) {
            const captures = resolve('workers/.wrangler/magi2-stream-eval/captures'); mkdirSync(captures,{recursive:true});
            await page.screenshot({path:resolve(captures,name+'.png'),animations:'disabled'});
          }
          release();
          await until(async () => (await page.locator(send).getAttribute('title')) === (name === 'dj' ? 'すぐに全部表示' : 'Show all now'));
          assert.equal(await page.locator('.magi-stream-note').count(),0);
          if (mode.endsWith('stop')) await page.locator(send).click(); else await page.clock.runFor(20000);
        }
        const closed = malice && name !== 'dj';
        await until(async () => closed ? await page.locator('.agent-closed').count() === 1 : !await page.locator(input).isDisabled());
        const body = page.locator(name === 'dj' ? '.ab' : '.agent-reply-body').last();
        assert.equal(await body.textContent(), answer); assert.equal(await page.locator(input).inputValue(), '');
        const saved = await page.evaluate(dj => localStorage.getItem(dj ? 'tkdj.consults' : 'magi_current_history'), name === 'dj');
        assert.ok(saved?.includes(answer), name + ': 保存された回答'); assert.equal(errors.length,0,errors.join('\n'));
        if (closed) {
          assert.equal(await page.locator(input).isDisabled(),true);
          assert.ok(JSON.parse(saved).at(-1).closed === true);
          assert.equal(await page.locator('.agent-personas').count(),0);
          assert.equal(await page.locator('#agent-suggest').isVisible(),false);
          await page.reload({waitUntil:'domcontentloaded'});
          assert.equal(await page.locator(input).isDisabled(),true);
          assert.equal(await page.locator('.agent-closed').count(),1);
          assert.equal(await page.locator('.agent-personas').count(),0);
          await page.locator('.agent-closed button').click();
          assert.equal(await page.locator(input).isDisabled(),false);
          assert.equal(await page.locator('.agent-closed').count(),0);
          // 保存済みの終了会話へ戻しても、入力は閉じたまま。
          await page.locator('#btn-history-agent').click();
          await page.locator(name.startsWith('home') ? '.btn-load-session' : '.session-load').first().click();
          assert.equal(await page.locator(input).isDisabled(),true);
          assert.equal(await page.locator('.agent-closed').count(),1);
          assert.equal(await page.locator('.reaction-bar[data-target="integrated"]').count(),1);
          assert.equal(errors.length,0,errors.join('\n'));
        }
        console.log(`${name}/${mode}: 注記・回答・停止・保存 OK`);
      } finally { release(); await page.close(); }
    }
  }
} finally { await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
