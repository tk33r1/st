import { SITE_RANK, SITE_SEARCH } from './personas.js';
import { fetchSearchSource, getSiteSnapshot, searchDeadline, searchFailure, sha256, snapshotHash } from './site-search.js';
import { toRankCandidate } from './site-rank.js';

// 入力から URL を作らない。scope と媒体のディレクトリの対応はここだけに持つ。
const SEARCH_SCOPES = Object.freeze({
  site: Object.freeze({}),
  nitori: Object.freeze({ media: 'nitoridaily' }),
  retail: Object.freeze({ media: 'retailtechdaily' }),
  tools: Object.freeze({ kind: 'tool', list: 'tools', filter: 'category' }),
  game: Object.freeze({ kind: 'game', list: 'game', filter: 'genre' }),
});
const dailySnapshots = new Map();
const scopeObject = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
};
const scopeHex = value => typeof value === 'string' && /^[a-f0-9]{1,32}$/i.test(value);
const scopeControl = /[\u0000-\u001f\u007f-\u009f]/;
const scopeCategory = value => typeof value === 'string' && !!value && Array.from(value).length <= 40 && !scopeControl.test(value);
const scopeTerms = value => Array.isArray(value) && value.length >= 3 && value.length <= 5
  && value.every(t => typeof t === 'string' && !!t.trim() && Array.from(t).length <= 60 && !scopeControl.test(t))
  && new Set(value).size === value.length;
const scopeYear = value => typeof value === 'string' && /^\d{4}$/.test(value) && Number(value) > 0;
const scopeMonth = value => typeof value === 'string' && /^\d{6}$/.test(value)
  && scopeYear(value.slice(0, 4)) && Number(value.slice(4)) >= 1 && Number(value.slice(4)) <= 12;

export function isSearchScope(name) {
  return typeof name === 'string' && Object.hasOwn(SEARCH_SCOPES, name);
}

export function isDailyScope(name) {
  return isSearchScope(name) && !!SEARCH_SCOPES[name].media;
}

export function searchScope(name) {
  if (!isSearchScope(name)) throw searchFailure('invalid_request');
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
  const { media, filter } = searchScope(scope);
  if (value === undefined) return {};
  if (!media && !filter) throw searchFailure('invalid_request');
  const keys=media?['category','region','month']:filter?[filter]:[];
  if (!scopeObject(value) || Object.keys(value).some(k => !keys.includes(k))) throw searchFailure('invalid_request');
  const filters = {};
  // 省略・空文字を除き、必ずこのキー順でキャッシュに渡す。
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) continue;
    const v = value[key];
    if (typeof v !== 'string') throw searchFailure('invalid_request');
    if (!v) continue;
    if ((['category','genre'].includes(key) && !scopeCategory(v))
      || (key === 'region' && !['JP', 'GLOBAL'].includes(v)) || (key === 'month' && !scopeMonth(v))) throw searchFailure('invalid_request');
    filters[key] = v;
  }
  return filters;
}

export function scopeGeneration(scope, value) {
  const { media } = searchScope(scope);
  if (value === undefined) return undefined;
  if (media ? !scopeHex(value) : typeof value!=='string' || !/^[a-f0-9]{64}$/.test(value)) throw searchFailure('invalid_request');
  return value;
}

