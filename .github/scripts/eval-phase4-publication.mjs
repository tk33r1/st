// 本番の新入口で固定final 40問を各1回確認。評価キーはファイルからだけ読む。
// 通常公開後は --key-file を省略できる。失敗を自動で再送しない。
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {loadWorker} from './eval-site-rank.mjs';
import {loadListFixtures} from './eval-list-rank.mjs';
const option=(name,fallback)=>{const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1];};
const keyFile=option('--key-file',null),out=resolve(option('--report','.github/scripts/.search-reading-env/work/rank-publication.json'));
const key=keyFile?JSON.parse(readFileSync(resolve(keyFile),'utf8')).SITE_RANK_EVAL_KEY:null;
if(keyFile)assert.match(key,/^[a-f0-9]{64}$/);
const endpoint='https://tk.st/search/api/rank',magi=loadWorker(),fixed=await loadListFixtures(magi);
const report={started:new Date().toISOString(),endpoint,evaluationGate:!!key,queriesHash:fixed.manifest.files['queries.json'],
  annotator:fixed.data.annotator,requests:0,searchRequests:0,probes:[],scopes:{},pass:false};
mkdirSync(dirname(out),{recursive:true});
const save=()=>writeFileSync(out,JSON.stringify(report,null,2)+'\n');
async function post(body,authorized=true) {
  const start=performance.now();report.requests++;
  const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://tk.st',
    ...(authorized && key?{'x-api-key':key}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(8000)});
  const payload=await response.json();return {http:response.status,ms:performance.now()-start,payload};
}
const request=(scope,generation,q)=>({search_contract:1,mode:'rank',scope,generation,query:q.query,locale:q.locale,filters:q.filters});
try {
  const indexResponse=await fetch('https://tk.st/data/site-search.json');assert.ok(indexResponse.ok);const index=await indexResponse.text();
  magi.hooks.fetch=async url=>{assert.equal(url,'https://tk.st/data/site-search.json');return new Response(index);};
  const publication=await magi.fetchSiteLists();
  for(const scope of ['tools','game']) {
    const response=await fetch('https://tk.st/data/'+scope+'.json');assert.ok(response.ok);const text=await response.text();
    assert.deepEqual(JSON.parse(text),JSON.parse(readFileSync('.github/site-search/phase4/rank/'+scope+'.json','utf8')),'公開正本と固定候補');
    const snapshot=magi.makeListSnapshot(scope,text,publication),generation=await magi.snapshotHash(snapshot),config=magi.rankScopeConfig(scope);
    const queries=fixed.data.queries.filter(q=>q.scope===scope && q.set==='final'),urlToId=new Map(snapshot.raw.map(p=>[p.url,p.id]));
    const record=report.scopes[scope]={generation,candidateHash:await magi.rankCandidateHash(snapshot),threshold:config.threshold,
      revision:config.revision,rows:[],summary:null};
    if(key) {
      const probe=await post(request(scope,generation,queries[0]),false);
      assert.equal(probe.http,200);assert.equal(probe.payload.reason,'disabled');assert.equal(probe.payload.searched,null);
      report.probes.push({scope,case:'ordinary request disabled before release',http:probe.http,reason:probe.payload.reason});save();
    }
    const invalid=await post({...request(scope,generation,queries[0]),filters:{unknown:'x'}});
    assert.equal(invalid.http,400);assert.equal(invalid.payload.reason,'invalid_request');assert.equal(invalid.payload.searched,null);
    report.probes.push({scope,case:'invalid filter',http:invalid.http,reason:invalid.payload.reason});save();
    for(const q of queries) {
      report.searchRequests++;
      const result=await post(request(scope,generation,q)),r=result.payload;
      if(!['results','no_results'].includes(r.status))report.lastFailure={id:q.id,http:result.http,payload:r};
      assert.equal(result.http,200,q.id+': HTTP');assert.ok(['results','no_results'].includes(r.status),q.id+': '+r.reason);
      assert.equal(r.complete,true);assert.equal(r.searched.scope,scope);assert.equal(r.searched.generation,generation);
      assert.deepEqual(r.searched.filters,q.filters);assert.equal(r.searched.judged,r.searched.candidates);
      const allowed=new Set(magi.filterRankItems(snapshot,scope,q.filters).map(p=>p.id));
      const ids=r.results.map(row=>{const id=urlToId.get(row.url);assert.ok(allowed.has(id),q.id+': scope/filter外');return id;});
      const candidateIds=magi.shortlistRankItems(magi.filterRankItems(snapshot,scope,q.filters),q.query,scope).map(row=>row.p.id);
      record.rows.push({id:q.id,http:result.http,ms:result.ms,status:r.status,complete:r.complete,cached:r.cached,
        candidates:r.searched.candidates,judged:r.searched.judged,ids,answers:q.answers,required:q.required,
        candidateReached:!q.answers.length || q.answers.some(id=>candidateIds.includes(id))});
      save();console.log(q.id+': '+r.status+' ('+result.ms.toFixed(1)+'ms)');
    }
    const positive=record.rows.filter(r=>r.answers.length),none=record.rows.filter(r=>!r.answers.length),required=positive.filter(r=>r.required);
    const hit=positive.filter(r=>r.ids.slice(0,5).some(id=>r.answers.includes(id))).length,
      reached=positive.filter(r=>r.candidateReached).length,requiredReached=required.filter(r=>r.candidateReached).length,
      shown=none.filter(r=>r.ids.length).length;
    record.summary={positive:positive.length,hit,reached,required:required.length,requiredReached,none:none.length,shown,
      positiveExtras:positive.filter(r=>r.ids.some(id=>!r.answers.includes(id))).map(r=>r.id),
      p95:record.rows.map(r=>r.ms).sort((a,b)=>a-b)[Math.ceil(record.rows.length*.95)-1],
      pass:hit/positive.length>=.95 && reached/positive.length>=.95 && requiredReached===required.length && shown===0};
    assert.ok(record.summary.pass,scope+': fixed final条件');
    const mismatch=await post(request(scope,'0'.repeat(64),queries[0]));
    assert.equal(mismatch.http,200);assert.equal(mismatch.payload.reason,'index_updating');assert.equal(mismatch.payload.complete,false);
    report.probes.push({scope,case:'generation mismatch',http:mismatch.http,reason:mismatch.payload.reason});save();
  }
  report.pass=true;
} catch(error) {report.error=error.message;process.exitCode=1;console.error(error.message);}
finally {report.finished=new Date().toISOString();save();console.log(JSON.stringify({pass:report.pass,requests:report.requests,
  searchRequests:report.searchRequests,scopes:Object.fromEntries(Object.entries(report.scopes).map(([s,r])=>[s,r.summary]))}));}
