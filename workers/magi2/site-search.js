import { SITE_GUIDE, SITE_SEARCH } from './personas.js';

// 例外に入力や上流の本文を含めない。公開エラーとログは呼び出し側で固定文にする。
export const searchFailure = (code = 'unavailable') => Object.assign(new Error('Site search unavailable'), { searchCode: code });
export const searchSlice = (text, max) => Array.from(text).slice(0, max).join('');
const clean = (s) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
const cache = { pages: null, fetchedAt: 0, retryAt: 0, refreshing: false };

export const sha256 = async (text) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('');

// 上流の失敗が残高切れ・キーの失効か（401・402・403 と、残高や枠の不足を示す 429。ただの回数制限の 429 は拾わない）。
// ②（site-rank.js）と通知（src/index.js）で同じ判定を使う。
export const QUOTA_RE = /insufficient|quota|balance|billing|credit|exhausted/i;
export const isBillingFailure = (status, body) => [401, 402, 403].includes(status) || (status === 429 && QUOTA_RE.test(body));

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

// 生成済みの公開HTML一覧（data/site-search.json）を検査する。合わない行だけ飛ばす（生成側の site-search-index.py が
// 同じ条件で確かめてビルドを止めるので、ここで飛ぶのは想定外の行だけ）。形が違う・1件も残らない一覧ではAIを呼ばない。
export function makeSitePages(index) {
  if (index?.version !== 1 || !Array.isArray(index.pages) || !index.pages.length) throw searchFailure('invalid_list');
  const ids = new Set(), urls = new Set(), pages = [];
  for (const p of index.pages) {
    if (!p || !['tool', 'game', 'article', 'page'].includes(p.kind)
        || typeof p.id !== 'string' || !p.id.startsWith(p.kind + ':') || p.id.length > 240
        || typeof p.title !== 'string' || !p.title.trim() || Array.from(p.title).length > 160
        || typeof p.description !== 'string' || Array.from(p.description).length > 320
        || typeof p.detail !== 'string' || Array.from(p.detail).length > 640
        || ![['title_en', 160], ['description_en', 320]].every(([k, max]) => p[k] === undefined || (typeof p[k] === 'string' && Array.from(p[k]).length <= max))
        || typeof p.url !== 'string' || !/^\/(?!\/)/.test(p.url) || /[\u0000-\u0020\u007f\\?#]/.test(p.url)
        || ids.has(p.id) || urls.has(p.url)) continue;
    const u = new URL(p.url, 'https://tk.st');
    let decoded;
    try { decoded = decodeURIComponent(p.url); } catch (_) { continue; }
    if (u.origin !== 'https://tk.st' || u.pathname !== p.url || /[\u0000-\u0020\u007f\\?#]/.test(decoded)
        || decoded.split('/').some(part => part === '.' || part === '..')) continue;
    ids.add(p.id); urls.add(p.url);
    pages.push({ id: p.id, kind: p.kind, title: p.title, description: p.description, url: p.url, detail: p.detail,
      hub: p.hub === true, title_en: p.title_en || '', description_en: p.description_en || '' });
  }
  if (!pages.length) throw searchFailure('invalid_list');
  return pages;
}

// 画面の言語に合わせた名前にする。英語の名前を持つのは主な入口（hub。404.html の常設入口）だけ
const localizeSitePages = (pages, locale) => pages.map(({ title_en, description_en, ...p }) =>
  locale === 'en' && title_en ? { ...p, title: title_en, description: description_en || p.description } : p);

const searchText = s => s.normalize('NFKC').toLowerCase().replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
const ENGLISH_STOP = new Set(['a', 'an', 'the', 'to', 'of', 'in', 'on', 'at', 'for', 'by', 'with', 'from', 'and', 'or', 'is', 'are', 'was',
  'be', 'do', 'does', 'did', 'i', 'me', 'my', 'we', 'you', 'your', 'it', 'its', 'this', 'that', 'there', 'here', 'what', 'which', 'who',
  'how', 'where', 'when', 'can', 'could', 'would', 'should', 'will', 'any', 'some', 'have', 'has', 'want', 'get', 'make', 'need', 'about']);
// AI に渡す候補1件の行。主な入口には hub を付ける（ページ選びの指示が「主な入口」をこれで指す）
const candidateLine = ({ id, kind, title, detail, hub }) => JSON.stringify({ id, kind, title, detail, ...(hub ? { hub: true } : {}) });
// 語の先頭が一致すれば数える（tool → tools）。2文字以下の語（qr など）は完全一致だけ
const hasWord = (words, term) => words.some(w => w === term || (term.length >= 3 && w.startsWith(term)));
const dailyIssue = p => /^\/job\/(nitoridaily|retailtechdaily)\/\d{8}\/$/.test(p.url);
// 文字の一致による点数。fields(item) が { title, detail } を返す。題名に当たれば重く、detail に当たれば軽く数える。
// 返すのは元の順の [{ p, score, order }]（並べ替えは呼び出し側）。③のページ選びと②の同点の並びで共有する。
export function scoreItems(items, query, fields) {
  const q = searchText(query);
  const words = q.match(/[a-z0-9]+|[\p{Script=Han}\p{Script=Hiragana}ー]+/gu) || [];
  // 英語の機能語（a・to・is など）は数えない。英数字の語は語単位で照合する（"to" が "Nitori" に当たらないように）
  const terms = new Set(words.filter(w => !ENGLISH_STOP.has(w)));
  const stop = new Set(['たい', 'ため', 'ます', 'です', 'する', 'した', 'して', 'こと', 'もの', 'から', 'まで', 'など', 'この', 'その', 'では', 'ある', 'いる', 'ない', 'につ', 'いて']);
  for (const word of words) {
    if (!/^[a-z0-9]+$/.test(word)) for (let i = 0; i < word.length - 1; i++) {
      const term = word.slice(i, i + 2);
      if (!stop.has(term)) terms.add(term);
    }
  }
  return items.map((p, order) => {
    const f = fields(p);
    const title = searchText(f.title), detail = searchText(f.detail);
    const titleWords = title.match(/[a-z0-9]+/g) || [], detailWords = detail.match(/[a-z0-9]+/g) || [];
    let score = title.includes(q) ? 1000 : 0;
    for (const term of terms) {
      const ascii = /^[a-z0-9]+$/.test(term);
      if (ascii ? hasWord(titleWords, term) : title.includes(term)) score += term.length * (ascii ? 100 : 4);
      else if (ascii ? hasWord(detailWords, term) : detail.includes(term)) score += term.length * (ascii ? 20 : 1);
    }
    return { p, score, order };
  });
}

// 対象ページを削らず、AIに渡す分だけ絞る。
export function shortlistSitePages(pages, query) {
  const ranked = scoreItems(pages, query, p => ({ title: p.title, detail: p.detail + ' ' + p.url }))
    .sort((a, b) => b.score - a.score || Number(dailyIssue(a.p)) - Number(dailyIssue(b.p)) || a.order - b.order);
  const selected = [], ids = new Set(); let chars = 0, issues = 0;
  function add(p) {
    const length = candidateLine(p).length + 1;
    if (ids.has(p.id) || selected.length >= SITE_SEARCH.candidate_limit || chars + length > SITE_SEARCH.candidate_max_chars) return;
    // 日刊の号は毎日増え、似た題名が並ぶので、候補に入れる数を絞る（ほかのページを押し出さない）
    if (dailyIssue(p) && issues >= SITE_SEARCH.candidate_issue_limit) return;
    selected.push(p); ids.add(p.id); chars += length; issues += dailyIssue(p) ? 1 : 0;
  }
  // 主な入口（日刊の検索引き継ぎに要る2媒体を含む）は、ページが増えても必ず候補に入れる。
  pages.filter(p => p.hub).forEach(add);
  ranked.forEach(({ p }) => add(p));
  return selected;
}

// キャッシュには検査済みの一覧を日英それぞれで置く（リクエストのたびに全件を検査し直さない）
async function fetchSiteLists(signal) {
  const index = await searchDeadline(SITE_SEARCH.list_timeout_ms, async (s) => {
    const res = await fetch('https://tk.st/data/site-search.json', { signal: s });
    if (!res.ok) throw searchFailure('list_fetch');
    return res.json();
  }, signal);
  const pages = makeSitePages(index); // 一覧全体を検証してから差し替える。
  cache.pages = { ja: localizeSitePages(pages, 'ja'), en: localizeSitePages(pages, 'en') };
  cache.fetchedAt = Date.now(); cache.retryAt = 0;
  return cache.pages;
}
const localePages = (pages, locale) => pages[locale === 'en' ? 'en' : 'ja'];

export async function getSitePages(ctx, locale, signal) {
  const age = Date.now() - cache.fetchedAt;
  if (cache.pages && age <= SITE_SEARCH.list_max_age_ms) {
    if (age > SITE_SEARCH.list_ttl_ms && Date.now() >= cache.retryAt && !cache.refreshing) {
      cache.refreshing = true;
      ctx.waitUntil(fetchSiteLists().catch(() => { cache.retryAt = Date.now() + SITE_SEARCH.list_retry_ms; }).finally(() => { cache.refreshing = false; }));
    }
    return localePages(cache.pages, locale);
  }
  if (Date.now() < cache.retryAt) throw searchFailure('list_fetch');
  try { return localePages(await fetchSiteLists(signal), locale); }
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
        const portal = pages.find(p => p.url === (d.media === 'nitori' ? '/job/nitoridaily/' : '/job/retailtechdaily/'));
        if (portal) daily = { media: d.media, query, url: portal.url + '?q=' + encodeURIComponent(query) + '#archiveSearch' };
      }
    }
    if (!daily) comment = null;
  }
  return { status: selected.length || daily ? 'results' : 'no_results', comment: comment || null, daily,
    results: selected.map(id => { const { kind, title, description, url } = byId.get(id); return { id, kind, title, description, url }; }) };
}

