// 条件付きのHaiku移行。外部API・本番DBを使わず、旧入口と2段階の出典照合・期限を確認する。
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {auxiliaryConfig,stripAuxImports} from './aux-ai-config.mjs';
const read=p=>readFileSync(new URL('../../'+p,import.meta.url),'utf8');
const registry=JSON.parse(read('config/ai-models.json'));
const reply=(text='READY',stop_reason='end_turn')=>({stop_reason,content:[{type:'thinking',signature:'opaque'},{type:'text',text}]});
const source='https://official.example/song';
const searched=()=>({...reply('この曲は1982年に初出。'),content:[{type:'server_tool_use',id:'s1',name:'web_search'},
  {type:'web_search_tool_result',tool_use_id:'s1',content:[{type:'web_search_result',url:source,title:'公式'}]},
  {type:'text',text:'この曲は1982年に初出。',citations:[{type:'web_search_result_location',url:source,cited_text:'この曲は1982年に初出。'}]}]});
const card=()=>({identified:true,original_year:1982,year_note:null,facts:[{kind:'other',text:'公式の記述',source_url:source},
  {kind:'viral',text:'検索にない情報',source_url:'https://invented.example/'}],viral_version:'invented',floor_tip:'架空の使いどころ',
  floor_tip_source:'https://invented.example/',mix_hint:null});
function load(kind,upstream){
 const calls=[];
 const ctx=vm.createContext({aiModels:registry,Request,Response,URL,Headers,AbortController,DOMException,TextDecoder,TextEncoder,
  setTimeout,clearTimeout,console,crypto:globalThis.crypto,transitionScores(){throw new Error('Unexpected Jev call');},
  fetch:async(url,options)=>{calls.push({url,options,body:JSON.parse(options.body)});return upstream(url,options,calls.length);}});
 const paths=['workers/shared/anthropic.js',kind==='games'?'workers/games/anthropic.js':'workers/dj-request/song-info-anthropic.js',`workers/${kind}/src/index.js`];
 vm.runInContext(paths.map(p=>stripAuxImports(read(p)).replace('export default {','globalThis.worker = {')).join('\n'),ctx);
 return {ctx,calls,env:kind==='games'?{GAME_AI_PROVIDER:'anthropic',GAME_ANTHROPIC_API_KEY:'private'}:{SONG_INFO_AI_PROVIDER:'anthropic',ANTHROPIC_API_KEY:'private'}};
}
const req=(w,path,body)=>w.ctx.worker.fetch(new Request('https://game.example'+path,{method:'POST',headers:{Origin:'https://tk.st','Content-Type':'application/json'},body:JSON.stringify(body)}),w.env);

