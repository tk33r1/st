// 公開後は成否と版だけで判断する。通知や復旧のI/Oはmain側の実行入口が渡す。
import {deploymentPlan} from './magi2-daily-deploy.mjs';

const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const status=value=>['success','failure','cancelled','skipped'].includes(value)?value:'not_run';
export async function prepareRelease({merge,root,readDeployment,plan=deploymentPlan}) {
  if(merge?.state!=='merged')throw new Error('release_merge_required');
  // 文書だけなら本番の版も読まない。
  const initial=plan({root,target:merge.target,mergeBase:merge.base,previous:null});
  if(initial.action==='skip')return {merge,plan:initial};
  let previous;
  try{previous=await readDeployment();}
  catch{return {merge,plan:{action:'blocked',reason:'production_version_unavailable'}};}
  return {merge,previous,plan:plan({root,target:merge.target,mergeBase:merge.base,previous})};
}

export async function finishRelease({release,results,readDeployment,rollback,revert,push,save=async()=>{},announce}) {
  const report={target:release?.merge?.target||null,head:release?.merge?.head||null,base:release?.merge?.base||null,
    version:release?.version||null,checks:{worker:status(results?.worker),deploy:status(results?.deploy),publication:status(results?.publication)},
    number:release?.merge?.number||null,previous_id:release?.previous?.id||null,deployed_id:uuid(results?.versionId)?results.versionId:null,
    rollback_commits:(release?.plan?.rollback_commits||[]).filter(value=>/^[a-f0-9]{40}$/.test(value)),
    outcome:'halt',reason:'release_incomplete',rollback:'not_run',revert:'not_run',push:'not_run',halt_required:true};
  const persist=()=>save({...report});
  const done=async()=>{await persist();await announce({...report});return report;};
  if(release?.merge?.state!=='merged'){report.reason='merge_unverified';return done();}
  if(release.plan?.action==='skip') {
    report.outcome='skip';report.reason='no_worker_changes';report.halt_required=false;return done();
  }
  if(release.plan?.action!=='deploy'){report.reason=release.plan?.reason||'preparation_failed';return done();}
  if(results.worker!=='success'){report.reason='worker_validation_failed';return done();}
  if(!report.deployed_id){report.reason='published_version_unknown';return done();}
  let current;
  try{current=await readDeployment();}catch{report.reason='production_version_unavailable';return done();}
  if(current.id!==report.deployed_id||current.message!==report.target){report.reason='deployment_interrupted';return done();}
  if(results.deploy==='success'&&results.publication==='success') {
    report.outcome='success';report.reason='published';report.halt_required=false;return done();
  }
  if(!uuid(report.previous_id)){report.reason='rollback_target_unknown';return done();}
  report.reason='publication_failed';await persist();
  // 停止Issueの保存中にも手動公開が入り得る。rollbackの直前に再取得する。
  try{current=await readDeployment();}catch{report.reason='production_version_unavailable';return done();}
  if(current.id!==report.deployed_id||current.message!==report.target){report.reason='deployment_interrupted';return done();}
  try {
    await rollback(report.previous_id);
    const restored=await readDeployment();
    if(restored.id!==report.previous_id||restored.message!==release.previous.message)throw new Error('rollback_unverified');
    report.rollback='success';
  } catch{report.rollback='failure';report.reason='rollback_failed';return done();}
  await persist();
  try{await revert(release);report.revert='success';}
  catch{report.revert='failure';report.reason='revert_conflict';return done();}
  await persist();
  try{await push();report.push='success';report.reason='recovered';}
  catch{report.push='failure';report.reason='push_failed';}
  return done();
}
