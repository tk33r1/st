// 保存済み討議で判定だけを確認する。人格の再生成・統合・Jev・検索は呼ばない。
// --plan / --checkは通信なし。--runは固定の共通予算台帳と完全一致する計画が必須。
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {createHash,webcrypto} from 'node:crypto';
import vm from 'node:vm';
import {extractDebate} from './prepare-magi-a3-review.mjs';
import {paidEvaluationGate,evaluationBudgetPath,evaluationRequestHash} from './magi-eval-budget.mjs';
const root = new URL('../../',import.meta.url), read = p => readFileSync(new URL(p,root),'utf8');
const dir = new URL('workers/.wrangler/magi2-dialogue-a3/',root);
const hash = s => createHash('sha256').update(s).digest('hex');
const save = (file,v) => writeFileSync(file,JSON.stringify(v,null,2)+'\n');
const mode = process.argv.includes('--run') ? 'run' : process.argv.includes('--plan') ? 'plan' : 'check';
let budget;
if (mode === 'run') budget = paidEvaluationGate(); // 鍵と本文を読む前に既定拒否を確認する。
const files = ['languages.js','personas.js','classification.js','research.js','magi-mode.js','site-search.js','search-scope.js','site-rank.js','src/index.js'];
const sources = files.map(p=>read('workers/magi2/'+p));
const registry = JSON.parse(read('config/ai-models.json')), cards = JSON.parse(read('data/magi-context.json'));
const raw = read('workers/.wrangler/magi2-dialogue-a3/collection-result.json');
const tune = read('workers/.wrangler/magi2-dialogue-a3/tune-review.json');
const cases = JSON.parse(raw).results.map(row=>({id:row.id,input:row.input,debate:extractDebate(row)}));
const userCase = JSON.parse(tune).cases.find(c=>c.id==='tune-21');
assert(userCase); cases.push({id:userCase.id,input:userCase.input,debate:userCase.debate});
assert.equal(cases.length,4);
const strip = s=>s.replace(/^import .*;\r?\n/gm,'').replace(/export const /g,'const ').replace(/export (?=(?:async )?function)/g,'');
let row = null, keys = mode === 'run' ? {} : {MAGI_OPENAI_API_KEY:'mock',MAGI_ANTHROPIC_API_KEY:'mock'}, report = null;
const hardCapUSD = .069135; // 送信許可で提示した追加上限。切替の残枠がなければ送信しない。
let reservedUSD = 0;
const planFile = new URL('judge-plan.json',dir), resultFile = new URL('judge-result.json',dir);
const realFetch = globalThis.fetch;
const rates = {anthropic:{input:.20,output:.50,source:'https://platform.claude.com/docs/en/models/haiku-5-5/overview'},
  openai:{input:.25,output:.75,source:'https://developers.openai.com/api/docs/pricing'}};
const estimate = (provider,body) => {
  const bytes=Buffer.byteLength(JSON.stringify(body)); assert(bytes<=40000,'判定要求は40,000バイト以内・テキストのみ');
  const input=bytes*2+2048,output=body.max_tokens||body.max_completion_tokens;
  assert(input<100000); assert.equal(output,4096); assert(!body.tools&&!body.stream);
  return {provider,model:body.model,max_usd:Math.ceil((input*rates[provider].input+output*rates[provider].output)*1.1)/1e6,
    input_ceiling:input,output_ceiling:output,pricing_checked_at:'2026-10-15',
    basis:`${rates[provider].source}; Standard・cache write側の高い単価; UTF8 ${bytes} bytes*2+2048 input ceiling; output<=${output}; 10%余裕。`};
};
const ctx = vm.createContext({aiModels:registry,bundledContext:cards,Request,Response,ReadableStream,TextEncoder,TextDecoder,
  AbortController,URL,crypto:webcrypto,setTimeout,clearTimeout,setInterval,clearInterval,console:{log(){}},
  fetch:async(url,options)=>{
    const provider = url==='https://api.anthropic.com/v1/messages' ? 'anthropic'
      : url==='https://api.openai.com/v1/chat/completions' ? 'openai' : null;
    assert(provider,'判定の2社以外へ送らない');
    const body=JSON.parse(options.body);
    if(provider==='openai')body.service_tier='default';
    const request_hash=evaluationRequestHash(provider,body);
    const request=row.requests.find(r=>r.request_hash===request_hash);assert(request,'計画と異なる要求は送らない');
    if(mode!=='run') {
      if(provider==='anthropic'&&process.argv.includes('--mock-fallback'))return new Response('mock failure',{status:503});
      const text=JSON.stringify({next_step:'answer',assessment:'模擬応答',persona_questions:[],questions:[]});
      return Response.json(provider==='anthropic' ? {content:[{type:'text',text}],stop_reason:'end_turn'}
        : {choices:[{message:{content:text},finish_reason:'stop'}]});
    }
    assert(row.calls.length<2,'1判定は2社まで'); assert(!row.calls.some(c=>c.provider===provider),'同じ会社を再試行しない');
    assert(Math.round((reservedUSD+request.estimate.max_usd)*1e6)<=Math.round(hardCapUSD*1e6),'追加上限に達したので切替を送信しない');
    const reservation=budget.reserve(provider,body),call={provider,request_hash,reservation,status:null,finish:null,usage:null};
    reservedUSD+=reservation.max_usd;
    row.calls.push(call);save(resultFile,report);
    const response=await realFetch(url,{...options,body:JSON.stringify(body)});call.status=response.status;
    if(response.ok){const data=await response.clone().json();call.usage=data.usage||null;call.finish=data.stop_reason||data.choices?.[0]?.finish_reason||null;}
    save(resultFile,report);return response;
  }});
