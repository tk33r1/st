// 固定した公開原典→カードの段階だけ。実検索を評価した記録にはしない。
// 既定は無通信。--runも固定計画・共通累計台帳で送信前予約が必要。
import {readFileSync,writeFileSync,mkdirSync,existsSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {auxiliaryContext,auxiliaryConfig} from './aux-ai-config.mjs';
import {paidEvaluationGate,evaluationBudgetPath,evaluationRequestHash} from './magi-eval-budget.mjs';
const root=new URL('../../',import.meta.url),read=p=>readFileSync(new URL(p,root),'utf8'),sha=s=>createHash('sha256').update(s).digest('hex');
const dir=new URL('workers/.wrangler/dj-song-card-20261017/',root);mkdirSync(dir,{recursive:true});
const fixture=JSON.parse(read('.github/scripts/fixtures/dj-song-card-references-20261017.json'));
const registry=JSON.parse(read('config/ai-models.json')),cfg=auxiliaryConfig(),ctx=auxiliaryContext();
const evidence={sources:fixture.sources.map(({url,title})=>({url,title})),excerpts:fixture.sources.flatMap(s=>s.excerpts.map(text=>({url:s.url,text})))};
const paths=['.github/scripts/eval-dj-song-card.mjs','.github/scripts/fixtures/dj-song-card-references-20261017.json',
 'config/ai-models.json','workers/shared/anthropic.js','workers/dj-request/song-info-anthropic.js','workers/dj-request/src/index.js'];
const requests=[];
for(const sample of fixture.cases)for(const provider of sample.id==='unknown'?['anthropic']:['anthropic','openai']){
 const anthropic=ctx.songCardBody(sample.song,evidence,cfg.schema);
 const body=provider==='anthropic'?anthropic:{model:registry.openai.luna.id,
  messages:[{role:'system',content:anthropic.system},...anthropic.messages],reasoning_effort:'none',max_completion_tokens:anthropic.max_tokens,
  response_format:{type:'json_schema',json_schema:{name:'song_card',strict:true,schema:cfg.schema}},stream:false,service_tier:'default'};
 const input=Buffer.byteLength(JSON.stringify(body))*2+2048,output=body.max_tokens||body.max_completion_tokens;
 assert(input<100000&&!body.tools);const rates=provider==='anthropic'?[.20,.50]:[.25,.75];
 const estimate={provider,model:body.model,max_usd:Math.ceil((input*rates[0]+output*rates[1])*1.1)/1e6,
  pricing_checked_at:'2026-10-17',evaluation_batch:'dj-song-card-20261017',
  basis:`固定した文字だけ。UTF8 bytes*2+2048=${input} input ceiling; output<=${output}; input $${rates[0]}/M output $${rates[1]}/M +10%。検索・画像・再試行なし。https://platform.claude.com/docs/en/about-claude/pricing https://developers.openai.com/api/docs/pricing`};
 requests.push({id:sample.id,provider,body,request_hash:evaluationRequestHash(provider,body),estimate});
}
const sums=Object.fromEntries(['openai','anthropic'].map(p=>[p,requests.filter(r=>r.provider===p).reduce((n,r)=>n+Math.round(r.estimate.max_usd*1e6),0)/1e6]));
const maximum_usd=Math.round((sums.openai+sums.anthropic)*1e6)/1e6;assert(maximum_usd<=.03);
const plan={version:1,scope:fixture.scope,source_hash:sha(paths.map(read).join('\n')),maximum_usd,by_provider:sums,requests};
const planFile=new URL('plan.json',dir),resultFile=new URL('result.json',dir);
if(!process.argv.includes('--run')){
 const text=JSON.stringify(plan,null,2)+'\n';if(existsSync(planFile))assert.equal(readFileSync(planFile,'utf8'),text,'既存計画と異なる');else writeFileSync(planFile,text,{flag:'wx'});
 console.log(JSON.stringify({mode:'plan',calls:requests.length,maximum_usd,by_provider:sums,network_calls:0,scope:fixture.scope}));process.exit(0);
}
const gate=paidEvaluationGate();assert(!existsSync(resultFile),'完了・中断結果を再実行・上書きしない');
assert.equal(JSON.stringify(JSON.parse(readFileSync(planFile,'utf8'))),JSON.stringify(plan),'計画後にコード・入力が変わった');
const vars=read('workers/magi2/.dev.vars'),keys={};
for(const [p,name] of [['anthropic','MAGI_ANTHROPIC_API_KEY'],['openai','MAGI_OPENAI_API_KEY']]){
 keys[p]=process.env[name]||vars.match(new RegExp('^\\s*'+name+'\\s*=\\s*(.*?)\\s*$','m'))?.[1]?.replace(/^(['"])(.*)\1$/,'$2');assert(keys[p],name+' required');
}
const lock=evaluationBudgetPath+'.lock',fd=openSync(lock,'wx');
try{
 const ledger=JSON.parse(readFileSync(evaluationBudgetPath,'utf8')),spent=p=>ledger.reservations.filter(r=>!p||r.provider===p).reduce((n,r)=>n+Math.ceil(r.max_usd*1e6),0);
 assert(spent()+Math.ceil(maximum_usd*1e6)<=800000);
 for(const p of Object.keys(sums))assert(spent(p)+Math.ceil(sums[p]*1e6)<=400000);
 for(const r of requests){assert(!ledger.reservations.some(x=>x.request_hash===r.request_hash),'同じ要求を再送しない');
  if(ledger.estimates[r.request_hash])assert.deepEqual(ledger.estimates[r.request_hash],r.estimate);else ledger.estimates[r.request_hash]=r.estimate;}
 writeFileSync(evaluationBudgetPath,JSON.stringify(ledger,null,2)+'\n');
}finally{closeSync(fd);unlinkSync(lock);}
const report={scope:plan.scope,plan_hash:sha(JSON.stringify(plan)),complete:false,results:[]};
const save=()=>writeFileSync(resultFile,JSON.stringify(report,null,2)+'\n');writeFileSync(resultFile,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
for(const r of requests){
 const row={id:r.id,provider:r.provider,...gate.reserve(r.provider,r.body),completed:false};report.results.push(row);save();
 const start=Date.now(),signal=AbortSignal.timeout(25000);
 try{
  const response=await fetch(r.provider==='anthropic'?'https://api.anthropic.com/v1/messages':'https://api.openai.com/v1/chat/completions',
   {method:'POST',signal,headers:{'Content-Type':'application/json',...(r.provider==='anthropic'?{'x-api-key':keys.anthropic,'anthropic-version':'2023-06-01'}:{Authorization:'Bearer '+keys.openai})},body:JSON.stringify(r.body)});
  assert(response.ok,'HTTP '+response.status);row.reply=await response.json();
  let output=row.reply;
  if(r.provider==='openai'){
   assert.equal(row.reply.choices?.[0]?.finish_reason,'stop');output={stop_reason:'end_turn',content:[{type:'text',text:row.reply.choices[0].message.content}]};
  }
  row.card=ctx.buildSongCard(ctx.songCardOutput(evidence,output));
  const expected=fixture.cases.find(c=>c.id===r.id).expected;
  assert.equal(row.card.identified,expected.identified);assert.equal(row.card.originalYear,expected.year);
  assert.equal(!!row.card.yearNote,expected.year_note);assert.equal(row.card.dropped,0);
  assert(!row.card.viralVersion&&!row.card.floorTip,'資料にないSNS流行・使いどころを作らない');
  if(!expected.identified)assert.equal(row.card.facts.length,0);
  row.completed=true;
 }catch(e){row.error=e.name+': '+e.message;}
 finally{row.ms=Date.now()-start;save();}
}
report.complete=true;save();console.log(JSON.stringify({complete:true,calls:report.results.length,checks_passed:report.results.filter(r=>r.completed).length,maximum_usd}));
