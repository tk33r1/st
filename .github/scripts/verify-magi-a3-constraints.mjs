// 受付・読書会の制約を検算し、保存済み討議と判定から本番の統合だけを再生する。
// --plan/--checkは通信なし。--runは共通台帳を使い、前回4件と合わせた$0.069135以内。
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {createHash,webcrypto} from 'node:crypto';
import vm from 'node:vm';
import {extractDebate} from './prepare-magi-a3-review.mjs';
import {paidEvaluationGate,evaluationBudgetPath,evaluationRequestHash} from './magi-eval-budget.mjs';

const root=new URL('../../',import.meta.url), read=p=>readFileSync(new URL(p,root),'utf8');
const dir=new URL('workers/.wrangler/magi2-dialogue-a3/',root);
const hash=s=>createHash('sha256').update(s).digest('hex');
const save=(p,v)=>writeFileSync(p,JSON.stringify(v,null,2)+'\n');
const mode=process.argv.includes('--run')?'run':process.argv.includes('--plan')?'plan':'check';
const budget=mode==='run'?paidEvaluationGate():null; // 鍵より先に既定拒否。
const previousText=read('workers/.wrangler/magi2-dialogue-a3/judge-result.json');
const previous=JSON.parse(previousText), rawText=read('workers/.wrangler/magi2-dialogue-a3/collection-result.json');
const raw=JSON.parse(rawText);
const cases=['collect-01','collect-03'].map(id=>{
  const row=raw.results.find(r=>r.id===id), judgement=previous.results.find(r=>r.id===id)?.decision;
  assert(row?.completed&&judgement?.next_step==='answer');
  return {id,input:row.input,debate:extractDebate(row),judgement};
});

// 受付中は「待ち列」に含めない。到着と同時の完了は先に反映する。
function queue(arrivals, seconds) {
  const finishes=[];let lastFinish=0,maxWaiting=0,maxWait=0;
  for(const at of [...arrivals].sort((a,b)=>a-b)) {
    const start=Math.max(at,lastFinish), active=finishes.filter(t=>t>at).length;
    maxWaiting=Math.max(maxWaiting,Math.max(0,active));
    maxWait=Math.max(maxWait,start-at);lastFinish=start+seconds;finishes.push(lastFinish);
  }
  return {max_waiting:maxWaiting,max_wait_seconds:maxWait,last_finish_seconds:lastFinish};
}
const burst=queue(Array(60).fill(0),20), uniform=queue(Array.from({length:60},(_,i)=>i*10),20);
assert.deepEqual(burst,{max_waiting:59,max_wait_seconds:1180,last_finish_seconds:1200});
assert.deepEqual(uniform,{max_waiting:30,max_wait_seconds:590,last_finish_seconds:1200});
const oracle={reception:{capacity_per_10_min:600/20,total_service_seconds:60*20,burst,uniform,
  conclusion:'最大30人待ちは到着分布を仮定しないと成立しない。受付1人の能力は列を分けても増えない。'},
  reading:{original_minutes:45+5+45,limit_minutes:90,overflow_minutes:45+5+45-90,
    feasible_example:[{from:0,to:40,participants:6,host:1},{from:40,to:45,participants:0,host:1},{from:45,to:85,participants:6,host:1},{from:85,to:90,participants:0,host:1}],
    sharing:'全12人の事前感想を全員へ配布する場合のみ、分かれた組の感想も共有できる。二部制だけでは届かない。'}};
