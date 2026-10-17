// 正式版と同じapp.jsを別IDのdebugアプリへ複製し、更新照会だけを実時間で計測する。
// 出荷物・正式アプリの保存領域・時計を変更しない。追加のAI送信は計測用fetchで拒否する。
import {cpSync,readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../../',import.meta.url));
const target=resolve(root,'workers/.wrangler/magi2-update-observation-20261017/android');
assert(!existsSync(target),'既存の計測用データは上書きしない');
mkdirSync(resolve(target,'..'),{recursive:true});
cpSync(resolve(root,'magi-app/android'),target,{recursive:true,filter:p=>!['build','.gradle','keystore.properties'].includes(basename(p))&&!/\.(jks|keystore)$/i.test(p)});
const edit=(p,fn)=>{const f=resolve(target,p);writeFileSync(f,fn(readFileSync(f,'utf8')));};
edit('app/build.gradle',s=>s.replace('applicationId "st.tk.magi"','applicationId "st.tk.magi.qa24"'));
edit('capacitor.settings.gradle',s=>s.replace('../node_modules',resolve(root,'magi-app/node_modules').replaceAll('\\','/')));
edit('app/src/main/res/values/strings.xml',s=>s.replaceAll('>MAGI<','>MAGI QA 24h<'));
const publicDir=resolve(target,'app/src/main/assets/public');
const app=readFileSync(resolve(publicDir,'app.js'));
assert(app.equals(readFileSync(resolve(root,'magi-app/www/app.js'))),'同梱app.jsと正式版が一致すること');
const appHash=createHash('sha256').update(app).digest('hex');
const instrument=`(function(){
 const key='magi_qa_update_log';const read=()=>{try{return JSON.parse(localStorage.getItem(key))||{first_started:Date.now(),app_js_sha256:${JSON.stringify(appHash)},requests:[]}}catch{return {first_started:Date.now(),requests:[]}}};
 const write=v=>localStorage.setItem(key,JSON.stringify(v));write(read());const original=window.fetch.bind(window);
 window.fetch=function(input,options){const method=String(options&&options.method||input&&input.method||'GET').toUpperCase();
  if(!['GET','HEAD'].includes(method))return Promise.reject(new Error('QA observation blocks paid sends'));
  const url=String(input&&input.url||input);if(url!=='https://api.github.com/repos/tk33r1/st/releases/latest')return original(input,options);
  const at=Date.now(),v=read();v.requests.push({at,status:null});v.requests=v.requests.slice(-20);write(v);
  return original(input,options).then(response=>{const done=read(),r=done.requests.find(r=>r.at===at);if(r)r.status=response.status;write(done);return response;});
 };
})();\n`;
writeFileSync(resolve(publicDir,'qa-observe.js'),instrument);
edit('app/src/main/assets/public/index.html',s=>{const tag=/<script\b[^>]*src="app\.js[^\"]*"[^>]*><\/script>/g;assert.equal([...s.matchAll(tag)].length,1);return s.replace(tag,m=>'<script src="qa-observe.js"></script>\n'+m);});
writeFileSync(resolve(target,'../build-plan.json'),JSON.stringify({application_id:'st.tk.magi.qa24',formal_application_untouched:true,app_js_sha256:appHash,records_only_release_get:true,paid_post_blocked:true},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({target,application_id:'st.tk.magi.qa24',same_app_js:true}));
