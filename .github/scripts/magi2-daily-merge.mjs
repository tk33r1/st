// main側だけで再取得・再判定し、GitHubのrebase mergeへ検証したheadを指定する。
import {execFileSync} from 'node:child_process';
import {appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {githubClient,dailyRepository,eligibleDailyPR} from './magi2-daily-github.mjs';
import {readChanges,inspectChanges} from './magi2-daily-check.mjs';
import {reviewState,mayMerge,claudeModelEvidence} from './magi2-daily-review.mjs';
import {readReviewEvidence} from './magi2-daily-review-source.mjs';

const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
export async function dailySettings(client) {
  const value=async(name,fallback)=>{
    try{return (await client.request('/actions/variables/'+name)).value;}
    catch(error){if(/^github_404_/.test(error.message))return fallback;throw error;}
  };
  return {stage:await value('MAGI2_DAILY_STAGE','1'),actor:await value('MAGI2_DAILY_ACTOR','tk33r1'),
    reviewOff:(await value('MAGI2_DAILY_REVIEW',''))==='off'};
}
export function candidateChanges(root,base,head) {
  execFileSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','fetch','--no-tags',
    'https://github.com/'+dailyRepository+'.git',base,head],{cwd:root,stdio:['ignore','pipe','pipe']});
  return readChanges(root,base,head);
}
const contents=changes=>changes.commits.map(({message,files})=>({message,files}));

export async function mergeCandidate({client,snapshot,validation,readSettings=()=>dailySettings(client),
  readReview=readReviewEvidence,changes=(base,head)=>candidateChanges(process.cwd(),base,head),onAttempt=()=>{}}) {
  const blocked=(reason,extra={})=>({state:'blocked',reason,number:snapshot?.number,...extra});
  if(!snapshot||!Number.isSafeInteger(snapshot.number)||snapshot.number<1||!sha(snapshot.head)||!sha(snapshot.base)
    ||validation!=='success'||snapshot.mechanical?.ok!==true)return blocked('validation');
  let settings;try{settings=await readSettings();}catch{return blocked('settings_unavailable');}
  if(settings.stage!=='2')return blocked('stage');
  const current=async()=>{
    const prs=await client.pages('/pulls?state=open'),pr=await client.request('/pulls/'+snapshot.number);
    const main=await client.request('/branches/main'),halts=await client.pages('/issues?state=open&labels=magi2-daily-halt');
    return {pr,main,halts,openA:prs.filter(p=>eligibleDailyPR(p,{actor:settings.actor})).length};
  };
  const first=await current();
  const evidence=await readReview({client,number:snapshot.number,head:snapshot.head,base:snapshot.base});
  const review=reviewState({...evidence,head:snapshot.head,base:snapshot.base});
  const check=state=>mayMerge({stage:settings.stage,halt:state.halts.some(row=>!row.pull_request),openA:state.openA,
    validation:true,head:snapshot.head,base:snapshot.base,currentHead:state.pr.head?.sha,currentBase:state.main.commit?.sha,
    open:state.pr.state==='open'&&!state.pr.draft,labelled:state.pr.labels?.some(row=>row.name==='magi2-daily-A'),
    eligible:eligibleDailyPR(state.pr,{actor:settings.actor}),
    claudeSettings:!!evidence.route?.routine_actor&&claudeModelEvidence(evidence.claude||[],snapshot.head,evidence.route.routine_actor),review,reviewOff:settings.reviewOff});
  let gate=check(first);if(!gate.allowed)return blocked('merge_gate',{reasons:gate.reasons,review:review.next});
  const original=changes(snapshot.base,snapshot.head);
  if(!inspectChanges(original).ok)return blocked('mechanical_changed');
  // GitHubがheadを受理する直前にも、段階・停止・head/baseを取り直す。
  const refreshed=await readSettings();
  if(JSON.stringify(refreshed)!==JSON.stringify(settings))return blocked('settings_changed');
  gate=check(await current());if(!gate.allowed)return blocked('snapshot_changed',{reasons:gate.reasons});
  const pending={state:'merge_unknown',number:snapshot.number,head:snapshot.head,base:snapshot.base,target:null};
  onAttempt(pending);
  let merged;
  try{merged=await client.request('/pulls/'+snapshot.number+'/merge',{method:'PUT',body:{sha:snapshot.head,merge_method:'rebase'}});}
  catch{return {...pending,reason:'merge_result_unknown'};}
  if(merged.merged!==true)return blocked('merge_refused');
  if(!sha(merged.sha))return {...pending,reason:'merge_target_unknown'};
  // mainの先頭を取り直して対象にしない。APIが返したマージ結果を固定する。
  const result={...pending,state:'merged',target:merged.sha};
  try {
    const actual=changes(snapshot.base,result.target);
    if(!inspectChanges(actual).ok||JSON.stringify(contents(actual))!==JSON.stringify(contents(original)))
      return {...result,state:'merge_invalid',reason:'merged_range_changed'};
  } catch{return {...result,state:'merge_invalid',reason:'merged_range_unverified'};}
  return result;
}
function output(value) {
  if(process.env.GITHUB_OUTPUT)appendFileSync(process.env.GITHUB_OUTPUT,'merge='+JSON.stringify(value)+'\n'
    +'merged='+String(value.state==='merged')+'\n'+'attempted='+String(value.state!=='blocked')+'\n');
  console.log(JSON.stringify(value));
}
async function main() {
  const client=githubClient(process.env.GITHUB_TOKEN,{repository:process.env.GITHUB_REPOSITORY||dailyRepository});
  output(await mergeCandidate({client,snapshot:JSON.parse(process.env.DAILY_SNAPSHOT||'null'),validation:process.env.DAILY_VALIDATION,
    onAttempt:output}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main().catch(()=>{console.error('daily_merge_failed');process.exitCode=1;});
