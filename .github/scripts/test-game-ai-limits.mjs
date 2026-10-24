// 実SQLite・模擬上流で、呼び出し上限と障害時の停止を確認する。本番へは送らない。
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {gameAiDb} from './fixtures/game-ai-db.mjs';
import {stripAuxImports} from './aux-ai-config.mjs';
const read=p=>readFileSync(new URL('../../'+p,import.meta.url),'utf8');
function harness(t, config={}, upstream=null) {
  const DB=gameAiDb();t.after(()=>DB.close());let now=Date.parse('2026-10-24T12:00:01Z');const calls=[];
  class Clock extends Date { static now(){return now;} }
  const ctx=vm.createContext({aiModels:JSON.parse(read('config/ai-models.json')),Request,Response,URL,Headers,
    AbortController,AbortSignal,DOMException,TextDecoder,TextEncoder,setTimeout,clearTimeout,crypto:globalThis.crypto,Date:Clock,
    console:{warn(){}},fetch:async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});
      return upstream?upstream():Response.json({stop_reason:'end_turn',content:[{type:'text',text:'READY'}]});}});
  vm.runInContext(['workers/shared/anthropic.js','workers/games/anthropic.js','workers/games/src/index.js'].map(p=>stripAuxImports(read(p)).replace('export default {','globalThis.worker = {')).join('\n'),ctx);
  const env={DB,GAME_AI_PROVIDER:'anthropic',GAME_ANTHROPIC_API_KEY:'synthetic',...config};
  const request=(path='/api/gpt',body={prompt:'hello'},ip='203.0.113.7',extra={})=>new Request('https://game.example'+path,
    {method:'POST',headers:{Origin:'https://tk.st','Content-Type':'application/json',...(ip?{'CF-Connecting-IP':ip}:{}),...extra},body:typeof body==='string'?body:JSON.stringify(body)});
  return {DB,env,calls,request,run:r=>ctx.worker.fetch(r,env),move:ms=>{now+=ms;},count:()=>DB.sqlite.prepare("SELECT count FROM game_ai_usage WHERE bucket = 'global' ORDER BY period DESC LIMIT 1").get()?.count||0};
}

test('3つの旧・現行AI入口で分の枠を共有し、429とRetry-Afterを返す',async t=>{
  const w=harness(t,{GAME_AI_MINUTE_LIMIT:'2'});
  assert.equal((await w.run(w.request('/api/gpt'))).status,200);
  assert.equal((await w.run(w.request('/api/deepseek'))).status,200);
  const r=await w.run(w.request('/api/gemini',{contents:[{parts:[{text:'hello'}]}]}));
  assert.equal(r.status,429);assert.equal((await r.json()).error.message,'AI request limit reached');
  assert.equal(r.headers.get('Retry-After'),'59');assert.equal(w.calls.length,2);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'),'https://tk.st');
  assert.equal(r.headers.get('Cache-Control'),'no-store');
});

test('分が変われば回復し、IPの日次枠は維持する',async t=>{
  const w=harness(t,{GAME_AI_MINUTE_LIMIT:'1',GAME_AI_DAILY_LIMIT:'2'});
  assert.equal((await w.run(w.request())).status,200);w.move(60000);
  assert.equal((await w.run(w.request())).status,200);w.move(60000);
  const r=await w.run(w.request());assert.equal(r.status,429);assert.ok(Number(r.headers.get('Retry-After'))>60);
  w.move(86400000);assert.equal((await w.run(w.request())).status,200);assert.equal(w.calls.length,3);
});

test('IPを変えても全体の日次枠を越えて上流を呼べない',async t=>{
  const w=harness(t,{GAME_AI_GLOBAL_DAILY_LIMIT:'2'});
  for(const ip of ['203.0.113.1','203.0.113.2'])assert.equal((await w.run(w.request('/api/gpt',{prompt:'hello'},ip))).status,200);
  const before=w.DB.sqlite.prepare('SELECT count(*) AS n FROM game_ai_usage').get().n;
  assert.equal((await w.run(w.request('/api/gpt',{prompt:'hello'},'203.0.113.3'))).status,429);
  assert.equal(w.DB.sqlite.prepare('SELECT count(*) AS n FROM game_ai_usage').get().n,before);
  assert.equal(w.calls.length,2);assert.equal(w.count(),2);
});

test('同じIPの並行要求でも分の上限を越えない',async t=>{
  const w=harness(t,{GAME_AI_MINUTE_LIMIT:'3'});
  const responses=await Promise.all(Array.from({length:15},()=>w.run(w.request())));
  assert.equal(responses.filter(r=>r.status===200).length,3);assert.equal(w.calls.length,3);
  assert.equal(responses.filter(r=>r.status===429).length,12);
});

test('別IPからの並行要求でも全体の上限を越えない',async t=>{
  const w=harness(t,{GAME_AI_GLOBAL_DAILY_LIMIT:'3'});
  const responses=await Promise.all(Array.from({length:15},(_,i)=>w.run(w.request('/api/gpt',{prompt:'hello'},'203.0.113.'+(i+1)))));
  assert.equal(responses.filter(r=>r.status===200).length,3);assert.equal(w.calls.length,3);assert.equal(w.count(),3);
});

