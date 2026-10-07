// サイト内検索の画面の検証（assets/site-search-design.md 10.3）。手元の Playwright で動かす。
//   node .github/scripts/test-site-search-ui.mjs [--root _site]
// 先に `bash build.sh` で _site を作る（--root . ならリポジトリをそのまま出す）。存在しないパスには 404.html を 404 で返す。
// いまあるのは URL の部分（PRD 6.1。計画書 T4.8）：目印の検索語が、外へ出る通信（URL と本文）・location・移った先の
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
const root = resolve(repo, option('--root', '_site'));
if (!existsSync(join(root, '404.html'))) {
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
const server = await serve();
const BASE = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const failures = [];
const analyticsLoaded = new Set(), analyticsFailed = new Set();
const check = (ok, message) => { if (!ok) failures.push(message); };
const marked = s => typeof s === 'string' && s.toLowerCase().includes(MARK);

// 外への通信の記録。手元のサーバーへの要求（目印を URL に入れて開くものを含む）は数えない
async function newContext({ js = true, analyticsOff = false, worker = null } = {}) {
  const context = await browser.newContext({ javaScriptEnabled: js, locale: 'ja-JP' });
  const log = [];
  if (analyticsOff) await context.addInitScript(() => { try { localStorage.setItem('st-analytics', 'off'); } catch (_) {} });
  await context.route('**/*', async route => {
    const req = route.request(), url = req.url();
    if (url.startsWith(BASE + '/')) return route.continue();
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

function checkLog(name, log) {
  for (const r of log) {
    if (r.search) {
      check(!marked(r.url), `${name}: 検索の Worker への URL に目印がある（${r.url}）`);
      check(!marked(r.referer), `${name}: 検索の Worker への参照元に目印がある`);
      continue;
    }
    check(!marked(r.url), `${name}: 外への通信の URL に目印がある（${r.url.slice(0, 160)}）`);
    check(!marked(r.body), `${name}: 外への通信の本文に目印がある（${r.url.slice(0, 160)}）`);
    check(!marked(r.referer), `${name}: 外への通信の参照元に目印がある（${r.url.slice(0, 160)}）`);
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
const PORTAL = '/job/nitoridaily/';
async function anyIssue(page) {
  await page.goto(BASE + PORTAL); await settle(page);
  return page.locator('[data-archive-month] a').first().getAttribute('href').then(h => new URL(h, BASE + PORTAL).pathname);
}

scenario('404 → 日刊（①の下の「日刊ブリーフで探す」）', {}, async (page, name) => {
  await page.goto(BASE + '/no-such-page/'); await settle(page);
  await page.fill('#query', QUERY);
  const link = page.locator('#nitori-search');
  await link.waitFor({ state: 'visible' });
  await Promise.all([page.waitForURL(u => u.pathname === PORTAL), link.click()]);
  await settle(page);
  check(await portalInput(page) === QUERY, `${name}: ポータルの横断検索に検索語が入らない`);
  await checkLocation(name, page);
  await leaveToIssue(name, page);
});

scenario('404 → ③ → 日刊のリンク', {
  worker: route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ request_id: 'local', status: 'results', comment: null,
      results: [{ id: 'tool:7', kind: 'tool', title: 'PDF Studio', description: 'PDF', url: '/tools/pdf-studio/' }],
      daily: { media: 'nitori', query: MARK + ' 出店', url: '/job/nitoridaily/?q=' + encodeURIComponent(MARK + ' 出店') + '#archiveSearch' } }) }),
}, async (page, name) => {
  await page.goto(BASE + '/no-such-page/'); await settle(page);
  await page.fill('#query', MARK + 'zz');
  await page.locator('#ai-run').waitFor({ state: 'visible' });
  await page.click('#ai-run');
  const link = page.locator('#ai-daily');
  await link.waitFor({ state: 'visible' });
  check(/^\/job\/nitoridaily\/#q=/.test(await link.getAttribute('href')), `${name}: 古い形の日刊リンクが #q= に直っていない`);
  await Promise.all([page.waitForURL(u => u.pathname === PORTAL), link.click()]);
  await settle(page);
  check(await portalInput(page) === MARK + ' 出店', `${name}: ポータルの横断検索に検索語が入らない`);
  await checkLocation(name, page);
  await leaveToIssue(name, page);
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

for (const { name, options, fn } of scenarios) {
  const { context, log } = await newContext(options);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  try { await fn(page, name); } catch (e) { failures.push(`${name}: ${e.message.split('\n')[0]}`); }
  checkLog(name, log);
  for (const e of errors) failures.push(`${name}: ページのエラー ${e}`);
  console.log(`${failures.some(f => f.startsWith(name + ':') || f.startsWith(name + '（')) ? 'NG' : 'ok'}  ${name}（外への通信 ${log.length}件）`);
  await context.close();
}
await browser.close();
server.close();

console.log(`\n計測のスクリプト：読み込めた ${[...analyticsLoaded].join('・') || 'なし'}／読み込めなかった ${[...analyticsFailed].join('・') || 'なし'}`);
if (!analyticsLoaded.size) console.log('注意：計測のスクリプトを読み込めなかったので、計測が送るはずの通信は確かめられていない（手元の見当。合否は本番の URL で決める）');
if (failures.length) { console.log('\n' + failures.map(f => '- ' + f).join('\n')); process.exit(1); }
console.log('URL の検証：すべて通った');
