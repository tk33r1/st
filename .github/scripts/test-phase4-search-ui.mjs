// 新共通UIを実ブラウザで検証。通信は固定した応答に置き換え、本番Jevは使わない。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {chromium} from 'playwright';
const scripts=['japanese-search.js','site-search.js','search-ui.js'];
const html=`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/assets/search-ui.css"></head><body><main><div id="search"></div></main>${scripts.map(s=>`<script src="/assets/${s}"></script>`).join('')}</body></html>`;
const server=createServer((req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  if(path==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);return;}
  if(!scripts.map(s=>'/assets/'+s).concat('/assets/search-ui.css').includes(path)){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':path.endsWith('.css')?'text/css':'application/javascript'});res.end(readFileSync(path.slice(1)));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
async function setup(page,{scope='tools',initialMismatch=false,slowRecovery=false,readingFailure=false}={}) {
  await page.goto(origin,{waitUntil:'domcontentloaded'});
  await page.evaluate(({scope,initialMismatch,slowRecovery,readingFailure})=>{
    const daily=['nitori','retail'].includes(scope), kind=scope==='game'?'game':daily?'daily':'tool';
    const prefix=scope==='game'?'/game/':daily?`/job/${scope==='nitori'?'nitoridaily':'retailtechdaily'}/20261011/#art-`:'/tools/';
    const records=Array.from({length:250},(_,i)=>({id:kind+':'+(i+1),title:'家電 '+(i+1),description:'収納の道具',category:i%2?'A':'B',genre:i%2?'A':'B',
      href:prefix+(i+1)+(daily?'':'/')}));
    window.stats={bases:0,readings:0,tracks:[]};window.releaseRecovery=null;window.readingFailure=readingFailure;
    const source='1'.repeat(64), generation=daily?'abcd':'2'.repeat(64);
    const adapter={scope,locale:'ja',fields:[{name:'title',mask:1},{name:'description',mask:4}],href:r=>r.href,
      filters:scope==='site'?[]:[{key:scope==='game'?'genre':'category',label:'分野',options:[{value:'',label:'すべて'},{value:'A',label:'A'}]}],
      sorts:[{value:'normal',label:'関連順'},{value:'reverse',label:'逆順',compare:(a,b)=>b.id.localeCompare(a.id)}],
      track:(event,values)=>window.stats.tracks.push({event,values}),
      loadBase:async({cache})=>{
        window.stats.bases++;
        if(cache==='no-cache' && slowRecovery) await new Promise(resolve=>{window.releaseRecovery=resolve;});
        return {records,sourceHash:source,generation};
      },
      loadReadings:async()=>{
        const n=++window.stats.readings;
        if(window.readingFailure) throw new Error('network');
        return {version:1,normalization_revision:1,source_sha256:initialMismatch && n===1?'0'.repeat(64):source,generation:'3'.repeat(64),
          analyzer:{package:'fixture',dictionary:'fixture',dictionary_sha256:'4'.repeat(64),aliases_sha256:'5'.repeat(64)},
          record_ids:records.map(r=>r.id),terms:[{surface:'家電',reading:'かでん',postings:records.map((_,i)=>[i,1])}]};
      }};
    window.ui=STSearchUI.mount(document.querySelector('#search'),adapter);
    window.fixtureRecords=records;
  },{scope,initialMismatch,slowRecovery,readingFailure});
  await page.waitForFunction(()=>window.ui.state.base==='ready');
}
try {
  browser=await chromium.launch({headless:true});
  for(const scope of ['site','tools','game','nitori','retail']) {
    const page=await browser.newPage(), errors=[],posts=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/search/api/rank',async route=>{
      const body=route.request().postDataJSON();posts.push(body);
      const first=await page.evaluate(()=>window.fixtureRecords[0]);
      const kind=scope==='game'?'game':['nitori','retail'].includes(scope)?'daily':'tool';
      await route.fulfill({json:{status:'results',complete:true,cached:false,
        searched:{scope,filters:body.filters,generation:body.generation,total:250,candidates:scope==='site'?250:20,judged:scope==='site'?250:20},
        results:[{id:first.id,kind,title:first.title,description:first.description,url:first.href}]}});
    });
    await setup(page,{scope});await page.waitForFunction(()=>window.ui.state.readings==='ready');
    const input=page.locator('.st-search-input');await input.fill('kaden');
    assert.equal(await input.inputValue(),'kaden');assert.equal(await page.locator('.st-search-suggestions li').count(),6);
    assert.equal(await page.locator('.st-search-suggestions .st-search-count').textContent(),'250件一致');assert.equal(posts.length,0);
    await input.dispatchEvent('compositionstart');await input.press('Enter');assert.equal(posts.length,0);
    await input.dispatchEvent('compositionend');assert.equal(posts.length,0);
    // OSのIMEではなく、Chromiumの入力経路でpreedit→確定Enterを検査する。
    const ime=await page.context().newCDPSession(page);await input.fill('');await input.focus();
    await ime.send('Input.imeSetComposition',{text:'家電',selectionStart:2,selectionEnd:2});
    await page.keyboard.down('Enter');assert.equal(posts.length,0);
    await ime.send('Input.insertText',{text:'家電'});assert.equal(await input.inputValue(),'家電');assert.equal(posts.length,0);
    await page.keyboard.up('Enter');assert.equal(posts.length,0);await ime.detach();
    await page.getByRole('button',{name:'全候補を見る',exact:true}).click();
    assert.equal(await page.locator('.st-search-local li').count(),100);
    await page.evaluate(()=>{window.kept=document.querySelector('.st-search-local li');});
    await page.getByRole('button',{name:'さらに100件表示',exact:true}).click();
    assert.equal(await page.locator('.st-search-local li').count(),200);
    assert.equal(await page.evaluate(()=>window.kept===document.querySelector('.st-search-local li')),true);
    await page.getByRole('button',{name:'さらに100件表示',exact:true}).click();
    assert.equal(await page.locator('.st-search-local li').count(),250);assert.equal(posts.length,0);
    await input.press('Enter');await page.waitForFunction(()=>window.ui.state.rank==='results');assert.equal(posts.length,1);
    assert.equal(await page.locator('.st-search-semantic li').count(),1);assert.equal(await page.locator('.st-search-local li').count(),249);
    assert.equal(await page.locator('.st-search-local li').first().getAttribute('data-id'),scope==='game'?'game:2':['nitori','retail'].includes(scope)?'daily:2':'tool:2');
    await input.press('Enter');assert.equal(posts.length,1,'確定した同条件を重複送信しない');
    await page.locator('[data-sort]').selectOption('reverse');assert.equal(posts.length,1);assert.equal(await page.locator('.st-search-local li').count(),100);
    assert.equal(await page.locator('.st-search-semantic li').count(),0,'並べ替えでも確定済みの②を破棄し、自動再送しない');
    assert.equal(await page.evaluate(()=>window.ui.state.rank),'stale');
    if(scope!=='site') {
      await page.locator('[data-filter]').selectOption('A');assert.equal(posts.length,1);assert.equal(await page.locator('.st-search-semantic li').count(),0);
      assert.equal(await page.locator('.st-search-local li').count(),100);assert.equal(await page.evaluate(()=>window.ui.state.total),125);
    }
    await page.evaluate(()=>{window.ui.setLocale('en');window.ui.setQuery('家電');});assert.equal(posts.length,1);
    assert.equal(await page.getByRole('button',{name:'Search',exact:true}).count(),1);
    assert.ok(!(await page.evaluate(()=>JSON.stringify(window.stats.tracks))).includes('kaden'),'計測に検索語を載せない');
    assert.deepEqual(errors,[]);console.log(`${scope}: 共通候補・全件・追加表示・重複除去・IME抑止・明示POSTを確認`);await page.close();
  }
  {
    const page=await browser.newPage();let posts=0,mode='update';
    await page.route('**/search/api/rank',async route=>{
      posts++;const body=route.request().postDataJSON();
      await route.fulfill({json:{status:'failed',reason:'index_updating',complete:false,cached:false,
        searched:mode==='update'?null:{scope:'tools',filters:body.filters,generation:'9'.repeat(64),total:250,candidates:0,judged:0},results:[]}});
    });
    await setup(page,{initialMismatch:true,slowRecovery:true});
    await page.waitForFunction(()=>typeof window.releaseRecovery==='function');
    const input=page.locator('.st-search-input');await input.fill('家電 249');
    assert.equal(await page.locator('.st-search-suggestions .st-search-count').textContent(),'1件一致');
    await page.evaluate(()=>window.releaseRecovery());await page.waitForFunction(()=>window.ui.state.readings==='ready');
    assert.equal(await input.inputValue(),'家電 249');assert.equal(await page.evaluate(()=>window.stats.bases),2);assert.equal(posts,0);
    await input.press('Enter');await page.waitForFunction(()=>window.ui.state.rank==='index_updating');
    assert.equal(posts,1);assert.equal(await page.evaluate(()=>window.stats.bases),2,'復帰済みの枠をJev失敗で戻さない');
    mode='mismatch';await input.fill('家電');await input.press('Enter');await page.waitForFunction(()=>window.ui.state.rank==='index_updating');
    assert.equal(posts,2);assert.equal(await page.evaluate(()=>window.stats.bases),2);await page.close();
    console.log('版ずれ: 復帰1回・共有待ち・最新入力・searched=null・自動POSTゼロを確認');
  }
  {
    const page=await browser.newPage();let posts=0,release;
    await page.route('**/search/api/rank',async route=>{
      posts++;const body=route.request().postDataJSON();await new Promise(resolve=>{release=resolve;});
      await route.fulfill({json:{status:'no_results',complete:true,cached:false,searched:{scope:'tools',filters:body.filters,generation:body.generation,total:250,candidates:20,judged:20},results:[]}});
    });
    await setup(page,{readingFailure:true});await page.waitForFunction(()=>window.ui.state.readings==='failed');
    const input=page.locator('.st-search-input');await input.fill('家電');assert.equal(await page.evaluate(()=>window.ui.state.total),250);
    assert.equal(await page.evaluate(()=>window.stats.bases),1,'取得失敗では再取得しない');
    await input.press('Enter');await page.waitForFunction(()=>window.ui.state.rank==='loading');
    while(!release) await new Promise(resolve=>setTimeout(resolve,10));
    await input.fill('別の語');await input.fill('家電');release();
    await page.waitForFunction(()=>window.ui.state.rank==='stale');assert.equal(posts,1);assert.equal(await page.locator('.st-search-semantic li').count(),0);
    await page.evaluate(()=>window.ui.destroy());assert.equal(await page.locator('#search').textContent(),'');await page.close();
    console.log('取得失敗・遅い応答: 文字検索を維持し、A→B→Aの旧応答を破棄');
  }
  {
    const page=await browser.newPage();let posts=0;
    await page.addInitScript(()=>Object.defineProperty(window,'scheduler',{value:undefined}));
    await page.route('**/search/api/rank',route=>{posts++;return route.abort();});
    await setup(page);await page.waitForFunction(()=>window.ui.state.readings==='ready');
    await page.locator('.st-search-input').fill('kaden');
    assert.equal(await page.evaluate(()=>window.ui.state.total),250);assert.equal(posts,0);
    await page.evaluate(()=>window.ui.destroy());await page.close();
    console.log('scheduler非対応: タイマーへ縮退し、読みと入力を保持');
  }
} finally {
  if(browser) await browser.close();await new Promise(resolve=>server.close(resolve));
}
