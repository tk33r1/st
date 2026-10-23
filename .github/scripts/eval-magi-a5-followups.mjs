// A5の代表2相談・各3問だけ。--plan/--checkは無通信、--runは共通予算と段階上限で既定拒否。
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,mkdirSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {webcrypto,createHash} from 'node:crypto';
import vm from 'node:vm';
import {paidEvaluationGate,evaluationBudgetPath,evaluationRequestHash} from './magi-eval-budget.mjs';
const read=p=>readFileSync(new URL('../../'+p,import.meta.url),'utf8'),hash=s=>createHash('sha256').update(s).digest('hex');
const dir=new URL('../../workers/.wrangler/magi2-dialogue-a5/',import.meta.url);mkdirSync(dir,{recursive:true});
const mode=process.argv.includes('--run')?'run':process.argv.includes('--check')?'check':'plan';
const full=process.argv.includes('--full');
assert(!(full&&mode==='run'),'全件は計画・模擬確認だけ。有料送信は入力と新しい費用上限の確認後に有効化する');
const repair=process.argv.includes('--repair');
assert(!(full&&repair),'全件と旧2相談の修正確認は分ける');
const phase='a5-followups',hardCap=.18,budget=mode==='run'?paidEvaluationGate():null;
let cases=[{id:'pdf',locale:'ja',expected:'/tools/pdf-studio/',questions:['PDFを結合したい。サイトのツールを案内してください。','それの使い方を教えてください。','画像にすることもできますか。']},
 {id:'qr',locale:'en',expected:'/tools/qr-palette/',questions:['Show me the tool on this site for creating a QR code.','How do I use that tool?','Can I change its colors and then save it?']}];
