// B4のウィジェットの入口（チャット・カメラ・アルバム・音声入力・通知からの会話）と設定を、実画面と模擬ネイティブで確認する。実AI・録音なし。
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {nativeFilesystemFixture} from './magi-native-filesystem-fixture.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),out=root+'workers/.wrangler/magi-b4-20261021/';mkdirSync(out,{recursive:true});
const fs=nativeFilesystemFixture(),calls=[],errors=[],runs=new Map();let launch=null,listenerGate=Promise.resolve();
const browser=await chromium.launch({headless:true}),context=await browser.newContext({serviceWorkers:'block',viewport:{width:390,height:844}});
const event=(name,data)=>'event: '+name+'\ndata: '+JSON.stringify(data)+'\n\n';
const answer=event('classification',{version:1,intent:'consult',mode:'consult',fresh:'no',votable:'no',site_pages:'no',magi_candidate:false,reply_language:{version:1,code:'en',source:'ui'}})
 +event('title',{text:'New widget conversation'})+event('integrated',{delta:'New answer for the home widget.'})+event('done',{});
const methods={
 'widget:information':async()=>({canPin:true}),
 'widget:pin':async args=>{calls.push(['pin',args]);return{requested:true}},
 'conversation:information':async()=>({test:false}), 'conversation:checkPermissions':async()=>({display:'denied'}),
 'conversation:begin':async value=>{calls.push(['begin']);runs.set(value.id,{...value,status:'complete',data:answer,startedAt:Date.now()});},
 'conversation:read':async({id,offset})=>{const run=runs.get(id),bytes=Buffer.from(run.data).subarray(offset);return{status:run.status,base64:bytes.toString('base64'),offset:offset+bytes.length,length:Buffer.byteLength(run.data)};},
 'conversation:pending':async()=>({runs:[...runs.values()].map(({data,body,...r})=>r)}),
 'conversation:acknowledge':async({id})=>{runs.delete(id)},'conversation:cancel':async()=>{},'conversation:openNotificationSettings':async()=>{},
 'launch':async()=>({url:launch}),'listen':async()=>{await listenerGate},
};
await context.exposeBinding('bridge',async(_,method,args)=>{try{return{value:method.startsWith('fs:')?await fs.fs[method.slice(3)](args):await methods[method](args)}}catch(e){return{error:{message:e.message,code:e.code}}}});
await context.addInitScript(()=>{
 const call=async(method,args)=>{const r=await bridge(method,args);if(r.error)throw Object.assign(Error(r.error.message),r.error);return r.value};
 const plugin=(prefix,methods)=>Object.fromEntries(methods.map(name=>[name,args=>call(prefix+':'+name,args)]));
 window.voiceEvents={};window.voiceStarts=0;
 window.Capacitor={isNativePlatform:()=>true,getPlatform:()=>'android',Plugins:{
  Filesystem:plugin('fs',['stat','readFile','writeFile','rename','deleteFile','readdir','rmdir','getUri']),
  MagiWidget:plugin('widget',['information','pin']),
  MagiConversation:plugin('conversation',['information','checkPermissions','begin','read','pending','cancel','acknowledge','openNotificationSettings']),
  App:{addListener:async(_,fn)=>{window.widgetLink=fn},getLaunchUrl:()=>call('launch')},
  SpeechRecognition:{available:async()=>({available:true}),checkPermissions:async()=>({speechRecognition:'granted'}),
   getSupportedLanguages:async()=>({languages:['en-US']}),start:async options=>{window.voiceStarts++;window.voiceId=options.sessionId},stop:async()=>{},
   addListener:async(name,fn)=>{window.voiceEvents[name]=event=>fn({sessionId:window.voiceId,...event});await call('listen')}}
 }};
 if(!localStorage.getItem('widget-seeded')){
  const votes=Object.fromEntries(['MELCHIOR-1','BALTHASAR-2','CASPER-3'].map(name=>[name,{state:'voted',vote:'approve',round:2}]));
  localStorage.setItem('magi_saved_sessions',JSON.stringify([{id:'old',timestamp:1,title:'Existing title',history:[{role:'user',content:'A question'},{role:'assistant',content:'Existing answer. '.repeat(20),mode:'magi',magi:{motion:'Read a book?',result:'approve',tally:{approve:3,reject:0,none:0},rounds:2,reason_missing:false,votes}}]}]));
  localStorage.setItem('widget-seeded','1');
 }
});
let jsPosts=0;
await context.route('**/*',route=>{const url=new URL(route.request().url());
 if(url.pathname==='/magi2/chat'){jsPosts++;return route.abort()}
 if(url.pathname==='/magi2/models')return route.fulfill({json:{}});
 if(url.pathname.endsWith('/releases/latest'))return route.fulfill({json:{tag_name:'v5.6'}});
 if(url.origin==='https://tk.st'&&url.pathname.startsWith('/magi-app/www/')){const file=url.pathname.slice('/magi-app/www/'.length)||'index.html';if(!/^(?:[a-z0-9.-]+|vendor\/Readability\.js)$/.test(file))return route.abort();return route.fulfill({body:readFileSync(root+'magi-app/www/'+file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html':'application/json'})}
 return route.abort();
});
async function page(){const p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto('https://tk.st/magi-app/www/');await p.waitForFunction(()=>nativeWidget&&!historyLoading&&window.widgetLink);return p}
const results=[];
try{
 let p=await page();
 await p.evaluate(()=>showNativeSettings());assert.equal(await p.locator('#widget-masked').count(),0);await p.locator('#widget-pin').waitFor();
 await p.locator('#widget-pin').click();await p.waitForFunction(()=>true);assert.deepEqual(calls.filter(x=>x[0]==='pin'),[['pin',undefined]]);results.push('settings only request pinning without widget contents');
 await p.evaluate(()=>closeAgentPanels());
 await p.evaluate(()=>widgetLink({url:'magi://open?id=old'}));await p.waitForFunction(()=>currentSessionId==='old');
 for(const url of ['magi://camera','magi://album']){await p.evaluate(u=>widgetLink({url:u}),url);assert.equal(await p.evaluate(()=>currentSessionId),'old');assert.equal(await p.evaluate(()=>agentHistory.length),2);}
 results.push('camera and album leave the current chat to the native picker');
 await p.evaluate(()=>widgetLink({url:'magi://new'}));assert.equal(await p.evaluate(()=>agentHistory.length),0);assert.equal(calls.filter(x=>x[0]==='begin').length,0);
 await p.evaluate(()=>widgetLink({url:'magi://voice'}));await p.waitForFunction(()=>voiceStarts===1);
 await p.evaluate(()=>voiceEvents.partialResults({matches:['Confirmed voice'],final:true}));assert.equal(await p.locator('#agent-input').inputValue(),'Confirmed voice');assert.equal(calls.filter(x=>x[0]==='begin').length,0);
 await p.evaluate(()=>showNativeSettings());await p.evaluate(()=>widgetLink({url:'magi://open?id=old'}));await p.waitForFunction(()=>currentSessionId==='old');assert.equal(await p.locator('.agent-panel').count(),0);
 await p.evaluate(()=>widgetLink({url:'magi://open?id=old&send=true'}));assert.equal(await p.evaluate(()=>agentHistory.length),0);results.push('chat voice and existing links never send');
 await p.locator('#agent-input').fill('Synthetic B4 question');await p.locator('#agent-send').click();await p.waitForFunction(()=>!agentBusy&&agentHistory.length===2);
 assert.equal(calls.filter(x=>x[0]==='begin').length,1);assert.equal(calls.filter(x=>x[0]==='pin').length,1);results.push('completed answer does not update the widget');
 await p.close();launch='magi://voice';let ready;listenerGate=new Promise(r=>{ready=r});p=await page();assert.equal(await p.evaluate(()=>voiceStarts),0);ready();await p.waitForFunction(()=>voiceStarts===1);
 assert.equal(calls.filter(x=>x[0]==='begin').length,1);results.push('cold voice link waits for input initialization');
 await p.evaluate(()=>nativeInput.stopVoice());assert.equal(jsPosts,0);assert.deepEqual(errors,[]);
 writeFileSync(out+'browser-widget.json',JSON.stringify({passed:results.length,results,errors,jsPosts,nativeMockCalls:calls.filter(x=>x[0]==='begin').length},null,2)+'\n');console.log(JSON.stringify({passed:results.length,errors,jsPosts}));
}finally{await context.close();await browser.close()}
