// 404 のサイト内検索の②（Jev）の評価（assets/site-search-design.md 10.4・10.5）。
//   --check                  評価セット（.github/site-search/rank-queries.json）の形式の検査
//   --hash                   手元と本番の索引の index_hash・candidate_hash を並べる（T3.6・T3.7 の照合）
//   --smoke-payload          週次の smoke（ai_models.py）が送る要求（決まった3問）を JSON で出す。npm の依存を読まない
//   --accuracy [--set tune|final] [--runs 2]
//                            Jev を直接呼んで精度を測る（MAGI_TYPESAFE_API_KEY。Worker の回数・キャッシュに当たらない）
//   --report <生の記録>        精度の生の記録から、まとめを Jev を呼び直さずに出し直す
//   --browser [--set final]  本物のブラウザから本番の Worker へ送り、送信から応答本文までを測る（Playwright）
//   --probe                  測定の前に、ブラウザから本番の②へ評価セットに無い1問を送り、有効か・届くかだけを見る
// 候補の変換・要求の組み立て・判定・並べ方・URL の検査は Worker の関数をそのまま使い、ここに別の変換や問いを書かない。
// キーは出力しない。生の記録は workers/.wrangler/（Git の管理外）に書く。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = p => readFileSync(join(root, p), 'utf8');
const QUERIES = '.github/site-search/rank-queries.json';
const INDEX_URL = 'https://tk.st/data/site-search.json';
const RANK_URL = 'https://workers.tk.st/magi2/site-search';
const RAW_DIR = 'workers/.wrangler';
const TYPES = ['keyword', 'sentence', 'paraphrase', 'english', 'self', 'none'];
const SETS = ['tune', 'final'];
// 正解を付けた人（PRD 7.1。誰が付けたかを記録に残す）
const ANNOTATORS = { claude: 'Claude が付けた正解。本人は確かめていない', owner: '本人が付けた正解' };
const THRESHOLDS = [0.3, 0.35, 0.4, 0.5, 0.6]; // 比べる閾値（PRD 7.1）
const PASS = { hit: 0.8, shown: 0.15 };        // リリースの条件（PRD 7.1）：上位5件に正解80%以上、答えの無いもので結果15%以下
const BROWSER_MAX = 50; // ブラウザの1回の測定の上限（設計書 10.4）。final はこれ以内にして、事前の選び直しを要らなくする
const P95_MAX_MS = 1500;
const BROWSER_TIMEOUT_MS = 8000; // 画面（assets/site-search.js）の期限（設計書 5.2）。これを超えた結果は利用者に出せないので、測定でも時間切れ
const PROBE_QUERY = 'サイト内検索の評価の疎通確認'; // 評価セット・smoke と重ねない
// smoke の決まった3問（評価セットとは重ねない）。期待するページが閾値以上に入ることを確かめる
const SMOKE = [
  { query: 'PDFを結合したい', locale: 'ja', expect: ['tool:7'] },
  { query: 'create a QR code', locale: 'en', expect: ['tool:10'] },
  { query: 'ハーレーのモトブログ', locale: 'ja', expect: ['page:motovlog'] },
];

const between = (s, start, end) => {
  const i = s.indexOf(start), j = s.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, `取り出す範囲が見つからない: ${start}`);
  return s.slice(i, j);
};

// magi2 のファイルを test-magi2.mjs と同じやり方で1つにつないで読む（personas.js が JSON を import するので、Node の ESM では直接読めない）。
// Worker の fetch は hooks.fetch に差し替える（索引の取得と Jev）
export function loadWorker() {
  const hooks = { fetch: () => { throw new Error('fetch is not hooked'); } };
  const ctx = vm.createContext({ aiModels: JSON.parse(read('config/ai-models.json')), Response,
    TextEncoder, TextDecoder, AbortController, URL, crypto: webcrypto, setTimeout, clearTimeout, console,
    fetch: (...args) => hooks.fetch(...args) });
  const strip = s => s.replace(/^import .*;\r?\n/gm, '').replace(/export const /g, 'const ').replace(/export (?=(?:async )?function)/g, '');
  vm.runInContext(['languages.js', 'personas.js', 'site-search.js', 'site-rank.js'].map(f => strip(read('workers/magi2/' + f))).join('\n')
    + '\nglobalThis.magi = { SITE_RANK, makeSitePages, fetchSiteLists, rankTargets, toRankCandidate, rankPayload, rankProbability,'
    + ' rankSearch, rankCandidateHash, snapshotHash, rankId, rankSiteUrl, rankQuery, clearRankCache: () => rankCache.clear() };', ctx);
  return Object.assign(ctx.magi, { hooks });
}