if(full){
 const fixture=JSON.parse(read('.github/scripts/fixtures/magi-dialogue-a5-full-20261017.json'));
 const malice=JSON.parse(read('.github/scripts/fixtures/magi-dialogue-a1-final.json')).cases;
 cases=fixture.cases.concat(fixture.malice_source_ids.flatMap(id=>{
  const c=malice.find(c=>c.id===id);assert(c);
  return [{id:id+'-initial',locale:'ja',expected:null,questions:[c.text],malice_at:1,malice:c.expected},
   {id:id+'-followup',locale:'ja',expected:'/tools/pdf-studio/',questions:['PDFを結合したい',c.text],malice_at:2,malice:c.expected}];
 }));
}
const original=repair?JSON.parse(read('workers/.wrangler/magi2-dialogue-a5/quality-result.json')):null;
if(repair){assert(original.complete&&original.results.length===6);cases=cases.map(c=>{const first=original.results.find(r=>r.id===c.id&&r.turn===1);return {...c,questions:c.questions.slice(1),initial_history:[{role:'user',content:c.questions[0]},{role:'assistant',content:first.response.comment,pages:first.response.results.map(p=>({title:p.title,url:p.url}))}],initial_language:first.response.reply_language};});}
const modules=['languages.js','personas.js','version-history.js','versions.js','classification.js','research.js','magi-mode.js','site-search.js','search-scope.js','site-rank.js','probe.js','speech.js','src/index.js'];
const sources=modules.map(p=>read('workers/magi2/'+p)),cards=JSON.parse(read('data/magi-context.json')),registry=JSON.parse(read('config/ai-models.json')),versions=JSON.parse(read('data/magi-versions.json'));
const strip=s=>s.replace(/^import .*;\r?\n/gm,'').replace(/export const /g,'const ').replace(/export (?=(?:async )?function)/g,'');
const code=sources.map(strip).join('\n').replace('export default {','globalThis.worker = {');
const snapshot={...(repair?{original_result_hash:hash(JSON.stringify(original))}:{}),runner_hash:hash(read('.github/scripts/eval-magi-a5-followups.mjs')),worker_hash:hash(sources.join('\n')),cards_hash:hash(JSON.stringify(cards)),models_hash:hash(JSON.stringify(registry)),index_hash:hash(read('_site/data/site-search.json'))};
let keys={},guardStopped=false,report={version:1,phase,hard_cap_usd:hardCap,...snapshot,cases,complete:false,results:[]},planned=[];
const planFile=new URL(full?'quality-full-plan-20261017.json':repair?'quality-repair-plan.json':'quality-plan.json',dir),resultFile=new URL(repair?'quality-repair-result.json':'quality-result.json',dir);
const save=()=>writeFileSync(resultFile,JSON.stringify(report,null,2)+'\n');
if(mode==='run'){
 assert(!existsSync(resultFile),'完了・中断結果を上書きしない');
 const old=JSON.parse(readFileSync(planFile,'utf8'));for(const k of Object.keys(snapshot))assert.equal(old[k],snapshot[k],'計画後に入力またはコードが変更された');
 assert.equal(JSON.stringify(old.cases),JSON.stringify(cases));
 assert.equal(old.hard_cap_usd,hardCap);
 const ledger=JSON.parse(readFileSync(evaluationBudgetPath,'utf8')),spent=p=>ledger.reservations.filter(r=>!p||r.provider===p).reduce((n,r)=>n+Math.ceil(r.max_usd*1e6),0)/1e6;
 const phaseSpent=ledger.reservations.filter(r=>ledger.estimates[r.request_hash]?.evaluation_batch===phase).reduce((n,r)=>n+Math.ceil(r.max_usd*1e6),0)/1e6;const remaining=Math.max(0,hardCap-phaseSpent);
 assert(spent()+remaining<=.80);for(const p of ['openai','anthropic'])assert(spent(p)+remaining<=.40);
 const runLock=new URL('quality-run.lock',dir),handle=openSync(runLock,'wx');
 process.once('exit',()=>{closeSync(handle);unlinkSync(runLock);});
 const vars=read('workers/magi2/.dev.vars');for(const name of ['MAGI_OPENAI_API_KEY','MAGI_ANTHROPIC_API_KEY','MAGI_TYPESAFE_API_KEY']){keys[name]=process.env[name]||vars.match(new RegExp('^\\s*'+name+'\\s*=\\s*(.*?)\\s*$','m'))?.[1]?.replace(/^(['"])(.*)\1$/,'$2');assert(keys[name],name+' required');}
 writeFileSync(resultFile,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
}
const estimate=(provider,body)=>{
 const bytes=Buffer.byteLength(JSON.stringify(body)),input=bytes*2+2048,output=body.max_tokens||body.max_completion_tokens||0;
 assert(input<100000 && !body.tools,'上限の分からない要求は送らない');
 const rates={openai:[.25,.75],anthropic:[.20,.50],typesafe:[.042,0]}[provider];assert(rates);
 assert.equal(body.model,{openai:registry.openai.luna.id,anthropic:registry.anthropic.haiku.id,typesafe:registry.typesafe.jev.id}[provider]);
 return {provider,model:body.model,max_usd:Math.ceil((input*rates[0]+output*rates[1])*1.1)/1e6,pricing_checked_at:'2026-10-15',
  basis:`既存の2026-10-15料金根拠（OpenAI pricing / Haiku overview / .github/JEV.md）。UTF8 ${bytes} bytes*2+2048 input ceiling, ${output} output ceiling, 10%余裕。Webなし、Standard。`,evaluation_batch:phase};
};
function reserve(provider,body,e){let lock;try{
 lock=openSync(evaluationBudgetPath+'.lock','wx');const ledger=JSON.parse(readFileSync(evaluationBudgetPath,'utf8'));
 const spent=ledger.reservations.filter(r=>ledger.estimates[r.request_hash]?.evaluation_batch===phase).reduce((n,r)=>n+Math.ceil(r.max_usd*1e6),0)/1e6;
 assert(Math.round((spent+e.max_usd)*1e6)<=Math.round(hardCap*1e6),'A5の段階上限に達した');
 const h=evaluationRequestHash(provider,body);assert(!ledger.reservations.some(r=>r.request_hash===h),'同じ要求を再送しない');ledger.estimates[h]=e;writeFileSync(evaluationBudgetPath,JSON.stringify(ledger,null,2)+'\n');
 }finally{if(lock!==undefined){closeSync(lock);unlinkSync(evaluationBudgetPath+'.lock');}}
 return budget.reserve(provider,body);
}
for(const sample of cases){
 let row;
 const ctx=vm.createContext({aiModels:registry,bundledContext:cards,bundledVersions:versions,Request,Response,ReadableStream,TextEncoder,TextDecoder,AbortController,URL,crypto:webcrypto,setTimeout,clearTimeout,setInterval,clearInterval,console:{log(){}},
  async fetch(url,options){
   if(guardStopped)throw new Error('evaluation_guard_stopped');
   if(String(url)==='https://tk.st/data/magi-context.json')return Response.json(cards);
   if(String(url)==='https://tk.st/data/site-search.json')return new Response(read('_site/data/site-search.json'));
   if(/^https:\/\/tk\.st\/data\/(tools|game|glitch)\.json$/.test(url))return new Response(read('data/'+String(url).split('/').at(-1)));
   const provider=String(url).startsWith('https://api.openai.com/')?'openai':String(url)==='https://api.typesafe.ai/v1/systemone'?'typesafe':String(url)==='https://api.anthropic.com/v1/messages'?'anthropic':null;
   assert(provider && options?.body,'計画外の送信先');const body=JSON.parse(options.body);
   if(repair && !body.stream && provider==='openai'){
    const prior=original.results.find(r=>r.id===sample.id&&r.turn===row.turn),pages=await ctx.getSitePages({waitUntil(){}},sample.locale,new AbortController().signal);
    const selected=prior.response.results.map(old=>{const p=pages.find(p=>p.url===old.url);assert(p);return p.id;});
    row.replayed_selection=selected;return Response.json({choices:[{message:{content:JSON.stringify({selections:selected})},finish_reason:'stop'}]});
   }
   if(provider==='openai')body.service_tier='default';const e=estimate(provider,body);
   if(mode!=='run'){
    planned.push({case:sample.id,turn:row.turn,provider,model:body.model,max_usd:e.max_usd});
    if(provider==='typesafe')return Response.json({answers:Object.fromEntries(Object.keys(body.questions).map(k=>[k,{choice:k==='language'?sample.locale:k==='malice'&&row.malice?sample.malice:'none',confidence:.99}]))});
    if(!body.stream){const pages=await ctx.getSitePages({waitUntil(){}},sample.locale,new AbortController().signal);const page=pages.find(p=>p.url===sample.expected);assert(page||sample.expected===null);return Response.json({choices:[{message:{content:JSON.stringify({selections:page?[page.id]:[]})},finish_reason:'stop'}]});}
    return new Response('data: '+JSON.stringify({choices:[{delta:{content:'😀'.repeat(2000)},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
   }
   let reservation;
   try {reservation=reserve(provider,body,e);} catch(err) {guardStopped=true;row.guard_error=String(err.message);save();throw err;}
   const call={provider,...reservation,status:null};row.calls.push(call);save();
   const response=await fetch(url,{...options,body:JSON.stringify(body)});call.status=response.status;save();return response;
  }});
 vm.runInContext(code,ctx);
 const env={...Object.fromEntries(['MAGI_OPENAI_API_KEY','MAGI_ANTHROPIC_API_KEY','MAGI_TYPESAFE_API_KEY'].map(k=>[k,keys[k]||'dry'])),SITE_SEARCH_ENABLED:'true',DB:{prepare(){return {bind(){return {async first(){return {count:1};}};}};}}};
 if(repair)env.MAGI_TYPESAFE_API_KEY='';
 let history=sample.initial_history||[],language=sample.initial_language||null;
 for(const [i,query] of sample.questions.entries()){
  row={id:sample.id,turn:i+1+(repair?1:0),...(full?{malice:sample.malice_at===i+1}:{}),calls:[],response:null};if(mode==='run'){report.results.push(row);save();}
  const body={query,locale:sample.locale,history,...(language?{reply_language:language}:{})},waits=[];
  const response=await ctx.worker.fetch(new Request('https://workers.tk.st/magi2/site-search?site_debate=1&site_chat=1',{method:'POST',headers:{Origin:'https://tk.st','Content-Type':'application/json'},body:JSON.stringify(body)}),env,{waitUntil(p){waits.push(p);}});
  const result=await response.json();await Promise.allSettled(waits);row.status=response.status;row.response=result;if(mode==='run')save();
  assert.equal(response.status,200);assert.equal(result.closed,!!row.malice);assert(result.comment&&result.reply_language);
  language=result.reply_language;history=history.concat([{role:'user',content:query},{role:'assistant',content:Array.from(result.comment).slice(0,2000).join(''),pages:result.results.map(p=>({title:p.title,url:p.url}))}]).slice(-6);
  console.log(JSON.stringify({mode,id:sample.id,turn:row.turn,status:response.status,calls:row.calls.length}));
 }
}
if(mode==='run'){report.complete=true;save();}else{
 const plan={version:1,phase,...snapshot,cases,hard_cap_usd:full?null:hardCap,mock_primary_reservation_usd:planned.reduce((n,r)=>n+r.max_usd,0),requests:planned,network_calls:0,limitations:full?'通常10相談30回答・悪意5入力10配置の模擬確認と一次経路の費用概算だけ。実モデルの品質は未評価。切替・再試行を含む全費用の上限ではなく、有料実行は明示的に停止している。':'2相談・続き4件。独立20件の品質合格にはしない。実際の要求ごとに累計・会社別・段階上限を予約し、未計画のWeb・外部送信は拒否。失敗・再試行でも予約は戻さない。'};
 if(mode==='plan'){assert(!existsSync(planFile),'既存計画を上書きしない');writeFileSync(planFile,JSON.stringify(plan,null,2)+'\n');}console.log(JSON.stringify(plan));
}
