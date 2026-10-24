import {gameAiDb} from './fixtures/game-ai-db.mjs';
// 前回合格5件は再利用。不合格2件の修正後Haikuと、同じ7入力のLunaを各1回だけ比較する。
// 既定は無通信。--runも固定計画・共通累計予算・送信前の要求別予約が必要。
import {readFileSync,writeFileSync,existsSync,mkdirSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {stripAuxImports} from './aux-ai-config.mjs';
import {paidEvaluationGate,evaluationBudgetPath,evaluationRequestHash} from './magi-eval-budget.mjs';

const root=new URL('../../',import.meta.url),read=p=>readFileSync(new URL(p,root),'utf8');
const kabukiRepair=process.argv.includes('--kabuki-repair');
const shortRevision=process.argv.includes('--revision=short');
assert(!shortRevision||kabukiRepair,'短文修正はKabukiだけ');
const phase=kabukiRepair?'auxiliary-kabuki-repair-20261017'+(shortRevision?'-short':''):'auxiliary-games-comparison-20261017';
const dir=new URL('workers/.wrangler/'+(kabukiRepair?'auxiliary-haiku-kabuki-20261017'+(shortRevision?'-short':''):'auxiliary-haiku-20261017')+'/',root);mkdirSync(dir,{recursive:true});
const sha=s=>createHash('sha256').update(s).digest('hex');
const files=['config/ai-models.json','workers/shared/anthropic.js','workers/games/anthropic.js','workers/games/src/index.js',
 'game/masala-tetris/index.html','game/masala-tetris-tiffin/index.html','game/kabuki-craft/index.html','.github/scripts/eval-games-haiku-comparison.mjs'];
const registry=JSON.parse(read(files[0])),source_hash=sha(files.map(read).join('\n'));
const old=JSON.parse(read('workers/.wrangler/auxiliary-haiku/games-plan.json'));
const saved=JSON.parse(read('workers/.wrangler/auxiliary-haiku/games-result.json'));
const previous=JSON.parse(read('workers/.wrangler/auxiliary-haiku/browser.json'));
const current=JSON.parse(readFileSync(new URL('browser.json',dir),'utf8'));
const repaired=kabukiRepair?['kabuki-craft']:['masala-tetris','masala-tetris-tiffin'];
assert(current.results.length===(kabukiRepair?1:7)&&current.results.every(r=>r.ok),'修正後の画面確認が必要');
assert.equal(old.requests.length,7);assert(saved.complete);
const pick=(capture,game)=>capture.requests.find(r=>r.game===game&&(game!=='kabuki-craft'||r.body.maxTokens===260));
const planned=[];
let selected;
const ctx=vm.createContext({crypto:globalThis.crypto,TextEncoder,AbortSignal,aiModels:registry,Request,Response,Headers,URL,AbortController,DOMException,TextDecoder,setTimeout,clearTimeout,
 fetch:async(url,options)=>{
  const body=JSON.parse(options.body),provider=String(url).includes('anthropic.com')?'anthropic':'openai';
  assert.equal(String(url),provider==='anthropic'?'https://api.anthropic.com/v1/messages':'https://api.openai.com/v1/chat/completions');
  const input=Buffer.byteLength(JSON.stringify(body))*2+2048,output=body.max_tokens||body.max_completion_tokens;
  assert(input<100000&&!body.tools&&output<=800);
  const rates=provider==='anthropic'?[.20,.50]:[.25,.75];
  const estimate={provider,model:body.model,max_usd:Math.ceil((input*rates[0]+output*rates[1])*1.1)/1e6,pricing_checked_at:'2026-10-17',
   evaluation_batch:phase,
   basis:`UTF8 bytes*2+2048=${input} input ceiling (<100k), output<=${output}; input $${rates[0]}/M, output $${rates[1]}/M, 10%余裕。Web・画像・再試行なし。https://platform.claude.com/docs/en/about-claude/pricing https://developers.openai.com/api/docs/pricing`};
  planned.push({game:selected,provider,url:String(url),body,request_hash:evaluationRequestHash(provider,body),estimate});
  return Response.json(provider==='anthropic'?{stop_reason:'end_turn',content:[{type:'text',text:'plan'}]}:{choices:[{message:{content:'plan'}}]});
 }});
vm.runInContext(files.slice(1,4).map(p=>stripAuxImports(read(p)).replace('export default {','globalThis.worker = {')).join('\n'),ctx);
for(const item of old.requests.filter(r=>!kabukiRepair||r.game==='kabuki-craft')){
 selected=item.game;
 const sample=pick(repaired.includes(selected)?current:previous,selected);assert(sample);
 for(const provider of repaired.includes(selected)?['anthropic','openai']:['openai']){
  const response=await ctx.worker.fetch(new Request('https://st-games-api.tk33r1.workers.dev'+sample.path,
   {method:'POST',headers:{Origin:'https://tk.st','Content-Type':'application/json'},body:JSON.stringify(sample.body)}),
   {DB:gameAiDb(),GAME_AI_PROVIDER:provider,GAME_OPENAI_API_KEY:'plan',GAME_ANTHROPIC_API_KEY:'plan'});
  assert.equal(response.status,200);
 }
 if(!repaired.includes(selected)){
  const record=saved.results.find(r=>r.game===selected);assert(record?.completed&&record.reply.stop_reason==='end_turn');
  assert.equal(record.request_hash,item.request_hash);
 }
}
const totals={openai:0,anthropic:0};for(const r of planned)totals[r.provider]+=Math.ceil(r.estimate.max_usd*1e6);
for(const p of Object.keys(totals))totals[p]/=1e6;
const plan={version:1,phase,source_hash,old_plan_hash:sha(JSON.stringify(old)),
 saved_result_hash:sha(JSON.stringify(saved)),max_usd:totals,total_max_usd:(Math.round(totals.openai*1e6)+Math.round(totals.anthropic*1e6))/1e6,
 requests:planned,reused:kabukiRepair?[]:saved.results.filter(r=>!repaired.includes(r.game)).map(r=>({game:r.game,request_hash:r.request_hash})),
 quality_gate:kabukiRepair?'両社の正常終了、指定JSON、say70字以内、指定act・数値、人物設定、採掘0個と矛盾する事実・噂を作らない。同一入力でLunaより意味・表示を悪くしない。':'全7件が正常終了。Masalaは80字以内・励まし、DX20字以内、Vindaloo24字以内、TIFFIN30字以内・架空の条件なし、ASCIIはセンサー一致、Kabukiは指定JSONと人物設定。既存Lunaより意味・ゲーム表示を悪くしない。比較後に採否を決める。'};
assert.equal(planned.length,kabukiRepair?2:9);assert(plan.total_max_usd<=.025);
const planFile=new URL('games-comparison-plan.json',dir),resultFile=new URL('games-comparison-result.json',dir);
if(!process.argv.includes('--run')){
 if(existsSync(planFile))assert.equal(sha(readFileSync(planFile,'utf8')),sha(JSON.stringify(plan,null,2)+'\n'),'既存計画を上書きしない');
 else writeFileSync(planFile,JSON.stringify(plan,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({mode:'plan',calls:planned.length,reused:plan.reused.length,max_usd:totals,total_max_usd:plan.total_max_usd,network_calls:0}));
 process.exit(0);
}
const gate=paidEvaluationGate();assert(!existsSync(resultFile),'結果を再実行・上書きしない');
assert.equal(sha(JSON.stringify(JSON.parse(readFileSync(planFile,'utf8')))),sha(JSON.stringify(plan)),'計画後に入力・コードが変わった');
const lock=evaluationBudgetPath+'.lock',fd=openSync(lock,'wx');
try{
 const ledger=JSON.parse(readFileSync(evaluationBudgetPath,'utf8'));
 const spent=p=>ledger.reservations.filter(r=>!p||r.provider===p).reduce((n,r)=>n+Math.ceil(r.max_usd*1e6),0);
 assert(spent()+Math.ceil(plan.total_max_usd*1e6)<=800000);
 for(const provider of Object.keys(totals))assert(spent(provider)+Math.ceil(totals[provider]*1e6)<=400000);
 for(const r of planned){assert(!ledger.reservations.some(x=>x.request_hash===r.request_hash),'同じ要求を再送しない');
  const prior=ledger.estimates[r.request_hash];if(prior)assert.deepEqual(prior,r.estimate);else ledger.estimates[r.request_hash]=r.estimate;}
 writeFileSync(evaluationBudgetPath,JSON.stringify(ledger,null,2)+'\n');
}finally{closeSync(fd);unlinkSync(lock);}
const vars=read('workers/magi2/.dev.vars'),key=provider=>{
 const name=provider==='anthropic'?'MAGI_ANTHROPIC_API_KEY':'MAGI_OPENAI_API_KEY';
 const value=process.env[name]||vars.match(new RegExp('^\\s*'+name+'\\s*=\\s*(.*?)\\s*$','m'))?.[1]?.replace(/^(['"])(.*)\1$/,'$2');
 assert(value,name+' required');return value;
};
// キーが片方でも無い場合は、予約・送信・結果ファイル作成より前に停止する。
const keys={anthropic:key('anthropic'),openai:key('openai')};
const report={phase:plan.phase,plan_hash:sha(JSON.stringify(plan)),complete:false,results:[]};
const save=()=>writeFileSync(resultFile,JSON.stringify(report,null,2)+'\n');
writeFileSync(resultFile,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
ctx.fetch=fetch;
for(const r of planned){
 const row={game:r.game,provider:r.provider,...gate.reserve(r.provider,r.body),completed:false};report.results.push(row);save();
 const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),30000),start=Date.now();
 try{
  if(r.provider==='anthropic'){row.reply=await ctx.postAnthropicJSON(keys.anthropic,r.body,ac.signal);row.text=ctx.anthropicText(row.reply);}
  else{
   const response=await fetch(r.url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+keys.openai},body:JSON.stringify(r.body),signal:ac.signal});
   if(!response.ok)throw new Error('HTTP '+response.status);
   row.reply=await response.json();assert.equal(row.reply.choices?.[0]?.finish_reason,'stop');
   row.text=row.reply.choices[0].message.content?.trim();assert(row.text);
  }
  row.completed=true;
 }catch(e){row.error=e.name+': '+e.message;}
 finally{clearTimeout(timer);row.ms=Date.now()-start;save();}
}
report.complete=true;save();console.log(JSON.stringify({complete:true,calls:report.results.length,max_usd:plan.total_max_usd}));
