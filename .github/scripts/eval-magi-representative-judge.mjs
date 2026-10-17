// 保存討議2件を、A3前のLuna lowと現行Haiku mediumで比較。人格・統合・検索は生成しない。
import {readFileSync,writeFileSync,mkdirSync,existsSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash,webcrypto} from 'node:crypto';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {extractDebate} from './prepare-magi-a3-review.mjs';
import {paidEvaluationGate,evaluationBudgetPath,evaluationRequestHash,evaluationBudgetCaps} from './magi-eval-budget.mjs';
const root=new URL('../../',import.meta.url),read=p=>readFileSync(new URL(p,root),'utf8'),hash=s=>createHash('sha256').update(s).digest('hex');
const dir=new URL('workers/.wrangler/magi2-compact-20261017/',root);mkdirSync(dir,{recursive:true});
const mode=process.argv.includes('--run')?'run':'plan',oldRef='cb450a06';
const collection=JSON.parse(read('workers/.wrangler/magi2-dialogue-a3/collection-result.json'));
const tune=JSON.parse(read('workers/.wrangler/magi2-dialogue-a3/tune-review.json'));
const one=collection.results.find(r=>r.id==='collect-01'),two=tune.cases.find(r=>r.id==='tune-21');assert(one&&two);
const samples=[{id:one.id,input:one.input,debate:extractDebate(one),rubric:'受付能力は30人/10分、来場60人。見守り係の兼務は禁止。処理時間20秒、10分集中、追加予算なしを同時に守って比較する。'},
 {id:two.id,input:two.input,debate:two.debate,rubric:'期限と重要度・裁量・休み方など本人にしか分からない条件を確認。旧判定にask_userがないことだけを新方式の勝ちにしない。'}];
