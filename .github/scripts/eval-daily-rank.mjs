// 日刊②の評価。固定した全年度の索引とWorkerの処理を使う（Phase 3 T09）。
// --check / --plan / --candidates は外部へ送らない。実測は --accuracy / --probe / --browser だけ。
// 使い方と固定セットの根拠: .github/site-search/fixtures/phase3/README.md
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { loadWorker, typesafeKey, gitState, openRankPage, readResponseOfPage } from './eval-site-rank.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURES = '.github/site-search/fixtures/phase3';
const QUERIES = '.github/site-search/phase3-rank-queries.json';
const RAW = 'workers/.wrangler';
const SCOPES = ['nitori', 'retail'], SETS = ['tune', 'final'];
const TYPES = ['keyword', 'sentence', 'paraphrase', 'english', 'none'];
const COVERAGE = ['old', 'product', 'business', 'month', 'category', 'region', 'anchor', 'no_overlap'];
const THRESHOLDS = [0.3, 0.35, 0.4, 0.5, 0.6];
const read = path => readFileSync(join(ROOT, path), 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
const digest = value => hash(JSON.stringify(value));
const plain = value => JSON.parse(JSON.stringify(value));
const dateValid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
export const percentile = (values, p) => values.length ? values.slice().sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] : null;

// headの年一覧だけを使い、任意のパス・URLをfixtureから読まない。本文のハッシュはWorkerと同じ。
export async function dailySnapshot(magi, scope, readFile) {
  const { media } = magi.searchScope(scope); assert.ok(media);
  const text = await readFile('search-index.json');
  const head = JSON.parse(text);
  assert.ok(Array.isArray(head.years) && head.years.length <= magi.SITE_RANK.daily_index_max_years
    && head.years.every(y => typeof y === 'string' && /^\d{4}$/.test(y)));
  const files = [['search-index.json', text]];
  for (const year of head.years.slice(1)) files.push([`search-index-${year}.json`, await readFile(`search-index-${year}.json`)]);
  const snapshot = magi.makeDailySnapshot(scope, files);
  return { snapshot, generation: snapshot.generation, years: head.years, records: snapshot.raw.length,
    index_hash: await magi.snapshotHash(snapshot), candidate_hash: await magi.rankCandidateHash(snapshot),
    files: files.map(([name, text]) => ({ name, sha256: hash(text) })),
    urlToId: new Map(snapshot.raw.map(p => [p.url, p.id])) };
}

export async function loadFixtures(magi, data, { indexSet = 'original' } = {}) {
  const dated = /^\d{8}$/.test(indexSet) && dateValid(indexSet.slice(0, 4) + '-' + indexSet.slice(4, 6) + '-' + indexSet.slice(6));
  assert.ok(['original', 'terms'].includes(indexSet) || dated, '--index-set original|terms|YYYYMMDD');
  const directory = dated ? `publications/${indexSet}/` : indexSet === 'terms' ? 'with-search-terms/' : '';
  const manifest = directory ? JSON.parse(read(`${FIXTURES}/${directory}indexes.json`)) : null;
  if (manifest) {
    assert.equal(manifest.version, 1);
    assert.equal(manifest.terms_source_sha256, hash(read('.github/scripts/daily_search_terms.py').replace(/\r\n/g, '\n')), '言い換え語の生成規則が固定時と違う');
    for (const scope of SCOPES) assert.equal(manifest.parent_index_hashes[scope], data.indexes[scope].index_hash);
    if (dated) {
      assert.equal(manifest.frozen.replace(/-/g, ''), indexSet);
      assert.match(manifest.source_commit, /^[a-f0-9]{40}$/);
      assert.equal(manifest.query_hash, digest(data), '固定した問い・正解が更新時と違う');
    }
  }
  const snapshots = {};
  for (const scope of SCOPES) {
    snapshots[scope] = await dailySnapshot(magi, scope, name => read(`${FIXTURES}/${directory}${scope}/${name}`));
    const { generation, years, records, index_hash, candidate_hash, files } = snapshots[scope];
    assert.deepEqual((manifest || data).indexes[scope], { generation, years, records, index_hash, candidate_hash, files }, scope + ': 固定索引が変更された');
    if (indexSet === 'terms') assert.equal(candidate_hash, data.indexes[scope].candidate_hash, '言い換え語でJevの候補変換を変えない');
  }
  return { snapshots, termsSourceHash: manifest?.terms_source_sha256 ?? null,
    ...(dated ? { indexSource: { index_source_commit: manifest.source_commit, index_frozen: manifest.frozen } } : {}) };
}

