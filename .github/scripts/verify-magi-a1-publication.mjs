// A1公開後の少数確認。固定の本番URLと承認済み合成入力を使い、本文はGit管理外だけに保存する。
// DJ受付はブラウザ内だけの合成イベント。実際のイベントや曲の受付は変更しない。
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {chromium} from 'playwright';
const workerOnly=process.argv.includes('--worker-only');
const out=resolve('workers/.wrangler/magi2-dialogue-a1/production-a1-'+(workerOnly?'worker':'pages')+'.json');
const fixture=JSON.parse(readFileSync('.github/scripts/fixtures/magi-dialogue-a1-final.json','utf8'));
const approved=fixture.cases.find(c=>c.id==='final-identity-02').text;
const old=workerOnly?spawnSync('git',['show','v4.6:magi-app/www/app.js'],{encoding:'utf8',maxBuffer:20*1024*1024}):null;
if(workerOnly)assert.equal(old.status,0,'旧4.6互換確認にはv4.6タグが必要');
const report={started:new Date().toISOString(),pass:false,cases:[],limitations:'Chromium。実SSEを受信後まとめて画面へ渡す。旧APKのWebコードを使う互換確認で、Android実機の代わりではない。DJ受付はブラウザ内だけの合成イベント。'};
const browser=await chromium.launch({headless:true});
try {
  for(const name of (workerOnly?['old-app']:['home-light','home-dark','app','dj'])) {
    const legacy=name==='old-app',dj=name==='dj',path=dj?'/dj/request/':name.includes('app')?'/magi-app/www/':'/';
    const ctx=await browser.newContext({viewport:{width:name.startsWith('home')?1280:390,height:900},colorScheme:name==='app'?'dark':'light',serviceWorkers:'block'});
    const page=await ctx.newPage(),errors=[];let captured;page.on('pageerror',e=>errors.push(e.message));
    await ctx.addInitScript(()=>localStorage.setItem('st-analytics','off'));
    await ctx.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.origin==='https://workers.tk.st'&&url.pathname==='/magi2/chat') {
        const request=route.request().postDataJSON();
        const response=await fetch(url,{method:'POST',headers:{Origin:'https://tk.st','Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(300000)});
        const body=await response.text();captured={request,body,status:response.status,requestId:response.headers.get('X-Request-Id')};
        return route.fulfill({status:response.status,contentType:'text/event-stream',headers:{'Access-Control-Allow-Origin':'https://tk.st'},body});
      }
      if(legacy&&url.pathname==='/magi-app/www/app.js')return route.fulfill({contentType:'application/javascript',body:old.stdout});
      if(dj&&['/dj/api/req/event','/dj/api/req/board'].includes(url.pathname)) {
        const event={open:true,code:'ABC123',title:'公開確認用の合成イベント',genres:[]};
        return route.fulfill({json:url.pathname.endsWith('/event')?event:{event,played:[],waiting:[]}});
      }
      if(url.pathname==='/search/api/click')return route.abort();
      if(url.origin==='https://tk.st'&&!url.pathname.startsWith('/cdn-cgi/'))return route.continue();
      if(url.origin==='https://workers.tk.st'&&url.pathname.startsWith('/magi2/'))return route.continue();
      return route.abort();
    });
    try {
      await page.goto('https://tk.st'+path,{waitUntil:'domcontentloaded'});
      if(name==='home-dark')await page.locator('[data-act="settings"]').click();
      if(dj)await page.locator('[data-tab="consult"]').click();
      if(!legacy&&!dj)await page.waitForFunction(()=>document.body.innerText.includes('ver 4.8'));
      const input=dj?'#chatInput':'#agent-input',send=dj?'#chatSend':'#agent-send';
      const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/magi2/chat',{timeout:300000});
      await page.locator(input).fill(legacy?'短い休憩に散歩を取り入れたい。続けるコツを教えて。':approved);
      await page.locator(send).click();const res=await response;assert.equal(res.status(),200);
      const text=captured.body,events=[...text.matchAll(/^event: (.+)\r?\ndata: (.+)$/gm)].map(m=>({event:m[1],data:JSON.parse(m[2])}));
      assert.equal(events.at(-1)?.event,'done');assert.ok(!events.some(e=>e.event==='error'));
      const request=captured.request;
      if(!legacy) {
        const names=events.map(e=>e.event);
        assert.deepEqual(names.filter((name,i)=>i===0||name!==names[i-1]),['classification','integrated','closed','done']);
        assert.equal(events.find(e=>e.event==='closed').data.reason,'malice');assert.equal(request.theme,name==='home-light'?'light':'dark');
        if(!dj)assert.equal(request.close_on_malice,true);
      } else {
        assert.ok(!request.close_on_malice);assert.ok(!events.some(e=>e.event==='closed'));
        const privacy=await page.evaluate(async()=>{
          const data=await loadAgentModels();const list=document.createElement('ul');document.body.appendChild(list);renderAgentPrivacy(list,'en',data);
          return {features:AGENT_PRIVACY_FEATURES,text:list.textContent,newRows:data.privacy.en.filter(r=>r.requires?.includes('close_on_malice')).map(r=>r.text)};
        });
        assert.ok(!privacy.features.includes('close_on_malice'));assert.ok(privacy.newRows.length);for(const row of privacy.newRows)assert.ok(!privacy.text.includes(row));
      }
      const expected=events.filter(e=>e.event==='integrated').map(e=>e.data.delta||'').join('');assert.ok(expected.trim());
      if(!legacy){assert.doesNotMatch(expected,/僕|ぜ/);}
      await page.waitForFunction(({dj,text})=>{
        const nodes=document.querySelectorAll(dj?'.ab':'.agent-reply-body');return nodes[nodes.length-1]?.textContent===text;
      },{dj,text:expected},{timeout:60000});
      assert.equal(await page.locator(input).isDisabled(),!legacy&&!dj);
      const stored=await page.evaluate(dj=>localStorage.getItem(dj?'tkdj.consults':'magi_current_history'),dj);
      const contains=value=>value===expected||value&&typeof value==='object'&&Object.values(value).some(contains);assert.ok(contains(JSON.parse(stored)));
      if(!legacy&&!dj){await page.reload({waitUntil:'domcontentloaded'});assert.equal(await page.locator(input).isDisabled(),true);await page.locator('.agent-closed button').click();assert.equal(await page.locator(input).isDisabled(),false);}
      assert.deepEqual(errors,[]);report.cases.push({name,pass:true,requestId:captured.requestId,request,events,closed:!legacy&&!dj,privacyCompatible:legacy,djSyntheticReception:dj});console.log(name+': 本番A1・表示・保存・互換 OK');
    } catch(error) {
      // assertのactual・pageerrorは本番の返答の本文を含みうる。成果物とActionsのログには画面・種類・行だけを残す
      const line=(error.stack||'').match(/verify-magi-a1-publication\.mjs:(\d+)/)?.[1];
      throw new Error(name+': '+(error.code==='ERR_ASSERTION'?'assert.'+error.operator:error.name)+(line?' (line '+line+')':''));
    } finally {await ctx.close();}
  }
  report.pass=true;
} catch(error){report.error=error.message;throw error;}
finally{mkdirSync(dirname(out),{recursive:true});writeFileSync(out,JSON.stringify(report,null,2)+'\n');await browser.close();}
