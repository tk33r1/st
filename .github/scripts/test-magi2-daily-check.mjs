import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {nextVersion,inspectChanges,isWorkerInput,readChanges,usedVersionsAt,checkPlan,workerInputs,assertBundleInputs,deploymentMessage,validHistory} from './magi2-daily-check.mjs';
import {cleanVersionHistory} from '../../workers/magi2/version-history.js';

const row=version=>({version,date:'2026-10-23',changes:{ja:['表示を改善しました','操作を改善しました'],en:['Improved display','Improved controls']}});
const baseFiles={
  'index.html':'<button class="magi-ver">ver 6.0</button>\n',
  'magi-app/www/app.js':"var APP_VERSION = '6.0';\nvar unused = 1;\n",
  'magi-app/package.json':JSON.stringify({version:'6.0.0',private:true}),
  'magi-app/package-lock.json':JSON.stringify({version:'6.0.0',packages:{'':{version:'6.0.0'}}}),
  'magi-app/android/app/build.gradle':'versionCode 60\nversionName "6.0"\n',
  'data/magi-versions.json':JSON.stringify({versions:[row('6.0')]}),
  'magi-app/www/sw.js':"var CACHE = 'magi-shell-v1';\nvar CORE = ['./app.js?v=20261023_1'];\n",
  'magi-app/www/index.html':'<script src="app.js?v=20261023_1"></script>\n',
};
function file(path,before='old\n',after='new\n') {
  const old=before===null?[]:before.split('\n'),value=after===null?[]:after.split('\n');let start=0,end=0;
  while(start<old.length&&start<value.length&&old[start]===value[start])start++;
  while(end<old.length-start&&end<value.length-start&&old.at(-end-1)===value.at(-end-1))end++;
  return {path,before,after,added:value.slice(start,end?value.length-end:undefined),removed:old.slice(start,end?old.length-end:undefined)};
}
const commit=(files,message='fix boundary [magi2-daily]')=>({sha:'synthetic',message,files});
const inspect=(files,message)=>inspectChanges({commits:[commit(files,message)],baseFiles});
const has=(result,code)=>result.errors.some(e=>e.code===code);

