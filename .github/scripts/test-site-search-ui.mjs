// サイト内検索の画面の検証（assets/site-search-design.md 10.3）。手元の Playwright で動かす。
//   node .github/scripts/test-site-search-ui.mjs [--root _site]
//   node .github/scripts/test-site-search-ui.mjs --base https://tk.st   … 本番を相手にする（計画書 T4.10。Actions の site-search-url.yml）
// 手元では先に `bash build.sh` で _site を作る（--root . ならリポジトリをそのまま出す）。存在しないパスには 404.html を 404 で返す。
// ②の場面（計画書 T5.4）：応答の検査・状態と世代・①③との連携と計測・表示・停止。Worker への要求は route で応答を差し替える。
// 404 の RANK_ENABLED が false（②を止めた）なら、②の場面は飛ばす。本番（--base）では1場面だけ本物の Worker に送る。
// URL の部分（PRD 6.1。計画書 T4.8）：目印の検索語が、外へ出る通信（URL と本文）・location・移った先の
// document.referrer に残らないことを、404 → 日刊、③の日刊リンク、日刊のヘッダー・横断検索・タグ・絞り込み・号への移動、
// 古い ?q=、受け取らない値、計測を止めた状態、JS 無効のヘッダー送信、再読み込みで確かめる。
// 計測は本物の GTM・Ahrefs を読み込み、ほかの外への通信はすべて記録してから止める（解析のデータを汚さない）。
// 合否は本番の URL で決める（設計書 9章の5・計画書 T4.10）。手元の結果は事前の見当にとどまる。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const option = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const remote = option('--base', null);
const root = resolve(repo, option('--root', '_site'));
if (!remote && !existsSync(join(root, '404.html'))) {
  console.error(`${root} に 404.html が無い。先に bash build.sh を実行する（または --root . でリポジトリをそのまま出す）`);
  process.exit(1);
}

const MARK = 'zqxmark7';           // 目印。ASCII なので URL のエンコードを通っても同じ文字列のまま残る
const QUERY = MARK + ' 収納';       // 日本語も混ぜる
// 本物を読み込む計測のスクリプト。これ以外の外への通信は記録して止める
const ANALYTICS_SCRIPTS = [/^https:\/\/www\.googletagmanager\.com\/gtm\.js\?/, /^https:\/\/www\.googletagmanager\.com\/gtag\/js\?/,
  /^https:\/\/analytics\.ahrefs\.com\/analytics\.js$/];