test('ゲーム：3入口の応答形・履歴・サーバー側の上限を維持してMessagesへ変換する',async()=>{
 for(const path of ['/api/gpt','/api/deepseek','/api/gemini']){
  const w=load('games',()=>Response.json(reply('  answer  ')));
  const legacy=path==='/api/gemini';
  const res=await req(w,path,legacy?{systemInstruction:{parts:[{text:'rules'}]},contents:[{role:'user',parts:[{text:'question'}]}]}:
    {system:'rules',prompt:'question',maxTokens:99999,model:'untrusted',temperature:0.1});
  assert.equal(res.status,200);assert.equal(res.headers.get('Access-Control-Allow-Origin'),'https://tk.st');
  const json=await res.json();assert.equal(legacy?json.candidates[0].content.parts[0].text:json.text,'answer');
  const {body,options}=w.calls[0];assert.equal(body.model,registry.anthropic.haiku.id);assert.equal(body.system,'rules');
  assert.equal(body.max_tokens,800);assert.equal(body.thinking.type,'disabled');
  for(const k of ['temperature','top_p','top_k','reasoning_effort','tools'])assert.ok(!(k in body));
  assert.equal(options.headers['x-api-key'],'private');assert.ok(!JSON.stringify(json).includes('private'));
 }
});
test('ゲーム：20メッセージ・4000文字の上限と旧assistant末尾の続行を守る',async()=>{
 const w=load('games',()=>Response.json(reply('x','max_tokens')));
 const messages=Array.from({length:23},(_,i)=>({role:i===22?'model':'user',content:'x'.repeat(5000)}));
 assert.equal((await req(w,'/api/gpt',{system:'s'.repeat(5000),messages})).status,200);
 const body=w.calls[0].body;assert.equal(body.system.length,4000);assert.equal(body.messages.length,21);
 assert.ok(body.messages.slice(0,-1).every(m=>m.content.length===4000));assert.equal(body.messages.at(-1).role,'user');
});
test('ゲーム：移行前の既定値はOpenAI、キー欠落・HTTP失敗・拒否・空文を正しく返す',async()=>{
 const old=load('games',()=>Response.json({choices:[{message:{content:'old'}}]}));old.env={GAME_OPENAI_API_KEY:'old-key'};
 assert.equal((await(await req(old,'/api/gpt',{prompt:'question'})).json()).text,'old');assert.ok(old.calls[0].url.includes('openai'));
 const missing=load('games',()=>{throw new Error('Must not call');});delete missing.env.GAME_ANTHROPIC_API_KEY;
 assert.equal((await req(missing,'/api/gpt',{prompt:'q'})).status,503);assert.equal(missing.calls.length,0);
 assert.equal((await req(missing,'/api/gpt',{messages:[]})).status,400);
 for(const [response,status] of [[()=>new Response('',{status:429}),429],[()=>Response.json(reply('','end_turn')),502],[()=>Response.json(reply('refused','refusal')),502]]){
  const w=load('games',response),r=await req(w,'/api/gemini',{contents:[{role:'user',parts:[{text:'q'}]}]});
  assert.equal(r.status,status);assert.equal((await r.json()).error.message,'upstream');
 }
});
test('DJ：検索と構造化を分け、同じ期限・実検索URLの照合で架空の出典を落とす',async()=>{
 const w=load('dj-request',(_u,_o,n)=>Response.json(n===1?searched():reply(JSON.stringify(card()))));
 const raw=await w.ctx.requestSongInfo(w.env,{title:'test',artist:'artist'},25000),value=w.ctx.buildSongCard(raw);
 assert.equal(w.calls.length,2);const [a,b]=w.calls;
 assert.equal(a.body.tools[0].max_uses,2);assert.equal(a.body.tool_choice.name,'web_search');assert.ok(!a.body.output_config.format);
 assert.ok(b.body.output_config.format.schema);assert.ok(!b.body.tools);assert.equal(b.body.thinking.type,'disabled');
 assert.equal(b.body.output_config.format.schema.properties.facts.maxItems,undefined);
 assert.equal(auxiliaryConfig().schema.properties.facts.maxItems,4);
 assert.equal(a.options.signal,b.options.signal);assert.equal(value.facts.length,1);assert.equal(value.dropped,1);
 assert.equal(value.facts[0].url,source);assert.equal(value.viralVersion,'');assert.equal(value.floorTip,'');
 assert.ok(!JSON.stringify(a.body).includes('private'));
});
test('DJ：検索未実行・ツール内エラー・pause・拒否・不正JSONでは先へ進めず、再試行もしない',async()=>{
 for(const first of [reply('no search'),{...searched(),stop_reason:'pause_turn'},reply('no','refusal'),
  {...searched(),content:[{type:'server_tool_use',id:'s1',name:'web_search'},{type:'web_search_tool_result',tool_use_id:'s1',content:{type:'web_search_tool_result_error',error_code:'max_uses_exceeded'}},{type:'text',text:'partial'}]}]){
  const w=load('dj-request',()=>Response.json(first));await assert.rejects(w.ctx.requestSongInfo(w.env,{},200));assert.equal(w.calls.length,1);
 }
 const w=load('dj-request',(_u,_o,n)=>Response.json(n===1?searched():reply('not json')));
 await assert.rejects(w.ctx.requestSongInfo(w.env,{},200));assert.equal(w.calls.length,2);
});
test('DJ：無引用の要約・検索外の引用・URLの大文字小文字のすり替えを根拠にしない',async()=>{
 for(const url of [null,'https://invented.example/','https://official.example/Song']){
  const data=searched(),text=data.content.at(-1);text.text='根拠のない要約';
  text.citations=url?[{type:'web_search_result_location',url,cited_text:'架空の引用'}]:[];
  const w=load('dj-request',()=>Response.json(data));await assert.rejects(w.ctx.requestSongInfo(w.env,{},200));assert.equal(w.calls.length,1);
 }
 const w=load('dj-request',()=>Response.json(searched())),evidence=w.ctx.songSearchEvidence(searched());
 assert(!JSON.stringify(evidence).includes('encrypted_content'));assert(evidence.excerpts.length===1);
 const raw=card();raw.facts=[{kind:'other',text:'大文字パスは別ページ',source_url:'https://official.example/Song'}];
 assert.equal(w.ctx.buildSongCard(w.ctx.songCardOutput(evidence,reply(JSON.stringify(raw)))).facts.length,0);
});
test('DJ：大きすぎる引用資料は切り詰めず後段の有料呼出し前に停止する',async()=>{
 const data=searched();data.content.at(-1).citations[0].cited_text='大'.repeat(16000);
 const w=load('dj-request',()=>Response.json(data));await assert.rejects(w.ctx.requestSongInfo(w.env,{},200),/evidence too large/);
 assert.equal(w.calls.length,1);
});
test('DJ：検索で見つかっただけの未引用URLと、検索係の無引用の要約をJSON係へ渡さない',()=>{
 const data=searched();data.content[1].content.push({type:'web_search_result',url:'https://official.example/uncited',title:'未引用'});
 data.content.at(-1).text='LEAK_UNCITED_SUMMARY';
 const w=load('dj-request',()=>{throw new Error('No network');}),evidence=w.ctx.songSearchEvidence(data);
 assert.equal(evidence.sources.length,1);
 const body=w.ctx.songCardBody({},evidence,auxiliaryConfig().schema);
 assert(!body.messages[0].content.includes('LEAK_UNCITED_SUMMARY'));
 const raw=card();raw.facts=[{kind:'other',text:'引用されていない出典',source_url:'https://official.example/uncited'}];
 assert.equal(w.ctx.buildSongCard(w.ctx.songCardOutput(evidence,reply(JSON.stringify(raw)))).facts.length,0);
});
test('DJ：期限はヘッダー・本文を含み、止まった応答でも返ってくる',async()=>{
 for(const body of [false,true]){
  let cancelled=false;
  const w=load('dj-request',()=>body?new Response(new ReadableStream({pull(){},cancel(){cancelled=true;}})):new Promise(()=>{}));
  await assert.rejects(w.ctx.requestSongInfo(w.env,{},15),{name:'AbortError'});assert.equal(w.calls.length,1);assert.ok(w.calls[0].options.signal.aborted);
  if(body)assert.ok(cancelled);
 }
});
test('DJ：既定のOpenAI経路と、採用した会社のキー判定・保存モデルを保持する',async()=>{
 const w=load('dj-request',()=>Response.json({output:[]}));w.env={OPENAI_API_KEY:'old-key'};
 await w.ctx.requestSongInfo(w.env,{},100);assert.equal(w.calls.length,1);assert.ok(w.calls[0].url.includes('openai'));
 assert.equal(w.calls[0].body.reasoning.effort,'high');assert.equal(w.calls[0].body.tool_choice,'required');
 const canDescribe=vm.runInContext('canDescribe',w.ctx);
 assert.equal(canDescribe({SONG_INFO_AI_PROVIDER:'anthropic',ANTHROPIC_API_KEY:'key'},{trackId:'123',isFree:false}),true);
 assert.equal(canDescribe({SONG_INFO_AI_PROVIDER:'anthropic',OPENAI_API_KEY:'key'},{trackId:'123'}),false);
 let saved;const env={...w.env,SONG_INFO_AI_PROVIDER:'anthropic',DB:{prepare(){return {bind(...args){saved=args;return {async run(){}};}};}}};
 await w.ctx.saveSongInfo(env,'123',{card:{ok:true}});assert.equal(saved[1],registry.anthropic.haiku.id);
});

