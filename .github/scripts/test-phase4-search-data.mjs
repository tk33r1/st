// 生データのadapter→共通照合を、実際の生成物で検証する。外部通信なし。
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),matcher=require('../../assets/japanese-search.js');
const generated=process.argv[2];if(!generated) throw new Error('Usage: node test-phase4-search-data.mjs generated-directory');
const source=readFileSync('assets/search-data.js','utf8');
function load(mutate=()=>{}) {
  const calls=[],window={};
  runInNewContext(source,{window,crypto:webcrypto,TextDecoder,AbortController,setTimeout,clearTimeout,URL,
    fetch:async path=>{
      calls.push(path);assert.ok(/^\/(data\/(site-keyword|site-readings|tools|tools-readings|game|game-readings)\.json|job\/(nitoridaily|retailtechdaily)\/search-(index|readings)(?:-\d{4})?\.json)$/.test(path));
      const output=path.includes('readings') || path==='/data/site-keyword.json';let bytes=readFileSync(resolve(output?generated:'.',path.slice(1)));
      bytes=mutate(path,bytes) || bytes;return new Response(bytes);
    }});
  return {api:window.STSearchData,calls};
}
for(const scope of ['site','tools','game','nitori','retail']) {
  const w=load(),adapter=w.api.createAdapter(scope),options={cache:'default'},base=await adapter.loadBase(options),reading=await adapter.loadReadings(base,options);
  const engine=matcher.prepare(base.records,adapter.fields,adapter.legacy);
  if(Array.isArray(reading)) engine.attachReadingSets(reading);else engine.attachReadings(reading,base.sourceHash);
  assert.equal(engine.search('').total,base.records.length);
  for(const r of base.records) assert.ok(engine.search(r.title).rows.some(row=>row.id===r.id),r.title);
  const n=w.calls.length;assert.equal(await adapter.loadBase(options),base);assert.equal(w.calls.length,n,'通常の基礎取得はPromiseを共有');
  const refreshed=await adapter.loadBase({cache:'no-cache'});assert.equal(refreshed.generation,base.generation);assert.ok(w.calls.length>n);
  if(['tools','game'].includes(scope)) assert.ok(w.calls.every(path=>!path.includes('site-')),'一覧は全サイト索引を取得しない');
  if(scope==='site') for(const query of ['DJ','Thought','思索','人類踊狂計画']) assert.ok(engine.search(query).total,query);
  console.log(`${scope}: 実ソース→adapter→読み・ID順・全題名・共通照合を確認 (${base.records.length}件)`);
}
{
  const w=load((path,bytes)=>{
    if(path==='/job/nitoridaily/search-readings.json'){const d=JSON.parse(bytes);d.source_generation='ffff';return Buffer.from(JSON.stringify(d));}
  }),adapter=w.api.createAdapter('nitori'),base=await adapter.loadBase({});
  await assert.rejects(adapter.loadReadings(base,{}),error=>error.message==='reading_version');
}
{
  const w=load((path,bytes)=>{
    if(path==='/data/tools.json'){const d=JSON.parse(bytes);d[0].url='https://outside.example/tools/x/';return Buffer.from(JSON.stringify(d));}
  });await assert.rejects(w.api.createAdapter('tools').loadBase({}),error=>error.message==='search_base');
}
console.log('媒体generationの混在・外部URLを採用前に拒否');
