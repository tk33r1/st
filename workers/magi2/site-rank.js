// 404 のサイト内検索の②：索引の各ページに Jev（TypeSafe AI）で「この検索の目的を果たせる確率」を付け、閾値以上を並べる。
// 設計は assets/site-search-design.md 3章。設定の正本は personas.js の SITE_RANK。
// いまの scope は site だけ（日刊・tools・game は Phase 3）。
// test-magi2.mjs は magi2 のファイルを1つにつないで動かすので、トップレベルの名前には rank を付けて重ならないようにする。
import { SITE_RANK } from './personas.js';
import { RANK_FIELDS, dailyIssue, isBillingFailure, scoreItems, searchDeadline, searchFailure, searchSlice, sha256, snapshotHash } from './site-search.js';

const rankLength = s => Array.from(s).length;
const rankValues = c => Object.values(c).flatMap(v => Array.isArray(v) ? v : [v]);
const rankTotal = c => rankValues(c).reduce((n, v) => n + rankLength(v), 0);

// Jev に渡す候補1件（設計書 3.7）。ID・URL・detail は渡さない。長さは値の文字列のコードポイントの合計で数え、
// 説明は300文字まで、全体は400文字まで。超えたら英語の説明 → 日本語の説明の順に末尾から削る。
// それでも超える行は元の JSON を直す必要がある（生成側が先に止める）ので、失敗にする（黙って候補を落とさない）。
export function toRankCandidate(item) {
  const max = SITE_RANK.description_max_chars;
  let c;
  if (item.kind === 'page') {
    c = { kind: 'page', title: item.title };
    if (item.title_en) c.title_en = item.title_en;
    c.description = searchSlice(item.description || '', max);
    if (item.description_en) c.description_en = searchSlice(item.description_en, max);
  } else if (item.kind === 'tool') {
    c = { kind: 'tool', title: item.rank_title, description: searchSlice(item.description || '', max), tags: [...item.tags], category: item.category };
  } else if (item.kind === 'game') {
    c = { kind: 'game', title: item.rank_title, genre: item.genre, description: searchSlice(item.description || '', max) };
  } else if (item.kind === 'article') {
    c = { kind: 'article', title: item.rank_title, description: searchSlice(item.description || '', max), tags: [...item.tags] };
  } else throw searchFailure('index_unavailable');
  for (const key of ['description_en', 'description']) {
    const over = rankTotal(c) - SITE_RANK.candidate_max_chars;
    if (over > 0 && c[key]) c[key] = searchSlice(c[key], Math.max(0, rankLength(c[key]) - over));
  }
  if (rankTotal(c) > SITE_RANK.candidate_max_chars) throw searchFailure('index_unavailable');
  return c;
}

// ②の対象：日刊の号を除いた行（索引の順のまま）
export const rankTargets = snapshot => snapshot.raw.filter(p => !dailyIssue(p) && (p.kind === 'page' || RANK_FIELDS[p.kind]));

// 評価の照合用：検索語・言語・点数に関係しない、全対象の変換結果のハッシュ。スナップショットごとに1回だけ作る
const rankCandidateHashes = new WeakMap();
export function rankCandidateHash(snapshot) {
  if (!rankCandidateHashes.has(snapshot)) {
    let text = null;
    try { text = JSON.stringify(rankTargets(snapshot).slice().sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(p => [p.id, toRankCandidate(p)])); } catch (_) {}
    rankCandidateHashes.set(snapshot, text === null ? Promise.resolve(null) : sha256(text));
  }
  return rankCandidateHashes.get(snapshot);
}

// 同じ確率のときの並び（設計書 3.6）。索引の detail は使わない（ページ内の見出しで点が付かないように）
const rankScoreFields = p => ({
  title: [p.rank_title || p.title, p.title_en || ''].join(' '),
  detail: [p.description, p.description_en || '', ...(p.tags || []), p.category || '', p.genre || ''].join(' '),
});

