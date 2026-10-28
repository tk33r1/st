// GitHub/Cloudflare/メールへ接続するmain側の入口。PRや対象SHAのスクリプトは実行しない。
import {execFileSync} from 'node:child_process';
import {appendFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {githubClient,dailyRepository,dailyIssueNumber,commentOnce,notifyDaily,digest,dailyStatusText} from './magi2-daily-github.mjs';
import {cloudflareVersionReader} from './magi2-daily-cloudflare.mjs';
import {candidateChanges} from './magi2-daily-merge.mjs';
import {prepareRelease,finishRelease} from './magi2-daily-release.mjs';
import {gitRecovery} from './magi2-daily-recovery.mjs';
import {cleanVersionHistory} from '../../workers/magi2/version-history.js';

const reasonText={published:'公開と公開後確認が完了しました',no_worker_changes:'Workerの変更が無いため公開を省略しました',
  recovered:'公開後確認に失敗し、前の版へ戻して自動更新のコミットを取り消し、リモートへ反映しました',
  deployment_interrupted:'本人の公開による版の変更を検出しました。版の復元・コミットの取り消しは行いません',
  published_version_unknown:'公開した版IDを確定できません。推測で戻さず本人確認が必要です',
  rollback_failed:'前の版への復元に失敗したため、コミットの取り消しは行っていません',revert_conflict:'コミットの取り消しが完了していません',
  notification_failed:'通知が完了しなかったため、本人確認まで公開を停止します',
  push_failed:'取り消したコミットのリモートへの反映が完了していません',worker_validation_failed:'公開前のWorker検査に失敗しました',
  merge_unverified:'マージ結果を確定できません。本人確認が必要です',
  release_incomplete:'公開処理が完了していません',preparation_failed:'公開の準備に失敗しました',
  production_version_unavailable:'本番の版を取得できません。本人確認が必要です',
  rollback_target_unknown:'復元先の版を確定できません。本人確認が必要です',publication_failed:'公開後の確認に失敗しました',
  merge_base_not_ancestor:'マージ元のコミットが公開対象の履歴に含まれていません',
  previous_version_untracked_or_dirty:'本番の版に記録されたコミットが不明か、未コミットの変更が含まれています',
  previous_commit_missing:'本番の版のコミットがローカルの履歴にありません',previous_not_ancestor:'本番の版のコミットが公開対象の履歴に含まれていません',
  unpublished_model_configuration:'未公開のAIモデル設定が含まれています',unpublished_manual_worker_change:'本人による未公開のWorker変更が含まれています'};
export function releaseText(report) {
  return 'MAGI継続改善: '+(reasonText[report.reason]||'公開を停止しました。理由は実行記録を確認してください')+'。\n'
    +'PR: '+(report.number?'https://github.com/'+dailyRepository+'/pull/'+report.number:'未確認')+'\n'
    +'公開対象のコミット: '+(report.target||'未確認')+' / 提案元のコミット: '+(report.head||'未確認')+' / 基準のコミット: '+(report.base||'未確認')+'\n'
    +'出した版: '+(report.deployed_id||'未確認')+' / 戻す先の版: '+(report.previous_id||'未確認')+'\n'
    +'表示版: '+(report.version||'未確認')+' / Worker検査: '+dailyStatusText(report.checks.worker)+' / 公開: '+dailyStatusText(report.checks.deploy)+' / 公開確認: '+dailyStatusText(report.checks.publication)+'\n'
    +'前の版への復元: '+dailyStatusText(report.rollback)+' / コミットの取り消し: '+dailyStatusText(report.revert)+' / リモートへの反映: '+dailyStatusText(report.push)+'\n'
    +'取り消す自動更新のコミット（新しい順）: '+((report.rollback_commits||[]).join(', ')||'なし')+'\n'
    +(report.halt_required?'停止を維持します。未完了の操作と原因を本人が確認してから停止Issueを閉じてください。':'');
}
export async function haltRelease(client,report) {
  const marker='<!-- magi2-daily:halt:'+digest([report.target,report.head,report.deployed_id])+' -->';
  const issues=await client.pages('/issues?state=open&labels=magi2-daily-halt');
  const existing=issues.find(row=>!row.pull_request&&row.user?.login==='github-actions[bot]'&&row.body?.startsWith(marker));
  const body=marker+'\n'+releaseText(report);
  if(existing?.body===body)return existing.number;
  const value=await client.request(existing?'/issues/'+existing.number:'/issues',{
    method:existing?'PATCH':'POST',body:{body,...(existing?{}:{title:'MAGI継続改善の公開を停止',labels:['magi2-daily-halt']})}});
  return value.number;
}
export async function announceRelease({client,issue,report,mail=notifyDaily}) {
  const failures=[],attempt=async(name,operation)=>{try{await operation();}catch{failures.push(name);}};
  if(report.halt_required)await attempt('halt_issue',()=>haltRelease(client,report));
  const key=['release',report.target,report.head,report.deployed_id,report.reason];
  await attempt('issue_comment',()=>commentOnce(client,issue,key,releaseText(report)));
  if(report.outcome!=='skip')await attempt('mail',async()=>{
    const marker='<!-- magi2-daily:mail:'+digest(key)+' -->';
    const comments=await client.pages('/issues/'+issue+'/comments');
    if(comments.some(row=>row.user?.login==='github-actions[bot]'&&row.body?.startsWith(marker)))return;
    await mail(releaseText(report),key);
    await client.request('/issues/'+issue+'/comments',{method:'POST',body:{body:marker+'\n通知送信済み。'}});
  });
  if(failures.length)throw new Error('release_notification_failed:'+failures.join(','));
}

async function main(args) {
  if(args.length!==1||!['--prepare','--finish'].includes(args[0]))throw new Error('release_arguments');
  const merge=JSON.parse(process.env.DAILY_MERGE||'null');
  const readDeployment=()=>cloudflareVersionReader({accountId:process.env.CLOUDFLARE_ACCOUNT_ID,token:process.env.CLOUDFLARE_API_TOKEN,fetcher:fetch})();
  if(args[0]==='--prepare') {
    candidateChanges(process.cwd(),merge.base,merge.target);
    const release=await prepareRelease({merge,root:process.cwd(),readDeployment});
    const history=cleanVersionHistory(JSON.parse(execFileSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',
      'show',merge.target+':data/magi-versions.json'],{encoding:'utf8',maxBuffer:65536,stdio:['ignore','pipe','pipe']})));
    if(!history)throw new Error('release_version_invalid');release.version=history.versions[0].version;
    if(process.env.GITHUB_OUTPUT)appendFileSync(process.env.GITHUB_OUTPUT,'release='+JSON.stringify(release)+'\n'
      +'action='+release.plan.action+'\n'+'target='+merge.target+'\n'+'previous-id='+(release.previous?.id||'')+'\n');
    console.log(JSON.stringify(release));return;
  }
  const client=githubClient(process.env.GITHUB_TOKEN,{repository:process.env.GITHUB_REPOSITORY||dailyRepository});
  const release=JSON.parse(process.env.DAILY_RELEASE||'null')||{merge};
  const needs=JSON.parse(process.env.DAILY_RESULTS||'{}');
  const results={worker:needs.worker?.result,deploy:needs.deploy?.result,publication:needs.publication?.result,
    versionId:needs.deploy?.outputs?.['version-id']};
  const path=process.env.DAILY_REPORT;if(!path)throw new Error('release_report_required');
  const write=report=>writeFileSync(path,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  const recovery=gitRecovery({release,token:process.env.GITHUB_TOKEN});
  let latest;
  try {
    const report=await finishRelease({release,results,readDeployment,
      rollback:id=>execFileSync(process.execPath,['workers/node_modules/wrangler/bin/wrangler.js','rollback',id,
        '--config','workers/magi2/wrangler.toml','--yes','--message','MAGI daily recovery'],
        {stdio:['ignore','pipe','pipe'],maxBuffer:1048576,env:{...process.env,WRANGLER_SEND_METRICS:'false'}}),
      revert:()=>recovery.revert(),push:()=>recovery.push(),
      save:async report=>{latest=report;write(report);if(report.halt_required)try{await haltRelease(client,report);}catch{write({...report,halt_issue:'failure'});}},
      announce:report=>announceRelease({client,issue:dailyIssueNumber(process.env.MAGI2_DAILY_ISSUE),report}),
    });
    if(report.halt_required)process.exitCode=1;
    console.log(JSON.stringify(report));
  } catch(error){
    if(latest) {
      const failed={...latest,notification:'failure',halt_required:true,
        reason:latest.halt_required?latest.reason:'notification_failed'};
      write(failed);try{await haltRelease(client,failed);}catch{write({...failed,halt_issue:'failure'});}
      try{await commentOnce(client,dailyIssueNumber(process.env.MAGI2_DAILY_ISSUE),
        ['release_notification_failed',failed.target,failed.deployed_id],releaseText(failed));}catch{}
    }
    throw error;
  }
  finally{recovery.cleanup();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch(()=>{console.error('daily_release_failed');process.exitCode=1;});
