// 固定した旧HTML・旧daily-uiと、新しいsite-search.jsの組み合わせ。実API・解析送信を遮断する。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
const fixture=JSON.parse(readFileSync(new URL('../site-search/phase4/legacy-contract.json',import.meta.url)));
assert.match(fixture.source_commit,/^[a-f0-9]{40}$/);
const cache=new Map();
function frozen(path) {
  if (!cache.has(path)) cache.set(path,execFileSync('git',['show',fixture.source_commit+':'+path],{maxBuffer:16*1024*1024,stdio:['ignore','pipe','ignore']}));
  return cache.get(path);
}
for (const file of fixture.files) assert.equal(createHash('sha256').update(frozen(file.path)).digest('hex'),file.sha256,file.path);
const server=createServer((req,res)=>{
  let path=new URL(req.url,'http://localhost').pathname.slice(1);
  if (path.endsWith('/') || !path) path+='index.html';
  if (!/^[a-zA-Z0-9/_\-.]+$/.test(path) || path.split('/').includes('..') || path.startsWith('.')) {res.writeHead(404);res.end();return;}
  try {
    const body=path==='assets/site-search.js'?readFileSync(path):frozen(path);
    const type=path.endsWith('.js')?'application/javascript':path.endsWith('.json')?'application/json':path.endsWith('.css')?'text/css':path.endsWith('.html')?'text/html':'application/octet-stream';
    res.writeHead(path==='404.html'?404:200,{'Content-Type':type+'; charset=utf-8'});res.end(body);
  } catch {res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser=await chromium.launch({headless:true});
  for (const scope of ['site','nitori','retail']) {
    const media=scope==='nitori'?'nitoridaily':'retailtechdaily';
    const daily=scope!=='site';
    const head=daily?JSON.parse(frozen(`job/${media}/search-index.json`)):null;
    const row=daily?head.records[0]:null;
    const href=daily?`/job/${media}/${row.url}`:'/tools/csv-json-bridge/';
    const title=daily?row.title:'CSV JSON Bridge';
    const response={status:'results',complete:true,reason:null,searched:{total:1,candidates:1,judged:1,...(daily?{generation:head.generation}:{})},
      results:[{kind:daily?'daily':'tool',title,description:'固定した旧画面の互換確認',url:href}],...(daily?{cached:false}:{})};
    const page=await browser.newPage();
    const errors=[],requests=[];let answer='results';
    page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>{
      let api;
      Object.defineProperty(window,'STSiteSearch',{configurable:true,get:()=>api,set:value=>{
        const original=value.rank;
        value.rank=function(options){const rank=original(options);window.__legacyRank=rank;return rank;};api=value;
      }});
    });
    await page.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      if (request.method()==='OPTIONS' && url.pathname==='/magi2/site-search') {
        await route.fulfill({status:204,headers:{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'POST','Access-Control-Allow-Headers':'Content-Type'}});return;
      }
      if (request.method()==='POST' && url.pathname==='/magi2/site-search') {
        const body=request.postDataJSON();requests.push(body);
        assert.equal(body.scope,scope);assert.equal(body.mode,'rank');assert.equal(body.search_contract,undefined);
        const result=answer==='results'?response:answer==='empty'?{...response,status:'no_results',results:[]}:
          {...response,status:'failed',complete:false,reason:answer==='disabled'?'disabled':'rate_limited',searched:null,results:[]};
        await route.fulfill({status:answer==='limit'?429:200,headers:{'Access-Control-Allow-Origin':origin},contentType:'application/json',body:JSON.stringify(result)});return;
      }
      if (url.origin===origin) await route.continue(); else await route.abort();
    });
    await page.goto(origin+(daily?`/job/${media}/`:'/404.html'),{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>!!window.__legacyRank);
    assert.deepEqual(await page.evaluate(()=>['run','invalidate','cancel','settled','hrefs'].map(key=>typeof window.__legacyRank[key])),Array(5).fill('function'));
    const input=page.locator(daily?'#archiveSearchInput':'#query');
    const list=page.locator(daily?'#archiveRankList a':'#rank-list a');
    await input.fill(daily?title:'CSV');
    assert.equal(requests.length,0,'入力で送信しない');
    await input.press('Enter');
    await page.waitForFunction(()=>window.__legacyRank.state==='results');
    assert.equal(await list.first().getAttribute('href'),href);
    assert.equal(await list.first().locator('.result-title').textContent(),title);
    assert.deepEqual(await page.evaluate(()=>window.__legacyRank.hrefs()),[href]);
    assert.equal((await page.evaluate(()=>window.__legacyRank.settled())).status,'results');
    assert.equal(requests.length,1);
    await input.fill('旧契約の次の検索');
    await page.waitForFunction(()=>window.__legacyRank.state==='stale');
    assert.equal(await list.count(),0);assert.equal(requests.length,1);
    await page.evaluate(()=>window.__legacyRank.cancel());assert.equal(requests.length,1);
    for (const [mode,expected] of [['empty','no_results'],['limit','failed'],['disabled','idle']]) {
      answer=mode;await input.fill('旧契約 '+mode);await input.press('Enter');
      await page.waitForFunction(expected=>window.__legacyRank.state===expected,expected);
      assert.equal(await list.count(),0);
    }
    assert.equal(await page.evaluate(()=>window.__legacyRank.disabled),true);
    assert.equal(requests.length,4);
    assert.deepEqual(errors,[]);
    console.log(`${scope}: 旧HTML＋新JS、描画・状態・中止・停止と明示POSTを確認`);
    await page.close();
  }
  for (const media of ['nitoridaily','retailtechdaily']) {
    const page=await browser.newPage();
    let posts=0;
    await page.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      if (request.method()==='POST') posts++;
      if (url.origin===origin) await route.continue(); else await route.abort();
    });
    await page.goto(`${origin}/job/${media}/20261011/`,{waitUntil:'domcontentloaded'});
    const header=page.locator('.header-search input[type="search"]');
    await header.fill('固定した受け渡し語');
    await header.press('Enter');
    await page.waitForURL(url=>url.origin===origin && url.pathname===`/job/${media}/`);
    assert.equal(await page.locator('#archiveSearchInput').inputValue(),'固定した受け渡し語');
    assert.equal(posts,0,'旧号からの受け渡しで②を送らない');
    console.log(`${media}/20261011: 旧号→旧ポータルの受け渡しと非送信を確認`);
    await page.close();
  }
  // Phase 4のHTMLとページ側JSは固定し、共通UIだけ最新版へ差し替える。
  for(const [scope,path,query] of [['site','/404.html','Thought'],['tools','/tools/','PDF'],['game','/game/','tetris'],['nitori','/job/nitoridaily/','収納'],['retail','/job/retailtechdaily/','AI']]) {
    const page=await browser.newPage(),errors=[],posts=[];page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(()=>localStorage.setItem('st-analytics','off'));
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url());if(url.origin!==origin) {await route.abort();return;}
      if(url.pathname==='/search/api/rank') {
        const body=route.request().postDataJSON();posts.push(body);
        await route.fulfill({json:{status:'no_results',complete:true,cached:false,results:[],searched:{scope,filters:body.filters,generation:body.generation,total:20,candidates:20,judged:20}}});return;
      }
      const file=url.pathname.slice(1)+(url.pathname.endsWith('/')?'index.html':'');let body;
      try {
        if(file==='assets/search-ui.js' || file==='assets/search-ui.css' || file==='assets/site-search.js') body=readFileSync(file);
        else if(/readings|site-keyword/.test(file)) body=readFileSync('_site/'+file);
        else body=execFileSync('git',['show','HEAD:'+file],{maxBuffer:16*1024*1024,stdio:['ignore','pipe','ignore']});
        await route.fulfill({body,contentType:file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':'text/html; charset=utf-8'});
      }catch(_) {await route.fulfill({status:404,body:''});}
    });
    await page.goto(origin+path,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>document.querySelector('[data-st-search-readings=ready]'));
    const field=page.locator('.st-search-input');await field.fill(query);assert.equal(posts.length,0);await field.press('Enter');
    await page.waitForFunction(()=>document.querySelector('.st-search-semantic').hidden);
    assert.ok(await page.locator('.st-search-local > ul > li').count()>0);assert.equal(posts.length,1);assert.deepEqual(errors,[]);
    await page.close();console.log(scope+': Phase 4のHTML＋新共通UI');
  }
} finally {
  if (browser) await browser.close();
  await new Promise(resolve=>server.close(resolve));
}
