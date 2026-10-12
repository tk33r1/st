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
async function setup(page,{scope='tools',initialMismatch=false,slowRecovery=false,readingFailure=false,slowBase=false,slowReading=false,badRender=false,baseFailure=false,filterChips=false}={}) {
  await page.goto(origin,{waitUntil:'domcontentloaded'});
  await page.evaluate(({scope,initialMismatch,slowRecovery,readingFailure,slowBase,slowReading,badRender,baseFailure,filterChips})=>{
    const daily=['nitori','retail'].includes(scope), kind=scope==='game'?'game':daily?'daily':'tool';
    const prefix=scope==='game'?'/game/':daily?`/job/${scope==='nitori'?'nitoridaily':'retailtechdaily'}/20261011/#art-`:'/tools/';
    const records=Array.from({length:250},(_,i)=>({id:kind+':'+(i+1),title:'家電 '+(i+1),description:'収納の道具',category:i%2?'A':'B',genre:i%2?'A':'B',
      href:prefix+(i+1)+(daily?'':'/')}));
    window.stats={bases:0,readings:0,tracks:[]};window.releaseRecovery=null;window.readingFailure=readingFailure;
    const source='1'.repeat(64), generation=daily?'abcd':'2'.repeat(64);
    const adapter={renderItem:badRender?(record,ctx)=>{const a=document.createElement('a');a.href=record.id.endsWith(':1')?'/tools/wrong/':ctx.href;a.textContent=record.title;return a;}:undefined,scope,locale:'ja',fields:[{name:'title',mask:1},{name:'description',mask:4}],href:r=>r.href,
      filterChips,filters:scope==='site'?[]:[{key:scope==='game'?'genre':'category',label:'分野',options:[{value:'',label:'すべて'},{value:'A',label:'A'}]}],
      sorts:[{value:'normal',label:'関連順'},{value:'reverse',label:'逆順',compare:(a,b)=>b.id.localeCompare(a.id)}],
      track:(event,values)=>window.stats.tracks.push({event,values}),
      loadBase:async({cache})=>{
        window.stats.bases++;if(baseFailure) throw new Error('offline');if(slowBase) await new Promise(r=>window.releaseBase=r);
        if(cache==='no-cache' && slowRecovery) await new Promise(resolve=>{window.releaseRecovery=resolve;});
        return {records,sourceHash:source,generation,...(filterChips?{filterOptions:{category:['A','B']}}:{})};
      },
      loadReadings:async()=>{
        const n=++window.stats.readings;if(slowReading) await new Promise(r=>window.releaseReading=r);
        if(window.readingFailure) throw new Error('network');
        return {version:1,normalization_revision:1,source_sha256:initialMismatch && n===1?'0'.repeat(64):source,generation:'3'.repeat(64),
          analyzer:{package:'fixture',dictionary:'fixture',dictionary_sha256:'4'.repeat(64),aliases_sha256:'5'.repeat(64)},
          record_ids:records.map(r=>r.id),terms:[{surface:'家電',reading:'かでん',postings:records.map((_,i)=>[i,1])}]};
      }};
    window.ui=STSearchUI.mount(document.querySelector('#search'),adapter);
    window.fixtureRecords=records;
  },{scope,initialMismatch,slowRecovery,readingFailure,slowBase,slowReading,badRender,baseFailure,filterChips});
  if(!slowBase) await page.waitForFunction(({baseFailure})=>window.ui.state.base===(baseFailure?'failed':'ready'),{baseFailure});
}
async function rankFixture(page,posts,{delay=false,reason=null}={}) {
  let release;
  await page.route('**/search/api/rank',async route=>{
    const body=route.request().postDataJSON();posts.push(body);
    if(delay) await new Promise(r=>release=r);
    const records=await page.evaluate(()=>window.fixtureRecords),kind=body.scope==='game'?'game':['nitori','retail'].includes(body.scope)?'daily':'tool';
    const rows=reason?[]:[records[0],...records.slice(20,24)];
    await route.fulfill({json:{status:reason?'failed':'results',reason,complete:!reason,cached:false,
      searched:reason?null:{scope:body.scope,filters:body.filters,generation:body.generation,total:250,candidates:20,judged:20},
      results:rows.map(r=>({id:r.id,kind,title:r.title,description:r.description,url:r.href}))}});
  });
  return ()=>release?.();
}
try {
  browser=await chromium.launch({headless:true});
  for(const scope of ['site','tools','game','nitori','retail']) {
    const page=await browser.newPage(),errors=[],posts=[];page.on('pageerror',e=>errors.push(e.message));
    const release=await rankFixture(page,posts,{delay:true});
    await setup(page,{scope});await page.waitForFunction(()=>window.ui.state.readings==='ready');
    const input=page.locator('.st-search-input');await input.fill('kaden');
    assert.equal(await page.locator('[role=option]').count(),7);assert.equal(posts.length,0);
    assert.equal(await page.locator('.st-search-local').isVisible(),false);
    await input.press('Escape');assert.equal(await input.inputValue(),'kaden');assert.equal(await input.getAttribute('aria-expanded'),'false');
    await input.fill('家電');await input.press('ArrowDown');await input.press('Enter');
    await page.waitForFunction(()=>window.ui.state.rank==='loading');assert.equal(posts.length,1);
    assert.equal(await page.locator('.st-search-local > ul > li').count(),20);
    const y=await page.locator('.st-search-local > ul').evaluate(el=>el.getBoundingClientRect().top);
    await input.fill('収納');release();await page.waitForFunction(()=>window.ui.state.rank!=='loading');assert.equal(await page.evaluate(()=>window.ui.state.rank),'results',JSON.stringify({errors,posts}));
    assert.equal(await page.evaluate(()=>window.ui.state.query),'家電');assert.equal(posts[0].query,'家電');
    assert.equal(await page.locator('.st-search-semantic li').count(),3);
    await page.evaluate(()=>window.ui.setQuery('家電'));
    assert.equal(await page.evaluate(()=>window.ui.state.rank),'results','同じ語の受け渡しで②を捨てない');
    assert.equal(await page.locator('.st-search-semantic li').count(),3);assert.equal(posts.length,1);
    assert.equal(await page.locator('.st-search-semantic li').first().getAttribute('data-id'),scope==='game'?'game:21':['nitori','retail'].includes(scope)?'daily:21':'tool:21');
    assert.equal(await page.locator('.st-search-local > ul').evaluate(el=>el.getBoundingClientRect().top),y,'AIの応答で①を押し下げない');
    await input.press('Escape');
    await page.getByRole('button',{name:'すべて表示',exact:true}).click();assert.equal(await page.locator('.st-search-semantic li').count(),4);
    await page.evaluate(()=>window.kept=document.querySelector('.st-search-local > ul > li'));
    await page.getByRole('button',{name:/もっと見る/}).click();assert.equal(await page.locator('.st-search-local > ul > li').count(),40);
    assert.equal(await page.evaluate(()=>window.kept===document.querySelector('.st-search-local > ul > li')),true);
    await page.locator('[data-sort]').selectOption('reverse');assert.equal(await page.evaluate(()=>window.ui.state.rank),'results');assert.equal(posts.length,1);
    if(scope!=='site') {await page.locator('[data-filter]').selectOption('A');assert.equal(await page.evaluate(()=>window.ui.state.total),125);assert.equal(posts.length,1);assert.equal(await page.getByRole('button',{name:'AIで関連する候補も探す',exact:true}).isVisible(),true);}
    await input.focus();await input.press('Escape');await input.press('Escape');assert.equal(await input.inputValue(),'');assert.equal(await page.locator('.st-search-local').isVisible(),true);
    await page.evaluate(()=>window.ui.setQuery('家電'));assert.equal(posts.length,1);
    await input.focus();await input.fill('PDF');assert.equal(await page.locator('.st-search-suggestions .st-search-link').count(),0);
    await input.press('Tab');assert.equal(await input.getAttribute('aria-expanded'),'true');
    await page.locator('.st-search-notice button').focus();assert.equal(await input.getAttribute('aria-expanded'),'true');
    await page.locator('.st-search-notice button').click();await page.locator('dialog button').click();await page.waitForFunction(()=>document.activeElement===document.querySelector('input'));assert.equal(await input.evaluate(el=>document.activeElement===el),true);
    await input.fill('家電');assert.equal(await page.locator('.st-search-suggestions a').first().getAttribute('tabindex'),'-1');
    await input.dispatchEvent('compositionstart');await input.press('Enter');await input.press('Escape');assert.equal(posts.length,1);await input.dispatchEvent('compositionend');await input.fill('家電');
    await page.getByRole('button',{name:'検索をやめる',exact:true}).click();assert.equal(await page.locator('.st-search-local').isVisible(),false);
    assert.deepEqual(errors,[]);await page.close();console.log(`${scope}: 確定語・20件・AI重複除去・高さ・IME・フォーカスを確認`);
  }
  for(const explicit of [false,true]) {
    const page=await browser.newPage(),posts=[];await rankFixture(page,posts);await setup(page,{slowBase:true});
    await page.waitForFunction(()=>!!window.releaseBase);const input=page.locator('.st-search-input');
    if(explicit) {await input.fill('家電');await input.press('Enter');}else await page.evaluate(()=>window.ui.setQuery('家電'));
    await page.evaluate(()=>window.ui.setQuery('家電'));
    assert.equal(posts.length,0);assert.match(await page.locator('.st-search-empty').textContent(),/読み込み中/);
    await page.evaluate(()=>window.releaseBase());await page.waitForFunction(()=>window.ui.state.readings==='ready');
    if(explicit) await page.waitForFunction(()=>window.ui.state.rank==='results');
    assert.equal(posts.length,explicit?1:0);assert.equal(await page.evaluate(()=>window.ui.state.total),250);await page.close();
  }
  // 共通部品は explicit===true のときだけ受け渡しを明示操作として扱う（目印の判定は日刊の daily-ui.js。test-phase4-pages.mjs）。
  for(const explicit of [true,false,'1',null]) {
    const page=await browser.newPage(),posts=[];await rankFixture(page,posts);await setup(page);
    await page.evaluate(explicit=>window.ui.setQuery('家電',explicit===null?undefined:{explicit}),explicit);
    if(explicit===true) await page.waitForFunction(()=>window.ui.state.rank==='results');
    assert.equal(posts.length,explicit===true?1:0);
    await page.evaluate(()=>window.ui.setQuery('家電'));assert.equal(posts.length,explicit===true?1:0);await page.close();
  }
  {
    const page=await browser.newPage(),posts=[];const release=await rankFixture(page,posts,{delay:true});await setup(page);await page.waitForFunction(()=>window.ui.state.readings==='ready');
    await page.locator('input').fill('家電');await page.locator('input').press('Enter');await page.waitForFunction(()=>window.ui.state.rank==='loading');
    await page.evaluate(()=>window.ui.setQuery('家電'));assert.equal(await page.evaluate(()=>window.ui.state.rank),'loading');
    release();await page.waitForFunction(()=>window.ui.state.rank==='results');assert.equal(posts.length,1);
    await page.evaluate(()=>window.ui.handoff());assert.equal(await page.evaluate(()=>window.ui.state.rank),'handoff');
    assert.equal(await page.locator('.st-search-semantic').isVisible(),false,'③へ渡した後は②の再実行を出さない');
    assert.equal(await page.getByRole('button',{name:'AIで関連する候補も探す',exact:true}).isVisible(),false);await page.close();
  }
  {
    const page=await browser.newPage(),posts=[];await rankFixture(page,posts);await setup(page,{slowReading:true});await page.waitForFunction(()=>!!window.releaseReading);
    await page.locator('input').fill('kaden');await page.locator('input').press('Enter');
    assert.match(await page.locator('.st-search-heading').first().textContent(),/読み込み中/);assert.doesNotMatch(await page.locator('.st-search-empty').textContent(),/見つかりません/);
    await page.waitForFunction(()=>window.ui.state.rank==='results');assert.equal(await page.locator('.st-search-semantic li').count(),3);
    await page.evaluate(()=>window.releaseReading());await page.waitForFunction(()=>window.ui.state.readings==='ready');assert.equal(await page.evaluate(()=>window.ui.state.total),250);await page.close();
  }
  for(const reason of ['disabled','rate_limited','unavailable']) {
    const page=await browser.newPage(),posts=[];await rankFixture(page,posts,{reason});await setup(page);await page.locator('input').fill('家電');await page.locator('input').press('Enter');
    await page.waitForFunction(()=>['failed','disabled','rate_limited'].includes(window.ui.state.rank));assert.equal(await page.locator('.st-search-semantic').isVisible(),false);assert.equal(await page.locator('.st-search-rank-status').evaluate(el=>el.getBoundingClientRect().width),1);await page.close();
  }
  {
    const page=await browser.newPage();await setup(page,{badRender:true});await page.evaluate(()=>window.ui.setQuery('家電'));
    assert.equal(await page.locator('.st-search-local > ul > li').count(),19,'検査したhrefと違うカードは出さない');await page.close();
  }
  for(const change of ['filter','query']) {
    const page=await browser.newPage(),posts=[];await rankFixture(page,posts);await setup(page,{slowBase:true});await page.waitForFunction(()=>!!window.releaseBase);
    const input=page.locator('input');await input.fill('家電');await input.press('Enter');
    if(change==='filter') await page.locator('[data-filter]').selectOption('A');
    else {await input.fill('収納');await input.press('Enter');}
    await page.evaluate(()=>window.releaseBase());await page.waitForFunction(()=>window.ui.state.readings==='ready');
    if(change==='filter') {assert.equal(posts.length,0);assert.equal(await page.getByRole('button',{name:'AIで関連する候補も探す',exact:true}).isVisible(),true);}
    else {await page.waitForFunction(()=>window.ui.state.rank==='results');assert.equal(posts.length,1);assert.equal(posts[0].query,'収納');}
    await page.close();
  }
  {
    const page=await browser.newPage(),posts=[];await rankFixture(page,posts);await setup(page,{baseFailure:true});
    await page.locator('input').fill('家電');await page.locator('input').press('Enter');assert.equal(posts.length,0);assert.match(await page.locator('.st-search-empty').textContent(),/準備に失敗/);await page.close();
  }
  {
    const page=await browser.newPage(),posts=[];const release=await rankFixture(page,posts,{delay:true});await setup(page);await page.waitForFunction(()=>window.ui.state.readings==='ready');
    await page.locator('input').fill('架空');await page.locator('input').press('Enter');await page.waitForFunction(()=>window.ui.state.rank==='loading');
    assert.doesNotMatch(await page.locator('.st-search-empty').textContent(),/見つかりません/);assert.equal(await page.locator('.st-search-local > h3').textContent(),'「架空」の検索結果');
    release();await page.waitForFunction(()=>window.ui.state.rank==='results');assert.equal(await page.locator('.st-search-local > ul').getAttribute('data-st-search-list'),'semantic');
    assert.equal(await page.locator('.st-search-local > ul > li').count(),5);assert.match(await page.locator('.st-search-local > h3').textContent(),/近いもの/);
    await page.locator('input').fill('架空');await page.locator('input').press('Enter');assert.equal(posts.length,1);await page.close();
  }
  {
    const page=await browser.newPage(),posts=[];await rankFixture(page,posts);await setup(page,{initialMismatch:true,slowRecovery:true});
    await page.waitForFunction(()=>!!window.releaseRecovery);await page.locator('input').fill('家電 249');await page.evaluate(()=>window.releaseRecovery());await page.waitForFunction(()=>window.ui.state.readings==='ready');
    assert.equal(await page.locator('input').inputValue(),'家電 249');assert.equal(await page.evaluate(()=>window.stats.bases),2);assert.equal(posts.length,0);await page.close();
  }
  {
    const page=await browser.newPage(),posts=[];await rankFixture(page,posts);await setup(page);await page.waitForFunction(()=>window.ui.state.readings==='ready');
    const field=page.locator('input');await field.focus();const ime=await page.context().newCDPSession(page);
    await ime.send('Input.imeSetComposition',{text:'家電',selectionStart:2,selectionEnd:2});await page.keyboard.down('Enter');
    await ime.send('Input.insertText',{text:'家電'});assert.equal(posts.length,0);await page.keyboard.up('Enter');assert.equal(posts.length,0);await ime.detach();
    await page.evaluate(()=>window.ui.setQuery('家電'));assert.equal(posts.length,0);await page.close();
  }
  {
    const page=await browser.newPage();await setup(page,{filterChips:true});
    const group=page.getByRole('group',{name:'分野',exact:true});assert.equal(await group.count(),1);
    assert.equal(await page.locator('.st-search-filters label button').count(),0,'label内にチップを置かない');
    await page.evaluate(()=>window.ui.setLocale('en'));
    assert.equal(await page.locator('[data-filter] option[value=""]').textContent(),'All');
    assert.equal(await page.locator('.st-search-chips button').first().textContent(),'All');
    await page.evaluate(()=>window.ui.setLocale('ja'));
    assert.equal(await page.locator('[data-filter] option[value=""]').textContent(),'すべて');
    assert.equal(await page.locator('.st-search-chips button').first().textContent(),'すべて');await page.close();
  }
  console.log('保留・明示受け渡し・読みの到着・停止・href検査・絞り込みの翻訳を確認');
} finally {if(browser) await browser.close();await new Promise(r=>server.close(r));}