// 検索語を送る先として決まっている Worker（③。本文に検索語が入るのは仕様。URL と参照元だけを見る）
const SEARCH_API = /^(?:https:\/\/workers\.tk\.st|http:\/\/localhost:8787)\/magi2\/site-search(?:\?|$)/;

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.xml': 'application/xml',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm' };
function serve() {
  const server = createServer((req, res) => {
    let path;
    try { path = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (_) { path = '/'; }
    let file = resolve(root, '.' + path);
    if (file !== root && !file.startsWith(root + sep)) file = null;
    if (file && existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    const found = file && existsSync(file) && statSync(file).isFile();
    const body = readFileSync(found ? file : join(root, '404.html'));
    res.writeHead(found ? 200 : 404, { 'Content-Type': (found ? TYPES[extname(file)] : TYPES['.html']) || 'application/octet-stream' });
    res.end(body);
  });
  return new Promise(ok => server.listen(0, '127.0.0.1', () => ok(server)));
}

const { chromium } = await import('playwright');
const server = remote ? null : await serve();
const BASE = remote ? remote.replace(/\/$/, '') : `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const failures = [];
const analyticsLoaded = new Set(), analyticsFailed = new Set();
const allRequests = []; // まとめ用（送り先ごとの件数と GA4 のイベント名）
const check = (ok, message) => { if (!ok) failures.push(message); };
const marked = s => typeof s === 'string' && s.toLowerCase().includes(MARK);

// 外への通信の記録。手元のサーバーへの要求（目印を URL に入れて開くものを含む）は数えない
async function newContext({ js = true, analyticsOff = false, worker = null, locale = 'ja-JP', viewport = null, colorScheme = 'light', lists = null } = {}) {
  const context = await browser.newContext({ javaScriptEnabled: js, locale, colorScheme, ...(viewport ? { viewport } : {}) });
  const log = [];
  if (analyticsOff) await context.addInitScript(() => { try { localStorage.setItem('st-analytics', 'off'); } catch (_) {} });
  await context.route('**/*', async route => {
    const req = route.request(), url = req.url();
    // ①の一覧（404 が読む JSON）を遅らせる・1つ失敗させる（keyword_state の検査）
    if (lists && /\/data\/(tools|game|glitch)\.json$/.test(new URL(url).pathname)) {
      if (lists === 'fail' && url.endsWith('/tools.json')) return route.fulfill({ status: 500, body: '' });
      if (lists === 'slow') await new Promise(ok => setTimeout(ok, 3000));
    }
    if (url.startsWith(BASE + '/') && !url.startsWith(BASE + '/cdn-cgi/')) return route.continue(); // /cdn-cgi/ は Cloudflare の計測の送り先
    let body = null;
    try { body = req.postData(); } catch (_) { body = '(読めない本文)'; }
    log.push({ url, body, referer: (await req.allHeaders()).referer || null, search: SEARCH_API.test(url) });
    if (SEARCH_API.test(url) && worker) return worker(route);
    if (ANALYTICS_SCRIPTS.some(r => r.test(url))) {
      try {
        const res = await route.fetch();
        (res.ok() ? analyticsLoaded : analyticsFailed).add(new URL(url).host + (res.ok() ? '' : `（HTTP ${res.status()}）`));
        return route.fulfill({ response: res });
      } catch (_) { analyticsFailed.add(new URL(url).host); return route.abort(); }
    }
    return route.abort();
  });
  return { context, log };
}

// 検索語を送ってよいのは GA4 のイベントの search_term だけ（PRD 8.3）。その値を除いてから目印を探す
const GOOGLE_MEASUREMENT = /(^|\.)google-analytics\.com$|^analytics\.google\.com$|^stats\.g\.doubleclick\.net$|^www\.google\.[a-z.]+$/; // 国別のドメイン（www.google.ca など）も Google シグナルの送り先
const withoutSearchTerm = (r, text) => typeof text === 'string' && GOOGLE_MEASUREMENT.test(new URL(r.url).host)
  ? text.replace(/(^|[?&\n])ep\.search_term=[^&\n]*/g, '$1') : text;
// 伏せ字にするはずの値（計測の場面で入力する）。URL と本文をデコードしてから探す（エンコードの違いで見逃さない）
const PII = ['a.b@example.com', '090-1234-5678', '０９０１２３４５６７８', '09012345678'];
const PII_QUERY = 'メール a.b@example.com 090-1234-5678 収納', PII_MASKED = 'メール [email] [number] 収納';
const PII_WIDE = '電話番号 ０９０１２３４５６７８', PII_WIDE_MASKED = '電話番号 [number]'; // 全角の数字（NFKC で半角にしてから伏せる）
function decoded(text) {
  let t = (text || '').replace(/\+/g, ' ');
  for (let i = 0; i < 2; i++) { try { t = decodeURIComponent(t); } catch (_) { break; } }
  return t;
}
function checkLog(name, log) {
  for (const raw of log) {
    const plain = decoded(raw.url) + '\n' + decoded(raw.body);
    for (const v of PII) check(!plain.includes(v), `${name}: 伏せるはずの値（${v}）が外への通信に出た（${raw.url.slice(0, 120)}）`);
    const r = { ...raw, url: withoutSearchTerm(raw, raw.url), body: withoutSearchTerm(raw, raw.body) };
    if (r.search) {
      check(!marked(r.url), `${name}: 検索の Worker への URL に目印がある（${r.url}）`);
      check(!marked(r.referer), `${name}: 検索の Worker への参照元に目印がある`);
      continue;
    }
    check(!marked(r.url), `${name}: 外への通信の URL に目印がある（${r.url.slice(0, 160)}）`);
    check(!marked(r.body), `${name}: 外への通信の本文に目印がある（${r.url.slice(0, 160)}）`);
    // 同じサイトの /cdn-cgi/（Cloudflare の先読み speculation など）の参照元は見ない。古い ?q= はページを開く要求そのもので
    // すでに tk.st に届いている（外部へ出るのではない）。URL と本文は見る（Cloudflare Web Analytics の送信など）
    if (!r.url.startsWith(BASE + '/cdn-cgi/')) check(!marked(r.referer), `${name}: 外への通信の参照元に目印がある（${r.url.slice(0, 160)}）`);
    check(!/[?&]en=view_search_results(?:&|$)/.test(r.url) && !/(?:^|[&\n])en=view_search_results(?:&|$)/.test(r.body || ''),
      `${name}: GA4 に view_search_results が送られた`);
  }
}

async function checkLocation(name, page) {
  const loc = await page.evaluate(() => ({ search: location.search, hash: location.hash, href: location.href }));
  check(!marked(loc.search) && !marked(loc.hash), `${name}: URL に目印が残る（${loc.href}）`);
  return loc;
}

// 日刊のポータルから号へ移り、移った先の参照元を見る
async function leaveToIssue(name, page) {
  const link = page.locator('[data-archive-month] a').first();
  await Promise.all([page.waitForURL(/\/job\/[a-z]+daily\/\d{8}\//), link.click()]);
  const referrer = await page.evaluate(() => document.referrer);
  check(!marked(referrer), `${name}: 号のページの参照元に目印がある（${referrer}）`);
  await checkLocation(name + '（号）', page);
}

async function settle(page) { await page.waitForLoadState('load'); await page.waitForTimeout(400); }
async function portalInput(page) { return page.locator('#archiveSearchInput').inputValue(); }

const scenarios = [];
const scenario = (name, options, fn) => scenarios.push({ name, options, fn });

// Worker の差し替え。rank・ai は要求の本文を受けて { status?, body, delay? } を返す
function mockWorker({ rank, ai }) {
  return async route => {
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    let body = {};
    try { body = JSON.parse(route.request().postData() || '{}'); } catch (_) {}
    const handler = body.mode === 'rank' ? rank : ai;
    const reply = handler ? await handler(body) : { status: 503, body: {} };
    if (reply.delay) await new Promise(ok => setTimeout(ok, reply.delay));
    try { await route.fulfill({ status: reply.status || 200, headers, contentType: 'application/json', body: JSON.stringify(reply.body) }); } catch (_) { /* 中止された要求 */ }
  };
}
const rankBody = (results, extra = {}) => ({ request_id: 'local', status: results.length ? 'results' : 'no_results', complete: true, reason: null,
  searched: { total: 35, candidates: 35, judged: 35 }, results, ...extra });
const row = (title, url = '/tools/pdf-studio/', kind = 'tool') => ({ kind, title, description: title + ' の説明', url });
const aiBody = { request_id: 'local', status: 'no_results', comment: null, results: [] };

// ②の画面の様子
async function rankView(page) {
  return page.evaluate(() => ({
    state: document.getElementById('rank-info-text').hidden ? 'off' : 'on',
    suggest: document.getElementById('suggest-list').hidden ? [] : [...document.querySelectorAll('#suggest-list [role="option"] a')].map(a => a.getAttribute('href')),
    area: !document.getElementById('rank-area').hidden,
    rank: [...document.querySelectorAll('#rank-list .result-title')].map(e => e.textContent),
    rankHrefs: [...document.querySelectorAll('#rank-list a')].map(a => a.getAttribute('href')),
    rankStatus: document.getElementById('rank-status').textContent,
    keyword: [...document.querySelectorAll('#result-list a')].map(a => a.getAttribute('href')),
    keywordStatus: document.getElementById('search-status').textContent,
    ai: !document.getElementById('ai-search').hidden, aiQuiet: document.getElementById('ai-search').classList.contains('is-quiet'),
    aiResult: !document.getElementById('ai-result').hidden,
    images: document.querySelectorAll('#rank-results img').length,
    events: (window.dataLayer || []).filter(e => e && typeof e.event === 'string' && /^not_found_(rank_|ai_used)/.test(e.event)).map(e => ({ ...e })),
  }));
}
// ②の場面は、②が出ているときだけ（本番で未公開なら飛ばす）
const rankScenario = (name, options, fn) => scenarios.push({ name: '②：' + name, options, fn: async (page, label) => {
  await page.goto(BASE + '/no-such-page/'); await settle(page);
  if (!(await page.evaluate(() => { const e = document.getElementById('rank-info-text'); return !!e && !e.hidden; }))) { skipped.push(label); return; }
  await fn(page, label);
} });
const skipped = [];
async function typeAndRun(page, value, wait = 300) { await page.fill('#query', value); await page.waitForTimeout(150); await page.press('#query', 'Enter'); await page.waitForTimeout(wait); }
const PORTAL = '/job/nitoridaily/';
async function anyIssue(page) {
  await page.goto(BASE + PORTAL); await settle(page);
  return page.locator('[data-archive-month] a').first().getAttribute('href').then(h => new URL(h, BASE + PORTAL).pathname);
}

scenario('404 → 日刊（③の下の「日刊ブリーフで探す」）', {}, async (page, name) => {
  await page.goto(BASE + '/no-such-page/'); await settle(page);
  await page.fill('#query', QUERY);
  // 入力中は出さず、検索した後（Enter）に出す
  check(!(await page.locator('#nitori-search').isVisible()), `${name}: 入力中に日刊ブリーフの欄が出ている`);
  await page.press('#query', 'Enter');
  const link = page.locator('#nitori-search');
  await link.waitFor({ state: 'visible' });
  await Promise.all([page.waitForURL(u => u.pathname === PORTAL), link.click()]);
  await settle(page);
  check(await portalInput(page) === QUERY, `${name}: ポータルの横断検索に検索語が入らない`);
  await checkLocation(name, page);
  await leaveToIssue(name, page);
});

scenario('404 → ③ の結果の行', {
  worker: mockWorker({ rank: () => ({ body: rankBody([]) }), ai: () => ({ body: { request_id: 'local', status: 'results', comment: null,
      results: [{ id: 'tool:7', kind: 'tool', title: 'PDF Studio', description: 'PDF', url: '/tools/pdf-studio/' }],
      // 日刊の検索語付きリンク（daily）はやめた。古い Worker が送っても描かない
      daily: { media: 'nitori', query: MARK + ' 出店', url: '/job/nitoridaily/#q=' + encodeURIComponent(MARK + ' 出店') } } }) }),
}, async (page, name) => {
  await page.goto(BASE + '/no-such-page/'); await settle(page);
  await page.fill('#query', MARK + 'zz');
  // ③は検索した後（Enter）に出る（設計書 6.3）
  await page.waitForTimeout(200); await page.press('#query', 'Enter');
  await page.locator('#ai-run').waitFor({ state: 'visible' });
  await page.click('#ai-run');
  await page.locator('#ai-list .result-link').first().waitFor({ state: 'visible' });
  const aiRow = await page.evaluate(() => { const a = document.querySelector('#ai-list .result-link'); return a && [a.getAttribute('href'), a.dataset.aiTarget, a.dataset.aiPosition, a.querySelector('.result-title').textContent, a.querySelector('.kind').textContent].join('|'); });
  check(aiRow === '/tools/pdf-studio/|result|1|PDF Studio|ツール', `${name}: ③の結果の行の形が違う（${aiRow}）`);
  check(!(await page.evaluate(() => [...document.querySelectorAll('#ai-result a')].some(a => (a.getAttribute('href') || '').includes('#q=')))), `${name}: ③に日刊の検索語付きリンクが出た`);
});


for (const [label, off] of [['', false], ['（計測を止めた状態）', true]]) {
  scenario('日刊ポータルの #q=' + label, { analyticsOff: off }, async (page, name) => {
    await page.goto(BASE + PORTAL + '#q=' + encodeURIComponent(QUERY)); await settle(page);
    check(await portalInput(page) === QUERY, `${name}: 横断検索に検索語が入らない`);
    await checkLocation(name, page);
    // 再読み込みで検索語が戻らない
    await page.reload(); await settle(page);
    check(await portalInput(page) === '', `${name}: 再読み込みで検索語が戻る`);
    await checkLocation(name + '（再読み込み）', page);
    await leaveToIssue(name, page);
  });
}

// ポータルを開いたまま #q= に変える（hashchange。計測の履歴の変更の扱いも見る）
scenario('日刊ポータルの中で #q= に変える', {}, async (page, name) => {
  await page.goto(BASE + PORTAL); await settle(page);
  await page.evaluate(q => { location.hash = '#q=' + encodeURIComponent(q); }, QUERY);
  await page.waitForTimeout(800);
  check(await portalInput(page) === QUERY, `${name}: 横断検索に検索語が入らない`);
  await checkLocation(name, page);
  await leaveToIssue(name, page);
});

scenario('日刊ポータルの古い ?q=', {}, async (page, name) => {
  await page.goto(BASE + PORTAL + '?q=' + encodeURIComponent(QUERY) + '#archiveSearch'); await settle(page);
  check(await portalInput(page) === QUERY, `${name}: 横断検索に検索語が入らない`);
  await checkLocation(name, page);
  await leaveToIssue(name, page);
});

for (const [label, suffix] of [
  ['q が2つ', `?q=${MARK}&q=${MARK}b#archiveSearch`],
  ['不正なエンコード', `#q=${MARK}%E0%A4`],
  ['201文字', '#q=' + MARK + 'a'.repeat(201 - MARK.length)],
  ['?q= と #q= の両方', `?q=${MARK}#q=${MARK}b`],
  ['& を含むフラグメント', `#q=${MARK}&x=1`],
]) {
  scenario('受け取らない値：' + label, {}, async (page, name) => {
    await page.goto(BASE + PORTAL + suffix); await settle(page);
    await checkLocation(name, page);
    await leaveToIssue(name, page);
  });
}