export function checkDailyQueries(magi, data, snapshots) {
  assert.deepEqual(Object.keys(data).sort(), ['annotator', 'frozen', 'indexes', 'queries', 'source_commit', 'timing', 'version']);
  assert.equal(data.version, 1); assert.ok(dateValid(data.frozen));
  assert.ok(['codex', 'owner'].includes(data.annotator));
  assert.match(data.source_commit, /^[a-f0-9]{40}$/);
  assert.deepEqual(Object.keys(data.indexes).sort(), SCOPES.slice().sort());
  assert.deepEqual(Object.keys(data.timing).sort(), SCOPES.slice().sort());
  assert.ok(Array.isArray(data.queries));
  const ids = new Set(), requests = new Set(), summary = {};
  for (const q of data.queries) {
    assert.deepEqual(Object.keys(q).sort(), ['answers', 'coverage', 'filters', 'id', 'locale', 'note', 'query', 'scope', 'set', 'type']);
    assert.ok(SCOPES.includes(q.scope) && SETS.includes(q.set) && TYPES.includes(q.type), q.id);
    assert.match(q.id, new RegExp('^' + q.scope + '-\\d{3}$')); assert.ok(!ids.has(q.id), q.id); ids.add(q.id);
    assert.ok(['ja', 'en'].includes(q.locale));
    assert.equal(q.query, magi.rankQuery(q.query));
    assert.ok(typeof q.query === 'string' && Array.from(q.query).length >= 1 && Array.from(q.query).length <= magi.SITE_RANK.query_max_chars);
    const filters = plain(magi.normalizeScopeFilters(q.scope, q.filters));
    assert.deepEqual(q.filters, filters, q.id + ': filtersは正規化したキー順で保存する');
    const key = digest([q.scope, q.locale, q.query, filters]);
    assert.ok(!requests.has(key), q.id + ': 同じ要求が重複'); requests.add(key);
    const snapshot = snapshots[q.scope].snapshot;
    assert.ok(!filters.category || snapshot.categories.has(filters.category));
    assert.ok(!filters.month || snapshot.months.has(filters.month));
    const targets = magi.filterDailyItems(snapshot, filters), targetIds = new Set(targets.map(p => p.id));
    assert.ok(targets.length, q.id + ': 0件の絞り込みは精度の分母にしない');
    assert.ok(Array.isArray(q.answers) && new Set(q.answers).size === q.answers.length);
    for (const id of q.answers) assert.ok(targetIds.has(id), q.id + ': 絞り込み後の全記事に正解が無い ' + id);
    assert.equal(q.type === 'none', q.answers.length === 0);
    assert.ok(Array.isArray(q.coverage) && new Set(q.coverage).size === q.coverage.length && q.coverage.every(c => COVERAGE.includes(c)));
    assert.ok(typeof q.note === 'string' && q.note.trim());
    if (q.coverage.includes('no_overlap')) assert.ok(q.answers.some(id => {
      const { search_terms, ...original } = targets.find(p => p.id === id);
      return magi.shortlistRankDaily([original], q.query, q.scope)[0].score === 0;
    }), q.id + ': 元の題名・要約に字の重ならない正解が無い');
  }
  for (const scope of SCOPES) {
    summary[scope] = {};
    for (const set of SETS) {
      const rows = data.queries.filter(q => q.scope === scope && q.set === set), none = rows.filter(q => q.type === 'none').length;
      assert.ok(rows.length >= 30 && none >= Math.ceil(rows.length * 0.2) && none < rows.length, `${scope}/${set}: 30件以上、答え無し20%以上`);
      for (const type of TYPES) assert.ok(rows.some(q => q.type === type), `${scope}/${set}: ${type}`);
      for (const c of COVERAGE) assert.ok(rows.some(q => q.coverage.includes(c)), `${scope}/${set}: ${c}`);
      summary[scope][set] = { total: rows.length, answered: rows.length - none, none };
    }
    const timing = data.timing[scope];
    assert.ok(Array.isArray(timing) && timing.length === 24 && new Set(timing).size === 24);
    for (const id of timing) assert.ok(data.queries.some(q => q.id === id && q.scope === scope && q.set === 'final'), '速度の24件は固定済みfinalから選ぶ');
  }
  return summary;
}

