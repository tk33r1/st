// 先行0の公開確認。本番の固定URLだけを使い、合成入力でSSE・検索・画面を点検する。
// 結果にキーや会話本文を入れず、公開後の少数確認として品質評価と区別する。
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {performance} from 'node:perf_hooks';
import {chromium} from 'playwright';
const option=(key,fallback)=>{const i=process.argv.indexOf(key);return i<0?fallback:process.argv[i+1];};
const phase=option('--phase','worker');assert.ok(['worker','pages'].includes(phase));
const out=resolve(option('--report','workers/.wrangler/magi2-stream-eval/magi-'+phase+'.json'));
const report={phase,started:new Date().toISOString(),pass:false,cases:[],limitations:'Chromiumのみ。Android実機・会社PC・OSのIMEは含まない。'};
const origin='https://tk.st',api='https://workers.tk.st';let browser;
async function context() {
  const ctx=await browser.newContext({locale:'ja-JP',serviceWorkers:'block'}),posts=[],errors=[],blocked=[];
  await ctx.addInitScript(()=>localStorage.setItem('st-analytics','off'));
  await ctx.route('**/*',route=>{
    const req=route.request(),url=new URL(req.url());
    if(url.pathname==='/search/api/click'){blocked.push('click');return route.abort();}
    if(url.origin===origin&&!url.pathname.startsWith('/cdn-cgi/')){
      if(url.pathname==='/search/api/rank')posts.push(req.postDataJSON());
      return route.continue();
    }
    if(url.origin===api&&url.pathname.startsWith('/magi2/'))return route.continue();
    blocked.push(url.host);return route.abort();
  });
  const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));
  return {ctx,page,posts,errors,blocked};
}
async function probe() {
  const start=performance.now(),res=await fetch(api+'/magi2/chat',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},
    body:JSON.stringify({messages:[{role:'user',content:'小さな書店です。月の販促予算2万円、平日は1人、週末だけ手伝いが来ます。新規客向けSNSと常連向け読書会のどちらに注力するか、弱点と3か月で判断する基準も検討してください。'}],
      classification_state:true,entry:'chat',ui_language:'ja',reply_language:{version:1,code:'ja',source:'ui'},magi_panel:true,theme:'light',adaptive_debate:true,suggest:true}),signal:AbortSignal.timeout(300000)});
  assert.equal(res.status,200);assert.equal(res.headers.get('cache-control'),'no-cache, no-transform');assert.equal(res.headers.get('x-accel-buffering'),'no');
  const reader=res.body.getReader(),decoder=new TextDecoder(),pings=[],events=[],chunks=[];let buffer='',firstComment=false;
  try {while(true){const {done,value}=await reader.read();if(done)break;const ms=Math.round(performance.now()-start);chunks.push({ms,bytes:value.length});buffer+=decoder.decode(value,{stream:true});let i;
    while((i=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,i);buffer=buffer.slice(i+2);if(!firstComment){assert.equal(block.length+2,2048);assert.ok(block.startsWith(':'));firstComment=true;}
      if(block===': ping')pings.push(ms);const ev=block.match(/^event: (.+)$/m)?.[1];if(ev)events.push({ev,ms});}
  }} finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
  assert.ok(firstComment);assert.ok(events.some(e=>e.ev==='done'));assert.ok(!events.some(e=>e.ev==='error'));assert.ok(pings.length,'10秒のpingが実際に届くこと');
  const value={name:'production-SSE',firstChunkMs:chunks[0].ms,chunks:chunks.length,pings,eventCounts:Object.fromEntries([...new Set(events.map(e=>e.ev))].map(ev=>[ev,events.filter(e=>e.ev===ev).length])),elapsedMs:Math.round(performance.now()-start)};
  report.cases.push(value);console.log(JSON.stringify(value));
}
async function search() {
  const {ctx,page,posts,errors}=await context();try {
    await page.goto(origin+'/',{waitUntil:'domcontentloaded'});await page.locator('[data-act="search"]').click();
    await page.waitForFunction(()=>document.getElementById('search-form').dataset.stSearchOwned==='1'&&document.querySelector('[data-st-search-readings=ready]'));
    const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/search/api/rank'&&r.request().method()==='POST');
    await page.locator('#search-input').fill('DJ');await page.locator('#search-input').press('Enter');const data=await (await response).json();
    assert.ok(['results','no_results'].includes(data.status),'top Search: '+data.reason);assert.equal(data.complete,true);assert.deepEqual(data.searched.generation,posts[0].generation);
    await page.waitForFunction(()=>!document.querySelector('.st-search-rank-status')?.textContent.includes('探しています'));
    assert.ok(await page.locator('#search-shared .st-search-local a').count(),'①のページ');
    const before=posts.length;await page.locator('#search-shared [data-command]').first().click();await page.waitForTimeout(200);assert.equal(posts.length,before,'コマンドでは②を送らない');assert.deepEqual(errors,[]);
    report.cases.push({name:'top-Search',rank:data.status,generation:data.searched.generation,commandWithoutRank:true,keyword:true});
    const legacy=await page.evaluate(async endpoint=>{
      const values=[];for(const [scope,query] of [['site','Thought'],['nitori','収納'],['retail','AI'],['tools','PDF'],['game','MASALA']]){
        const res=await fetch(endpoint+'/magi2/site-search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'rank',scope,query,locale:'ja'})});const data=await res.json();values.push({scope,http:res.status,status:data.status,reason:data.reason,count:data.results?.length,complete:data.complete});}
      return values;
    },api);
    for(const item of legacy){if(['tools','game'].includes(item.scope))assert.equal(item.http,400);else {assert.equal(item.http,200,item.scope+': '+item.reason);assert.ok(['results','no_results'].includes(item.status));assert.equal(item.complete,true);}}
    report.cases.push({name:'legacy-rank',values:legacy});console.log('top Search・旧入口3scope・tools/game拒否 OK');
  } finally {await ctx.close();}
  const c=await context();try {
    await c.page.goto(origin+'/magi-publication/missing/',{waitUntil:'domcontentloaded'});await c.page.waitForFunction(()=>document.querySelector('[data-st-search-readings=ready]'));
    await c.page.locator('.st-search-input').fill('PDF');await c.page.locator('.st-search-input').press('Enter');await c.page.locator('#ai-run').waitFor({state:'visible'});
    const response=c.page.waitForResponse(r=>r.url().includes('/magi2/site-search?site_debate=1'));
    await c.page.locator('#ai-run').click();const res=await response;assert.equal(res.status(),200);const data=await res.json();assert.ok(['results','no_results'].includes(data.status));
    await c.page.locator('#ai-result').waitFor({state:'visible',timeout:165000});await c.page.locator('#ai-info-open').click();
    const explanation=await c.page.locator('#ai-info-dialog').innerText();assert.match(explanation,/OpenAI/);assert.match(explanation,/DeepSeek/);assert.match(explanation,/Google/);assert.deepEqual(c.errors,[]);
    report.cases.push({name:'404-third-search',status:data.status,count:data.results.length,explanation:true});console.log('404③・説明 OK');
  } finally {await c.ctx.close();}
}
async function pages() {
  for(const [name,path] of [['top','/'],['PWA','/magi-app/www/'],['DJ','/dj/request/']]) {
    const c=await context();try {
      if(name!=='top')await c.page.setViewportSize({width:390,height:900});
      const board=name==='DJ'?c.page.waitForResponse(r=>new URL(r.url()).pathname==='/dj/api/req/board'):null;
      await c.page.goto(origin+path,{waitUntil:'domcontentloaded'});
      if(board){const res=await board;assert.equal(res.status(),200);await res.finished();await c.page.waitForTimeout(200);}
      if(name==='DJ')await c.page.locator('[data-tab="consult"]').click();else await c.page.waitForFunction(()=>document.body.innerText.includes('ver 4.5'));
      const input=name==='DJ'?'#chatInput':'#agent-input',send=name==='DJ'?'#chatSend':'#agent-send';
      if(name==='DJ'&&await c.page.locator(input).isDisabled()) {
        // 受付を勝手に開かず、画面のロックと同じDJ契約の通信を分けて記録する。
        const res=await fetch(api+'/magi2/chat',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:'落ち着いた夕方に合うソウルの曲を3曲提案して。'}],entry:'dj-request',classification_state:true,ui_language:'ja',language_seed:'落ち着いた夕方に合うソウルの曲を3曲提案して。',theme:'dark',adaptive_debate:true,suggest:true,context:'公開確認用の合成相談。受付は閉じたまま。'}),signal:AbortSignal.timeout(300000)});
        assert.equal(res.status,200);const text=await res.text();assert.match(text,/event: done/);assert.doesNotMatch(text,/event: error/);report.cases.push({name,locked:true,transportOnly:true,done:true});console.log(name+': 受付外の画面・DJ契約の通信 OK（画面送信は未実施）');continue;
      }
      const answer=name==='DJ'?'.ab':'.agent-reply-body';await c.page.locator(input).fill('短い休憩に散歩を取り入れたい。続けるコツを教えて。');await c.page.locator(send).click();
      let finished=false,note=false;for(let i=0;i<1240;i++){if(await c.page.locator('.magi-stream-note').count())note=true;if(!await c.page.locator(input).isDisabled()){finished=true;break;}await c.page.waitForTimeout(250);}
      assert.ok(finished);assert.ok(!note,'通常受信で注記なし');const text=await c.page.locator(answer).last().textContent();assert.ok(text.trim());assert.equal(await c.page.locator(input).inputValue(),'');
      const stored=await c.page.evaluate(dj=>localStorage.getItem(dj?'tkdj.consults':'magi_current_history'),name==='DJ');
      const has=value=>value===text||value&&typeof value==='object'&&Object.values(value).some(has);assert.ok(has(JSON.parse(stored)));assert.deepEqual(c.errors,[]);
      report.cases.push({name,done:true,notice:false,answerChars:text.length,saved:true});console.log(name+': 本番の受信・表示・保存 OK');
    } finally {await c.ctx.close();}
  }
}
try {
  browser=await chromium.launch({headless:true});
  if(phase==='worker'){await probe();await search();}else {await pages();}
  report.pass=true;
} catch(error){report.error=error.message;throw error;}
finally{mkdirSync(dirname(out),{recursive:true});writeFileSync(out,JSON.stringify(report,null,2)+'\n');await browser?.close();}