// 索引の本文から、Worker と同じ処理（fetchSiteLists）でスナップショットを作る
async function snapshotOf(magi, text) {
  magi.hooks.fetch = async url => { assert.equal(url, INDEX_URL); return new Response(text, { status: 200 }); };
  const snapshot = await magi.fetchSiteLists();
  const targets = magi.rankTargets(snapshot);
  return { snapshot, targets, rankReady: snapshot.rankReady,
    indexHash: await magi.snapshotHash(snapshot), candidateHash: await magi.rankCandidateHash(snapshot),
    urlToId: new Map(targets.map(p => [p.url, p.id])) };
}
async function productionIndex() {
  const res = await fetch(INDEX_URL, { headers: { 'Cache-Control': 'no-cache' } });
  assert.ok(res.ok, `本番の索引が取れない（HTTP ${res.status}）`);
  return res.text();
}

const isDate = s => /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;

// rankQuery は Worker の正規化（site-rank.js）。評価セットは Worker が直さない形で書く
export function checkQueries(data, targetIds, maxChars, rankQuery) {
  assert.deepEqual(Object.keys(data).sort(), ['annotator', 'frozen', 'queries', 'version'], '最上位のキーは version・frozen・annotator・queries');
  assert.equal(data.version, 1);
  assert.ok(data.frozen === '' || isDate(data.frozen), 'frozen は空（未固定）か YYYY-MM-DD');
  assert.ok(typeof data.annotator === 'string' && Object.hasOwn(ANNOTATORS, data.annotator), `annotator は ${Object.keys(ANNOTATORS).join('・')} のどれか`);
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
    assert.ok(typeof q.query === 'string' && q.query === rankQuery(q.query), at + '検索語は Worker が直さない形で書く（制御文字・< >・前後の空白なし）');
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

// 評価セットを読み、形式を検査する。measure なら正解の固定（frozen）が無ければ止まる（正解は結果を見る前に決める）
function loadQueries(magi, targets, measure, given = null) {
  const data = given || JSON.parse(read(QUERIES));
  const summary = checkQueries(data, new Set(targets.map(p => p.id)), magi.SITE_RANK.query_max_chars, magi.rankQuery);
  if (measure && !data.frozen) fail('正解を固定してから測る（rank-queries.json の frozen に日付を書く。設計書 10.4）');
  return { data, summary };
}

function fail(message) { console.error(message); process.exit(1); }
function option(name, fallback) {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : process.argv[i + 1];
}
function typesafeKey(name) {
  const placeholder = v => !v || /^x+$/.test(v) || /^sk-x+$/.test(v);
  for (const v of [process.env[name], process.env.TYPESAFE_API_KEY]) if (!placeholder(v)) return v;
  let text = '';
  try { text = read('workers/magi2/.dev.vars'); } catch (_) { return null; }
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i < 0 || line.slice(0, i).trim() !== name) continue;
    let v = line.slice(i + 1).trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1);
    return placeholder(v) ? null : v;
  }
  return null;
}
function gitState() {
  const git = args => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout.trim();
  return { commit: git(['rev-parse', 'HEAD']), dirty: git(['status', '--porcelain']) !== '' };
}
function writeRaw(kind, record) {
  mkdirSync(join(root, RAW_DIR), { recursive: true });
  const file = `${RAW_DIR}/site-rank-${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(join(root, file), JSON.stringify(record, null, 2));
  return file;
}
const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
};
const pct = (n, d) => d ? `${n}/${d}（${Math.round(n / d * 100)}%）` : '-';

// 答えのある問い合わせで上位5件に正解が入る割合と、答えの無い問い合わせで結果を出した割合。
// 失敗（時間切れ・判定の欠け・上限など）も分母に残す（PRD 7.1）
function score(queries, resultOf) {
  const answered = queries.filter(q => q.answers.length), none = queries.filter(q => !q.answers.length);
  const rows = queries.map(q => ({ q, r: resultOf(q) }));
  const hit = rows.filter(({ q, r }) => q.answers.length && r.ids.slice(0, 5).some(id => q.answers.includes(id))).length;
  const shown = rows.filter(({ q, r }) => !q.answers.length && r.ids.length).length;
  const failed = rows.filter(({ r }) => r.status === 'failed');
  const reasons = {};
  for (const { r } of failed) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
  return { hit, answered: answered.length, shown, none: none.length, failed: failed.length, reasons,
    avgResults: rows.reduce((n, { r }) => n + r.ids.length, 0) / rows.length,
    pass: hit / answered.length >= PASS.hit && shown / none.length <= PASS.shown };
}
const scoreRow = (label, s) => `| ${label} | ${pct(s.hit, s.answered)} | ${pct(s.shown, s.none)} | ${s.failed}${s.failed ? ' ' + JSON.stringify(s.reasons) : ''} | ${s.avgResults.toFixed(1)} | ${s.pass ? '合格' : '-'} |`;
const SCORE_HEAD = '| 方式 | 上位5件に正解 | 答えの無いもので結果 | 失敗 | 平均表示件数 | 条件 |\n| --- | ---: | ---: | --- | ---: | --- |';

// いまの「含む」検索：404.html の searchItems をそのまま取り出して動かす（書き写さない）。tools・game・glitch が対象
export function containsSearch() {
  const src = read('404.html');
  const ctx = vm.createContext({ URL });
  vm.runInContext('var arrivedSection = "";\n' + between(src, 'function safeDecode(', 'var displayedPath') + '\n'
    + between(src, 'function validatedHref(', 'function suggestions(') + '\n' + between(src, 'var sources = [', '\n')
    + '\nglobalThis.contains = { adapt, searchItems, sources };', ctx);
  const items = ctx.contains.sources.flatMap(([section, kind, path], i) => ctx.contains.adapt(JSON.parse(read(path.slice(1))), section, kind, i * 1000000));
  return query => ctx.contains.searchItems(items, query).slice(0, 5).map(item => item.key);
}

// 測る方式と閾値。tune は方式と閾値を比べる（PRD 7.1）：personas.js に文面のある問いの言語 × 基準の有無
// （基準なしは personas.js の問いから criteria を外しただけ）と、THRESHOLDS。final は確定した設定（question_language の
// 基準付きの問いと threshold）だけで測る（T3.5 で使わない言語の文面を消した後も動くように。設計書 10.4 の手順3）
function methodsFor(set, rank) {
  if (set === 'final') return { methods: [{ name: `確定した設定（${rank.question_language}・基準付き）`, fixed: true }], thresholds: [rank.threshold] };
  return { methods: Object.keys(rank.questions).flatMap(lang => [{ name: `基準付き・${lang}`, lang, criteria: true }, { name: `短い問い・${lang}`, lang, criteria: false }]),
    thresholds: THRESHOLDS };
}
async function withMethod(magi, method, run) {
  const rank = magi.SITE_RANK, saved = { lang: rank.question_language, question: rank.questions[method.lang], threshold: rank.threshold };
  if (!method.fixed) {
    rank.question_language = method.lang;
    if (!method.criteria) rank.questions[method.lang] = { instructions: saved.question.instructions };
  }
  try { return await run(); }
  finally {
    rank.threshold = saved.threshold;
    if (!method.fixed) { rank.question_language = saved.lang; rank.questions[method.lang] = saved.question; }
  }
}
// Jev の応答の本文から答えを読む。JSON でない・answers が無い本文は null（Worker も unavailable にする）
function jevAnswers(text) {
  let body;
  try { body = JSON.parse(text); } catch (_) { return null; }
  if (!body || typeof body !== 'object' || !body.answers || typeof body.answers !== 'object' || Array.isArray(body.answers)) return null;
  return { model: typeof body.model === 'string' ? body.model : null, answers: body.answers };
}

export async function accuracy(magi, { data: given } = {}) {
  const key = typesafeKey(magi.SITE_RANK.key);
  if (!key) fail(`TypeSafe のキーが無いので精度は測らない（環境変数 ${magi.SITE_RANK.key} か、追跡外の workers/magi2/.dev.vars）`);
  const set = option('--set', 'tune'), runs = Number(option('--runs', '2'));
  if (!SETS.includes(set) || !Number.isInteger(runs) || runs < 1) fail('--set は tune か final、--runs は1以上');
  // 測る索引は、いまの公開 HTML から site-search-index.py で作り直したもの（PRD 7.1）。作り直して違えば止める
  const fresh = join(mkdtempSync(join(tmpdir(), 'site-rank-')), 'site-search.json');
  const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const built = spawnSync(python, ['-B', '.github/scripts/site-search-index.py', '--output', fresh], { cwd: root, encoding: 'utf8' });
  if (built.status !== 0) fail(`索引を作り直せない（${python}）: ${built.stderr}`);
  if (!readFileSync(fresh).equals(readFileSync(join(root, 'data/site-search.json')))) fail('手元の data/site-search.json が古い。python -B .github/scripts/site-search-index.py で作り直してから測る');
  const local = await snapshotOf(magi, read('data/site-search.json'));
  if (!local.rankReady) fail('手元の索引が②に使えない（rankReady が false）。site-search-index.py で作り直す');
  const { data } = loadQueries(magi, local.targets, true, given);
  const queries = data.queries.filter(q => q.set === set);
  const env = { [magi.SITE_RANK.key]: key }, signal = new AbortController().signal;
  // いまの「含む」検索は、方式を比べる tune でだけ並べる
  const contains = set === 'tune' ? containsSearch() : null;
  const { methods, thresholds } = methodsFor(set, magi.SITE_RANK);
  const models = new Set(), record = { kind: 'accuracy', ...gitState(), set, runs, started: new Date().toISOString(),
    revision: magi.SITE_RANK.revision, question_language: magi.SITE_RANK.question_language, threshold: magi.SITE_RANK.threshold,
    index_hash: local.indexHash, candidate_hash: local.candidateHash, frozen: data.frozen, annotator: data.annotator, thresholds,
    contains: contains && Object.fromEntries(queries.map(q => [q.id, contains(q.query)])), measurements: [] };
  let billing = null;
  for (let run = 1; run <= runs; run++) {
    for (const method of methods) {
      const rows = await withMethod(magi, method, async () => {
        // 1回目：本物の Jev を呼ぶ（Worker と同じ2秒の期限）。応答の本文を残し、閾値ごとの結果はそれを流し直して作る
        const live = new Map();
        magi.hooks.fetch = async (url, opts) => {
          assert.equal(url, magi.SITE_RANK.endpoint);
          const { state } = JSON.parse(opts.body), slot = live.get(state.locale + ' ' + state.query), started = performance.now();
          try {
            const res = await fetch(url, opts), text = await res.text();
            Object.assign(slot, { status: res.status, text, ms: performance.now() - started });
            return new Response(text, { status: res.status });
          } catch (e) { slot.error = e && e.name; slot.ms = performance.now() - started; throw e; }
        };
        magi.clearRankCache();
        // 1件ずつ順に呼ぶ。並べると Jev の毎秒のトークンの上限（JEV.md。1回 約1.2万トークン）に当たり、本番では起きない
        // 429 の失敗が精度に混ざる
        const firsts = [];
        for (const q of queries) {
          const slot = {}; live.set(q.locale + ' ' + q.query, slot);
          const r = await magi.rankSearch({ env, snapshot: local.snapshot, query: q.query, locale: q.locale, signal,
            onBilling: status => { billing = status; } });
          firsts.push({ q, slot, r });
        }
        if (billing) fail(`Jev が HTTP ${billing} を返した（キーの失効か残高切れ）。測定を止める`);
        const out = [];
        for (const { q, slot, r } of firsts) {
          // 答えが読めなかった呼び出し（時間切れ・HTTP エラー・JSON でない 200 など）は、その問い合わせだけを失敗として分母に残す
          const body = slot.status === 200 ? jevAnswers(slot.text) : null;
          if (body?.model) models.add(body.model);
          const probs = body && Object.fromEntries(local.targets.map((p, i) => [p.id, magi.rankProbability(body.answers[magi.rankId(i)])]));
          const byThreshold = {};
          for (const t of thresholds) {
            if (!body) { byThreshold[t] = { status: 'failed', reason: r.status === 'failed' ? r.reason : 'unavailable', complete: false, ids: [] }; continue; }
            magi.SITE_RANK.threshold = t; magi.clearRankCache();
            magi.hooks.fetch = async () => new Response(slot.text, { status: slot.status });
            const x = await magi.rankSearch({ env, snapshot: local.snapshot, query: q.query, locale: q.locale, signal, onBilling: () => {} });
            byThreshold[t] = { status: x.status, reason: x.reason, complete: x.complete, ids: x.results.map(v => local.urlToId.get(v.url)) };
          }
          out.push({ id: q.id, http: slot.status ?? null, error: slot.error ?? null, answered: !!body, jev_ms: slot.ms == null ? null : Math.round(slot.ms),
            judged: r.searched?.judged ?? null, candidates: r.searched?.candidates ?? null, probs, byThreshold });
        }
        return out;
      });
      record.measurements.push({ run, method: method.name, rows });
      console.error(`run ${run} ${method.name}: ${rows.length}件`);
    }
  }
  record.models = [...models];
  record.queries = queries; // --report で出し直せるように、測った問い合わせ（正解つき）も残す
  record.finished = new Date().toISOString();
  const file = writeRaw('accuracy', record);
  console.log(accuracyReport(record, file));
}

// 精度のまとめ（assets/site-search-evaluation.md に貼れる形）。生の記録だけから作る（--report で Jev を呼び直さずに出し直せる）
export function accuracyReport(record, file) {
  const queries = record.queries || JSON.parse(read(QUERIES)).queries.filter(q => q.set === record.set); // 古い記録には問い合わせが無い
  const thresholds = record.thresholds, methods = [...new Set(record.measurements.map(m => m.method))];
  const runs = record.runs, rowsOf = (method, run) => new Map(record.measurements.find(m => m.run === run && m.method === method).rows.map(r => [r.id, r]));
  const lines = [`## 精度（${record.set}、${queries.length}件、${runs}回）`, '',
    `- コミット ${record.commit}${record.dirty ? '（未コミットの変更あり）' : ''}、revision ${record.revision}、Jev ${record.models.join('・') || '不明'}`,
    `- 設定の question_language ${record.question_language}、threshold ${record.threshold}`,
    `- index_hash ${record.index_hash}`, `- candidate_hash ${record.candidate_hash}`,
    `- 正解の固定 ${record.frozen}（${ANNOTATORS[record.annotator] || record.annotator}）、生の記録 ${file}`, ''];
  for (let run = 1; run <= runs; run++) {
    lines.push(`### ${run}回目`, '', SCORE_HEAD);
    if (record.contains) lines.push(scoreRow('いまの「含む」検索', score(queries, q => ({ status: 'results', ids: record.contains[q.id] }))));
    for (const method of methods) {
      const byId = rowsOf(method, run);
      for (const t of thresholds) lines.push(scoreRow(`${method} ${t}`, score(queries, q => byId.get(q.id).byThreshold[t])));
    }
    lines.push('');
  }
  if (thresholds.length > 1) {
    // 閾値の余裕（設計書 10.4 の手順2）：2回を通した「正解のページの確率の最低」（答えのある問い合わせごとに、正解のうち
    // 最も高い確率。答えが読めなかった問い合わせは0）と「答えの無い問い合わせで出た最も高い確率」の間で、
    // 両側からの余裕の小さい方が最も大きい閾値を、2回とも条件を満たす閾値から選ぶ
    lines.push('### 閾値の余裕', '', '| 方式 | 正解の最低 | 答え無しの最高 | 閾値 | 2回とも条件 | 余裕（小さい方） |', '| --- | ---: | ---: | ---: | --- | ---: |');
    const picks = [];
    for (const method of methods) {
      let correctMin = 1, noneMax = 0;
      for (let run = 1; run <= runs; run++) {
        const byId = rowsOf(method, run);
        for (const q of queries) {
          const probs = byId.get(q.id).probs || {};
          if (q.answers.length) correctMin = Math.min(correctMin, Math.max(0, ...q.answers.map(a => probs[a] ?? 0)));
          else noneMax = Math.max(noneMax, ...Object.values(probs).map(v => v ?? 0));
        }
      }
      let best = null;
      for (const t of thresholds) {
        const pass = Array.from({ length: runs }, (_, i) => i + 1).every(run => { const byId = rowsOf(method, run); return score(queries, q => byId.get(q.id).byThreshold[t]).pass; });
        const margin = Math.round(Math.min(t - noneMax, correctMin - t) * 100) / 100;
        if (pass && (!best || margin > best.margin)) best = { t, margin };
        lines.push(`| ${method} | ${correctMin.toFixed(2)} | ${noneMax.toFixed(2)} | ${t} | ${pass ? '満たす' : '-'} | ${margin.toFixed(2)} |`);
      }
      picks.push(`${method}：${best ? `${best.t}（余裕 ${best.margin.toFixed(2)}）` : '条件を満たす閾値が無い'}`);
    }
    lines.push('', '規則で選ぶ閾値（方式ごと）：', '', ...picks.map(p => `- ${p}`), '');
  }
  lines.push('### 判定の欠けと Jev 単体の時間（直接呼んだもの。ブラウザの p95 の合否には使わない）', '',
    '| 回 | 方式 | 判定の欠けた問い合わせ | 失敗した呼び出し | p50 | p95 |', '| ---: | --- | ---: | ---: | ---: | ---: |');
  for (const m of record.measurements) {
    const ms = m.rows.map(r => r.jev_ms).filter(v => v != null);
    lines.push(`| ${m.run} | ${m.method} | ${m.rows.filter(r => r.answered && r.judged < r.candidates).length} | ${m.rows.filter(r => !r.answered).length} | ${percentile(ms, 0.5)}ms | ${percentile(ms, 0.95)}ms |`);
  }
  if (runs >= 2) {
    // 表示ページの増減（片方の回だけに出たページがある）は集合で比べ、同じページの順位だけの入れ替わりは別に数える
    lines.push('', '### 2回で結果の変わった問い合わせ', '', '| 方式 | 閾値 | 表示ページの増減 | ID | 順位だけの変化 | ID |', '| --- | ---: | ---: | --- | ---: | --- |');
    const asSet = ids => ids.slice().sort().join(',');
    for (const method of methods) for (const t of thresholds) {
      const [a, b] = [1, 2].map(run => new Map([...rowsOf(method, run)].map(([id, r]) => [id, r.byThreshold[t].ids])));
      const changed = queries.filter(q => asSet(a.get(q.id)) !== asSet(b.get(q.id))).map(q => q.id);
      const reordered = queries.filter(q => asSet(a.get(q.id)) === asSet(b.get(q.id)) && a.get(q.id).join(',') !== b.get(q.id).join(',')).map(q => q.id);
      lines.push(`| ${method} | ${t} | ${changed.length} | ${changed.join(' ')} | ${reordered.length} | ${reordered.join(' ')} |`);
    }
  }
  return lines.join('\n');
}

