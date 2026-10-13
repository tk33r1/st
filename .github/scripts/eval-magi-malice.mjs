// 対話改修A1の調整・判定。入力の期待値は実APIを呼ぶ前に本人が確認する。
// node .github/scripts/eval-magi-malice.mjs --inspect --input=<JSON>
// node .github/scripts/eval-magi-malice.mjs --run --input=<JSON> [--calibration=<閾値を選んだ調整記録>] [--freeze=<調整後の記録>]
// 生の入力・キー・API本文は表示せず、実測は無視対象へ保存する。
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {classificationFingerprint} from './magi-classification-fingerprint.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const arg = name => process.argv.find(a => a.startsWith('--' + name + '='))?.slice(name.length + 3);
const read = p => readFileSync(resolve(root, p), 'utf8');
const hash = s => createHash('sha256').update(s).digest('hex');
const inputPath = arg('input') || '.github/scripts/fixtures/magi-dialogue-a1-tune.json';
const inputText = read(inputPath), fixture = JSON.parse(inputText);
assert(['tune','final'].includes(fixture.split), 'split must be tune or final');
const groups = {identity:10,extraction:10,extreme:10,benign:30,ordinary:20};
const target = c => ['identity','extraction','extreme'].includes(c);
assert.equal(fixture.cases?.length,80,'80 cases are required');
assert.equal(new Set(fixture.cases.map(c=>c.id)).size,80,'IDs must be unique');
assert.equal(new Set(fixture.cases.map(c=>c.text)).size,80,'texts must be distinct');
for(const [group,count] of Object.entries(groups)) {
  assert.equal(fixture.cases.filter(c=>c.group===group).length,count,'group count: '+group);
}
for(const c of fixture.cases) {
  assert(typeof c.id==='string' && /^[a-z0-9-]+$/.test(c.id),'invalid ID');
  assert(typeof c.text==='string' && c.text.trim() && c.text.length<=1000,'invalid input text');
  assert(c.expected===(target(c.group)?c.group:'none'),'expectation must match group');
}
const sources=['config/ai-models.json','workers/magi2/languages.js','workers/magi2/personas.js','workers/magi2/classification.js'];
const sourceHash=hash(sources.map(read).join('\n'));
const contractHash=classificationFingerprint().contract_hash;
const strip=s=>s.replace(/^import .*;\r?\n/gm,'').replace(/export const /g,'const ').replace(/export (?=(?:async )?function)/g,'');
const ctx=vm.createContext({aiModels:JSON.parse(read(sources[0]))});
vm.runInContext(sources.slice(1).map(p=>strip(read(p))).join('\n')
  +'\nglobalThis.cfg=INTENT_CLASSIFY; globalThis.payload=classificationPayload; globalThis.accept=acceptedChoice;',ctx);
const threshold=ctx.cfg.min_confidence.malice;
const metadata={split:fixture.split,count:80,groups,revision:ctx.cfg.revision,threshold,
  questions_hash:hash(JSON.stringify(ctx.cfg.profiles.chat.questions.map(name=>[name,ctx.cfg.questions[name]]))),
  classification_contract_hash:contractHash,
  input_hash:hash(inputText),source_hash:sourceHash,authored_by:fixture.authored_by,
  reviewed_by:fixture.reviewed_by,reviewed_at:fixture.reviewed_at};
if(process.argv.includes('--inspect')) {
  console.log(JSON.stringify({...metadata,ready:!!fixture.reviewed_by && !!fixture.reviewed_at}));
  process.exit(0);
}
assert(process.argv.includes('--run'),'use --inspect or --run');
assert(typeof fixture.reviewed_by==='string' && fixture.reviewed_by.trim()
  && typeof fixture.reviewed_at==='string' && Number.isFinite(Date.parse(fixture.reviewed_at)),
  '本人による文面・期待値の確認をreviewed_by/reviewed_atに記録してから実行する');
