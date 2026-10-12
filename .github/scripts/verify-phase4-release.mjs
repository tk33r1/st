// 公開済みの生バイト列を正本・adapter・matcherで検査。AIへの要求は送らない。
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {runInNewContext} from 'node:vm';
import {createHash,webcrypto} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const option=(name,fallback)=>{const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1];};
const base=option('--base','https://tk.st'),out=resolve(option('--report','.github/scripts/.search-reading-env/work/release-bytes.json'));
assert.match(base,/^https:\/\/(?:tk\.st|[a-z0-9-]+\.st-dmt\.pages\.dev)$/);
const require=createRequire(import.meta.url),matcher=require('../../assets/japanese-search.js');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const report={started:new Date().toISOString(),base,commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  runtime:{},scopes:{},pass:false};
const cache=new Map();
async function bytes(path) {
  if(!cache.has(path))cache.set(path,(async()=>{const r=await fetch(base+path,{cache:'no-cache'});assert.ok(r.ok,path);return Buffer.from(await r.arrayBuffer());})());
  return cache.get(path);
}
try {
  for(const name of ['japanese-search.js','site-search.js','search-ui.js','search-data.js','search-ui.css','search-json-worker.js']) {
    const path='assets/'+name,actual=await bytes('/'+path),expected=execFileSync('git',['show','HEAD:'+path]);
    assert.equal(hash(actual),hash(expected),path+': Git正本と公開バイト列');report.runtime[path]=hash(actual);
  }
  const window={};runInNewContext(readFileSync('assets/search-data.js','utf8'),{window,crypto:webcrypto,TextDecoder,AbortController,
    setTimeout,clearTimeout,URL,fetch:async path=>new Response(await bytes(path))});
  for(const scope of ['site','nitori','retail','tools','game']) {
    const adapter=window.STSearchData.createAdapter(scope),source=await adapter.loadBase({cache:'no-cache'}),readings=await adapter.loadReadings(source,{cache:'no-cache'});
    const engine=matcher.prepare(source.records,adapter.fields,adapter.legacy);
    if(Array.isArray(readings))engine.attachReadingSets(readings);else engine.attachReadings(readings,source.sourceHash);
    assert.equal(engine.search('').total,source.records.length);
    for(const row of source.records)assert.ok(engine.search(row.title).rows.some(r=>r.id===row.id),scope+': '+row.id);
    if(scope==='site')for(const query of ['DJ','Thought','思索','人類踊狂計画'])assert.ok(engine.search(query).total,query);
    report.scopes[scope]={records:source.records.length,generation:source.generation,sourceHash:source.sourceHash || null,
      allTitles:true,readingsAttached:true};
  }
  for(const path of ['/tools/','/game/','/job/nitoridaily/','/job/retailtechdaily/']) {
    const html=(await bytes(path)).toString('utf8');
    for(const name of ['japanese-search','search-data','search-ui'])assert.ok(html.includes(name+'.js?v=20261012_6'),path+': '+name);
  }
  const r=await fetch(base+'/phase4-validation/missing/deep/');assert.equal(r.status,404);
  const html=await r.text();assert.ok(html.includes('site-tree'));assert.ok(html.includes('search-ui.js?v=20261012_6'));report.deep404=true;
  report.fetched=Object.fromEntries(await Promise.all([...cache].map(async([path,p])=>[path,{sha256:hash(await p),bytes:(await p).length}])));
  report.pass=true;console.log(JSON.stringify({pass:true,scopes:report.scopes,deep404:true}));
}catch(error){report.error=error.message;process.exitCode=1;console.error(error.message);}
finally{mkdirSync(dirname(out),{recursive:true});writeFileSync(out,JSON.stringify(report,null,2)+'\n');}
