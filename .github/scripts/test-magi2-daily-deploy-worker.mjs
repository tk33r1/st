import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,statSync,rmSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {deployMagiWorker} from './magi2-daily-deploy-worker.mjs';

const target='a'.repeat(40),id='11111111-1111-1111-1111-111111111111',key='SYNTHETIC_SECRET';
test('キーを先に公開せず、版照合の直後に同じdeployで反映し、一時ファイルを消す',async()=>{
  const events=[];let secretFile;
  await deployMagiWorker({target,expectedId:id,anthropicKey:key,readDeployment:async()=>{events.push('read');return {id};},run:args=>{
    events.push('deploy');secretFile=args.at(-1);
    assert.deepEqual(args,['deploy','--config','magi2/wrangler.toml','--message',target,'--secrets-file',secretFile]);
    assert.equal(statSync(secretFile).mode&0o777,0o600);
    assert.deepEqual(JSON.parse(readFileSync(secretFile,'utf8')),{MAGI_ANTHROPIC_API_KEY:key});
    assert.ok(!args.some(value=>value.includes(key)));return {status:0};
  }});
  assert.deepEqual(events,['read','deploy']);assert.equal(existsSync(secretFile),false);
});
test('前回の確認後に手動公開された版と照合失敗では、キーもコードも公開しない',async()=>{
  let deployments=0;
  for(const readDeployment of [async()=>({id:'22222222-2222-2222-2222-222222222222'}),async()=>{throw new Error('read failed');}]) {
    await assert.rejects(deployMagiWorker({target,expectedId:id,anthropicKey:key,readDeployment,run:()=>{deployments++;return {status:0};}}));
  }
  assert.equal(deployments,0);
});
test('手動公開もキーが必須で、コマンド失敗・例外でも一時ファイルを残さない',async()=>{
  for(const run of [()=>({status:1}),()=>({status:null,error:new Error('failed')}),()=>{throw new Error('failed');}]) {
    let secretFile;
    await assert.rejects(deployMagiWorker({target,anthropicKey:key,run:args=>{secretFile=args.at(-1);return run();}}));
    assert.equal(existsSync(secretFile),false);
  }
  for(const patch of [{target:'HEAD'},{anthropicKey:''},{expectedId:'bad'},{expectedId:id}])
    await assert.rejects(deployMagiWorker({target,anthropicKey:key,run:()=>assert.fail('must not deploy'),...patch}),/configuration/);
});
test('実行入口はキーをコマンド引数・子の環境へ渡さず、Wranglerへファイルだけを渡す',()=>{
  const root=mkdtempSync(join(tmpdir(),'magi2-deploy-worker-cli-'));
  try {
    const wrangler=join(root,'node_modules/wrangler/bin/wrangler.js'),record=join(root,'record.json');
    mkdirSync(dirname(wrangler),{recursive:true});
    writeFileSync(wrangler,`const fs=require('node:fs');
const args=process.argv.slice(2),file=args[args.indexOf('--secrets-file')+1];
const secrets=JSON.parse(fs.readFileSync(file,'utf8'));
fs.writeFileSync(process.env.SYNTHETIC_RECORD,JSON.stringify({args,file,hasKey:!!secrets.MAGI_ANTHROPIC_API_KEY,envKey:!!process.env.ANTHROPIC_API_KEY}));
`);
    const env={...process.env,DEPLOY_SHA:target,EXPECTED_VERSION_ID:'',ANTHROPIC_API_KEY:key,SYNTHETIC_RECORD:record};delete env.NODE_TEST_CONTEXT;
    execFileSync(process.execPath,[resolve('.github/scripts/magi2-daily-deploy-worker.mjs')],{cwd:root,env,stdio:['ignore','pipe','pipe']});
    const result=JSON.parse(readFileSync(record,'utf8'));
    assert.equal(result.hasKey,true);assert.equal(result.envKey,false);assert.equal(existsSync(result.file),false);
    assert.ok(!result.args.some(value=>value.includes(key)));
  } finally {rmSync(root,{recursive:true,force:true});}
});
