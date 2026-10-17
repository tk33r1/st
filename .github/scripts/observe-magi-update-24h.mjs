// 別IDの計測用アプリだけに接続。時計・更新確認日時を書き換えず、実時間で1日1回の照会を確認する。
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const dir=new URL('../../workers/.wrangler/magi2-update-observation-20261017/',import.meta.url);
if(existsSync(new URL('latest.json',dir))){const previous=JSON.parse(readFileSync(new URL('latest.json',dir)));if(previous.complete_24h&&previous.qa_application_removed){console.log(JSON.stringify(previous));process.exit(0);}}
const adb=process.argv.find(a=>a.startsWith('--adb='))?.slice(6)||join(process.env.LOCALAPPDATA,'Android/Sdk/platform-tools/adb.exe');
const devices=execFileSync(adb,['devices'],{encoding:'utf8'}).split('\n').map(l=>l.match(/^(\S+)\s+device\s*$/)?.[1]).filter(Boolean);
if(devices.length!==1){console.log(JSON.stringify({status:'needs_device',connected:devices.length}));process.exit(0);}
const device=devices[0],run=(...a)=>execFileSync(adb,['-s',device,...a],{encoding:'utf8'});
const build=JSON.parse(readFileSync(new URL('build-plan.json',dir)));
assert.equal(build.application_id,'st.tk.magi.qa24');
assert.equal(build.activity,'st.tk.magi.MainActivity');
run('shell','am','start','-n',build.application_id+'/'+build.activity);
const pid=run('shell','pidof',build.application_id).trim();assert.match(pid,/^\d+$/);
const port=run('forward','tcp:0','localabstract:webview_devtools_remote_'+pid).trim();assert.match(port,/^\d+$/);
let socket;
try{
 const pages=await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
 const page=pages.find(p=>/^https?:\/\/localhost\//.test(p.url));assert(page?.webSocketDebuggerUrl,'計測用WebViewだけに接続');
 socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
 const result=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('QA WebView inspection timed out')),15000);
  socket.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.id===1){clearTimeout(timer);m.error?reject(new Error('CDP error')):resolve(m.result);}});
  socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{awaitPromise:true,returnByValue:true,expression:`(async()=>{
   for(let i=0;i<50&&(typeof checkAppUpdate!=='function'||!localStorage.getItem('magi_qa_update_log'));i++)await new Promise(r=>setTimeout(r,100));
   for(let i=0;i<60&&JSON.parse(localStorage.getItem('magi_qa_update_log')).requests.some(r=>r.status===null);i++)await new Promise(r=>setTimeout(r,100));
   const before=JSON.parse(localStorage.getItem('magi_qa_update_log'));
   await checkAppUpdate();const middle=JSON.parse(localStorage.getItem('magi_qa_update_log'));await checkAppUpdate();
   let blocked=false;try{await fetch('https://workers.tk.st/magi2/chat',{method:'POST',body:'{}'})}catch(e){blocked=e.message==='QA observation blocks paid sends'}
   return {native:window.Capacitor.isNativePlatform(),now:Date.now(),checked:Number(localStorage.getItem('magi_update_checked')),before,middle,after:JSON.parse(localStorage.getItem('magi_qa_update_log')),paid_post_blocked:blocked};
  })()`}}));
 });
 assert(!result.exceptionDetails);const data=result.result.value;
 assert(data.native&&data.paid_post_blocked);assert.equal(data.after.app_js_sha256,build.app_js_sha256);
 assert(data.after.requests.length>=1&&data.after.requests[0].status===200,'初回の公開Release照会が成功すること');
 assert(data.middle.requests.length-data.before.requests.length>=0&&data.middle.requests.length-data.before.requests.length<=1,'期限到達時は1回だけ照会');
 assert.equal(data.middle.requests.length,data.after.requests.length,'直後の2回目は照会しない');
 for(let i=1;i<data.after.requests.length;i++)assert(data.after.requests[i].at-data.after.requests[i-1].at>=86400000-100,'24時間未満に再照会していない');
 assert(Math.abs(data.now-Date.now())<120000,'端末とPCの実時計を確認');
 const baseline=new URL('baseline.json',dir);
 if(!existsSync(baseline)){assert.equal(data.after.requests.length,1);writeFileSync(baseline,JSON.stringify({host_started_at:new Date().toISOString(),first_request_at:data.after.requests[0].at,due_at:new Date(data.after.requests[0].at+86400000).toISOString(),app_js_sha256:build.app_js_sha256},null,2)+'\n',{flag:'wx'});}
 const start=JSON.parse(readFileSync(baseline)),last=data.after.requests.at(-1);
 const complete=Date.now()-start.first_request_at>=86400000&&data.now-start.first_request_at>=86400000&&data.after.requests.length>=2&&last.status===200;
 const report={at:new Date().toISOString(),native_qa_only:true,same_formal_app_js:true,paid_post_blocked:true,immediate_repeat_suppressed:true,
  complete_24h:complete,due_at:start.due_at,observed_requests:data.after.requests,checked:data.checked};
 if(complete){const removed=run('uninstall','st.tk.magi.qa24');assert(removed.includes('Success'));report.qa_application_removed=true;}
 mkdirSync(new URL('samples/',dir),{recursive:true});writeFileSync(new URL('samples/'+Date.now()+'.json',dir),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 writeFileSync(new URL('latest.json',dir),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report));
}finally{socket?.close();run('forward','--remove','tcp:'+port);run('shell','am','start','-n','st.tk.magi/.MainActivity');}
