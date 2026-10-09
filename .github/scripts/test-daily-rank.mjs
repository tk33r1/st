// T09の評価器を模擬Jevで検証する。ネットワーク・本番Worker・実キーは使わない。
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { loadWorker } from './eval-site-rank.mjs';
import { dailySnapshot, loadFixtures, checkDailyQueries, queryCandidates, candidateScore, resultScore,
  measureAccuracy, accuracyReport, timingRow, checkPrevious, checkTimingBudget, percentile } from './eval-daily-rank.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = p => readFileSync(join(root, p), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
const data = JSON.parse(read('.github/site-search/phase3-rank-queries.json'));
const fixtures = '.github/site-search/fixtures/phase3';
const indexFailure = e => e.searchCode === 'index_unavailable';
const synthetic = (magi, scope, mutate = () => {}) => dailySnapshot(magi, scope, name => {
  const file = JSON.parse(read(`${fixtures}/synthetic/${scope}/${name}`)); mutate(file, name); return JSON.stringify(file);
});
const query = (scope, text = '前年の特別な電動米びつ', filters = {}) => ({ id: scope + '-001', scope, locale: 'ja', query: text, filters });

test('固定380記事・120問・splitごとの6件の答え無し、速度の24問を検査する', async () => {
  const magi = loadWorker(), { snapshots, termsSourceHash } = await loadFixtures(magi, data);
  assert.equal(termsSourceHash, null);
  const summary = checkDailyQueries(magi, data, snapshots);
  assert.equal(snapshots.nitori.records, 176); assert.equal(snapshots.retail.records, 204);
  for (const scope of ['nitori', 'retail']) {
    assert.deepEqual(summary[scope], { tune: { total: 30, answered: 24, none: 6 }, final: { total: 30, answered: 24, none: 6 } });
    assert.ok(data.timing[scope].some(id => data.queries.find(q => q.id === id).type === 'english'));
    for (const { name } of data.indexes[scope].files) {
      const original = execFileSync('git', ['show', `${data.source_commit}:job/${magi.searchScope(scope).media}/${name}`], { cwd: root });
      assert.deepEqual(readFileSync(join(root, fixtures, scope, name)), original);
    }
  }
  const changed = copy(data); changed.indexes.nitori.files[0].sha256 = '0'.repeat(64);
  await assert.rejects(loadFixtures(magi, changed), /固定索引が変更/);
});

test('正解・条件・重複・0件・答え無し・split・速度セットの改変を拒否する', async () => {
  const magi = loadWorker(), { snapshots } = await loadFixtures(magi, data);
  const changes = [
    d => { d.queries[0].answers = ['nitoridaily:20240101:999']; },
    d => { d.queries[0].filters = { region: 'EU' }; },
    d => { d.queries[0].filters = { category: '索引に無いカテゴリー' }; },
    d => { d.queries[0].filters = { month: '202610', region: 'GLOBAL', category: '商品・サービス' }; },
    d => { d.queries[0].query += '\n'; },
    d => { d.queries[0].answers.push(d.queries[0].answers[0]); },
    d => { Object.assign(d.queries[1], { ...d.queries[0], id: d.queries[1].id }); },
    d => { d.queries[0].type = 'none'; },
    d => { d.queries = d.queries.filter(q => q.id !== 'nitori-030'); },
    d => { d.queries[0].set = 'final'; },
    d => { d.timing.nitori[0] = 'nitori-001'; },
    d => { d.timing.nitori[1] = d.timing.nitori[0]; },
    d => { d.queries.forEach(q => q.coverage = q.coverage.filter(c => c !== 'no_overlap')); },
    d => { d.queries[0].coverage.push('no_overlap'); },
    d => { d.frozen = '2026-02-29'; },
  ];
  for (const change of changes) { const changed = copy(data); change(changed); assert.throws(() => checkDailyQueries(magi, changed, snapshots)); }
});

