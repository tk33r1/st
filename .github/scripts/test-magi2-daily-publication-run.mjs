import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {expectedPublication,runPublicationCheck} from './magi2-daily-publication-run.mjs';
import {cloudflareVersionReader} from './magi2-daily-cloudflare.mjs';
import {publicationRequests} from './magi2-daily-publication.mjs';

const id='11111111-1111-1111-1111-111111111111',deployment='22222222-2222-2222-2222-222222222222';
const row=version=>({version,date:'2026-10-23',changes:{ja:['表示を改善しました','操作を改善しました'],en:['Improved display','Improved controls']}});
const history={versions:[row('6.0')]};
async function fixture(run) {
  const root=mkdtempSync(join(tmpdir(),'magi2-publication-run-'));
  const git=(...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','commit.gpgsign=false',
    '-c','user.name=Synthetic test','-c','user.email=synthetic@example.invalid',...args],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  try {
    mkdirSync(join(root,'data'));writeFileSync(join(root,'data/magi-versions.json'),JSON.stringify(history));
    git('init','-b','main');git('add','.');git('commit','-m','published target');const target=git('rev-parse','HEAD');
    writeFileSync(join(root,'data/magi-versions.json'),JSON.stringify({versions:[row('6.1'),...history.versions]}));
    git('add','.');git('commit','-m','later manual change');
    return await run({root,git,target});
  } finally {rmSync(root,{recursive:true,force:true});}
}
test('公開する履歴はtargetのgitオブジェクトから読み、後続mainをcheckout・実行しない',()=>fixture(f=>{
  const head=f.git('rev-parse','HEAD');
  assert.deepEqual(expectedPublication({...f,id}),{id,sha:f.target,version:'6.0'});
  assert.equal(f.git('rev-parse','HEAD'),head);
  assert.equal(JSON.parse(readFileSync(join(f.root,'data/magi-versions.json'),'utf8')).versions[0].version,'6.1');
  assert.throws(()=>expectedPublication({...f,target:'HEAD',id}),/target_invalid/);
  assert.throws(()=>expectedPublication({...f,id:'untrusted'}),/target_invalid/);
}));
test('版取得アダプターから公開後確認までを模擬通信で接続し、CFの鍵を公開URLへ渡さない',()=>fixture(async f=>{
  const seen=[],token='SYNTHETIC_SECRET';
  const readDeployment=cloudflareVersionReader({accountId:'a'.repeat(32),token,fetcher:async(url,options)=>{
    seen.push(url);assert.ok(url.startsWith('https://api.cloudflare.com/'));assert.equal(options.headers.Authorization,'Bearer '+token);
    return Response.json({success:true,result:url.endsWith('/deployments')
      ?{deployments:[{id:deployment,versions:[{version_id:id,percentage:100}]}]}:{id,annotations:{'workers/message':f.target}}});
  }});
  const body={desc:{ja:'説明',en:'description'},context:{ja:'素材',en:'context'},theme:{ja:'テーマ',en:'theme'}};
  const report=await runPublicationCheck({...f,id,readDeployment,fetcher:async(url,options)=>{
    seen.push(url);assert.equal(options.headers.Authorization,undefined);assert.equal(options.redirect,'error');
    if(url.endsWith('/models'))return Response.json({personas:Object.fromEntries(['MELCHIOR-1','BALTHASAR-2','CASPER-3'].map(k=>[k,body])),
      synthesizer:body,privacy:{ja:[{text:'説明'}],en:[{text:'Description'}]}});
    const probe=publicationRequests().find(p=>p.url===url&&p.options.body===options.body);assert.ok(probe);
    return Response.json(['versions','legacy_versions'].includes(probe.name)?history:probe.name==='old_generation_rejected'
      ?{status:'failed',complete:false,reason:probe.code,results:[]}:{error:{code:probe.code}},{status:probe.status});
  }});
  assert.equal(report.ok,true);assert.equal(report.target,f.target);assert.equal(report.version,'6.0');
  assert.equal(report.version_id,id);assert.equal(seen.length,14);assert.doesNotMatch(JSON.stringify(report),/SECRET|description/);
}));
test('Actionsは呼び出し専用・読み取り権限で、失敗をcontinue-on-errorで合格にしない',()=>{
  const text=readFileSync('.github/workflows/magi2-daily-publication.yml','utf8');
  assert.match(text,/workflow_call:/);assert.doesNotMatch(text,/workflow_dispatch:|schedule:|pull_request:|pull_request_target:|continue-on-error/);
  assert.match(text,/permissions:\n  contents: read/);assert.doesNotMatch(text,/contents: write|issues: write|pull-requests: write|npm |wrangler |secrets: inherit/);
  assert.match(text,/ref: \$\{\{ github.sha \}\}/);assert.match(text,/persist-credentials: false/);
  assert.match(text,/fetch --no-tags origin "\$DAILY_TARGET"/);assert.doesNotMatch(text,/ref: \$\{\{ inputs.target-sha/);
  assert.match(text,/if: always\(\)/);assert.match(text,/retention-days: 7/);
});
test('共通公開は版照合とキー反映を同じ公開入口で行い、毎時処理には未接続',()=>{
  const core=readFileSync('.github/workflows/deploy-worker-core.yml','utf8');
  assert.match(core,/version-id: \$\{\{ steps.published.outputs.version-id \}\}/);
  assert.doesNotMatch(core,/secret put MAGI_ANTHROPIC_API_KEY/);
  assert.match(core,/EXPECTED_VERSION_ID: \$\{\{ inputs.expected-version-id \}\}/);
  assert.match(core,/node \.\.\/\.deploy-caller\/\.github\/scripts\/magi2-daily-deploy-worker.mjs/);
  assert.ok(core.indexOf('if [ "$DRY_RUN" = "true" ]')<core.indexOf('node ../.deploy-caller/.github/scripts/magi2-daily-deploy-worker.mjs'));
  assert.match(core,/WRANGLER_OUTPUT_FILE_PATH: \$\{\{ runner.temp \}\}\/worker-deployment.jsonl/);
  assert.match(core,/\.deploy-caller\/\.github\/scripts\/magi2-daily-cloudflare.mjs --published/);
  assert.match(core,/sparse-checkout:[\s\S]*\.github\/scripts\/magi2-daily-http.mjs/);
  assert.match(core,/sparse-checkout:[\s\S]*\.github\/scripts\/magi2-daily-deploy-worker.mjs/);
  const daily=readFileSync('.github/workflows/magi2-daily-merge.yml','utf8');
  assert.doesNotMatch(daily,/uses:.*magi2-daily-publication|uses:.*deploy-worker-core/);
});
