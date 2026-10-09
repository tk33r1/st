import { SITE_RANK, SITE_SEARCH } from './personas.js';
import { searchDeadline, searchFailure, sha256 } from './site-search.js';

// 入力から URL を作らない。scope と媒体のディレクトリの対応はここだけに持つ。
const SEARCH_SCOPES = Object.freeze({
  site: Object.freeze({}),
  nitori: Object.freeze({ media: 'nitoridaily' }),
  retail: Object.freeze({ media: 'retailtechdaily' }),
});
const dailySnapshots = new Map();
const scopeObject = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
};
const scopeHex = value => typeof value === 'string' && value.length >= 1 && value.length <= 32 && !/[^a-f0-9]/i.test(value);
const scopeYear = value => typeof value === 'string' && value.length === 4 && /^\d{4}$/.test(value) && Number(value) > 0;
const scopeMonth = value => typeof value === 'string' && value.length === 6 && /^\d{6}$/.test(value)
  && scopeYear(value.slice(0, 4)) && Number(value.slice(4)) >= 1 && Number(value.slice(4)) <= 12;

export function searchScope(name) {
  if (typeof name !== 'string' || !Object.hasOwn(SEARCH_SCOPES, name)) throw searchFailure('invalid_request');
  return SEARCH_SCOPES[name];
}

export function rankScopeConfig(scope) {
  searchScope(scope);
  return scope === 'site' ? SITE_RANK : SITE_RANK.scopes[scope];
}

export function rankScopeEnabled(env, scope) {
  searchScope(scope);
  return env.SITE_RANK_ENABLED === 'true'
    && (env.SITE_RANK_SCOPES === undefined ? ['site'] : String(env.SITE_RANK_SCOPES).split(',').map(s => s.trim())).includes(scope);
}

export function normalizeScopeFilters(scope, value) {
  const { media } = searchScope(scope);
  if (value === undefined) return {};
  if (!media || !scopeObject(value) || Object.keys(value).some(k => !['category', 'region', 'month'].includes(k))) throw searchFailure('invalid_request');
  const filters = {};
  // 省略・空文字を除き、必ずこのキー順でキャッシュに渡す。
  for (const key of ['category', 'region', 'month']) {
    if (!Object.hasOwn(value, key)) continue;
    const v = value[key];
    if (typeof v !== 'string') throw searchFailure('invalid_request');
    if (!v) continue;
    if ((key === 'category' && (Array.from(v).length > 40 || /[\u0000-\u001f\u007f-\u009f]/.test(v)))
      || (key === 'region' && !['JP', 'GLOBAL'].includes(v)) || (key === 'month' && !scopeMonth(v))) throw searchFailure('invalid_request');
    filters[key] = v;
  }
  return filters;
}

export function scopeGeneration(scope, value) {
  const { media } = searchScope(scope);
  if (value === undefined) return undefined;
  if (!media || !scopeHex(value)) throw searchFailure('invalid_request');
  return value;
}

