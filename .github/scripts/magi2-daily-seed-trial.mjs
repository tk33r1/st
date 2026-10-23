// 段3専用。仕込みbase宛のPRだけを検査・報告する。mainへのマージ・公開・復旧は行わない。
import {appendFileSync,readFileSync,writeFileSync,readdirSync,mkdirSync,realpathSync,lstatSync,existsSync,copyFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,dirname,resolve,relative,isAbsolute,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {githubClient,dailyRepository,dailyIssueNumber,eligibleDailyPR,commentOnce,notifyDaily} from './magi2-daily-github.mjs';
import {candidateChanges} from './magi2-daily-merge.mjs';
import {inspectChanges} from './magi2-daily-check.mjs';

export const seedBranch='automation/magi2-daily-seeded-base';
const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
export function eligibleSeedPR(pr,actor='tk33r1',label='magi2-daily-A') {
  return pr?.base?.ref===seedBranch&&eligibleDailyPR({...pr,base:{...pr.base,ref:'main'}},{actor,label});
}
export async function discoverSeedTrial({client,number,base,head,actor='tk33r1',changes=(base,head)=>candidateChanges(process.cwd(),base,head)}) {
  if(!Number.isSafeInteger(number)||number<1||!sha(base)||!sha(head))throw new Error('seed_trial_inputs');
  const pr=await client.request('/pulls/'+number),branch=await client.request('/branches/'+encodeURIComponent(seedBranch));
  const snapshot={number,base,head,selected:false,validate:false,reason:'ineligible'};
  const classification=eligibleSeedPR(pr,actor)?'A':eligibleSeedPR(pr,actor,'magi2-daily-B')?'B':null;
  if(!classification||pr.state!=='open'||pr.draft)return snapshot;
  snapshot.selected=true;snapshot.classification=classification;
  if(pr.head.sha!==head||branch.commit.sha!==base)return {...snapshot,reason:'snapshot_changed'};
  if(classification==='B')return {...snapshot,reason:'B_proposal'};
  const prs=await client.pages('/pulls?state=open&base='+encodeURIComponent(seedBranch));
  if(prs.filter(row=>eligibleSeedPR(row,actor)).length!==1)return {...snapshot,reason:'duplicate_or_missing_A'};
  let mechanical;
  try {
    const delta=changes(base,head);
    mechanical=inspectChanges(delta);
    // このfixtureは検査用のtrusted版に差し替えるため、候補からの変更は受理しない。
    if(delta.commits.some(c=>c.files.some(f=>f.path==='.github/scripts/fixtures/magi-versions-apk59.js')))
      mechanical={ok:false,errors:[{code:'trial_fixture_change'}]};
  } catch{mechanical={ok:false,errors:[{code:'trial_diff_unavailable'}]};}
  return {...snapshot,mechanical,validate:mechanical.ok,reason:mechanical.ok?'validate':'mechanical_failed'};
}

export function installSeedHarness({trustedRoot,candidateRoot}) {
  trustedRoot=realpathSync(trustedRoot);candidateRoot=realpathSync(candidateRoot);
  if(trustedRoot===candidateRoot)throw new Error('seed_trial_same_root');
  const scripts='.github/scripts',workflows='.github/workflows';
  const paths=[...readdirSync(join(trustedRoot,scripts)).filter(name=>/^(?:test-)?magi2-daily-.*\.mjs$/.test(name)
      ||['magi-version.mjs','magi-eval-budget.mjs','push-with-retry.sh'].includes(name)).map(name=>scripts+'/'+name),
    ...readdirSync(join(trustedRoot,workflows)).filter(name=>name.endsWith('.yml')).map(name=>workflows+'/'+name),
    scripts+'/fixtures/magi-versions-apk59.js'];
  const files=[];
  for(const path of paths) {
    const from=join(trustedRoot,path),to=join(candidateRoot,path);
    if(lstatSync(from).isSymbolicLink())throw new Error('seed_trial_harness_symlink');
    let ancestor=dirname(to);while(!existsSync(ancestor))ancestor=dirname(ancestor);
    const parent=relative(candidateRoot,realpathSync(ancestor));
    if(isAbsolute(parent)||parent==='..'||parent.startsWith('..'+sep)||existsSync(to)&&lstatSync(to).isSymbolicLink())
      throw new Error('seed_trial_harness_escape');
    mkdirSync(dirname(to),{recursive:true});
    copyFileSync(from,to);
    files.push({path,sha256:createHash('sha256').update(readFileSync(to)).digest('hex')});
  }
  return {files,limitation:'検査用の運用基盤だけをtrusted側から補充。点検入力や合否の証明へ流用しない。'};
}
export async function reportSeedTrial({client,snapshot,validation,issue,actor='tk33r1',runUrl,mail=notifyDaily}) {
  if(!snapshot.selected)return {reported:false,reason:'ineligible'};
  const pr=await client.request('/pulls/'+snapshot.number),branch=await client.request('/branches/'+encodeURIComponent(seedBranch));
  const prs=await client.pages('/pulls?state=open&base='+encodeURIComponent(seedBranch));
  const classification=snapshot.classification||'A',openA=prs.filter(row=>eligibleSeedPR(row,actor)).length;
  const label=classification==='B'?'magi2-daily-B':'magi2-daily-A';
  if(!eligibleSeedPR(pr,actor,label)||pr.state!=='open'||pr.draft||pr.head.sha!==snapshot.head||branch.commit.sha!==snapshot.base
    ||classification==='A'&&(snapshot.reason==='duplicate_or_missing_A'?openA<2:openA!==1))return {reported:false,reason:'snapshot_changed'};
  if(typeof runUrl!=='string'||!/^https:\/\/github\.com\/tk33r1\/st\/actions\/runs\/[1-9]\d*$/.test(runUrl))throw new Error('seed_trial_run_url');
  const codes=snapshot.mechanical?.errors?.map(row=>row.code)||[];
  const status=snapshot.validate?validation:snapshot.reason;
  const text='段3のActions試行: '+status+'\nPR: https://github.com/'+dailyRepository+'/pull/'+snapshot.number
    +'\nbase: '+snapshot.base+'\nhead: '+snapshot.head+'\n実行: '+runUrl+'\n機械的な理由: '+codes.join(', ')
    +'\nmainへのマージ・公開は行いません。Claudeの検出成績・正式レビューの合格には数えません。';
  const key=['seed_trial',snapshot.number,snapshot.base,snapshot.head,status];
  // 片方のGitHub書き込みが失敗しても、他の記録と必要なメールを試す。
  const failed=[];
  for(const [label,number] of [['pr',snapshot.number],['issue',issue]])
    try{await commentOnce(client,number,[...key,label],text);}catch{failed.push(label);}
  if(status==='failure'||snapshot.reason==='mechanical_failed'||classification==='B'&&!pr.labels.some(row=>row.name==='magi2-daily-notified')) {
    try {
      const marker='<!-- magi2-daily:seed-mail:'+createHash('sha256').update(JSON.stringify(key)).digest('hex')+' -->';
      const comments=await client.pages('/issues/'+snapshot.number+'/comments');
      if(!comments.some(row=>row.user?.login==='github-actions[bot]'&&row.body?.startsWith(marker))) {
        await mail(text,key);
        await client.request('/issues/'+snapshot.number+'/comments',{method:'POST',body:{body:marker+'\n通知送信済み。'}});
      }
      if(classification==='B')await client.request('/issues/'+snapshot.number+'/labels',{method:'POST',body:{labels:['magi2-daily-notified']}});
    }catch{failed.push('mail');}
  }
  if(failed.length)throw new Error('seed_trial_report_failed:'+failed.join(','));
  return {reported:true,status,merge_enabled:false};
}

async function main(args) {
  const value=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
  if(args[0]==='--harness') {
    const report=installSeedHarness({trustedRoot:resolve(value('--trusted')),candidateRoot:resolve(value('--candidate'))});
    writeFileSync(value('--output'),JSON.stringify(report,null,2)+'\n');return;
  }
  const client=githubClient(process.env.GITHUB_TOKEN,{repository:process.env.GITHUB_REPOSITORY||dailyRepository});
  const actor=process.env.MAGI2_DAILY_ACTOR||'tk33r1';
  if(args.length===1&&args[0]==='--discover') {
    const snapshot=await discoverSeedTrial({client,actor,number:Number(process.env.TRIAL_PR),base:process.env.TRIAL_BASE,head:process.env.TRIAL_HEAD});
    if(process.env.GITHUB_OUTPUT)appendFileSync(process.env.GITHUB_OUTPUT,'snapshot='+JSON.stringify(snapshot)+'\nvalidate='+snapshot.validate+'\n');
    console.log(JSON.stringify(snapshot));return;
  }
  if(args.length===1&&args[0]==='--report') {
    const result=await reportSeedTrial({client,actor,snapshot:JSON.parse(process.env.TRIAL_SNAPSHOT),validation:process.env.TRIAL_VALIDATION,
      issue:dailyIssueNumber(process.env.MAGI2_DAILY_ISSUE),runUrl:'https://github.com/'+dailyRepository+'/actions/runs/'+process.env.GITHUB_RUN_ID});
    console.log(JSON.stringify(result));return;
  }
  throw new Error('seed_trial_mode');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch(()=>{console.error('seed_trial_failed');process.exitCode=1;});
