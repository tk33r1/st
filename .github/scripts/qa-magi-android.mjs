// 接続した本人の実機を確認する補助。AI送信・アプリデータ削除は行わない。
// XMLと画像はGit対象外。既存画面から読んだラベルの要素だけをタップする。
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const arg=(name,fallback='')=>process.argv.find(a=>a.startsWith('--'+name+'='))?.slice(name.length+3)||fallback;
const adb=arg('adb');assert(adb,'--adbにSDKのadb.exeを指定する');
const device=arg('device');assert(device,'--deviceで対象の端末を明示する');
const run=(...args)=>execFileSync(adb,['-s',device,...args],{maxBuffer:16*1024*1024});
const dir=fileURLToPath(new URL('../../workers/.wrangler/magi2-android-20261017/',import.meta.url));mkdirSync(dir,{recursive:true});
const label=arg('snapshot');if(label)assert.match(label,/^[a-z0-9-]+$/);
const decode=s=>s.replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
function snapshot(){
 run('shell','uiautomator','dump','/data/local/tmp/magi-qa.xml');
 const xml=run('shell','cat','/data/local/tmp/magi-qa.xml').toString('utf8');
 const nodes=[...xml.matchAll(/<node ([^>]+)>?/g)].map(m=>Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(m=>[m[1],decode(m[2])])));
 return {xml,nodes};
}
if(arg('tap')||arg('tap-class')){
 const value=arg('tap'),{nodes}=snapshot();
 let found=arg('tap-class')?nodes.filter(n=>n.class===arg('tap-class')&&n.package==='st.tk.magi')
  :nodes.filter(n=>n.clickable==='true'&&(n.text===value||n['content-desc']===value));
 if(!found.length&&!arg('tap-class'))found=nodes.filter(n=>n.text===value||n['content-desc']===value);
 assert.equal(found.length,1,'タップ対象は現在画面内に1つ必要');
 const box=found[0].bounds.match(/\d+/g).map(Number);assert.equal(box.length,4);
 run('shell','input','tap',String(Math.floor((box[0]+box[2])/2)),String(Math.floor((box[1]+box[3])/2)));
 console.log('Tapped observed UI label');
}
if(arg('scroll')){
 assert.equal(arg('scroll'),'down');
 const count=Number(arg('repeat','1'));assert(Number.isInteger(count)&&count>=1&&count<=12);
 for(let i=0;i<count;i++){
  const {nodes}=snapshot(),scrolls=nodes.filter(n=>n.scrollable==='true');assert.equal(scrolls.length,1);
  const [x1,y1,x2,y2]=scrolls[0].bounds.match(/\d+/g).map(Number),x=Math.floor((x1+x2)/2);
  run('shell','input','swipe',String(x),String(y2-100),String(x),String(y1+100),'450');
 }
}
if(arg('key')){assert(['BACK','HOME'].includes(arg('key')));run('shell','input','keyevent',arg('key'));}
if(label){
 const {xml,nodes}=snapshot();writeFileSync(join(dir,label+'.xml'),xml);
 writeFileSync(join(dir,label+'.png'),run('exec-out','screencap','-p'));
 // 任意の会話内容は標準出力へ出さない。操作するラベルの確認は保存XMLを必要に応じて読む。
 console.log(JSON.stringify({snapshot:label,nodes:nodes.length,clickable:nodes.filter(n=>n.clickable==='true').length,
  update_notice:nodes.some(n=>/新しいバージョン|Version .* available/.test(n.text)),
  versions:nodes.filter(n=>/^ver \d/.test(n.text)).map(n=>n.text)}));
}
if(arg('list-labels')){
 const {nodes}=snapshot();console.log(JSON.stringify(nodes.filter(n=>n.clickable==='true').map(n=>({text:n.text,description:n['content-desc'],bounds:n.bounds}))));
}
