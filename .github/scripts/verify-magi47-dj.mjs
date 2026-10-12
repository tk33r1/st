// 変更前後のDJ回答を、本番のpickSongs/verifyRecommendationsでAppleの公開カタログに照合する。
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import vm from 'node:vm';
const dir=resolve('workers/.wrangler/magi47-quality'),cache=new Map();
const context=vm.createContext({window:{DJRequestCore:{timeoutSignal:ms=>AbortSignal.timeout(ms)}},fetch:async(url,options)=>{
 if(cache.has(url))return Response.json(cache.get(url));const r=await fetch(url,options);if(!r.ok)throw new Error('Catalogue HTTP failure');const value=await r.json();cache.set(url,value);return Response.json(value);
}});
vm.runInContext(readFileSync('dj/request/catalog.js','utf8'),context);
const catalog=context.window.DJRequestCatalog,report={date:new Date().toISOString(),sides:{}};
for(const side of ['baseline','candidate']){
 const input=JSON.parse(readFileSync(resolve(dir,side+'.json'),'utf8')),results=[];
 for(const c of input.results.filter(r=>r.kind==='dj')){const labels=catalog.pickSongs(c.answer),checked=await catalog.verifyRecommendations(labels);
  results.push({id:c.id,recommended:labels.length,checked:JSON.parse(JSON.stringify(checked))});
  console.log(JSON.stringify({side,id:c.id,labels:labels.length,states:checked.map(x=>x.state)}));}
 const all=results.flatMap(r=>r.checked);report.sides[side]={results,total:all.length,found:all.filter(r=>r.state==='ok').length,unknown:all.filter(r=>r.state==='unknown').length};
}
const a=report.sides.baseline,b=report.sides.candidate;report.delta=a.total&&b.total?b.found/b.total-a.found/a.total:null;
report.comparable=!!a.total&&!!b.total&&!a.unknown&&!b.unknown;
writeFileSync(resolve(dir,'dj-catalogue.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({delta:report.delta,comparable:report.comparable}));
