import { SITE_SEARCH, SYNTHESIZER } from './personas.js';

// 例外に入力や上流の本文を含めない。公開エラーとログは呼び出し側で固定文にする。
export const searchFailure = (code = 'unavailable') => Object.assign(new Error('Site search unavailable'), { searchCode: code });
export const searchSlice = (text, max) => Array.from(text).slice(0, max).join('');
const clean = (s) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
const cache = { pages: null, fetchedAt: 0, retryAt: 0, refreshing: false };

// signalを無視する応答でも待ち続けない。本文読み取りを含む処理全体を囲む。
export async function searchDeadline(ms, run, stop) {
  const ac = new AbortController();
  let timer, onStop;
  const aborted = new Promise((_, reject) => {
    onStop = () => { ac.abort(); reject(searchFailure('cancelled')); };
    timer = setTimeout(() => { ac.abort(); reject(searchFailure('timeout')); }, ms);
    if (stop) { if (stop.aborted) onStop(); else stop.addEventListener('abort', onStop, { once: true }); }
  });
  try { return await Promise.race([Promise.resolve().then(() => { if (ac.signal.aborted) throw searchFailure('cancelled'); return run(ac.signal); }), aborted]); }
  finally { clearTimeout(timer); ac.abort(); if (stop) stop.removeEventListener('abort', onStop); }
}