export function queryCandidates(magi, local, q) {
  const targets = magi.filterDailyItems(local.snapshot, q.filters);
  const selected = magi.shortlistRankDaily(targets, q.query, q.scope).map(r => r.p);
  return { total: targets.length, ids: selected.map(p => p.id), payload: magi.rankPayload(q.query, q.locale, selected.map(magi.toRankCandidate), q.scope) };
}

export function candidateScore(queries, rows) {
  const byId = new Map(rows.map(r => [r.id, r])), answered = queries.filter(q => q.answers.length);
  const hit = answered.filter(q => q.answers.some(id => byId.get(q.id)?.candidate_ids.includes(id))).length;
  return { hit, total: answered.length, rate: hit / answered.length, pass: hit / answered.length >= 0.9 };
}

export function resultScore(queries, rows, threshold) {
  const byId = new Map(rows.map(r => [r.id, r.by_threshold[threshold]]));
  const answered = queries.filter(q => q.answers.length), none = queries.filter(q => !q.answers.length);
  const hit = answered.filter(q => byId.get(q.id)?.status !== 'failed' && byId.get(q.id)?.ids?.slice(0, 5).some(id => q.answers.includes(id))).length;
  const shown = none.filter(q => byId.get(q.id)?.ids?.length).length;
  const failed = queries.filter(q => !byId.get(q.id) || byId.get(q.id).status === 'failed').length;
  const incomplete = queries.filter(q => byId.get(q.id)?.complete === false).length;
  return { hit, answered: answered.length, shown, none: none.length, failed, incomplete,
    pass: failed === 0 && hit / answered.length >= 0.8 && shown / none.length <= 0.15 };
}