assert(oracle.reading.feasible_example.every(s=>s.participants+s.host<=8));
assert.equal(oracle.reading.feasible_example.at(-1).to,90);
const files=['languages.js','personas.js','classification.js','research.js','magi-mode.js','site-search.js','search-scope.js','site-rank.js','src/index.js'];
const sources=files.map(p=>read('workers/magi2/'+p)),cards=JSON.parse(read('data/magi-context.json')),registry=JSON.parse(read('config/ai-models.json'));
const strip=s=>s.replace(/^import .*;\r?\n/gm,'').replace(/export const /g,'const ').replace(/export (?=(?:async )?function)/g,'');
const code=sources.map(strip).join('\n').replace('export default {','globalThis.worker = {');
const rates={anthropic:{input:.20,output:.50,source:'https://platform.claude.com/docs/en/models/haiku-5-5/overview'},openai:{input:.25,output:.75,source:'https://developers.openai.com/api/docs/pricing'}};
const estimate=(provider,body)=>{
  const bytes=Buffer.byteLength(JSON.stringify(body)),input=bytes*2+2048,output=body.max_tokens||body.max_completion_tokens;
  assert(bytes<=40000&&input<100000&&body.stream&&!body.tools);
  assert.equal(body.reasoning_effort||body.output_config?.effort,'medium');
  assert.equal(output,provider==='anthropic'?8192:4096);
  return {provider,model:body.model,max_usd:Math.ceil((input*rates[provider].input+output*rates[provider].output)*1.1)/1e6,
    pricing_checked_at:'2026-10-15',input_ceiling:input,output_ceiling:output,
    basis:`${rates[provider].source}; Standard・cache write側の高い単価; UTF8 ${bytes} bytes*2+2048 input ceiling; output<=${output}; 10%余裕。`};
};
const hardCap=.069135;
const previousHashes=new Set(previous.results.flatMap(r=>r.calls.map(c=>c.request_hash)));
function phaseSpend(ledger) {
  const first=ledger.reservations.filter(r=>previousHashes.has(r.request_hash));assert.equal(first.length,4);
  const at=Math.min(...first.map(r=>Date.parse(r.at)));assert(Number.isFinite(at));
  assert(ledger.reservations.every(r=>Number.isFinite(Date.parse(r.at))));
  // 他の評価が後から走っていても上限の残額を大きく見積もらない。
  return ledger.reservations.filter(r=>Date.parse(r.at)>=at).reduce((n,r)=>n+Math.ceil(r.max_usd*1e6),0)/1e6;
}
const planFile=new URL('constraints-plan.json',dir),resultFile=new URL('constraints-result.json',dir);
const event=(v)=>'data: '+JSON.stringify(v)+'\n\n';
const mock=(provider)=>new Response(provider==='anthropic'
  ? event({type:'content_block_delta',delta:{type:'text_delta',text:'模擬の回答'}})+event({type:'message_delta',delta:{stop_reason:'end_turn'}})+event({type:'message_stop'})
  : event({choices:[{delta:{content:'模擬の回答'},finish_reason:'stop'}]})+'data: [DONE]\n\n');
let report=null,keys=null;
async function replay(sample,theme,planned=null) {
  const row={id:sample.id,theme,requests:[],calls:[],events:[],answer:null,error:null,complete:false}, observations=[];
  if(report){report.results.push(row);save(resultFile,report);}
  const ctx=vm.createContext({aiModels:registry,bundledContext:cards,Request,Response,ReadableStream,TextEncoder,TextDecoder,AbortController,URL,
    crypto:webcrypto,setTimeout,clearTimeout,setInterval,clearInterval,console:{log(){}},
    fetch:async(url,options)=>{
      const provider=url==='https://api.anthropic.com/v1/messages'?'anthropic':url==='https://api.openai.com/v1/chat/completions'?'openai':null;
      assert(provider,'承認済みの2社以外へ送らない');
      const body=JSON.parse(options.body);if(provider==='openai')body.service_tier='default';
      const request_hash=evaluationRequestHash(provider,body),e=estimate(provider,body);
      assert.equal(provider,theme==='dark'?'anthropic':'openai');
      assert.equal(row.requests.length,0,'確認は各テーマ1回。切替や再試行は課金しない');
      row.requests.push({provider,body,request_hash,estimate:e});
      if(!planned)return mock(provider);
      assert.equal(request_hash,planned.requests[0].request_hash,'計画と違う要求は送らない');
      const ledger=JSON.parse(readFileSync(evaluationBudgetPath,'utf8'));
      assert(Math.round((phaseSpend(ledger)+e.max_usd)*1e6)<=Math.round(hardCap*1e6),'前回4件との合計上限に達した');
      const reservation=budget.reserve(provider,body),call={provider,request_hash,reservation,status:null,usage:null,finish:null};
      row.calls.push(call);save(resultFile,report);
      const response=await fetch(url,{...options,body:JSON.stringify(body)});call.status=response.status;save(resultFile,report);return response;
    }});
  vm.runInContext(code,ctx);
  ctx.fetchPersonaText=async(_env,p,_messages,_signal,_log,round)=>sample.debate.find(d=>d.codename===p.codename).views.find(v=>v.round===round).text;
  ctx.fetchJudgement=async()=>sample.judgement;
  const env=keys?{...keys}:{MAGI_ANTHROPIC_API_KEY:'mock',MAGI_OPENAI_API_KEY:'mock'};
  env.evalObserve=(provider,_model,response,stream)=>{
    assert(stream);const observation=(async()=>{
      const text=await response.text();
      for(const frame of text.split('\n\n'))for(const line of frame.split('\n')){
        if(!line.startsWith('data:')||line.slice(5).trim()==='[DONE]')continue;
        let v;try{v=JSON.parse(line.slice(5));}catch{continue;}
        const call=row.calls[0];if(!call)continue;
        if(v.type==='message_start')call.usage={...v.message.usage};
        if(v.type==='message_delta'){call.usage={...call.usage,...v.usage};call.finish=v.delta?.stop_reason||call.finish;}
        if(v.usage&&v.choices)call.usage=v.usage;
        if(v.choices?.[0]?.finish_reason)call.finish=v.choices[0].finish_reason;
      }
    })().catch(()=>{});observations.push(observation);
  };
  const started=performance.now();
  try{
    row.answer=await ctx.runDiscussion({upstream:env,cards:ctx.cardsFrom(cards),plainMessages:[{role:'user',content:sample.input}],
      langNote:ctx.languageNote({code:'ja'}),theme,adaptive:true,shortDebate:false,newContract:true,signal:new AbortController().signal,
      send:(name,data)=>row.events.push({name,data}),log(){}});
    row.complete=!!row.answer?.trim();
  }catch(e){row.error={name:e.name,message:e.envelope?.code||e.message};}
  await Promise.allSettled(observations);row.elapsed_ms=Math.round(performance.now()-started);
  if(report){row.requests=row.requests.map(({body,...request})=>request);save(resultFile,report);}
  assert(row.complete,'統合が完了しなかった。保存記録を確認する');
  return row;
}
const plannedRows=[];for(const sample of cases)for(const theme of ['light','dark'])plannedRows.push(await replay(sample,theme));
const maximum_usd={openai:0,anthropic:0,total:0};
for(const row of plannedRows)for(const r of row.requests){maximum_usd[r.provider]+=r.estimate.max_usd;maximum_usd.total+=r.estimate.max_usd;}
const plan={version:1,scope:'承認済み2件の保存討議・判定を再生し、ライトとダークの最終回答だけ各1回検査。人格・判定・分類・検索は課金しない。',
  worker_hash:hash(sources.join('\n')),cards_hash:hash(JSON.stringify(cards)),registry_hash:hash(JSON.stringify(registry)),script_hash:hash(read('.github/scripts/verify-magi-a3-constraints.mjs')),
  source_hash:hash(rawText),judge_hash:hash(previousText),oracle,hard_cap_including_previous_usd:hardCap,maximum_usd,cases:plannedRows.map(({id,theme,requests})=>({id,theme,requests}))};
