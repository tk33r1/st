// 段階1の発見・報告。PRのコードを動かすジョブの出力値や状態コメントを承認として使わない。
// レビュー経路と公開試行が未成立のため、この準備版にマージ・デプロイの操作は実装しない。
import {execFileSync} from 'node:child_process';
import {writeFileSync,appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {githubClient,dailyRepository,dailyIssueNumber,eligibleDailyPR,commentOnce,stateComment,notifyDaily} from './magi2-daily-github.mjs';
import {readChanges,inspectChanges} from './magi2-daily-check.mjs';

const labels=pr=>pr.labels.map(row=>row.name);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
export async function discover(client,{actor='tk33r1',root=process.cwd()}={}) {
  const prs=await client.pages('/pulls?state=open'),main=await client.request('/branches/main');
  if(!sha(main.commit.sha))throw new Error('invalid_main_sha');
  const a=prs.filter(p=>eligibleDailyPR(p,{actor}));
  const base=main.commit.sha;
  if(a.length!==1)return {base,head:null,number:null,mechanical:null,open_a:a.map(p=>p.number),reason:a.length?'duplicate_A':'no_A'};
  const pr=a[0];if(!sha(pr.head.sha))throw new Error('invalid_pr_head');
  execFileSync('git',['fetch','--no-tags','origin',base,pr.head.sha],{cwd:root,stdio:['ignore','pipe','pipe']});
  let mechanical;
  try{mechanical=inspectChanges(readChanges(root,base,pr.head.sha));}
  catch(error){mechanical={ok:false,errors:[{code:error.message.slice(0,300)}]};}
  return {base,head:pr.head.sha,number:pr.number,mechanical,open_a:[pr.number],reason:mechanical.ok?'validate':'mechanical_failed'};
}

async function notifyB(client,issue,pr,mail) {
  if(labels(pr).includes('magi2-daily-notified'))return;
  const key=['B',pr.number];
  const text='区分Bの本人確認: '+pr.html_url+'\n内容・メリット・デメリット・費用と送り先への影響をPRで確認してください。';
  await commentOnce(client,issue,key,text);
  await mail(text,key);
  await client.request('/issues/'+pr.number+'/labels',{method:'POST',body:{labels:['magi2-daily-notified']}});
}

export async function report(client,snapshot,{issue,actor='tk33r1',validation='skipped',stage='1',mail=notifyDaily}={}) {
  const prs=await client.pages('/pulls?state=open'),a=prs.filter(p=>eligibleDailyPR(p,{actor}));
  for(const pr of prs.filter(p=>eligibleDailyPR(p,{actor,label:'magi2-daily-B'}))) {
    // Bを先に付けた後に中断した移行を再開する。両ラベルがあるPRはAの候補にしない。
    if(labels(pr).includes('magi2-daily-A'))await client.request('/issues/'+pr.number+'/labels/magi2-daily-A',{method:'DELETE'});
    await notifyB(client,issue,pr,mail);
  }
  if(snapshot.open_a.length>1) {
    await commentOnce(client,issue,['duplicate_A',snapshot.open_a],
      '区分Aが複数あるため検証対象を選ばず、マージもしません。本人が不要なPRを閉じて1件にしてください。');return;
  }
  if(!snapshot.number)return;
  const pr=a.find(p=>p.number===snapshot.number);
  const main=await client.request('/branches/main');
  if(!pr||a.length!==1||pr.head.sha!==snapshot.head||main.commit.sha!==snapshot.base)return;
  const errors=snapshot.mechanical?.errors||[];
  if(!snapshot.mechanical?.ok||validation==='failure') {
    const reason=!snapshot.mechanical?.ok?'機械的な条件を外れました':'外部APIを呼ばない検証が失敗しました';
    await commentOnce(client,pr.number,['validation',snapshot.head,reason],reason+'。区分Bへ移して本人確認にします。\n\n'+JSON.stringify(errors));
    await client.request('/issues/'+pr.number+'/labels',{method:'POST',body:{labels:['magi2-daily-B']}});
    await client.request('/issues/'+pr.number+'/labels/magi2-daily-A',{method:'DELETE'});
    await notifyB(client,issue,{...pr,labels:[...pr.labels.filter(l=>l.name!=='magi2-daily-A'),{name:'magi2-daily-B'}]},mail);return;
  }
  const halts=await client.pages('/issues?state=open&labels=magi2-daily-halt');
  const state={version:1,head:snapshot.head,base:snapshot.base,next:'unconfigured',review_route:'unconfigured',
    validation,stage:String(stage),halt:halts.some(row=>!row.pull_request),rounds:0,
    merge_enabled:false,reason:'段0・交互レビュー経路・公開試行は未成立。現在は検証と採点のみ。'};
  await stateComment(client,pr.number,state);
  await commentOnce(client,issue,['review_route','unconfigured'],
    'ChatGPTの指定モデル・highと正式な実行記録を扱う経路は未設定です。提案・検証・採点は進めますが、Aをマージせず、レビューの依頼・ラウンド・24時間期限も始めません。');
}

async function main(args) {
  const client=githubClient(process.env.GITHUB_TOKEN,{repository:process.env.GITHUB_REPOSITORY||dailyRepository});
  const actor=process.env.MAGI2_DAILY_ACTOR||'tk33r1';
  if(args.includes('--discover')) {
    const snapshot=await discover(client,{actor,root:process.env.DAILY_GIT_ROOT||process.cwd()});
    const output=args[args.indexOf('--output')+1];if(!output||output.startsWith('--'))throw new Error('--output is required');
    writeFileSync(output,JSON.stringify(snapshot,null,2)+'\n');
    if(process.env.GITHUB_OUTPUT)appendFileSync(process.env.GITHUB_OUTPUT,'snapshot='+JSON.stringify(snapshot)+'\n'
      +'validate='+String(snapshot.mechanical?.ok===true)+'\n');
    console.log(JSON.stringify(snapshot));return;
  }
  if(args.includes('--report')) {
    const snapshot=JSON.parse(process.env.DAILY_SNAPSHOT||'null');if(!snapshot)throw new Error('snapshot_missing');
    await report(client,snapshot,{actor,issue:dailyIssueNumber(process.env.MAGI2_DAILY_ISSUE),
      validation:process.env.DAILY_VALIDATION||'skipped',stage:process.env.MAGI2_DAILY_STAGE||'1'});return;
  }
  throw new Error('Choose --discover or --report');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