const registry=JSON.parse(read('config/ai-models.json')),cards=JSON.parse(read('data/magi-context.json'));
const modules=['languages.js','personas.js','classification.js','research.js','magi-mode.js','site-search.js','search-scope.js','site-rank.js','src/index.js'];
const strip=s=>s.replace(/^import .*;\r?\n/gm,'').replace(/export const /g,'const ').replace(/export (?=(?:async )?function)/g,'');
let capture=null,current=null,gate=null,keys={},report=null;
const sourceSets={};
function context(old){
 const sources=modules.map(p=>old&&['personas.js','src/index.js'].includes(p)?execFileSync('git',['show',oldRef+':workers/magi2/'+p],{cwd:root,encoding:'utf8',maxBuffer:4*1024*1024}):read('workers/magi2/'+p));
 sourceSets[old?'old':'current']=hash(sources.join('\n'));
 const ctx=vm.createContext({aiModels:registry,bundledContext:cards,Request,Response,ReadableStream,TextEncoder,TextDecoder,AbortController,URL,crypto:webcrypto,setTimeout,clearTimeout,setInterval,clearInterval,console:{log(){}},
  fetch:async(url,options)=>{
   const provider=String(url).includes('anthropic')?'anthropic':'openai',body=JSON.parse(options.body);if(provider==='openai')body.service_tier='default';
   const request_hash=evaluationRequestHash(provider,body);
   if(capture){capture.requests.push({provider,body,request_hash});if(capture.fallback&&provider==='anthropic')return new Response('mock',{status:503});
    const v=old?{action:'answer',assessment:'模擬',questions:[]}:{next_step:'answer',assessment:'模擬',persona_questions:[],questions:[]};
    return Response.json(provider==='anthropic'?{content:[{type:'text',text:JSON.stringify(v)}],stop_reason:'end_turn'}:{choices:[{message:{content:JSON.stringify(v)},finish_reason:'stop'}]});}
   const request=current.requests.find(r=>r.request_hash===request_hash);assert(request,'固定計画と異なる要求');
   assert(current.calls.length<(old?1:2));assert(!current.calls.some(c=>c.provider===provider));
   const call={provider,request_hash,reservation:gate.reserve(provider,body),status:null};current.calls.push(call);save();
   const start=Date.now(),res=await fetch(url,{...options,body:JSON.stringify(body)});call.status=res.status;call.elapsed_ms=Date.now()-start;
   if(res.ok){const data=await res.clone().json();call.usage=data.usage;call.finish=data.stop_reason||data.choices?.[0]?.finish_reason;}
   save();return res;
  }});
 vm.runInContext(sources.map(strip).join('\n').replace('export default {','globalThis.worker = {'),ctx);
 ctx.makeInput=sample=>{ctx.sample=sample;return vm.runInContext(`({system:withLangNote(withCard({...SYNTHESIZER,system_prompt:DEBATE.system_prompt(2,5,${!old})},cardsFrom(bundledContext),PERSONA_CONTEXT.synth_header).system_prompt${old?'':"+'\\n\\n'+DEBATE.constraint_rules"},languageNote({code:'ja'})),input:judgeInput([{role:'user',content:sample.input}],null,sample.debate,languageNote({code:'ja'})),active:sample.debate.map(d=>d.codename),allowUser:true})`,ctx);};
 return ctx;
}
const contexts={old:context(true),current:context(false)},cases=[];
for(const sample of samples)for(const variant of ['current','old']){
 const ctx=contexts[variant],input=ctx.makeInput(sample);capture={requests:[],fallback:variant==='current'};
 await ctx.withTimeout(20000,s=>ctx.fetchJudgement({MAGI_OPENAI_API_KEY:'dry',MAGI_ANTHROPIC_API_KEY:'dry'},input,s,()=>{}));
 const requests=capture.requests;capture=null;assert.equal(requests.length,variant==='old'?1:2);
 for(const r of requests){const bytes=Buffer.byteLength(JSON.stringify(r.body)),tokens=bytes*2+2048,out=r.body.max_tokens||r.body.max_completion_tokens;
  assert(bytes<=40000&&!r.body.tools&&!r.body.stream&&tokens<100000);
  r.estimate={provider:r.provider,model:r.body.model,max_usd:Math.ceil((tokens*.125+out*.50)*1.1)/1e6,pricing_checked_at:'2026-10-17',
   basis:`公式料金を同日に確認。入力${tokens} tokens未満・cache write側$0.125/M、出力<=${out}・$0.50/M、10%余裕。保存討議だけ、Webなし。`,evaluation_batch:'compact-20261017'};
 }
 cases.push({id:sample.id,variant,input,requests,rubric:sample.rubric});
}
const plan={version:1,scope:'追加$2の代表案、保存討議2件の判定比較だけ。独立20件の合格や本人の盲検採点にはしない。',old_ref:oldRef,sourceSets,script_hash:hash(read('.github/scripts/eval-magi-representative-judge.mjs')),cards_hash:hash(JSON.stringify(cards)),models_hash:hash(JSON.stringify(registry)),cases};
const total=cases.flatMap(c=>c.requests).reduce((s,r)=>s+r.estimate.max_usd,0);assert(total<=.10);
const planFile=new URL('judge-plan.json',dir),resultFile=new URL('judge-result.json',dir);
const checkPlan=()=>assert.equal(hash(JSON.stringify(JSON.parse(readFileSync(planFile)))),hash(JSON.stringify(plan)),'保存計画の内容が変わったため送信しない');
if(mode==='plan'){if(existsSync(planFile))checkPlan();else writeFileSync(planFile,JSON.stringify(plan,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({mode,comparisons:2,maximum_calls:6,maximum_usd:total,network_calls:0}));process.exit(0);}
gate=paidEvaluationGate();assert(!existsSync(resultFile),'既存結果を上書きしない');checkPlan();
const handle=openSync(evaluationBudgetPath+'.lock','wx');try{const ledger=JSON.parse(readFileSync(evaluationBudgetPath));
 for(const p of ['openai','anthropic']){const spent=ledger.reservations.filter(r=>r.provider===p).reduce((n,r)=>n+Math.ceil(r.max_usd*1e6),0)/1e6;assert(spent+cases.flatMap(c=>c.requests).filter(r=>r.provider===p).reduce((n,r)=>n+r.estimate.max_usd,0)<=evaluationBudgetCaps[p]);}
 const spent=ledger.reservations.reduce((n,r)=>n+Math.ceil(r.max_usd*1e6),0)/1e6;assert(spent+total<=evaluationBudgetCaps.total);
 for(const c of cases)for(const r of c.requests)ledger.estimates[r.request_hash]=r.estimate;
 writeFileSync(evaluationBudgetPath,JSON.stringify(ledger,null,2)+'\n');
}finally{closeSync(handle);unlinkSync(evaluationBudgetPath+'.lock');}
const vars=read('workers/magi2/.dev.vars');for(const name of ['MAGI_OPENAI_API_KEY','MAGI_ANTHROPIC_API_KEY']){keys[name]=process.env[name]||vars.match(new RegExp('^\\s*'+name+'\\s*=\\s*(.*?)\\s*$','m'))?.[1]?.replace(/^(['"])(.*)\1$/,'$2');assert(keys[name]);}
report={version:1,date:new Date().toISOString(),plan_hash:hash(JSON.stringify(plan)),complete:false,results:[]};
function save(){if(report)writeFileSync(resultFile,JSON.stringify(report,null,2)+'\n');}
writeFileSync(resultFile,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
const prior=JSON.parse(read('workers/.wrangler/magi2-dialogue-a3/release-v2-judge-result.json'));
for(const c of cases){current={id:c.id,variant:c.variant,requests:c.requests,calls:[],decision:null};report.results.push(current);save();
 const reuse=c.variant==='current'&&prior.complete&&prior.results.find(r=>r.id===c.id&&r.decision&&r.calls.some(x=>x.request_hash===c.requests[0].request_hash));
 if(reuse){current.decision=reuse.decision;current.reused_from='release-v2-judge-result.json';save();continue;}
 const start=Date.now();current.decision=await contexts[c.variant].withTimeout(20000,s=>contexts[c.variant].fetchJudgement(keys,c.input,s,()=>{}));current.elapsed_ms=Date.now()-start;save();
 assert(current.decision,'判定が完了していない');
 console.log(JSON.stringify({id:c.id,variant:c.variant,completed:true,calls:current.calls.length}));
}
report.complete=true;save();
console.log(JSON.stringify({complete:true,comparisons:2,new_calls:report.results.reduce((n,r)=>n+r.calls.length,0),reused:report.results.filter(r=>r.reused_from).length}));
