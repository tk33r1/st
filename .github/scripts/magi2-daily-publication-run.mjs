// main側のActionsが使う、A6公開後確認の実行入口。マージ・公開・戻しは行わない。
import {execFileSync} from 'node:child_process';
import {writeFileSync,appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {cloudflareVersionReader} from './magi2-daily-cloudflare.mjs';
import {verifyDailyPublication} from './magi2-daily-publication.mjs';
import {cleanVersionHistory} from '../../workers/magi2/version-history.js';

export function expectedPublication({root,target,id}) {
  if(!/^[a-f0-9]{40}$/.test(target||'')||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id||''))throw new Error('publication_target_invalid');
  const text=execFileSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','show',target+':data/magi-versions.json'],
    {cwd:root,encoding:'utf8',maxBuffer:65536,stdio:['ignore','pipe','pipe']});
  const history=cleanVersionHistory(JSON.parse(text));if(!history||history.versions[0].version==='earlier')throw new Error('publication_target_history');
  return {id,sha:target,version:history.versions[0].version};
}

export async function runPublicationCheck({root=process.cwd(),target,id,fetcher,readDeployment}={}) {
  const expected=expectedPublication({root,target,id});
  const report=await verifyDailyPublication({expected,fetcher,readDeployment});
  return {...report,target,version_id:id,version:expected.version};
}

async function main(args) {
  if(args.length!==0)throw new Error('Use DAILY_TARGET, DAILY_VERSION_ID and DAILY_REPORT environment variables');
  const reportPath=process.env.DAILY_REPORT;if(!reportPath)throw new Error('publication_report_required');
  const root=resolve(process.env.DAILY_TARGET_GIT_ROOT||process.cwd());
  let report;
  try {
    const readDeployment=cloudflareVersionReader({accountId:process.env.CLOUDFLARE_ACCOUNT_ID,token:process.env.CLOUDFLARE_API_TOKEN,fetcher:fetch});
    report=await runPublicationCheck({root,target:process.env.DAILY_TARGET,id:process.env.DAILY_VERSION_ID,fetcher:fetch,readDeployment});
  } catch{report={ok:false,cases:[],error:'publication_check_failed'};}
  writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  if(process.env.GITHUB_OUTPUT)appendFileSync(process.env.GITHUB_OUTPUT,'ok='+String(report.ok===true)+'\n');
  console.log(JSON.stringify(report));
  if(!report.ok)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch(()=>{console.error('publication_check_failed');process.exitCode=1;});
