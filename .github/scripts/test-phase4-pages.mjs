// 実ページ・実索引の接続をローカルで検証する。外部通信・Jevは固定応答に置き換える。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,extname,sep} from 'node:path';
import {chromium} from 'playwright';
const repo=resolve('.'),generated=resolve(process.argv[2] || '_site');
const server=createServer((req,res)=>{
  let path;
  try {path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);} catch(_) {res.writeHead(400);res.end();return;}
  if(path.endsWith('/')) path+='index.html';
  const inGenerated=resolve(generated,'.'+path),inRepo=resolve(repo,'.'+path);
  const file=inGenerated.startsWith(generated+sep) && existsSync(inGenerated)?inGenerated:inRepo;
  if(!file.startsWith(repo+sep) || !existsSync(file)) {res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.json':'application/json','.woff2':'font/woff2'})[extname(file)] || 'application/octet-stream'});
  res.end(readFileSync(file));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
async function offline(page,posts,requests=[],delayFile=null) {
  let release;
  await page.addInitScript(()=>localStorage.setItem('st-analytics','off'));
  await page.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());requests.push(url.pathname);
    if(url.origin!==origin) {await route.fulfill({status:200,body:'',contentType:url.pathname.endsWith('.css')?'text/css':'application/javascript'});return;}
    if(url.pathname==='/search/api/rank') {
      const body=request.postDataJSON();posts.push(body);
      await route.fulfill({json:{status:'no_results',complete:true,cached:false,results:[],searched:{scope:body.scope,filters:body.filters,generation:body.generation,total:20,candidates:20,judged:20}}});return;
    }
    if(delayFile && url.pathname===delayFile) {delayFile=null;await new Promise(r=>release=r);}
    await route.continue();
  });
  return async()=>{while(!release) await new Promise(r=>setTimeout(r,10));release();};
}
const ready=page=>page.waitForFunction(()=>document.querySelector('[data-st-search-readings="ready"]'));
try {
  browser=await chromium.launch({headless:true});
  for(const [scope,path,query] of [['site','/404.html','Thought'],['tools','/tools/','PDF'],['game','/game/','tetris'],['nitori','/job/nitoridaily/','収納'],['retail','/job/retailtechdaily/','AI']]) {
    const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],posts=[];page.on('pageerror',e=>errors.push(e.message));await offline(page,posts);
    await page.goto(origin+path,{waitUntil:'domcontentloaded'});
    if(scope==='site') await page.waitForFunction(()=>document.querySelector('#path-suggestion-list').children.length>0);else await ready(page);
    const input=page.locator('.st-search-input');
    const catalogue=scope==='tools'?'#tool-grid':scope==='game'?'#game-grid':null;
    if(catalogue) {
      assert.equal(await page.getByRole('group',{name:scope==='tools'?'カテゴリー':'ジャンル',exact:true}).count(),1);
      assert.equal(await page.locator('.st-search-filters label button').count(),0);
      assert.equal(await page.locator('[data-sort] option').first().getAttribute('value'),'newest');
      assert.equal(await page.locator('.st-search-chip').count()>1,true);await page.locator('.st-search-chip').nth(1).click();
      assert.equal(await page.locator('.st-search-chip').nth(1).getAttribute('aria-pressed'),'true');await page.locator('.st-search-chip').first().click();
      await page.locator('[data-sort]').selectOption('title');
    }
    await input.fill(query);assert.equal(posts.length,0);
    if(scope==='tools') {
      assert.ok(await page.locator('.st-search-suggestions .st-search-kind').count()>0);
      assert.equal(await page.locator('.st-search-kind .st-search-kind').count(),0,'種類の字を二重に縮小しない');
    }
    if(catalogue) assert.equal(await page.locator(catalogue).isVisible(),true,'打っている間はカタログを残す');
    if(scope==='site') assert.equal(await page.locator('#path-suggestions').isVisible(),true);
    assert.match(await page.locator('.st-search-notice').textContent(),/TypeSafe AI/);
    await input.press('Enter');await page.waitForFunction(()=>document.querySelector('.st-search-rank-status').textContent==='' && document.querySelector('.st-search-local').hidden===false);
    await page.waitForFunction(()=>document.querySelector('.st-search-semantic').hidden);
    assert.equal(posts.length,1);assert.equal(posts[0].query,query);
    if(scope==='site') {
      await page.locator('#ai-search').waitFor();
      await input.press('Enter');
      assert.equal(await page.locator('#ai-search').isVisible(),true,'同じ語の再確定でも③を表示する');
      assert.equal(posts.length,1,'同じ条件の②は再送しない');
      let finishAI;
      await page.route(/\/magi2\/site-search(?:\?|$)/,async route=>{await new Promise(r=>finishAI=r);await route.fulfill({json:{status:'no_results',results:[],comment:''}});});
      await page.locator('#ai-run').click();
      await page.waitForFunction(()=>!document.querySelector('#ai-thinking').hidden);
      assert.equal(await page.getByRole('button',{name:'AIで関連する候補も探す',exact:true}).isVisible(),false,'③の実行中に②の再実行を出さない');
      assert.equal(posts.length,1);
      while(!finishAI) await new Promise(r=>setTimeout(r,10));finishAI();
      await page.waitForFunction(()=>document.querySelector('#ai-cancel').hidden);
    }
    const rows=page.locator('.st-search-local > ul > li');assert.ok(await rows.count()>0);
    if(catalogue) {
      assert.equal(await page.locator(catalogue).isVisible(),false);
      const heading=await page.locator('.st-search-local > h3').textContent(),count=Number(heading.match(/ (\d+)件/)[1]);
      assert.equal(await rows.count(),count);assert.equal(await page.locator('.st-search-local .'+(scope==='tools'?'tool-card':'game-card')).count(),count);
      for(const href of await rows.locator('[data-st-primary]').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('href')))) assert.ok(href.startsWith('/'+scope+'/'));
      assert.equal(await page.locator('[data-sort]').inputValue(),'relevance');
    }
    await page.waitForFunction(()=>!document.querySelector('.st-search-local > h3').textContent.includes('（読み込み中）'));
    const mainText=await page.locator('.st-search-local > h3').textContent();await input.fill('別の下書き');assert.equal(await page.locator('.st-search-local > h3').textContent(),mainText);
    if(scope==='site') assert.equal(await page.locator('#daily-query').textContent(),query);
    if(scope==='nitori' || scope==='retail') {
      await page.evaluate(()=>document.documentElement.lang='en');
      await page.waitForFunction(()=>document.querySelector('.st-search-input').placeholder==='Search articles');
      assert.deepEqual(await page.locator('[data-filter] option[value=""]').allTextContents(),['All','All','All']);
      await page.evaluate(()=>document.documentElement.lang='ja');
      await page.waitForFunction(()=>document.querySelector('.st-search-input').placeholder==='記事を検索');
      assert.deepEqual(await page.locator('[data-filter] option[value=""]').allTextContents(),['すべて','すべて','すべて']);
    }
    await input.press('Escape');
    await page.getByRole('button',{name:'検索をやめる',exact:true}).click();
    if(catalogue) {assert.equal(await page.locator(catalogue).isVisible(),true);assert.equal(await page.locator('[data-sort]').inputValue(),'title');}
    if(scope==='site') assert.equal(await page.locator('#path-suggestions').isVisible(),true);
    assert.equal(await page.locator('.st-search-analytics-notice').count(),['site','nitori','retail'].includes(scope)?1:0);
    if(catalogue) {
      const records=JSON.parse(readFileSync(generated+'/data/'+scope+'.json','utf8'));
      for(const record of records) {
        await input.fill(record.title);await input.press('Enter');await page.waitForFunction(()=>document.querySelector('.st-search-semantic').hidden);
        const count=Number((await page.locator('.st-search-local > h3').textContent()).match(/ (\d+)件/)[1]);
        assert.equal(await rows.count(),count);
        const href=new URL(record.url,'https://tk.st').pathname;
        assert.ok((await rows.locator('[data-st-primary]').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('href')))).includes(href),record.title+': 検査済みの主リンク');
      }
    }
    assert.deepEqual(errors,[]);await page.close();console.log(scope+': 実索引・ページのカード・帯・確定語・プライバシー');
  }
  for(const scope of ['tools','game','nitori','retail']) {
    const media=scope==='nitori'?'nitoridaily':'retailtechdaily',path=['tools','game'].includes(scope)?'/'+scope+'/':'/job/'+media+'/';
    const page=await browser.newPage(),posts=[],requests=[];
    const release=await offline(page,posts,requests,['tools','game'].includes(scope)?'/data/'+scope+'.json':'/job/'+media+'/search-index.json');
    await page.goto(origin+path+'#q='+encodeURIComponent(scope==='game'?'tetris':'PDF'),{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>document.querySelector('.st-search-local')?.hidden===false);await release();await ready(page);
    assert.equal(posts.length,0);assert.equal(await page.getByRole('button',{name:'AIで関連する候補も探す',exact:true}).isVisible(),true);assert.ok(!page.url().includes('q='));await page.close();
  }
  for(const media of ['nitoridaily','retailtechdaily']) {
    for(const issue of [true,false]) {
      const typing=await browser.newPage({viewport:{width:320,height:900}}),typingPosts=[];
      const release=await offline(typing,typingPosts,[],'/assets/search-ui.js');
      await typing.goto(origin+'/job/'+media+'/'+(issue?'20261011/':''),{waitUntil:'commit'});
      const input=typing.locator('#headerSearchInput');await input.focus();await typing.keyboard.type('ni');
      await input.evaluate(el=>el.setSelectionRange(1,2,'backward'));await release();
      await typing.waitForFunction(()=>document.querySelector('.header-search').dataset.stSearchOwned==='1');
      assert.equal(await input.evaluate(el=>document.activeElement===el),true,'取り付け後も入力欄のフォーカスを保つ');
      assert.deepEqual(await input.evaluate(el=>[el.selectionStart,el.selectionEnd,el.selectionDirection]),[1,2,'backward']);
      assert.equal(await input.getAttribute('aria-expanded'),'true');
      await typing.keyboard.type('tori');assert.equal(await input.inputValue(),'ntori','続けて打った文字も欄へ入る');
      await ready(typing);assert.equal(typingPosts.length,0);await typing.close();
    }
    const page=await browser.newPage({viewport:{width:320,height:900}}),posts=[],requests=[];await offline(page,posts,requests);
    await page.goto(origin+'/job/'+media+'/20261011/',{waitUntil:'domcontentloaded'});
    assert.ok(!requests.includes('/assets/search-ui.js'));assert.ok(!requests.includes('/job/'+media+'/search-index.json'));
    for(const width of [320,375,720]) {
      await page.setViewportSize({width,height:900});
      const logo=await page.locator('.brand-mark').boundingBox(),form=await page.locator('.header-search').boundingBox();
      assert.ok(logo.x+logo.width<=form.x,media+'/'+width+': 読み込み前の検索欄がロゴに重ならない');
      assert.ok(form.width<=150,media+'/'+width+': 読み込み前はコンパクトな幅');
    }
    await page.locator('#headerSearchInput').fill('収納');await page.locator('.st-search-input').waitFor();
    await page.waitForFunction(()=>document.querySelector('.header-search').dataset.stSearchOwned==='1');
    assert.match(await page.locator('.st-search-notice').textContent(),/TypeSafe AI/);await page.locator('#headerSearchInput').press('Enter');
    await page.waitForURL('**/job/'+media+'/#archiveSearch');await ready(page);await page.waitForFunction(()=>document.querySelector('.st-search-semantic').hidden);
    assert.equal(posts.length,1,'号の確定はポータルでもAI検索を一度送る');assert.equal(await page.evaluate(()=>sessionStorage.getItem('st-search-explicit')),null);await page.close();
    const early=await browser.newPage(),earlyPosts=[],earlyRequests=[];await offline(early,earlyPosts,earlyRequests,'/assets/search-ui.js');
    await early.goto(origin+'/job/'+media+'/20261011/',{waitUntil:'domcontentloaded'});
    const loading=early.waitForRequest(r=>new URL(r.url()).pathname==='/assets/search-ui.js');
    await early.locator('#headerSearchInput').fill('収納');await loading;await early.locator('#headerSearchInput').dispatchEvent('compositionstart');await early.locator('#headerSearchInput').press('Enter');
    assert.ok(early.url().includes('20261011'));await early.locator('#headerSearchInput').dispatchEvent('compositionend');await early.locator('#headerSearchInput').press('Enter');
    await early.waitForURL('**/job/'+media+'/#archiveSearch');
    assert.equal(earlyPosts.length,0);assert.equal(await early.evaluate(()=>sessionStorage.getItem('st-search-explicit')),null);await early.close();
    console.log(media+': 号の遅延読み込み・確定受け渡し・取得前IME');
    const pending=await browser.newPage(),pendingPosts=[];const release=await offline(pending,pendingPosts,[],'/assets/search-ui.js');
    await pending.goto(origin+'/job/'+media+'/',{waitUntil:'commit'});
    const field=pending.locator('#headerSearchInput');await field.fill('収納');await field.press('Enter');await release();await ready(pending);
    assert.equal(pendingPosts.length,0);assert.equal(await field.inputValue(),'収納');
    assert.equal(await pending.getByRole('button',{name:'AIで関連する候補も探す',exact:true}).isVisible(),true);await pending.close();
    for(const entry of ['tag','watch']) {
      const p=await browser.newPage(),ps=[];await p.addInitScript(media=>localStorage.setItem('daily_watch_topics:'+media,JSON.stringify(['収納'])),media);
      const release=await offline(p,ps,[],'/job/'+media+'/search-index.json');await p.goto(origin+'/job/'+media+'/',{waitUntil:'domcontentloaded'});
      await p.locator(entry==='tag'?'a.topic-tag[href^="#q="]':'.watch-topic-search').first().click();await release();await ready(p);
      assert.equal(ps.length,0);assert.equal(await p.getByRole('button',{name:'AIで関連する候補も探す',exact:true}).isVisible(),true);await p.close();
    }
    const failed=await browser.newPage(),failedPosts=[];await offline(failed,failedPosts);
    await failed.route('**/assets/search-ui.js*',route=>route.abort());await failed.goto(origin+'/job/'+media+'/20261011/',{waitUntil:'domcontentloaded'});
    await failed.locator('#headerSearchInput').fill('収納');await failed.locator('#headerSearchInput').press('Enter');await failed.waitForURL('**/job/'+media+'/#archiveSearch');
    assert.equal(failedPosts.length,0);assert.equal(await failed.evaluate(()=>sessionStorage.getItem('st-search-explicit')),null);await failed.close();
    console.log(media+': ポータル取得前の確定・タグ・ウォッチ・取得失敗を確認');
  }
} finally {if(browser) await browser.close();await new Promise(r=>server.close(r));}
