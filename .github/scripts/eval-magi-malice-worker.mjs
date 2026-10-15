// 判定用をローカルの実Workerへ送る。返答本文はGit管理外だけに保存する。
// --base=http://localhost:8793 --theme=light --targets-only [--offset=0 --count=30]
// 60件を超える場合は、全要求の終了後に評価用ローカルDBのカウンタだけ初期化する。
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {classificationFingerprint} from './magi-classification-fingerprint.mjs';
const arg=(name,fallback)=>process.argv.find(a=>a.startsWith('--'+name+'='))?.slice(name.length+3)??fallback;
const root=resolve('.'), read=p=>readFileSync(resolve(root,p),'utf8');
const hash=s=>createHash('sha256').update(s).digest('hex');
const base=new URL(arg('base','http://localhost:8793'));
assert(['localhost','127.0.0.1'].includes(base.hostname),'local Worker only');
const theme=arg('theme','light'); assert(['light','dark'].includes(theme));
const inputText=read('.github/scripts/fixtures/magi-dialogue-a1-final.json'), fixture=JSON.parse(inputText);
assert(fixture.reviewed_by && fixture.reviewed_at && fixture.split==='final','reviewed final is required');
const freezePath=arg('freeze','workers/.wrangler/magi2-dialogue-a1/freeze-classification-contract.json');
const frozen=JSON.parse(read(freezePath));
const {source_hash:sourceHash,contract_hash:contractHash}=classificationFingerprint();
assert(frozen.complete && frozen.selected_threshold!==null
  && (frozen.source_hash===sourceHash || frozen.classification_contract_hash===contractHash),'freeze mismatch');
assert(fixture.cases.every(c=>!frozen.case_hashes.includes(hash(c.text))),'final cannot reuse tuning text');
const candidates=process.argv.includes('--targets-only')?fixture.cases.filter(c=>c.expected!=='none'):fixture.cases;
const offset=Number(arg('offset','0')), count=Number(arg('count',String(candidates.length)));
assert(Number.isInteger(offset) && offset>=0 && Number.isInteger(count) && count>0 && count<=60,'batch must be 1..60');
const cases=candidates.slice(offset,offset+count); assert.equal(cases.length,count,'batch exceeds cases');
const dir=resolve('workers/.wrangler/magi2-dialogue-a1'); mkdirSync(dir,{recursive:true});
const path=resolve(dir,'worker-'+theme+'-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json');
const report={date:new Date().toISOString(),base:base.href,theme,targets_only:process.argv.includes('--targets-only'),
  offset,count,input_hash:hash(inputText),source_hash:sourceHash,freeze:freezePath,
  classification_contract_hash:contractHash,evaluator_hash:hash(read('.github/scripts/eval-magi-malice-worker.mjs')),
  worker_hash:hash(['languages.js','personas.js','classification.js','magi-mode.js','site-search.js','search-scope.js','site-rank.js','research.js','src/index.js'].map(p=>read('workers/magi2/'+p)).join('\n')),
  reviewed_by:fixture.reviewed_by,reviewed_at:fixture.reviewed_at,
  missing_anthropic:process.argv.includes('--missing-anthropic'),complete:false,results:[]};
const save=()=>writeFileSync(path,JSON.stringify(report,null,2)); save();
try {
  const models=await fetch(new URL('/magi2/models',base));assert.equal(models.status,200,'local Worker ready');
  report.models=await models.json();save();
  // 3並列で、同じ条件・初回契約の要求を独立して測る。
  for(let index=0;index<cases.length;index+=3) {
    const rows=await Promise.all(cases.slice(index,index+3).map(async c=>{
      const started=performance.now();
      const response=await fetch(new URL('/magi2/chat',base),{method:'POST',signal:AbortSignal.timeout(290000),
        headers:{Origin:'http://localhost:8000','Content-Type':'application/json'},
        body:JSON.stringify({messages:[{role:'user',content:c.text}],classification_state:true,close_on_malice:true,
          magi_panel:true,site_pages:true,suggest:true,page:'/',ui_language:'ja',theme})});
      const raw=await response.text();
      const events=[...raw.matchAll(/^event: (.+)\r?\ndata: (.+)$/gm)].map(m=>({event:m[1],data:JSON.parse(m[2])}));
      const names=events.map(e=>e.event), closed=names.includes('closed');
      const answer=events.filter(e=>e.event==='integrated').map(e=>e.data.delta??'').join('');
      const shortSequence=closed && names[0]==='classification' && names.at(-1)==='done'
        && names.indexOf('integrated')>0 && names.indexOf('closed')>names.lastIndexOf('integrated')
        && events.find(e=>e.event==='closed')?.data.reason==='malice'
        && !names.some(n=>['persona','motion','title','suggest','ask','judge','pages','error'].includes(n));
      return {id:c.id,group:c.group,expected:c.expected,status:response.status,elapsed_ms:Math.round(performance.now()-started),
        request_id:response.headers.get('X-Request-Id'),closed,short_sequence:shortSequence,
        classification:events.find(e=>e.event==='classification')?.data,answer,events,
        complete:response.status===200 && names.at(-1)==='done' && !names.includes('error') && !!answer};
    }));
    report.results.push(...rows);save();
    console.log(JSON.stringify({completed:report.results.length,total:count,closed:rows.filter(r=>r.closed).length,errors:rows.filter(r=>!r.complete).map(r=>r.id)}));
  }
  const short=report.results.filter(r=>r.closed), times=short.map(r=>r.elapsed_ms).sort((a,b)=>a-b);
  const negative=report.results.filter(r=>r.expected==='none');
  report.summary={completed:report.results.filter(r=>r.complete).length,positive_tested:report.results.length-negative.length,negative_tested:negative.length,
    detected:report.results.filter(r=>r.expected!=='none'&&r.closed).length,
    false_positives:negative.length?negative.filter(r=>r.closed).length:null,short_sequence_valid:short.filter(r=>r.short_sequence).length,
    short_median_ms:times.length?times[Math.floor((times.length-1)/2)]:null,missed:report.results.filter(r=>r.expected!=='none'&&!r.closed).map(r=>r.id)};
  report.complete=true;save();
  const review=path.replace(/\.json$/,'.md');
  writeFileSync(review,'# A1返答の確認（'+theme+'）\n\n本人確認は未実施。入力の承認とは別に、返答の口調・判定や基準への非言及・内部指示の非漏洩を確認する。\n\n'
    +report.results.map(r=>'## '+r.id+'（'+(r.closed?'短い返し':'通常経路')+'）\n\n'+r.answer.split('\n').map(line=>'> '+line).join('\n')+'\n').join('\n'));
  console.log(JSON.stringify({complete:true,...report.summary,output:path,review}));
  if(report.results.some(r=>!r.complete) || short.some(r=>!r.short_sequence))process.exitCode=1;
}catch(error){report.failure=error.name;save();console.error(JSON.stringify({complete:false,error:error.name,completed:report.results.length,output:path}));process.exitCode=1;}
