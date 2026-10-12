// 文字一致に救われたものを読みrecallへ混ぜない。入力値と全文を変更しない。
import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),search=require('../../assets/japanese-search.js');
const file=process.argv[2],data=JSON.parse(readFileSync(file,'utf8'));
const literal=search.prepare(data.records),engine=search.prepare(data.records).attachReadings(data.payload,data.sourceHash);
const rows=data.cases.map((c,index)=>{
  const variants=c.readings.map(reading=>({reading,inputs:[reading,reading.slice(0,2)].map(query=>({query,
    literal:literal.search(query).rows.some(r=>r.id===c.id),matched:engine.search(query).rows.some(r=>r.id===c.id),
    readingReached:data.payload.terms.some(t=>search.prefixes(query).some(p=>t.reading.startsWith(p)) && t.postings.some(([i])=>i===index))}))}));
  return {id:c.id,text:c.text,kind:c.kind,field:c.field,variants,pass:variants.some(v=>v.inputs.every(i=>i.readingReached && i.matched))};
});
const report={set:data.set,fixture_sha256:data.fixture_sha256,analyzer:data.payload.analyzer,
  normalization_revision:data.payload.normalization_revision,source_sha256:data.sourceHash,unknown:data.unknown,
  total:rows.length,passed:rows.filter(r=>r.pass).length,rows};
report.recall=report.passed/report.total;report.pass=report.recall>=.95;
writeFileSync(file.replace(/\.json$/,'.report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({set:report.set,passed:report.passed,total:report.total,recall:report.recall,pass:report.pass,
  failures:rows.filter(r=>!r.pass).map(r=>({id:r.id,text:r.text})),unknown:report.unknown}));
if(!report.pass) process.exitCode=1;
