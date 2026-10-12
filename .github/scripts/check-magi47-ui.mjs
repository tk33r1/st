// 候補Workerの説明を使うローカル表示確認。AI・計測・本番APIへの通信は行わない。
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {createServer} from 'node:http';
import {resolve,extname,sep} from 'node:path';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
const root=resolve('_site'),out=resolve('workers/.wrangler/magi2-app47-eval');mkdirSync(out,{recursive:true});
const modelFile=resolve(out,'models.json');
execFileSync(process.execPath,['.github/scripts/eval-magi-models.mjs','--check','--models-output='+modelFile]);
const models=JSON.parse(readFileSync(modelFile,'utf8'));
const server=createServer((req,res)=>{let path=new URL(req.url,'http://localhost').pathname;if(path.endsWith('/'))path+='index.html';const file=resolve(root,'.'+path);
 if(!file.startsWith(root+sep)||!existsSync(file)){res.writeHead(404);res.end();return;}
 res.writeHead(200,{'Content-Type':({'.html':'text/html;charset=utf-8','.js':'application/javascript','.css':'text/css','.json':'application/json'})[extname(file)]||'application/octet-stream'});res.end(readFileSync(file));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch(),results=[];
try{for(const [label,path]of [['top-en','/'],['top-ja','/'],['PWA','/magi-app/www/'],['DJ','/dj/request/'],['404','/404.html']]){
 const page=await browser.newPage({viewport:{width:label.startsWith('top')?1280:390,height:900},serviceWorkers:'block'}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(()=>localStorage.setItem('st-analytics','off'));
 await page.route('**/*',async route=>{const url=new URL(route.request().url());
  if(url.pathname==='/magi2/models'){await route.fulfill({json:models});return;}
  if(url.pathname==='/dj/api/req/event'){await route.fulfill({json:{open:true,title:'表示確認',code:'review'}});return;}
  if(url.pathname==='/search/api/rank'){await route.fulfill({status:503,json:{error:{code:'rank_unavailable'}}});return;}
  if(url.origin!==origin){await route.fulfill({status:200,body:''});return;}await route.continue();});
 await page.goto(origin+path,{waitUntil:'domcontentloaded'});
 if(label.startsWith('top')||label==='PWA'){
  await page.locator('.magi-ver').waitFor();
  if(label==='top-ja'){await page.locator('#cmd-input').fill('japanese ja');await page.locator('#cmd-input').press('Enter');}
  await page.locator('.magi-node[data-codename="BALTHASAR-2"]').click();await page.locator('.magi-desc').getByText(/Anthropic/).waitFor();
  assert.ok((await page.locator('.magi-desc').textContent()).includes(models.personas['BALTHASAR-2'].model));
  await page.locator('.magi-node[data-codename="Shinya Takeda"]').click();await page.locator('.magi-desc').getByText(/Anthropic/).waitFor();
  const description=await page.locator('.magi-desc').textContent();assert.match(description,/OpenAI/);assert.match(description,/Anthropic/);
  await page.screenshot({path:resolve(out,label+'-models.png')});await page.locator('#btn-info-agent').click();
  await page.locator('.agent-privacy-list').getByText(/Anthropic/).first().waitFor();
  const text=await page.locator('.agent-privacy-list').textContent();assert.match(text,/30/);assert.doesNotMatch(text,/Gemini|Google/);
 }else if(label==='DJ'){
  await page.locator('[data-tab="consult"]').click();await page.locator('#aiInfoBtn').click();const text=await page.locator('#aiInfoDlg').innerText();
  assert.match(text,/Anthropic/);assert.match(text,/30/);assert.doesNotMatch(text,/Gemini|Google|無料枠/);
 }else{
  const search=page.locator('#common-search input[type="search"]');await search.fill('不存在の検索語zq9876');await search.press('Enter');
  await page.locator('#ai-info-open').click();const text=await page.locator('#ai-info-text').innerText();assert.match(text,/Anthropic/);assert.doesNotMatch(text,/Gemini|Google/);
  assert.match(await page.locator('#analytics-info-text').innerText(),/Google/);
  assert.equal(await page.getByRole('link',{name:'Anthropic API privacy'}).getAttribute('href'),'https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data');
 }
 await page.screenshot({path:resolve(out,label+'-privacy.png')});assert.deepEqual(errors,[]);results.push({label,pass:true});console.log(label+' OK');await page.close();
}}finally{writeFileSync(resolve(out,'actual-ui.json'),JSON.stringify(results,null,2));await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
