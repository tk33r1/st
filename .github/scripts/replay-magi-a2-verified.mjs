// 保存済みの実本文とJSON応答を本番の組立てへ通す。意味の支持の合否は自動で付けない。
// --report=<評価JSON> --output=<workers/.wrangler内のJSON>。キー・実API・公開ページの再取得は不要。
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {verifiedResearchResult} from './magi-a2-verification.mjs';
const option=name=>process.argv.find(a=>a.startsWith('--'+name+'='))?.slice(name.length+3);
const reportPath=option('report'),output=option('output');
if(!reportPath||!output)throw new Error('--report and --output are required');
const root=fileURLToPath(new URL('../../workers/.wrangler/',import.meta.url)),path=resolve(output),rel=relative(root,path);
if(!rel||rel==='..'||rel.startsWith('..'+sep)||resolve(root,rel)!==path)throw new Error('Replay output must stay in workers/.wrangler');
const original=readFileSync(reportPath,'utf8'),report=JSON.parse(original),rows=[];
for(const r of report.results||[]){
  const proofs=r.calls?.filter(c=>c.verification_evidence&&c.verification_reply)||[];
  if(!proofs.length){rows.push({id:r.id,theme:r.theme,status:'missing_record'});continue;}
  for(const c of proofs){
    try{
      const value=JSON.parse(c.verification_reply),evidence=c.verification_evidence.evidence;
      const language=r.events?.find(e=>e.name==='classification')?.data.reply_language;
      const result=verifiedResearchResult(value,evidence,language);
      rows.push({id:r.id,theme:r.theme,provider:c.provider,status:'references_valid',reply:result,
        parts:value.parts.map(p=>({label:p.label,status:p.status,recorded_text:p.text,
          support:p.citations.map(c=>({n:c.n,blocks:c.blocks.map(id=>({id,text:evidence.find(e=>e.n===c.n).blocks.find(b=>b.id===id).text}))}))}))});
    }catch(error){rows.push({id:r.id,theme:r.theme,status:'invalid_record',code:error.message});}
  }
}
const summary={rows:rows.length,references_valid:rows.filter(r=>r.status==='references_valid').length,
  missing_record:rows.filter(r=>r.status==='missing_record').length,invalid_record:rows.filter(r=>r.status==='invalid_record').length,
  unverified_parts:rows.flatMap(r=>r.parts||[]).filter(p=>p.status==='unverified').length};
writeFileSync(path,JSON.stringify({date:new Date().toISOString(),scope:'recorded-reference-validation; semantic-support-not-auto-approved',
  source_report:reportPath,source_hash:createHash('sha256').update(original).digest('hex'),summary,rows},null,2)+'\n');
console.log(JSON.stringify(summary));
if(summary.invalid_record)process.exitCode=1;
