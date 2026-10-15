// A3の確認質問を実ブラウザで検査する。--base=https://tk.stでもAI・計測は模擬にする。
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, existsSync, mkdirSync} from 'node:fs';
import {createServer} from 'node:http';
import {resolve, extname, sep} from 'node:path';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
const remote = process.argv.find(v => v.startsWith('--base='))?.slice(7);
if (remote && remote !== 'https://tk.st') throw new Error('publication_base_not_allowed');
const root = resolve('.'), out = resolve('workers/.wrangler/magi2-dialogue-a3/' + (remote ? 'public-browser' : 'browser'));
mkdirSync(out, {recursive:true});
const modelsFile = resolve(out, 'models.json');
execFileSync(process.execPath, ['.github/scripts/eval-magi-models.mjs', '--check', '--models-output='+modelsFile]);
const models = JSON.parse(readFileSync(modelsFile, 'utf8'));
const server = createServer((req, res) => {
  let path = new URL(req.url, 'http://localhost').pathname;
  if (path.endsWith('/')) path += 'index.html';
  const file = resolve(root, '.'+path);
  if (!file.startsWith(root+sep) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, {'Content-Type':({'.html':'text/html; charset=utf-8','.js':'application/javascript','.json':'application/json'})[extname(file)] || 'application/octet-stream'});
  res.end(readFileSync(file));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = remote || 'http://localhost:'+server.address().port;
const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const one = [{question:'用途を選んでください <b>確認</b>', options:['練習','本番','比較']}];
const multi = [{question:'人数は？',options:['1人','2人','3人']},{question:'時間は？',options:['10分','20分','30分']}];
const browser = await chromium.launch({headless:true}), results = [];
try {
  for (const [label, path, width, lang, theme] of [
    ['home-ja-light','/',1280,'ja','light'], ['home-en-dark','/',390,'en','dark'],
    ['app-ja-dark','/magi-app/www/',390,'ja','dark'], ['app-en-light','/magi-app/www/',1280,'en','light'],
  ]) {
    const page = await browser.newPage({viewport:{width,height:900},serviceWorkers:'block'}), errors = [], sent = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => localStorage.setItem('st-analytics','off'));
    let answer = 'one';
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname === '/magi2/models') { await route.fulfill({json:models}); return; }
      if (url.pathname === '/magi2/chat') {
        const body = JSON.parse(request.postData()); sent.push(body);
        const notice = {version:1,intent:'consult',mode:'consult',fresh:'no',site_pages:'no',votable:'no',magi_candidate:false,
          reply_language:body.reply_language || {version:1,code:lang,source:'jev'}};
        let text = event('classification', notice);
        if (answer === 'normal') text += event('integrated', {delta:'回答しました。'});
        else {
          for (const codename of ['MELCHIOR-1','BALTHASAR-2','CASPER-3']) for (const round of [1,2]) text += event('persona',{codename,round,text:'討議の意見'});
          text += event('clarify', {questions:answer === 'one' ? one : multi,intent:'consult',fresh:'no'});
        }
        await route.fulfill({contentType:'text/event-stream', body:text+event('done',{}),headers:{'Access-Control-Allow-Origin':origin}}); return;
      }
      if (url.origin !== origin) { await route.fulfill({status:200,body:''}); return; }
      await route.continue();
    });
    const ready = async () => {
      await page.locator('#agent-input').waitFor();
      if (path === '/') await page.evaluate(lang => setLanguage(lang),lang);
      await page.evaluate(({lang,theme}) => {
        document.documentElement.lang = lang; document.documentElement.setAttribute('data-theme',theme);
      },{lang,theme});
    };
    const send = async text => {
      await page.locator('#agent-input').fill(text); await page.locator('#agent-send').click();
    };
    try {
      await page.goto(origin+path,{waitUntil:'domcontentloaded'}); await ready();
      await send('確認のある相談です');
      await page.locator('.agent-turn:last-child .agent-clarify').waitFor();
      assert.equal(sent[0].clarify,true); assert.equal(await page.locator('.agent-clarify fieldset button').count(),4);
      assert.equal(await page.locator('.agent-clarify b').count(),0);
      await page.screenshot({animations:'disabled',path:resolve(out,label+'-one.png')});
      answer = 'normal';
      await page.locator('.agent-turn:last-child .agent-clarify fieldset button').nth(1).click();
      await page.waitForFunction(() => JSON.parse(localStorage.getItem('magi_current_history') || '[]').at(-1)?.content === '回答しました。');
      assert.match(sent[1].messages.at(-1).content,/本番/);
      assert.deepEqual(sent[1].messages.at(-2).clarify.questions,one);
      assert.equal(await page.locator('.agent-clarify button:enabled').count(),0);
      await page.reload({waitUntil:'domcontentloaded'}); await ready();
      assert.equal(await page.locator('.agent-clarify button:enabled').count(),0);
      answer = 'multi'; await send('条件を確認したい相談です');
      await page.locator('.agent-turn:last-child .agent-clarify').waitFor();
      await page.reload({waitUntil:'domcontentloaded'}); await ready();
      const panel = page.locator('.agent-turn:last-child .agent-clarify');
      assert.equal(await panel.locator('button:enabled').count(),9);
      await panel.locator('fieldset').nth(0).locator('button').nth(0).click();
      await panel.locator('fieldset').nth(1).locator('button').nth(3).click();
      await panel.locator('input').nth(1).fill('45分');
      assert.equal(await panel.locator('input').nth(1).getAttribute('maxlength'),'100');
      const before = sent.length;
      await page.locator('#agent-input').fill('x'.repeat(1000)); await panel.locator(':scope > button').click();
      assert.equal(sent.length,before,'合成後1000文字超過は送らない');
      await page.locator('#agent-input').fill('途中で休憩します');
      await page.screenshot({animations:'disabled',path:resolve(out,label+'-multi.png')});
      answer = 'normal'; await panel.locator(':scope > button').click();
      await page.waitForFunction(() => JSON.parse(localStorage.getItem('magi_current_history') || '[]').at(-1)?.content === '回答しました。');
      assert.match(sent.at(-1).messages.at(-1).content,/1人/); assert.match(sent.at(-1).messages.at(-1).content,/45分/);
      assert.match(sent.at(-1).messages.at(-1).content,/途中で休憩します/);
      assert.deepEqual(errors,[]); results.push({label,pass:true,requests:sent.length}); console.log(label+' OK');
    } finally { await page.close(); }
  }
} finally {
  writeFileSync(resolve(out,'results.json'),JSON.stringify(results,null,2));
  await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));
}