vm.runInContext(sources.map(strip).join('\n').replace('export default {','globalThis.worker = {'),ctx);
const requests = cases.map(c=>{
  ctx.sample=c;
  const input=vm.runInContext(`({system:withLangNote(withCard({...SYNTHESIZER,system_prompt:DEBATE.system_prompt(2,5,true)},cardsFrom(bundledContext),PERSONA_CONTEXT.synth_header).system_prompt,languageNote({code:'ja'})),
    input:judgeInput([{role:'user',content:sample.input}],null,sample.debate,languageNote({code:'ja'})),active:sample.debate.map(d=>d.codename),allowUser:true})`,ctx);
  ctx.judgeSample=input;
  const bodies=vm.runInContext(`[DEFAULTS.models.judge,DEFAULTS.models.judge_fallback].map(cfg=>({provider:cfg.provider,body:requestBody(cfg,{stream:false,response_format:DEBATE.format,messages:[{role:'system',content:judgeSample.system},{role:'user',content:judgeSample.input}]})}))`,ctx);
  for(const r of bodies)if(r.provider==='openai')r.body.service_tier='default';
  return {id:c.id,input,requests:JSON.parse(JSON.stringify(bodies)).map(r=>({...r,request_hash:evaluationRequestHash(r.provider,r.body),estimate:estimate(r.provider,r.body)}))};
});
const maximum_usd={anthropic:0,openai:0,total:0};
for(const c of requests)for(const r of c.requests){maximum_usd[r.provider]+=r.estimate.max_usd;maximum_usd.total+=r.estimate.max_usd;}
const plan={version:1,scope:'保存済み3討議＋確認候補1件の技術確認。期待値は本人未採用で精度の合否には使わない。',
  worker_hash:hash(sources.join('\n')),cards_hash:hash(JSON.stringify(cards)),registry_hash:hash(JSON.stringify(registry)),
  script_hash:hash(read('.github/scripts/eval-magi-a3-judge.mjs')),source_hash:hash(raw),tune_hash:hash(tune),hard_cap_usd:hardCapUSD,maximum_usd,cases:requests};
if(mode==='plan'){
  if(existsSync(planFile))assert.equal(hash(JSON.stringify(JSON.parse(readFileSync(planFile,'utf8')))),hash(JSON.stringify(plan)),'既存計画と異なる');else writeFileSync(planFile,JSON.stringify(plan,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({mode,cases:cases.length,maximum_usd,network_calls:0}));process.exit(0);
}
if(mode==='run'){
  assert(!existsSync(resultFile),'完了・中断した記録を上書きしない');
  assert.equal(hash(JSON.stringify(JSON.parse(readFileSync(planFile,'utf8')))),hash(JSON.stringify(plan)),'計画後にコード・要求が変わっている');
  let lock;
  try{
    lock=openSync(evaluationBudgetPath+'.lock','wx');const ledger=JSON.parse(readFileSync(evaluationBudgetPath,'utf8'));
    const spent=p=>ledger.reservations.filter(r=>!p||r.provider===p).reduce((n,r)=>n+r.max_usd,0);
    assert(spent()+maximum_usd.total<=.80);for(const p of ['openai','anthropic'])assert(spent(p)+maximum_usd[p]<=.40);
    for(const c of requests)for(const r of c.requests){assert(!ledger.reservations.some(x=>x.request_hash===r.request_hash),'同じ要求は再送しない');ledger.estimates[r.request_hash]=r.estimate;}
    save(evaluationBudgetPath,ledger);
  }finally{if(lock!==undefined){closeSync(lock);unlinkSync(evaluationBudgetPath+'.lock');}}
  const vars=read('workers/magi2/.dev.vars');
  for(const name of ['MAGI_ANTHROPIC_API_KEY','MAGI_OPENAI_API_KEY']){
    keys[name]=process.env[name]||vars.match(new RegExp('^\\s*'+name+'\\s*=\\s*(.*?)\\s*$','m'))?.[1]?.replace(/^(['"])(.*)\1$/,'$2');assert(keys[name],name+' required');
  }
  report={version:1,date:new Date().toISOString(),scope:plan.scope,plan_hash:hash(JSON.stringify(plan)),worker_hash:plan.worker_hash,complete:false,results:[]};save(resultFile,report);
}
for(const c of requests){
  row={id:c.id,requests:c.requests.map(({body,...r})=>r),calls:[],decision:null,elapsed_ms:null};if(report)report.results.push(row);
  const start=performance.now();
  row.decision=await ctx.withTimeout(20000,signal=>ctx.fetchJudgement(keys,c.input,signal,()=>{}));row.elapsed_ms=Math.round(performance.now()-start);
  if(mode==='check')assert.equal(row.decision?.next_step,'answer','模擬要求の組立てが計画と一致しない');
  if(report)save(resultFile,report);
  console.log(JSON.stringify({mode,id:row.id,next_step:row.decision?.next_step||'failed',targets:row.decision?.persona_questions?.map(q=>q.target)||[],elapsed_ms:row.elapsed_ms,calls:row.calls.length}));
}
if(report){report.complete=true;save(resultFile,report);}