test('語を足した固定索引でも120問の正解・本文とJevの変換を保持し、元のhashと混ぜない', async () => {
  const magi = loadWorker(), { snapshots: original } = await loadFixtures(magi, data);
  const { snapshots: enriched, termsSourceHash } = await loadFixtures(magi, data, { indexSet: 'terms' });
  assert.equal(termsSourceHash, JSON.parse(read(`${fixtures}/with-search-terms/indexes.json`)).terms_source_sha256);
  assert.deepEqual(checkDailyQueries(magi, data, enriched), checkDailyQueries(magi, data, original));
  for (const scope of ['nitori', 'retail']) {
    assert.equal(enriched[scope].candidate_hash, original[scope].candidate_hash);
    assert.notEqual(enriched[scope].index_hash, original[scope].index_hash);
    assert.notEqual(enriched[scope].generation, original[scope].generation);
    assert.deepEqual(copy(enriched[scope].snapshot.raw.map(({ search_terms, ...p }) => p)), copy(original[scope].snapshot.raw));
  }
  const wrong = copy(data); wrong.indexes.nitori.index_hash = '0'.repeat(64);
  await assert.rejects(loadFixtures(magi, wrong, { indexSet: 'terms' }));
  await assert.rejects(loadFixtures(magi, data, { indexSet: 'other' }));
});

test('接客のコーチング20記事があっても、古いCoachブランド記事を候補から落とさない', async () => {
  const script = `
import sys, json, importlib.util
sys.path.insert(0, '.github/scripts')
from daily_engine import build_search_index
from daily_search_terms import fallback_search_terms
spec = importlib.util.spec_from_file_location('nitori', '.github/scripts/generate-nitori-daily.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
def article(title):
    value = {'title': title, 'summary': '', 'category': '話題', 'tags': []}
    value['search_terms'] = fallback_search_terms(value)
    return value
history = [
    {'date': '20261010', 'articles': [article('店舗スタッフの接客をコーチング') for _ in range(20)]},
    {'date': '20260910', 'articles': [article('コーチが新作バッグを発表')]},
]
print(json.dumps(build_search_index(module.CONFIG, history), ensure_ascii=False))
`;
  const files = JSON.parse(execFileSync('python', ['-B', '-c', script], { cwd: root, encoding: 'utf8' }));
  const magi = loadWorker(), local = await dailySnapshot(magi, 'nitori', name => JSON.stringify(files[name]));
  assert.equal(local.records, 21);
  const candidates = queryCandidates(magi, local, query('nitori', 'Coach'));
  assert.equal(candidates.ids.length, 20);
  assert.equal(candidates.ids[0], 'nitoridaily:20260910:1');
});

