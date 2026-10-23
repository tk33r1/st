// 本番版の読み取りとWranglerの構造化出力。生成API・Cloudflareへの書き込みは行わない。
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {limitedJSON} from './magi2-daily-http.mjs';

const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
export function magiWorkerName() {
  const name=readFileSync(new URL('../../workers/magi2/wrangler.toml',import.meta.url),'utf8').match(/^name\s*=\s*"([a-z][a-z0-9-]*)"/m)?.[1];
  if(!name)throw new Error('cloudflare_worker_configuration');return name;
}
function activeVersion(result) {
  const row=result?.deployments?.[0];
  if(!row||!uuid(row.id)||!Array.isArray(row.versions)||row.versions.length!==1
    ||row.versions[0].percentage!==100||!uuid(row.versions[0].version_id))throw new Error('cloudflare_ambiguous_deployment');
  return {deployment_id:row.id,id:row.versions[0].version_id};
}

export function cloudflareVersionReader({accountId,token,fetcher,workerName=magiWorkerName()}={}) {
  if(!/^[a-f0-9]{32}$/i.test(accountId||'')||typeof token!=='string'||!token
    ||typeof fetcher!=='function'||workerName!==magiWorkerName())throw new Error('cloudflare_reader_configuration');
  const base='https://api.cloudflare.com/client/v4/accounts/'+accountId+'/workers/scripts/'+workerName;
  const get=async path=>{
    let response;
    try{response=await fetcher(base+path,{method:'GET',headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(10000)});}
    catch{throw new Error('cloudflare_transport_failed');}
    if(!response.ok){await response.body?.cancel().catch(()=>{});throw new Error('cloudflare_http_'+response.status);}
    let data;try{data=await limitedJSON(response,1048576);}catch{throw new Error('cloudflare_response_invalid');}
    if(data?.success!==true||!data.result)throw new Error('cloudflare_api_failed');return data.result;
  };
  return async()=>{
    const first=activeVersion(await get('/deployments'));
    const version=await get('/versions/'+first.id);
    if(version.id!==first.id)throw new Error('cloudflare_version_mismatch');
    const last=activeVersion(await get('/deployments'));
    if(last.deployment_id!==first.deployment_id||last.id!==first.id)throw new Error('cloudflare_deployment_changed');
    const message=version.annotations?.['workers/message'];
    // 任意のデプロイ注記はログへ転載せず、追跡に使うコミットとdirtyの印だけを返す。
    return {...first,message:typeof message==='string'&&/^[a-f0-9]{40}(?:-dirty)?$/.test(message)?message:null};
  };
}

export function wranglerPublishedVersion(text,workerName=magiWorkerName()) {
  if(typeof text!=='string'||text.length>1048576)throw new Error('wrangler_output_size');
  let rows;try{rows=text.trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));}
  catch{throw new Error('wrangler_output_invalid');}
  const deployed=rows.filter(row=>row.type==='deploy'&&row.worker_name===workerName);
  if(deployed.length!==1||deployed[0].version!==1||!uuid(deployed[0].version_id))throw new Error('wrangler_deployment_missing_or_ambiguous');
  return deployed[0].version_id;
}

async function main(args) {
  const mode=args[0];
  if(!['--read','--published'].includes(mode)||args.length%2!==1)throw new Error('cloudflare_cli_arguments');
  const keys=args.filter((_,i)=>i%2===1),allowed=mode==='--read'?['--expect-id','--expect-sha','--output']:['--file','--output'];
  if(keys.some(k=>!allowed.includes(k))||new Set(keys).size!==keys.length)throw new Error('cloudflare_cli_arguments');
  const value=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
  if(value('--expect-id')!==undefined&&!uuid(value('--expect-id'))||value('--expect-sha')!==undefined&&!sha(value('--expect-sha')))
    throw new Error('cloudflare_cli_expectation');
  let result;
  if(mode==='--published') {
    if(!value('--file'))throw new Error('wrangler_output_file_required');
    result={id:wranglerPublishedVersion(readFileSync(value('--file'),'utf8'))};
    if(process.env.GITHUB_OUTPUT)appendFileSync(process.env.GITHUB_OUTPUT,'version-id='+result.id+'\n');
  } else {
    result=await cloudflareVersionReader({accountId:process.env.CLOUDFLARE_ACCOUNT_ID,token:process.env.CLOUDFLARE_API_TOKEN,fetcher:fetch})();
    if(value('--expect-id')&&result.id!==value('--expect-id')||value('--expect-sha')&&result.message!==value('--expect-sha'))
      throw new Error('cloudflare_expectation_changed');
  }
  if(value('--output'))writeFileSync(value('--output'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify(result));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
