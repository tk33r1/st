// 固定した合成ケースの本番費用枠を先に予約し、404の2会話だけを順番に実行する。
import {readFileSync,writeFileSync,existsSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {paidEvaluationGate,evaluationBudgetPath,evaluationRequestHash} from './magi-eval-budget.mjs';
const dir=new URL('../../workers/.wrangler/magi2-compact-20261017/',import.meta.url);
const read=name=>JSON.parse(readFileSync(new URL(name,dir),'utf8'));
const plan=read('plan.json'),planHash=createHash('sha256').update(JSON.stringify(plan)).digest('hex');
const gate=paidEvaluationGate(),group=process.argv.includes('--reserve-native')?'native':'site';
assert(plan.version===1 && Date.parse(plan.expires_at)>Date.now(),'期限切れの計画は実行しない');
const file=new URL(group+'-reservations.json',dir);
const selected=plan.cases.filter(c=>c.kind===(group==='native'?'chat':'site'));
if(process.argv.includes('--reserve-site')||process.argv.includes('--reserve-native')){
 const reservations=existsSync(file)?read(group+'-reservations.json'):{plan_hash:planHash,group,providers:[]};
 assert.equal(reservations.plan_hash,planHash);
 for(const provider of ['openai','anthropic','deepseek','typesafe']){
  const micro=selected.reduce((n,c)=>n+c.caps_micro[provider],0);if(!micro)continue;
  const body={model:plan.models[provider],operation:'guarded-production-evaluation',plan_id:plan.id,plan_hash:planHash,
   cases:selected.map(c=>({id:c.id,cap_micro:c.caps_micro[provider]}))};
  const request_hash=evaluationRequestHash(provider,body);
  const lock=openSync(evaluationBudgetPath+'.lock','wx');
  let previous;
  try{
   const ledger=JSON.parse(readFileSync(evaluationBudgetPath,'utf8'));
   previous=ledger.reservations.filter(r=>r.request_hash===request_hash);assert(previous.length<=1);
   ledger.estimates[request_hash]={provider,model:body.model,max_usd:micro/1e6,pricing_checked_at:'2026-10-17',
    basis:'固定合成入力だけの会社別枠。qa-budget.jsで上流送信前に原子的に加算し、上限・未知モデル・Web・画像寸法・要求量を検査。失敗予約も保持。計画hash='+planHash};
   writeFileSync(evaluationBudgetPath,JSON.stringify(ledger,null,2)+'\n');
  }finally{closeSync(lock);unlinkSync(evaluationBudgetPath+'.lock');}
  // 中断後も同じD1ケースを再利用するだけで、外側の枠を二重に予約しない。
  const reservation=previous[0]||gate.reserve(provider,body);
  const existing=reservations.providers.find(r=>r.provider===provider);
  if(existing)assert.equal(existing.request_hash,request_hash);
  else reservations.providers.push({provider,...reservation});
  writeFileSync(file,JSON.stringify(reservations,null,2)+'\n');
 }
 console.log(JSON.stringify({group,plan_id:plan.id,reserved_usd:reservations.providers.reduce((n,r)=>n+r.max_usd,0)}));
 process.exit(0);
}
assert(process.argv.includes('--run-site'),'--reserve-site / --reserve-native / --run-siteを指定');
assert.equal(read('site-reservations.json').plan_hash,planHash,'本番用の枠を先に予約する');
const resultFile=new URL('site-result.json',dir);
assert(!existsSync(resultFile),'失敗・中断したケースも自動で再送しない');
const report={plan_hash:planHash,started_at:new Date().toISOString(),complete:false,results:[]};
const save=()=>writeFileSync(resultFile,JSON.stringify(report,null,2)+'\n');
writeFileSync(resultFile,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
try{
 for(const theme of ['pdf','qr']){
  let history=[],language;
  for(const sample of plan.cases.filter(c=>c.theme===theme)){
   assert.equal(history.length,sample.history_messages);
   const body={query:sample.text,locale:sample.locale,history,...(language?{reply_language:language}:{})};
   const row={id:sample.id,sent_at:new Date().toISOString(),body};report.results.push(row);save();
   const started=Date.now();
   const response=await fetch('https://workers.tk.st/magi2/site-search?site_debate=1&site_chat=1',{
    method:'POST',headers:{Origin:'https://tk.st','Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(170000)});
   row.status=response.status;row.elapsed_ms=Date.now()-started;row.response=await response.json();save();
   const result=row.response;assert.equal(response.status,200,sample.id+' HTTP');
   assert.equal(result.closed,false);assert(result.comment?.trim()&&result.reply_language);
   assert.equal(result.reply_language.code,sample.locale);
   assert(result.results.some(p=>new URL(p.url,'https://tk.st').pathname===sample.expected),sample.id+' ページ選択');
   if(language)assert.equal(JSON.stringify(result.reply_language),JSON.stringify(language));
   language=result.reply_language;
   history.push({role:'user',content:sample.text},{role:'assistant',content:Array.from(result.comment).slice(0,2000).join(''),
    pages:result.results.map(p=>({title:p.title,url:p.url}))});
   row.contract_pass=true;save();console.log(JSON.stringify({id:sample.id,status:row.status,elapsed_ms:row.elapsed_ms,contract_pass:true}));
  }
 }
 report.complete=true;save();
}catch(error){report.error=error.message;save();throw error;}