for (const scope of ['nitori', 'retail']) {
  test(scope + ': 言い換え語は古い記事を候補に入れ、Jevの内容・ハッシュ・filtersを変えない', async () => {
    const magi = loadWorker(), original = await synthetic(magi, scope);
    const terms = ['home storage', '片付け', 'organize rooms'];
    const enriched = await synthetic(magi, scope, (f, name) => { if (name === 'search-index-2025.json') f.records[0].search_terms = terms; });
    const q = query(scope, 'home storage'), oldId = `${magi.searchScope(scope).media}:20251231:1`;
    assert.ok(!queryCandidates(magi, original, q).ids.includes(oldId));
    assert.ok(queryCandidates(magi, enriched, q).ids.includes(oldId));
    assert.ok(!queryCandidates(magi, enriched, query(scope, q.query, { month: '202601' })).ids.includes(oldId));
    assert.equal(original.candidate_hash, enriched.candidate_hash); assert.notEqual(original.index_hash, enriched.index_hash);
    const old = enriched.snapshot.raw.find(p => p.id === oldId);
    assert.deepEqual(copy(old.search_terms), terms);
    assert.ok(!('search_terms' in magi.toRankCandidate(old)));
    assert.ok(!JSON.stringify(queryCandidates(magi, enriched, q).payload).includes('home storage","片付け'));
    const comparison = [{ ...old, title: 'home storage', search_terms: undefined }, old];
    const ranked = magi.shortlistRankDaily(comparison, q.query, scope);
    assert.ok(ranked[0].score > ranked[1].score, '題名より軽い重み');
  });

  test(scope + ': 省略された語は従来どおり、不正な語・件数・制御文字・重複は索引全体を拒否する', async () => {
    const magi = loadWorker();
    for (const terms of [null, 'word', [], ['one', 'two'], ['a','b','c','d','e','f'], ['a','a','b'],
      ['a','b', ''], ['a','b', '\ufeff'], ['a','b', 4], ['a','b','x\x00'], ['a','b','x\x85'], ['a','b','🧺'.repeat(61)]]) {
      await assert.rejects(synthetic(magi, scope, f => { f.records[0].search_terms = terms; }), indexFailure);
    }
    const accepted = await synthetic(magi, scope, f => { f.records[0].search_terms = ['収納', 'home storage', '🧺'.repeat(60)]; });
    assert.equal(accepted.records, 25);
  });

  test(scope + ': 全3年度・閏日・年境界・同じ号の別アンカー・長文とUnicodeをWorkerで読む', async () => {
    const magi = loadWorker(), local = await synthetic(magi, scope);
    assert.equal(local.records, 25); assert.deepEqual(local.years, ['2026', '2025', '2024']);
    assert.equal(local.generation, 'a1b2'); assert.equal(local.files.length, 3);
    assert.equal(magi.filterDailyItems(local.snapshot, { month: '202402' }).length, 1);
    const old = magi.filterDailyItems(local.snapshot, { month: '202512' });
    assert.equal(old.length, 2); assert.notEqual(old[0].id, old[1].id);
    assert.ok(old.every(p => magi.dailyResultUrl(scope, p)));
    const selected = queryCandidates(magi, local, query(scope));
    assert.equal(selected.total, 25); assert.equal(selected.ids.length, 20); assert.ok(selected.ids.includes(old[0].id));
    const scoped = queryCandidates(magi, local, query(scope, '別記事', { month: '202512', region: 'GLOBAL' }));
    assert.equal(scoped.total, 1); assert.deepEqual(copy(scoped.ids), [old[1].id]);
    const c = magi.toRankCandidate(local.snapshot.raw[0]);
    assert.ok(Array.from(c.summary).length <= 300);
    assert.ok(Object.values(c).flat().reduce((n, s) => n + Array.from(s).length, 0) <= 400);
    assert.match(c.title, /👩‍💻/);
    const repeat = await synthetic(magi, scope);
    assert.equal(repeat.index_hash, local.index_hash); assert.equal(repeat.candidate_hash, local.candidate_hash);
  });

  test(scope + ': 年ファイルの欠落・混版・媒体違い・不正な暦・重複・無効な文字を拒否する', async () => {
    const magi = loadWorker();
    const changes = [
      (f, n) => { if (n !== 'search-index.json') f.generation = 'ffff'; },
      f => { f.media = 'otherdaily'; },
      (f, n) => { if (n === 'search-index-2024.json') { f.records[0].date = '20230229'; f.records[0].url = '20230229/#art-1'; } },
      f => { f.records.push(f.records[0]); },
      f => { f.records[0].category += '\u0000'; },
      f => { f.records[0].title = ''; },
      f => { f.records[0].tags.push(''); },
      f => { f.records[0].url = 'https://example.com/'; },
    ];
    for (const mutate of changes) await assert.rejects(synthetic(magi, scope, mutate), indexFailure);
    await assert.rejects(dailySnapshot(magi, scope, name => name === 'search-index-2025.json' ? undefined : read(`${fixtures}/synthetic/${scope}/${name}`)), indexFailure);
    let reads = 0;
    await assert.rejects(dailySnapshot(magi, scope, () => { reads++; return '{"years":["2026","../../x"]}'; }));
    assert.equal(reads, 1);
  });
}

test('候補recallは正解群の1件以上で数え、欠けた要求を分母から除かない', () => {
  const qs = [{ id: 'a', answers: ['old', 'new'] }, { id: 'b', answers: ['old2'] }, { id: 'n', answers: [] }];
  assert.deepEqual(candidateScore(qs, [{ id: 'a', candidate_ids: ['new'] }]), { hit: 1, total: 2, rate: 0.5, pass: false });
  const rows = qs.map(q => ({ id: q.id, candidate_ids: q.answers.slice(0, 1) }));
  assert.equal(candidateScore(qs, rows).pass, true);
});

