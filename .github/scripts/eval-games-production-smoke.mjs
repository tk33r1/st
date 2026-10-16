// 公開Worker→実上流の最小疎通1件。検索・再試行・ランキング・秘密情報を使わない。
// 既定は計画のみ。送信には固定計画と既存の累計予算台帳が必要。
import {readFileSync,writeFileSync,mkdirSync,existsSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {auxiliaryConfig} from './aux-ai-config.mjs';
import {paidEvaluationGate,evaluationBudgetPath,evaluationRequestHash} from './magi-eval-budget.mjs';
const root=new URL('../../',import.meta.url),read=p=>readFileSync(new URL(p,root),'utf8');
const hash=s=>createHash('sha256').update(s).digest('hex');
const dir=new URL('workers/.wrangler/games-production-smoke-20261017/',root);mkdirSync(dir,{recursive:true});
const cfg=auxiliaryConfig();assert.equal(cfg.providers.games,'anthropic');
const body=cfg.game;
assert.equal(body.max_tokens,200);assert.equal(body.thinking.type,'disabled');assert(!body.tools);
const clientBody={system:body.system,messages:body.messages,maxTokens:body.max_tokens};
const input=Buffer.byteLength(JSON.stringify(body))*2+2048;
assert(input<100000);
const request_hash=evaluationRequestHash('anthropic',body);
const estimate={provider:'anthropic',model:body.model,max_usd:Math.ceil((input*.20+body.max_tokens*.50)*1.1)/1e6,
 pricing_checked_at:'2026-10-17',evaluation_batch:'games-production-smoke-20261017',
 basis:`本番と同じ組立て。UTF8 bytes*2+2048=${input} input ceiling (<100k)、output<=200。入力1時間cache write側$0.20/M・出力$0.50/Mに10%余裕。検索・画像・再試行なし。https://platform.claude.com/docs/en/about-claude/pricing`};
assert(estimate.max_usd<=.003);
const files=['workers/games/src/index.js','workers/games/anthropic.js','workers/shared/anthropic.js','workers/games/wrangler.toml','config/ai-models.json','.github/scripts/eval-games-production-smoke.mjs'];
const deployments=JSON.parse(read('workers/.wrangler/magi2-release-20261017/games-live-deployments.json'));
const latest=deployments.toSorted((a,b)=>Date.parse(b.created_on)-Date.parse(a.created_on))[0];
assert.deepEqual(latest.versions,[{version_id:'4c99d3e1-8157-43f2-865c-da05f4d9cfea',percentage:100}]);
const plan={scope:'公開ゲームAPIの固定READY 1件。端末からのMAGI相談ではない。',
 source_hash:hash(files.map(read).join('\n')),deployment:latest.id,url:'https://st-games-api.tk33r1.workers.dev/api/gpt',
 clientBody,upstreamBody:body,request_hash,estimate};
const planFile=new URL('plan.json',dir),resultFile=new URL('result.json',dir);
if(!process.argv.includes('--run')){
 const text=JSON.stringify(plan,null,2)+'\n';
 if(existsSync(planFile))assert.equal(readFileSync(planFile,'utf8'),text);else writeFileSync(planFile,text,{flag:'wx'});
 console.log(JSON.stringify({mode:'plan',calls:1,maximum_usd:estimate.max_usd,input_ceiling:input,clientBody,network_calls:0}));
 process.exit(0);
}
const gate=paidEvaluationGate();assert(!existsSync(resultFile),'完了・中断結果を上書きしない');
assert.deepEqual(JSON.parse(readFileSync(planFile,'utf8')),plan,'計画後に入力・コードが変わった');
const lock=evaluationBudgetPath+'.lock',fd=openSync(lock,'wx');
try{
 const ledger=JSON.parse(readFileSync(evaluationBudgetPath,'utf8'));
 assert(!ledger.reservations.some(r=>r.request_hash===request_hash),'予約済みの同一要求を再送しない');
 if(ledger.estimates[request_hash])assert.deepEqual(ledger.estimates[request_hash],estimate);else ledger.estimates[request_hash]=estimate;
 writeFileSync(evaluationBudgetPath,JSON.stringify(ledger,null,2)+'\n');
}finally{closeSync(fd);unlinkSync(lock);}
const report={date:new Date().toISOString(),scope:plan.scope,deployment:plan.deployment,
 reservation:gate.reserve('anthropic',body),complete:false,ai_calls:1};
const save=()=>writeFileSync(resultFile,JSON.stringify(report,null,2)+'\n');
writeFileSync(resultFile,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
const start=Date.now();
try{
 const response=await fetch(plan.url,{method:'POST',headers:{Origin:'https://tk.st','Content-Type':'application/json'},
  body:JSON.stringify(clientBody),signal:AbortSignal.timeout(40000)});
 report.status=response.status;report.cors=response.headers.get('access-control-allow-origin');
 report.response=await response.json();report.elapsed_ms=Date.now()-start;
 assert.equal(response.status,200);assert.equal(report.cors,'https://tk.st');assert.equal(report.response.text,'READY');
 report.complete=true;save();console.log(JSON.stringify(report));
}catch(error){report.error=error.message;report.elapsed_ms=Date.now()-start;save();throw error;}