// 本物のブラウザ（Playwright の Chromium）で 404 のページ（Origin が https://tk.st）を開き、そこから本番の Worker へ送る。
// assets/site-search.js と同じ fetch を送り、送信の直前から res.json() を読み終えるまでを測る（プリフライトを含む）。
// 解析を汚さない：計測を止める設定を先に入れ、tk.st と Worker 以外への通信は止める
async function openRankPage() {
  const { chromium } = await import('playwright'); // ブラウザの測定のときだけ読む（smoke の経路は npm の依存を読まない）
  const instance = await chromium.launch();
  const blocked = [];
  try {
    const context = await instance.newContext();
    await context.addInitScript(() => { try { localStorage.setItem('st-analytics', 'off'); } catch (_) {} });
    await context.route('**/*', route => {
      const host = new URL(route.request().url()).hostname;
      if (host === 'tk.st' || host === 'workers.tk.st') return route.continue();
      if (!blocked.includes(host)) blocked.push(host);
      return route.abort();
    });
    const page = await context.newPage();
    const landing = await page.goto(`https://tk.st/site-rank-eval-${Date.now()}/`);
    assert.equal(landing.status(), 404, '404 のページが開けない');
    // 期限は画面と同じ（BROWSER_TIMEOUT_MS）。本文の読み取りまで含めて止める
    const send = body => page.evaluate(async ({ url, body, timeout }) => {
      const started = performance.now();
      try {
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
          credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(timeout) });
        const data = await res.json();
        return { http: res.status, data, ms: performance.now() - started };
      } catch (e) { return { http: null, error: e && e.name, ms: performance.now() - started }; }
    }, { url: RANK_URL, body, timeout: BROWSER_TIMEOUT_MS });
    return { version: instance.version(), blocked, send, close: () => instance.close() };
  } catch (e) { await instance.close(); throw e; }
}