test('精度の分母・上位5件・答え無しの誤表示・途中失敗を正しく数える', () => {
  const qs = Array.from({ length: 10 }, (_, i) => ({ id: String(i), answers: i < 5 ? ['gold'] : [] }));
  const row = (id, ids) => ({ id, by_threshold: { 0.4: { status: ids.length ? 'results' : 'no_results', complete: true, ids } } });
  const rows = qs.map(q => row(q.id, q.answers));
  assert.equal(resultScore(qs, rows, 0.4).pass, true);
  rows[4] = row('4', ['a', 'b', 'c', 'd', 'e', 'gold']);
  assert.equal(resultScore(qs, rows, 0.4).hit, 4);
  rows[5] = row('5', ['other']); assert.equal(resultScore(qs, rows, 0.4).pass, false);
  rows[5] = row('5', []); rows.pop();
  assert.equal(resultScore(qs, rows, 0.4).failed, 1); assert.equal(resultScore(qs, rows, 0.4).pass, false);
  assert.equal(resultScore(qs, rows, 0.6).failed, 10);
});

for (const scope of ['nitori', 'retail']) {
  test(scope + ': 直接Jevは各要求1回・各run1回、閾値再生は追加課金せずcNNをその要求のIDへ戻す', async () => {
    const magi = loadWorker(), local = await synthetic(magi, scope), hook = magi.hooks.fetch;
    const qs = [query(scope), { ...query(scope, '別記事', { month: '202512', region: 'GLOBAL' }), id: scope + '-002' }];
    let calls = 0;
    const ms = await measureAccuracy(magi, local, qs, { key: 'not-a-real-secret', thresholds: [0.4, 0.6], runs: 2,
      liveFetch: async (url, opts) => {
        assert.equal(url, magi.SITE_RANK.endpoint); assert.equal(opts.headers.Authorization, 'Bearer not-a-real-secret'); calls++;
        const payload = JSON.parse(opts.body);
        assert.ok(!JSON.stringify(payload).includes('/job/')); assert.ok(payload.questions.c01.instructions);
        return Response.json({ model: 'mock-version', usage: { input_tokens: 42 }, answers: Object.fromEntries(Object.keys(payload.questions).map(id => [id, { type: 'noul', noul: id === 'c01' ? 0.55 : 0.1 }])) });
      } });
    assert.equal(calls, 4); assert.equal(ms.length, 2); assert.equal(ms[0].rows[1].candidate_ids.length, 1);
    for (const m of ms) for (const r of m.rows) {
      assert.deepEqual(copy(r.by_threshold[0.4].ids), [r.candidate_ids[0]]);
      assert.equal(r.by_threshold[0.6].status, 'no_results'); assert.equal(r.probs[r.candidate_ids[0]], 0.55);
      assert.equal(r.model, 'mock-version'); assert.equal(r.usage.input_tokens, 42);
    }
    assert.ok(!JSON.stringify(ms).includes('not-a-real-secret'));
    assert.equal(magi.rankScopeConfig(scope).threshold, 0.4); assert.equal(magi.hooks.fetch, hook);
  });
}

test('不完全なprob・読めない本文・HTTP失敗を正解や答え無しにしない', async () => {
  const magi = loadWorker(), local = await synthetic(magi, 'nitori');
  const qs = [query('nitori')];
  for (const response of [Response.json({ answers: { c01: { type: 'noul', noul: 1.1 } } }), new Response('not JSON'), new Response('bad gateway', { status: 502 })]) {
    const ms = await measureAccuracy(magi, local, qs, { key: 'mock', runs: 1, thresholds: [0.4], liveFetch: async () => response });
    assert.equal(ms[0].rows[0].by_threshold[0.4].status, 'failed');
  }
  const incomplete = await measureAccuracy(magi, local, qs, { key: 'mock', runs: 1, thresholds: [0.4], liveFetch: async () => Response.json({ answers: { c01: { type: 'noul', noul: 0.9 } } }) });
  assert.equal(incomplete[0].rows[0].by_threshold[0.4].complete, false);
  assert.equal(incomplete[0].rows[0].by_threshold[0.4].searched.judged, 1);
});