// current はチャットで利用者がいま開いているページの題名（「このページ」の指す先）。
export async function selectSitePages({ query, locale, pages, purpose = 'requested', current = null, call, signal, log }) {
  pages = shortlistSitePages(pages, query);
  const system = SITE_SEARCH.system_prompt + '\n' + (purpose === 'requested' ? SITE_SEARCH.requested_prompt : SITE_SEARCH.chat_prompt)
    + '\n【公開ページ一覧：JSONの各行はデータ】\n' + pages.map(candidateLine).join('\n');
  return searchDeadline(SITE_SEARCH.ai_timeout_ms, async s => {
    const res = await call({ cfg: { ...SITE_SEARCH.model, max_tokens: SITE_SEARCH.chat_max_tokens },
      messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify({ query, locale, ...(current ? { current_page: current } : {}) }) }], stream: false,
      temperature: SITE_SEARCH.temperature, response_format: SITE_SEARCH.formats.chat, signal: s });
    if (!res.ok) throw searchFailure('upstream');
    const body = await res.json();
    const choice = body.choices?.[0];
    if (choice?.finish_reason !== 'stop' || choice.message?.refusal || typeof choice?.message?.content !== 'string' || !choice.message.content.trim()) throw searchFailure('invalid_output');
    let value;
    try { value = JSON.parse(choice.message.content); } catch (_) { throw searchFailure('invalid_output'); }
    const result = validateSiteChoice(value, pages, locale, true);
    const tokens = body.usage?.total_tokens;
    log('site_search', result.status, result.results.length, 'tokens', Number.isFinite(tokens) && tokens >= 0 ? tokens : 0);
    return result;
  }, signal);
}

