// 依存なし。画面・Worker・Androidの契約が食い違った状態をPagesのビルドでも拒否する。
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
export const matrix = ['normal-off', 'normal-on', 'temporary-off', 'temporary-on'];
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trim();
const input = p => p === 'index.html' || p === 'config/ai-models.json' || p === 'data/magi-context.json'
  || p === 'data/magi-versions.json' || p === '.node-version' || p === 'build.sh' || p === 'AGENTS.md'
  || /^(magi-app\/(www\/|android\/|scripts\/|package|capacitor)|workers\/magi2\/|\.github\/(workflows\/|scripts\/.*magi.*\.(mjs|py)$))/.test(p) && !p.endsWith('.md');

export function sourceFingerprint(revision) {
  const paths = (revision ? git('ls-tree', '-r', '--name-only', revision) : git('ls-files', '--cached', '--others', '--exclude-standard'))
    .split('\n').filter(input).sort();
  const hash = createHash('sha256');
  for (const p of paths) {
    const bytes = revision ? execFileSync('git', ['show', revision + ':' + p], {cwd: root, maxBuffer: 16 * 1024 * 1024}) : readFileSync(resolve(root, p));
    hash.update(p + '\0').update(sha256(bytes) + '\n');
  }
  return hash.digest('hex');
}

export function checkContract(read = p => readFileSync(resolve(root, p), 'utf8')) {
  const sets = ['index.html', 'magi-app/www/app.js'].map(p => {
    const list = read(p).match(/if \(!data \|\| (\[[^\]]+\])\.indexOf\(ev\) < 0\)/)?.[1];
    assert(list, '受信イベント一覧が見つからない: ' + p);
    return [...list.matchAll(/'([a-z_]+)'/g)].map(m => m[1]).sort();
  });
  const java = read('magi-app/android/app/src/main/java/st/tk/magi/MagiConversationService.java')
    .match(/event\.matches\("([a-z_|]+)"\)/)?.[1];
  assert(java, 'Androidのイベント選別が見つからない');
  const worker = [...new Set([...read('workers/magi2/src/index.js').matchAll(/\bsend\(\s*['"]([a-z_]+)['"]/g)].map(m => m[1]))].sort();
  assert(worker.includes('session') && worker.includes('done'), 'Workerの必須イベントがない');
  for (const names of [...sets, java.split('|').sort()]) {
    assert.equal(new Set(names).size, names.length, 'イベント重複');
    assert.deepEqual(names, worker, 'Worker・画面・Androidの受信イベントが不一致');
  }
  return worker;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(process.argv.includes('--fingerprint') ? {commit: git('rev-parse', 'HEAD'), fingerprint: sourceFingerprint()}
    : {pass: true, events: checkContract()}));
}