test('呼び出しの時間切れは全閾値で時間切れとして保存する', async () => {
  const magi = loadWorker(), local = await synthetic(magi, 'nitori'); magi.SITE_RANK.jev_timeout_ms = 20;
  let calls = 0;
  const ms = await measureAccuracy(magi, local, [query('nitori')], { key: 'mock', runs: 1, thresholds: [0.3, 0.6],
    liveFetch: async () => { calls++; return new Promise(() => {}); } });
  assert.equal(calls, 1);
  for (const r of Object.values(ms[0].rows[0].by_threshold)) assert.equal(r.reason, 'timeout');
});

test('残高・認証の失敗で止まり、部分記録と元の設定を残す', async () => {
  for (const status of [401, 402, 403, 429]) {
    const magi = loadWorker(), local = await synthetic(magi, 'retail'), hook = magi.hooks.fetch;
    let calls = 0;
    await assert.rejects(measureAccuracy(magi, local, [query('retail'), query('retail', '閏日')], { key: 'mock', runs: 2, thresholds: [0.6],
      liveFetch: async () => { calls++; return new Response('insufficient balance', { status }); } }), e => {
      assert.equal(e.measurements[0].rows.length, 1); assert.match(e.message, /測定を停止/); return true;
    });
    assert.equal(calls, 1); assert.equal(magi.rankScopeConfig('retail').threshold, 0.4); assert.equal(magi.hooks.fetch, hook);
  }
});

test('精度レポートは各runを分け、モデル版・欠落・候補の取りこぼしを残す', () => {
  const report = accuracyReport({ scope: 'nitori', set: 'tune', annotator: 'codex', thresholds: [0.4],
    queries: [{ id: 'a', answers: ['gold'] }, { id: 'b', answers: [] }],
    measurements: [{ run: 1, rows: [{ id: 'a', candidate_ids: ['other'], model: 'mock-version', usage: {}, jev_ms: 9, by_threshold: { 0.4: { status: 'no_results', ids: [] } } }] }] });
  assert.match(report, /本人未確認/); assert.match(report, /候補に正解 0\/1/); assert.match(report, /mock-version/); assert.match(report, /"failed":1/);
});

test('速度記録は画面の検査を通し、request_id・N/M/J・generation・cachedを残す', async () => {
  const magi = loadWorker(), local = await synthetic(magi, 'nitori'), q = query('nitori');
  const expected = queryCandidates(magi, local, q), p = local.snapshot.raw.find(p => p.id === expected.ids[0]);
  const body = { status: 'results', complete: true, cached: false, request_id: 'req-test', reason: null,
    searched: { total: expected.total, candidates: expected.ids.length, judged: expected.ids.length, generation: local.generation },
    results: [{ kind: 'daily', title: p.title, description: p.summary, url: p.url }] };
  const valid = timingRow(magi, q, { http: 200, data: body, ms: 123 }, local);
  assert.equal(valid.request_id, 'req-test'); assert.equal(valid.ms, 123); assert.equal(valid.cached, false); assert.equal(valid.invalid.length, 0);
  assert.deepEqual(copy(valid.ids), [p.id]);
  const changes = [b => { b.cached = true; }, b => { b.searched.generation = 'ffff'; }, b => { delete b.request_id; },
    b => { b.searched.total++; }, b => { b.searched.judged = 21; },
    b => { b.results[0].url = p.url.replace('nitoridaily', 'retailtechdaily'); },
    b => { b.results.push(copy(b.results[0])); }];
  for (const change of changes) { const b = copy(body); change(b); const r = timingRow(magi, q, { http: 200, data: b, ms: 10 }, local); assert.ok(r.invalid.length); assert.equal(r.ms, 8000); }
  for (const reason of ['disabled', 'rate_limited', 'index_updating', 'timeout']) {
    const r = timingRow(magi, q, { http: reason === 'rate_limited' ? 429 : 200, ms: 9, data: { ...body, status: 'failed', complete: false, results: [], reason } }, local);
    assert.ok(r.invalid.includes(reason)); assert.equal(r.status, 'failed'); assert.equal(r.ms, 8000);
  }
  assert.equal(timingRow(magi, q, { http: null, error: 'TimeoutError', ms: 8500 }, local).ms, 8500);
  assert.equal(percentile(Array.from({ length: 24 }, (_, i) => i + 1), 0.95), 23);
});