scenario('日刊ポータルのヘッダー検索・タグ・横断検索・絞り込み', {}, async (page, name) => {
  await page.goto(BASE + PORTAL); await settle(page);
  await page.fill('#headerSearchInput', QUERY); await page.press('#headerSearchInput', 'Enter'); await page.waitForTimeout(400);
  check(await portalInput(page) === QUERY, `${name}: ヘッダー検索が横断検索に入らない`);
  await checkLocation(name + '（ヘッダー）', page);
  await page.fill('#archiveSearchInput', MARK + ' 横断'); await page.press('#archiveSearchInput', 'Enter'); await page.waitForTimeout(400);
  await checkLocation(name + '（横断検索）', page);
  const month = page.locator('#archiveMonthFilter option').nth(1);
  if (await month.count()) { await page.selectOption('#archiveMonthFilter', await month.getAttribute('value')); await page.waitForTimeout(300); }
  await page.selectOption('#archiveRegionFilter', 'JP'); await page.waitForTimeout(300);
  await checkLocation(name + '（絞り込み）', page);
  const tag = page.locator('.trend-list a.topic-tag').first();
  if (await tag.count()) { await tag.click(); await page.waitForTimeout(300); await checkLocation(name + '（タグ）', page); }
  // 横断検索の結果から号へ移る（目印で検索した後に、結果の出る語で検索し直す）
  await page.selectOption('#archiveRegionFilter', ''); await page.selectOption('#archiveMonthFilter', '');
  await page.fill('#archiveSearchInput', 'ニトリ'); await page.press('#archiveSearchInput', 'Enter'); await page.waitForTimeout(400);
  const result = page.locator('#archiveSearchResults a').first();
  if (await result.count()) {
    await Promise.all([page.waitForURL(/\/job\/nitoridaily\/\d{8}\//), result.click()]);
    const referrer = await page.evaluate(() => document.referrer);
    check(!marked(referrer), `${name}: 横断検索の結果から移った号の参照元に目印がある（${referrer}）`);
  } else failures.push(`${name}: 横断検索の結果が無く、号への移動を確かめられない`);
});

scenario('号のページのヘッダー検索とタグ', {}, async (page, name) => {
  const issue = await anyIssue(page);
  await page.goto(BASE + issue); await settle(page);
  await page.fill('#headerSearchInput', QUERY);
  await Promise.all([page.waitForURL(u => u.pathname === PORTAL), page.press('#headerSearchInput', 'Enter')]);
  await settle(page);
  check(await portalInput(page) === QUERY, `${name}: 号のヘッダー検索がポータルの横断検索に入らない`);
  await checkLocation(name + '（ヘッダー）', page);
  await page.goto(BASE + issue); await settle(page);
  const tag = page.locator('.card-tags a.topic-tag').first();
  const text = (await tag.textContent()).replace(/^#/, '');
  await Promise.all([page.waitForURL(u => u.pathname === PORTAL), tag.click()]);
  await settle(page);
  check(await portalInput(page) === text, `${name}: タグがポータルの横断検索に入らない`);
  await checkLocation(name + '（タグ）', page);
});

scenario('analytics.js を先に読ませたポータル（手元で作る）', {}, async (page, name) => {
  await page.route('**' + PORTAL, async route => {
    const res = await route.fetch();
    let html = await res.text();
    const tag = html.match(/\s*<script src="[^"]*assets\/analytics\.js" async><\/script>/);
    assert.ok(tag, 'ポータルに analytics.js が無い');
    html = html.replace(tag[0], '').replace('<meta charset="UTF-8">', '<meta charset="UTF-8">\n  <script src="../../assets/analytics.js"></script>');
    await route.fulfill({ response: res, body: html });
  });
  await page.goto(BASE + PORTAL + '#q=' + encodeURIComponent(QUERY)); await settle(page);
  await page.waitForTimeout(800);
  await checkLocation(name, page);
  await leaveToIssue(name, page);
});

scenario('JS 無効のヘッダー送信', { js: false }, async (page, name) => {
  await page.goto(BASE + PORTAL); await settle(page);
  const issue = await page.locator('[data-archive-month] a').first().getAttribute('href');
  await page.goto(new URL(issue, BASE + PORTAL).href); await settle(page);
  await page.fill('#headerSearchInput', QUERY);
  await Promise.all([page.waitForURL(u => u.pathname === PORTAL), page.press('#headerSearchInput', 'Enter')]);
  check(!marked(page.url()), `${name}: JS 無効の送信で URL に検索語が入る（${page.url()}）`);
});

// 404 の計測（Phase 0。計画書 T0.2）：①の件数のイベントが dataLayer に入り、GTM が GA4 へ送るか。
// GA4 へ送ったかはまとめの「GA4 のイベント」に出る（本物の GTM を読めたときだけ分かる）
scenario('404 の計測：not_found_keyword_count', {}, async (page, name) => {
  await page.goto(BASE + '/no-such-page/'); await settle(page);
  await page.fill('#query', 'pdf');
  await page.waitForTimeout(2500); // 入力が1.5秒止まったら送る
  const events = await page.evaluate(() => (window.dataLayer || []).filter(e => e && typeof e.event === 'string').map(e => ({ ...e })));
  const hit = events.find(e => e.event === 'not_found_keyword_count');
  check(hit && hit.count === 1, `${name}: dataLayer に not_found_keyword_count（count 1）が入らない`);
  await page.waitForTimeout(5000); // GA4 はまとめて送るので待つ
});

// 検索語の計測（PRD 8.3）：伏せ字にしてから search_term で送る。日刊の横断検索も同じ。計測を止めた人には送らない
scenario('404 の計測：search_term は伏せ字にして送る', {}, async (page, name) => {
  await page.goto(BASE + '/no-such-page/'); await settle(page);
  await page.fill('#query', PII_QUERY);
  await page.waitForTimeout(2500);
  const hit = (await page.evaluate(() => (window.dataLayer || []).filter(e => e && e.event === 'not_found_keyword_count').map(e => ({ ...e })))).at(-1);
  check(hit && hit.search_term === PII_MASKED, `${name}: search_term が伏せ字になっていない（${hit && hit.search_term}）`);
  await page.fill('#query', PII_WIDE);
  await page.waitForTimeout(2500);
  const wide = (await page.evaluate(() => (window.dataLayer || []).filter(e => e && e.event === 'not_found_keyword_count').map(e => e.search_term))).at(-1);
  check(wide === PII_WIDE_MASKED, `${name}: 全角の電話番号が伏せ字になっていない（${wide}）`);
  await page.fill('#query', '２０２６－１０－０８ 号');
  await page.waitForTimeout(2500);
  const date = (await page.evaluate(() => (window.dataLayer || []).filter(e => e && e.event === 'not_found_keyword_count').map(e => e.search_term))).at(-1);
  check(date === '2026-10-08 号', `${name}: 日付まで伏せ字にした（${date}）`);
  check(await page.locator('#search-info-open').isVisible() && !(await page.evaluate(() => document.getElementById('analytics-info-text').hidden)), `${name}: 計測の説明（見出しの横のインフォメーションマークとダイアログの段落）が無い`);
  await page.click('#search-info-open');
  check(await page.evaluate(() => document.getElementById('ai-info-dialog').open), `${name}: インフォメーションマークでダイアログが開かない`);
});
for (const [label, off] of [['', false], ['（計測を止めた状態）', true]]) {
  scenario('日刊の計測：daily_search' + label, { analyticsOff: off }, async (page, name) => {
    await page.goto(BASE + PORTAL); await settle(page);
    await page.fill('#archiveSearchInput', QUERY); await page.press('#archiveSearchInput', 'Enter'); await page.waitForTimeout(500);
    await page.selectOption('#archiveRegionFilter', 'JP'); await page.waitForTimeout(300); // 絞り込みだけの変更では送り直さない
    const hits = await page.evaluate(() => (window.dataLayer || []).filter(e => e && e.event === 'daily_search').map(e => ({ ...e })));
    if (off) check(hits.length === 0, `${name}: 計測を止めているのに daily_search を送った`);
    else check(hits.length === 1 && hits[0].search_term === QUERY && typeof hits[0].count === 'number', `${name}: daily_search が1回だけ・検索語付きで送られない（${JSON.stringify(hits)}）`);
    if (!off) {
      await page.fill('#archiveSearchInput', PII_QUERY); await page.press('#archiveSearchInput', 'Enter'); await page.waitForTimeout(300);
      const last = (await page.evaluate(() => (window.dataLayer || []).filter(e => e && e.event === 'daily_search').map(e => e.search_term))).at(-1);
      check(last === PII_MASKED, `${name}: 日刊の search_term が伏せ字になっていない（${last}）`);
      await page.fill('#archiveSearchInput', PII_WIDE); await page.press('#archiveSearchInput', 'Enter'); await page.waitForTimeout(300);
      const wide = (await page.evaluate(() => (window.dataLayer || []).filter(e => e && e.event === 'daily_search').map(e => e.search_term))).at(-1);
      check(wide === PII_WIDE_MASKED, `${name}: 日刊の全角の電話番号が伏せ字になっていない（${wide}）`);
    }
    await checkLocation(name, page);
    await page.waitForTimeout(3000);
  });
}

// 日刊の索引が読めないとき：「0件」と表示・計測せず、次の検索で読み直す
scenario('日刊の索引の取得失敗', {}, async (page, name) => {
  let fail = true;
  await page.route('**/job/nitoridaily/search-index*.json', route => fail ? route.fulfill({ status: 503, body: '' }) : route.fallback());
  await page.goto(BASE + PORTAL); await settle(page);
  await page.fill('#archiveSearchInput', 'ニトリ'); await page.press('#archiveSearchInput', 'Enter'); await page.waitForTimeout(500);
  let v = await page.evaluate(() => ({ status: document.getElementById('archiveSearchStatus').textContent, results: document.querySelectorAll('#archiveSearchResults article, #archiveSearchResults a').length,
    events: (window.dataLayer || []).filter(e => e && e.event === 'daily_search').length }));
  check(/読み込めませんでした/.test(v.status) && !/件見つかりました/.test(v.status), `${name}: 失敗が「0件」と表示される（${v.status}）`);
  check(v.results === 0 && v.events === 0, `${name}: 失敗したのに結果か daily_search が出た（${JSON.stringify(v)}）`);
  fail = false;
  await page.press('#archiveSearchInput', 'Enter'); await page.waitForTimeout(800);
  v = await page.evaluate(() => ({ status: document.getElementById('archiveSearchStatus').textContent, events: (window.dataLayer || []).filter(e => e && e.event === 'daily_search').length }));
  check(/件見つかりました/.test(v.status) && v.events === 1, `${name}: 直った後の検索で読み直さない（${JSON.stringify(v)}）`);
});

// ウォッチ中のテーマの新着：索引が読めないとき「新着なし」と見せない
scenario('日刊のウォッチの新着の取得失敗', {}, async (page, name) => {
  await page.addInitScript(() => { try { localStorage.setItem('daily_watch_topics:' + 'nitoridaily', JSON.stringify(['ニトリ'])); } catch (_) {} });
  await page.route('**/job/nitoridaily/search-index*.json', route => route.fulfill({ status: 503, body: '' }));
  await page.goto(BASE + PORTAL); await settle(page);
  const v = await page.evaluate(() => ({ hidden: document.getElementById('watchFeed').hidden, status: document.getElementById('watchFeedStatus').textContent }));
  check(!v.hidden && /読み込めませんでした/.test(v.status), `${name}: 失敗が「新着なし」に見える（${JSON.stringify(v)}）`);
});

// ---- ②（計画書 T5.4。設計書 5章・6章、PRD 3.1・7.4） ----
const FAILED_JA = 'いまは検索結果を出せません。キーワードの一致と Shinya Takeda AI は使えます。';

// 応答の検査：1行でも URL などが合わなければ全体を描かない（設計書 5.3）
const BAD_ROWS = [
  ['//example.com/', row('外部1', '//example.com/')], ['https://example.com/', row('外部2', 'https://example.com/')],
  ['/\\example.com', row('外部3', '/\\example.com')], ['クエリ付き', row('クエリ', '/tools/pdf-studio/?x=1')],
  ['フラグメント付き', row('フラグメント', '/tools/pdf-studio/#x')], ['javascript:', row('js', 'javascript:alert(1)')],
  ['日刊の行（site では出さない）', row('日刊', '/job/nitoridaily/20261007/#art-1', 'daily')],
  ['知らない kind', row('謎', '/tools/pdf-studio/', 'secret')],
];
for (const [label, bad] of BAD_ROWS) {
  rankScenario('応答の検査：' + label, { worker: mockWorker({ rank: () => ({ body: rankBody([row('正しい行'), bad]) }) }) }, async (page, name) => {
    await typeAndRun(page, 'pdf');
    const v = await rankView(page);
    check(v.rank.length === 0, `${name}: 合わない行を含む応答を描いた（${v.rank.join('・')}）`);
    check(v.rankStatus === FAILED_JA, `${name}: 失敗の文言が出ない（${v.rankStatus}）`);
    const result = v.events.filter(e => e.event === 'not_found_rank_result').at(-1);
    check(result && result.status === 'failed' && result.reason === 'unavailable', `${name}: 計測が failed（unavailable）でない`);
  });
}
rankScenario('応答の検査：形の合わない本文・HTTP の状態', { worker: mockWorker({ rank: b => (
  b.query === 'q1' ? { body: { status: 'results', results: [row('complete が無い')] } }
  : b.query === 'q2' ? { body: rankBody(Array.from({ length: 6 }, (_, i) => row('多すぎる' + i))) }
  : b.query === 'q3' ? { status: 500, body: rankBody([row('500')]) }
  : b.query === 'q4' ? { status: 429, body: { request_id: 'x', status: 'failed', complete: false, reason: 'rate_limited', searched: null, results: [] } }
  : { body: rankBody([row('<img src=x onerror="window.__xss=1">')]) }) }) }, async (page, name) => {
  for (const q of ['q1', 'q2', 'q3']) {
    await typeAndRun(page, q);
    const v = await rankView(page);
    check(v.rank.length === 0 && v.rankStatus === FAILED_JA, `${name}: ${q} を描いた、または失敗の文言が出ない`);
  }
  await typeAndRun(page, 'q4');
  check((await rankView(page)).rankStatus === '今日の検索の上限に達しました。キーワードの一致は使えます。', `${name}: 上限の文言が出ない`);
  await typeAndRun(page, 'q5');
  const v = await rankView(page);
  check(v.rank[0] === '<img src=x onerror="window.__xss=1">' && v.images === 0 && !(await page.evaluate(() => window.__xss)), `${name}: 題名を文字として描いていない`);
});

// 状態と世代：古い応答を描かない（PRD 3.1）
const echo = delayFor => mockWorker({ rank: b => ({ delay: delayFor(b.query), body: rankBody([row('結果:' + b.query)]) }), ai: () => ({ body: aiBody }) });
rankScenario('状態：遅い A の後に B', { worker: echo(q => q === 'A' ? 1500 : 0) }, async (page, name) => {
  await typeAndRun(page, 'A', 100);
  check((await rankView(page)).rankStatus === '意味の近いページを探しています…', `${name}: 読み込み中の文言が出ない`);
  await typeAndRun(page, 'B', 2000);
  const v = await rankView(page);
  check(v.rank.join() === '結果:B', `${name}: B の結果だけを描いていない（${v.rank.join('・')}）`);
});
rankScenario('状態：A → B → A（最初の A の応答を描かない）', { worker: echo(q => q === 'A' ? 1200 : 0) }, async (page, name) => {
  await typeAndRun(page, 'A', 100);
  await page.fill('#query', 'B'); await page.waitForTimeout(150);
  await page.fill('#query', 'A'); await page.waitForTimeout(1500);
  const v = await rankView(page);
  check(v.rank.length === 0, `${name}: 最初の A の応答を描いた`);
  check(v.rankStatus === '', `${name}: stale の文言が出ない（${v.rankStatus}）`);
  check(!v.area && !v.ai, `${name}: 入力を変えた後も②の欄か③が出ている（入力中の形に戻らない）`);
  await page.press('#query', 'Enter'); await page.waitForTimeout(1500);
  check((await rankView(page)).rank.join() === '結果:A', `${name}: 入力を戻して Enter で送り直さない`);
});
rankScenario('状態：送信後に入力を変える・空入力', { worker: echo(() => 800) }, async (page, name) => {
  await typeAndRun(page, 'A', 100);
  await page.fill('#query', ''); await page.waitForTimeout(1200);
  let v = await rankView(page);
  check(v.rank.length === 0 && v.rankStatus === '' && !v.ai, `${name}: 空入力で②の結果・文言・③が残る`);
  const before = (await rankView(page)).events.filter(e => e.event === 'not_found_rank_run').length;
  await page.press('#query', 'Enter'); await page.waitForTimeout(300);
  v = await rankView(page);
  check(v.events.filter(e => e.event === 'not_found_rank_run').length === before, `${name}: 空入力の Enter で②を送った`);
});
rankScenario('状態：変換中の Enter で送らない', { worker: echo(() => 0) }, async (page, name) => {
  await page.fill('#query', 'しゅうのう'); await page.waitForTimeout(150);
  await page.evaluate(() => document.getElementById('query').dispatchEvent(new CompositionEvent('compositionstart')));
  await page.press('#query', 'Enter'); await page.waitForTimeout(300);
  let v = await rankView(page);
  check(!v.events.some(e => e.event === 'not_found_rank_run'), `${name}: 変換中の Enter で②を送った`);
  await page.evaluate(() => document.getElementById('query').dispatchEvent(new CompositionEvent('compositionend')));
  await page.waitForTimeout(300);
  await page.press('#query', 'Enter'); await page.waitForTimeout(300);
  v = await rankView(page);
  check(v.rank.join() === '結果:しゅうのう', `${name}: 確定後の Enter で②を送らない`);
});
rankScenario('状態：②から③へ・③の実行中に入力を変える', { worker: mockWorker({ rank: b => ({ body: rankBody([row('結果:' + b.query)]) }), ai: () => ({ delay: 1200, body: { ...aiBody, comment: '答え' } }) }) }, async (page, name) => {
  await typeAndRun(page, 'A');
  await page.click('#ai-run'); await page.waitForTimeout(150);
  let v = await rankView(page);
  check(v.rank.length === 0 && v.rankStatus === '', `${name}: ③を始めても②の結果か文言が残る`);
  check(v.events.filter(e => e.event === 'not_found_ai_used').at(-1)?.after === 'rank_results', `${name}: ③の after が rank_results でない`);
  await page.fill('#query', 'B'); await page.waitForTimeout(1500);
  v = await rankView(page);
  check(!v.aiResult, `${name}: 入力を変えた後に古い③の応答を描いた`);
  check(v.rankStatus === '' && !v.ai && !v.area, `${name}: ③の後に入力を変えたとき stale と入力中の形にならない`);
});

rankScenario('状態：同じ語の Enter の連打で送り直さない', { worker: echo(() => 600) }, async (page, name) => {
  await page.fill('#query', 'A'); await page.waitForTimeout(150);
  for (let i = 0; i < 3; i++) { await page.press('#query', 'Enter'); await page.waitForTimeout(100); }
  await page.waitForTimeout(900);
  await page.press('#query', 'Enter'); await page.waitForTimeout(300);
  const v = await rankView(page);
  check(v.events.filter(e => e.event === 'not_found_rank_run').length === 1 && v.rank.join() === '結果:A', `${name}: 連打で②を送り直した（${v.events.filter(e => e.event === 'not_found_rank_run').length}回）`);
});
// 失敗の後は送り直せるので、キーの自動の繰り返し（フォームの暗黙の送信）で送り直さない
rankScenario('状態：失敗の後に Enter を押し続けても送り直さない', { worker: mockWorker({ rank: () => ({ status: 503, body: {} }) }) }, async (page, name) => {
  await page.fill('#query', 'A'); await page.waitForTimeout(150); await page.focus('#query');
  const cdp = await page.context().newCDPSession(page);
  const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' };
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key }); await page.waitForTimeout(200);
  for (let i = 0; i < 3; i++) { await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, autoRepeat: true }); await page.waitForTimeout(200); }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  const runs = (await rankView(page)).events.filter(e => e.event === 'not_found_rank_run').length;
  check(runs === 1, `${name}: 押し続けで②を送り直した（${runs}回）`);
  await page.press('#query', 'Enter'); await page.waitForTimeout(300);
  check((await rankView(page)).events.filter(e => e.event === 'not_found_rank_run').length === 2, `${name}: キーを離した後の Enter で送り直さない`);
});
// ②の到着で①を描き直しても、操作中のリンクのフォーカスを入力欄へ戻さない。②へ移ったページなら②の同じリンクへ
for (const [label, rows, expected] of [['①に残るリンク', [row('MAGI', '/magi/', 'page')], '#result-list'], ['②へ移るリンク', [row('PDF Studio')], '#rank-list']]) {
  rankScenario('表示：②の到着で' + label + 'のフォーカスを保つ', { worker: mockWorker({ rank: () => ({ delay: 1000, body: rankBody(rows) }) }) }, async (page, name) => {
    await typeAndRun(page, 'pdf', 200);
    await page.focus('#result-list a[href="/tools/pdf-studio/"]');
    await page.waitForFunction(() => document.querySelectorAll('#rank-list a').length > 0, null, { timeout: 3000 }).catch(() => {});
    const where = await page.evaluate(() => { const a = document.activeElement; return (a.closest('#result-list') ? '#result-list' : a.closest('#rank-list') ? '#rank-list' : '#' + a.id) + ' ' + (a.getAttribute('href') || ''); });
    check(where === expected + ' /tools/pdf-studio/', `${name}: フォーカスが PDF Studio に残らない（${where}）`);
  });
}
rankScenario('状態：入力のイベント無しで値が変わっても読み込み中のまま止まらない', { worker: echo(() => 800) }, async (page, name) => {
  await typeAndRun(page, 'A', 100);
  await page.evaluate(() => { document.getElementById('query').value = 'B'; }); // 自動入力などを模す（input イベント無し）
  await page.waitForTimeout(1200);
  const v = await rankView(page);
  check(v.rank.length === 0 && v.rankStatus === '', `${name}: 読み込み中のまま止まった、または古い応答を描いた（${v.rankStatus}）`);
});
rankScenario('状態：Worker が落とす文字だけの入力は送らない', { worker: echo(() => 0) }, async (page, name) => {
  await typeAndRun(page, '<<>>');
  check(!(await rankView(page)).events.some(e => e.event === 'not_found_rank_run'), `${name}: < > だけの入力で②を送った`);
});

