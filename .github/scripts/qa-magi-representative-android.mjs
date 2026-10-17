// 予約・本番ガード・固定文面を照合した合成入力だけを、正式APKの観測したSendから1回送る。
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const arg=n=>process.argv.find(a=>a.startsWith('--'+n+'='))?.slice(n.length+3);
const adb=arg('adb'),device=arg('device'),id=arg('type')||arg('send');
assert(adb&&device&&id&&!(arg('type')&&arg('send')),'--adb --deviceと--typeまたは--sendを指定');
const dir=new URL('../../workers/.wrangler/magi2-compact-20261017/',import.meta.url);
const read=n=>JSON.parse(readFileSync(new URL(n,dir),'utf8'));
const plan=read('native-plan.json'),sample=plan.cases.find(c=>c.id===id);
assert(sample&&sample.kind==='chat'&&Date.parse(plan.expires_at)>Date.now());
const hash=createHash('sha256').update(JSON.stringify(plan)).digest('hex');
const reservations=read('native-reservations.json');assert.equal(reservations.plan_hash,hash);
assert.equal(read('native-armed.json').plan_hash,hash);
for(const provider of ['openai','anthropic','deepseek','typesafe']){
 const r=reservations.providers.find(r=>r.provider===provider);
 assert(r&&r.max_usd*1e6+0.001>=plan.cases.reduce((n,c)=>n+c.caps_micro[provider],0));
}
const marker=new URL('native-'+id+'-sent.json',dir);assert(!existsSync(marker),'同じ合成ケースを再送しない');
const run=(...args)=>execFileSync(adb,['-s',device,...args],{maxBuffer:16*1024*1024});
const decode=s=>s.replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
function snapshot(){
 run('shell','uiautomator','dump','/data/local/tmp/magi-qa.xml');
 const xml=run('shell','cat','/data/local/tmp/magi-qa.xml').toString('utf8');
 const nodes=[...xml.matchAll(/<node ([^>]+)>?/g)].map(m=>Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(m=>[m[1],decode(m[2])])));
 return {xml,nodes};
}
const tap=n=>{const [x1,y1,x2,y2]=n.bounds.match(/\d+/g).map(Number);run('shell','input','tap',String(Math.floor((x1+x2)/2)),String(Math.floor((y1+y2)/2)));};
function input(nodes){const rows=nodes.filter(n=>n.package==='st.tk.magi'&&n['resource-id']==='agent-input'&&n.class==='android.widget.EditText');
 assert.equal(rows.length,1);assert.equal(rows[0].enabled,'true');return rows[0];}
let state=snapshot();
if(arg('type')){
 const field=input(state.nodes);assert.equal(field.text,'','空の新規会話へだけ入力');
 assert.match(sample.text,/^[A-Za-z0-9 .,?()-]+$/,'ADB入力は固定ASCIIのみに制限');
 tap(field);run('shell','input','keyevent','BACK'); // IMEの変換候補を閉じてからハードウェアキー入力を送る。
 // IMEが大量のキーイベントを落とさないよう短い塊に分け、都度受け付けた値を確認する。
 for(let i=0;i<sample.text.length;i+=24){
  run('shell',"input text '"+sample.text.slice(i,i+24).replaceAll(' ','%s')+"'");
  await new Promise(resolve=>setTimeout(resolve,150));
  state=snapshot();assert.equal(input(state.nodes).text,sample.text.slice(0,i+24),'IMEでの誤変換・欠落があれば送信しない');
 }
 state=snapshot();assert.equal(input(state.nodes).text,sample.text,'入力文字列が計画と一致すること');
 writeFileSync(new URL('native-'+id+'-typed.xml',dir),state.xml);
 console.log(JSON.stringify({id,typed_exactly:true,sent:false}));
}else{
 assert.equal(input(state.nodes).text,sample.text,'送信直前にも固定文面を照合');
 assert.equal(state.nodes.filter(n=>n['content-desc']==='Remove attachment'||n.text==='Remove attachment').length,sample.images,'予定した画像枚数だけ');
 const buttons=state.nodes.filter(n=>n.package==='st.tk.magi'&&n['content-desc']==='Send'&&n.enabled==='true');
 assert.equal(buttons.length,1);
 writeFileSync(new URL('native-'+id+'-send.xml',dir),state.xml);
 writeFileSync(marker,JSON.stringify({id,plan_hash:hash,sent_at:new Date().toISOString(),state:'tap_started'},null,2)+'\n',{flag:'wx'});
 tap(buttons[0]);console.log(JSON.stringify({id,sent_once:true}));
}