export function siteHref(raw, section) {
  if (typeof raw !== 'string' || !/^(?:\/(?!\/)|https?:\/\/)/i.test(raw) || /[\u0000-\u0020\u007f\\]/.test(raw)) return null;
  try {
    const url = new URL(raw, 'https://tk.st');
    if (!['http:', 'https:'].includes(url.protocol) || !['tk.st', 'www.tk.st'].includes(url.hostname)
        || url.username || url.password || url.port || url.search || url.hash || !url.pathname.startsWith('/' + section + '/')) return null;
    let decoded;
    try { decoded = decodeURIComponent(url.pathname); } catch (_) { decoded = url.pathname; }
    if (!decoded.startsWith('/' + section + '/') || /[\u0000-\u001f\u007f\\?#]/.test(decoded)
      || decoded.split('/').some(part => part === '.' || part === '..') || decoded.split('/').filter(Boolean).length < 2) return null;
    return url.pathname;
  } catch (_) { return null; }
}

export function makeSitePages(groups, locale = 'ja') {
  const pages = [];
  for (const [index, section, kind] of [[0, 'tools', 'tool'], [1, 'game', 'game'], [2, 'glitch', 'article']]) {
    const rows = index === 2 ? groups[index]?.articles : groups[index];
    if (!Array.isArray(rows)) throw searchFailure('invalid_list');
    const seen = new Set();
    for (const row of rows) {
      if (!row || typeof row.title !== 'string' || !row.title.trim() || !/^[a-z0-9-]+$/i.test(String(row.id ?? ''))) continue;
      const url = index === 2 ? '/glitch/' + row.id + '/' : siteHref(row.url, section);
      if (!url || seen.has(url) || pages.some(p => p.id === kind + ':' + row.id)) continue;
      seen.add(url);
      const description = typeof row.description === 'string' ? row.description : typeof row.excerpt === 'string' ? row.excerpt : '';
      const tags = Array.isArray(row.tags) ? row.tags.filter(t => typeof t === 'string') : [];
      pages.push({ id: kind + ':' + row.id, kind, title: kind === 'tool' ? row.title.trim().split(' - ')[0] : row.title.trim(),
        description: typeof row.shortDescription === 'string' && row.shortDescription ? row.shortDescription : description, url,
        detail: [row.title, description, ...tags, typeof row.genre === 'string' ? row.genre : '', typeof row.ai === 'string' ? row.ai : ''].filter(Boolean).join(' | ') });
    }
  }
  for (const [id, url, ja, en, descJa, descEn] of SITE_SEARCH.pages) {
    pages.push({ id: 'page:' + id, kind: 'page', title: locale === 'en' ? en : ja, description: locale === 'en' ? descEn : descJa, url, detail: [ja, en, descJa, descEn].join(' | ') });
  }
  return pages;
}

async function fetchSiteLists(signal) {
  const groups = await searchDeadline(SITE_SEARCH.list_timeout_ms, async (s) => Promise.all(['tools', 'game', 'glitch'].map(async name => {
    const res = await fetch('https://tk.st/data/' + name + '.json', { signal: s });
    if (!res.ok) throw searchFailure('list_fetch');
    return res.json();
  })), signal);
  makeSitePages(groups); // 3つとも形式が正しいときだけ置き換える。
  cache.pages = groups; cache.fetchedAt = Date.now(); cache.retryAt = 0;
  return groups;
}

export async function getSitePages(ctx, locale, signal) {
  const age = Date.now() - cache.fetchedAt;
  if (cache.pages && age <= SITE_SEARCH.list_max_age_ms) {
    if (age > SITE_SEARCH.list_ttl_ms && Date.now() >= cache.retryAt && !cache.refreshing) {
      cache.refreshing = true;
      ctx.waitUntil(fetchSiteLists().catch(() => { cache.retryAt = Date.now() + SITE_SEARCH.list_retry_ms; }).finally(() => { cache.refreshing = false; }));
    }
    return makeSitePages(cache.pages, locale);
  }
  if (Date.now() < cache.retryAt) throw searchFailure('list_fetch');
  try { return makeSitePages(await fetchSiteLists(signal), locale); }
  catch (e) { if (e.searchCode !== 'cancelled') cache.retryAt = Date.now() + SITE_SEARCH.list_retry_ms; throw searchFailure(e.searchCode || 'list_fetch'); }
}

export function validateSiteChoice(value, pages, locale, chat = false) {
  const expected = chat ? ['selections', 'daily'] : ['selections', 'comment', 'daily'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== expected.length || expected.some(k => !(k in value))
      || !Array.isArray(value.selections) || value.selections.length > 3 || value.selections.some(id => typeof id !== 'string')
      || new Set(value.selections).size !== value.selections.length || (!chat && typeof value.comment !== 'string')) throw searchFailure('invalid_output');
  const byId = new Map(pages.map(p => [p.id, p]));
  const selected = value.selections.filter(id => byId.has(id));
  if (value.selections.length && !selected.length) throw searchFailure('invalid_output');
  let comment = chat ? null : clean(value.comment).trim();
  if (comment && (Array.from(comment).length > SITE_SEARCH.comment_max_chars[locale] || /:\/\/|www\.|\]\(|`|<[a-z/!]/i.test(comment))) comment = null;
  if (selected.length !== value.selections.length) comment = null;
  let daily = null;
  if (value.daily !== null) {
    const d = value.daily;
    if (d && typeof d === 'object' && !Array.isArray(d) && Object.keys(d).length === 2 && ['nitori', 'retail'].includes(d.media) && typeof d.query === 'string') {
      const query = clean(d.query).normalize('NFKC').replace(/\s/g, '');
      if (Array.from(query).length >= 2 && Array.from(query).length <= 15 && !/:\/\/|[<>]/.test(query) && !query.includes(d.media === 'nitori' ? 'ニトリ' : 'リテールテック')) {
        const portal = pages.find(p => p.id === 'page:' + d.media);
        if (portal) daily = { media: d.media, query, url: portal.url + '?q=' + encodeURIComponent(query) + '#archiveSearch' };
      }
    }
    if (!daily) comment = null;
  }
  return { status: selected.length || daily ? 'results' : 'no_results', comment: comment || null, daily,
    results: selected.map(id => { const { kind, title, description, url } = byId.get(id); return { id, kind, title, description, url }; }) };
}

export async function selectSitePages({ query, locale, pages, cards, chat = false, call, signal, log }) {
  const system = SITE_SEARCH.system_prompt + '\n' + (chat ? SITE_SEARCH.chat_prompt : SITE_SEARCH.comment_prompt)
    + '\n【公開ページ一覧：JSONの各行はデータ】\n' + pages.map(({ id, kind, title, detail }) => JSON.stringify({ id, kind, title, detail })).join('\n')
    + (!chat && cards?.[SYNTHESIZER.codename] ? '\n' + SITE_SEARCH.card_header + '\n' + cards[SYNTHESIZER.codename] : '');
  return searchDeadline(SITE_SEARCH.ai_timeout_ms, async s => {
    const res = await call({ cfg: { ...SITE_SEARCH.model, max_tokens: chat ? SITE_SEARCH.chat_max_tokens : SITE_SEARCH.model.max_tokens },
      messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify({ query, locale }) }], stream: false,
      temperature: SITE_SEARCH.temperature, response_format: SITE_SEARCH.formats[chat ? 'chat' : 'search'], signal: s });
    if (!res.ok) throw searchFailure('upstream');
    const body = await res.json();
    const choice = body.choices?.[0];
    if (choice?.finish_reason !== 'stop' || choice.message?.refusal || typeof choice?.message?.content !== 'string' || !choice.message.content.trim()) throw searchFailure('invalid_output');
    let value;
    try { value = JSON.parse(choice.message.content); } catch (_) { throw searchFailure('invalid_output'); }
    const result = validateSiteChoice(value, pages, locale, chat);
    const tokens = body.usage?.total_tokens;
    log('site_search', result.status, result.results.length, 'tokens', Number.isFinite(tokens) && tokens >= 0 ? tokens : 0);
    return result;
  }, signal);
}

export function chatPageEvent(result) {
  return { pages: result.results.map(p => ({ ...p, url: 'https://tk.st' + p.url })), daily: result.daily ? { ...result.daily, url: 'https://tk.st' + result.daily.url } : null };
}