// 連携と計測
rankScenario('連携：①から②のページを除き、入力の変更で戻す', { worker: mockWorker({ rank: () => ({ body: rankBody([row('PDF Studio')]) }), ai: () => ({ body: aiBody }) }) }, async (page, name) => {
  await page.fill('#query', 'pdf'); await page.waitForTimeout(300);
  const typing = await rankView(page);
  check(typing.suggest.includes('/tools/pdf-studio/'), `${name}: 入力中の候補に PDF Studio が無い（前提）`);
  check(!typing.keyword.length && !typing.area && !typing.ai, `${name}: 入力中にページへ結果か②・③を出している`);
  await page.press('#query', 'Enter'); await page.waitForTimeout(300);
  let v = await rankView(page);
  check(!v.keyword.includes('/tools/pdf-studio/'), `${name}: ②に出たページが①に残る`);
  check(/件見つかりました/.test(v.keywordStatus), `${name}: ①の件数の表示が消えた`);
  check(v.ai && v.aiQuiet, `${name}: 完全な結果で③が控えめに出ない`);
  await page.fill('#query', 'pdf '); await page.waitForTimeout(300);
  v = await rankView(page);
  check(v.rank.length === 1 && v.area && v.suggest.length === 0, `${name}: 前後の空白だけの違いで②の結果を消した`);
  await page.fill('#query', 'pd'); await page.waitForTimeout(300);
  v = await rankView(page);
  check(v.suggest.includes('/tools/pdf-studio/') && v.rank.length === 0 && !v.area, `${name}: 入力の変更で入力中の候補に戻らない`);
  await page.press('#query', 'Enter'); await page.waitForTimeout(300);
  v = await rankView(page);
  check(v.rank.length === 1 && !v.keyword.includes('/tools/pdf-studio/') && v.ai, `${name}: 検索し直すと②・①・③がそろわない`);
});
rankScenario('計測：①が0件で②を送る前は③を出さず、検索ボタンを目立たせる', { worker: echo(() => 0) }, async (page, name) => {
  await page.fill('#query', MARK + 'なし'); await page.waitForTimeout(300);
  const v = await rankView(page);
  check(!v.ai, `${name}: ②を送る前に③が出る`);
  const note = await page.evaluate(() => { const e = document.querySelector('#suggest-list:not([hidden]) .suggest-note'); return e ? e.textContent : ''; });
  check(/Enter で、意味の近いページを探します/.test(note), `${name}: 候補の欄に Enter への案内が出ない（${note}）`);
  check(await page.evaluate(() => document.getElementById('search-submit').classList.contains('is-suggested')), `${name}: 検索ボタンが目立たない`);
  await page.press('#query', 'Enter'); await page.waitForTimeout(300);
  const run = (await rankView(page)).events.find(e => e.event === 'not_found_rank_run');
  check(run && run.keyword_state === 'known' && run.keyword_count === 0, `${name}: rank_run の keyword_state・keyword_count が違う（${JSON.stringify(run)}）`);
  // 検索語は search_term にだけ載る（PRD 8.3）
  const ev = (await rankView(page)).events;
  check(!JSON.stringify(ev.map(({ search_term, ...rest }) => rest)).includes(MARK), `${name}: search_term 以外の計測の値に検索語が載る`);
  check(ev.find(e => e.event === 'not_found_rank_run')?.search_term === MARK + 'なし', `${name}: rank_run に search_term が付かない`);
});
for (const [label, mode, expected] of [['読み込み中', 'slow', 'loading'], ['一部失敗', 'fail', 'failed']]) {
  rankScenario('計測：①が' + label + 'の keyword_state', { worker: echo(() => 0), lists: mode }, async (page, name) => {
    await page.fill('#query', 'pdf'); await page.waitForTimeout(150); await page.press('#query', 'Enter'); await page.waitForTimeout(300);
    const run = (await rankView(page)).events.find(e => e.event === 'not_found_rank_run');
    check(run && run.keyword_state === expected && !('keyword_count' in run), `${name}: keyword_state が ${expected} でない、または件数が付く（${JSON.stringify(run)}）`);
  });
}
rankScenario('停止：disabled なら検索ボタンと②の欄を隠し、いまの動きに戻る', { worker: mockWorker({ rank: () => ({ body: { request_id: 'x', status: 'failed', complete: false, reason: 'disabled', searched: null, results: [] } }), ai: () => ({ body: aiBody }) }) }, async (page, name) => {
  await typeAndRun(page, MARK + 'なし');
  const v = await rankView(page);
  check(v.state === 'off' && v.rankStatus === '', `${name}: 検索ボタンか②の文言が残る`);
  check(v.ai && !v.aiQuiet, `${name}: ①が0件で③が出ない（いまの動き）`);
  check(await page.evaluate(() => document.getElementById('rank-info-text').hidden), `${name}: ダイアログに②の説明が残る`);
  check(await page.locator('#search-info-open').isVisible(), `${name}: ②を止めるとインフォメーションマークまで消える`);
});