// 画面（設計書 5.2・5.3）が描く結果として読む。HTTP の状態と本文の検査は画面の部品（assets/site-search.js の readResponse）を
// そのまま使い、書き写さない（期限切れ、200・429・400 以外、読めない本文、形の合わない本文、1行でも URL などが合わない結果は failed）
let pageReadResponse = null;
function readResponseOfPage() {
  if (!pageReadResponse) {
    const ctx = vm.createContext({ URL, location: { hostname: 'tk.st' } });
    ctx.window = ctx;
    vm.runInContext(read('assets/site-search.js'), ctx);
    pageReadResponse = ctx.STSiteSearch.readResponse;
  }
  return pageReadResponse;
}
export function screenResult(magi, r, urlToId) {
  const failed = reason => ({ status: 'failed', reason, ids: [] });
  if (r.error) return failed(r.error === 'TimeoutError' ? 'timeout' : r.error === 'SyntaxError' ? 'unavailable' : 'network');
  const v = readResponseOfPage()(r.http, r.data, 'site');
  if (v.status === 'failed') return failed(v.reason);
  return { status: v.status, reason: null, ids: v.rows.map(row => urlToId.get(row.href) ?? `unknown:${row.href}`) };
}

// 測定の前の疎通の確認：評価セットに無い決まった1問を送り、②が有効か・ブラウザから届くかだけを見る
// （評価セットの検索語で試すと、本番の測定が10分のキャッシュに当たる）
export async function probe() {
  const browser = await openRankPage();
  try {
    const r = await browser.send({ query: PROBE_QUERY, locale: 'ja', mode: 'rank', scope: 'site' });
    const d = r.data || {};
    console.log(JSON.stringify({ http: r.http, error: r.error ?? null, ms: Math.round(r.ms), request_id: d.request_id ?? null,
      status: d.status ?? null, reason: d.reason ?? null, error_code: d.error?.code ?? null, searched: d.searched ?? null, results: (d.results || []).length,
      chromium: browser.version, blocked: browser.blocked }, null, 2));
    // ②が止まっている・届かない・②の形で答えないときは失敗で終える（Actions の測定の前の確認に使う）
    if (d.reason === 'disabled' || !['results', 'no_results'].includes(d.status)) { console.error('②が有効でないか、届かない'); process.exitCode = 1; }
  } finally { await browser.close(); }
}