test('DJ：DBでの先取りに使った時間も生成の持ち時間から引く',async()=>{
 const w=load('dj-request',()=>{throw new Error('Must not fetch');});
 w.ctx.now=0;w.ctx.Date={now:()=>w.ctx.now};w.ctx.real={trackId:'123',title:'test'};
 vm.runInContext('lookupTrack=async()=>{now+=3000;return real;};claimSongInfo=async()=>{now+=2000;return true;};requestSongInfo=async(_env,_song,left)=>{globalThis.left=left;return {};};buildSongCard=()=>({});',w.ctx);
 const result=await w.ctx.startSongInfo(w.env,{trackId:'123',title:'test'});
 await result.promise;assert.equal(w.ctx.left,20000);
 w.ctx.now=0;vm.runInContext('claimSongInfo=async()=>{now+=30000;return true;};',w.ctx);w.ctx.left=undefined;
 const expired=await w.ctx.startSongInfo(w.env,{trackId:'123',title:'test'});
 assert.equal((await expired.promise).error,'時間切れ');assert.equal(w.ctx.left,undefined);
});
test('モデルは正本を使い、採用設定はゲームHaiku・検索付きDJはLunaに揃う',()=>{
 const cfg=auxiliaryConfig();assert.equal(cfg.search.model,registry.anthropic.haiku.id);assert.equal(cfg.card.model,cfg.game.model);
 assert.ok(read('workers/games/wrangler.toml').includes('GAME_AI_PROVIDER = "anthropic"'));
 assert.ok(read('workers/dj-request/wrangler.toml').includes('SONG_INFO_AI_PROVIDER = "openai"'));
});