if(mode==='plan'){
  if(existsSync(planFile))assert.equal(hash(readFileSync(planFile,'utf8')),hash(JSON.stringify(plan,null,2)+'\n'),'既存計画と異なる');
  else writeFileSync(planFile,JSON.stringify(plan,null,2)+'\n',{flag:'wx'});
}
if(mode==='run'){
  assert(!existsSync(resultFile),'既存の結果・中断結果を上書きしない');
  assert.equal(hash(readFileSync(planFile,'utf8')),hash(JSON.stringify(plan,null,2)+'\n'),'計画後に要求が変わっている');
  let lock;
  try{
    lock=openSync(evaluationBudgetPath+'.lock','wx');const ledger=JSON.parse(readFileSync(evaluationBudgetPath,'utf8'));
    assert(Math.round((phaseSpend(ledger)+maximum_usd.total)*1e6)<=Math.round(hardCap*1e6),'前回4件と合わせた上限を超える計画');
    const total=ledger.reservations.reduce((n,r)=>n+Math.ceil(r.max_usd*1e6),0)/1e6;
    assert(total+maximum_usd.total<=.80);
    for(const provider of ['openai','anthropic'])assert(ledger.reservations.filter(r=>r.provider===provider).reduce((n,r)=>n+Math.ceil(r.max_usd*1e6),0)/1e6+maximum_usd[provider]<=.40);
    for(const row of plannedRows)for(const r of row.requests){assert(!ledger.reservations.some(x=>x.request_hash===r.request_hash),'同じ要求は再送しない');ledger.estimates[r.request_hash]=r.estimate;}
    save(evaluationBudgetPath,ledger);
  }finally{if(lock!==undefined){closeSync(lock);unlinkSync(evaluationBudgetPath+'.lock');}}
  const vars=read('workers/magi2/.dev.vars');keys={};
  for(const name of ['MAGI_ANTHROPIC_API_KEY','MAGI_OPENAI_API_KEY']){
    keys[name]=process.env[name]||vars.match(new RegExp('^\\s*'+name+'\\s*=\\s*(.*?)\\s*$','m'))?.[1]?.replace(/^(['"])(.*)\1$/,'$2');assert(keys[name],name+' required');
  }
  report={version:1,date:new Date().toISOString(),scope:plan.scope,plan_hash:hash(JSON.stringify(plan)),worker_hash:plan.worker_hash,oracle,complete:false,results:[]};save(resultFile,report);
  for(const sample of cases)for(const theme of ['light','dark']){
    const row=await replay(sample,theme,plan.cases.find(r=>r.id===sample.id&&r.theme===theme));
    console.log(JSON.stringify({id:row.id,theme,complete:row.complete,calls:row.calls.length,elapsed_ms:row.elapsed_ms}));
  }
  report.complete=true;save(resultFile,report);
}
console.log(JSON.stringify({mode,oracle,maximum_usd,network_calls:report?report.results.reduce((n,r)=>n+r.calls.length,0):0}));
