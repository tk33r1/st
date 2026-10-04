import { transitionState } from '../../../dj/booth/transition-score.js';

// 実曲だけの再テストで承認された質問。この指示と入力をキャッシュキーにも含める。
export const TRANSITION_QUESTION = {
  type: 'score',
  instructions: [
    'DJがfromからtoへ繋ぐ候補として、提示された条件でどれくらい自然な流れを作れるか評価する。',
    '滑らかな流れを優先し、意図的なカットインによる場面転換は優先しない。',
    '実データとして提示されたBPM、キー、原曲の年代、発売年、ジャンル、版の種類だけを総合して評価する。',
    '音源は提供されていない。音色、リズムの特徴、ボーカルの量、曲の構成を推測して補わない。',
    '年代にはoriginalYearを優先し、再発・リミックスのreleaseYearと混同しない。年代が遠いだけで不適にしない。',
    'bpmFitとkeyFitは現行コードの計算済みの参考情報。倍・半分のBPMも参考にし、ラベルを絶対的な結論にしない。',
    'nullや空欄は不明。情報不足を好相性と見なさず、プレビューを聴いたかのように判断しない。',
    'いいね・リクエスト数・採用状況は評価しない。',
  ].join(''),
  criteria: [
    'BPM・キー・ジャンルの複数条件に大きな不整合があり、滑らかな次曲としては不適。または判断材料がほぼない。',
    '通常のテンポ合わせや短いミックスでは自然に続けにくく、カットインなど明確な切替演出が必要。',
    '繋げる材料はあるがBPM・キー・ジャンルに不一致や情報不足があり、ブレイクでの切替や短いミックスなど工夫が必要。',
    '小さな調整や短めのミックスで自然に繋がり、ジャンルや年代による雰囲気変化にも無理が少ない。',
    '提示されたBPM・キーの相性が良く、ジャンル・年代にも無理が少ない。これらの条件が揃い、少ない調整で連続したミックスができる。',
  ],
};
export const TRANSITION_LIMITS = { timeoutMs: 7000, parallel: 4, batch: 12, dailyCap: 2000, staleSec: 30, retrySec: 60 };

export function parseTransitionScore(data) {
  const answer = data?.answers?.transition;
  const valid = (n, max) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= max;
  if (answer?.type !== 'score' || !valid(answer.score, 4) || !valid(answer.confidence, 1)) throw new Error('invalid_score');
  const probabilities = Array.from({ length: 5 }, (_, i) => answer.probabilities?.[i]);
  if (!probabilities.every((p) => valid(p, 1))) throw new Error('invalid_probabilities');
  // APIの小数2桁丸めに対し、合計・重み付き和の最大丸め誤差だけを許容する。
  if (Math.abs(probabilities.reduce((a, b) => a + b, 0) - 1) > 0.025000001
    || Math.abs(probabilities.reduce((a, p, i) => a + p * i, 0) - answer.score) > 0.055000001) throw new Error('invalid_distribution');
  return { score: answer.score / 4, confidence: answer.confidence };
}
export async function requestTransition(state, apiKey, model) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRANSITION_LIMITS.timeoutMs);
  try {
    const response = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST', signal: controller.signal,
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, state, questions: { transition: TRANSITION_QUESTION } }),
    });
    if (!response.ok) throw new Error('transition_unavailable');
    return parseTransitionScore(await response.json());
  } finally { clearTimeout(timer); }
}
async function cacheKey(state, model) {
  const bytes = new TextEncoder().encode(JSON.stringify({ model, question: TRANSITION_QUESTION, state }));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (n) => n.toString(16).padStart(2, '0')).join('');
}
async function readScores(db, keys) {
  const scores = new Map();
  for (let offset = 0; offset < keys.length; offset += 50) {
    const chunk = keys.slice(offset, offset + 50);
    const result = await db.prepare(`SELECT *,
        updated_at < datetime('now', ?1) AS stale,
        updated_at < datetime('now', ?2) AS retry
      FROM transition_scores WHERE cache_key IN (${chunk.map((_, i) => '?' + (i + 3)).join(',')})`)
      .bind(`-${TRANSITION_LIMITS.staleSec} seconds`, `-${TRANSITION_LIMITS.retrySec} seconds`, ...chunk).all();
    for (const row of result.results) scores.set(row.cache_key, row);
  }
  return scores;
}
async function evaluateEntry(db, entry, apiKey, model) {
  // DBで先取りする。別ブラウザ・別isolateの同時要求も同じ評価を重ねない。
  const claim = await db.prepare(`INSERT INTO transition_scores (cache_key, status) VALUES (?1, 'pending')
    ON CONFLICT(cache_key) DO UPDATE SET status = 'pending', score = NULL, confidence = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE (transition_scores.status = 'failed' AND transition_scores.updated_at < datetime('now', ?2))
         OR (transition_scores.status = 'pending' AND transition_scores.updated_at < datetime('now', ?3))`)
    .bind(entry.key, `-${TRANSITION_LIMITS.retrySec} seconds`, `-${TRANSITION_LIMITS.staleSec} seconds`).run();
  if (!claim.meta?.changes) return;
  try {
    const budget = await db.prepare(`INSERT INTO transition_usage (day, calls) VALUES (date('now'), 1)
      ON CONFLICT(day) DO UPDATE SET calls = calls + 1 WHERE calls < ?1`)
      .bind(TRANSITION_LIMITS.dailyCap).run();
    if (!budget.meta?.changes) throw new Error('daily_limit');
    const result = await requestTransition(entry.state, apiKey, model);
    await db.prepare(`UPDATE transition_scores SET status = 'ok', score = ?2, confidence = ?3, updated_at = CURRENT_TIMESTAMP WHERE cache_key = ?1`)
      .bind(entry.key, result.score, result.confidence).run();
  } catch {
    // エラー本文やAPIキーを返さず、失敗の再試行にも間隔を空ける。
    await db.prepare(`UPDATE transition_scores SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE cache_key = ?1`)
      .bind(entry.key).run();
  }
}
export async function transitionScores(env, base, candidates, model) {
  const entries = await Promise.all(candidates.map(async (song) => {
    const state = transitionState(base, song);
    return { id: song.id, state, signature: JSON.stringify(state), key: await cacheKey(state, model) };
  }));
  let cached = await readScores(env.DB, entries.map((entry) => entry.key));
  const apiKey = env.TYPESAFE_API_KEY || env.MAGI_TYPESAFE_API_KEY;
  const missing = entries.filter((entry) => {
    const row = cached.get(entry.key);
    return !row || (row.status === 'pending' && row.stale) || (row.status === 'failed' && row.retry);
  }).slice(0, TRANSITION_LIMITS.batch);
  if (apiKey && missing.length) {
    for (let i = 0; i < missing.length; i += TRANSITION_LIMITS.parallel) {
      await Promise.all(missing.slice(i, i + TRANSITION_LIMITS.parallel).map((entry) => evaluateEntry(env.DB, entry, apiKey, model)));
    }
    cached = await readScores(env.DB, entries.map((entry) => entry.key));
  }
  return entries.map((entry) => {
    const row = cached.get(entry.key);
    const ok = row?.status === 'ok' && typeof row.score === 'number' && row.score >= 0 && row.score <= 1
      && typeof row.confidence === 'number' && row.confidence >= 0 && row.confidence <= 1;
    return { songId: entry.id, signature: entry.signature,
      status: ok ? 'ok' : !apiKey ? 'unavailable' : row?.status === 'failed' ? 'failed' : 'pending',
      ...(ok ? { score: row.score, confidence: row.confidence } : {}) };
  });
}
