// 保存済みの質問・出典だけで残る項目を再確認する。検索・分類・タイトル・答え直しは呼ばない。
// --plan はネットワークとキーを使わない。--run は同じ計画の最大4要求を共通予算で実行する。
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {recordedVerificationRequest,verifiedResearchResult} from './magi-a2-verification.mjs';
import {paidEvaluationGate,evaluationRequestHash,evaluationBudgetPath} from './magi-eval-budget.mjs';
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const dir=fileURLToPath(new URL('../../workers/.wrangler/magi2-dialogue-a2/',import.meta.url));
const option=n=>process.argv.find(a=>a.startsWith('--'+n+'='))?.slice(n.length+3);
const planPath=resolve(option('plan')||dir+'bounded-verification-plan.json');
const assertPath=p=>{const rel=relative(dir,p);if(!rel||rel==='..'||rel.startsWith('..'+sep)||resolve(dir,rel)!==p)throw new Error('Evaluation file must stay in the private A2 directory.');};
assertPath(planPath);
if(!process.argv.includes('--run')){
  const main=read(dir+'worker-verified-source-final.json'),prototype=read(dir+'source-verification-blocks-probe.json');
  const selected=['final-fresh-02','final-fresh-06','final-fresh-10','final-fresh-12'];
  const requests=selected.map(id=>{
    const row=main.results.find(r=>r.id===id&&r.theme==='light')||prototype.results.find(r=>r.id===id);
    const saved=row.calls?.find(c=>c.verification_evidence)?.verification_evidence;
    const question=saved?.question||read('.github/scripts/fixtures/magi-dialogue-a2-final.json').cases.find(c=>c.id===id).text;
    const evidence=saved?.evidence||row.evidence.map(e=>({n:e.n,title:e.title,url:e.url,allowed:true,readable:e.readable,blocks:e.blocks,truncated:false}));
    const language={code:row.language||'ja'},theme=row.theme||'dark';
    const date=saved?main.date:prototype.date;
    const body={...recordedVerificationRequest(question,saved?.draft||row.original,evidence,language,theme,date),service_tier:'default'};
    if(body.tools||body.stream||body.messages.some(m=>typeof m.content!=='string'))throw new Error('Only bounded text verification is allowed.');
    // UTF8バイト数の2倍＋2,048を入力トークン上限とし、長文・cache write側の高い単価と10%の余裕を使う。
    const bytes=Buffer.byteLength(JSON.stringify(body)),input_ceiling=bytes*2+2048,output_ceiling=body.max_completion_tokens;
    const max_usd=Math.ceil(((input_ceiling*.25+output_ceiling*.75)/1e6)*1.1*1e6)/1e6;
    return {id,theme,language,question,evidence,body,request_hash:evaluationRequestHash('openai',body),input_ceiling,output_ceiling,max_usd};
  });
  if(requests.length>4||requests.reduce((n,r)=>n+r.max_usd,0)>.10)throw new Error('Targeted plan exceeds its $0.10 ceiling.');
  writeFileSync(planPath,JSON.stringify({date:new Date().toISOString(),scope:'recorded-evidence-only; no fresh Web search',
    pricing_checked_at:'2026-10-15',pricing_source:'https://developers.openai.com/api/docs/pricing',requests},null,2));
  console.log(JSON.stringify({planned:requests.length,max_usd:requests.reduce((n,r)=>n+r.max_usd,0),plan:planPath}));
} else {
  const budget=paidEvaluationGate(),plan=read(planPath);
  if(plan.requests.length>4||plan.requests.reduce((n,r)=>n+r.max_usd,0)>.10)throw new Error('Invalid targeted plan.');
  const ledger=read(evaluationBudgetPath);
  if(plan.requests.some(r=>ledger.reservations.some(s=>s.request_hash===r.request_hash)))throw new Error('This plan has already reserved API calls. Use its saved results instead of repeating it.');
  const vars=readFileSync(fileURLToPath(new URL('../../workers/magi2/.dev.vars',import.meta.url)),'utf8');
  const key=process.env.MAGI_OPENAI_API_KEY||vars.match(/^\s*MAGI_OPENAI_API_KEY\s*=\s*(.*?)\s*$/m)?.[1].replace(/^(['"])(.*)\1$/,'$2');
  if(!key)throw new Error('OpenAI key required.');
  const report={date:new Date().toISOString(),scope:plan.scope,plan_hash:createHash('sha256').update(JSON.stringify(plan)).digest('hex'),results:[]};
  const output=resolve(option('output')||dir+'bounded-verification-result.json');assertPath(output);
  for(const r of plan.requests){
    if(evaluationRequestHash('openai',r.body)!==r.request_hash)throw new Error('Request plan changed.');
    const reservation=budget.reserve('openai',r.body),start=performance.now();
    const res=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},
      body:JSON.stringify(r.body),signal:AbortSignal.timeout(45000)});
    const data=await res.json(),row={id:r.id,status:res.status,reservation,elapsed_ms:Math.round(performance.now()-start),usage:data.usage,service_tier:data.service_tier};
    report.results.push(row);
    if(!res.ok||data.error){row.error={type:data.error?.type,code:data.error?.code};writeFileSync(output,JSON.stringify(report,null,2));throw new Error('Targeted evaluation stopped at API error.');}
    const value=JSON.parse(data.choices[0].message.content);
    if(data.choices[0].finish_reason!=='stop')throw new Error('Incomplete targeted verification.');
    row.value=value;row.reply=verifiedResearchResult(value,r.evidence,r.language);
    // 標準・短文の入力でもcache writeを全入力へ適用し、請求額と区別した保守的な使用量見積もり。
    row.estimated_usd=((data.usage.prompt_tokens||0)*.125+(data.usage.completion_tokens||0)*.5)/1e6;
    writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({id:r.id,estimated_usd:row.estimated_usd,parts:value.parts.map(p=>({label:p.label,status:p.status}))}));
  }
}
