// NEXTの回帰確認。本番DB・外部APIへは接続しない。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { legacyFeatures } from './fixtures/dj-next-rule.js';
import * as music from '../../dj/booth/transition-score.js';
import { TRANSITION_QUESTION, TRANSITION_LIMITS, parseTransitionScore, transitionScores } from '../../workers/dj-request/src/transitions.js';

const root = new URL('../../', import.meta.url);
const file = (path) => readFileSync(new URL(path, root), 'utf8');
const base = { id: 44, title: 'Home', genre: 'ポップ', originalYear: 2026, releaseYear: 2026,
  bpm: 93.9, camelot: '5B', songKey: 'Eb', bpmSrc: 'est', keySrc: 'est', variant: '' };
const candidate = { id: 46, title: 'Battle Scars', genre: 'ヒップホップ／ラップ', originalYear: 2012, releaseYear: 2012,
  bpm: 84, camelot: '5B', songKey: 'Eb', bpmSrc: 'deezer', keySrc: 'est', variant: '', likes: 0 };
const reply = (score = 2) => ({ answers: { transition: { type: 'score', score, confidence: 1,
  probabilities: Object.fromEntries([0, 1, 2, 3, 4].map((n) => [n, n === score ? 1 : 0])) } } });
const response = () => new Response(JSON.stringify(reply()), { headers: { 'Content-Type': 'application/json' } });
function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(file('workers/dj-request/schema.sql'));
  sqlite.exec(file('workers/dj-request/migrations/0008_transition_scores.sql')); // 2回目も適用可能
  const db = { prepare(sql) {
    const bound = (args) => ({
      async all() { return { results: sqlite.prepare(sql).all(...args) }; },
      async first() { return sqlite.prepare(sql).get(...args) || null; },
      async run() { const result = sqlite.prepare(sql).run(...args); return { meta: { changes: result.changes } }; },
    });
    return { ...bound([]), bind(...args) { return bound(args); } };
  } };
  return { sqlite, db, env: { DB: db, TYPESAFE_API_KEY: 'test-key' } };
}
const originalFetch = globalThis.fetch;
let calls = 0, bodies = [];
const normalFetch = async (_url, options) => { calls++; bodies.push(JSON.parse(options.body)); return response(); };
globalThis.fetch = normalFetch;
try {
  assert.deepEqual([0, 1, 2, 10].map(music.likePoints), [0, 10, 15, 25]);
  assert(Math.abs(music.likePoints(5) - 150 / 7) < 1e-12);
  assert(music.likePoints(Number.MAX_SAFE_INTEGER) <= 30);
  assert(music.likePoints(Number.MAX_SAFE_INTEGER + 1) > 29.99);
  assert.equal(music.totalPoints(0.3375, 1), 33.625);
  const state = music.transitionState(base, candidate);
  assert.equal(state.bpmFit.m, 0.5);
  assert.equal(state.keyFit.score, 0);
  assert(!/title|artist|styleDescription|likes|votes|status/.test(JSON.stringify(state)));
  assert.equal(music.transitionSignature(base, candidate), music.transitionSignature(base, { ...candidate, likes: 10, votes: 20, status: 'queued' }));
  assert.notEqual(music.transitionSignature(base, candidate), music.transitionSignature({ ...base, bpm: 64, bpmTapped: true }, candidate));
  assert.equal(music.bpmForMix({ ...base, bpm: 64, bpmTapped: true }), 64);
  assert.throws(() => parseTransitionScore({ answers: { transition: { ...reply().answers.transition, score: '2' } } }));
  assert.throws(() => parseTransitionScore({ answers: { transition: { ...reply().answers.transition, score: 4 } } }));
  assert.equal(parseTransitionScore(reply(0)).score, 0);

  const recordedIndex = process.argv.indexOf('--recorded-run');
  if (recordedIndex >= 0) {
    const recorded = JSON.parse(readFileSync(process.argv[recordedIndex + 1], 'utf8'));
    assert.deepEqual(TRANSITION_QUESTION, recorded.input.question);
    for (const pair of recorded.input.cases) {
      const legacy = legacyFeatures(pair.from, pair.to);
      assert.deepEqual(legacy, pair.features);
      assert.deepEqual(music.transitionState(pair.from, pair.to), {
        from: { genre: pair.from.genre, originalYear: pair.from.originalYear, releaseYear: pair.from.releaseYear,
          bpm: pair.from.bpm, camelot: pair.from.camelot, songKey: pair.from.songKey, bpmSrc: pair.from.bpmSrc, keySrc: pair.from.keySrc,
          versionKind: ['remix', 'refix', ' mix'].some((v) => pair.from.variant.toLowerCase().includes(v)) ? 'remix'
            : pair.from.variant.toLowerCase().includes('extended') ? 'extended' : 'unspecified' },
        to: { genre: pair.to.genre, originalYear: pair.to.originalYear, releaseYear: pair.to.releaseYear,
          bpm: pair.to.bpm, camelot: pair.to.camelot, songKey: pair.to.songKey, bpmSrc: pair.to.bpmSrc, keySrc: pair.to.keySrc,
          versionKind: ['remix', 'refix', ' mix'].some((v) => pair.to.variant.toLowerCase().includes(v)) ? 'remix'
            : pair.to.variant.toLowerCase().includes('extended') ? 'extended' : 'unspecified' },
        bpmFit: legacy.bpmFit, keyFit: legacy.keyFit, effectiveFromBpm: legacy.effectiveFromBpm, effectiveToBpm: legacy.effectiveToBpm,
      });
    }
    for (const result of recorded.results) {
      const parsed = parseTransitionScore({ answers: { transition: result.answer } });
      assert.equal(parsed.score, result.score); assert.equal(parsed.confidence, result.confidence);
    }
    console.log(`承認された実曲${recorded.input.cases.length}組の入力・質問、${recorded.results.length}応答: OK`);
  }

  // 保存済みの評価は再読込・いいね変更で課金されず、メタデータ変更だけ再評価する。
  const first = database(); calls = 0; bodies = [];
  assert.equal((await transitionScores(first.env, base, [candidate], 'test-model'))[0].status, 'ok');
  assert.equal((await transitionScores(first.env, base, [{ ...candidate, likes: 5, status: 'queued' }], 'test-model'))[0].status, 'ok');
  assert.equal(calls, 1);
  await transitionScores(first.env, base, [{ ...candidate, bpm: 85 }], 'test-model');
  assert.equal(calls, 2);
  assert.equal((await transitionScores({ DB: first.db }, base, [candidate], 'test-model'))[0].status, 'ok');
  assert.equal(calls, 2);
  assert.equal((await transitionScores({ DB: first.db }, base, [{ ...candidate, bpm: 86 }], 'test-model'))[0].status, 'unavailable');
  assert.equal(calls, 2);

  const concurrent = database(); calls = 0;
  globalThis.fetch = async (...args) => { await new Promise((resolve) => setImmediate(resolve)); return normalFetch(...args); };
  await Promise.all([transitionScores(concurrent.env, base, [candidate], 'test-model'), transitionScores(concurrent.env, base, [candidate], 'test-model')]);
  assert.equal(calls, 1);
  concurrent.sqlite.exec("UPDATE transition_scores SET status = 'pending', updated_at = datetime('now', '-40 seconds')");
  assert.equal((await transitionScores(concurrent.env, base, [candidate], 'test-model'))[0].status, 'ok');
  assert.equal(calls, 2); // Workerが途中で落ちても古い先取りを回収する

  const budget = database(); calls = 0; globalThis.fetch = normalFetch;
  const dailyCap = TRANSITION_LIMITS.dailyCap; TRANSITION_LIMITS.dailyCap = 2;
  const several = Array.from({ length: 5 }, (_, i) => ({ ...candidate, id: 100 + i, bpm: 101 + i }));
  const capped = await transitionScores(budget.env, base, several, 'test-model');
  assert.equal(calls, 2); assert.equal(capped.filter((r) => r.status === 'failed').length, 3);
  await transitionScores(budget.env, base, several, 'test-model'); assert.equal(calls, 2);
  TRANSITION_LIMITS.dailyCap = dailyCap;

  const failure = database(); calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('private upstream error', { status: 503 }); };
  assert.equal((await transitionScores(failure.env, base, [candidate], 'test-model'))[0].status, 'failed');
  await transitionScores(failure.env, base, [candidate], 'test-model'); assert.equal(calls, 1);
  failure.sqlite.exec("UPDATE transition_scores SET updated_at = datetime('now', '-70 seconds')");
  globalThis.fetch = normalFetch;
  assert.equal((await transitionScores(failure.env, base, [candidate], 'test-model'))[0].status, 'ok'); assert.equal(calls, 2);

  const batching = database(); calls = 0;
  const many = Array.from({ length: 15 }, (_, i) => ({ ...candidate, id: 200 + i, bpm: 140 + i }));
  const partial = await transitionScores(batching.env, base, many, 'test-model');
  assert.equal(calls, 12); assert.equal(partial.filter((r) => r.status === 'pending').length, 3);
  assert((await transitionScores(batching.env, base, many, 'test-model')).every((r) => r.status === 'ok')); assert.equal(calls, 15);

  const timed = database(), timeoutMs = TRANSITION_LIMITS.timeoutMs;
  TRANSITION_LIMITS.timeoutMs = 15;
  globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  assert.equal((await transitionScores(timed.env, base, [candidate], 'test-model'))[0].status, 'failed');
  TRANSITION_LIMITS.timeoutMs = timeoutMs; globalThis.fetch = normalFetch;

  // 実際のNEXT描画関数で、いいね加点・古い応答破棄・タップBPMを確認。
  const html = file('dj/booth/index.html');
  const uiCode = html.slice(html.indexOf('    function mixPlan('), html.indexOf('    // 候補を押したら'));
  const view = {}, requests = [];
  const uiBase = { ...base, status: 'played', playedAt: '2026-10-04T00:00:00Z' };
  const other = { ...candidate, id: 48, bpm: 89.9, title: 'コンチ', camelot: '9B', songKey: 'G', likes: 1, status: 'pending' };
  const ui = vm.createContext({ ...music, songs: [uiBase, { ...candidate, status: 'pending' }, other], tapCode: 'EVENT1', tapMap: new Map(),
    asDate: (value) => new Date(value), esc: String, Date,
    paintHTML: (selector, output) => { view[selector] = output; },
    apiJson: (_path, options) => new Promise((resolve, reject) => requests.push({ ...options.json, resolve, reject })),
  });
  vm.runInContext(uiCode + '\nglobalThis.paint = renderNext;', ui);
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  ui.paint(); assert.equal(requests.length, 1); assert.match(view['#nextList'], /評価中/);
  requests[0].resolve({ eventCode: 'EVENT1', baseId: 44, scores: [candidate, other].map((song) => ({ songId: song.id,
    signature: music.transitionSignature(base, song), status: 'ok', score: 0.5 })) });
  await flush();
  assert(view['#nextList'].indexOf('data-id="48"') < view['#nextList'].indexOf('data-id="46"'));
  assert.match(view['#nextList'], /45\.0点/);
  ui.songs[2].likes = 0; ui.paint(); assert.equal(requests.length, 1);
  ui.tapMap.set(44, 64); ui.songs[0].bpm = 64; ui.songs[0].bpmTapped = true; ui.paint();
  assert.equal(requests.length, 2); assert.equal(requests[1].tapBpms[44], 64);
  ui.tapCode = 'EVENT2'; ui.songs = [{ ...uiBase }, { ...candidate, status: 'pending' }]; ui.paint();
  requests[1].resolve({ eventCode: 'EVENT1', baseId: 44, scores: [] }); await flush();
  assert(!/45\.0点/.test(view['#nextList'])); // 前のイベントの票数で再描画しない

  // 新着の待機・失敗・キー未設定・通信失敗でも、評価済みの候補を残す。
  for (const status of ['pending', 'failed', 'unavailable', 'network_error']) {
    let now = Date.now();
    class TestDate extends Date { static now() { return now; } }
    const partialView = {}, partialRequests = [];
    const knownSong = { ...candidate, status: 'pending', likes: 1 };
    const newSong = { ...other, id: 70, title: '新着の候補', likes: 0 };
    const partialUi = vm.createContext({ ...music, songs: [{ ...uiBase }, knownSong], tapCode: 'PARTIAL', tapMap: new Map(),
      asDate: (value) => new Date(value), esc: String, Date: TestDate,
      paintHTML: (selector, output) => { partialView[selector] = output; },
      apiJson: (_path, options) => new Promise((resolve, reject) => partialRequests.push({ ...options.json, resolve, reject })),
    });
    vm.runInContext(uiCode + '\nglobalThis.paint = renderNext;', partialUi);
    const knownResult = { songId: knownSong.id, signature: music.transitionSignature(uiBase, knownSong), status: 'ok', score: 0 };
    const newResult = { songId: newSong.id, signature: music.transitionSignature(uiBase, newSong), status };
    partialUi.paint();
    partialRequests[0].resolve({ eventCode: 'PARTIAL', baseId: 44, scores: [knownResult] }); await flush();
    assert.match(partialView['#nextList'], /data-id="46"/); // 0点も評価済みとして扱う
    partialUi.songs.push(newSong); partialUi.paint();
    assert.match(partialView['#nextList'], /data-id="46"/);
    assert.match(partialView['#nextList'], /評価済み 1 \/ 2曲 · 未評価 1曲/);
    if (status === 'network_error') partialRequests[1].reject(new Error('connection failed'));
    else partialRequests[1].resolve({ eventCode: 'PARTIAL', baseId: 44, scores: [knownResult, newResult] });
    await flush();
    assert.match(partialView['#nextList'], /data-id="46"/);
    assert(!partialView['#nextList'].includes('data-id="70"'));
    assert.match(partialView['#nextList'], /評価済み 1 \/ 2曲 · 未評価 1曲/);
    assert(!/NaN|undefined/.test(partialView['#nextList']));
    assert.match(partialView['#nextList'], status === 'pending' ? /評価中/ : /取得できません/);
    // 復旧して評価が届けば順位に加わり、未評価の案内は消える。
    now += 31000; partialUi.paint();
    assert.equal(partialRequests.length, 3);
    partialRequests[2].resolve({ eventCode: 'PARTIAL', baseId: 44,
      scores: [knownResult, { ...newResult, status: 'ok', score: 0.9 }] }); await flush();
    assert(partialView['#nextList'].indexOf('data-id="70"') < partialView['#nextList'].indexOf('data-id="46"'));
    assert(!/未評価/.test(partialView['#nextList']));
    // 起点のBPM変更後は、その条件で未評価の曲に以前の点数を使わない。
    partialUi.songs[0].bpm = 130; partialUi.paint();
    assert(!/class="cand"/.test(partialView['#nextList']));
    assert.match(partialView['#nextList'], /評価済み 0 \/ 2曲 · 未評価 2曲/);
    partialRequests[3].resolve({ eventCode: 'PARTIAL', baseId: 44, scores: partialUi.songs.slice(1).map((song) => ({
      songId: song.id, signature: music.transitionSignature(partialUi.songs[0], song), status: 'failed',
    })) }); await flush();
    assert(!/class="cand"/.test(partialView['#nextList']));
    assert.match(partialView['#nextList'], /未評価 2曲。相性の評価を取得できません/);
  }

  const bundleIndex = process.argv.indexOf('--worker-bundle');
  if (bundleIndex >= 0) {
    const worker = (await import(pathToFileURL(process.argv[bundleIndex + 1]).href)).default;
    const routed = database(); globalThis.fetch = normalFetch; calls = 0; bodies = [];
    routed.sqlite.exec("INSERT INTO events(code,title,status) VALUES ('EVENT1','test','open');");
    for (const song of [uiBase, { ...candidate, status: 'pending' }]) {
      routed.sqlite.prepare(`INSERT INTO songs(id,event_code,dedupe_key,title,variant,genre,release_year,bpm,song_key,camelot,bpm_src,key_src,status,played_at)
        VALUES (?, 'EVENT1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(song.id, String(song.id), song.title, song.variant,
          song.genre, song.releaseYear, song.bpm, song.songKey, song.camelot, song.bpmSrc, song.keySrc, song.status, song.playedAt || null);
    }
    const post = (body, origin = 'https://tk.st') => new Request('https://tk.st/dj/api/req/admin/next', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body),
    });
    const requestBody = { eventCode: 'EVENT1', baseId: 44, tapBpms: {} };
    assert.equal((await worker.fetch(post(requestBody, ''), routed.env, {})).status, 403);
    assert.equal((await worker.fetch(post({ ...requestBody, eventCode: 'EVENT2' }), routed.env, {})).status, 409);
    assert.equal((await worker.fetch(post({ ...requestBody, baseId: 46 }), routed.env, {})).status, 409); assert.equal(calls, 0);
    const result = await worker.fetch(post({ ...requestBody, tapBpms: { 44: 64 }, genre: 'injected', questions: {} }), routed.env, {});
    assert.equal(result.status, 200); assert.equal((await result.json()).scores[0].status, 'ok');
    assert.equal(bodies[0].state.from.genre, 'ポップ'); assert.equal(bodies[0].state.effectiveFromBpm, 64);
    assert(!JSON.stringify(bodies[0]).includes('Home'));
    console.log('バンドルしたWorkerのOrigin・起点・イベント照合とタップBPM: OK');
  }
  console.log('加点・D1キャッシュ・重複抑止・上限・失敗後の再試行・分割評価・NEXT描画・部分失敗と復旧: OK');
} finally { globalThis.fetch = originalFetch; }