test('採番は系列とmainまでの使用済み番号を使い、戻した番号を再利用しない',()=>{
  for(const [current,used,expected] of [['5.9',[],'5.91'],['6.0',[],'6.01'],['5.9',['5.91'],'5.92'],
    ['6.08',[],'6.09'],['5.99',[],null],['5.98',['5.99'],null],['6.0',['5.99'],'6.01']])assert.equal(nextVersion(current,used),expected);
  assert.throws(()=>nextVersion('5.90'));
});
test('Workerと日次検査が同じ履歴の境界条件を使う',()=>{
  const valid={versions:[row('6.01'),row('6.0')]};
  assert.equal(validHistory(valid),true);assert.equal(cleanVersionHistory(valid),valid);
  for(const change of [d=>d.versions[0].changes.extra=[],d=>d.versions[0].changes.ja[0]='   ',
    d=>d.versions[0].changes.en[0]='a\u0001b',d=>d.versions[0].date='2026-02-30',
    d=>d.versions[0].version='6.00',d=>d.versions.reverse()]) {
    const value=structuredClone(valid);change(value);assert.equal(validHistory(value),false);assert.equal(cleanVersionHistory(value),null);
  }
});
test('機械的条件: 保護ファイル・範囲外・完了済み文書・印なしを落とす',()=>{
  for(const path of ['.github/workflows/a.yml','.github/magi2-daily/README.md','.github/scripts/magi2-daily-check.mjs',
    '.github/scripts/test-magi2-daily-check.mjs','workers/magi2/migrations/0003_a.sql','workers/magi2/schema.sql',
    'workers/magi2/personas.js','config/ai-models.json','data/magi-context.json','tools/test/index.html','magi-app/android/a.java']) {
    assert.ok(has(inspect([file(path)]),'protected_path'),path);
  }
  assert.ok(has(inspect([file('workers/magi2/README.md','# 記録\n\n実装済み（2026-10-23）。\n','new\n')]),'frozen_document'));
  assert.ok(has(inspect([file('workers/magi2/research.js')],'fix boundary'),'commit_marker'));
});
test('機械的条件: 両本体・61行・5ファイル・改行変換を落とす',()=>{
  assert.ok(has(inspect([file('workers/magi2/src/index.js'),file('magi-app/www/app.js')]),'worker_and_screen'));
  assert.ok(has(inspect([file('workers/magi2/research.js',null,Array(61).fill('line').join('\n'))]),'diff_size'));
  assert.ok(has(inspect(Array.from({length:5},(_,i)=>file('magi-app/www/a'+i+'.js'))),'diff_size'));
  assert.ok(has(inspect([file('workers/magi2/research.js','old\r\n','new\n')]),'line_endings'));
  assert.equal(inspect([file('workers/magi2/research.js','old\r\n','new\r\n')]).ok,true);
});
test('機械的条件: テストを消す・書き換える・飛ばす・本番の入口を足すと落ちる',()=>{
  for(const f of [file('.github/scripts/test-magi2.mjs','assert.ok(value);\n',''),
    file('.github/scripts/test-magi2.mjs','assert.ok(value);\n','assert.ok(true);\n'),
    file('.github/scripts/test-magi2.mjs',null,"test.skip('case',()=>{});\n"),
    file('.github/scripts/test-magi2.mjs',null,"fetch('https://workers.tk.st/magi2/models');\n")])assert.equal(inspect([f]).ok,false);
  assert.equal(inspect([file('workers/magi2/research.js'),file('.github/scripts/test-magi2.mjs',null,'assert.equal(value,1);\n')]).ok,true);
});
test('機械的条件: トップの肥大化・外部アセット・PWAキャッシュの据え置きを落とす',()=>{
  assert.ok(has(inspect([file('index.html','old','longer')]),'home_size'));
  assert.ok(has(inspect([file('index.html',null,'<script src="https://example.test/a.js"></script>')]),'external_asset'));
  assert.ok(has(inspect([file('magi-app/www/app.js')]),'pwa_cache'));
});
test('追加したモジュール直下のヘルパーのreturnは許し、テスト内の早期returnは拒否する',()=>{
  const path='.github/scripts/test-magi2.mjs';
  const helper="function fixture(value) {\n  return value + 1;\n}\nassert.equal(fixture(1),2);\n";
  assert.equal(inspect([file(path,null,helper)]).ok,true);
  assert.equal(inspect([file(path,null,"const helper = value => {\n  return value + 1;\n};\nassert.equal(helper(1),2);\n")]).ok,true);
  for(const source of ["test('case',()=>{ return; assert.ok(false); });\n",
    "test('case',()=>{ return true; assert.ok(false); });\n",
    "test('case',\nfunction callback() {\n return;\n});\n"])assert.ok(has(inspect([file(path,null,source)]),'test_bypass'));
  assert.ok(has(inspect([file(path,null,"test('case',()=>{\nconst helper = value => { return value; };\nreturn helper(1);\n});\n")]),'test_bypass'));
  assert.ok(has(inspect([file(path,null,"function helper() { test.skip('case',()=>{}); return 1; }\n")]),'test_bypass'));
  assert.ok(has(inspect([file(path,"function helper() {\n  assert.ok(value);\n}\n",
    "function helper() {\n  return value;\n  assert.ok(value);\n}\n")]),'test_bypass'));
  assert.ok(has(inspect([file(path,null,"new Request('https://workers.tk.st/magi2');\n")]),'production_endpoint'));
});
test('PWAのすべての版付きスクリプトで、HTMLとSWの版の一致と変更時の更新を検査する',()=>{
  for(const name of ['app','native-history','native-input','native-widget','native-background','app-theme','vendor/Readability']) {
    const html=`<script src="${name}.js?v=20261023_1"></script>\n`;
    const sw=`var CACHE = 'magi-shell-v1';\nvar CORE = ['./${name}.js?v=20261023_1'];\n`;
    const base={...baseFiles,'magi-app/www/index.html':html,'magi-app/www/sw.js':sw};
    const run=(h,s)=>inspectChanges({baseFiles:base,commits:[commit([
      file('magi-app/www/'+name+'.js','old\n','new\n'),file('magi-app/www/index.html',html,h),
      file('magi-app/www/sw.js',sw,s.replace('shell-v1','shell-v2'))]) ]});
    assert.ok(has(run(html,sw),'pwa_asset_not_bumped'),name);
    assert.ok(has(run(html.replace('_1','_2'),sw),'pwa_asset_version'),name);
    assert.equal(run(html.replace('_1','_2'),sw.replace('_1','_2')).ok,true,name);
    assert.ok(has(run(html.replace('?v=20261023_1',''),sw.replace('?v=20261023_1','')),'pwa_asset_version'),name);
  }
});
test('文書だけではWorkerを出さず、研究処理はWorkerの依存と判定する',()=>{
  const result=inspect([file('workers/magi2/README.md')]);assert.equal(result.ok,true);assert.equal(result.worker,false);
  assert.equal(isWorkerInput('workers/magi2/research.js'),true);assert.equal(isWorkerInput('workers/magi2/src/eval.js'),false);
  assert.equal(checkPlan('fast',workerInputs).bundle,false);assert.equal(checkPlan('worker').bundle,true);
  assert.ok(checkPlan('full',['404.html']).commands.some(c=>c.includes('build.sh')));
  assert.ok(checkPlan('full',['404.html']).commands.some(c=>c.includes('.github/scripts/test-magi-a5-browser.mjs')));
});
function versionCommit(version='6.01') {
  const after={...baseFiles};
  after['index.html']=after['index.html'].replace('6.0',version);
  after['magi-app/www/app.js']=after['magi-app/www/app.js'].replace("'6.0'","'"+version+"'");
  const npm='6.0.'+version.at(-1);
  after['magi-app/package.json']=JSON.stringify({version:npm,private:true});
  after['magi-app/package-lock.json']=JSON.stringify({version:npm,packages:{'':{version:npm}}});
  after['magi-app/android/app/build.gradle']=after['magi-app/android/app/build.gradle'].replace('"6.0"','"'+version+'"');
  after['data/magi-versions.json']=JSON.stringify({versions:[row(version),row('6.0')]});
  after['magi-app/www/sw.js']=after['magi-app/www/sw.js'].replace('v1','v2').replace('20261023_1','20261023_2');
  after['magi-app/www/index.html']=after['magi-app/www/index.html'].replace('20261023_1','20261023_2');
  return commit(Object.keys(after).map(path=>file(path,baseFiles[path],after[path])),'bump version [magi2-daily]');
}
test('最後の版のコミットだけは両本体を許し、採番・5か所・履歴・Codeを検査する',()=>{
  const fix=commit([file('magi-app/www/unused.js','var unused=1;\n','')]);
  const run=(version,usedVersions=[])=>inspectChanges({commits:[fix,version],baseFiles,usedVersions});
  assert.equal(run(versionCommit()).ok,true);
  assert.equal(run(versionCommit(),['6.01']).ok,false);
  assert.equal(inspectChanges({commits:[versionCommit(),fix],baseFiles}).ok,false);
  const bad=versionCommit();bad.files.find(f=>f.path.endsWith('build.gradle')).after=bad.files.find(f=>f.path.endsWith('build.gradle')).after.replace('versionCode 60','versionCode 601');
  assert.ok(has(run(bad),'version_android_only'));
  const missing=versionCommit();missing.files=missing.files.filter(f=>f.path!=='magi-app/package.json');assert.equal(run(missing).ok,false);
});

