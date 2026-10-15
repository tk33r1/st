// 404の会話継続。生成AI・Jev・計測の外部送信は模擬し、出荷索引と実画面だけを使う。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,existsSync,statSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,sep,extname} from 'node:path';
import {chromium} from 'playwright';
const remote=process.argv.find(v=>v.startsWith('--base='))?.slice(7);
if(remote && remote!=='https://tk.st')throw new Error('publication_base_not_allowed');
const root=resolve('.'),out=resolve('workers/.wrangler/magi2-dialogue-a5/'+(remote?'public-browser':'browser'));mkdirSync(out,{recursive:true});
const server=createServer((req,res)=>{let path=new URL(req.url,'http://localhost').pathname;if(path.endsWith('/'))path+='index.html';
 let file=resolve(root,'_site','.'+path);if(!file.startsWith(resolve(root,'_site')+sep)){res.writeHead(400);res.end();return;}
 if(path==='/assets/search-ui.js')file=resolve(root,'assets/search-ui.js');
 const found=existsSync(file)&&statSync(file).isFile();if(!found||path==='/404.html')file=resolve(root,'404.html');
 res.writeHead(found?200:404,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'application/javascript','.json':'application/json','.css':'text/css'})[extname(file)]||'application/octet-stream'});res.end(readFileSync(file));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=remote || 'http://localhost:'+server.address().port;
