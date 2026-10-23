// 復旧専用の独立Git。本人の後続コミットを残し、trusted側のpush-with-retryだけを実行する。
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {deploymentPlan} from './magi2-daily-deploy.mjs';
import {dailyRepository} from './magi2-daily-github.mjs';

export function gitRecovery({release,token,remote='https://github.com/'+dailyRepository+'.git',
  pushScript=fileURLToPath(new URL('./push-with-retry.sh',import.meta.url))}) {
  let directory;
  const execute=(command,args,env=process.env)=>execFileSync(command,args,{cwd:directory,env,encoding:'utf8',
    maxBuffer:1048576,stdio:['ignore','pipe','pipe']});
  const git=(...args)=>execute('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',
    '-c','commit.gpgsign=false','-c','user.name=github-actions[bot]',
    '-c','user.email=41898282+github-actions[bot]@users.noreply.github.com',...args]);
  return {
    revert() {
      if(directory)throw new Error('recovery_already_started');
      directory=mkdtempSync(join(tmpdir(),'magi2-daily-recovery-'));
      git('init');git('remote','add','origin',remote);git('fetch','--no-tags','origin','main');
      git('checkout','-b','magi2-daily-recovery','FETCH_HEAD');
      const actual=deploymentPlan({root:directory,target:release.merge.target,mergeBase:release.merge.base,previous:release.previous});
      if(actual.action!=='deploy'||JSON.stringify(actual.rollback_commits)!==JSON.stringify(release.plan.rollback_commits))
        throw new Error('recovery_commits_changed');
      for(const commit of actual.rollback_commits) {
        try{git('revert','--no-edit',commit);}
        catch(error){try{git('revert','--abort');}catch{}throw error;}
      }
    },
    push() {
      if(!directory||typeof token!=='string'||!token)throw new Error('recovery_push_configuration');
      // URLやgit設定ファイルへトークンを保存しない。pull/rebase中もフックを無効にする。
      const env={...process.env},count=Number(env.GIT_CONFIG_COUNT||0);
      const config=[['core.hooksPath','/dev/null'],['core.fsmonitor','false'],['commit.gpgsign','false'],
        ['user.name','github-actions[bot]'],['user.email','41898282+github-actions[bot]@users.noreply.github.com'],
        ['http.https://github.com/.extraheader','AUTHORIZATION: basic '+Buffer.from('x-access-token:'+token).toString('base64')]];
      for(const [i,[key,value]] of config.entries()){env['GIT_CONFIG_KEY_'+(count+i)]=key;env['GIT_CONFIG_VALUE_'+(count+i)]=value;}
      env.GIT_CONFIG_COUNT=String(count+config.length);
      execute('bash',[pushScript],env);
    },
    cleanup(){if(directory)rmSync(directory,{recursive:true,force:true});},
  };
}
