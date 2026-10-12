// tools/gameの②を固定済みの公開候補・正解で評価する。npm依存を読まない。
// --check / --plan / --smoke-payload は通信しない。--accuracyだけJevへ送る。
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadWorker,typesafeKey,gitState} from './eval-site-rank.mjs';
import {measureAccuracy,percentile} from './eval-daily-rank.mjs';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const DIR='.github/site-search/phase4/rank',SCOPES=['tools','game'];
const read=p=>readFileSync(resolve(ROOT,p),'utf8'),sha=v=>createHash('sha256').update(v).digest('hex');
const plain=v=>JSON.parse(JSON.stringify(v));
const option=(key,fallback)=>{const i=process.argv.indexOf(key);return i<0?fallback:process.argv[i+1];};

export async function loadListFixtures(magi) {
  const manifest=JSON.parse(read(DIR+'/manifest.json'));
  assert.equal(manifest.version,1);assert.match(manifest.frozen,/^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(Object.keys(manifest.files).sort(),['game.json','queries.json','site-index.json','tools.json']);
  for(const [file,hash] of Object.entries(manifest.files)) assert.equal(sha(readFileSync(resolve(ROOT,DIR,file))),hash,file+': 固定fixtureが変わった');
  const data=JSON.parse(read(DIR+'/queries.json'));assert.equal(data.frozen,manifest.frozen);assert.equal(data.version,1);
  assert.ok(['agent','owner'].includes(data.annotator));assert.ok(data.source);
  magi.hooks.fetch=async url=>{assert.equal(url,'https://tk.st/data/site-search.json');return new Response(read(DIR+'/site-index.json'));};
  const publication=await magi.fetchSiteLists(),locals={};
  for(const scope of SCOPES) {
    const snapshot=magi.makeListSnapshot(scope,read(DIR+'/'+scope+'.json'),publication);
    locals[scope]={snapshot,generation:await magi.snapshotHash(snapshot),candidate_hash:await magi.rankCandidateHash(snapshot),
      urlToId:new Map(snapshot.raw.map(p=>[p.url,p.id]))};
  }
  const ids=new Set(),requests=new Set(),summary={};
  for(const q of data.queries) {
    assert.ok(SCOPES.includes(q.scope) && ['tune','final'].includes(q.set) && ['positive','negative','boundary'].includes(q.class));
    assert.match(q.id,new RegExp('^'+q.scope+'-'+q.set+'-\\d{2}$'));assert.ok(!ids.has(q.id));ids.add(q.id);
    assert.ok(['ja','en'].includes(q.locale));assert.equal(q.query,magi.rankQuery(q.query));
    assert.ok(q.query.length && Array.from(q.query).length<=magi.SITE_RANK.query_max_chars);
    assert.deepEqual(q.filters,plain(magi.normalizeScopeFilters(q.scope,q.filters)));
    const targets=magi.filterRankItems(locals[q.scope].snapshot,q.scope,q.filters),targetIds=new Set(targets.map(p=>p.id));
    assert.ok(targets.length,q.id+': 絞り込みが空');assert.ok(Array.isArray(q.answers) && new Set(q.answers).size===q.answers.length);
    for(const id of q.answers) assert.ok(targetIds.has(id),q.id+': 正解が対象外 '+id);
    assert.ok(q.class!=='negative' || !q.answers.length);assert.ok(q.class!=='positive' || q.answers.length);
    assert.equal(typeof q.required,'boolean');assert.ok(!q.required || q.answers.length);assert.ok(q.note);
    const key=JSON.stringify([q.scope,q.locale,q.query,q.filters]);assert.ok(!requests.has(key));requests.add(key);
  }
  for(const scope of SCOPES) {
    summary[scope]={};
    for(const set of ['tune','final']) {
      const rows=data.queries.filter(q=>q.scope===scope && q.set===set);
      assert.ok(rows.length>=20);for(const c of ['positive','negative','boundary']) assert.ok(rows.some(q=>q.class===c));
      assert.ok(rows.some(q=>q.locale==='en') && rows.some(q=>Object.keys(q.filters).length));
      summary[scope][set]={total:rows.length,positive:rows.filter(q=>q.answers.length).length,none:rows.filter(q=>!q.answers.length).length};
    }
  }
  return {manifest,data,locals,summary};
}
export function listCandidates(magi,local,q) {
  const targets=magi.filterRankItems(local.snapshot,q.scope,q.filters),selected=magi.shortlistRankItems(targets,q.query,q.scope).map(r=>r.p);
  return {total:targets.length,ids:selected.map(p=>p.id),payload:magi.rankPayload(q.query,q.locale,selected.map(magi.toRankCandidate),q.scope)};
}
export function listScores(queries,rows,threshold) {
  const byId=new Map(rows.map(r=>[r.id,r])),positive=queries.filter(q=>q.answers.length),none=queries.filter(q=>!q.answers.length);
  const reached=positive.filter(q=>q.answers.some(id=>byId.get(q.id)?.candidate_ids.includes(id))).length;
  const required=positive.filter(q=>q.required),requiredReached=required.filter(q=>q.answers.some(id=>byId.get(q.id)?.candidate_ids.includes(id))).length;
  const hit=positive.filter(q=>byId.get(q.id)?.by_threshold[threshold]?.ids.slice(0,5).some(id=>q.answers.includes(id))).length;
  const shown=none.filter(q=>byId.get(q.id)?.by_threshold[threshold]?.ids.length).length;
  const failed=queries.filter(q=>!byId.get(q.id) || byId.get(q.id).by_threshold[threshold]?.status==='failed').length;
  const missing=rows.filter(r=>Object.values(r.probs).some(p=>p===null)).length;
  const positiveExtras=positive.filter(q=>byId.get(q.id)?.by_threshold[threshold]?.ids.some(id=>!q.answers.includes(id))).map(q=>q.id);
  return {reached,positive:positive.length,requiredReached,required:required.length,hit,shown,none:none.length,failed,missing,positiveExtras,
    pass:reached/positive.length>=.95 && requiredReached===required.length && hit/positive.length>=.95 && shown===0 && failed===0 && missing===0};
}
export function listReport(record) {
  return {scope:record.scope,set:record.set,thresholds:record.thresholds,
    runs:record.measurements.map(run=>({run:run.run,scores:Object.fromEntries(record.thresholds.map(t=>[t,listScores(record.queries,run.rows,t)])),
      models:[...new Set(run.rows.map(r=>r.model).filter(Boolean))],missingUsage:run.rows.filter(r=>!r.usage).length,
      p50:percentile(run.rows.map(r=>r.jev_ms).filter(Number.isFinite),.5),p95:percentile(run.rows.map(r=>r.jev_ms).filter(Number.isFinite),.95)})),
    drift:record.measurements.length<2?null:record.thresholds.map(t=>({threshold:t,queries:record.queries.filter(q=>{
      const a=record.measurements[0].rows.find(r=>r.id===q.id)?.by_threshold[t]?.ids,b=record.measurements[1].rows.find(r=>r.id===q.id)?.by_threshold[t]?.ids;
      return JSON.stringify(a)!==JSON.stringify(b);
    }).map(q=>q.id)}))};
}
async function main() {
  const modes=['--check','--plan','--smoke-payload','--accuracy','--report'].filter(k=>process.argv.includes(k));
  assert.equal(modes.length,1,'実行モードは1つだけ指定する');
  const params=['--scope','--set','--runs','--report'];
  for(let i=2;i<process.argv.length;i++) {
    const key=process.argv[i];assert.ok(modes.includes(key) || params.includes(key),'不明な引数: '+key);
    if(params.includes(key)) assert.ok(process.argv[++i] && !process.argv[i].startsWith('--'),'引数の値が必要: '+key);
  }
  if(process.argv.includes('--report')) {console.log(JSON.stringify(listReport(JSON.parse(readFileSync(resolve(option('--report')),'utf8'))),null,2));return;}
  const magi=loadWorker(),fixed=await loadListFixtures(magi),scope=option('--scope','tools'),set=option('--set','tune');
  assert.ok(SCOPES.includes(scope) && ['tune','final'].includes(set));
  if(process.argv.includes('--check')) {console.log(JSON.stringify({frozen:fixed.manifest.frozen,queriesHash:fixed.manifest.files['queries.json'],summary:fixed.summary}));return;}
  if(process.argv.includes('--smoke-payload')) {
    const cases=[{scope:'tools',query:'画像の並びから動くGIFを作る',locale:'ja',answers:['tool:6'],filters:{category:'Converter'}},
      {scope:'game',query:'Play the voxel world with AI residents',locale:'en',answers:['game:8'],filters:{genre:'sandbox'}}];
    console.log(JSON.stringify({endpoint:magi.SITE_RANK.endpoint,cases:cases.map(q=>{
      const c=listCandidates(magi,fixed.locals[q.scope],q);
      return {scope:q.scope,threshold:magi.rankScopeConfig(q.scope).threshold,payload:plain(c.payload),expect:q.answers.map(id=>{const i=c.ids.indexOf(id);assert.ok(i>=0);return magi.rankId(i);})};
    })}));return;
  }
  const queries=fixed.data.queries.filter(q=>q.scope===scope && q.set===set),runs=Number(option('--runs','2'));
  assert.ok(Number.isSafeInteger(runs) && runs>=1 && runs<=2);
  const local=fixed.locals[scope],config=magi.rankScopeConfig(scope),thresholds=set==='tune'?[.3,.35,.4,.5,.6]:[config.threshold];
  const paths=['workers/magi2/personas.js','workers/magi2/site-search.js','workers/magi2/search-scope.js','workers/magi2/site-rank.js','config/ai-models.json'];
  const metadata={...gitState(),scope,set,queriesHash:fixed.manifest.files['queries.json'],annotator:fixed.data.annotator,source:fixed.data.source,
    generation:local.generation,candidate_hash:local.candidate_hash,revision:config.revision,threshold:config.threshold,thresholds,
    codeHash:sha(JSON.stringify(paths.map(p=>[p,sha(read(p))]))),modelAlias:magi.SITE_RANK.model.model};
  if(process.argv.includes('--plan')) {
    const bytes=queries.reduce((n,q)=>n+Buffer.byteLength(JSON.stringify(listCandidates(magi,local,q).payload)),0)*runs;
    console.log(JSON.stringify({...metadata,requests:queries.length*runs,payloadUTF8Bytes:bytes,conservativeInputUSD:bytes/1e6*.042,
      priceSource:'https://docs.typesafe.ai/models',priceChecked:'2026-10-12',keyAvailable:!!typesafeKey(magi.SITE_RANK.key)}));return;
  }
  assert.ok(process.argv.includes('--accuracy'),'--check / --plan / --smoke-payload / --accuracy / --report');
  const key=typesafeKey(magi.SITE_RANK.key);assert.ok(key,'Jevのキーが無い');
  mkdirSync(resolve(ROOT,'workers/.wrangler'),{recursive:true});
  const file=resolve(ROOT,'workers/.wrangler',`list-rank-${scope}-${set}-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
  const record={...metadata,started:new Date().toISOString(),queries,measurements:[],status:'running'};
  const save=()=>writeFileSync(file,JSON.stringify(record,null,2)+'\n');save();
  try {
    record.measurements=await measureAccuracy(magi,local,queries,{runs,thresholds,key,candidateProvider:listCandidates,
      onRow:(run,row)=>{let m=record.measurements.find(m=>m.run===run);if(!m){m={run,rows:[]};record.measurements.push(m);}m.rows.push(row);save();console.log(JSON.stringify({run,id:row.id,http:row.http,ms:row.jev_ms}));
        if(row.http===null && row.error) throw new Error('Jevへ接続できず測定を停止: '+row.error);
      }});
    record.status='complete';
  } catch(e) {record.measurements=e.measurements || record.measurements;record.status='failed';record.error=e.message;process.exitCode=1;}
  record.finished=new Date().toISOString();save();console.log(JSON.stringify({file,report:listReport(record)},null,2));
  if(set==='final' && !record.measurements.every(run=>listScores(queries,run.rows,config.threshold).pass)) process.exitCode=1;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {await main();} catch(e) {console.error(e.message);process.exitCode=1;}
}
