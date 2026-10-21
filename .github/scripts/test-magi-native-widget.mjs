import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../../magi-app/www/native-widget.js',import.meta.url),'utf8');
function fixture(){const ctx=vm.createContext({URL});vm.runInContext(source,ctx);return ctx.MagiNativeWidget;}
const sessions=[{id:'pending',title:'未完了',history:[{role:'user',content:'問い'}]},
 {id:'s',title:'題名\n 続き',history:[{role:'user',content:'問い'},{role:'assistant',content:'😀'.repeat(121),magi:{result:'approve'},native_request:'r'}]}];
test('B4: 伏せる場合は本文と題名を橋渡しへ渡さず、表示時は改行なし120字にする',()=>{
 const f=fixture(),hidden=f.data(sessions,true),shown=f.data(sessions,false);
 assert.deepEqual(Object.keys(hidden).sort(),['masked','sessionId']);assert.equal(hidden.sessionId,'s');
 assert.equal(shown.title,'題名 続き');assert.equal(Array.from(shown.summary).length,120);assert.equal(shown.verdict,'approve');
 assert.equal(f.data([],false).sessionId,'');assert.equal(f.data([{id:'../x',history:sessions[1].history}],true).sessionId,'');
});
test('B4: 3種類の起動だけを受け付け、余分な項目や重複ID・不正IDを拒む',()=>{
 const f=fixture();assert.equal(f.link('magi://new').action,'new');assert.equal(f.link('magi://voice').action,'voice');assert.equal(f.link('magi://open?id=s').id,'s');
 for(const url of ['https://open?id=s','magi://new?send=1','magi://voice/extra','magi://open?id=s&id=t','magi://open?id=../x','magi://open?id=s#x','magi://user@voice','magi://open?id=s&delete=true'])assert.equal(f.link(url),null,url);
});
test('B4: WebとiOSではプラグインに触れない',async()=>{
 const f=fixture();for(const platform of ['web','ios'])assert.equal(await f.create({cap:{isNativePlatform:()=>platform!=='web',getPlatform:()=>platform,get Plugins(){throw Error('must not read')}}}),null);
});
test('B4: 未取込回答はネイティブで復元し、保存失敗時は書かない',async()=>{
 const f=fixture(),calls=[];let pending=[{id:'new',sessionId:'s',status:'complete'}],fail=false;
 const bridge=await f.create({cap:{isNativePlatform:()=>true,getPlatform:()=>'android',Plugins:{MagiWidget:{information:async()=>({masked:true,revision:1}),update:async x=>calls.push(x)}}},
 sessions:()=>sessions,flush:async()=>{if(fail)throw Error('disk')},pending:async()=>pending});
 await bridge.sync();assert.equal(calls.length,1);assert.equal(calls[0].pendingId,'new');assert.equal(calls[0].pendingSessionId,'s');assert.equal('summary' in calls[0],false);
 pending=[{id:'r',sessionId:'s',status:'complete'}];await bridge.sync();assert.equal(calls.length,2);assert.equal('pendingId' in calls[1],false);
 fail=true;await assert.rejects(bridge.sync());assert.equal(calls.length,2);
});
test('B4: 保留一覧の読取中に受信が完了しても、新しい版で古い回答を上書きしない',async()=>{
 const f=fixture();let revision=0,complete=false,cache='Old answer',accepted=[];
 const plugin={information:async()=>({masked:false,revision}),update:async value=>{
  if(value.revision!==revision)throw Error('widget_state_changed');
  cache=value.pendingId==='new'?'New answer':value.summary;accepted.push(cache);revision++;
 }};
 const bridge=await f.create({cap:{isNativePlatform:()=>true,getPlatform:()=>'android',Plugins:{MagiWidget:plugin}},
  sessions:()=>[{id:'s',timestamp:1,title:'Title',history:[{role:'assistant',content:'Old answer',native_request:'old'}]}],flush:async()=>{},pending:async()=>{
   if(!complete){complete=true;cache='New answer';revision++;return[{id:'new',sessionId:'s',status:'receiving'}]}
   return[{id:'new',sessionId:'s',status:'complete',finishedAt:2,widgetAnswer:true}];
  }});
 await bridge.sync();assert.equal(cache,'New answer');assert.deepEqual(accepted,['New answer']);
});
test('B4: 別会話の古い完了列が残っても、より新しい会話の内容を再表示できる',async()=>{
 const f=fixture();let masked=true,revision=0,cache;
 const plugin={information:async()=>({masked,revision}),setMasked:async value=>{masked=value.masked;revision++},update:async value=>{assert.equal(value.revision,revision);cache=value;revision++}};
 const bridge=await f.create({cap:{isNativePlatform:()=>true,getPlatform:()=>'android',Plugins:{MagiWidget:plugin}},
  sessions:()=>[{id:'b',timestamp:20,title:'B title',history:[{role:'assistant',content:'B answer',native_request:'b_request'}]},
   {id:'a',timestamp:1,title:'A title',history:[{role:'user',content:'A question'}]}],flush:async()=>{},
  pending:async()=>[{id:'a_request',sessionId:'a',status:'complete',finishedAt:10,widgetAnswer:true}]});
 await bridge.setMasked(false);assert.equal(cache.sessionId,'b');assert.equal(cache.title,'B title');assert.equal(cache.summary,'B answer');assert.equal('pendingId' in cache,false);
});
test('B4: 聞き返し・取込済み・削除済みの列は表示候補にせず、最新の未取込回答を選ぶ',async()=>{
 const f=fixture();let cache;
 const bridge=await f.create({cap:{isNativePlatform:()=>true,getPlatform:()=>'android',Plugins:{MagiWidget:{information:async()=>({masked:true,revision:1}),update:async value=>cache=value}}},
  sessions:()=>[{id:'s',timestamp:1,title:'Title',history:[{role:'assistant',content:'Old answer',native_request:'old'}]}],flush:async()=>{},
  pending:async()=>[{id:'clarify',sessionId:'s',status:'complete',finishedAt:100,widgetAnswer:false},{id:'orphan',sessionId:'deleted',status:'complete',finishedAt:100},
   {id:'old',sessionId:'s',status:'complete',finishedAt:100},{id:'new',sessionId:'s',status:'complete',finishedAt:20,widgetAnswer:true},
   {id:'older',sessionId:'s',status:'complete',finishedAt:10,widgetAnswer:true}]});
 await bridge.sync();assert.equal(cache.pendingId,'new');assert.equal('title' in cache,false);assert.equal('summary' in cache,false);
});
test('B4: 同じ会話の古い保留列も新しい回答を上書きせず、現在待っている往復は復元する',async()=>{
 const f=fixture();let cache,history=[{role:'assistant',content:'Newer answer',native_request:'new'}];
 const bridge=await f.create({cap:{isNativePlatform:()=>true,getPlatform:()=>'android',Plugins:{MagiWidget:{information:async()=>({masked:false,revision:1}),update:async value=>cache=value}}},
  sessions:()=>[{id:'s',timestamp:30,title:'Title',history}],flush:async()=>{},pending:async()=>[{id:'pending',sessionId:'s',status:'complete',finishedAt:20,widgetAnswer:true}]});
 await bridge.sync();assert.equal(cache.summary,'Newer answer');assert.equal('pendingId'in cache,false);
 history=[{role:'user',content:'Waiting question',native_request:'pending'}];await bridge.sync();assert.equal(cache.pendingId,'pending');
});
test('B4: 設定変更を直列化し、ネイティブで受信が先に完了した場合は再判定する',async()=>{
 const f=fixture(),calls=[];let masked=false,revision=0,changed=false;
 const plugin={information:async()=>({masked,revision}),setMasked:async x=>{masked=x.masked;revision++;calls.push(['mask',masked])},update:async x=>{
  if(!changed){changed=true;revision++;throw Error('widget_state_changed')}assert.equal(x.revision,revision);calls.push(['update',x]);revision++;
 }};
 const bridge=await f.create({cap:{isNativePlatform:()=>true,getPlatform:()=>'android',Plugins:{MagiWidget:plugin}},sessions:()=>sessions,flush:async()=>{},pending:async()=>[]});
 await Promise.all([bridge.sync(),bridge.setMasked(true)]);assert.equal(calls[0][1].masked,false);assert.deepEqual(calls[1],['mask',true]);
 assert.equal(calls[2][1].masked,true);assert.equal('title' in calls[2][1],false);assert.equal('summary' in calls[2][1],false);
});