test('DBなし・表なし・DB障害・設定不正では上流を呼ばず503',async t=>{
  for(const mode of ['missing','table','failure','config']){
    const w=harness(t);
    if(mode==='missing')delete w.env.DB;
    if(mode==='table')w.DB.sqlite.exec('DROP TABLE game_ai_usage');
    if(mode==='failure')w.env.DB={prepare(){throw new Error('synthetic DB failure');}};
    if(mode==='config')w.env.GAME_AI_DAILY_LIMIT='0';
    const r=await w.run(w.request());assert.equal(r.status,503,mode);assert.equal(w.calls.length,0,mode);
    assert.equal((await r.json()).error,'AI limit unavailable');
  }
});

test('停止フラグはDBも上流も使わず503',async t=>{
  const w=harness(t,{GAME_AI_ENABLED:'false',DB:{prepare(){throw new Error('must not read');}}});
  assert.equal((await w.run(w.request())).status,503);assert.equal(w.calls.length,0);
});

test('上流失敗でも一度予約した枠は戻さない',async t=>{
  const w=harness(t,{GAME_AI_MINUTE_LIMIT:'1'},()=>new Response('',{status:500}));
  assert.ok((await w.run(w.request())).status>=500);
  assert.equal((await w.run(w.request())).status,429);assert.equal(w.calls.length,1);assert.equal(w.count(),1);
});

test('不正JSON・本文なし・配列・不正な旧contents・空入力は枠を使わない',async t=>{
  const w=harness(t);
  for(const [path,body] of [['/api/gpt','{'],['/api/gpt','null'],['/api/gpt',[]],['/api/gpt',{}],['/api/gpt',{messages:[]}],['/api/gemini',{contents:{}}]]){
    assert.equal((await w.run(w.request(path,body))).status,400);
  }
  assert.equal(w.count(),0);assert.equal(w.calls.length,0);
});

test('JSON以外のContent-Typeは415で拒否する',async t=>{
  const w=harness(t);
  assert.equal((await w.run(w.request('/api/gpt',{prompt:'hello'},'203.0.113.7',{'Content-Type':'text/plain'}))).status,415);
  assert.equal(w.count(),0);assert.equal(w.calls.length,0);
});

test('Content-Lengthを省略・偽装しても実バイトの上限を越える本文は413',async t=>{
  const w=harness(t);const raw=JSON.stringify({prompt:'あ'.repeat(100000)});
  for(const headers of [{},{'Content-Length':'1'},{'Content-Length':'999999'}]){
    assert.equal((await w.run(w.request('/api/gpt',raw,'203.0.113.7',headers))).status,413);
  }
  assert.equal(w.count(),0);assert.equal(w.calls.length,0);
});

test('分割ストリームの超過でも上流を呼ばず読み取りを止める',async t=>{
  const w=harness(t);let cancelled=false;
  const body=new ReadableStream({pull(c){c.enqueue(new Uint8Array(65536));},cancel(){cancelled=true;}});
  const r=await w.run(new Request('https://game.example/api/gpt',{method:'POST',headers:{Origin:'https://tk.st','Content-Type':'application/json'},body,duplex:'half'}));
  assert.equal(r.status,413);assert.equal(cancelled,true);assert.equal(w.calls.length,0);
});

test('CFのIPがなければ共通枠を使い、X-Forwarded-Forで逃げられない',async t=>{
  const w=harness(t,{GAME_AI_MINUTE_LIMIT:'1'});
  assert.equal((await w.run(w.request('/api/gpt',{prompt:'hello'},null,{'X-Forwarded-For':'203.0.113.1'}))).status,200);
  assert.equal((await w.run(w.request('/api/gpt',{prompt:'hello'},null,{'X-Forwarded-For':'203.0.113.2'}))).status,429);
});

test('IPは直接保存せず、期限切れの回数行だけを掃除する',async t=>{
  const w=harness(t);w.DB.sqlite.exec("CREATE TABLE scores (score INTEGER); INSERT INTO scores VALUES (42); INSERT INTO game_ai_usage VALUES ('old','old',1,0)");
  assert.equal((await w.run(w.request())).status,200);
  assert.equal(w.DB.sqlite.prepare("SELECT * FROM game_ai_usage WHERE bucket='old'").get(),undefined);
  assert.equal(w.DB.sqlite.prepare('SELECT score FROM scores').get().score,42);
  assert.ok(w.DB.sqlite.prepare('SELECT bucket FROM game_ai_usage').all().every(row=>!row.bucket.includes('203.0.113.7')));
});

test('許可外Originは回数記録や有料呼び出しより前に拒否する',async t=>{
  const w=harness(t);
  assert.equal((await w.run(w.request('/api/gpt',{prompt:'hello'},'203.0.113.7',{Origin:'https://outside.example'}))).status,403);
  assert.equal(w.calls.length,0);assert.equal(w.count(),0);
});
