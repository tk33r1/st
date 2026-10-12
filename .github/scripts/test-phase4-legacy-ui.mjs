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
} finally {
  if (browser) await browser.close();
  await new Promise(resolve=>server.close(resolve));
}
