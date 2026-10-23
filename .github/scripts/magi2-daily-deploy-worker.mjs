// キーの反映と公開を1回のdeployで行い、版照合の後に独立したsecret putを挟まない。
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {cloudflareVersionReader} from './magi2-daily-cloudflare.mjs';

export async function deployMagiWorker({target,expectedId='',anthropicKey,readDeployment,run}={}) {
  if(!/^[a-f0-9]{40}$/.test(target||'')||typeof expectedId!=='string'
    ||expectedId!==''&&!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(expectedId)
    ||typeof anthropicKey!=='string'||!anthropicKey.trim()||typeof run!=='function'
    ||expectedId!==''&&typeof readDeployment!=='function')throw new Error('magi_deploy_configuration');
  const directory=mkdtempSync(join(tmpdir(),'magi2-deploy-secrets-'));
  try {
    const file=join(directory,'secrets.json');
    writeFileSync(file,JSON.stringify({MAGI_ANTHROPIC_API_KEY:anthropicKey}),{mode:0o600});
    const args=['deploy','--config','magi2/wrangler.toml','--message',target,'--secrets-file',file];
    // この後に独立したキー同期や別ステップを挟まない。API照合と公開は原子的ではない。
    if(expectedId!==''&&(await readDeployment())?.id!==expectedId)throw new Error('cloudflare_expectation_changed');
    const result=run(args);
    if(result?.error||result?.status!==0)throw new Error('magi_deploy_failed');
  } finally {rmSync(directory,{recursive:true,force:true});}
}

async function main() {
  if(process.argv.length!==2)throw new Error('magi_deploy_arguments');
  const expectedId=process.env.EXPECTED_VERSION_ID||'';
  const env={...process.env};delete env.ANTHROPIC_API_KEY;
  await deployMagiWorker({target:process.env.DEPLOY_SHA,expectedId,anthropicKey:process.env.ANTHROPIC_API_KEY,
    readDeployment:expectedId===''?undefined:cloudflareVersionReader({accountId:env.CLOUDFLARE_ACCOUNT_ID,token:env.CLOUDFLARE_API_TOKEN,fetcher:fetch}),
    run:args=>spawnSync(process.execPath,['node_modules/wrangler/bin/wrangler.js',...args],{env,stdio:'inherit'}),
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main().catch(()=>{console.error('magi_deployment_failed');process.exitCode=1;});