function provenance(magi, data, local, scope, set) {
  const config = magi.rankScopeConfig(scope);
  const paths = ['languages.js', 'personas.js', 'site-search.js', 'search-scope.js', 'site-rank.js', 'src/index.js', 'wrangler.toml']
    .map(f => `workers/magi2/${f}`).concat(['.github/scripts/eval-site-rank.mjs', '.github/scripts/eval-daily-rank.mjs', 'assets/site-search.js', 'config/ai-models.json']);
  const questions = Object.fromEntries(Object.entries(config.questions).map(([lang, q]) => [lang, { ...q, instructions: q.instructions('c01') }]));
  return { ...gitState(), scope, set, frozen: data.frozen, annotator: data.annotator, source_commit: data.source_commit,
    generation: local.generation, index_hash: local.index_hash, candidate_hash: local.candidate_hash,
    query_hash: digest(data), code_hash: digest(paths.map(f => [f, read(f)])),
    config_hash: digest({ ...config, questions, question_language: magi.SITE_RANK.question_language }),
    revision: config.revision, threshold: config.threshold, model_alias: magi.SITE_RANK.model.model };
}
function writeRecord(record) {
  mkdirSync(join(ROOT, RAW), { recursive: true });
  const path = `${RAW}/daily-rank-${record.kind}-${record.scope}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(join(ROOT, path), JSON.stringify(record, null, 2) + '\n'); return path;
}
function savedResult(result, local) {
  return { status: result.status, reason: result.reason, complete: result.complete, searched: plain(result.searched),
    ids: result.results.map(r => { const id = local.urlToId.get(r.url); assert.ok(id); return id; }) };
}

// 上流・キャッシュ・閾値の再生はWorkerを通す。候補のcNNは問いごとに異なるので、その問いのID順で記録する。
export async function measureAccuracy(magi, local, queries, { runs = 2, thresholds, key, liveFetch = fetch, onRow = () => {} }) {
  assert.ok(queries.length && queries.every(q => q.scope === local.snapshot.scope));
  assert.ok(thresholds.length && thresholds.every(t => Number.isFinite(t) && t >= 0 && t <= 1));
  const measurements = [], signal = new AbortController().signal, config = magi.rankScopeConfig(queries[0].scope), original = config.threshold;
  const originalFetch = magi.hooks.fetch;
  try {
    for (let run = 1; run <= runs; run++) {
      const rows = []; measurements.push({ run, rows });
      for (const q of queries) {
        const candidates = queryCandidates(magi, local, q), slot = {};
        magi.hooks.fetch = async (url, opts) => {
          assert.equal(url, magi.SITE_RANK.endpoint); assert.deepEqual(JSON.parse(opts.body), plain(candidates.payload));
          const start = performance.now();
          try { const res = await liveFetch(url, opts); slot.http = res.status; slot.text = await res.text(); return new Response(slot.text, { status: res.status }); }
          catch (e) { slot.error = e.name; throw e; }
          finally { slot.ms = performance.now() - start; }
        };
        let billing = null; magi.clearRankCache(); config.threshold = original;
        const args = { env: { [magi.SITE_RANK.key]: key }, snapshot: local.snapshot, scope: q.scope, filters: q.filters,
          query: q.query, locale: q.locale, signal, onBilling: status => { billing = status; } };
        const first = await magi.rankSearch(args);
        let body = null; try { body = JSON.parse(slot.text); } catch (_) {}
        const probs = Object.fromEntries(candidates.ids.map((id, i) => [id, magi.rankProbability(body?.answers?.[magi.rankId(i)])]));
        const row = { id: q.id, candidate_ids: candidates.ids, total: candidates.total, http: slot.http ?? null, error: slot.error ?? null,
          model: typeof body?.model === 'string' ? body.model : null, usage: body?.usage ?? null, jev_ms: slot.ms ?? first.jevMs,
          raw_response: slot.text ?? null, probs, by_threshold: {} };
        rows.push(row);
        for (const threshold of thresholds) {
          config.threshold = threshold; magi.clearRankCache();
          magi.hooks.fetch = async () => new Response(slot.text || '', { status: slot.http || 503 });
          row.by_threshold[threshold] = savedResult(slot.error || slot.text === undefined ? first : await magi.rankSearch(args), local);
        }
        onRow(run, row);
        if (billing) throw Object.assign(new Error(`Jev HTTP ${billing}: キー・残高の問題で測定を停止`), { measurements });
      }
    }
    return measurements;
  } catch (e) { e.measurements = measurements; throw e; }
  finally { config.threshold = original; magi.hooks.fetch = originalFetch; magi.clearRankCache(); }
}

export function accuracyReport(record) {
  const lines = [`${record.scope}/${record.set}: ${record.queries.length}問、${record.measurements.length}回`,
    `generation=${record.generation}; index_hash=${record.index_hash}; candidate_hash=${record.candidate_hash}`,
    '正解は' + (record.annotator === 'owner' ? '本人' : 'Codex（本人未確認）') + 'がAPIの結果を見る前に固定。'];
  for (const m of record.measurements) {
    const candidates = candidateScore(record.queries, m.rows);
    lines.push(`run ${m.run}: 候補に正解 ${candidates.hit}/${candidates.total}、90%条件=${candidates.pass}`);
    for (const t of record.thresholds) lines.push(JSON.stringify({ run: m.run, threshold: t, ...resultScore(record.queries, m.rows, t) }));
    lines.push(JSON.stringify({ run: m.run, model_versions: [...new Set(m.rows.map(r => r.model).filter(Boolean))],
      missing_model: m.rows.filter(r => !r.model).length, missing_usage: m.rows.filter(r => !r.usage).length,
      jev_p50_ms: percentile(m.rows.map(r => r.jev_ms).filter(Number.isFinite), 0.5),
      jev_p95_ms: percentile(m.rows.map(r => r.jev_ms).filter(Number.isFinite), 0.95) }));
  }
  lines.push('Jev単体の時間を本番ブラウザの速度の合格には使わない。');
  return lines.join('\n');
}

export function timingRow(magi, q, response, local) {
  const body = response.data || {}, parsed = readResponseOfPage()(response.http, body, q.scope);
  const failed = response.error || parsed.status === 'failed';
  const ids = failed ? [] : parsed.rows.map(r => local.urlToId.get(r.href));
  const invalid = [];
  if (failed) invalid.push(response.error || parsed.reason);
  if (ids.some(id => !id)) invalid.push('unknown_result');
  if (body.searched?.generation !== local.generation) invalid.push('generation_mismatch');
  if (body.cached !== false) invalid.push('cache_not_false');
  if (typeof body.request_id !== 'string' || !body.request_id) invalid.push('request_id_missing');
  const expected = queryCandidates(magi, local, q);
  if (body.searched?.total !== expected.total || body.searched?.candidates !== expected.ids.length) invalid.push('coverage_mismatch');
  return { id: q.id, http: response.http, request_id: body.request_id ?? null, generation: body.searched?.generation ?? null,
    cached: body.cached ?? null, complete: body.complete ?? false, searched: body.searched ?? null,
    status: invalid.length ? 'failed' : parsed.status, reason: invalid.join(',') || null, invalid,
    ids: invalid.length ? [] : ids, ms: failed || invalid.length ? Math.max(response.ms, 8000) : response.ms };
}

export function checkPrevious(previous, current, now, ttl) {
  assert.equal(previous.kind, 'browser'); assert.equal(previous.run, 1); assert.equal(current.run, 2);
  for (const key of ['scope', 'index_set', 'terms_source_sha256', 'generation', 'index_hash', 'candidate_hash', 'query_hash', 'code_hash', 'config_hash', 'worker_version', 'protected_evaluation']) assert.equal(previous[key], current[key], '2回の条件が違う: ' + key);
  assert.equal(previous.started.slice(0, 10), now.toISOString().slice(0, 10), '2回は同じUTC日');
  assert.ok(now.getTime() - Date.parse(previous.finished) >= ttl + 60000, '前回の終了から10分以上と余裕を空ける');
  assert.ok(previous.valid, '前回が不成立');
  assert.deepEqual(previous.rows.map(r => r.id), current.queries.map(q => q.id), '速度の固定24問が違う');
}

// 手元に残した既知の測定だけを数える。ほかの利用者・端末の共有上限の残量は分からない。
export function checkTimingBudget(records, current, count) {
  const today = current.started.slice(0, 10);
  const sameDay = records.filter(r => ['browser', 'probe'].includes(r.kind) && r.started?.slice(0, 10) === today);
  assert.ok(!sameDay.some(r => r.scope !== current.scope && r.rows.length), '共有IP上限のため媒体を別のUTC日に分ける');
  assert.ok(!sameDay.some(r => r.scope === current.scope && r.kind === current.kind && r.run === current.run), '同じUTC日の同じ測定を繰り返さない');
  const used = sameDay.filter(r => r.scope === current.scope).reduce((n, r) => n + r.rows.length, 0);
  assert.ok(used + count <= 50, '1媒体・同一UTC日は既知の要求だけで50回まで');
  return { known_scope_calls_today: used, planned_calls: count, shared_quota_remaining: 'unknown' };
}

const option = (args, name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
export async function main(args = process.argv.slice(2)) {
  const modes = ['--check', '--plan', '--candidates', '--accuracy', '--report', '--probe', '--browser'].filter(m => args.includes(m));
  assert.equal(modes.length, 1, 'モードを1つ指定: --check | --plan | --candidates | --accuracy | --report <記録> | --probe | --browser');
  const known = new Set([...modes, '--scope', '--set', '--runs', '--run', '--previous', '--worker-version', '--index-set', '--eval-key', '--cancel-after']);
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    assert.ok(known.has(args[i]) && !seen.has(args[i]), '知らない引数または重複: ' + args[i]); seen.add(args[i]);
    if ((!modes.includes(args[i]) && args[i] !== '--eval-key') || args[i] === '--report') { assert.ok(args[i + 1] && !args[i + 1].startsWith('--')); i++; }
  }
  const mode = modes[0];
  const protectedEvaluation = args.includes('--eval-key');
  const cancelAfter = args.includes('--cancel-after') ? Number(option(args, '--cancel-after')) : null;
  assert.ok(!protectedEvaluation || ['--probe', '--browser'].includes(mode), '--eval-key は本番のprobe/browserだけ');
  assert.ok(cancelAfter === null || (mode === '--probe' && Number.isInteger(cancelAfter) && cancelAfter > 0 && cancelAfter < 8000), '--cancel-after はprobeの1〜7999msだけ');
  if (mode === '--report') {
    const record = JSON.parse(readFileSync(resolve(option(args, '--report')), 'utf8'));
    assert.equal(record.kind, 'accuracy', '精度の生記録を指定する');
    console.log(accuracyReport(record)); return;
  }
  const indexSet = option(args, '--index-set', 'original');
  const magi = loadWorker(), data = JSON.parse(read(QUERIES));
  const { snapshots, termsSourceHash, indexSource } = await loadFixtures(magi, data, { indexSet });
  const summary = checkDailyQueries(magi, data, snapshots);
  if (mode === '--check') {
    const indexes = Object.fromEntries(Object.entries(snapshots).map(([scope, { snapshot, urlToId, ...metadata }]) => [scope, metadata]));
    console.log(JSON.stringify({ ok: true, index_set: indexSet, frozen: data.frozen, annotator: data.annotator, indexes, summary }, null, 2)); return;
  }
  const scope = option(args, '--scope'); assert.ok(SCOPES.includes(scope), '--scope nitori|retail を明示する');
  const set = option(args, '--set', mode === '--browser' || mode === '--probe' ? 'final' : 'tune'); assert.ok(SETS.includes(set));
  const runs = Number(option(args, '--runs', '2')); assert.ok([1, 2].includes(runs), '--runs 1|2');
  const local = snapshots[scope], queries = data.queries.filter(q => q.scope === scope && q.set === set);
  const metadata = { ...provenance(magi, data, local, scope, set), index_set: indexSet,
    terms_source_sha256: termsSourceHash, ...indexSource };
  const candidates = queries.map(q => ({ id: q.id, ...queryCandidates(magi, local, q) }));
  if (mode === '--plan') {
    const bytes = candidates.reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r.payload), 'utf8'), 0) * runs;
    console.log(JSON.stringify({ ...metadata, runs, requests: queries.length * runs, questions_max: magi.rankScopeConfig(scope).candidates,
      payload_utf8_bytes: bytes, conservative_cost_usd: bytes / 1e6 * 0.042, price_checked: '2026-10-09', price_source: 'https://docs.typesafe.ai/models',
      estimate: 'UTF-8バイト数を入力トークン数と置く概算。実usageとは異なる。単価は実測前に再確認する。APIは未呼び出し。' }, null, 2)); return;
  }
  if (mode === '--candidates') {
    const rows = candidates.map(r => ({ id: r.id, total: r.total, candidate_ids: r.ids }));
    const file = writeRecord({ kind: 'candidates', ...metadata, queries, rows, score: candidateScore(queries, rows) });
    console.log(JSON.stringify({ scope, set, ...candidateScore(queries, rows), file })); return;
  }
  if (mode === '--accuracy') {
    const key = typesafeKey(magi.SITE_RANK.key); assert.ok(key, 'Jevのキーが無い');
    const record = { kind: 'accuracy', ...metadata, started: new Date().toISOString(), runs, queries,
      thresholds: set === 'tune' ? THRESHOLDS : [metadata.threshold], measurements: [] };
    let error;
    try { record.measurements = await measureAccuracy(magi, local, queries, { runs, thresholds: record.thresholds, key,
      onRow: (run, row) => console.error(`run ${run} ${row.id}: ${row.http ?? row.error}`) }); }
    catch (e) { record.measurements = e.measurements || record.measurements; error = e; }
    record.finished = new Date().toISOString(); const file = writeRecord(record);
    console.log('生の記録: ' + file); if (error) throw error;
    console.log(accuracyReport(record)); return;
  }
  // 本番の測定はT12でのみ使う。索引・コード・Workerの版・固定24問をそろえる。
  assert.equal(set, 'final', '速度はfinalの固定24問だけ');
  const run = Number(option(args, '--run')); assert.ok([1, 2].includes(run), '--run 1|2');
  const version = option(args, '--worker-version'); assert.ok(typeof version === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(version), '--worker-version にデプロイしたVersion IDを指定');
  const timing = data.timing[scope].map(id => queries.find(q => q.id === id));
  const selected = mode === '--probe' ? [{ id: `${scope}-probe-${run}`, scope, locale: 'ja', filters: {}, query: `日刊検索の疎通確認 ${scope} ${run}` }] : timing;
  const record = { kind: mode === '--probe' ? 'probe' : 'browser', ...metadata, worker_version: version, run,
    started: new Date().toISOString(), queries: selected, rows: [], protected_evaluation: protectedEvaluation,
    ...(cancelAfter === null ? {} : { cancel_after_ms: cancelAfter }) };
  if (mode === '--browser' && run === 2) {
    const previous = option(args, '--previous'); assert.ok(previous, '--run 2 には --previous <前回の記録>');
    checkPrevious(JSON.parse(readFileSync(resolve(previous), 'utf8')), record, new Date(), magi.SITE_RANK.cache_ttl_ms);
  }
  let names = []; try { names = readdirSync(join(ROOT, RAW)); } catch (_) {}
  const history = names.filter(n => /^daily-rank-(?:browser|probe)-.*\.json$/.test(n)).map(n => JSON.parse(read(`${RAW}/${n}`)));
  record.budget = checkTimingBudget(history, record, mode === '--probe' ? 1 : 24);
  const production = await dailySnapshot(magi, scope, async name => {
    const r = await fetch(`https://tk.st/job/${magi.searchScope(scope).media}/${name}`, { cache: 'no-cache', signal: AbortSignal.timeout(8000) });
    assert.ok(r.ok); return r.text();
  });
  assert.equal(production.index_hash, local.index_hash, '本番の全年度の索引がfixtureと違う');
  const apiKey = protectedEvaluation ? process.env.SITE_RANK_EVAL_KEY : null;
  assert.ok(!protectedEvaluation || apiKey, 'SITE_RANK_EVAL_KEY が無い');
  const page = await openRankPage({ apiKey }); record.browser = page.version; record.blocked = page.blocked;
  try {
    for (const q of selected) {
      const response = await page.send({ mode: 'rank', scope, query: q.query, locale: q.locale, filters: q.filters, generation: local.generation },
        cancelAfter === null ? {} : { timeout: cancelAfter });
      record.rows.push(timingRow(magi, q, response, local));
    }
  } finally {
    await page.close(); record.finished = new Date().toISOString();
    record.valid = record.rows.length === (mode === '--probe' ? 1 : 24) && record.rows.every(r => !r.invalid.length)
      && record.started.slice(0, 10) === record.finished.slice(0, 10);
    record.p95 = percentile(record.rows.map(r => r.ms), 0.95);
    record.successes = record.rows.filter(r => r.status !== 'failed').length;
    record.timeouts = record.rows.filter(r => /timeout/i.test(r.reason || '')).length;
    if (mode === '--browser') record.score = resultScore(timing, record.rows.map(r => ({ id: r.id, by_threshold: { [metadata.threshold]: r } })), metadata.threshold);
    console.log(JSON.stringify({ scope, run, valid: record.valid, p95: record.p95, score: record.score, file: writeRecord(record) }));
    if (!record.valid || (mode === '--browser' && record.p95 > 1500)) process.exitCode = 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