// 本番の Worker で②を1回だけ送る（--base のときだけ。Jev を1回呼ぶ。評価セット・smoke と重ねない語）
if (remote) rankScenario('本番の Worker で検索する', { worker: route => route.continue() }, async (page, name) => {
  await page.fill('#query', '書類のPDFをひとつにまとめる'); await page.waitForTimeout(150); await page.press('#query', 'Enter');
  await page.waitForFunction(() => !['', '意味の近いページを探しています…'].includes(document.getElementById('rank-status').textContent), null, { timeout: 10000 }).catch(() => {});
  const v = await rankView(page);
  check(v.rankHrefs.includes('/tools/pdf-studio/'), `${name}: PDF Studio が②に出ない（${v.rankStatus}／${v.rankHrefs.join('・')}）`);
});

// 表示：日英・暗い配色・320px・キーボード・読み上げの状態の行
rankScenario('表示：英語', { locale: 'en-US', worker: echo(() => 0) }, async (page, name) => {
  await typeAndRun(page, 'pdf');
  const t = await page.evaluate(() => ({ heading: document.getElementById('rank-heading').textContent, button: document.getElementById('search-submit').getAttribute('aria-label'), status: document.getElementById('rank-status').textContent }));
  check(t.heading === 'Results' && t.button === 'Search' && /related page/.test(t.status), `${name}: 英語の文言でない（${JSON.stringify(t)}）`);
});
rankScenario('表示：幅320px・暗い配色で横にはみ出さない', { viewport: { width: 320, height: 800 }, colorScheme: 'dark', worker: echo(() => 0) }, async (page, name) => {
  await typeAndRun(page, 'とても長い検索語'.repeat(10));
  const w = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  check(w.scroll <= w.client, `${name}: 横にはみ出す（${w.scroll} > ${w.client}）`);
});
rankScenario('表示：キーボードだけで②・①を行き来し、状態の行が読み上げられる', { worker: mockWorker({ rank: () => ({ body: rankBody([row('ページ1', '/magi/', 'page'), row('ページ2', '/dj/', 'page')]) }) }) }, async (page, name) => {
  await page.focus('#query'); await page.keyboard.type('pdf'); await page.waitForTimeout(200);
  await page.keyboard.press('Enter'); await page.waitForTimeout(300);
  const focused = () => page.evaluate(() => document.activeElement && (document.activeElement.getAttribute('href') || document.activeElement.id));
  check(await focused() === 'query', `${name}: ②の後にフォーカスが入力欄から動いた`);
  await page.keyboard.press('ArrowDown'); check(await focused() === '/magi/', `${name}: ↓で②の先頭へ移らない`);
  await page.keyboard.press('ArrowDown'); check(await focused() === '/dj/', `${name}: ②の中を↓で移れない`);
  await page.keyboard.press('ArrowDown'); check(await focused() === '/tools/pdf-studio/', `${name}: ②の末尾の↓で①の先頭へ移らない`);
  await page.keyboard.press('Escape'); check(await focused() === 'query', `${name}: Esc で入力欄へ戻らない`);
  const role = await page.evaluate(() => { const el = document.getElementById('rank-status'); return el.getAttribute('role') + ':' + (el.closest('[hidden]') ? 'hidden' : 'shown'); });
  check(role === 'status:shown', `${name}: ②の状態の行が role="status" で常にある状態でない（${role}）`);
});