test('速度の2回目は同一UTC日・同じ版・24問・キャッシュ期限と余裕を要求する', () => {
  const keys = ['scope', 'index_set', 'terms_source_sha256', 'generation', 'index_hash', 'candidate_hash', 'query_hash', 'code_hash', 'config_hash', 'worker_version', 'protected_evaluation'];
  const current = { kind: 'browser', run: 2, ...Object.fromEntries(keys.map(k => [k, 'same'])), queries: Array.from({ length: 24 }, (_, i) => ({ id: String(i) })) };
  const previous = { ...current, run: 1, valid: true, started: '2026-10-09T01:00:00Z', finished: '2026-10-09T01:01:00Z', rows: current.queries };
  checkPrevious(previous, current, new Date('2026-10-09T01:12:00Z'), 600000);
  assert.throws(() => checkPrevious(previous, current, new Date('2026-10-09T01:11:59Z'), 600000));
  assert.throws(() => checkPrevious(previous, current, new Date('2026-10-10T01:12:00Z'), 600000));
  for (const key of keys) assert.throws(() => checkPrevious({ ...previous, [key]: 'different' }, current, new Date('2026-10-09T01:12:00Z'), 600000));
  assert.throws(() => checkPrevious({ ...previous, valid: false }, current, new Date('2026-10-09T01:12:00Z'), 600000));
  assert.throws(() => checkPrevious({ ...previous, rows: previous.rows.slice(1) }, current, new Date('2026-10-09T01:12:00Z'), 600000));
});

test('疎通2回＋本測定48回の上限と重複を確認し、共有残量はunknownとする', () => {
  const current = { scope: 'nitori', started: '2026-10-09T01:12:00Z', kind: 'browser', run: 2 };
  const history = [{ ...current, kind: 'probe', run: 1, rows: [{}] }, { ...current, kind: 'probe', run: 2, rows: [{}] },
    { ...current, run: 1, rows: Array(24).fill({}) }];
  assert.deepEqual(checkTimingBudget(history, current, 24), { known_scope_calls_today: 26, planned_calls: 24, shared_quota_remaining: 'unknown' });
  assert.throws(() => checkTimingBudget(history, current, 25));
  assert.throws(() => checkTimingBudget([...history, { ...current, rows: [] }], current, 24));
  assert.throws(() => checkTimingBudget([...history, { ...current, scope: 'retail', rows: [{}] }], current, 24));
});

test('CLIのオフライン経路はキーを読まず、回数と費用を示し、曖昧な引数を拒否する', () => {
  for (const scope of ['nitori', 'retail']) for (const indexSet of ['original', 'terms']) {
    const r = spawnSync(process.execPath, ['.github/scripts/eval-daily-rank.mjs', '--plan', '--scope', scope, '--set', 'tune', '--runs', '2', '--index-set', indexSet], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); const plan = JSON.parse(r.stdout);
    assert.equal(plan.requests, 60); assert.equal(plan.questions_max, 20); assert.ok(plan.conservative_cost_usd > 0); assert.match(plan.estimate, /未呼び出し/);
    assert.equal(plan.index_set, indexSet);
    assert.equal(plan.terms_source_sha256, indexSet === 'terms' ? JSON.parse(read(`${fixtures}/with-search-terms/indexes.json`)).terms_source_sha256 : null);
  }
  for (const args of [['--accuracy'], ['--check', '--plan'], ['--check', '--oops'], ['--plan', '--scope', 'nitori', '--scope', 'retail'], ['--browser', '--scope', 'nitori'],
    ['--check', '--eval-key'], ['--accuracy', '--eval-key'], ['--check', '--cancel-after', '100'],
    ['--probe', '--cancel-after', '0'], ['--probe', '--cancel-after', '8000'], ['--probe', '--cancel-after', '1.5'], ['--browser', '--cancel-after', '100']]) {
    const r = spawnSync(process.execPath, ['.github/scripts/eval-daily-rank.mjs', ...args], { cwd: root, encoding: 'utf8' }); assert.equal(r.status, 1);
  }
});
