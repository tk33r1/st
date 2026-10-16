// 7画面から取得した合成入力だけ。既定は無通信の計画作成、--runは承認後に共有台帳で予約する。
import {readFileSync,writeFileSync,existsSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {stripAuxImports} from './aux-ai-config.mjs';
import {paidEvaluationGate,evaluationBudgetPath,evaluationRequestHash} from './magi-eval-budget.mjs';
const root=new URL('../../',import.meta.url),read=p=>readFileSync(new URL(p,root),'utf8');
const dir=new URL('workers/.wrangler/auxiliary-haiku/',root),hash=s=>createHash('sha256').update(s).digest('hex');
const paths=['config/ai-models.json','workers/shared/anthropic.js','workers/games/anthropic.js','workers/games/src/index.js'];
const sourceHash=hash(paths.map(read).join('\n')),registry=JSON.parse(read(paths[0]));
const run=process.argv.includes('--run'),cap=.025,phase='auxiliary-haiku-games';
const planFile=new URL('games-plan.json',dir),resultFile=new URL('games-result.json',dir);
const captured=JSON.parse(readFileSync(new URL('browser.json',dir),'utf8'));
assert.equal(captured.results.length,7,'先に7画面のローカル確認を完了する');
const samples=captured.results.map(({game,ok})=>{
 assert(ok);const request=captured.requests.find(r=>r.game===game&&(game!=='kabuki-craft'||r.body.maxTokens===260));assert(request);
 return request;
});
const planned=[];
const ctx=vm.createContext({aiModels:registry,Request,Response,URL,Headers,AbortController,DOMException,TextDecoder,setTimeout,clearTimeout,
 fetch:async(url,options)=>{assert.equal(url,'https://api.anthropic.com/v1/messages');planned.push(JSON.parse(options.body));
  return Response.json({stop_reason:'end_turn',content:[{type:'text',text:'plan'}]});}});
vm.runInContext(paths.slice(1).map(p=>stripAuxImports(read(p)).replace('export default {','globalThis.worker = {')).join('\n'),ctx);
for(const sample of samples){
 const response=await ctx.worker.fetch(new Request('https://st-games-api.tk33r1.workers.dev'+sample.path,
  {method:'POST',headers:{Origin:'https://tk.st','Content-Type':'application/json'},body:JSON.stringify(sample.body)}),
  {GAME_AI_PROVIDER:'anthropic',GAME_ANTHROPIC_API_KEY:'plan-only'});
 assert.equal(response.status,200);
}
const estimates=planned.map(body=>{
 const input=Buffer.byteLength(JSON.stringify(body))*2+2048,output=body.max_tokens;
 assert(input<100000&&!body.tools);assert.equal(body.model,registry.anthropic.haiku.id);
 return {provider:'anthropic',model:body.model,max_usd:Math.ceil((input*.20+output*.50)*1.1)/1e6,pricing_checked_at:'2026-10-16',
  evaluation_batch:phase,basis:`Haiku overview 2026-10-16。UTF8 bytes×2+2048=${input} input ceiling (<100k), output<=${output}; 1h cache write USD .20/M, output .50/M, 10%余裕。Web・画像・再試行なし。https://platform.claude.com/docs/en/models/haiku-5-5/overview`};
});
const plan={version:1,phase,source_hash:sourceHash,runner_hash:hash(read('.github/scripts/eval-games-haiku.mjs')),hard_cap_usd:cap,max_usd:estimates.reduce((n,e)=>n+Math.ceil(e.max_usd*1e6),0)/1e6,
 requests:samples.map((s,i)=>({game:s.game,body:planned[i],request_hash:evaluationRequestHash('anthropic',planned[i]),estimate:estimates[i]}))};
assert(plan.max_usd<=cap);
if(!run){
 writeFileSync(planFile,JSON.stringify(plan,null,2)+'\n');console.log(JSON.stringify({mode:'plan',requests:plan.requests.length,max_usd:plan.max_usd,network_calls:0}));
}else{
 const gate=paidEvaluationGate();assert(!existsSync(resultFile),'結果の再実行・上書きをしない');
 assert.deepEqual(JSON.parse(readFileSync(planFile,'utf8')),plan,'計画後にコード・入力が変わった');
 const vars=existsSync(new URL('workers/magi2/.dev.vars',root))?read('workers/magi2/.dev.vars'):'';
 const key=process.env.ANTHROPIC_API_KEY||process.env.MAGI_ANTHROPIC_API_KEY||vars.match(/^\s*MAGI_ANTHROPIC_API_KEY\s*=\s*(.*?)\s*$/m)?.[1]?.replace(/^(['"])(.*)\1$/,'$2');
 assert(key,'Anthropic API key required');
 const report={phase,plan_hash:hash(JSON.stringify(plan)),complete:false,results:[]};
 writeFileSync(resultFile,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 const lock=evaluationBudgetPath+'.lock',fd=openSync(lock,'wx');
 try{
  const ledger=JSON.parse(readFileSync(evaluationBudgetPath,'utf8')),reserved=provider=>ledger.reservations.filter(r=>!provider||r.provider===provider).reduce((n,r)=>n+Math.ceil(r.max_usd*1e6),0)/1e6;
  assert(reserved()+plan.max_usd<=.80&&reserved('anthropic')+plan.max_usd<=.40);
  for(const item of plan.requests){const prior=ledger.estimates[item.request_hash];if(prior)assert.deepEqual(prior,item.estimate);else ledger.estimates[item.request_hash]=item.estimate;}
  writeFileSync(evaluationBudgetPath,JSON.stringify(ledger,null,2)+'\n');
 }finally{closeSync(fd);unlinkSync(lock);}
 ctx.fetch=fetch;
 for(const item of plan.requests){
  const row={game:item.game,...gate.reserve('anthropic',item.body),completed:false};report.results.push(row);
  const save=()=>writeFileSync(resultFile,JSON.stringify(report,null,2)+'\n');save();
  const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),30000),started=Date.now();
  try{
   const data=await ctx.postAnthropicJSON(key,item.body,ac.signal);row.reply=data;row.text=ctx.anthropicText(data,true);row.completed=true;
  }catch(e){row.error=e.name+': '+e.message;}
  finally{clearTimeout(timer);row.ms=Date.now()-started;save();}
 }
 report.complete=true;writeFileSync(resultFile,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({complete:true,calls:report.results.length,max_usd:plan.max_usd}));
}