function dailyDate(value) {
  if (typeof value !== 'string' || value.length !== 8 || !/^\d{8}$/.test(value) || !scopeMonth(value.slice(0, 6))) return false;
  const year = Number(value.slice(0, 4)), month = Number(value.slice(4, 6)), day = Number(value.slice(6));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day >= 1 && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

// 結果を返す直前にもID・日付・記事番号・媒体・URLの一致を確かめる。上流の返したリンクは使わない。
export function dailyResultUrl(scope, item) {
  const { media } = searchScope(scope);
  if (!media || item.kind !== 'daily' || !dailyDate(item.date) || !Number.isSafeInteger(item.article) || item.article < 1
    || item.id !== `${media}:${item.date}:${item.article}`) return null;
  const url = `/job/${media}/${item.date}/#art-${item.article}`;
  return item.url === url ? url : null;
}

function dailyIndex(text) {
  let index;
  try { index = JSON.parse(text); } catch (_) { throw searchFailure('index_unavailable'); }
  if (!scopeObject(index) || !Array.isArray(index.records) || !scopeHex(index.generation)) throw searchFailure('index_unavailable');
  return index;
}

function dailyHead(scope, text) {
  const { media } = searchScope(scope), head = dailyIndex(text);
  if (!media || head.media !== media || !Array.isArray(head.years) || head.years.length > SITE_RANK.daily_index_max_years
    || head.years.some((y, i) => !scopeYear(y) || (i > 0 && head.years[i - 1] <= y))
    || (!head.years.length && head.records.length)) throw searchFailure('index_unavailable');
  return head;
}

// 保存した fixture と実際の取得で同じ検査を使う。files は [固定のファイル名, 取得本文] の組を head→年の降順で並べる。
// generation は照合するだけ。index_hash の材料は、正規化し直さず取得した本文そのもの。
export function makeDailySnapshot(scope, files) {
  const { media } = searchScope(scope);
  if (!Array.isArray(files) || !files.length || files.some(f => !Array.isArray(f) || f.length !== 2 || typeof f[1] !== 'string')
    || files[0][0] !== 'search-index.json') throw searchFailure('index_unavailable');
  if (files.reduce((sum, f) => sum + new TextEncoder().encode(f[1]).byteLength, 0) > SITE_RANK.daily_index_max_bytes) throw searchFailure('index_unavailable');
  const head = dailyHead(scope, files[0][1]);
  if (files.length !== Math.max(1, head.years.length)) throw searchFailure('index_unavailable');
  const raw = [], ids = new Set(), urls = new Set(), categories = new Set(), months = new Set();
  for (let i = 0; i < files.length; i++) {
    const [filename, text] = files[i], year = head.years[i], index = i === 0 ? head : dailyIndex(text);
    if ((i > 0 && (filename !== `search-index-${year}.json` || index.year !== year))
      || index.media !== media || index.generation !== head.generation
      || raw.length + index.records.length > SITE_RANK.daily_index_max_records) throw searchFailure('index_unavailable');
    for (const record of index.records) {
      if (!scopeObject(record) || !dailyDate(record.date) || record.date.slice(0, 4) !== year
        || typeof record.title !== 'string' || !record.title.trim() || typeof record.summary !== 'string'
        || typeof record.category !== 'string' || !record.category || Array.from(record.category).length > 40
        || /[\u0000-\u001f\u007f-\u009f]/.test(record.category)
        || !['JP', 'GLOBAL'].includes(record.region) || !Array.isArray(record.tags)
        || record.tags.some(t => typeof t !== 'string' || !t)
        || ['takeaway', 'source', 'source_kind'].some(k => k in record && typeof record[k] !== 'string')
        || typeof record.url !== 'string') throw searchFailure('index_unavailable');
      // 完全一致で相対 URL を検査するため、遡り・外部 URL・エンコード・別媒体のリンクも通らない。
      const match = /^(\d{8})\/#art-([1-9]\d*)$/.exec(record.url);
      const article = match && Number(match[2]);
      if (!match || match[0] !== record.url || match[1] !== record.date || !Number.isSafeInteger(article)) throw searchFailure('index_unavailable');
      const id = `${media}:${record.date}:${article}`, url = `/job/${media}/${record.url}`;
      if (ids.has(id) || urls.has(url)) throw searchFailure('index_unavailable');
      ids.add(id); urls.add(url); categories.add(record.category); months.add(record.date.slice(0, 6));
      raw.push({ id, kind: 'daily', date: record.date, article, url, title: record.title, summary: record.summary,
        category: record.category, region: record.region, tags: [...record.tags] });
    }
  }
  return { scope, media, generation: head.generation, raw, categories, months, text: JSON.stringify(files) };
}

const dailyUnknownFilter = (snapshot, filters) => (filters.category && !snapshot.categories.has(filters.category))
  || (filters.month && !snapshot.months.has(filters.month));

export function filterDailyItems(snapshot, filters) {
  return snapshot.raw.filter(p => (!filters.category || p.category === filters.category)
    && (!filters.region || p.region === filters.region) && (!filters.month || p.date.startsWith(filters.month)));
}

async function dailyText(url, signal, budget) {
  const response = await fetch(url, { signal, headers: { 'Cache-Control': 'no-cache' } });
  if (!response.ok || !response.body) throw searchFailure('index_unavailable');
  const reader = response.body.getReader(), chunks = [];
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw searchFailure('cancelled');
      const { value, done } = await reader.read();
      if (signal.aborted) throw searchFailure('cancelled');
      if (done) break;
      budget.bytes += value.byteLength;
      if (budget.bytes > SITE_RANK.daily_index_max_bytes) throw searchFailure('index_unavailable');
      chunks.push(value);
    }
    const decoder = new TextDecoder('utf-8', { fatal: true });
    return chunks.map(chunk => decoder.decode(chunk, { stream: true })).join('') + decoder.decode();
  } finally {
    cancel(); signal.removeEventListener('abort', cancel); reader.releaseLock();
  }
}