test('gitの履歴はbaseまでに固定し、PR自身と未マージの別枝を採番に含めない',()=>{
  const dir=mkdtempSync(join(tmpdir(),'magi2-daily-git-'));
  const git=(...args)=>execFileSync('git',['-c','core.hooksPath='+join(dir,'no-hooks'),'-c','commit.gpgsign=false','-c','tag.gpgsign=false',...args],{cwd:dir,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  const write=(path,value)=>{mkdirSync(dirname(join(dir,path)),{recursive:true});writeFileSync(join(dir,path),value);};
  try {
    git('init','-b','main');git('config','user.name','Synthetic test');git('config','user.email','synthetic@example.test');
    for(const [path,value]of Object.entries(baseFiles))write(path,value);
    write('workers/magi2/README.md','old\n');git('add','.');git('commit','-m','initial');const base=git('rev-parse','HEAD');
    write('workers/magi2/README.md','new\n');git('add','.');git('commit','-m','update docs [magi2-daily]');
    assert.equal(deploymentMessage(dir),git('rev-parse','HEAD'));
    write('workers/magi2/research.js','var test=1;\n');assert.ok(deploymentMessage(dir).endsWith('-dirty'));
    rmSync(join(dir,'workers/magi2/research.js'));
    const changes=readChanges(dir,base);assert.equal(changes.commits.length,1);assert.equal(inspectChanges(changes).ok,true);
    git('checkout','-b','other-main',base);write('AGENTS.md','manual change\n');git('add','.');git('commit','-m','manual update');
    const advanced=git('rev-parse','HEAD');git('checkout','main');
    const behind=readChanges(dir,advanced);assert.equal(behind.base,advanced);assert.equal(behind.commits.length,1);assert.equal(inspectChanges(behind).ok,true);
    git('checkout','-b','unmerged-version',base);write('data/magi-versions.json',JSON.stringify({versions:[row('6.09'),row('6.0')]}));
    git('add','.');git('commit','-m','unmerged version');git('checkout','main');
    assert.equal(nextVersion('6.0',usedVersionsAt(dir,'HEAD')),'6.01');
    write('data/magi-versions.json',JSON.stringify({versions:[row('6.01'),row('6.0')]}));git('add','.');git('commit','-m','draft version');
    assert.equal(nextVersion('6.0',usedVersionsAt(dir,base)),'6.01');
    const used=git('rev-parse','HEAD');git('revert','--no-edit',used);
    assert.equal(nextVersion('6.0',usedVersionsAt(dir,'HEAD')),'6.02');
  } finally {assert.equal(dirname(dir),resolve(tmpdir()));rmSync(dir,{recursive:true,force:true});}
});
test('本番Workerの静的import一覧と宣言を照合する',()=>{
  const root=resolve('.'),seen=new Set(),visit=path=>{
    if(seen.has(path))return;seen.add(path);
    if(!path.endsWith('.js'))return;
    const source=readFileSync(join(root,path),'utf8');
    for(const m of source.matchAll(/^import .* from ['"]([^'"]+)['"];?$/gm)) {
      const target=resolve(root,dirname(path),m[1]).slice(root.length+1).replaceAll('\\','/');visit(target);
    }
  };visit('workers/magi2/src/index.js');
  assert.deepEqual([...seen].sort(),workerInputs.filter(p=>!p.endsWith('wrangler.toml')).sort());
  const metadata={inputs:Object.fromEntries([...seen].map(p=>[p.startsWith('workers/magi2/')?p.slice(14):'../../'+p,{}]))};
  assert.doesNotThrow(()=>assertBundleInputs(metadata));
  metadata.inputs['unused.js']={};assert.throws(()=>assertBundleInputs(metadata),/drift/);
});
