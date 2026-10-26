// 区分Aの判定と検証の正本。差分を読む段階ではPRのJS・設定・フックを実行しない。
import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdtempSync,rmSync,existsSync,mkdirSync} from 'node:fs';
import {resolve,join,relative,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {magiDisplayVersion} from './magi-version.mjs';
import {cleanVersionHistory,versionOrder as order,VERSION_HISTORY_LIMITS} from '../../workers/magi2/version-history.js';

const repo=fileURLToPath(new URL('../../',import.meta.url));
// 本番エントリの依存だけを宣言する。eval専用src/eval.jsは自動公開しない。
export const workerInputs=Object.freeze([
  'workers/magi2/src/index.js',
  ...['classification','languages','magi-mode','personas','privacy','qa-budget','research','search-scope',
    'site-rank','site-search','speech','versions','version-history'].map(name=>'workers/magi2/'+name+'.js'),
  'config/ai-models.json','data/magi-context.json','data/magi-versions.json','workers/magi2/wrangler.toml',
]);
export const isWorkerInput=path=>workerInputs.includes(path);
const isScreen=path=>['index.html','404.html'].includes(path)||/^(magi-app\/www\/|dj\/request\/)/.test(path);
const isTest=path=>/^\.github\/scripts\/(?:test-magi[^/]*\.(?:mjs|py)|magi-native-filesystem-fixture\.mjs|fixtures\/magi[^/]*\.(?:json|js))$/.test(path);
// 版のコミットで必ず変える6つと、PWAを変えたときだけ変えるキャッシュの2つ。
const versionRequired=['index.html','magi-app/www/app.js','magi-app/package.json','magi-app/package-lock.json',
  'magi-app/android/app/build.gradle','data/magi-versions.json'];
const versionFiles=[...versionRequired,'magi-app/www/sw.js','magi-app/www/index.html'];
const protectedFile=path=>/^\.github\/(?:workflows\/|magi2-daily\/)/.test(path)
  ||/^\.github\/scripts\/(?:test-)?magi2-daily-/.test(path)
  ||['.github/scripts/magi-version.mjs','.github/scripts/magi-eval-budget.mjs','config/ai-models.json',
    'workers/magi2/personas.js','workers/magi2/version-history.js','workers/magi2/wrangler.toml','workers/magi2/schema.sql'].includes(path)
  ||/^workers\/magi2\/migrations\//.test(path);
const inScope=path=>isScreen(path)||isTest(path)||isWorkerInput(path)
  ||['AGENTS.md','.github/JEV.md','.github/AI_MODELS.md','magi-app/README.md','workers/magi2/README.md'].includes(path)
  ||versionFiles.includes(path);
const upstream=/\b(?:workers\.tk\.st|magi2-eval\.tk\.st|tk\.st\/(?:magi2|search\/api|dj\/api)|api\.(?:openai|anthropic|deepseek|typesafe)\.(?:com|ai)|api\.fish\.audio)\b/i;
const externalLoad=/(?:\b(?:src|href)\s*=\s*["'](?:https?:)?\/\/|url\(\s*["']?(?:https?:)?\/\/|\b(?:fetch|import(?:Scripts)?)\s*\(?\s*["'](?:https?:)?\/\/|\bimport\b.*\bfrom\s*["'](?:https?:)?\/\/)/i;
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

export function nextVersion(current,used=[]) {
  if(typeof current!=='string'||order(current)===null)throw new Error('invalid_current_version');
  const series=current.split('.')[0]+'.'+current.split('.')[1][0];
  const values=[current,...used].filter(v=>typeof v==='string'&&order(v)!==null&&v.startsWith(series));
  const last=Math.max(...values.map(v=>order(v)%10));
  return last===9?null:series+(last+1);
}

export function validHistory(data) {
  return !!cleanVersionHistory(data)&&Buffer.byteLength(JSON.stringify(data))<=VERSION_HISTORY_LIMITS.max_bytes;
}

function newline(text) {
  const lf=(text.match(/\n/g)||[]).length,crlf=(text.match(/\r\n/g)||[]).length;
  return !lf?'none':!crlf?'lf':lf===crlf?'crlf':'mixed';
}
function cacheNumber(text) {return Number(text?.match(/magi-shell-v(\d+)/)?.[1]);}
function shellScripts(html) {
  return [...(html||'').matchAll(/<script\b[^>]*\bsrc=["'](?:\.\/)?([^"'?#]+\.js)(?:\?([^"'#]*))?["']/gi)]
    .filter(m=>!m[1].includes(':')&&!m[1].startsWith('/'))
    .map(m=>({path:m[1],version:new URLSearchParams(m[2]||'').get('v')}));
}
function shellVersions(sw,path) {
  return [...(sw||'').matchAll(/["']\.\/([^"'?#]+\.js)(?:\?([^"'#]*))?["']/g)]
    .filter(m=>m[1]===path).map(m=>new URLSearchParams(m[2]||'').get('v'));
}
function replaceOne(text,pattern,value) {
  if(text.match(new RegExp(pattern.source,'g'))?.length!==1)throw new Error('version_field_count');
  return text.replace(pattern,value);
}

function checkVersion(commit,expected,errors) {
  const fail=code=>errors.push({commit:commit.sha,code});
  if(!expected){fail('version_exhausted');return;}
  const paths=commit.files.map(f=>f.path);
  if(!versionRequired.every(p=>paths.includes(p))||paths.some(p=>!versionFiles.includes(p))){fail('version_files');return;}
  try {
    for(const {path,before,after} of commit.files) {
      if(before===null||after===null)throw new Error('version_file_missing');
      if(path==='index.html') {
        if(after!==replaceOne(before,/>ver \d{1,2}\.\d[1-9]?</,'>ver '+expected+'<'))throw new Error('version_home_only');
      } else if(path==='magi-app/www/app.js') {
        if(after!==replaceOne(before,/var APP_VERSION = '[^']+';/,"var APP_VERSION = '"+expected+"';"))throw new Error('version_app_only');
      } else if(path==='magi-app/android/app/build.gradle') {
        if(after!==replaceOne(before,/versionName "[^"]+"/,'versionName "'+expected+'"'))throw new Error('version_android_only');
      } else if(path==='magi-app/package.json'||path==='magi-app/package-lock.json') {
        const old=JSON.parse(before),value=JSON.parse(after);
        if(magiDisplayVersion(value.version)!==expected)throw new Error('version_package');
        value.version=old.version;
        if(path.endsWith('package-lock.json')) {
          if(magiDisplayVersion(value.packages[''].version)!==expected)throw new Error('version_lock');
          value.packages[''].version=old.packages[''].version;
        }
        if(!equal(old,value))throw new Error('version_package_only');
      } else if(path==='data/magi-versions.json') {
        const old=JSON.parse(before),value=JSON.parse(after),row=value.versions[0];
        if(!validHistory(value)||Buffer.byteLength(after)>VERSION_HISTORY_LIMITS.max_bytes||row.version!==expected||!equal(value.versions.slice(1),old.versions)
          ||!['ja','en'].every(lang=>row.changes[lang].length===2)
          ||/\b(?:Worker|SSE|Jev|OpenAI|Anthropic|DeepSeek|GPT|Claude|function)\b|関数|モデル名/i.test(JSON.stringify(row.changes)))throw new Error('version_history');
      } else if(path==='magi-app/www/sw.js') {
        const strip=s=>s.replace(/magi-shell-v\d+/g,'CACHE').replace(/app\.js\?v=\d{8}_\d+/g,'app.js?v=CACHE');
        if(strip(before)!==strip(after))throw new Error('version_sw_only');
      } else if(path==='magi-app/www/index.html') {
        if(before.replace(/app\.js\?v=\d{8}_\d+/g,'CACHE')!==after.replace(/app\.js\?v=\d{8}_\d+/g,'CACHE'))throw new Error('version_app_html_only');
      }
    }
  } catch(error){fail(error.message);}
}

// 固定の差分も実際のgit差分も同じ関数を通す。意味の不変・バグの根拠・人格の文言は人のレビューも要る。
export function inspectChanges({commits,baseFiles={},usedVersions=[]}) {
  const errors=[],state={...baseFiles};
  const fail=(commit,code,path)=>errors.push({commit:commit.sha,code,...(path?{path}:{})});
  if(!Array.isArray(commits)||!commits.length)return {ok:false,errors:[{code:'no_commits'}],worker:false,screens:false};
  const startVersion=baseFiles['data/magi-versions.json']&&JSON.parse(baseFiles['data/magi-versions.json']).versions[0].version;
  const expected=startVersion?nextVersion(startVersion,usedVersions):null;
  let versionCommits=0,fixes=0;
  for(const [i,commit] of commits.entries()) {
    const version=/^bump version \[magi2-daily\]$/.test(commit.message),files=commit.files;
    if(!/\[magi2-daily\]$/.test(commit.message))fail(commit,'commit_marker');
    if(!Array.isArray(files)||!files.length){fail(commit,'empty_commit');continue;}
    if(version){versionCommits++;if(i!==commits.length-1)fail(commit,'version_last');checkVersion(commit,expected,errors);}
    else fixes++;
    const body=files.filter(f=>!isTest(f.path)&&!f.path.endsWith('.md'));
    if(!version&&(body.length>4||body.reduce((n,f)=>n+f.added.length+f.removed.length,0)>60))fail(commit,'diff_size');
    for(const file of files) {
      const {path,before,after,added,removed}=file;
      if(!inScope(path)||protectedFile(path)||(!version&&/^magi-app\/(?:android\/|package)/.test(path))
        ||path==='data/magi-context.json'||path==='data/magi-versions.json'&&!version)fail(commit,'protected_path',path);
      if(file.binary||file.renamed)fail(commit,'binary_or_rename',path);
      if(before&&path.endsWith('.md')&&before.split('\n').slice(0,8).some(line=>/^実装済み/.test(line.trim())))fail(commit,'frozen_document',path);
      if(before&&after&&newline(before)!=='none'&&newline(after)!=='none'&&newline(before)!==newline(after))fail(commit,'line_endings',path);
      if(isTest(path)&&before!==null&&removed.length)fail(commit,'test_removal',path);
      // 意図までは判定できないので、ヘルパーのreturnも含めて追加行のreturnはBへ回す（安全側）。
      if(isTest(path)&&added.some(line=>/\b(?:skip|todo|return)\b|process\.exit|\.only\s*\(/.test(line)))fail(commit,'test_bypass',path);
      if(added.some(line=>upstream.test(line)))fail(commit,'production_endpoint',path);
      if(path==='index.html') {
        if(!version&&Buffer.byteLength(after||'')>Buffer.byteLength(before||''))fail(commit,'home_size',path);
        if(added.some(line=>externalLoad.test(line)))fail(commit,'external_asset',path);
      }
      state[path]=after;
    }
  }
  if(fixes>5||versionCommits>1||!fixes)errors.push({code:'commit_count'});
  if(versionCommits&&!commits.some(c=>!/^bump version /.test(c.message)&&c.files.some(f=>f.path==='index.html'
    ||f.path.startsWith('magi-app/www/')&&!['magi-app/www/sw.js','magi-app/www/index.html'].includes(f.path))))errors.push({code:'version_without_screen_fix'});
  const paths=commits.flatMap(c=>c.files.map(f=>f.path));
  // コミットを分けても同じ枝なら一緒に公開されるので、版のコミットを除いた枝全体で見る。
  const fixPaths=commits.filter(c=>!/^bump version /.test(c.message)).flatMap(c=>c.files.map(f=>f.path));
  if(fixPaths.some(isWorkerInput)&&fixPaths.some(isScreen))errors.push({code:'worker_and_screen'});
  if(paths.some(p=>p.startsWith('magi-app/www/'))) {
    const old=cacheNumber(baseFiles['magi-app/www/sw.js']),current=cacheNumber(state['magi-app/www/sw.js']);
    if(!Number.isSafeInteger(old)||current!==old+1)errors.push({code:'pwa_cache'});
    const html=state['magi-app/www/index.html'],sw=state['magi-app/www/sw.js'];
    const previous=shellScripts(baseFiles['magi-app/www/index.html']),scripts=shellScripts(html);
    for(const path of new Set([...previous,...scripts].map(s=>s.path))) {
      const before=previous.filter(s=>s.path===path),after=scripts.filter(s=>s.path===path),versions=shellVersions(sw,path);
      if(!after.length) {
        if(paths.includes('magi-app/www/'+path))errors.push({code:'pwa_asset_version',path});
        continue;
      }
      if(after.length!==1||!after[0].version||versions.length!==1||versions[0]!==after[0].version)
        errors.push({code:'pwa_asset_version',path});
      if(paths.includes('magi-app/www/'+path)&&before.some(s=>s.version===after[0].version))
        errors.push({code:'pwa_asset_not_bumped',path});
    }
  }
  return {ok:!errors.length,errors,worker:paths.some(isWorkerInput),screens:paths.some(isScreen),version:versionCommits?expected:null};
}

function git(root,args,options={}) {
  return execFileSync('git',['-c','core.hooksPath='+join(tmpdir(),'magi2-no-hooks'),'-c','core.fsmonitor=false',...args],
    {cwd:root,encoding:'utf8',maxBuffer:16*1024*1024,stdio:['ignore','pipe','pipe'],...options});
}
export function gitCommit(root,ref) {return git(root,['rev-parse','--verify','--end-of-options',ref+'^{commit}']).trim();}
export function deploymentMessage(root=repo) {
  const sha=gitCommit(root,'HEAD');
  const dirty=git(root,['diff','--name-only','-z','HEAD','--',...workerInputs])
    +git(root,['ls-files','--others','--exclude-standard','-z','--',...workerInputs]);
  return sha+(dirty?'-dirty':'');
}
function blob(root,sha,path) {
  try {const value=git(root,['show',sha+':'+path],{encoding:'buffer'});return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(value);}
  catch(error){if(error.status!==undefined&&/does not exist|exists on disk, but not in/.test(String(error.stderr)))return null;throw error;}
}
export function usedVersionsAt(root,base) {
  if(git(root,['rev-parse','--is-shallow-repository']).trim()==='true')throw new Error('full_history_required');
  const shas=git(root,['log','--format=%H',base,'--','data/magi-versions.json']).trim().split('\n').filter(Boolean);
  return shas.flatMap(sha=>JSON.parse(blob(root,sha,'data/magi-versions.json')).versions.map(row=>row.version));
}
export function readChanges(root,baseRef,headRef='HEAD') {
  const base=gitCommit(root,baseRef),head=gitCommit(root,headRef);
  const fork=git(root,['merge-base',base,head]).trim();
  const baseFiles=Object.fromEntries(versionFiles.map(path=>[path,blob(root,base,path)]));
  const commits=git(root,['rev-list','--reverse',fork+'..'+head]).trim().split('\n').filter(Boolean).map(sha=>{
    const parents=git(root,['rev-list','--parents','-n','1',sha]).trim().split(' ').slice(1);
    if(parents.length!==1)throw new Error('daily_merge_commit');
    const parent=parents[0],parts=git(root,['diff','--name-status','--no-renames','-z',parent,sha,'--']).split('\0');
    const files=[];
    for(let i=0;i<parts.length-1;i+=2) {
      const path=parts[i+1],before=blob(root,parent,path),after=blob(root,sha,path);
      const patch=git(root,['diff','--no-ext-diff','--no-textconv','--no-renames','--unified=0',parent,sha,'--',path]);
      let hunk=false;const added=[],removed=[];
      for(const line of patch.split('\n')) {
        if(line.startsWith('@@')){hunk=true;continue;}
        if(hunk&&line[0]==='+')added.push(line.slice(1));
        if(hunk&&line[0]==='-')removed.push(line.slice(1));
      }
      const tree=git(root,['ls-tree',sha,'--',path]);
      const special=tree&&!/^100(?:644|755) /.test(tree);
      files.push({path,before,after,added,removed,binary:!!special||/Binary files/.test(patch)||[before,after].some(v=>v?.includes('\0'))});
    }
    return {sha,message:git(root,['log','-1','--format=%s',sha]).trim(),files};
  });
  return {base,head,commits,baseFiles,usedVersions:usedVersionsAt(root,base)};
}

export function checkPlan(mode,paths=[]) {
  const node=process.execPath,python=process.env.PYTHON||'python',commands=[
    [node,'--test','--test-force-exit','.github/scripts/test-magi2.mjs'],
    [python,'-B','.github/scripts/test-magi-smoke.py'],
    [node,'--test','.github/scripts/test-magi-qa-budget.mjs'],
    [node,'--test','.github/scripts/test-magi-eval-budget.mjs'],
    [node,'--test','.github/scripts/test-magi2-daily-check.mjs'],
    [node,'--test','.github/scripts/test-magi2-daily-review.mjs'],
    [node,'--test','.github/scripts/test-magi2-daily-budget.mjs'],
    [node,'--test','.github/scripts/test-magi2-daily-control.mjs'],
    [python,'-B','.github/scripts/ai_models.py','check'],
  ];
  if(mode==='full'&&(paths.some(isScreen)||paths.some(p=>p.startsWith('data/'))))commands.push(['bash','build.sh']);
  if(mode==='full'&&paths.some(isScreen)) {
    const browser=new Set();
    if(paths.some(p=>p==='index.html'||p.startsWith('magi-app/www/')))for(const name of ['stream-browser','a3-browser','a4-browser','app-preview'])browser.add(name);
    if(paths.some(p=>p.startsWith('magi-app/www/')))for(const name of ['native-shell','app-header-browser','native-input-browser','native-background-browser','native-widget-browser'])browser.add(name);
    if(paths.includes('404.html'))browser.add('a5-browser');
    if(paths.some(p=>p.startsWith('dj/request/')))browser.add('stream-browser');
    for(const name of browser)commands.push([node,'.github/scripts/test-magi-'+name+'.mjs']);
  }
  for(const path of paths.filter(p=>isTest(p)&&/^\.github\/scripts\/test-/.test(p))) {
    const browser=/browser|preview|native-shell/.test(path);
    if(!commands.some(command=>command.includes(path))&&(!browser||mode==='full'))commands.push(
      path.endsWith('.py')?[python,'-B',path]:[node,'--test','--test-force-exit',path]);
  }
  return {commands,bundle:mode==='worker'||mode==='full'&&paths.some(isWorkerInput)};
}

export function assertBundleInputs(metadata,root=repo) {
  const actual=Object.keys(metadata.inputs).map(p=>relative(root,resolve(root,'workers/magi2',p)).split(sep).join('/'))
    .filter(p=>/^(?:workers\/magi2\/|config\/|data\/)/.test(p)).sort();
  const expected=workerInputs.filter(p=>!p.endsWith('wrangler.toml')).sort();
  if(!equal(actual,expected))throw new Error('worker_dependency_drift: '+JSON.stringify({actual,expected}));
}

function run(command,root) {
  console.log(command.join(' '));
  const result=spawnSync(command[0],command.slice(1),{cwd:root,stdio:'inherit',env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
  if(result.error)throw result.error;if(result.status!==0)throw new Error('check_failed: '+command[1]);
}
export function runChecks(mode,changes,root=repo) {
  const paths=[...new Set(changes?.commits.flatMap(c=>c.files.map(f=>f.path))||workerInputs)];
  // 新しいcheckoutでも、既存の予算テストが一時台帳を置けるようにする。
  mkdirSync(join(root,'workers/.wrangler'),{recursive:true});
  const temporary=mkdtempSync(join(tmpdir(),'magi2-daily-check-'));
  try {
    for(const path of paths) {
      if(!existsSync(join(root,path)))continue;
      if(/\.(?:js|mjs)$/.test(path))run([process.execPath,'--check',path],root);
      else if(path.endsWith('.json'))JSON.parse(readFileSync(join(root,path),'utf8'));
      else if(path.endsWith('.html')) {
        const html=readFileSync(join(root,path),'utf8');let i=0;
        for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
          if(/\bsrc\s*=|application\/ld\+json/.test(match[1]))continue;
          const file=join(temporary,'script-'+i+++'.js');writeFileSync(file,match[2]);run([process.execPath,'--check',file],root);
        }
      }
    }
    const plan=checkPlan(mode,paths);
    for(const command of plan.commands)run(command,root);
    if(plan.bundle) {
      const metadata=join(temporary,'metadata.json');
      run([process.execPath,'node_modules/wrangler/bin/wrangler.js','deploy','--config','magi2/wrangler.toml','--dry-run',
        '--outdir',join(temporary,'bundle'),'--metafile',metadata],join(root,'workers'));
      assertBundleInputs(JSON.parse(readFileSync(metadata,'utf8')),root);
    }
  } finally {rmSync(temporary,{recursive:true,force:true});}
}

async function main(args) {
  const flags=['--fast','--full','--worker','--mechanical','--next-version','--deployment-message'].filter(v=>args.includes(v));
  if(flags.length!==1)throw new Error('Choose exactly one checker mode.');
  const value=name=>{const i=args.indexOf(name);return i>=0?args[i+1]:undefined;};
  const root=resolve(value('--root')||repo),base=value('--base'),head=value('--head')||'HEAD',mode=flags[0].slice(2);
  if(mode==='deployment-message'){console.log(deploymentMessage(root));return;}
  if(mode!=='worker'&&!base)throw new Error('--base is required; use the main SHA at the start of inspection.');
  if(mode==='next-version') {
    const sha=gitCommit(root,base),data=JSON.parse(blob(root,sha,'data/magi-versions.json'));
    console.log(JSON.stringify({base:sha,version:nextVersion(data.versions[0].version,usedVersionsAt(root,sha))}));return;
  }
  const changes=mode==='worker'?null:readChanges(root,base,head);
  const report=changes?{base:changes.base,head:changes.head,...inspectChanges(changes)}:{ok:true};
  const output=value('--output');if(output)writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
  if(!report.ok){process.exitCode=1;return;}
  if(mode!=='mechanical')runChecks(mode,changes,root);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