function dailyDate(value) {
  if (typeof value !== 'string' || !/^\d{8}$/.test(value) || !scopeMonth(value.slice(0, 6))) return false;
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
  const raw = [], ids = new Set(), categories = new Set(), months = new Set();
  for (let i = 0; i < files.length; i++) {
    const [filename, text] = files[i], year = head.years[i], index = i === 0 ? head : dailyIndex(text);
    if ((i > 0 && (filename !== `search-index-${year}.json` || index.year !== year))
      || index.media !== media || index.generation !== head.generation
      || raw.length + index.records.length > SITE_RANK.daily_index_max_records) throw searchFailure('index_unavailable');
    for (const record of index.records) {
      if (!scopeObject(record) || !dailyDate(record.date) || record.date.slice(0, 4) !== year
        || typeof record.title !== 'string' || !record.title.trim() || typeof record.summary !== 'string'
        || !scopeCategory(record.category)
        || !['JP', 'GLOBAL'].includes(record.region) || !Array.isArray(record.tags)
        || record.tags.some(t => typeof t !== 'string' || !t)
        || ('search_terms' in record && !scopeTerms(record.search_terms))
        || ['takeaway', 'source', 'source_kind'].some(k => k in record && typeof record[k] !== 'string')
        || typeof record.url !== 'string') throw searchFailure('index_unavailable');
      // 完全一致で相対 URL を検査するため、遡り・外部 URL・エンコード・別媒体のリンクも通らない。
      const match = /^(\d{8})\/#art-([1-9]\d*)$/.exec(record.url);
      const article = match && Number(match[2]);
      if (!match || match[1] !== record.date || !Number.isSafeInteger(article)) throw searchFailure('index_unavailable');
      const id = `${media}:${record.date}:${article}`, url = `/job/${media}/${record.url}`;
      if (ids.has(id)) throw searchFailure('index_unavailable');
      ids.add(id); categories.add(record.category); months.add(record.date.slice(0, 6));
      raw.push({ id, kind: 'daily', date: record.date, article, url, title: record.title, summary: record.summary,
        category: record.category, region: record.region, tags: [...record.tags],
        ...('search_terms' in record ? { search_terms: [...record.search_terms] } : {}) });
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

async function fetchDailySnapshot(scope, signal, shared = false, lease = null) {
  const owner=new AbortController(),stop=()=>{if(!lease?.shared) owner.abort();};
  if(signal?.aborted) stop();else signal?.addEventListener('abort',stop,{once:true});
  try {return await searchDeadline(SITE_SEARCH.list_timeout_ms, async s => {
    const { media } = searchScope(scope), base = `https://tk.st/job/${media}/`, budget = { bytes: 0 };
    const text = async url => {
      if (!shared) return dailyText(url,s,budget);
      const value=await fetchSearchSource(url,{signal:s,refresh:true,maxBytes:SITE_RANK.daily_index_max_bytes});
      budget.bytes+=new TextEncoder().encode(value).byteLength;
      if(budget.bytes>SITE_RANK.daily_index_max_bytes) throw searchFailure('index_unavailable');
      return value;
    };
    const files = [['search-index.json', await text(base + 'search-index.json')]];
    const head = dailyHead(scope, files[0][1]);
    let next = 1;
    await Promise.all(Array.from({ length: Math.min(SITE_RANK.daily_index_parallel, Math.max(0, head.years.length - 1)) }, async () => {
      for (;;) {
        if (s.aborted) throw searchFailure('cancelled');
        const i = next++;
        if (i >= head.years.length) return;
        const filename = `search-index-${head.years[i]}.json`;
        files[i] = [filename, await text(base + filename)];
      }
    }));
    const snapshot = makeDailySnapshot(scope, files);
    await snapshotHash(snapshot);
    if (s.aborted) throw searchFailure('cancelled');
    return snapshot;
  }, owner.signal);} finally {signal?.removeEventListener('abort',stop);}
}

// 更新は要求の期限・切断に従う。全ファイルとハッシュがそろうまで共有状態を差し替えない。
// 画面と版が違っても、既知の絞り込みなら完全な旧版を使える。未知の絞り込みは更新を待つ。
export async function getDailySnapshot(scope, { filters = {}, generation, signal } = {}) {
  if (!searchScope(scope).media) throw searchFailure('invalid_request');
  filters = normalizeScopeFilters(scope, filters);
  generation = scopeGeneration(scope, generation);
  if (signal?.aborted) throw searchFailure('cancelled');
  if (!dailySnapshots.has(scope)) dailySnapshots.set(scope, { snapshot: null, fetchedAt: 0, retryAt: 0, refreshing: false });
  const state = dailySnapshots.get(scope), now = Date.now(), age = now - state.fetchedAt;
  const unknownFilter = state.snapshot && dailyUnknownFilter(state.snapshot, filters);
  const forced = state.snapshot && ((generation && generation !== state.snapshot.generation) || unknownFilter);
  const usable = state.snapshot && age <= SITE_SEARCH.list_max_age_ms;
  if (!forced && usable && age <= SITE_SEARCH.list_ttl_ms) return state.snapshot;
  if (state.refreshing || now < state.retryAt) {
    if (usable && !unknownFilter) return state.snapshot;
    if (forced) throw searchFailure('index_updating');
    throw searchFailure('index_unavailable');
  }
  const previousRetryAt = state.retryAt;
  state.refreshing = true;
  state.retryAt = now + SITE_SEARCH.list_retry_ms;
  let snapshot;
  try {
    state.lease={shared:false};state.pending=fetchDailySnapshot(scope, signal, false, state.lease);
    snapshot = await state.pending;
    if (signal?.aborted) throw searchFailure('cancelled');
    state.snapshot = snapshot; state.fetchedAt = Date.now();
  } catch (e) {
    if (e.searchCode === 'cancelled' || signal?.aborted) {
      // 強制更新の中断は制限を残し、偽の版で再取得を繰り返させない。
      if (!forced) state.retryAt = previousRetryAt;
      throw searchFailure('cancelled');
    }
    state.retryAt = Date.now() + SITE_SEARCH.list_retry_ms;
    if (forced) throw searchFailure('index_updating');
    if (state.snapshot && Date.now() - state.fetchedAt <= SITE_SEARCH.list_max_age_ms) return state.snapshot;
    throw searchFailure('index_unavailable');
  } finally { state.refreshing = false; state.pending = null; }
  if (dailyUnknownFilter(snapshot, filters)) throw searchFailure('invalid_request');
  return snapshot;
}

const listSnapshots=new Map(), rankSnapshotUpdates=new Map();
const scopeCompact=(value,limit)=>typeof value==='string'?Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').replace(/\s+/g,' ').trim()).slice(0,limit).join(''):'';
export function makeListSnapshot(scope,text,publication) {
  const spec=searchScope(scope);
  if(!spec.list || !publication?.rankReady) throw searchFailure('index_updating');
  let list;try {list=JSON.parse(text);} catch(_) {throw searchFailure('index_unavailable');}
  if(!Array.isArray(list) || list.length>10000 || new TextEncoder().encode(text).byteLength>2*1024*1024) throw searchFailure('index_unavailable');
  const byUrl=new Map(publication.raw.map(p=>[p.url,p])), ids=new Set(), urls=new Set(), raw=[];
  for(const row of list) {
    if(!row || !((typeof row.id==='string' && !!row.id) || Number.isSafeInteger(row.id)) || typeof row.title!=='string' || !row.title.trim()
      || typeof row.url!=='string' || !/^(?:https:\/\/tk\.st)?\/(?!\/)/.test(row.url) || /[\u0000- \u007f\\?#]/.test(row.url)) throw searchFailure('index_unavailable');
    let link,decoded;try {link=new URL(row.url,'https://tk.st');decoded=decodeURIComponent(link.pathname);} catch(_) {throw searchFailure('index_unavailable');}
    const url=row.url.replace(/^https:\/\/tk\.st/,'');
    if(link.origin!=='https://tk.st' || link.pathname!==url || !url.startsWith(`/${spec.list}/`)
      || /[\u0000- \u007f\\?#]/.test(decoded) || decoded.split('/').some(p=>p==='.' || p==='..')) throw searchFailure('index_unavailable');
    const id=spec.kind+':'+row.id;
    if(ids.has(id) || urls.has(url)) throw searchFailure('index_unavailable');ids.add(id);urls.add(url);
    const page=byUrl.get(url);
    if(!page) continue; // noindex・転送・別canonical・欠落は公開索引から除かれている。
    if(page.id!==id || page.kind!==spec.kind) throw searchFailure('index_updating');
    const own={kind:spec.kind,rank_title:scopeCompact(row.title,1000000),description:scopeCompact(row.shortDescription || row.description || '',320)};
    if(spec.kind==='tool') {
      if(!Array.isArray(row.tags) || row.tags.some(t=>typeof t!=='string')) throw searchFailure('index_unavailable');
      own.tags=row.tags.map(t=>scopeCompact(t,1000000)).filter(Boolean);
      const category=scopeCompact(row.category,1000000);own.category=category.slice(0,1).toUpperCase()+category.slice(1);
    } else own.genre=scopeCompact(row.genre,1000000);
    if(JSON.stringify(toRankCandidate(own))!==JSON.stringify(toRankCandidate(page))) throw searchFailure('index_updating');
    raw.push(page);
  }
  return {scope,raw,ja:raw,en:raw,rankReady:true,text,publicationText:publication.text};
}
export function filterRankItems(snapshot,scope,filters={}) {
  if(isDailyScope(scope)) return filterDailyItems(snapshot,filters);
  const key=searchScope(scope).filter;
  return key && filters[key]?snapshot.raw.filter(p=>p[key]===filters[key]):snapshot.raw;
}

// 新入口専用の世代guard。旧入口の世代不一致でも旧日刊を返す契約は変えない。
// 更新Promiseはscope単位、取得PromiseはfetchSearchSourceでソース単位に共有する。
export async function getRankSnapshot(scope,{ctx,generation,signal}={}) {
  if(signal?.aborted) throw searchFailure('cancelled');
  const spec=searchScope(scope);
  const current=()=>scope==='site'?null:isDailyScope(scope)?dailySnapshots.get(scope)?.snapshot:listSnapshots.get(scope)?.snapshot;
  let snapshot;
  try {snapshot=scope==='site'?await getSiteSnapshot(ctx,signal):current();} catch(_) {snapshot=null;}
  const version=async value=>value?(isDailyScope(scope)?value.generation:await snapshotHash(value)):null;
  const matches=async value=>!!value && value.rankReady!==false && (!generation || generation===await version(value));
  const fresh=scope==='site' || Date.now()-(isDailyScope(scope)?dailySnapshots.get(scope)?.fetchedAt:listSnapshots.get(scope)?.at || 0)<=SITE_SEARCH.list_ttl_ms;
  if(fresh && !rankSnapshotUpdates.get(scope)?.blocked && await matches(snapshot)) return {snapshot,generation:await version(snapshot),updating:false};
  if(!rankSnapshotUpdates.has(scope)) rankSnapshotUpdates.set(scope,{pending:null,retryAt:0,blocked:false});
  const update=rankSnapshotUpdates.get(scope);
  if(!update.pending && Date.now()>=update.retryAt) {
    update.retryAt=Date.now()+SITE_SEARCH.list_retry_ms;
    update.pending=(async()=>{
      if(scope==='site') return getSiteSnapshot(ctx,undefined,{refresh:true});
      if(spec.media) {
        const state=dailySnapshots.get(scope);
        let next;
        if(state?.refreshing && state.pending) {if(state.lease) state.lease.shared=true;next=await state.pending;}
        else next=await fetchDailySnapshot(scope,undefined,true);
        if(!dailySnapshots.has(scope)) dailySnapshots.set(scope,{snapshot:null,fetchedAt:0,retryAt:0,refreshing:false});
        const target=dailySnapshots.get(scope);target.snapshot=next;target.fetchedAt=Date.now();return next;
      }
      const [text,publication]=await Promise.all([
        fetchSearchSource(`https://tk.st/data/${spec.list}.json`,{refresh:true,maxBytes:2*1024*1024}),
        getSiteSnapshot(ctx,undefined,{refresh:true})]);
      const next=makeListSnapshot(scope,text,publication);await snapshotHash(next);
      listSnapshots.set(scope,{snapshot:next,at:Date.now()});return next;
    })().then(next=>{update.blocked=false;return next;},error=>{update.blocked=true;throw error;}).finally(()=>{update.pending=null;});
    update.pending.catch(()=>{});
  }
  if(update.pending) {
    const pending=update.pending;
    try {snapshot=await searchDeadline(SITE_SEARCH.list_timeout_ms,()=>pending,signal);} catch(_) {}
  }
  if(signal?.aborted) throw searchFailure('cancelled');
  return {snapshot:snapshot || current() || null,generation:await version(snapshot || current()),updating:update.blocked || !(await matches(snapshot || current()))};
}
