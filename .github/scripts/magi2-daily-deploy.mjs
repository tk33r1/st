// 公開と戻しの事前判定。Gitを読むだけで、merge/deploy/rollback/revert/pushは実行しない。
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {workerInputs} from './magi2-daily-check.mjs';

const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const git=(root,...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],
  {cwd:root,encoding:'utf8',maxBuffer:16*1024*1024,stdio:['ignore','pipe','pipe']}).trim();
const paths=(root,base,head)=>git(root,'diff','--name-only','-z',base,head).split('\0').filter(Boolean);
function ancestor(root,base,head) {
  try{git(root,'merge-base','--is-ancestor',base,head);return true;}
  catch(error){if(error.status===1)return false;throw error;}
}

export function deploymentPlan({root=process.cwd(),target,mergeBase,previous}={}) {
  if(!sha(target)||!sha(mergeBase))throw new Error('deployment_full_sha_required');
  for(const ref of [target,mergeBase])git(root,'cat-file','-e',ref+'^{commit}');
  const blocked=reason=>({action:'blocked',reason,target,rollback_commits:[],execution_enabled:false});
  if(!ancestor(root,mergeBase,target))return blocked('merge_base_not_ancestor');
  const changed=paths(root,mergeBase,target).filter(p=>workerInputs.includes(p));
  if(!changed.length)return {action:'skip',reason:'no_worker_changes',target,rollback_commits:[],execution_enabled:false};
  if(!previous||typeof previous.id!=='string'||!previous.id.trim()||!sha(previous.message))return blocked('previous_version_untracked_or_dirty');
  try{git(root,'cat-file','-e',previous.message+'^{commit}');}catch{return blocked('previous_commit_missing');}
  if(!ancestor(root,previous.message,target))return blocked('previous_not_ancestor');
  const commits=git(root,'rev-list','--reverse',previous.message+'..'+target).split('\n').filter(Boolean);
  const revert=[];
  for(const commit of commits) {
    const [message,author,committer]=git(root,'show','-s','--format=%s%n%an%n%cn',commit).split('\n');
    const parent=git(root,'rev-list','--parents','-n','1',commit).split(' ')[1];
    // mergeの解消時に入った本人の変更も、最初の親との差分で拾う。
    const touched=parent?paths(root,parent,commit):git(root,'diff-tree','--root','--no-commit-id','--name-only','-r',commit).split('\n').filter(Boolean);
    const inputs=touched.filter(p=>workerInputs.includes(p)),daily=/\[magi2-daily\]$/.test(message);
    if(inputs.includes('config/ai-models.json'))return blocked('unpublished_model_configuration');
    const cardOnly=touched.length===1&&inputs[0]==='data/magi-context.json'
      &&author==='github-actions[bot]'&&committer==='github-actions[bot]';
    if(inputs.length&&!daily&&!cardOnly)return blocked('unpublished_manual_worker_change');
    if(daily&&!cardOnly)revert.unshift(commit);
  }
  return {action:'deploy',target,previous:{id:previous.id,sha:previous.message},changed,
    rollback_commits:revert,execution_enabled:false,
    limitation:'ローカルGitの事前判定だけ。main・版ID・レビューの再取得と認証済みActionsへの接続は別途必要。'};
}

export function deploymentVersionUnchanged(previous,current) {
  return !!previous&&!!current&&typeof previous.id==='string'&&previous.id===current.id&&previous.message===current.message;
}

// 状態は実行アダプターが確認した結果から渡す。自己申告JSONで本番操作を起動しない。
export function recoveryDecision({deployedId,currentId,rollback='not_run',revert='not_run',push='not_run'}={}) {
  const valid=value=>['not_run','success','failure'].includes(value);
  if(!valid(rollback)||!valid(revert)||!valid(push)||revert!=='not_run'&&rollback!=='success'
    ||push!=='not_run'&&revert!=='success')throw new Error('recovery_state');
  const halt=reason=>({next:'halt_and_notify',reason,halt_required:true,execution_enabled:false});
  if(rollback==='not_run') {
    if(typeof deployedId!=='string'||!deployedId||currentId!==deployedId)return halt('deployment_interrupted');
    return {next:'rollback',halt_required:true,execution_enabled:false};
  }
  if(rollback==='failure')return halt('rollback_failed');
  if(revert==='not_run')return {next:'revert_on_current_main',halt_required:true,execution_enabled:false};
  if(revert==='failure')return halt('revert_conflict');
  if(push==='not_run')return {next:'push_with_retry',halt_required:true,execution_enabled:false};
  return halt(push==='failure'?'push_failed':'recovered');
}

function main(args) {
  const names=['--plan','--target','--merge-base','--previous'];
  if(args.length!==7||args[0]!=='--plan'||args.filter((_,i)=>i%2===1).some(v=>!names.includes(v))
    ||new Set(args.filter((_,i)=>i%2===1)).size!==3)throw new Error('Use --plan --target <SHA> --merge-base <SHA> --previous <version.json>');
  const value=name=>args[args.indexOf(name)+1];
  const result=deploymentPlan({target:value('--target'),mergeBase:value('--merge-base'),previous:JSON.parse(readFileSync(value('--previous'),'utf8'))});
  console.log(JSON.stringify(result,null,2));if(result.action==='blocked')process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  try{main(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=1;}
