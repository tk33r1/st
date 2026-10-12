// 実ページ・実索引の接続をローカルで検証する。外部通信・Jevは固定応答に置き換える。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,extname,sep} from 'node:path';
import {chromium} from 'playwright';
const repo=resolve('.'),generated=resolve(process.argv[2] || '.github/scripts/.search-reading-env/work/generated');
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
try {
  browser=await chromium.launch({headless:true});
  const screens=[['site','/404.html','Thought'],['tools','/tools/','PDF'],['game','/game/','MASALA'],['nitori','/job/nitoridaily/','収納'],['retail','/job/retailtechdaily/','AI']];
  for(const [scope,path,query] of screens) {
    const page=await browser.newPage({locale:'ja-JP',viewport:{width:1280,height:900}}),errors=[],requests=[],posts=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(()=>localStorage.setItem('st-analytics','off'));
    await page.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());requests.push(url.pathname);
      if(url.origin!==origin) {await route.fulfill({status:200,body:'',contentType:url.pathname.endsWith('.css')?'text/css':'application/javascript'});return;}
      if(url.pathname==='/search/api/rank') {
        const body=request.postDataJSON();posts.push(body);
        const row=await page.locator('.st-search-local .st-search-result').first().evaluate(li=>({id:li.dataset.id,title:li.querySelector('.st-search-title').textContent,
          description:li.querySelector('.st-search-description')?.textContent || '',url:li.querySelector('a').getAttribute('href')}));
        const kind=scope==='tools'?'tool':scope==='game'?'game':scope==='site'?'page':'daily';
        await route.fulfill({status:200,json:{status:'results',complete:true,cached:false,results:[{...row,kind}],
          searched:{scope,filters:body.filters,generation:body.generation,total:20,candidates:20,judged:20}}});return;
      }
      if(url.pathname==='/magi2/site-search') {throw new Error('新画面が旧②へ送信した');}
      await route.continue();
    });
    await page.goto(origin+path,{waitUntil:'domcontentloaded'});
    await page.locator('.st-search-data-status').filter({hasText:'文字と読みで検索できます'}).waitFor();
    const input=page.locator('.st-search-input');await input.fill(query);
    assert.ok(await page.locator('.st-search-suggestions li').count()>0,scope+' ①の候補');assert.equal(posts.length,0);
    await page.locator('.st-search-suggestions .st-search-button').click();assert.equal(posts.length,0);
    const localCount=await page.locator('.st-search-local li').count();assert.ok(localCount>0);
    await input.press('Enter');await page.locator('.st-search-semantic li').waitFor();
    assert.equal(posts.length,1);assert.equal(posts[0].search_contract,1);assert.equal(posts[0].scope,scope);assert.equal(posts[0].mode,'rank');
    const semanticId=await page.locator('.st-search-semantic li').getAttribute('data-id');
    assert.equal(await page.locator('.st-search-local li').evaluateAll((rows,id)=>rows.filter(row=>row.dataset.id===id).length,semanticId),0,'②の同じhrefを①から除く');
    assert.ok(await page.locator('.st-search-local li').count()<=100,'重複を除いてから表示上限を適用');
    await input.press('Enter');assert.equal(posts.length,1,'同じ確定条件を再送しない');
    await input.fill(query+' 未収録語');assert.equal(await page.locator('.st-search-semantic li').count(),0,'入力変更で②を破棄');assert.equal(posts.length,1);
    if(scope==='tools' || scope==='game') {
      assert.ok(!requests.includes('/data/site-keyword.json') && !requests.includes('/data/site-search.json'),'一覧は自分の索引だけ取得');
      await input.fill('');assert.ok(await page.locator(scope==='tools'?'#tool-grid':'#game-grid').isVisible());
      assert.equal(await page.locator(scope==='tools'?'#tool-grid .tool-card':'#game-grid .game-card').count(),scope==='tools'?9:8,'元のカード一覧を維持');
      assert.equal(await page.locator('meta[http-equiv="Content-Security-Policy"]').count(),scope==='tools'?1:0);
    }
    if(scope==='site') {
      const expected=JSON.parse(readFileSync(resolve(generated,'data/site-keyword.json'))).pages.length;
      assert.equal(await page.locator('.site-tree a').count(),expected);
      assert.equal(await page.locator('.site-tree a[href="/job/nitoridaily/2026/"]').count(),0,'年枝の架空リンクを作らない');
      await input.fill(query);await input.press('Enter');await page.locator('.st-search-semantic li').waitFor();
      await page.locator('#ai-search').waitFor({state:'visible'});assert.ok(await page.locator('#ai-run').isEnabled());
      await input.fill('別の入力');assert.ok(await page.locator('#ai-search').isHidden(),'入力変更で③を消す');
    }
    assert.deepEqual(errors,[],scope+' の実行エラー');
    await page.screenshot({path:resolve(generated,'page-'+scope+'.png'),fullPage:false,animations:'disabled'});
    console.log(`${scope}: 実HTML・読み・明示POST・重複除去・入力変更を確認`);await page.close();
  }
  for(const media of ['nitoridaily','retailtechdaily']) {
    const page=await browser.newPage({locale:'ja-JP'});let posts=0;
    await page.addInitScript(()=>localStorage.setItem('st-analytics','off'));
    await page.route('**/*',async route=>{const url=new URL(route.request().url());if(route.request().method()==='POST') posts++;
      if(url.origin!==origin){await route.fulfill({status:200,body:''});return;}await route.continue();});
    const index=JSON.parse(readFileSync(resolve(generated,'job',media,'search-index.json')));
    const latest=index.records.map(r=>r.date).sort().at(-1);assert.ok(/^[1-9]\d{7}$/.test(latest));
    await page.goto(`${origin}/job/${media}/${latest}/`,{waitUntil:'domcontentloaded'});
    await page.locator('.header-search input[type="search"]').fill('収納');await page.locator('.header-search input[type="search"]').press('Enter');
    await page.waitForURL(url=>url.pathname===`/job/${media}/`);
    await page.locator('.st-search-input').waitFor();assert.equal(await page.locator('.st-search-input').inputValue(),'収納');assert.equal(posts,0);
    assert.equal(new URL(page.url()).hash,'#archiveSearch');assert.ok(!page.url().includes('収納'));
    console.log(`${media}: 号→共通検索への受け渡し、URL除去、POSTゼロを確認`);await page.close();
  }
} finally {if(browser) await browser.close();await new Promise(resolve=>server.close(resolve));}
