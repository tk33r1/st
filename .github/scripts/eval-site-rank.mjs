// 404 のサイト内検索の②（Jev）の評価（assets/site-search-design.md 10.4）。
// いまは評価セット（.github/site-search/rank-queries.json）の形式の検査だけ：
//   node .github/scripts/eval-site-rank.mjs --check
// 正解の ID は、手元の data/site-search.json から Worker と同じ関数（makeSitePages・rankTargets）で作った②の対象と照らす。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = p => readFileSync(join(root, p), 'utf8');
const QUERIES = '.github/site-search/rank-queries.json';
const TYPES = ['keyword', 'sentence', 'paraphrase', 'english', 'self', 'none'];
const SETS = ['tune', 'final'];
const BROWSER_MAX = 50; // ブラウザの1回の測定の上限（設計書 10.4）。final はこれ以内にして、事前の選び直しを要らなくする

// magi2 のファイルを test-magi2.mjs と同じやり方で1つにつないで読む（personas.js が JSON を import するので、Node の ESM では直接読めない）
function loadWorker() {
  const ctx = vm.createContext({ aiModels: JSON.parse(read('config/ai-models.json')),
    TextEncoder, TextDecoder, AbortController, URL, crypto: webcrypto, setTimeout, clearTimeout, console });
  const strip = s => s.replace(/^import .*;\r?\n/gm, '').replace(/export const /g, 'const ').replace(/export (?=(?:async )?function)/g, '');
  vm.runInContext(['languages.js', 'personas.js', 'site-search.js', 'site-rank.js'].map(f => strip(read('workers/magi2/' + f))).join('\n')
    + '\nglobalThis.magi = { SITE_RANK, makeSitePages, rankTargets, toRankCandidate, rankPayload, rankProbability };', ctx);
  return ctx.magi;
}

// Worker（handleSiteRank）が検索語から落とす文字：制御文字と < >
const droppedChar = c => { const n = c.codePointAt(0); return n < 0x20 || (n >= 0x7f && n <= 0x9f) || c === '<' || c === '>'; };
const workerQuery = q => Array.from(q).filter(c => !droppedChar(c)).join('').trim();
const isDate = s => /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;

export function checkQueries(data, targetIds, maxChars) {
  assert.deepEqual(Object.keys(data).sort(), ['queries', 'reviewed', 'version'], '最上位のキーは version・reviewed・queries');
  assert.equal(data.version, 1);
  assert.ok(data.reviewed === '' || isDate(data.reviewed), 'reviewed は空（未確認）か YYYY-MM-DD');
  assert.ok(Array.isArray(data.queries));
  const ids = new Set(), keys = new Set();
  for (const q of data.queries) {
    const at = `${q && q.id}: `;
    const extra = Object.keys(q).filter(k => !['id', 'set', 'scope', 'locale', 'type', 'query', 'answers', 'note'].includes(k));
    assert.deepEqual(extra, [], at + '知らないキー');
    assert.ok(typeof q.id === 'string' && /^site-[0-9]{3}$/.test(q.id) && !ids.has(q.id), at + 'id は site-NNN で重ならない');
    ids.add(q.id);
    assert.ok(SETS.includes(q.set), at + 'set');
    assert.equal(q.scope, 'site', at + 'scope は site だけ（Phase 2）');
    assert.ok(['ja', 'en'].includes(q.locale), at + 'locale');
    assert.ok(TYPES.includes(q.type), at + 'type');
    assert.ok(typeof q.query === 'string' && q.query === workerQuery(q.query), at + '検索語は Worker が直さない形で書く（制御文字・< >・前後の空白なし）');
    const len = Array.from(q.query).length;
    assert.ok(len >= 1 && len <= maxChars, at + `検索語は1〜${maxChars}文字`);
    // 同じ要求を重ねない（ブラウザの測定でキャッシュに当たらないように。tune と final の間でも重ねない）
    const key = JSON.stringify([q.scope, q.locale, q.query]);
    assert.ok(!keys.has(key), at + '同じ scope・locale・検索語が2つある');
    keys.add(key);
    assert.ok(Array.isArray(q.answers) && new Set(q.answers).size === q.answers.length, at + 'answers は重ならない配列');
    for (const a of q.answers) assert.ok(targetIds.has(a), at + `answers の ${a} は②の対象に無い`);
    assert.equal(q.type === 'none', q.answers.length === 0, at + '答えが空なのは type が none のときだけ');
    assert.ok(q.note === undefined || (typeof q.note === 'string' && q.note.trim()), at + 'note');
  }
  assert.ok(data.queries.length >= 60, '問い合わせは60件以上（PRD 7.1）');
  const summary = {};
  for (const set of SETS) {
    const rows = data.queries.filter(q => q.set === set);
    for (const type of TYPES) assert.ok(rows.some(q => q.type === type), `${set} に ${type} が無い`);
    const none = rows.filter(q => q.type === 'none').length;
    assert.equal(none, Math.round(rows.length * 0.2), `${set} の答えの無いものは20%`);
    summary[set] = { total: rows.length, ...Object.fromEntries(TYPES.map(t => [t, rows.filter(q => q.type === t).length])),
      en: rows.filter(q => q.locale === 'en').length };
  }
  assert.ok(summary.final.total <= BROWSER_MAX, `final はブラウザの1回の測定の上限（${BROWSER_MAX}件）以内`);
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== '--check') {
    console.error('使い方: node .github/scripts/eval-site-rank.mjs --check');
    process.exit(2);
  }
  const magi = loadWorker();
  const targets = magi.rankTargets({ raw: magi.makeSitePages(JSON.parse(read('data/site-search.json'))) });
  const summary = checkQueries(JSON.parse(read(QUERIES)), new Set(targets.map(p => p.id)), magi.SITE_RANK.query_max_chars);
  const data = JSON.parse(read(QUERIES));
  console.log(JSON.stringify({ ok: true, targets: targets.length, reviewed: data.reviewed || null, ...summary }));
}