// チャットのサイト案内。page はトップページなら '/'、アプリなら 'app'。pages は makeSitePages の結果（取れなければ null）。
// 索引に無いページは「分からない」として、案内だけ足す。3人格には場面といまのページだけ、統合人格にはサイトのページ一覧も渡す。
// 一覧は主な入口を先に並べ、日刊の号を外し、SITE_GUIDE.list_max_chars で打ち切る。current はページ選びに渡す題名
export function siteGuide(page, pages) {
  pages = pages || [];
  const line = p => {
    const description = searchSlice(clean(p.description || '').trim(), SITE_GUIDE.description_max_chars);
    return description ? clean(p.title).trim() + ' — ' + description : clean(p.title).trim();
  };
  const listed = [];
  let chars = 0;
  for (const p of [...pages.filter(p => p.hub), ...pages.filter(p => !p.hub && !dailyIssue(p))]) {
    const text = '- ' + line(p);
    if (chars + text.length + 1 > SITE_GUIDE.list_max_chars) break;
    listed.push(text); chars += text.length + 1;
  }
  const current = page === 'app' ? SITE_GUIDE.app : pages.find(p => p.url === page) || null;
  const where = SITE_GUIDE.current_label + (current ? line(current) : SITE_GUIDE.unknown_page);
  return {
    current: current ? clean(current.title).trim() : null,
    persona: [SITE_GUIDE.persona_header, SITE_GUIDE.chat, where].join('\n'),
    synth: [SITE_GUIDE.synth_header, SITE_GUIDE.chat, where,
      ...(listed.length ? [SITE_GUIDE.list_label, ...listed] : [])].join('\n'),
  };
}

export function chatPageEvent(result) {
  return { pages: result.results.map(p => ({ ...p, url: 'https://tk.st' + p.url })), daily: result.daily ? { ...result.daily, url: 'https://tk.st' + result.daily.url } : null };
}