// 入力中の候補（検索欄の下のドロップダウン。Google などと同じ操作）
scenario('404 の入力中の候補：↑↓・Enter・Esc・外を押す', {}, async (page, name) => {
  await page.goto(BASE + '/no-such-page/'); await settle(page);
  await page.focus('#query'); await page.keyboard.type('pdf'); await page.waitForTimeout(300);
  const view = () => page.evaluate(() => {
    const q = document.getElementById('query'), list = document.getElementById('suggest-list');
    return { open: !list.hidden, expanded: q.getAttribute('aria-expanded'), active: q.getAttribute('aria-activedescendant'),
      selected: [...list.querySelectorAll('[aria-selected="true"]')].map(e => e.id), results: !document.getElementById('results').hidden,
      daily: !document.getElementById('daily-search').hidden, hrefs: [...list.querySelectorAll('[role="option"] a')].map(a => a.getAttribute('href')) };
  });
  let v = await view();
  check(v.open && v.expanded === 'true' && v.hrefs.includes('/tools/pdf-studio/'), `${name}: 入力中に候補のドロップダウンが開かない（${JSON.stringify(v)}）`);
  check(!v.results && !v.daily, `${name}: 入力中にページへ結果か日刊ブリーフの欄を出している`);
  await page.keyboard.press('ArrowDown'); v = await view();
  check(v.active === 'suggest-0' && v.selected.join() === 'suggest-0', `${name}: ↓で先頭の候補を選ばない（${JSON.stringify(v)}）`);
  await page.keyboard.press('ArrowUp'); v = await view();
  check(!v.active && !v.selected.length, `${name}: 先頭で↑を押すと入力に戻らない`);
  await page.keyboard.press('Escape'); v = await view();
  check(!v.open && v.expanded === 'false', `${name}: Esc で閉じない`);
  await page.keyboard.press('ArrowDown'); v = await view();
  check(v.open && v.active === 'suggest-0', `${name}: 閉じた後の↓で開き直さない`);
  await page.mouse.click(5, 5); v = await view();
  check(!v.open, `${name}: 外を押しても閉じない`);
  await page.focus('#query'); await page.keyboard.press('ArrowDown');
  const target = (await view()).hrefs[0];
  await Promise.all([page.waitForURL(u => u.pathname === target), page.keyboard.press('Enter')]);
  // クリックの計測は、移動を止めて確かめる
  await page.goto(BASE + '/no-such-page/'); await settle(page);
  await page.fill('#query', 'pdf'); await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector('#suggest-list a').addEventListener('click', e => e.preventDefault()));
  await page.click('#suggest-list a');
  const mode = await page.evaluate(() => (window.dataLayer || []).filter(e => e && e.event === 'not_found_result_click').map(e => e.mode + ':' + e.position).join());
  check(mode === 'suggest:1', `${name}: 候補のクリックの計測が mode=suggest でない（${mode}）`);
});

