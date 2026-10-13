// 承認済みの入力で、ローカル実Workerと新画面・改修前の画面を接続する。
// 本文はGit管理外へ保存し、無関係な外部通信と解析は止める。
// 新Workerと旧画面を比較するときは --legacy-ref=<A1前のcommit/tag> を必ず指定する。
// --inspect は比較元の確認だけを行い、ブラウザや上流APIを起動しない。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,existsSync,writeFileSync} from 'node:fs';
import {resolve,extname,sep} from 'node:path';
import {spawnSync} from 'node:child_process';
import {chromium} from 'playwright';
const root=resolve('.'),base=new URL(process.argv.find(a=>a.startsWith('--base='))?.slice(7)||'http://127.0.0.1:8793');
assert(['localhost','127.0.0.1'].includes(base.hostname));
const fixture=JSON.parse(readFileSync(resolve(root,'.github/scripts/fixtures/magi-dialogue-a1-final.json'),'utf8'));
assert(fixture.reviewed_by&&fixture.reviewed_at);
const legacyWorker=process.argv.includes('--legacy-worker');
const input=fixture.cases.find(c=>c.id===(legacyWorker?'final-benign-01':'final-identity-02')).text;
const legacyRef=process.argv.find(a=>a.startsWith('--legacy-ref='))?.slice(13);
assert(legacyWorker || legacyRef,'旧画面との比較には --legacy-ref=<A1前のcommit/tag> が必要');
let legacyCommit=null,oldHome=null,oldApp=null;
if(!legacyWorker) {
  const revision=spawnSync('git',['rev-parse','--verify','--end-of-options',legacyRef+'^{commit}'],{encoding:'utf8'});
  assert.equal(revision.status,0,'legacy-refがcommitを指していない');legacyCommit=revision.stdout.trim();
  const oldFile=p=>{const r=spawnSync('git',['show',legacyCommit+':'+p],{encoding:'utf8',maxBuffer:20*1024*1024});assert.equal(r.status,0);return r.stdout;};
  oldHome=oldFile('index.html');oldApp=oldFile('magi-app/www/app.js');
  assert(!oldHome.includes('close_on_malice: true')&&!oldApp.includes('close_on_malice: true'),'legacy-refにはA1前の画面を指定する');
}
if(process.argv.includes('--inspect')) {
  console.log(JSON.stringify({base:base.href,legacy_worker:legacyWorker,legacy_ref:legacyRef??null,legacy_commit:legacyCommit,
    old_home_loaded:oldHome!==null,old_app_loaded:oldApp!==null}));process.exit(0);
}
const server=createServer((req,res)=>{
  let path=new URL(req.url,'http://localhost').pathname;
  if(path.endsWith('/'))path+='index.html';
  const file=resolve(root,'.'+path);
  if(!file.startsWith(root+sep)||!existsSync(file)){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.json':'application/json'})[extname(file)]||'application/octet-stream'});
  res.end(readFileSync(file));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin='http://localhost:'+server.address().port;
const browser=await chromium.launch({headless:true});
const rows=[],output=resolve(root,'workers/.wrangler/magi2-dialogue-a1/browser-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json');
const save=()=>writeFileSync(output,JSON.stringify({date:new Date().toISOString(),base:base.href,legacy_ref:legacyRef??null,legacy_commit:legacyCommit,complete:false,results:rows},null,2));
try{
  const surfaces=[['home-light','/',1280,false],['home-dark','/',1280,false],['app','/magi-app/www/',390,false],['dj','/dj/request/',390,false],['old-home','/',1280,true],['old-app','/magi-app/www/',390,true]];
  for(const [name,path,width,old] of (legacyWorker?surfaces.slice(0,4):surfaces)){
    const page=await browser.newPage({viewport:{width,height:900},serviceWorkers:'block'}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    let captured,doneResolve,responseTimer;const received=new Promise(r=>{doneResolve=r;});
    await page.addInitScript(()=>localStorage.setItem('st-analytics','off'));
    await page.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      if(url.pathname==='/magi2/chat'||url.pathname==='/magi2/models'){
        const started=performance.now();
        const response=await fetch(new URL(url.pathname,base),{method:request.method(),signal:AbortSignal.timeout(290000),
          headers:{Origin:'http://localhost:8000','Content-Type':'application/json'},...(request.postData()?{body:request.postData()}:{} )});
        const body=await response.text();
        await route.fulfill({status:response.status,contentType:response.headers.get('Content-Type')||'application/json',headers:{'Access-Control-Allow-Origin':origin},body});
        if(url.pathname==='/magi2/chat'){
          const events=[...body.matchAll(/^event: (.+)\r?\ndata: (.+)$/gm)].map(m=>({event:m[1],data:JSON.parse(m[2])}));
          captured={name,old,legacy_worker:legacyWorker,request:JSON.parse(request.postData()),status:response.status,elapsed_ms:Math.round(performance.now()-started),events};doneResolve();
        }return;
      }
      const event={open:true,code:'ABC123',title:'ローカル確認',genres:[]};
      if(url.pathname==='/dj/api/req/event'){await route.fulfill({json:event});return;}
      if(url.pathname==='/dj/api/req/board'){await route.fulfill({json:{event,played:[],waiting:[]}});return;}
      if(old&&name==='old-home'&&url.origin===origin&&url.pathname==='/'){await route.fulfill({contentType:'text/html',body:oldHome});return;}
      if(old&&name==='old-app'&&url.pathname==='/magi-app/www/app.js'){await route.fulfill({contentType:'application/javascript',body:oldApp});return;}
      if(url.origin!==origin){await route.fulfill({status:200,body:''});return;}
      await route.continue();
    });
    try{
      await page.clock.install({time:new Date('2026-10-13T00:00:00Z')});await page.clock.pauseAt(new Date('2026-10-13T00:10:00Z'));
      await page.goto(origin+path,{waitUntil:'domcontentloaded'});
      if(name==='home-dark')await page.locator('[data-act="settings"]').click();
      if(name==='dj')await page.locator('[data-tab="consult"]').click();
      await page.clock.runFor(5000);
      const inputSelector=name==='dj'?'#chatInput':'#agent-input',send=name==='dj'?'#chatSend':'#agent-send';
      await page.locator(inputSelector).fill(input);await page.locator(send).click();
      await Promise.race([received,new Promise((_resolve,reject)=>{responseTimer=setTimeout(()=>reject(new Error('actual_response_timeout')),290000);})]);clearTimeout(responseTimer);
      assert.equal(captured.status,200);assert.equal(captured.events.at(-1)?.event,'done');assert.equal(captured.events.some(e=>e.event==='closed'),!legacyWorker);
      await page.clock.runFor(30000);
      const expected=captured.events.filter(e=>e.event==='integrated').map(e=>e.data.delta||'').join('');assert.ok(expected);
      const body=page.locator(name==='dj'?'.ab':'.agent-reply-body').last();assert.equal(await body.textContent(),expected);
      const shouldClose=!legacyWorker&&!old&&name!=='dj';
      assert.equal(await page.locator(inputSelector).isDisabled(),shouldClose);
      assert.equal(await page.locator('.agent-closed').count(),shouldClose?1:0);
      const saved=await page.evaluate(dj=>localStorage.getItem(dj?'tkdj.consults':'magi_current_history'),name==='dj');
      const stored=JSON.parse(saved);
      const savedReply=name==='dj'?stored?.[0]?.turns?.at(-1)?.reply:stored?.filter(m=>m.role==='assistant').at(-1)?.content;
      assert.equal(savedReply,expected,'復元した保存データの最新回答が一致する');
      if(shouldClose){await page.reload({waitUntil:'domcontentloaded'});assert.equal(await page.locator(inputSelector).isDisabled(),true);await page.locator('.agent-closed button').click();assert.equal(await page.locator(inputSelector).isDisabled(),false);}
      assert.equal(errors.length,0,errors.join('\n'));rows.push({...captured,complete:true});save();console.log(name+': 実Worker・回答・保存・互換 OK');
    }catch(error){rows.push({...captured,name,complete:false,error:error.message,errors});save();throw error;}
    finally{clearTimeout(responseTimer);await page.close();}
  }
  writeFileSync(output,JSON.stringify({date:new Date().toISOString(),base:base.href,legacy_ref:legacyRef??null,legacy_commit:legacyCommit,complete:true,results:rows},null,2));console.log(JSON.stringify({complete:true,count:rows.length,output}));
}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