export async function browser(magi, { data: given } = {}) {
  const set = option('--set', 'final');
  if (!SETS.includes(set)) fail('--set は tune か final');
  const production = await snapshotOf(magi, await productionIndex());
  const { data } = loadQueries(magi, production.targets, true, given);
  const queries = data.queries.filter(q => q.set === set);
  assert.ok(queries.length <= BROWSER_MAX);
  // 2回目は、1回目と UTC の別の日に測る（キャッシュの期限と、IP ごとの1日の回数を跨がないため。設計書 10.4）
  const today = new Date().toISOString().slice(0, 10);
  let earlier = [];
  try { earlier = readdirSync(join(root, RAW_DIR)).filter(f => f.startsWith('site-rank-browser-')); } catch (_) {}
  for (const f of earlier) {
    const prev = JSON.parse(read(`${RAW_DIR}/${f}`));
    if (prev.started.slice(0, 10) === today && prev.set === set) console.error(`注意: 同じ UTC の日（${today}）に測った記録がある（${f}）。2回目は別の日に測る`);
  }
  const page = await openRankPage();
  const record = { kind: 'browser', ...gitState(), set, started: new Date().toISOString(), browser: page.version,
    revision: magi.SITE_RANK.revision, index_hash: production.indexHash, candidate_hash: production.candidateHash, frozen: data.frozen, annotator: data.annotator,
    blocked: page.blocked, rows: [] };
  try {
    for (const q of queries) {
      const r = await page.send({ query: q.query, locale: q.locale, mode: 'rank', scope: 'site' });
      const d = r.data || {};
      if (d.reason === 'disabled') throw new Error('本番の Worker の SITE_RANK_ENABLED が true になっていない（disabled）');
      // ②の応答はどれも { status, reason, … } の形。③の形のエラーは、②の無い Worker か認可の失敗なので測らない
      if (d.error) throw new Error(`本番の Worker が②の形で答えない（HTTP ${r.http}、${d.error.code}）。--probe で確かめる`);
      const shown = screenResult(magi, r, production.urlToId);
      record.rows.push({ id: q.id, http: r.http, error: r.error ?? null, ms: Math.round(r.ms), request_id: d.request_id ?? null,
        worker_status: d.status ?? null, worker_reason: d.reason ?? null, complete: d.complete ?? false, searched: d.searched ?? null, ...shown });
      console.error(`${q.id}: ${Math.round(r.ms)}ms ${shown.status}${shown.reason ? ' ' + shown.reason : ''}`);
    }
  } finally { await page.close(); }
  record.finished = new Date().toISOString();
  const file = writeRaw('browser', record);
  const ms = record.rows.map(r => r.ms), byId = new Map(record.rows.map(r => [r.id, r]));
  const s = score(queries, q => byId.get(q.id));
  const p95 = percentile(ms, 0.95);
  console.log([`## ブラウザの応答時間（${set}、${queries.length}件、${record.started}）`, '',
    `- コミット ${record.commit}${record.dirty ? '（未コミットの変更あり）' : ''}、手元の revision ${record.revision}、Chromium ${record.browser}`,
    `- 本番の索引 index_hash ${record.index_hash}`, `- 本番の索引 candidate_hash ${record.candidate_hash}`,
    `- 正解の固定 ${record.frozen}（${ANNOTATORS[record.annotator]}）`,
    `- 止めた通信の送り先 ${record.blocked.join('・') || 'なし'}`, `- 生の記録 ${file}（request_id を wrangler tail の site_rank の行と突き合わせ、jev_ms が null（キャッシュ）や rate_limited が混じっていないか、revision・candidate_hash が同じかを確かめる）`, '',
    `| p50 | p95 | 最大 | p95 が${P95_MAX_MS}ms 以内 |`, '| ---: | ---: | ---: | --- |',
    `| ${percentile(ms, 0.5)}ms | ${p95}ms | ${Math.max(...ms)}ms | ${p95 <= P95_MAX_MS ? '満たす' : '満たさない'} |`, '',
    SCORE_HEAD, scoreRow('本番の Worker', s), '',
    // 失敗の応答は速いので、p95 だけで合否を決めない（PRD 7.1）
    `- この回の条件（p95・上位5件の正解・答えの無いものでの結果の3つ）：${p95 <= P95_MAX_MS && s.pass ? 'すべて満たす' : '満たさない'}`].join('\n'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const modes = ['--check', '--hash', '--smoke-payload', '--accuracy', '--report', '--browser', '--probe'].filter(m => process.argv.includes(m));
  if (modes.length !== 1) fail('使い方: node .github/scripts/eval-site-rank.mjs --check | --hash | --smoke-payload | --accuracy [--set tune|final] [--runs 2] | --report <生の記録> | --browser [--set final] | --probe');
  const magi = loadWorker();
  if (modes[0] === '--check') {
    const local = await snapshotOf(magi, read('data/site-search.json'));
    const { data, summary } = loadQueries(magi, local.targets, false);
    console.log(JSON.stringify({ ok: true, targets: local.targets.length, frozen: data.frozen || null, annotator: data.annotator, ...summary }));
  } else if (modes[0] === '--hash') {
    const show = s => ({ rank_ready: s.rankReady, targets: s.targets.length, index_hash: s.indexHash, candidate_hash: s.candidateHash });
    const local = show(await snapshotOf(magi, read('data/site-search.json'))), production = show(await snapshotOf(magi, await productionIndex()));
    console.log(JSON.stringify({ revision: magi.SITE_RANK.revision, local, production, candidate_hash_match: local.candidate_hash === production.candidate_hash }, null, 2));
  } else if (modes[0] === '--smoke-payload') {
    const local = await snapshotOf(magi, read('data/site-search.json'));
    assert.ok(local.rankReady, '手元の索引が②に使えない');
    const candidates = local.targets.map(magi.toRankCandidate);
    console.log(JSON.stringify({ endpoint: magi.SITE_RANK.endpoint, key: magi.SITE_RANK.key, threshold: magi.SITE_RANK.threshold,
      cases: SMOKE.map(c => {
        const payload = magi.rankPayload(c.query, c.locale, candidates);
        const expect = c.expect.map(id => local.targets.findIndex(p => p.id === id));
        assert.ok(expect.every(i => i >= 0), `smoke の期待するページが索引に無い: ${c.query}`);
        return { payload, expect: expect.map(magi.rankId) };
      }) }));
  } else if (modes[0] === '--accuracy') await accuracy(magi);
  else if (modes[0] === '--report') {
    const file = option('--report');
    if (!file) fail('--report には生の記録（workers/.wrangler/site-rank-accuracy-*.json）を渡す');
    console.log(accuracyReport(JSON.parse(readFileSync(resolve(file), 'utf8')), file));
  }
  else if (modes[0] === '--probe') await probe();
  else await browser(magi);
}