async function fetchDailySnapshot(scope, signal) {
  return searchDeadline(SITE_SEARCH.list_timeout_ms, async s => {
    const { media } = searchScope(scope), base = `https://tk.st/job/${media}/`, budget = { bytes: 0 };
    const files = [['search-index.json', await dailyText(base + 'search-index.json', s, budget)]];
    const head = dailyHead(scope, files[0][1]);
    let next = 1;
    await Promise.all(Array.from({ length: Math.min(SITE_RANK.daily_index_parallel, Math.max(0, head.years.length - 1)) }, async () => {
      for (;;) {
        if (s.aborted) throw searchFailure('cancelled');
        const i = next++;
        if (i >= head.years.length) return;
        const filename = `search-index-${head.years[i]}.json`;
        files[i] = [filename, await dailyText(base + filename, s, budget)];
      }
    }));
    const snapshot = makeDailySnapshot(scope, files);
    snapshot.indexHash = await sha256(snapshot.text);
    if (s.aborted) throw searchFailure('cancelled');
    return snapshot;
  }, signal);
}

// 更新は要求の期限・切断に従う。全ファイルとハッシュがそろうまで共有状態を差し替えない。
// 更新中の別の要求は、完全な旧版が使える場合だけそれを受け取る。版の更新が必要なら index_updating。
export async function getDailySnapshot(scope, { filters = {}, generation, signal } = {}) {
  if (!searchScope(scope).media) throw searchFailure('invalid_request');
  filters = normalizeScopeFilters(scope, filters);
  generation = scopeGeneration(scope, generation);
  if (signal?.aborted) throw searchFailure('cancelled');
  if (!dailySnapshots.has(scope)) dailySnapshots.set(scope, { snapshot: null, fetchedAt: 0, retryAt: 0, refreshing: false });
  const state = dailySnapshots.get(scope), now = Date.now(), age = now - state.fetchedAt;
  const forced = state.snapshot && ((generation && generation !== state.snapshot.generation) || dailyUnknownFilter(state.snapshot, filters));
  const usable = state.snapshot && age <= SITE_SEARCH.list_max_age_ms;
  if (!forced && usable && age <= SITE_SEARCH.list_ttl_ms) return state.snapshot;
  if (state.refreshing || now < state.retryAt) {
    if (forced) throw searchFailure('index_updating');
    if (usable) return state.snapshot;
    throw searchFailure('index_unavailable');
  }
  state.refreshing = true;
  state.retryAt = now + SITE_SEARCH.list_retry_ms;
  let snapshot;
  try {
    snapshot = await fetchDailySnapshot(scope, signal);
    if (signal?.aborted) throw searchFailure('cancelled');
    state.snapshot = snapshot; state.fetchedAt = Date.now();
  } catch (e) {
    if (e.searchCode === 'cancelled' || signal?.aborted) throw searchFailure('cancelled');
    state.retryAt = Date.now() + SITE_SEARCH.list_retry_ms;
    if (forced) throw searchFailure('index_updating');
    if (state.snapshot && Date.now() - state.fetchedAt <= SITE_SEARCH.list_max_age_ms) return state.snapshot;
    throw searchFailure('index_unavailable');
  } finally { state.refreshing = false; }
  if (dailyUnknownFilter(snapshot, filters)) throw searchFailure('invalid_request');
  return snapshot;
}