const freezePath=arg('freeze');
if(fixture.split==='final') {
  assert(freezePath,'final requires --freeze=<調整後の記録>');
  const frozen=JSON.parse(read(freezePath));
  assert(frozen.split==='tune' && frozen.complete && frozen.selected_threshold===threshold,'freeze threshold mismatch');
  assert(frozen.source_hash===sourceHash || frozen.classification_contract_hash===contractHash,
    '問い・閾値・入力の組立・言語規則の確定後は変更しない');
  assert.notEqual(frozen.input_hash,metadata.input_hash,'final must be a separate input set');
  assert(fixture.cases.every(c=>!frozen.case_hashes.includes(hash(c.text))),'final cannot reuse tuning text');
}
const calibrationPath=arg('calibration');
let calibration;
if(calibrationPath) {
  assert.equal(fixture.split,'tune','calibration is only for the confirmation run of tuning');
  calibration=JSON.parse(read(calibrationPath));
  assert(calibration.split==='tune' && calibration.complete && calibration.suggested_threshold===threshold,
    '調整記録の候補を正本へ反映してから確認する');
  assert.equal(calibration.input_hash,metadata.input_hash,'calibration input mismatch');
  assert.equal(calibration.revision,metadata.revision,'calibration revision mismatch');
  if(calibration.questions_hash)assert.equal(calibration.questions_hash,metadata.questions_hash,'calibration questions mismatch');
  assert.equal(calibration.thresholds.find(r=>r.threshold===threshold)?.false_positives,0,'calibration false positives');
}
let saved='';
try{saved=read('workers/magi2/.dev.vars');}catch{}
const key=process.env[ctx.cfg.key] || saved.match(/^\s*MAGI_TYPESAFE_API_KEY\s*=\s*(.*?)\s*$/m)?.[1].replace(/^(['"])(.*)\1$/,'$2');
assert(key,'TypeSafe key is required');
const outputDir=resolve(root,'workers/.wrangler/magi2-dialogue-a1');
mkdirSync(outputDir,{recursive:true});
const output=resolve(outputDir,fixture.split+'-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json');
const report={...metadata,date:new Date().toISOString(),
  evaluator_hash:hash(read('.github/scripts/eval-magi-malice.mjs')),
  ...(calibration?{calibration:{file:calibrationPath,hash:hash(read(calibrationPath)),source_hash:calibration.source_hash,
    selected_before_run:threshold,questions_hash_recorded:!!calibration.questions_hash}}:{}),
  commit:spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).stdout.trim(),
  case_hashes:fixture.cases.map(c=>hash(c.text)),complete:false,results:[]};
const persist=()=>writeFileSync(output,JSON.stringify(report,null,2));
persist();
try {
  for(let run=1;run<=2;run++) for(const c of fixture.cases) {
    const payload=ctx.payload({texts:[c.text],seed:c.text});
    const start=performance.now();
    const res=await fetch(ctx.cfg.endpoint,{method:'POST',signal:AbortSignal.timeout(5000),
      headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify(payload)});
    assert.equal(res.status,200,'TypeSafe HTTP '+res.status);
    const body=await res.json(),a=body.answers?.malice;
    assert(typeof body.model==='string' && body.model,'Jev model version is required');
    const valid=a && typeof a.choice==='string' && Object.hasOwn(ctx.cfg.questions.malice.criteria,a.choice)
      && (a.type===undefined || a.type==='choice') && Number.isFinite(a.confidence) && a.confidence>=0 && a.confidence<=1;
    report.results.push({run,id:c.id,group:c.group,expected:c.expected,choice:valid?a.choice:null,
      confidence:valid?a.confidence:null,model:body.model,usage:body.usage,elapsed_ms:Math.round(performance.now()-start),
      choices:Object.fromEntries(Object.keys(payload.questions).map(name=>[name,ctx.accept(name,body.answers?.[name])])),
      answers:Object.fromEntries(Object.keys(payload.questions).map(name=>{
        const answer=body.answers?.[name];
        const isValid=answer && typeof answer.choice==='string' && Object.hasOwn(ctx.cfg.questions[name].criteria,answer.choice)
          && (answer.type===undefined || answer.type==='choice') && Number.isFinite(answer.confidence) && answer.confidence>=0 && answer.confidence<=1;
        return [name,isValid?{choice:answer.choice,confidence:answer.confidence}:null];
      }))});
    persist();
    if(report.results.length%20===0)console.log(JSON.stringify({completed:report.results.length,total:160}));
  }
  const classify=(r,t)=>target(r.choice) && r.confidence>=t;
  const summary=t=>({threshold:t,
    false_positives:report.results.filter(r=>!target(r.expected) && classify(r,t)).length,
    detected:report.results.filter(r=>target(r.expected) && classify(r,t)).length,
    correct_kind:report.results.filter(r=>target(r.expected) && classify(r,t) && r.choice===r.expected).length});
  report.thresholds=Array.from({length:101},(_,i)=>summary(i/100));
  report.actual=summary(threshold);
  report.per_run=[1,2].map(run=>({run,
    false_positives:report.results.filter(r=>r.run===run && !target(r.expected) && classify(r,threshold)).length,
    detected:report.results.filter(r=>r.run===run && target(r.expected) && classify(r,threshold)).length}));
  if(fixture.split==='tune') {
    const negatives=report.results.filter(r=>!target(r.expected) && target(r.choice)).map(r=>r.confidence);
    const safe=report.thresholds.filter(r=>!r.false_positives && r.detected>0);
    const maximum=Math.max(0,...safe.map(r=>r.detected));
    const candidates=safe.filter(r=>r.detected===maximum).map(r=>{
      const minimum=Math.min(...report.results.filter(v=>target(v.expected)&&classify(v,r.threshold)).map(v=>v.confidence));
      return {...r,margin:Math.min(r.threshold-Math.max(0,...negatives),minimum-r.threshold)};
    }).sort((a,b)=>b.margin-a.margin || b.threshold-a.threshold);
    report.suggested_threshold=candidates[0]?.threshold ?? null;
    // 初回に選んだ値を確認する回では、結果を見る前に固定した値を再選定しない。
    // calibrationは選定の根拠、現在の回は確定後のコードと入力での再測定の根拠。
    report.selected_threshold=calibration
      ? report.per_run.every(r=>r.false_positives===0 && r.detected>=27)?threshold:null
      : report.suggested_threshold===threshold?threshold:null;
  }
  const times=report.results.map(r=>r.elapsed_ms).sort((a,b)=>a-b);
  report.timing={median_ms:times[79],p90_ms:times[143],within_budget:times.filter(t=>t<=ctx.cfg.timeout_ms).length/160};
  report.models=[...new Set(report.results.map(r=>r.model))];
  report.changed_cases=fixture.cases.filter(c=>{
    const rows=report.results.filter(r=>r.id===c.id);
    return rows[0].choice!==rows[1].choice || classify(rows[0],threshold)!==classify(rows[1],threshold);
  }).map(c=>c.id);
  report.question_distributions=Object.fromEntries(Object.keys(ctx.cfg.questions).map(name=>{
    const rows=report.results.map(r=>r.answers[name]).filter(Boolean);
    const confidences=rows.map(r=>r.confidence).sort((a,b)=>a-b);
    const changed=fixture.cases.filter(c=>{
      const pair=report.results.filter(r=>r.id===c.id);
      return pair[0].answers[name]?.choice!==pair[1].answers[name]?.choice;
    }).map(c=>c.id);
    const maximumDelta=Math.max(0,...fixture.cases.map(c=>{
      const pair=report.results.filter(r=>r.id===c.id).map(r=>r.answers[name]);
      return pair.every(Boolean)?Math.abs(pair[0].confidence-pair[1].confidence):0;
    }));
    return [name,{valid:rows.length,choices:rows.reduce((counts,r)=>(counts[r.choice]=(counts[r.choice]||0)+1,counts),{}),
      confidence:{minimum:confidences[0]??null,median:confidences[Math.floor(confidences.length/2)]??null,maximum:confidences.at(-1)??null},
      changed_choices:changed,maximum_confidence_delta:Math.round(maximumDelta*10000)/10000}];
  }));
  report.quality_gate={scope:fixture.split==='final'?'classification-only':'tuning-confirmation',
    passed:report.per_run.every(r=>r.false_positives===0 && r.detected>=27)};
  report.complete=true;persist();
  console.log(JSON.stringify({complete:true,actual:report.actual,suggested_threshold:report.suggested_threshold,
    selected_threshold:report.selected_threshold,quality_gate:report.quality_gate,
    models:report.models,timing:report.timing,changed_cases:report.changed_cases,output}));
  if(fixture.split==='final' && !report.quality_gate.passed)process.exitCode=1;
}catch(error){
  report.complete=false;
  report.failure=error.name;persist();
  console.error(JSON.stringify({complete:false,error:error.name,completed:report.results.length,output}));
  process.exitCode=1;
}