// 変換中（未確定の文字）でも候補を出す。計測・②は確定まで送らない（CDP で IME の入力を再現する）
scenario('404 の入力中の候補：日本語の変換中', {}, async (page, name) => {
  await page.goto(BASE + '/no-such-page/'); await settle(page);
  await page.focus('#query');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'ツール', selectionStart: 3, selectionEnd: 3 });
  await page.waitForTimeout(1800);
  const v = await page.evaluate(() => ({ value: document.getElementById('query').value, open: !document.getElementById('suggest-list').hidden,
    options: document.querySelectorAll('#suggest-list [role="option"]').length,
    events: (window.dataLayer || []).filter(e => e && /^not_found_(keyword_count|rank_run)$/.test(e.event)).map(e => e.event) }));
  check(v.value === 'ツール' && v.open && v.options > 0, `${name}: 変換中に候補が出ない（${JSON.stringify(v)}）`);
  check(!v.events.length, `${name}: 変換中に計測か②を送った（${v.events.join('・')}）`);
  await cdp.send('Input.insertText', { text: 'ツール' }); // 確定
  await page.waitForTimeout(1800);
  const after = await page.evaluate(() => ({ open: !document.getElementById('suggest-list').hidden,
    events: (window.dataLayer || []).filter(e => e && e.event === 'not_found_keyword_count').length }));
  check(after.open && after.events === 1, `${name}: 確定後に候補か計測が続かない（${JSON.stringify(after)}）`);
});