const rankId = i => 'c' + String(i + 1).padStart(2, '0');
export function rankPayload(query, locale, candidates) {
  const q = SITE_RANK.questions[SITE_RANK.question_language];
  const ids = candidates.map((_, i) => rankId(i));
  return {
    model: SITE_RANK.model.model,
    state: { query, locale, candidates: Object.fromEntries(candidates.map((c, i) => [ids[i], c])) },
    questions: Object.fromEntries(ids.map(id => [id, { type: 'noul', instructions: q.instructions(id), criteria: q.criteria }])),
  };
}

// 答え1件が有効か（設計書 3.8）。送った ID の答えだけを見る
export function rankProbability(answer) {
  return answer && typeof answer === 'object' && answer.type === 'noul' && typeof answer.noul === 'number'
    && Number.isFinite(answer.noul) && answer.noul >= 0 && answer.noul <= 1 ? answer.noul : null;
}

// 本文を上限のバイト数まで読む（上限を超えた分は、チャンクの途中でも切ってから文字にする）。
// 中止されたら読み取り中の reader を止める（res.text() を期限で囲むだけでは止まらない）
async function rankReadLimited(res, maxBytes, signal) {
  if (!res.body) return '';
  const reader = res.body.getReader(), dec = new TextDecoder();
  const onAbort = () => { reader.cancel().catch(() => {}); };
  if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
  let text = '', size = 0;
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.byteLength > maxBytes - size ? value.subarray(0, maxBytes - size) : value;
      size += chunk.byteLength;
      text += dec.decode(chunk, { stream: true });
    }
    await reader.cancel().catch(() => {});
    return text + dec.decode();
  } finally { signal.removeEventListener('abort', onAbort); reader.releaseLock(); }
}

// Jev を呼ぶ。呼び出しから本文の読み取りまでを SITE_RANK.jev_timeout_ms で打ち切る。
// 401・402・403 と、本文が残高・枠の不足を示す 429 は onBilling(status) で知らせる（本文はログ・通知に渡さない）
export async function callRank(env, payload, signal, onBilling) {
  return searchDeadline(SITE_RANK.jev_timeout_ms, async s => {
    const res = await fetch(SITE_RANK.endpoint, {
      method: 'POST', signal: s,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env[SITE_RANK.key] },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      let billing = [401, 402, 403].includes(res.status);
      if (res.status === 429) billing = isBillingFailure(429, await rankReadLimited(res, SITE_RANK.error_body_max_bytes, s).catch(() => ''));
      else await res.body?.cancel().catch(() => {});
      if (billing) onBilling(res.status);
      throw searchFailure('unavailable');
    }
    let body;
    try { body = await res.json(); } catch (_) { throw searchFailure('unavailable'); }
    if (!body || typeof body.answers !== 'object' || body.answers === null || Array.isArray(body.answers)) throw searchFailure('unavailable');
    return body.answers;
  }, signal);
}

// 返すリンクを返す直前にもう一度確かめる（設計書 3.9）
export function rankSiteUrl(url) {
  if (typeof url !== 'string' || !/^\/(?!\/)/.test(url) || /[\\\u0000- \u007f]/.test(url)) return null;
  try {
    const u = new URL(url, 'https://tk.st');
    return u.origin === 'https://tk.st' && !u.search && !u.hash ? u.pathname : null;
  } catch (_) { return null; }
}

// 結果のキャッシュ（設計書 3.10）。isolate のメモリだけ。挿入順の LRU、期限切れは引くたびに消す。
// キーは検索語を含む条件の SHA-256 で、検索語そのものは持たない。値は応答の本体（検索語を含まない）
const rankCache = new Map();
async function rankCacheKey(scope, locale, query, filters, snapshot) {
  return sha256(JSON.stringify([SITE_RANK.revision, scope, locale, query, filters || null, await snapshotHash(snapshot)]));
}
function rankCacheGet(key) {
  const now = Date.now();
  for (const [k, v] of rankCache) if (v.expires <= now) rankCache.delete(k);
  const hit = rankCache.get(key);
  if (!hit) return null;
  rankCache.delete(key); rankCache.set(key, hit);
  return hit.value;
}
function rankCacheSet(key, value) {
  rankCache.delete(key);
  rankCache.set(key, { value, expires: Date.now() + SITE_RANK.cache_ttl_ms });
  while (rankCache.size > SITE_RANK.cache_max_entries) rankCache.delete(rankCache.keys().next().value);
}

