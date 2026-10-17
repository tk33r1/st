// 公開後1週間の低頻度な読み取り観測。モデル生成・入力送信・DB更新は行わない。
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root=new URL('../../',import.meta.url),dir=new URL('workers/.wrangler/magi2-observation-20261017/',root);
mkdirSync(dir,{recursive:true});
const planFile=new URL('plan.json',dir),now=Date.now();
const sourceHash=createHash('sha256').update(['workers/magi2/personas.js','workers/magi2/src/index.js'].map(p=>readFileSync(new URL(p,root),'utf8')).join('\n')).digest('hex');
if(!existsSync(planFile)){assert(process.argv.includes('--start'),'公開確認後に--startで基準を保存する');writeFileSync(planFile,JSON.stringify({version:1,started_at:new Date(now).toISOString(),due_at:new Date(now+7*86400000).toISOString(),source_hash:sourceHash},null,2)+'\n',{flag:'wx'});}
const plan=JSON.parse(readFileSync(planFile,'utf8')),day=plan.started_at.slice(0,10);
assert(plan.version===1&&/^\d{4}-\d{2}-\d{2}$/.test(day)&&Number.isFinite(Date.parse(plan.due_at)));
const report={at:new Date().toISOString(),due_at:plan.due_at,source_unchanged:sourceHash===plan.source_hash,models_http:null,global_counts:[],management_read_ok:false,errors:[],ai_calls:0,db_writes:0};
try{const response=await fetch('https://workers.tk.st/magi2/models',{headers:{Origin:'https://tk.st'},signal:AbortSignal.timeout(15000)});
 report.models_http=response.status;assert(response.ok);const body=await response.json();assert(Array.isArray(body.personas)&&body.personas.length===3);report.models_contract_valid=true;
}catch{report.errors.push('public_catalog_unavailable');}
const wrangler=fileURLToPath(new URL('workers/node_modules/wrangler/bin/wrangler.js',root));
try{
 const output=execFileSync(process.execPath,[wrangler,'d1','execute','tk-st-magi2-db','--config','magi2/wrangler.toml','--remote','--json','--command',
  `SELECT ip,day,count FROM rate_limit WHERE ip IN ('global','search:global','research:global') AND day>='${day}' ORDER BY day,ip`],
  {cwd:new URL('workers/',root),encoding:'utf8',timeout:45000,env:{...process.env,WRANGLER_LOG_PATH:fileURLToPath(new URL('wrangler-observe.log',dir))}});
 const records=JSON.parse(output)[0];assert(records.success);report.global_counts=records.results;report.management_read_ok=true;
}catch{report.errors.push('global_counter_read_unavailable');}
const previousFile=new URL('samples.json',dir),samples=existsSync(previousFile)?JSON.parse(readFileSync(previousFile)):[];
samples.push(report);writeFileSync(previousFile,JSON.stringify(samples,null,2)+'\n');
const days=[...new Set(samples.filter(s=>s.models_http===200&&s.management_read_ok&&!s.errors.length).map(s=>s.at.slice(0,10)))];
report.successful_utc_days=days.length;report.elapsed_days=(Date.now()-Date.parse(plan.started_at))/86400000;
report.week_observed=Date.now()>=Date.parse(plan.due_at)&&days.length>=7&&samples.every(s=>s.errors.length===0&&s.source_unchanged);
report.limit='定時の疎通と全体カウンタの記録。観測間の無停止・全回答品質・会社の請求額を保証するものではない。';
writeFileSync(new URL('latest.json',dir),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