// 変換を確定した Enter を押し続けても検索しない（キーの自動の繰り返しは、フォームの暗黙の送信を起こす）
scenario('404 の検索：変換を確定した Enter の押し続けで検索しない', {}, async (page, name) => {
  await page.goto(BASE + '/no-such-page/'); await settle(page);
  await page.fill('#query', 'しゅうのう'); await page.waitForTimeout(150);
  // 確定の Enter（変換中の keydown）を模す
  await page.evaluate(() => document.getElementById('query').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, isComposing: true })));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, autoRepeat: true, text: '\r' });
  await page.waitForTimeout(300);
  const held = await page.evaluate(() => ({ searched: !document.getElementById('daily-search').hidden,
    run: (window.dataLayer || []).some(e => e && e.event === 'not_found_rank_run') }));
  check(!held.searched && !held.run, `${name}: 押し続けの Enter で検索した（${JSON.stringify(held)}）`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await page.press('#query', 'Enter'); await page.waitForTimeout(300);
  check(await page.locator('#daily-search').isVisible(), `${name}: キーを離した後の Enter で検索しない`);
});

for (const { name, options, fn } of scenarios) {
  const { context, log } = await newContext(options);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  try { await fn(page, name); } catch (e) { failures.push(`${name}: ${e.message.split('\n')[0]}`); }
  checkLog(name, log);
  allRequests.push(...log);
  for (const e of errors) failures.push(`${name}: ページのエラー ${e}`);
  const mark = skipped.includes(name) ? 'skip' : failures.some(f => f.startsWith(name + ':') || f.startsWith(name + '（')) ? 'NG' : 'ok';
  console.log(`${mark}  ${name}（外への通信 ${log.length}件）`);
  await context.close();
}
await browser.close();
server?.close();

console.log(`\n計測のスクリプト：読み込めた ${[...analyticsLoaded].join('・') || 'なし'}／読み込めなかった ${[...analyticsFailed].join('・') || 'なし'}`);
const hosts = new Map();
for (const r of allRequests) { const h = new URL(r.url).host + (r.url.startsWith(BASE + '/cdn-cgi/') ? new URL(r.url).pathname : ''); hosts.set(h, (hosts.get(h) || 0) + 1); }
console.log('止めた外への通信：' + ([...hosts].map(([h, n]) => `${h} ${n}件`).join('・') || 'なし'));
const events = new Set();
for (const r of allRequests) for (const text of [r.url, r.body || '']) for (const m of text.matchAll(/(?:^|[?&\n])en=([^&\s]+)/g)) events.add(decodeURIComponent(m[1]));
console.log('GA4 のイベント：' + ([...events].sort().join('・') || 'なし'));
const terms = allRequests.flatMap(r => [r.url, r.body || ''].flatMap(t => [...t.matchAll(/(?:^|[?&\n])ep\.search_term=([^&\n]*)/g)].map(m => { try { return decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch (_) { return m[1]; } })));
console.log(`GA4 の search_term：${terms.length}件（例：${[...new Set(terms)].slice(0, 3).join('／') || 'なし'}）`);
for (const e of ['not_found_keyword_count', 'not_found_search_used', 'not_found_rank_run', 'daily_search']) console.log(`  ${e}：GA4 へ${events.has(e) ? '送った' : '送っていない'}`);
if (!analyticsLoaded.size) console.log('注意：計測のスクリプトを読み込めなかったので、計測が送るはずの通信は確かめられていない（手元の見当。合否は本番の URL で決める）');
if (skipped.length) console.log(`②が出ていないので飛ばした場面：${skipped.length}件`);
if (failures.length) { console.log('\n' + failures.map(f => '- ' + f).join('\n')); process.exit(1); }
console.log('画面の検証：すべて通った');
