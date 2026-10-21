import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../../magi-app/www/native-widget.js',import.meta.url),'utf8');
function fixture(){const ctx=vm.createContext({URL});vm.runInContext(source,ctx);return ctx.MagiNativeWidget;}
test('B4: 4種類の入口と既存の会話だけを受け付け、余分な項目や重複ID・不正IDを拒む',()=>{
 const f=fixture();
 for(const action of ['new','voice','camera','album'])assert.equal(f.link('magi://'+action).action,action);
 assert.equal(f.link('magi://open?id=s').id,'s');
 for(const url of ['https://open?id=s','magi://new?send=1','magi://camera?send=1','magi://album/extra','magi://voice/extra','magi://resume','magi://open?id=s&id=t','magi://open?id=../x','magi://open?id=s#x','magi://user@voice','magi://open?id=s&delete=true'])assert.equal(f.link(url),null,url);
});
test('B4: WebとiOSではプラグインに触れない',async()=>{
 const f=fixture();for(const platform of ['web','ios'])assert.equal(await f.create({cap:{isNativePlatform:()=>platform!=='web',getPlatform:()=>platform,get Plugins(){throw Error('must not read')}}}),null);
});
test('B4: 画面からは追加の可否と追加の要求だけを使い、会話の内容を渡さない',async()=>{
 const f=fixture(),calls=[];
 const plugin=new Proxy({},{get:(_,name)=>async args=>{calls.push([name,args]);return name==='information'?{canPin:true}:{requested:true}}});
 const bridge=await f.create({cap:{isNativePlatform:()=>true,getPlatform:()=>'android',Plugins:{MagiWidget:plugin}}});
 assert.deepEqual(Object.keys(bridge).sort(),['pin','state']);
 assert.equal((await bridge.state()).canPin,true);assert.equal((await bridge.pin()).requested,true);
 assert.deepEqual(calls.map(c=>c[0]),['information','pin']);assert.deepEqual(calls.map(c=>c[1]),[undefined,undefined]);
});