// ②の本体（設計書 3.3 の6〜10）。回数は呼び出し元が先に数えている（キャッシュで上限を避けられないように）。
// 返すのは { status, complete, reason, searched, results } と、ログ用の値（above・jevMs・cached）。
// progress（省略できる）には Jev に送る直前に候補の数を書く（要求全体の期限で途中で終わっても searched.candidates を返せるように）
export async function rankSearch({ env, snapshot, query, locale, signal, onBilling, progress = {} }) {
  const targets = rankTargets(snapshot);
  const total = targets.length;
  const failed = (reason, candidates = 0, judged = 0) => ({ status: 'failed', complete: false, reason,
    searched: { total, candidates, judged }, results: [], above: 0, jevMs: null, cached: false });
  if (!total) return { status: 'no_results', complete: true, reason: null, searched: { total: 0, candidates: 0, judged: 0 }, results: [], above: 0, jevMs: null, cached: false };
  const key = await rankCacheKey('site', locale, query, null, snapshot);
  const hit = rankCacheGet(key);
  if (hit) return { ...hit, jevMs: null, cached: true };
  let candidates;
  try { candidates = targets.map(toRankCandidate); } catch (_) { return failed('index_unavailable'); }
  const scores = scoreItems(targets, query, rankScoreFields);
  progress.candidates = candidates.length;
  const started = Date.now();
  let answers;
  try { answers = await callRank(env, rankPayload(query, locale, candidates), signal, onBilling); }
  catch (e) { return { ...failed(e.searchCode === 'timeout' ? 'timeout' : 'unavailable', candidates.length), jevMs: Date.now() - started }; }
  const jevMs = Date.now() - started;
  const probs = targets.map((_, i) => rankProbability(answers[rankId(i)]));
  const judged = probs.filter(p => p !== null).length;
  const above = targets.map((p, i) => ({ p, prob: probs[i], score: scores[i].score, order: i }))
    .filter(r => r.prob !== null && r.prob >= SITE_RANK.threshold)
    .sort((a, b) => b.prob - a.prob || b.score - a.score || Number(b.p.hub) - Number(a.p.hub) || a.order - b.order);
  let complete = judged === targets.length;
  if (!above.length) {
    if (!complete) return { ...failed('incomplete', candidates.length, judged), jevMs };
    const none = { status: 'no_results', complete: true, reason: null, searched: { total, candidates: candidates.length, judged }, results: [], above: 0 };
    rankCacheSet(key, none);
    return { ...none, jevMs, cached: false };
  }
  // 表示の題名・説明は③と同じく画面の言語に合わせる（英語の画面では英語の名前があればそれ）
  const shown = new Map(snapshot[locale === 'en' ? 'en' : 'ja'].map(p => [p.id, p]));
  const results = [];
  for (const { p } of above) {
    const url = rankSiteUrl(p.url), view = shown.get(p.id);
    if (!url || !view) { complete = false; continue; } // 閾値を超えた行を隠したことになるので、完全とは言わない
    if (results.length < SITE_RANK.max_results) results.push({ kind: p.kind, title: view.title, description: view.description, url });
  }
  if (!results.length) return { ...failed('unavailable', candidates.length, judged), jevMs };
  const value = { status: 'results', complete, reason: null, searched: { total, candidates: candidates.length, judged }, results, above: above.length };
  if (complete) rankCacheSet(key, value);
  return { ...value, jevMs, cached: false };
}
