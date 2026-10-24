// Web/PWAの管理機能。会話は固定SSE、通知はOSへ送らない模擬APIを使う。
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,extname,sep} from 'node:path';
import {chromium} from 'playwright';
const root=process.cwd(),out=resolve(root,'workers/.wrangler/magi-web-management-browser');mkdirSync(out,{recursive:true});
const ev=(name,data)=>`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const browser=await chromium.launch({headless:true});
try{
 for(const mobile of [true,false]){
  const context=await browser.newContext({viewport:{width:mobile?390:1600,height:900},acceptDownloads:true,serviceWorkers:'block'});
  await context.addInitScript(()=>{
   sessionStorage.setItem('magi_transport','sse');localStorage.setItem('lang','ja');localStorage.setItem('magi_lang','ja');
   if(!localStorage.getItem('web-management-seeded')){
    const history=[{role:'user',content:[{type:'text',text:'NORMAL-A'},{type:'image_url',image_url:{url:'data:image/png;base64,BASE64CANARY'},file:'image-ref'}]},{role:'assistant',content:'NORMAL-ANSWER',mode:'fact'}];
    localStorage.setItem('magi_saved_sessions',JSON.stringify([{id:'session_A',title:'NORMAL-TITLE',timestamp:1,history}]));
    localStorage.setItem('magi_current_history',JSON.stringify(history));localStorage.setItem('magi_current_session_id','session_A');localStorage.setItem('magi_current_title','NORMAL-TITLE');
    localStorage.setItem('magi_personalization_v1',JSON.stringify({version:1,enabled:false,preferred_name:'KEEP-NAME',custom_instructions:'KEEP-CUSTOM'}));localStorage.setItem('magi_location_enabled','1');localStorage.setItem('unrelated-setting','KEEP');localStorage.setItem('web-management-seeded','1');
   }
   window.fakeFocused=true;window.fakeHidden=false;window.noticeCalls=[];window.swNotices=[];window.closedNotices=0;window.permissionRequests=0;window.useSw=false;window.managementWrites=[];
   Object.defineProperty(document,'hidden',{get:()=>window.fakeHidden});document.hasFocus=()=>window.fakeFocused;
   class Notice{static permission='default';static async requestPermission(){permissionRequests++;return this.permission='granted';}constructor(title,options){noticeCalls.push({title,options});}close(){closedNotices++;}}
   window.Notification=Notice;window.MockNotice=Notice;
   const registration={active:true,showNotification:async(title,options)=>{swNotices.push({title,options});},getNotifications:async()=>[{close(){closedNotices++;}}]};
   Object.defineProperty(navigator,'serviceWorker',{value:{getRegistration:async()=>useSw?registration:undefined,register:async()=>registration,getRegistrations:async()=>[]}});
   const set=Storage.prototype.setItem,remove=Storage.prototype.removeItem,get=Storage.prototype.getItem;
   Storage.prototype.setItem=function(key,value){managementWrites.push(key);if(window.failPreference&&key==='magi_location_enabled')throw new Error('synthetic_write');return set.call(this,key,value);};
   Storage.prototype.removeItem=function(key){if(window.failClear&&key==='magi_current_title'){window.failClear=false;throw new Error('synthetic_delete');}return remove.call(this,key);};
   Storage.prototype.getItem=function(key){if(window.failHistoryRead&&key==='magi_saved_sessions')throw new Error('synthetic_read');return get.call(this,key);};
  });
  const requests=[],errors=[];
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.protocol==='blob:')return route.continue();
   if(url.pathname==='/magi2/models')return route.fulfill({json:{features:{privacy_contract:1,temporary_chat:true,personalization:true,temporary_personalization:true,speech:false}}});
   if(url.pathname==='/magi2/usage')return route.fulfill({json:{used:0,limit:60}});
   if(url.pathname==='/magi2/chat'){
    const body=JSON.parse(route.request().postData());requests.push(body);
    const stream=(body.privacy_contract?ev('session',{conversation_mode:body.conversation_mode,personalization_applied:!!body.personalization}):'')+ev('classification',{version:1,intent:'research',mode:'fact',fresh:'no',votable:'no',site_pages:'no',magi_candidate:false,reply_language:{version:1,code:'ja',source:'ui'}})+ev('integrated',{delta:'SYNTHETIC-ANSWER'})+ev('done',{});
    return route.fulfill({contentType:'text/event-stream',body:stream});
   }
   if(url.hostname==='tk.st'){
    const file=resolve(root,'.'+(url.pathname.endsWith('/')?url.pathname+'index.html':url.pathname));
    if(file.startsWith(root+sep)&&existsSync(file))return route.fulfill({body:readFileSync(file),contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png'})[extname(file)]||'application/octet-stream'});
   }
   return route.abort();
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  const url='https://tk.st/'+(mobile?'magi-app/www/':'');await page.goto(url);
  async function openSettings(){await page.locator('#btn-more-agent').click();await page.locator('#btn-settings-agent').click();await page.locator('#history-export').waitFor();}
  async function closeSettings(){await page.locator('#agent-settings-panel .agent-page-back').click();}
  async function send(text){const count=requests.length;await page.locator('#agent-input').fill(text);await page.locator('#agent-send').click();await page.waitForFunction(()=>document.querySelector('#agent-log').textContent.includes('SYNTHETIC-ANSWER')&&!document.querySelector('#btn-temporary-agent').disabled);assert.equal(requests.length,count+1);}
  await page.locator('#btn-more-agent').click();
  const order=await page.locator('#agent-more-dropdown').evaluate(el=>[...el.querySelectorAll('button')].map(b=>b.id).filter(id=>['btn-share-agent','btn-export-agent','btn-settings-agent','btn-bug-report-agent','btn-about-agent'].includes(id)));
  assert.deepEqual(order,['btn-share-agent','btn-export-agent','btn-settings-agent','btn-bug-report-agent','btn-about-agent']);
  await page.locator('#btn-settings-agent').click();
  const location=page.locator('#native-location-toggle'),notification=page.locator('#native-notification-toggle');await page.waitForFunction(()=>!document.querySelector('#native-notification-toggle').disabled);
  assert.equal(await page.evaluate(()=>permissionRequests),0);
  await location.click();assert.equal(await location.getAttribute('aria-checked'),'false');
  await notification.click();assert.equal(await page.evaluate(()=>permissionRequests),1);assert.equal(await notification.getAttribute('aria-checked'),'true');
  await page.screenshot({path:resolve(out,(mobile?'app':'home')+'-settings.png'),animations:'disabled'});await closeSettings();
  await page.evaluate(()=>{fakeFocused=false;fakeHidden=true;});await send('PRIVATE-NOTIFICATION-CANARY');await page.waitForFunction(()=>noticeCalls.length===1);
  assert.equal(requests.at(-1).location_enabled,false);assert.equal(JSON.stringify(await page.evaluate(()=>noticeCalls)).includes('PRIVATE'),false);
  await page.evaluate(()=>{fakeFocused=true;fakeHidden=false;});await send('VISIBLE-NO-NOTICE');assert.equal(await page.evaluate(()=>noticeCalls.length),1);
  await page.evaluate(()=>{useSw=true;fakeFocused=false;fakeHidden=true;});await send('PWA-NOTICE');await page.waitForFunction(()=>swNotices.length===1);
  await page.evaluate(()=>{fakeFocused=true;fakeHidden=false;});await openSettings();await notification.click();assert.equal(await notification.getAttribute('aria-checked'),'false');assert.ok(await page.evaluate(()=>closedNotices)>0);
  await closeSettings();await page.evaluate(()=>{fakeFocused=false;fakeHidden=true;});await send('DISABLED-NO-NOTICE');assert.equal(await page.evaluate(()=>swNotices.length),1);
  await page.evaluate(()=>{fakeFocused=true;fakeHidden=false;Notification.permission='denied';});await openSettings();assert.match(await page.locator('#native-notification-status').innerText(),/blocked|ブロック/);await notification.click();assert.equal(await page.evaluate(()=>permissionRequests),1);assert.equal(await notification.getAttribute('aria-checked'),'false');
  await page.evaluate(()=>{Notification.permission='granted';failPreference=true;});await location.click();assert.equal(await location.getAttribute('aria-checked'),'false');assert.match(await page.locator('#native-location-status').innerText(),/Could not save|保存できません/);await page.evaluate(()=>{failPreference=false;});await notification.click();assert.equal(await notification.getAttribute('aria-checked'),'true');await closeSettings();
  await page.locator('#btn-temporary-agent').click();await page.evaluate(()=>{fakeFocused=false;fakeHidden=true;});await send('TEMP-PRIVATE-NOT-EXPORTED');assert.equal(await page.evaluate(()=>swNotices.length),1);await page.evaluate(()=>{fakeFocused=true;fakeHidden=false;});
  await openSettings();const savedSettings=await page.evaluate(()=>localStorage.getItem('magi_personalization_v1'));
  const beforeExport=await page.evaluate(()=>JSON.stringify(Object.fromEntries(Object.keys(localStorage).map(k=>[k,localStorage.getItem(k)]))));
  const downloadPromise=page.waitForEvent('download');await page.locator('#history-export').click();const download=await downloadPromise;const exported=JSON.parse(readFileSync(await download.path(),'utf8'));
  assert.ok(exported.sessions.length>=1);assert.equal(JSON.stringify(exported).includes('BASE64CANARY'),false);assert.equal(JSON.stringify(exported).includes('"file"'),false);assert.equal(JSON.stringify(exported).includes('TEMP-PRIVATE-NOT-EXPORTED'),false);
  assert.equal(await page.evaluate(()=>JSON.stringify(Object.fromEntries(Object.keys(localStorage).map(k=>[k,localStorage.getItem(k)])))),beforeExport);
  await page.evaluate(()=>{failHistoryRead=true;});await page.locator('#history-export').click();assert.match(await page.locator('#history-storage-status').innerText(),/Could not export|書き出せません/);await page.evaluate(()=>{failHistoryRead=false;});
  page.once('dialog',d=>d.dismiss());await page.locator('#history-clear').click();assert.notEqual(await page.evaluate(()=>localStorage.getItem('magi_saved_sessions')),null);
  const snapshot=await page.evaluate(()=>Object.fromEntries(['magi_saved_sessions','magi_current_history','magi_current_session_id','magi_current_title','magi_current_language','magi_current_shared'].map(k=>[k,localStorage.getItem(k)])));
  await page.evaluate(()=>{failClear=true;});page.once('dialog',d=>d.accept());await page.locator('#history-clear').click();assert.match(await page.locator('#history-storage-status').innerText(),/Could not delete|削除できません/);
  assert.deepEqual(await page.evaluate(()=>Object.fromEntries(['magi_saved_sessions','magi_current_history','magi_current_session_id','magi_current_title','magi_current_language','magi_current_shared'].map(k=>[k,localStorage.getItem(k)]))),snapshot);
  const other=await context.newPage();await other.goto(url);await other.locator('#btn-temporary-agent').waitFor();
  page.once('dialog',d=>d.accept());await page.locator('#history-clear').click();
  await other.waitForFunction(()=>!document.querySelector('#agent-log').textContent.includes('NORMAL-ANSWER'));
  assert.equal(await page.evaluate(()=>localStorage.getItem('magi_saved_sessions')),null);assert.equal(await page.evaluate(()=>localStorage.getItem('magi_personalization_v1')),savedSettings);assert.equal(await page.evaluate(()=>localStorage.getItem('unrelated-setting')),'KEEP');
  await closeSettings();assert.equal(await page.locator('#btn-temporary-agent').getAttribute('aria-pressed'),'true');await page.locator('#btn-temporary-agent').click();assert.equal((await page.locator('#agent-log').innerText()).includes('NORMAL-A'),false);
  await page.evaluate(()=>{window.Notification=undefined;});await openSettings();assert.equal(await notification.isDisabled(),true);assert.match(await page.locator('#native-notification-status').innerText(),/cannot show|使えません/);
  assert.deepEqual(errors,[]);await context.close();console.log((mobile?'PWA':'home')+': menu parity, location, notification permission/delivery, export privacy, deletion rollback, temp isolation and cross-tab clear PASS');
 }
}finally{await browser.close();}
