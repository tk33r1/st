// A4の更新履歴を本物の画面で確認。上流AIと解析はすべて模擬する。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,sep,extname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
const remote=process.argv.find(v=>v.startsWith('--base='))?.slice(7);
if(remote && remote!=='https://tk.st')throw new Error('publication_base_not_allowed');
const root=resolve('.'),out=resolve('workers/.wrangler/magi2-dialogue-a4/'+(remote?'public-browser':'browser'));mkdirSync(out,{recursive:true});
const data=JSON.parse(readFileSync('data/magi-versions.json','utf8'));
const modelsFile=resolve(out,'models.json');
execFileSync(process.execPath,['.github/scripts/eval-magi-models.mjs','--check','--models-output='+modelsFile]);
const models=JSON.parse(readFileSync(modelsFile,'utf8'));
const server=createServer((req,res)=>{let path=new URL(req.url,'http://localhost').pathname;if(path.endsWith('/'))path+='index.html';
 const f=resolve(root,'.'+path);if(!f.startsWith(root+sep)||!existsSync(f)){res.writeHead(404);res.end();return;}
 res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'application/javascript','.json':'application/json'})[extname(f)]||'application/octet-stream'});res.end(readFileSync(f));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=remote || 'http://localhost:'+server.address().port;
const browser=await chromium.launch(),results=[];
try {
 for(const [label,path,width,lang,theme] of [['home-ja-light','/',1280,'ja','light'],['home-en-dark','/',390,'en','dark'],['app-ja-dark','/magi-app/www/',390,'ja','dark'],['app-en-light','/magi-app/www/',1280,'en','light']]){
  const page=await browser.newPage({viewport:{width,height:900},serviceWorkers:'block'}),errors=[];let mode='normal',calls=0;
  page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(()=>localStorage.setItem('st-analytics','off'));
  await page.route('**/*',async route=>{const url=new URL(route.request().url());
   if(url.pathname==='/magi2/versions'){calls++;const payload=structuredClone(data);if(mode==='xss')payload.versions[0].changes[lang][0]='<img src=x onerror=alert(1)> & <確認>';
    return route.fulfill(mode==='failure'?{status:503,body:''}:{json:payload,headers:{'Access-Control-Allow-Origin':origin}});}
   if(url.pathname==='/magi2/models')return route.fulfill({json:models});
   if(url.pathname==='/magi2/chat'){const event=(name,data)=>`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    return route.fulfill({contentType:'text/event-stream',headers:{'Access-Control-Allow-Origin':origin},body:event('integrated',{delta:'回答しました。'})+event('done',{})});}
   if(url.origin!==origin)return route.fulfill({body:''});return route.continue();});
  async function open(){await page.goto(origin+path,{waitUntil:'domcontentloaded'});await page.locator('#agent-input').waitFor({state:'attached'}); if(path==='/')await page.evaluate(()=>openAgentDock()); await page.locator('#btn-versions-agent').waitFor();
   await page.evaluate(({lang,theme})=>{if(typeof setLanguage==='function')setLanguage(lang);document.documentElement.lang=lang;document.documentElement.setAttribute('data-theme',theme);},{lang,theme});}
  await open();assert.equal(calls,0);
  await page.screenshot({path:resolve(out,label+'-splash.png'),animations:'disabled'});
  assert.equal(await page.locator('.magi-sub #btn-info-agent').count(),1);
  await page.locator('#btn-info-agent').click();await page.locator('#agent-info-panel').waitFor();
  await page.locator('#agent-info-panel .agent-panel-close').click();
  await page.locator('#btn-versions-agent').click();await page.locator('.agent-versions-list section').first().waitFor();
  assert.equal(await page.locator('.agent-versions-list section').count(),26);
  assert.equal(await page.locator('.agent-versions-list h3').first().textContent(),'ver 5.1');
  assert.equal(await page.locator('.agent-versions-title').textContent(),lang==='ja'?'更新履歴':'Release History');
  const list=page.locator('.agent-versions-list');assert.equal(await list.getAttribute('lang'),lang);
  assert.equal(await list.evaluate(e=>e.scrollHeight>e.clientHeight),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:resolve(out,label+'.png'),animations:'disabled'});
  await list.evaluate(e=>e.scrollTop=e.scrollHeight);
  assert.equal(await list.locator('h3').last().textContent(),lang==='ja'?'それ以前':'Earlier releases');
  if(path==='/'){await page.evaluate(()=>setLanguage('en'));assert.equal(await list.getAttribute('lang'),'en');assert.equal(await page.locator('.agent-versions-title').textContent(),'Release History');}
  await page.locator('#agent-versions-panel .agent-panel-close').click();await page.locator('#btn-versions-agent').click();assert.equal(calls,1);
  mode='xss';await open();await page.locator('#btn-versions-agent').click();await list.locator('section').first().waitFor();assert.equal(await list.locator('img').count(),0);assert.ok((await list.textContent()).includes('<img src=x onerror=alert(1)>'));
  mode='failure';await open();await page.locator('#btn-versions-agent').click();await list.locator('[role=status]').filter({hasText:/取得できませんでした|Could not load/}).waitFor();
  await page.locator('#agent-versions-panel .agent-panel-close').click();await page.locator('#agent-input').fill('履歴取得の失敗後の確認');await page.locator('#agent-send').click();await page.locator('.agent-turn .agent-reply').filter({hasText:'回答しました。'}).waitFor();
  assert.deepEqual(errors,[]);results.push({label,pass:true});console.log(label+' OK');await page.close();
 }
 writeFileSync(resolve(out,'results.json'),JSON.stringify(results,null,2));
}finally{await browser.close();await new Promise(r=>server.close(r));}