const browser=await chromium.launch(),results=[];
try{
 for(const [lang,width,off] of [['ja',390,true],['en',1280,false]]){
  const page=await browser.newPage({viewport:{width,height:900},locale:lang==='ja'?'ja-JP':'en-US',serviceWorkers:'block'}),errors=[],posts=[],rank=[];let mode='normal',release;
  page.on('pageerror',e=>errors.push(e.message));if(off)await page.addInitScript(()=>localStorage.setItem('st-analytics','off'));
  await page.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());
   if(url.pathname==='/search/api/rank'){const body=req.postDataJSON();rank.push(body);return route.fulfill({json:{status:'no_results',complete:true,cached:false,results:[],searched:{scope:body.scope,filters:body.filters,generation:body.generation,total:20,candidates:20,judged:20}}});}
   if(url.pathname==='/magi2/site-search'){const body=req.postDataJSON();posts.push(body);assert.equal(url.search,'?site_debate=1&site_chat=1');
    if(mode==='slow')await new Promise(r=>release=r);
    if(mode==='failure')return route.fulfill({status:503,json:{error:{code:'search_unavailable'}}});
    return route.fulfill({headers:{'Access-Control-Allow-Origin':origin},json:{status:'results',results:[{id:'tool:7',title:'PDF Studio',description:'<b>文字だけ</b>',kind:'tool',url:'/tools/pdf-studio/'}],comment:'回答 '+posts.length+' <img src=x onerror=alert(1)>',reply_language:{version:1,code:lang,source:'jev'},closed:mode==='closed'}});}
   if(url.origin!==origin||url.pathname==='/assets/analytics.js')return route.fulfill({body:''});return route.continue();});
  await page.goto(origin+'/a5-validation/missing/',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>document.querySelector('[data-st-search-readings=ready]'));
  const query=page.locator('.st-search-input'),follow=page.locator('#ai-followup-input');
  await query.fill('PDF');await query.press('Enter');await page.locator('#ai-run').waitFor();await page.locator('#ai-run').click();await page.locator('#ai-followup').waitFor();
  assert.equal(posts.length,1);assert.deepEqual(posts[0].history,[]);assert.equal(posts[0].query,'PDF');assert.equal(await page.locator('#ai-result img').count(),0);
  await query.fill('下書き');await query.press('Escape');assert.equal(await page.locator('#ai-followup').isVisible(),true);
  await query.fill('PDF');await query.press('Enter');await page.waitForTimeout(100);assert.equal(posts.length,1);assert.equal(rank.length,1);assert.equal(await page.locator('#ai-followup').isVisible(),true);
  const beforeRank=rank.length;
  await follow.fill('それの使い方は？ a.b@example.com 090-1234-5678');await page.locator('#ai-followup-send').click();await page.waitForFunction(()=>document.getElementById('ai-comment').textContent.includes('回答 2'));
  assert.equal(posts[1].history.length,2);assert.equal(posts[1].reply_language.code,lang);assert.equal(rank.length,beforeRank);assert.equal(await page.locator('.ai-past-turn').count(),1);
  await follow.fill('もう少し');await follow.dispatchEvent('compositionstart');await page.locator('#ai-followup').dispatchEvent('submit');await page.waitForTimeout(100);assert.equal(posts.length,2);await follow.dispatchEvent('compositionend');
  mode='failure';await page.locator('#ai-followup-send').click();await page.locator('#ai-status').filter({hasText:/いまは|not available/}).waitFor();assert.equal(await page.locator('.ai-past-turn').count(),1);assert.equal(await follow.inputValue(),'もう少し');
  mode='normal';await page.locator('#ai-followup-send').click();await page.waitForFunction(()=>document.getElementById('ai-comment').textContent.includes('回答 4'));assert.equal(await page.locator('.ai-past-turn').count(),2);
  await page.locator('#ai-result').screenshot({path:resolve(out,lang+'-conversation.png')});
  const entries=await page.evaluate(()=>JSON.stringify(Object.keys(localStorage).map(k=>[k,localStorage.getItem(k)]))+JSON.stringify(Object.keys(sessionStorage).map(k=>[k,sessionStorage.getItem(k)])));assert.ok(!entries.includes('それの使い方')&&!entries.includes('onerror'));
  mode='slow';release=null;await follow.fill('回答を待つ質問');await page.locator('#ai-followup-send').click();
  while(!release)await page.waitForTimeout(10);await follow.fill('回答待ちに書いた次の質問');release();
  await page.waitForFunction(()=>document.getElementById('ai-comment').textContent.includes('回答 5'));
  assert.equal(await follow.inputValue(),'回答待ちに書いた次の質問');
  // IMEの変換中なら、文字列がまだ変わっていなくても消さない。
  mode='slow';release=null;await follow.fill('変換中の質問');await page.locator('#ai-followup-send').click();
  while(!release)await page.waitForTimeout(10);await follow.dispatchEvent('compositionstart');release();
  await page.waitForFunction(()=>document.getElementById('ai-comment').textContent.includes('回答 6'));
  assert.equal(await follow.inputValue(),'変換中の質問');await follow.dispatchEvent('compositionend');
  mode='slow';release=null;await follow.fill('遅い質問');await page.locator('#ai-followup-send').click();await page.waitForFunction(()=>!document.getElementById('ai-cancel').hidden);
  while(!release)await page.waitForTimeout(10);await query.fill('QR');await query.press('Enter');await page.waitForTimeout(150);assert.equal(await page.locator('#ai-result').isHidden(),true);release();await page.waitForTimeout(100);assert.equal(await page.locator('#ai-result').isHidden(),true);
  mode='normal';await page.locator('#ai-run').click();await page.locator('#ai-followup').waitFor();assert.deepEqual(posts.at(-1).history,[]);
  mode='closed';await follow.fill('会話終了の確認');await page.locator('#ai-followup-send').click();await page.locator('#ai-closed').waitFor();assert.equal(await page.locator('#ai-followup').isHidden(),true);
  await query.fill('PDF');await query.press('Enter');await page.locator('#ai-run').waitFor();assert.equal(await page.locator('#ai-closed').isHidden(),true);
  const events=await page.evaluate(()=>(window.dataLayer||[]).filter(e=>/^not_found_ai/.test(e.event||'')));
  if(off)assert.equal(events.length,0);else{const followEvents=events.filter(e=>e.event==='not_found_ai_followup');assert.ok(followEvents.length>=2);assert.equal(followEvents[0].turn,2);assert.ok(!followEvents[0].search_term.includes('a.b@example.com')&&!followEvents[0].search_term.includes('090-1234-5678'));assert.ok(followEvents.every(e=>Object.keys(e).every(k=>['event','search_term','turn'].includes(k))));}
  await page.reload();assert.equal(await page.locator('#ai-result').isHidden(),true);assert.deepEqual(errors,[]);assert.ok(!page.url().includes('PDF'));
  results.push({lang,width,off,pass:true});console.log(lang+' OK');await page.close();
 }
 writeFileSync(resolve(out,'results.json'),JSON.stringify(results,null,2));
}finally{await browser.close();await new Promise(r=>server.close(r));}
