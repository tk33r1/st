// MAGI2 の入力・所有権・ストリーム・会話切り替えの回帰検証。外部 API は呼ばない。
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { createServer } from 'node:http';
import vm from 'node:vm';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = p => readFileSync(join(root, p), 'utf8');
const mobile = read('magi-app/www/app.js');
const home = read('index.html');
const dj = read('dj/request/index.html');
const between = (s, start, end) => s.slice(s.indexOf(start), s.indexOf(end, s.indexOf(start)));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const tick = () => new Promise(r => setImmediate(r));
const encode = s => new TextEncoder().encode(s);
const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const completion = (text = 'answer', reason = 'stop', done = true) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`
  + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })}\n\n`
  + (done ? 'data: [DONE]\n\n' : '');

// upstream を渡すと、上流（各社の API・Resend）への fetch をそれで置き換えられる（undefined を返せば既定の応答）
function worker(stream = completion(), upstream = null) {
  const calls = [], waits = [];
  const cards = JSON.parse(read('data/magi-context.json'));
  const ctx = vm.createContext({
    aiModels: JSON.parse(read('config/ai-models.json')), bundledContext: cards,
    Request, Response, ReadableStream, TextEncoder, TextDecoder, AbortController, URL,
    crypto: webcrypto, setTimeout, clearTimeout, console: { log() {} },
    fetch: async (url, options) => {
      if (url === 'https://tk.st/data/magi-context.json') return Response.json(cards);
      const replaced = upstream && await upstream(url, options);
      if (replaced) return replaced;
      if (/^https:\/\/tk\.st\/data\/(tools|game|glitch|site-search)\.json$/.test(url)) return Response.json(JSON.parse(read('data/' + url.split('/').at(-1))));
      const body = JSON.parse(options.body); calls.push(body);
      if (body.response_format?.type === 'json_schema') return Response.json({ choices: [{ message: { content: JSON.stringify({ selections: ['tool:7'], ...(body.response_format.json_schema.name === 'site_search' ? { comment: 'PDF Studioでまとめられます。' } : {}), daily: null }) }, finish_reason: 'stop' }] });
      return body.stream ? new Response(stream) : Response.json({ choices: [{ message: { content: 'opinion' }, finish_reason: 'stop' }] });
    },
  });
  const strip = s => s.replace(/^import .*;\r?\n/gm, '').replace(/export const /g, 'const ').replace(/export (?=(?:async )?function)/g, '');
  vm.runInContext(strip(read('workers/magi2/languages.js')) + '\n' + strip(read('workers/magi2/personas.js')) + '\n'
    + strip(read('workers/magi2/classification.js')) + '\n'
    + strip(read('workers/magi2/site-search.js')) + '\n'
    + strip(read('workers/magi2/src/index.js')).replace('export default {', 'globalThis.worker = {')
    + '\nglobalThis.defaults = DEFAULTS; globalThis.searchConfig = SITE_SEARCH; globalThis.searchCache = cache;', ctx);
  const env = { MAGI_OPENAI_API_KEY: 'test', MAGI_DEEPSEEK_API_KEY: 'test', MAGI_GEMINI_API_KEY: 'test' };
  const request = async (path, body, ip = '192.0.2.1', headers = {}) => {
    const res = await ctx.worker.fetch(new Request('https://workers.tk.st' + path, {
      method: 'POST', headers: { Origin: 'https://tk.st', 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }), env, { waitUntil(p) { waits.push(p); } });
    return res;
  };
  return { ctx, env, calls, waits, request, chat: messages => request('/magi2/chat', { messages }) };
}

// 実際の SQLite で D1 の SQL と移行を検証する。各呼び出しは同じ一時 DB を使う。
const bridge = `import sqlite3,json,sys
c=sqlite3.connect(sys.argv[1]); c.row_factory=sqlite3.Row
sql,args=json.loads(sys.argv[2])
if args is None:
 c.executescript(sql); result=None
else:
 cur=c.execute(sql,args); row=cur.fetchone() if cur.description else None
 result={'row':dict(row) if row else None,'changes':max(cur.rowcount,0)}
c.commit(); c.close(); print(json.dumps(result))`;
function sqlite(file, sql, args = null) {
  const p = spawnSync('python', ['-B', '-c', bridge, file, JSON.stringify([sql, args])], { encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr);
  return JSON.parse(p.stdout);
}
function database(file) {
  sqlite(file, read('workers/magi2/schema.sql'));
  return { prepare(sql) { let args; return {
    bind(...values) { args = values; return this; },
    async first() { return sqlite(file, sql, args).row; },
    async run() { return { meta: { changes: sqlite(file, sql, args).changes } }; },
  }; } };
}

// 同時実行や上限の順序を速く確認するD1代替。SQL自体は上の実SQLiteでも検証する。
function counts() {
  const rows = new Map();
  return { rows, prepare(sql) { let args; return {
    bind(...values) { args = values; return this; },
    async first() {
      assert.match(sql, /RETURNING count/);
      const [key, day, limit] = args, id = key + '|' + day, count = rows.get(id) || 0;
      if (count >= limit) return null;
      rows.set(id, count + 1); return { count: count + 1 };
    },
    async run() { if (sql.startsWith('DELETE')) rows.delete(args.join('|')); return { meta: { changes: 1 } }; },
  }; } };
}
function enableSearch(w) { w.env.SITE_SEARCH_ENABLED = 'true'; w.env.DB = counts(); return w; }
const searchRequest = (w, body = { query: 'PDFをまとめたい', locale: 'ja' }, ip) => w.request('/magi2/site-search?site_debate=1', body, ip);
const searchReply = (value, finish = 'stop', refusal = null) => Response.json({ choices: [{ finish_reason: finish, message: { content: typeof value === 'string' ? value : JSON.stringify(value), refusal } }] });
const validSearch = { selections: ['tool:7'], comment: '私のPDF Studioでまとめられます。(>_<)', daily: null };

test('公開ページ一覧から曲リクエストを404とチャットで案内し、送った候補以外のIDは採用しない', async () => {
  for (const chat of [false, true]) {
    const w = enableSearch(worker(undefined, (_, o) => {
      if (!o?.body) return;
      const body = JSON.parse(o.body);
      if (!body.response_format) return;
      const system = body.messages[0].content;
      assert.ok(system.includes('page:/dj/request/'));
      assert.ok(!system.includes('page:/dj/booth/'));
      assert.ok(!system.includes('page:/dj/schedule/'));
      return searchReply({ selections: ['page:/dj/request/'], daily: null });
    }));
    if (chat) {
      const res = await w.request('/magi2/chat', { site_pages: true, messages: [{ role: 'user', content: '曲のリクエスト' }] });
      const text = await res.text(); assert.match(text, /event: pages/); assert.ok(text.includes('https://tk.st/dj/request/'));
    } else {
      const res = await searchRequest(w, { query: '曲のリクエスト', locale: 'ja' });
      assert.equal(res.status, 200); assert.equal((await res.json()).results[0].url, '/dj/request/');
    }
  }
});

test('索引の不正な行と重複は飛ばし、全部不正なら拒否し、ページ数が増えてもAI候補の件数・文字数を守る', () => {
  const w = worker(), data = JSON.parse(read('data/site-search.json'));
  for (const url of ['//outside.test/', '/a/?q=x', '/a/#x', '/%2e%2e/b/', '/a/%5cfoo/', '/a/%0afoo/', '/a/%ZZ/']) {
    assert.throws(() => w.ctx.makeSitePages({ version: 1, pages: [{ ...data.pages[0], url }] }), url);
    assert.equal(w.ctx.makeSitePages({ version: 1, pages: [{ ...data.pages[0], url }, data.pages[1]] }).length, 1, url);
  }
  assert.throws(() => w.ctx.makeSitePages({ version: 1, pages: [{ ...data.pages[0], title_en: 5 }] }));
  assert.equal(w.ctx.makeSitePages({ ...data, pages: [...data.pages, data.pages[0]] }).length, data.pages.length);
  const pages = w.ctx.makeSitePages(data);
  const many = Array.from({ length: 2000 }, (_, n) => ({ id: 'page:issue-' + n, kind: 'page', title: '日刊のニュース ' + n,
    description: '', detail: '日刊のニュース', url: '/job/nitoridaily/' + (20200000 + n) + '/' }));
  const shortlist = w.ctx.shortlistSitePages([...many, ...pages], '曲のリクエスト');
  assert.ok(shortlist.some(p => p.url === '/dj/request/'));
  assert.ok(shortlist.some(p => p.url === '/job/nitoridaily/'));
  assert.ok(shortlist.some(p => p.url === '/job/retailtechdaily/'));
  assert.ok(pages.filter(p => p.hub).every(h => shortlist.some(p => p.id === h.id)));
  assert.ok(shortlist.filter(p => /^[/]job[/]nitoridaily[/][0-9]{8}[/]$/.test(p.url)).length <= w.ctx.searchConfig.candidate_issue_limit);
  assert.ok(shortlist.length <= w.ctx.searchConfig.candidate_limit);
  const candidateLine = vm.runInContext('candidateLine', w.ctx);
  assert.ok(shortlist.map(p => candidateLine(p) + '\n').join('').length <= w.ctx.searchConfig.candidate_max_chars);
  const omitted = many.find(p => !shortlist.some(x => x.id === p.id));
  assert.throws(() => w.ctx.validateSiteChoice({ selections: [omitted.id], comment: '案内', daily: null }, shortlist, 'ja'));
});

test('英語の機能語では点を付けず、英数字は語単位で照合する', () => {
  const w = worker(), pages = w.ctx.makeSitePages(JSON.parse(read('data/site-search.json')));
  const issues = Array.from({ length: 700 }, (_, n) => ({ id: 'page:issue-' + n, kind: 'page', title: 'Nitori Daily ' + n + ' is a news issue',
    description: '', detail: 'Nitori Daily', url: '/job/nitoridaily/' + (20200000 + n) + '/' }));
  for (const [query, url] of [['Is there a tool to make a QR code?', '/tools/qr-palette/'], ['How do I get in touch?', '/contact/'], ['contact the owner', '/contact/']]) {
    const shortlist = w.ctx.shortlistSitePages([...issues, ...pages], query);
    assert.ok(shortlist.slice(0, 15).some(p => p.url === url), query);
    assert.ok(shortlist.filter(p => p.id.startsWith('page:issue-')).length <= w.ctx.searchConfig.candidate_issue_limit, query);
  }
});

test('英語の画面では主な入口を英語名で返し、検査済みの一覧をキャッシュする', async () => {
  const w = enableSearch(worker());
  const en = await w.ctx.getSitePages({ waitUntil() {} }, 'en'), ja = await w.ctx.getSitePages({ waitUntil() {} }, 'ja');
  assert.equal(en.find(p => p.url === '/job/').title, 'Career'); assert.equal(ja.find(p => p.url === '/job/').title, '職務');
  assert.equal(en.find(p => p.url === '/contact/').title, 'Contact');
  assert.equal(await w.ctx.getSitePages({ waitUntil() {} }, 'en'), en);
});

test('出力言語は混在文を日本語に固定せず、記号や短い返答では直前の言語を維持する', () => {
  const w = worker();
  const ja = vm.runInContext('REPLY_LANGUAGE.ja', w.ctx);
  const note = vm.runInContext('REPLY_LANGUAGE.note', w.ctx);
  const user = content => ({ role: 'user', content });
  for (const text of ['個人情報保護方針について教えて', 'この曲はどうですか？', 'ｺﾉｷｮｸﾊﾄﾞｳ？']) {
    assert.equal(w.ctx.replyLanguageNote([user(text)]), ja);
  }
  for (const text of ['What do you think of サカナクション?', 'What does 「こんにちは」 mean in English?',
    'Which sounds better: jazz・funk or house?', 'Ｗｈｙ サカナクション？', 'Что вы думаете о サカナクション?',
    'PDFを結合する方法は？', '你好', '안녕하세요']) {
    assert.equal(w.ctx.replyLanguageNote([user(text)]), note(text));
  }
  const english = user('What do you think of Daft Punk?');
  for (const text of ['・', 'ー', 'ーー', 'ｰ', 'ﾞﾟ', '😀', '?', 'OK', 'Daft Punk?', 'あ']) {
    assert.equal(w.ctx.replyLanguageNote([english, { role: 'assistant', content: '日本語の回答' }, user(text)]), note(english.content));
    assert.equal(w.ctx.replyLanguageNote([user('この曲はどうですか？'), user(text)]), ja);
    assert.equal(w.ctx.replyLanguageNote([user(text)]), null);
  }
});

test('全人格・統合・タイトル・予測へ同じ言語指定を渡し、日本語の状況説明で上書きしない', async () => {
  for (const text of ['What do you think of サカナクション?', 'この曲はどうですか？']) {
    const w = worker();
    const note = text.startsWith('What') ? vm.runInContext('REPLY_LANGUAGE.note', w.ctx)(text) : vm.runInContext('REPLY_LANGUAGE.ja', w.ctx);
    const res = await w.request('/magi2/chat', { messages: [{ role: 'user', content: text }], suggest: true,
      context: '選曲の相談です。状況説明は日本語ですが、ユーザーの発言ではありません。' });
    assert.match(await res.text(), /event: done/);
    assert.equal(w.calls.length, 9); // R1とR2の各3人格、統合、タイトル、予測
    for (const call of w.calls) assert.ok(call.messages.some(m => typeof m.content === 'string' && m.content.includes(note)));
  }
});

test('検索は認可・入力・フラグ・DB・完全な一覧を確認してから回数とAIを使う', async () => {
  const w = enableSearch(worker());
  for (const body of ['{', null, {}, { query: '', locale: 'ja' }, { query: '\u0000\u0001', locale: 'ja' }, { query: 'x'.repeat(201), locale: 'ja' }, { query: 'q', locale: 'fr' }, { query: 'q', locale: 'ja', model: 'other' }]) {
    assert.equal((await searchRequest(w, body)).status, 400);
  }
  assert.equal((await searchRequest(w, JSON.stringify({ query: 'q', locale: 'ja' }) + ' '.repeat(4096))).status, 413);
  assert.equal((await w.request('/magi2/site-search?site_debate=1', '{}', undefined, { 'Content-Type': 'text/plain' })).status, 400);
  assert.equal((await w.request('/magi2/site-search?site_debate=1', '{}', undefined, { Origin: 'https://outside.example' })).status, 401);
  w.env.SITE_SEARCH_ENABLED = 'false'; assert.equal((await searchRequest(w)).status, 503);
  assert.equal(w.calls.length, 0); assert.equal(w.env.DB.rows.size, 0);
  w.env.SITE_SEARCH_ENABLED = 'true'; const db = w.env.DB; delete w.env.DB;
  assert.equal((await searchRequest(w)).status, 503); w.env.DB = db;
  const broken = enableSearch(worker(undefined, url => url.endsWith('/site-search.json') ? Response.json({}) : undefined));
  assert.equal((await searchRequest(broken)).status, 503); assert.equal(broken.env.DB.rows.size, 0); assert.equal(broken.calls.length, 0);
  const res = await searchRequest(w), body = await res.json();
  assert.equal(res.status, 200); assert.equal(res.headers.get('Cache-Control'), 'no-store'); assert.ok(body.request_id);
  assert.equal(body.results[0].title, 'PDF Studio'); assert.equal(body.results[0].url, '/tools/pdf-studio/');
  const call = w.calls.find(c => c.response_format); assert.equal(call.max_completion_tokens, 120); assert.equal(call.temperature, .4);
  assert.equal(call.reasoning_effort, 'none'); assert.equal(call.response_format.json_schema.strict, true);
});

test('検索のIP上限を超えた要求は全体を進めず、通常チャットとは別に数える', async () => {
  const w = enableSearch(worker()), day = new Date().toISOString().slice(0, 10);
  const responses = await Promise.all(Array.from({ length: 14 }, () => searchRequest(w)));
  assert.equal(responses.filter(r => r.status === 200).length, 10);
  assert.equal(responses.filter(r => r.status === 429).length, 4);
  assert.equal(w.env.DB.rows.get('search:global|' + day), 10);
  assert.equal(w.env.DB.rows.get('search:192.0.2.1|' + day), 10);
  assert.equal(w.calls.length, 80); assert.equal(w.env.DB.rows.has('global|' + day), false);
  assert.match(await (await w.chat([{ role: 'user', content: 'q' }])).text(), /event: done/);
  assert.equal(w.env.DB.rows.get('global|' + day), 1); assert.equal(w.env.DB.rows.get('search:global|' + day), 10);
  w.ctx.searchConfig.global_daily_limit = 10;
  assert.equal((await searchRequest(w, undefined, '192.0.2.2')).status, 429);
  assert.equal(w.env.DB.rows.get('search:192.0.2.2|' + day), 1);
  assert.equal(w.env.DB.rows.get('search:global|' + day), 10);
});

test('AIの未知ID・日刊の不正値・コメントの記号を検証し、実在するURLだけを作る', () => {
  const w = worker(), pages = w.ctx.makeSitePages(JSON.parse(read('data/site-search.json')));
  assert.equal(pages.length, JSON.parse(read('data/site-search.json')).pages.length);
  assert.ok(pages.some(p => p.url === '/dj/request/'));
  assert.ok(!pages.some(p => ['/dj/booth/', '/dj/schedule/'].includes(p.url)));
  assert.throws(() => w.ctx.validateSiteChoice({ ...validSearch, selections: ['tool:missing'] }, pages, 'ja'));
  const mixed = w.ctx.validateSiteChoice({ ...validSearch, selections: ['tool:7', 'tool:missing'] }, pages, 'ja');
  assert.equal(mixed.results.length, 1); assert.equal(mixed.comment, null);
  assert.ok(w.ctx.validateSiteChoice(validSearch, pages, 'ja').comment.includes('(>_<)'));
  for (const comment of ['https://outside.example', '<script>', 'www.fake.test', 'x'.repeat(121), 'link](path)', '`code`']) assert.equal(w.ctx.validateSiteChoice({ ...validSearch, comment }, pages, 'ja').comment, null);
  for (const daily of [{ media: 'other', query: 'AI' }, { media: 'nitori', query: 'ニトリ出店' }, { media: 'retail', query: 'x' }, { media: 'retail', query: 'https://x.y' }, { media: 'nitori', query: '<xx>' }, {}]) {
    const r = w.ctx.validateSiteChoice({ ...validSearch, daily }, pages, 'ja'); assert.equal(r.daily, null); assert.equal(r.comment, null); assert.equal(r.results.length, 1);
  }
  const daily = w.ctx.validateSiteChoice({ selections: [], comment: 'ニュースです', daily: { media: 'retail', query: ' ＡＩ ' } }, pages, 'en');
  assert.equal(daily.status, 'results'); assert.equal(daily.daily.query, 'AI'); assert.equal(daily.daily.url, '/job/retailtechdaily/?q=AI#archiveSearch');
});

test('検索の空応答・拒否・出力上限・JSON不正・本文受信の遅れは503で、開始済みの回数は戻さない', async () => {
  for (const response of [() => searchReply(''), () => searchReply('broken'), () => searchReply(validSearch, 'length'), () => searchReply(validSearch, 'stop', 'refused'), () => searchReply({ ...validSearch, extra: 1 })]) {
    const w = enableSearch(worker(undefined, (_, o) => o?.body && JSON.parse(o.body).response_format ? response() : undefined));
    assert.equal((await searchRequest(w)).status, 503); assert.equal(w.env.DB.rows.size, 2);
  }
  let aborted = false;
  const slow = enableSearch(worker(undefined, (_, o) => {
    if (!o?.body || !JSON.parse(o.body).response_format) return;
    o.signal.addEventListener('abort', () => { aborted = true; });
    return new Response(new ReadableStream({ start() {} }));
  }));
  slow.ctx.searchConfig.ai_timeout_ms = 15;
  assert.equal((await searchRequest(slow)).status, 503); assert.equal(aborted, true);
});

test('古い完全な一覧を丸ごと使い、更新失敗では置き換えず、24時間を超えたら断る', async () => {
  let broken = false;
  const w = enableSearch(worker(undefined, url => broken && url.endsWith('/site-search.json') ? Response.json({}) : undefined));
  assert.equal((await searchRequest(w)).status, 200);
  const old = w.ctx.searchCache.pages;
  w.ctx.searchCache.fetchedAt = Date.now() - 11 * 60000; broken = true;
  assert.equal((await searchRequest(w)).status, 200); await Promise.all(w.waits);
  assert.equal(w.ctx.searchCache.pages, old); assert.ok(w.ctx.searchCache.retryAt > Date.now());
  w.ctx.searchCache.fetchedAt = Date.now() - 25 * 3600000;
  assert.equal((await searchRequest(w)).status, 503);
  w.ctx.searchCache.retryAt = 0;
  assert.equal((await searchRequest(w)).status, 503); assert.equal(w.ctx.searchCache.pages, old);
});

test('検索エラーに入力が含まれても公開エラー・ログ・通知に流さず、会社単位の通知抑制を使う', async () => {
  const secret = 'PRIVATE_SEARCH_TEXT', logs = [], mails = [];
  const w = enableSearch(worker(undefined, (url, o) => {
    if (url.includes('resend.com')) { mails.push(JSON.parse(o.body)); return Response.json({ id: 'mail' }); }
    if (o?.body && JSON.parse(o.body).response_format) return new Response('insufficient_quota ' + secret, { status: 429 });
  }));
  w.ctx.console.log = (...values) => logs.push(values);
  Object.assign(w.env, { RESEND_API_KEY: 'test', ALERT_TO: 'a@example.test', ALERT_FROM: 'b@example.test' });
  for (let i = 0; i < 2; i++) {
    const res = await searchRequest(w, { query: secret, locale: 'en' }); assert.equal(res.status, 503); assert.ok(!(await res.text()).includes(secret));
  }
  await Promise.all(w.waits); assert.equal(mails.length, 1);
  assert.ok(!JSON.stringify([logs, mails]).includes(secret)); assert.ok(mails[0].text.includes('404検索'));
});

test('検索とチャットのページ選びは、遅れて届く429本文を判定し、メールの送信は待たない', { timeout: 2000 }, async () => {
  const secret = 'PRIVATE_SEARCH_TEXT';
  // 実際のfetchを使う。メモリ上のResponseだけではsignalによる本文の中止を再現できない。
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(429, { 'Content-Type': 'application/json' }); res.flushHeaders();
    const timer = setTimeout(() => res.end(JSON.stringify({ error: { code: 'insufficient_quota', message: secret } })), 80);
    res.on('close', () => clearTimeout(timer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let releaseMail;
  try {
    for (const chat of [false, true]) {
      const logs = [], mails = [];
      const w = enableSearch(worker(undefined, (url, o) => {
        if (url.includes('resend.com')) {
          mails.push(JSON.parse(o.body));
          return new Promise(resolve => { releaseMail = () => resolve(Response.json({ id: 'mail' })); });
        }
        if (o?.body && JSON.parse(o.body).response_format) return fetch('http://127.0.0.1:' + server.address().port, o);
      }));
      w.ctx.console.log = (...values) => logs.push(values);
      Object.assign(w.env, { RESEND_API_KEY: 'test', ALERT_TO: 'a@example.test', ALERT_FROM: 'b@example.test' });
      const res = chat
        ? await w.request('/magi2/chat', { site_pages: true, messages: [{ role: 'user', content: secret }] })
        : await searchRequest(w, { query: secret, locale: 'en' });
      const text = await res.text();
      if (chat) { assert.match(text, /event: done/); assert.doesNotMatch(text, /event: pages|event: error/); }
      else { assert.equal(res.status, 503); assert.ok(!text.includes(secret)); }
      assert.equal(mails.length, 1); assert.ok(mails[0].text.includes(chat ? 'チャットのページ選び' : '404検索'));
      assert.ok(!JSON.stringify([logs, mails]).includes(secret));
      releaseMail(); releaseMail = null; await Promise.all(w.waits);
    }
  } finally {
    if (releaseMail) releaseMail();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});

test('検索エラーの本文が届かなければ期限で通信を止め、HTTPコードだけで判定できる通知は送る', { timeout: 2000 }, async () => {
  let status;
  const server = createServer((req, res) => {
    req.resume(); res.writeHead(status, { 'Content-Type': 'application/json' }); res.flushHeaders();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (status of [429, 401]) {
      const mails = [];
      let signal;
      const w = enableSearch(worker(undefined, (url, o) => {
        if (url.includes('resend.com')) { mails.push(JSON.parse(o.body)); return Response.json({ id: 'mail' }); }
        if (o?.body && JSON.parse(o.body).response_format) {
          signal = o.signal; return fetch('http://127.0.0.1:' + server.address().port, o);
        }
      }));
      // 通知の本文待ち2秒だけを短縮し、AI全体の8秒の期限ではなく本文の期限で戻ることを確認する。
      w.ctx.setTimeout = (fn, ms) => setTimeout(fn, ms === 2000 ? 40 : ms);
      Object.assign(w.env, { RESEND_API_KEY: 'test', ALERT_TO: 'a@example.test', ALERT_FROM: 'b@example.test' });
      assert.equal((await searchRequest(w)).status, 503); assert.equal(signal.aborted, true);
      await Promise.all(w.waits); assert.equal(mails.length, status === 401 ? 1 : 0);
    }
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});

test('チャットのページ選びは最新本文500文字だけで並列に行い、統合とイベントで同じ候補を使う', async () => {
  const w = enableSearch(worker());
  const latest = 'PDFをまとめたい' + '😀'.repeat(500);
  const text = await (await w.request('/magi2/chat', { site_pages: true, suggest: true, messages: [
    { role: 'user', content: 'OLD_PRIVATE_HISTORY' }, { role: 'assistant', content: 'old answer' },
    { role: 'user', content: [{ type: 'text', text: latest.slice(0, 998) }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }] },
  ] })).text();
  assert.match(text, /event: pages/); assert.match(text, /https:\/\/tk.st\/tools\/pdf-studio\//);
  assert.ok(text.indexOf('event: pages') < text.indexOf('event: done'));
  const selector = w.calls.find(c => c.response_format), input = JSON.parse(selector.messages.at(-1).content);
  assert.equal(Array.from(input.query).length, 500); assert.equal(selector.max_completion_tokens, 120);
  assert.doesNotMatch(JSON.stringify(selector), /OLD_PRIVATE_HISTORY|data:image|自己像|内部討議/);
  const synth = w.calls.find(c => c.stream); assert.ok(synth.messages.some(m => m.content.includes('検証済みのサイト案内') && m.content.includes('PDF Studio')));
  assert.equal([...w.env.DB.rows.keys()].some(k => k.startsWith('search:')), false);
});

test('ページ選びの無効・非要求・画像だけ・DB未設定・通常上限では検索を呼ばず、失敗でもチャットは続く', async () => {
  for (const reason of ['flag', 'optin', 'images', 'db', 'quota']) {
    const w = enableSearch(worker());
    if (reason === 'flag') w.env.SITE_SEARCH_ENABLED = 'false';
    if (reason === 'db') delete w.env.DB;
    if (reason === 'quota') w.ctx.defaults.daily_limit = 0;
    const res = await w.request('/magi2/chat', { site_pages: reason !== 'optin', messages: [{ role: 'user', content: reason === 'images' ? [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }] : 'q' }] });
    if (reason === 'quota') assert.equal(res.status, 429); else assert.match(await res.text(), /event: done/);
    assert.equal(w.calls.some(c => c.response_format), false);
  }
  const w = enableSearch(worker(undefined, (_, o) => o?.body && JSON.parse(o.body).response_format ? searchReply('broken') : undefined));
  const text = await (await w.request('/magi2/chat', { site_pages: true, messages: [{ role: 'user', content: 'q' }] })).text();
  assert.match(text, /event: done/); assert.doesNotMatch(text, /event: pages/);
});

test('遅いページ選びだけを中止し、後から返っても統合や画面へ混ぜない', async () => {
  let aborted = false;
  const w = enableSearch(worker(undefined, async (_, o) => {
    if (!o?.body || !JSON.parse(o.body).response_format) return;
    o.signal.addEventListener('abort', () => { aborted = true; });
    await delay(60); return searchReply({ selections: ['tool:7'], daily: null });
  }));
  w.ctx.searchConfig.chat_wait_ms = 10;
  const text = await (await w.request('/magi2/chat', { site_pages: true, messages: [{ role: 'user', content: 'q' }] })).text();
  assert.match(text, /event: done/); assert.doesNotMatch(text, /event: pages/); assert.equal(aborted, true);
  assert.ok(!w.calls.find(c => c.stream).messages.some(m => m.content.includes('検証済みのサイト案内')));
  await delay(65);
});

test('統合の失敗ではpagesとdoneを出さず、接続キャンセルでは選択用AIも止める', async () => {
  for (const stream of [completion(''), completion('partial', 'length'), completion('partial', 'stop', false)]) {
    const w = enableSearch(worker(stream)), text = await (await w.request('/magi2/chat', { site_pages: true, messages: [{ role: 'user', content: 'q' }] })).text();
    assert.match(text, /event: error/); assert.doesNotMatch(text, /event: pages|event: done/);
  }
  let aborted = false;
  const w = enableSearch(worker(undefined, (_, o) => {
    if (!o?.body) return;
    const body = JSON.parse(o.body);
    if (body.response_format) o.signal.addEventListener('abort', () => { aborted = true; });
    return new Promise((_, reject) => o.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  }));
  const res = await w.request('/magi2/chat', { site_pages: true, messages: [{ role: 'user', content: 'q' }] });
  await tick(); await res.body.cancel(); await tick(); assert.equal(aborted, true);
  let allAbsentAborted = false;
  let searchStarted;
  const started = new Promise(resolve => { searchStarted = resolve; });
  const absent = enableSearch(worker(undefined, async (_, o) => {
    if (!o?.body) return;
    const body = JSON.parse(o.body);
    if (body.response_format) { searchStarted(); return new Promise((_, reject) => o.signal.addEventListener('abort', () => { allAbsentAborted = true; reject(new DOMException('aborted', 'AbortError')); })); }
    if (body.max_completion_tokens === 512 || body.max_tokens) { await started; return new Response('failed', { status: 400 }); }
  }));
  const text = await (await absent.request('/magi2/chat', { site_pages: true, messages: [{ role: 'user', content: 'q' }] })).text();
  assert.match(text, /event: error/); assert.doesNotMatch(text, /event: pages|event: done/); assert.equal(allAbsentAborted, true);
});

// サイト案内のテスト用の小さな索引（data/site-search.json の形）
const guideIndex = { version: 1, pages: [
  { id: 'page:/', kind: 'page', title: 'TOP_TITLE', description: 'TOP_DESC', url: '/', detail: 'TOP_TITLE' },
  { id: 'tool:7', kind: 'tool', title: 'PDF Studio', description: 'PDF_DESC', url: '/tools/pdf-studio/', detail: 'PDF Studio' },
  { id: 'page:tools', kind: 'page', title: 'TOOLS_TITLE', description: 'TOOLS_DESC', url: '/tools/', detail: 'TOOLS_TITLE', hub: true, title_en: 'All tools', description_en: 'EN_DESC' },
  { id: 'page:/job/nitoridaily/20261003/', kind: 'page', title: 'ISSUE_TITLE', description: '', url: '/job/nitoridaily/20261003/', detail: 'ISSUE_TITLE' },
] };
const serveIndex = (index = guideIndex) => url => url.endsWith('/site-search.json') ? (index ? Response.json(index) : new Response('down', { status: 503 })) : undefined;

test('page を送った画面だけにサイト案内を足し、3人格には場面だけ、統合には一覧まで渡す', async () => {
  for (const [page, index, flag = 'true'] of [['/', guideIndex], ['app', guideIndex], ['/unknown/', guideIndex], ['/', null], ['/', guideIndex, 'false'],
    [null, guideIndex], ['https://evil.example/', guideIndex], ['/<x>', guideIndex], ['/' + 'a'.repeat(100), guideIndex]]) {
    const w = worker(undefined, serveIndex(index));
    w.env.SITE_SEARCH_ENABLED = flag;
    const guide = vm.runInContext('SITE_GUIDE', w.ctx), personas = vm.runInContext('PERSONAS', w.ctx);
    const body = { messages: [{ role: 'user', content: 'このページは何？' }], ...(page ? { page } : { context: 'DJ_CONTEXT' }) };
    assert.match(await (await w.request('/magi2/chat', body)).text(), /event: done/);
    const personaCalls = w.calls.filter(c => personas.some(p => c.messages[0].content.startsWith(p.system_prompt)));
    const synth = w.calls.find(c => c.stream).messages.filter(m => m.role === 'system').map(m => m.content).join('|');
    assert.equal(personaCalls.length, 6);
    const expected = !index || flag !== 'true' ? guide.unknown_page
      : { '/': 'TOP_TITLE — TOP_DESC', app: guide.app.title + ' — ' + guide.app.description, '/unknown/': guide.unknown_page }[page];
    if (!expected) {
      assert.ok(!JSON.stringify(w.calls).includes(guide.persona_header) && !JSON.stringify(w.calls).includes(guide.synth_header), String(page));
      continue;
    }
    for (const c of personaCalls) {
      const system = c.messages[0].content;
      assert.ok(system.includes(guide.persona_header) && system.includes(guide.current_label + expected));
      assert.ok(!system.includes('TOOLS_DESC'));
    }
    assert.ok(synth.includes(guide.synth_header) && synth.includes(guide.current_label + expected));
    // 索引が取れない・停止フラグが false なら一覧なしで続ける。取れたら主な入口を先に並べ、日刊の号を外す
    const listed = !!index && flag === 'true';
    assert.equal(synth.includes('- TOOLS_TITLE — TOOLS_DESC'), listed);
    if (listed) assert.ok(synth.indexOf('- TOOLS_TITLE') < synth.indexOf('- TOP_TITLE') && synth.indexOf('- TOP_TITLE') < synth.indexOf('- PDF Studio'));
    assert.ok(!synth.includes('ISSUE_TITLE'));
  }
  assert.ok(!between(dj, 'body: JSON.stringify({ messages: messagesForMagi', 'signal').includes('page'));
});

test('統合人格に渡すページ一覧は上限の字数で打ち切る', () => {
  const w = worker(), guide = vm.runInContext('SITE_GUIDE', w.ctx);
  const pages = Array.from({ length: 200 }, (_, n) => ({ id: 'page:' + n, kind: 'page', title: 'PAGE_' + n, description: 'x'.repeat(150), url: '/p' + n + '/', hub: false }));
  const synth = w.ctx.siteGuide('/', pages).synth;
  const list = synth.slice(synth.indexOf(guide.list_label) + guide.list_label.length);
  assert.ok(list.length <= guide.list_max_chars + 1); assert.ok(list.includes('PAGE_0')); assert.ok(!list.includes('PAGE_199'));
});

test('ページ選びに今のページの題名を渡し、今のページそのものへのリンクは出さない', async () => {
  let selector, indexFetches = 0;
  const w = enableSearch(worker(undefined, (url, o) => {
    if (url.endsWith('/site-search.json')) { indexFetches++; return Response.json(guideIndex); }
    if (!o?.body || !JSON.parse(o.body).response_format) return;
    selector = JSON.parse(o.body);
    return searchReply({ selections: ['page:tools', 'tool:7'], daily: null });
  }));
  const text = await (await w.request('/magi2/chat', { site_pages: true, page: '/tools/', messages: [{ role: 'user', content: 'このページは何？' }] })).text();
  assert.equal(JSON.parse(selector.messages.at(-1).content).current_page, 'TOOLS_TITLE');
  assert.equal(indexFetches, 1); // 案内とページ選びで同じ索引を使う
  const lines = text.split(String.fromCharCode(10));
  const pages = JSON.parse(lines[lines.indexOf('event: pages') + 1].slice('data: '.length)).pages.map(p => p.url);
  assert.deepEqual(pages, ['https://tk.st/tools/pdf-studio/']);
});

test('両画面はpagesをdoneまで仮保持し、失敗・会話切り替えなら捨て、履歴へ保存しない', async () => {
  for (const [src, isHome] of [[mobile, false], [home, true]]) {
    for (const mode of ['success', 'eof', 'error', 'switch']) {
      const c = client(src, isHome), renders = [], outbound = [];
      c.ctx.renderAgentPages = (_, data) => renders.push(data);
      c.ctx.fetch = async (_, o) => { outbound.push(JSON.parse(o.body)); return { ok: true, body: {} }; };
      c.ctx.parseSSE = async (_, h) => {
        h.integrated({ delta: 'answer' }); h.pages({ pages: [{ title: 'PDF Studio' }], daily: null }); assert.equal(renders.length, 0);
        if (mode === 'error') h.error({ code: 'failed' });
        if (mode === 'switch') { c.ctx.agentGen++; c.ctx.agentHistory = []; c.ctx.agentBusy = false; }
        if (mode !== 'eof') h.done();
      };
      await c.ctx.agentSend(); assert.equal(outbound[0].site_pages, true); assert.equal(outbound[0].page, isHome ? '/' : 'app');
      assert.equal(renders.length, mode === 'success' ? 1 : 0);
      assert.equal(JSON.stringify(c.ctx.agentHistory).includes('PDF Studio'), false);
    }
  }
});

test('両画面のリンク検証とラベルの描画は一致し、サイト外・クエリ偽装を拒否する', () => {
  function node() { return { children: [], appendChild(child) { this.children.push(child); } }; }
  const helper = src => between(src, 'function renderAgentPages(', 'function prepareAgentMessages(').trim().split('\n').map(line => line.trim()).join('\n');
  assert.equal(helper(home), helper(mobile));
  for (const src of [home, mobile]) {
    const ctx = vm.createContext({ URL, document: { createElement: node, documentElement: { lang: 'ja' } } });
    vm.runInContext(helper(src), ctx); const reply = node();
    ctx.renderAgentPages(reply, { pages: [
      { kind: 'tool', title: '<script>label</script>', description: '<img>', url: 'https://tk.st/tools/pdf-studio/' },
      { kind: 'tool', title: 'bad', description: '', url: 'https://tk.st.evil.test/tools/a/' },
      { kind: 'page', title: 'bad', description: '', url: 'https://tk.st/?q=private' },
    ], daily: { media: 'retail', query: 'AI', url: 'https://tk.st/job/retailtechdaily/?q=AI&extra=x#archiveSearch' } });
    assert.equal(reply.children[0].children.length, 1);
    assert.equal(reply.children[0].children[0].children[0].textContent, '<script>label</script>');
    assert.equal(reply.children[0].children[0].rel, 'noopener noreferrer');
  }
});

test('chat と react の認可を共通化しても、公開情報・未知の入口・エラー応答を保つ', async () => {
  const w = worker();
  w.env.CLIENT_API_KEY = 'client-key';
  for (const path of ['/magi2/chat', '/magi2/react']) {
    for (const headers of [{ Origin: 'https://outside.example' }, { Origin: '', 'x-api-key': 'wrong' }]) {
      const res = await w.request(path, '{', '192.0.2.1', headers);
      assert.equal(res.status, 401);
      const error = (await res.json()).error;
      assert.equal(error.code, 'unauthorized');
      assert.ok(error.request_id);
      assert.equal(error.message, path.endsWith('/react') ? '許可されていない Origin です'
        : '許可されていない Origin です（許可: https://tk.st, https://www.tk.st, localhost）。外部利用は x-api-key が必要です');
    }
    for (const headers of [
      { Origin: 'https://tk.st' }, { Origin: 'https://www.tk.st' }, { Origin: 'https://localhost' },
      { Origin: 'capacitor://localhost' }, { Origin: 'http://localhost:5173' },
      { Origin: 'https://outside.example', 'x-api-key': 'client-key' },
    ]) {
      const res = await w.request(path, '{', '192.0.2.1', headers);
      assert.equal(res.status, 400);
      const error = (await res.json()).error;
      assert.equal(error.code, 'invalid_json');
      assert.equal(error.message, 'リクエストボディの JSON が不正です');
    }
  }
  const route = (path, method = 'GET') => w.ctx.worker.fetch(new Request('https://workers.tk.st' + path, {
    method, headers: { Origin: 'https://outside.example' },
  }), w.env, { waitUntil(p) { w.waits.push(p); } });
  const models = await route('/magi2/models');
  assert.equal(models.status, 200);
  assert.equal(models.headers.get('Content-Type'), 'application/json');
  assert.equal(models.headers.get('Cache-Control'), 'public, max-age=600');
  assert.equal(models.headers.get('Access-Control-Allow-Origin'), 'https://tk.st');
  const body = await models.json();
  assert.deepEqual(Object.keys(body.personas), ['MELCHIOR-1', 'BALTHASAR-2', 'CASPER-3']);
  assert.ok(body.synthesizer.model_id);
  assert.equal((await route('/magi2/chat')).status, 404);
  assert.equal((await route('/magi2/missing', 'POST')).status, 404);
  assert.equal((await route('/magi2/missing', 'OPTIONS')).status, 204);
  // キーが未設定なら、ヘッダーが空でも外部からは認可しない。
  delete w.env.CLIENT_API_KEY;
  assert.equal((await w.request('/magi2/chat', '{', '192.0.2.1', { Origin: '' })).status, 401);
  assert.equal(w.calls.length, 0);
});

test('本文・分割テキスト・履歴・状況説明・生ボディの上限を上流呼び出し前に検証する', async () => {
  const w = worker();
  for (const content of ['x'.repeat(1001), [{ type: 'text', text: 'x'.repeat(600) }, { type: 'text', text: 'y'.repeat(600) }]]) {
    const res = await w.chat([{ role: 'user', content }]);
    assert.equal(res.status, 400); assert.equal((await res.json()).error.code, 'text_too_long');
  }
  const res = await w.chat([{ role: 'assistant', content: 'x'.repeat(4001) }, { role: 'user', content: 'q' }]);
  assert.equal(res.status, 400);
  const history = Array.from({ length: 11 }, () => ({ role: 'assistant', content: 'x'.repeat(4000) })).concat({ role: 'user', content: 'q' });
  assert.equal((await w.chat(history)).status, 400);
  assert.equal((await w.request('/magi2/chat', { messages: [{ role: 'user', content: 'q' }], context: 'x'.repeat(4001) })).status, 400);
  assert.equal((await w.request('/magi2/chat', 'null')).status, 400);
  // 短いボディに偽の大きな Content-Length を付けても展開しない。
  assert.equal((await w.request('/magi2/chat', '{}', '192.0.2.1', { 'Content-Length': '99999999' })).status, 413);
  await assert.rejects(w.ctx.readJsonLimited(new Request('https://test/', { method: 'POST', body: '123456' }), 5), e => e.envelope.code === 'request_too_large');
  assert.equal(w.calls.length, 0);
  const ok = await w.request('/magi2/chat', { messages: [{ role: 'user', content: 'x'.repeat(1000) }], context: 'DJ context' });
  assert.match(await ok.text(), /event: done/);
  assert.ok(w.calls.some(c => c.messages.some(m => typeof m.content === 'string' && m.content.startsWith('DJ context\n'))));
});

test('統合の空本文・上限終了・終端欠落・不正データを完了扱いしない', async () => {
  for (const stream of [completion(''), completion('partial', 'length'), completion('partial', 'stop', false), 'data: broken\n\n', 'data: {"error":{"message":"failed"}}\n\n']) {
    const w = worker(stream), res = await w.chat([{ role: 'user', content: 'q' }]), text = await res.text();
    assert.match(text, /event: error/); assert.doesNotMatch(text, /event: done/);
  }
  const w = worker(), text = await (await w.chat([{ role: 'user', content: 'q' }])).text();
  assert.match(text, /event: integrated/); assert.match(text, /event: done/); assert.doesNotMatch(text, /event: error/);
});

test('リアクションの移行・所有権・重複・回数制限を実 SQLite で確認する', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tk-st-magi2-'));
  try {
    const old = join(dir, 'old.sqlite');
    sqlite(old, 'CREATE TABLE reactions (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT, ip TEXT, target TEXT, reaction TEXT, request TEXT, response TEXT); INSERT INTO reactions (response) VALUES (\'legacy\');');
    sqlite(old, read('workers/magi2/migrations/0001_reaction_ownership.sql'));
    assert.equal(sqlite(old, 'SELECT delete_token_hash FROM reactions WHERE id=1', []).row.delete_token_hash, null);
    const w = worker(); w.env.DB = database(join(dir, 'new.sqlite'));
    // 実SQLiteの検証は時間が掛かる。分の境目をまたいでも同じ窓の上限を確認する。
    const fixedTime = Date.now();
    w.ctx.Date = class extends Date {
      constructor(...args) { super(...(args.length ? args : [fixedTime])); }
      static now() { return fixedTime; }
    };
    const body = { target: 'integrated', reaction: '👍', request: 'q', response: 'a' };
    const add = await (await w.request('/magi2/react', body)).json();
    assert.match(add.delete_token, /^[a-f0-9]{64}$/);
    const stored = sqlite(join(dir, 'new.sqlite'), 'SELECT delete_token_hash FROM reactions WHERE id=?', [add.id]).row;
    assert.notEqual(stored.delete_token_hash, add.delete_token);
    const duplicate = await (await w.request('/magi2/react', body)).json();
    assert.equal(duplicate.duplicate, true); assert.equal(duplicate.delete_token, undefined); assert.equal(duplicate.id, undefined);
    assert.equal((await w.request('/magi2/react', { op: 'remove', target: body.target, id: add.id }, '192.0.2.2')).status, 400);
    const forged = await (await w.request('/magi2/react', { op: 'remove', target: body.target, id: add.id, delete_token: '0'.repeat(64) }, '192.0.2.2')).json();
    assert.equal(forged.deleted, 0);
    const remove = await (await w.request('/magi2/react', { op: 'remove', target: body.target, id: add.id, delete_token: add.delete_token }, '192.0.2.3')).json();
    assert.equal(remove.deleted, 1); // IPが変わっても自分のトークンで取り消せる。
    w.ctx.defaults.reactions.minute_limit = 2;
    w.ctx.defaults.reactions.daily_limit = 3;
    for (let i = 0; i < 2; i++) assert.equal((await w.request('/magi2/react', body, '192.0.2.4')).status, 200);
    assert.equal((await w.request('/magi2/react', body, '192.0.2.4')).status, 429);
    sqlite(join(dir, 'new.sqlite'), 'DELETE FROM rate_limit WHERE length(day)>10', []);
    assert.equal((await w.request('/magi2/react', body, '192.0.2.4')).status, 200);
    assert.equal((await w.request('/magi2/react', body, '192.0.2.4')).status, 429);
    assert.equal((await w.request('/magi2/react', { ...body, target: 'unknown' })).status, 400);
  } finally { rmSync(dir, { recursive: true }); }
});

test('本番とネイティブのAPI接続先をURLやグローバル値で変更できない', () => {
  const source = between(mobile, 'var API_BASE =', 'var AGENT_API');
  for (const [hostname, protocol, native, candidate, expected] of [
    ['tk.st', 'https:', false, 'https://collector.example', 'https://workers.tk.st'],
    ['localhost', 'https:', true, 'http://localhost:8787', 'https://workers.tk.st'],
    ['localhost', 'capacitor:', false, 'http://localhost:8787', 'https://workers.tk.st'],
    ['localhost', 'http:', false, 'https://collector.example', 'https://workers.tk.st'],
    ['localhost', 'http:', false, 'http://localhost:8787', 'http://localhost:8787'],
    ['127.0.0.1', 'http:', false, 'http://127.0.0.1:8787', 'http://127.0.0.1:8787'],
    ['localhost', 'http:', false, 'http://user:pass@localhost:8787', 'https://workers.tk.st'],
  ]) {
    const ctx = vm.createContext({ URL, URLSearchParams, location: { hostname, protocol, search: '?api=' + encodeURIComponent(candidate) }, window: { MAGI_API_BASE: candidate, Capacitor: { isNativePlatform: () => native } } });
    vm.runInContext(source, ctx); assert.equal(ctx.API_BASE, expected);
  }
});

test('連続画像添付では送信分だけ直近8枚を残し、保存履歴を変えない', async () => {
  const image = i => ({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' }, label: i });
  const history = [0, 1, 2].flatMap(n => [{ role: 'user', content: Array.from({ length: 4 }, (_, i) => image(n * 4 + i)) }, { role: 'assistant', content: 'a' }]).slice(0, -1);
  const original = JSON.stringify(history);
  for (const src of [mobile, home]) {
    const ctx = vm.createContext({ AGENT_MAX_HISTORY: 12 });
    vm.runInContext(between(src, 'function prepareAgentMessages(', 'async function agentSend('), ctx);
    const messages = ctx.prepareAgentMessages(history, history.at(-1).content);
    const images = messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(p => p.type === 'image_url') : []);
    assert.equal(images.length, 8); assert.deepEqual(Array.from(images, p => p.label), [4, 5, 6, 7, 8, 9, 10, 11]);
    assert.equal(JSON.stringify(history), original);
    assert.match(await (await worker().chat(messages)).text(), /event: done/);
  }
});

test('3画面のSSEは分割CRLF・終端・途中EOFを同じように読む', async () => {
  for (const [src, end] of [[mobile, '// ---- 画像添付'], [home, '// --- マルチモーダル入力'], [dj, '// 相談の下には FAQ']]) {
    const ctx = vm.createContext({ TextDecoder }); vm.runInContext(between(src, '// AGENT_CLASSIFY_BEGIN', '// AGENT_CLASSIFY_END') + '\n' + between(src, 'async function parseSSE(', end), ctx);
    let text = '', completed = false, chunks = 0, cancelled = false;
    const data = (event('integrated', { delta: '答え' }) + event('done', {})).replaceAll('\n', '\r\n');
    const body = new ReadableStream({ start(c) { for (const byte of encode(data)) c.enqueue(Uint8Array.of(byte)); }, cancel() { cancelled = true; } });
    await ctx.parseSSE(body, { integrated(d) { text += d.delta; }, done() { completed = true; } }, () => chunks++);
    assert.equal(text, '答え'); assert.equal(completed, true); assert.equal(cancelled, true); assert.ok(chunks > 1);
    completed = false;
    await ctx.parseSSE(new Response(event('integrated', { delta: 'partial' })).body, { done() { completed = true; } });
    assert.equal(completed, false);
  }
});

function element() {
  return { children: [], dataset: {}, style: {}, classList: { add() {}, remove() {}, contains() { return false; } }, querySelector: element, querySelectorAll: () => [], appendChild(el) { this.children.push(el); }, remove() { this.removed = true; }, focus() {} };
}
// 通信の期限と表示の更新を別々に進める。スリープは実時刻だけ進め、更新コールバックは呼ばない。
function thinkingClock() {
  let now = 0;
  const intervals = new Map();
  return {
    Date: class extends Date { static now() { return now; } },
    setInterval(fn, ms) { const id = {}; intervals.set(id, { fn, ms }); return id; },
    clearInterval(id) { intervals.delete(id); },
    setTime(ms) { now = ms; },
    tick() { for (const { fn } of intervals.values()) fn(); },
    intervals,
  };
}
const thinkingSource = src => between(src.replaceAll('\r\n', '\n'), 'function setMagiThinkingLabel(', '\n\n');

test('4画面の計時はスリープを含む実時刻で進み、回答開始で固定し、中断で更新を止める', () => {
  for (const src of [home, mobile, dj, read('404.html')]) {
    const clock = thinkingClock();
    const ctx = vm.createContext({ ...clock, performance: { now: () => 0 }, document: { createElement: element, documentElement: { lang: 'ja' } } });
    vm.runInContext(thinkingSource(src), ctx);
    const target = element();
    const thinking = ctx.startMagiThinking(target, clock.Date.now());
    const label = target.children[0];
    assert.equal(label.textContent, '0秒考え中');
    clock.setTime(2100); clock.tick();
    assert.equal(label.textContent, '2秒考え中');
    // コールバックも performance.now() も止まったまま25秒待ち、復帰して回答が届く。
    clock.setTime(27100);
    assert.equal(thinking.finish(), 27);
    assert.equal(label.textContent, '27秒考えました');
    assert.equal(clock.intervals.size, 0);
    clock.setTime(35000); clock.tick();
    assert.equal(thinking.finish(), 27);
    assert.equal(label.textContent, '27秒考えました');
    ctx.document.documentElement.lang = 'en';
    const cancelled = ctx.startMagiThinking(target, clock.Date.now());
    assert.equal(target.children[1].textContent, 'Thinking for 0s');
    cancelled.cancel();
    assert.equal(clock.intervals.size, 0);
    assert.equal(target.children[1].removed, true);
  }
});

function client(src, isHome = false) {
  const timers = new Map(), errors = [];
  const clock = thinkingClock();
  const ctx = vm.createContext({
    Date: clock.Date, setInterval: clock.setInterval, clearInterval: clock.clearInterval,
    AbortController, JSON, TextDecoder, console: { error() {} }, window: {}, AGENT_API: 'mock', AGENT_MAX_HISTORY: 12, AGENT_PERSONAS: [],
    setTimeout(fn, ms) { const id = {}; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
    document: { createElement: element, documentElement: { lang: 'en', getAttribute: () => 'light' } },
    agentLog: { ...element(), children: [] }, agentInput: { ...element(), value: 'q' }, agentSendBtn: element(), attachBtn: element(), agentDegraded: element(),
    agentHistory: [], agentBusy: false, agentDead: false, agentGen: 0, agentCtrl: null, attachments: [], attachNotice: '', pendingReactions: {},
    localStorage: { removeItem() {} }, safeGet(key) { return ctx.localStorage.getItem?.(key) ?? null; }, genMid: () => 'm1', setAgentSuggestion() {}, fitAgentInput() {}, renderAttachTray() {}, userContentHTML: () => '',
    userBubbleEl: element, agentTurnEl: element, splashOnly: () => false, isDarkNow: () => false, cssEsc: s => s, tr: s => s, announceAgent() {},
    personaCardsHTML: () => '', reactionBarHTML: () => '', agentScroll() {}, safeStore() {}, safeRemove() {}, saveCurrentHistory() {}, syncCurrentToSaved() {}, updateAgentActionButtons() {},
    archiveCurrentHistory() {}, closeAgentPanels() {}, setAgentTitle() {}, showSplashIfEmpty() {}, renderAgentPages() {}, renderAgentError(e) { errors.push(e); }, agentDegrade() {}, setAgentInputEnabled(enabled) { ctx.agentInput.disabled = ctx.agentSendBtn.disabled = ctx.attachBtn.disabled = !enabled; },
  });
  vm.runInContext(between(src, '// AGENT_CLASSIFY_BEGIN', '// AGENT_CLASSIFY_END'), ctx);
  ctx.currentSessionId = 'test-session'; ctx.agentReplyLanguage = null; ctx.currentLang = 'en'; ctx.ensureAgentConversation = () => ctx.currentSessionId; ctx.saveAgentLanguage = value => { ctx.agentReplyLanguage = value; };
  if (!isHome) vm.runInContext(between(src, 'function cleanHistory(', 'function initAgent('), ctx);
  vm.runInContext(thinkingSource(src), ctx);
  vm.runInContext(between(src, 'function prepareAgentMessages(', isHome ? 'agentSendBtn.addEventListener(' : '// ---- Reaction network'), ctx);
  return { ctx, timers, errors, clock };
}

test('両画面は最初の回答本文までの秒数を保存し、次の質問のAPIには送らない', async () => {
  for (const [src, isHome] of [[mobile, false], [home, true]]) {
    const c = client(src, isHome), outbound = [];
    c.ctx.fetch = async (_, options) => { outbound.push(JSON.parse(options.body)); return { ok: true, body: {} }; };
    c.ctx.parseSSE = async (_, handlers) => {
      c.clock.setTime(1200); handlers.integrated({ delta: '' });
      assert.equal(c.clock.intervals.size, 1);
      c.clock.setTime(4500); handlers.integrated({ delta: 'answer' });
      assert.equal(c.clock.intervals.size, 0);
      c.clock.setTime(12000); handlers.integrated({ delta: ' continued' }); handlers.done();
    };
    await c.ctx.agentSend();
    assert.equal(c.ctx.agentHistory.at(-1).thinkingSeconds, 4);
    assert.equal(c.clock.intervals.size, 0);
    c.ctx.agentInput.value = 'next question';
    c.ctx.parseSSE = async (_, handlers) => { handlers.integrated({ delta: 'next answer' }); handlers.done(); };
    await c.ctx.agentSend();
    const prior = outbound[1].messages.find(m => m.role === 'assistant');
    assert.equal(prior.content, 'answer continued');
    assert.equal(Object.hasOwn(prior, 'thinkingSeconds'), false);
    assert.equal(c.ctx.agentHistory[1].thinkingSeconds, 4);
    assert.equal(c.clock.intervals.size, 0);
  }
});

test('両画面はdone欠落を保存せず、開始後の無通信で入力を戻す', async () => {
  for (const [src, isHome] of [[mobile, false], [home, true]]) {
    const c = client(src, isHome);
    c.ctx.fetch = async () => ({ ok: true, body: {} });
    c.ctx.parseSSE = async (_, handlers) => { assert.equal([...c.timers.values()][0].ms, 70000); handlers.integrated({ delta: 'partial' }); };
    await c.ctx.agentSend();
    assert.equal(c.ctx.agentHistory.length, 0); assert.equal(c.errors.at(-1).code, 'incomplete_reply'); assert.equal(c.timers.size, 0); assert.equal(c.clock.intervals.size, 0);
    c.ctx.agentInput.value = 'retry';
    c.ctx.parseSSE = async (_, handlers) => { handlers.integrated({ delta: 'complete' }); handlers.done(); };
    await c.ctx.agentSend(); assert.equal(c.ctx.agentHistory.at(-1).content, 'complete');
    c.ctx.agentInput.value = 'stalled';
    c.ctx.fetch = async (_, { signal }) => ({ ok: true, body: { signal } });
    c.ctx.parseSSE = async body => new Promise((_, reject) => body.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    const pending = c.ctx.agentSend(); await tick();
    assert.equal([...c.timers.values()][0].ms, 70000); [...c.timers.values()][0].fn(); await pending;
    assert.equal(c.ctx.agentBusy, false); assert.equal(c.ctx.agentInput.disabled, false); assert.equal(c.errors.at(-1).code, 'timeout'); assert.equal(c.timers.size, 0); assert.equal(c.clock.intervals.size, 0);
  }
});

test('モバイルの新規会話と保存会話切り替えは古い回答を混ぜない', async () => {
  for (const switchSession of [false, true]) {
    const c = client(mobile);
    vm.runInContext(between(mobile, 'var agentGen = 0', 'function agentDegrade('), c.ctx);
    let release; const gate = new Promise(r => { release = r; });
    c.ctx.fetch = async () => ({ ok: true, body: {} });
    c.ctx.parseSSE = async (_, handlers) => { await gate; handlers.integrated({ delta: 'old answer' }); handlers.done(); };
    const pending = c.ctx.agentSend(); await tick();
    if (switchSession) {
      c.ctx.safeParse = () => [{ id: 'saved', history: [{ role: 'user', content: 'saved question' }] }];
      c.ctx.localStorage.getItem = () => ''; c.ctx.localStorage.setItem = () => {}; c.ctx.renderHistoryToLog = () => {};
      vm.runInContext(between(mobile, 'function loadSavedSession(', 'function deleteSavedSession('), c.ctx);
      c.ctx.loadSavedSession('saved');
    } else { c.ctx.resetAgent(); c.ctx.agentHistory.push({ role: 'user', content: 'new question' }); }
    release(); await pending;
    assert.equal(c.ctx.agentHistory.length, 1); assert.equal(c.ctx.agentHistory[0].role, 'user'); assert.equal(c.ctx.agentBusy, false); assert.equal(c.clock.intervals.size, 0);
  }
});

test('両画面は接続前・受信途中の通信失敗で質問と画像を戻し、同じ履歴で再送できる', async () => {
  for (const [src, isHome] of [[mobile, false], [home, true]]) for (const duringStream of [false, true]) {
    const c = client(src, isHome);
    c.ctx.agentHistory.push({ role: 'user', content: 'previous question' }, { role: 'assistant', content: 'previous answer' });
    const attachment = { url: 'data:image/jpeg;base64,AAAA', thumb: 'data:image/jpeg;base64,AAAA' };
    c.ctx.attachments.push(attachment);
    // 以前の実装が通信失敗を永久停止にしないことも、実際のagentDegradeで検出する。
    c.ctx.renderAgentSuggest = () => {};
    vm.runInContext(between(src, 'function agentDegrade(', 'function renderAgentError('), c.ctx);
    c.ctx.fetch = async () => { if (!duringStream) throw new TypeError('Failed to fetch'); return { ok: true, body: {} }; };
    c.ctx.parseSSE = async (_, h) => { h.integrated({ delta: 'partial' }); throw new TypeError('connection lost'); };
    await c.ctx.agentSend();
    assert.equal(c.ctx.agentDead, false); assert.equal(c.ctx.agentBusy, false);
    assert.equal(c.ctx.agentInput.disabled, false); assert.equal(c.ctx.agentSendBtn.disabled, false); assert.equal(c.ctx.attachBtn.disabled, false);
    assert.equal(c.ctx.agentInput.value, 'q'); assert.equal(c.ctx.attachments[0], attachment);
    assert.equal(c.ctx.agentHistory.length, 2); assert.equal(c.errors.at(-1).code, 'network_error');
    assert.equal(c.timers.size, 0); assert.equal(c.clock.intervals.size, 0);
    const outbound = [];
    c.ctx.fetch = async (_, options) => { outbound.push(JSON.parse(options.body)); return { ok: true, body: {} }; };
    c.ctx.parseSSE = async (_, h) => { h.integrated({ delta: 'complete' }); h.done(); };
    await c.ctx.agentSend();
    assert.equal(outbound.length, 1); assert.equal(outbound[0].messages[1].content, 'previous answer');
    assert.equal(outbound[0].messages[2].content[1].image_url.url, attachment.url);
    assert.equal(c.ctx.agentHistory.at(-1).content, 'complete');
  }
});

test('モバイルは保存容量超過や保存禁止でもタイトル・回答・会話切り替えを止めない', async () => {
  for (const blocked of [false, true]) {
    const c = client(mobile);
    const sessions = [{ id: 'saved', title: 'saved title', history: [{ role: 'user', content: 'saved question' }] }];
    c.ctx.localStorage = {
      getItem(key) { if (blocked) throw new DOMException('blocked', 'SecurityError'); return key === 'magi_saved_sessions' ? JSON.stringify(sessions) : null; },
      setItem() { throw new DOMException('full', 'QuotaExceededError'); },
      removeItem() { throw new DOMException('blocked', 'SecurityError'); },
    };
    c.ctx.barTitle = {}; c.ctx.document.getElementById = () => null;
    c.ctx.contentText = c => typeof c === 'string' ? c : '';
    vm.runInContext(between(mobile, 'function safeParse(', 'var genMid'), c.ctx);
    vm.runInContext(between(mobile, 'function setAgentTitle(', '// ---- Reactions persistence'), c.ctx);
    vm.runInContext(between(mobile, 'var currentSessionId =', 'function applyReactionsToTurn('), c.ctx);
    c.ctx.fetch = async () => ({ ok: true, body: {} });
    c.ctx.parseSSE = async (_, h) => { h.title({ text: 'new title' }); h.integrated({ delta: 'answer' }); h.done(); };
    await c.ctx.agentSend();
    assert.equal(c.ctx.barTitle.textContent, 'new title'); assert.equal(c.ctx.agentHistory.at(-1).content, 'answer');
    assert.equal(c.ctx.agentDead, false); assert.equal(c.ctx.agentBusy, false); assert.equal(c.ctx.agentInput.disabled, false);
    assert.equal(c.errors.length, 0); assert.equal(c.timers.size, 0);
    c.ctx.setAgentTitle(''); assert.equal(c.ctx.barTitle.textContent, 'MAGI');
    c.ctx.renderHistoryToLog = () => {};
    vm.runInContext(between(mobile, 'var agentGen = 0', 'function agentDegrade('), c.ctx);
    vm.runInContext(between(mobile, 'function loadSavedSession(', 'function deleteSavedSession('), c.ctx);
    c.ctx.loadSavedSession('saved');
    if (!blocked) assert.equal(c.ctx.agentHistory[0].content, 'saved question');
    assert.equal(c.ctx.agentInput.disabled, false);
    c.ctx.resetAgent(); assert.equal(c.ctx.agentHistory.length, 0); assert.equal(c.ctx.agentInput.disabled, false);
  }
});

test('両画面は削除トークンを保存し、登録中の取り消しでもトークン付きで削除する', async () => {
  for (const [src, end] of [[mobile, 'function flashReactBtn('], [home, '// agent-log 内の全クリック']]) {
    const store = {}, posts = [];
    let release;
    const receipt = { id: 7, delete_token: 'a'.repeat(64) };
    let delayed = false, removeStatus = 200;
    const ctx = vm.createContext({ REACT_API: 'mock', AbortController, setTimeout, clearTimeout, reactionStoreFor: () => store, persistReactions() {},
      fetch: async (_, options) => {
        const body = JSON.parse(options.body); posts.push(body);
        if (body.op === 'remove') return Response.json({ ok: removeStatus === 200 }, { status: removeStatus });
        if (delayed) await new Promise(r => { release = r; });
        return Response.json(receipt);
      },
    });
    vm.runInContext(between(src, 'async function sendReaction(', end), ctx);
    ctx.registerReaction({}, 'integrated', '👍', { request: 'q', response: 'a' });
    await tick(); assert.equal(store.integrated.delete_token, receipt.delete_token);
    await ctx.unregisterReaction({}, 'integrated');
    assert.equal(posts.at(-1).delete_token, receipt.delete_token);
    const count = posts.length;
    await ctx.deleteReaction('integrated', { id: 7 }); assert.equal(posts.length, count);
    delayed = true;
    ctx.registerReaction({}, 'integrated', '👍', { request: 'q', response: 'a' });
    const removing = ctx.unregisterReaction({}, 'integrated'); release(); await removing;
    assert.equal(posts.at(-1).op, 'remove'); assert.equal(posts.at(-1).delete_token, receipt.delete_token);
    assert.equal(store.integrated, undefined);
    // 登録中に押した取り消しが失敗しても、後から受け取ったトークンを残す。
    removeStatus = 429;
    ctx.registerReaction({}, 'integrated', '👍', { request: 'q', response: 'a' });
    const failedRemoval = ctx.unregisterReaction({}, 'integrated'); release();
    assert.equal(await failedRemoval, false); assert.equal(store.integrated.delete_token, receipt.delete_token);
    removeStatus = 200;
    assert.equal(await ctx.unregisterReaction({}, 'integrated'), true); assert.equal(store.integrated, undefined);
  }
});

test('両画面は削除失敗でトークンと選択を保持し、再試行の成功後だけ解除する', async () => {
  for (const [src, isHome, end] of [[mobile, false, 'function flashReactBtn('], [home, true, '// agent-log 内の全クリック']]) {
    for (const failure of ['network', '429', '500', 'invalid_json', 'invalid_ack', 'timeout']) {
      const receipt = { em: '👍', id: 7, delete_token: 'a'.repeat(64) };
      const store = { integrated: receipt }, posts = [], errors = [], timers = new Map();
      let resets = 0, unlocked = 0, failed = true;
      const bar = { dataset: {}, classList: { remove(name) { assert.equal(name, 'locked'); unlocked++; } } };
      const ctx = vm.createContext({ REACT_API: 'mock', AbortController, reactionStoreFor: () => store, persistReactions() {}, tr: s => s,
        renderAgentError(e) { errors.push(e); },
        setTimeout(fn) { const id = {}; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
        fetch: async (_, options) => {
          posts.push(JSON.parse(options.body));
          if (!failed) return Response.json({ ok: true, deleted: 1 });
          if (failure === 'network') throw new TypeError('Failed to fetch');
          if (failure === 'timeout') return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
          if (failure === 'invalid_json') return new Response('not JSON');
          return Response.json({ ok: false }, { status: /^\d+$/.test(failure) ? Number(failure) : 200 });
        },
      });
      vm.runInContext(between(src, 'async function sendReaction(', end), ctx);
      const pending = ctx.undoReaction(bar, 'integrated', () => { resets++; });
      await tick();
      if (failure === 'timeout') {
        await ctx.undoReaction(bar, 'integrated', () => { resets++; });
        assert.equal(posts.length, 1, '処理中の連打では削除を重ねない');
        [...timers.values()][0]();
      }
      await pending;
      assert.equal(store.integrated, receipt); assert.equal(resets, 0); assert.equal(unlocked, 0);
      assert.equal(errors.at(-1).code, 'reaction_remove_failed'); assert.equal(bar.dataset.removing, undefined); assert.equal(timers.size, 0);
      failed = false;
      await ctx.undoReaction(bar, 'integrated', () => { resets++; });
      assert.equal(store.integrated, undefined); assert.equal(resets, 1); assert.equal(unlocked, 1);
      assert.equal(posts.at(-1).delete_token, receipt.delete_token); assert.equal(timers.size, 0);
    }
  }
});

test('接続が切れたら、人格の呼び出しを止めて統合を呼ばない', async () => {
  const aborted = [];
  const w = worker(completion(), (url, options) => new Promise((_, reject) => {
    // 人格の呼び出しを止めておき、止められたら AbortError で返す
    options.signal.addEventListener('abort', () => { aborted.push(url); reject(new DOMException('aborted', 'AbortError')); });
  }));
  const res = await w.chat([{ role: 'user', content: 'q' }]);
  const reader = res.body.getReader();
  await tick();
  await reader.cancel();
  for (let i = 0; i < 5; i++) await tick();
  assert.ok(aborted.length >= 3, '3人格の呼び出しが止まる');
  assert.equal(w.calls.filter(c => c.stream).length, 0, '統合は呼ばない');
});

test('残高切れ・キーの失効は、会社と状態ごとに1日1通だけメールで知らせる', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'magi2-alert-'));
  try {
    const mails = [];
    const w = worker(completion(), (url, options) => {
      if (url === 'https://api.resend.com/emails') { mails.push(JSON.parse(options.body)); return Response.json({ id: 'mail' }); }
      if (url.includes('deepseek')) return Response.json({ error: { message: 'Insufficient Balance' } }, { status: 402 });
      // ただの回数制限の 429 は知らせない
      if (url.includes('googleapis')) return Response.json({ error: { message: 'Rate limit reached for requests' } }, { status: 429 });
    });
    Object.assign(w.env, { DB: database(join(dir, 'db.sqlite')), RESEND_API_KEY: 'k', ALERT_TO: 'to@example.com, second@example.com', ALERT_FROM: 'from@example.com' });
    for (let i = 0; i < 2; i++) {
      const res = await w.chat([{ role: 'user', content: 'q' }]);
      await res.text();
      await Promise.all(w.waits);
    }
    assert.equal(mails.length, 1);
    assert.match(mails[0].subject, /deepseek.*402/);
    assert.deepEqual(mails[0].to, ['to@example.com', 'second@example.com']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('通知メールが通信例外・HTTP エラーで失敗したら印を消し、成功後は重複送信しない', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'magi2-alert-retry-'));
  try {
    for (const [failure, key] of [['network', 'alert:deepseek:402'], ['http', 'alert:global']]) {
      const file = join(dir, failure + '.sqlite');
      let attempts = 0;
      const w = worker(completion(), (url) => {
        if (url !== 'https://api.resend.com/emails') return;
        attempts++;
        if (attempts === 1) {
          if (failure === 'network') throw new TypeError('network unavailable');
          return new Response('unavailable', { status: 503 });
        }
        return Response.json({ id: 'mail' });
      });
      Object.assign(w.env, { DB: database(file), RESEND_API_KEY: 'k', ALERT_TO: 'to@example.com', ALERT_FROM: 'from@example.com' });
      const send = () => w.ctx.sendAlert(w.env, () => {}, key, 'test', ['test']);
      await send();
      assert.equal(attempts, 1);
      assert.equal(sqlite(file, 'SELECT count FROM rate_limit WHERE ip = ?', [key]).row, null);
      // 同時に再試行されても、成功する送信は1つだけ。
      await Promise.all([send(), send()]);
      assert.equal(attempts, 2);
      assert.equal(sqlite(file, 'SELECT count FROM rate_limit WHERE ip = ?', [key]).row.count, 1);
      await send();
      assert.equal(attempts, 2);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('通知の HTTP エラー本文が止まっても再試行でき、本文受信後も再試行の成功印を保つ', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'magi2-alert-body-'));
  let body, pending;
  try {
    const file = join(dir, 'db.sqlite'), key = 'alert:global';
    let attempts = 0;
    const w = worker(completion(), url => {
      if (url !== 'https://api.resend.com/emails') return;
      attempts++;
      if (attempts === 1) return new Response(new ReadableStream({
        start(controller) { body = controller; controller.enqueue(encode('unavailable')); },
      }), { status: 503 });
      return Response.json({ id: 'mail' });
    });
    Object.assign(w.env, { DB: database(file), RESEND_API_KEY: 'k', ALERT_TO: 'to@example.com', ALERT_FROM: 'from@example.com' });
    const send = () => w.ctx.sendAlert(w.env, () => {}, key, 'test', ['test']);
    let settled = false;
    pending = send().then(() => { settled = true; });
    await tick();
    assert.equal(attempts, 1);
    assert.equal(settled, false); // 503 の本文受信はまだ終わっていない。
    assert.equal(sqlite(file, 'SELECT count FROM rate_limit WHERE ip = ?', [key]).row, null);
    await send();
    assert.equal(attempts, 2);
    assert.equal(sqlite(file, 'SELECT count FROM rate_limit WHERE ip = ?', [key]).row.count, 1);
    body.close(); body = null;
    await pending;
    // 最初の失敗の後始末で、後から成功した送信の印を消さない。
    assert.equal(sqlite(file, 'SELECT count FROM rate_limit WHERE ip = ?', [key]).row.count, 1);
    await send();
    assert.equal(attempts, 2);
  } finally {
    if (body) body.close();
    if (pending) await pending;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('両画面は停止ボタンで止めた質問を、エラーを出さずに入力欄へ戻す', async () => {
  for (const [src, isHome] of [[mobile, false], [home, true]]) {
    const c = client(src, isHome);
    c.ctx.agentInput.value = 'stop me';
    c.ctx.fetch = async (_, { signal }) => ({ ok: true, body: { signal } });
    c.ctx.parseSSE = async body => new Promise((_, reject) => body.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    const pending = c.ctx.agentSend(); await tick();
    assert.equal(c.ctx.agentSendBtn.title, 'Stop');
    c.ctx.agentStop(); await pending;
    assert.equal(c.errors.length, 0);
    assert.equal(c.ctx.agentHistory.length, 0);
    assert.equal(c.ctx.agentInput.value, 'stop me');
    assert.equal(c.ctx.agentBusy, false);
    assert.equal(c.ctx.agentSendBtn.title, 'Send');
    assert.equal(c.clock.intervals.size, 0);
  }
});

test('全利用者の合計が1日の上限を超えたら 429 を返し、最初の1回でメールを送る', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'magi2-global-'));
  try {
    const mails = [];
    const w = worker(completion(), (url, options) => {
      if (url === 'https://api.resend.com/emails') { mails.push(JSON.parse(options.body)); return Response.json({ id: 'mail' }); }
    });
    Object.assign(w.env, { DB: database(join(dir, 'db.sqlite')), RESEND_API_KEY: 'k', ALERT_TO: 'to@example.com', ALERT_FROM: 'from@example.com' });
    w.ctx.defaults.global_daily_limit = 2;
    const codes = [];
    for (const ip of ['192.0.2.1', '192.0.2.2', '192.0.2.3', '192.0.2.4']) {
      const res = await w.request('/magi2/chat', { messages: [{ role: 'user', content: 'q' }] }, ip);
      codes.push(res.status === 429 ? (await res.json()).error.code : res.status);
      if (res.status === 200) await res.text();
    }
    await Promise.all(w.waits);
    assert.deepEqual(codes, [200, 200, 'global_daily_limit_exceeded', 'global_daily_limit_exceeded']);
    assert.equal(mails.length, 1);
    assert.match(mails[0].subject, /全体の上限/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('上限を 0 にすると、その日の最初の1回から断る', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'magi2-zero-'));
  try {
    const w = worker();
    w.env.DB = database(join(dir, 'db.sqlite'));
    w.ctx.defaults.daily_limit = 0;
    const res = await w.chat([{ role: 'user', content: 'q' }]);
    assert.equal(res.status, 429);
    assert.equal((await res.json()).error.code, 'daily_limit_exceeded');
    assert.equal(w.calls.length, 0, '上流は呼ばない');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 討議の判定（personas.js の DEBATE）。上流のうち判定だけを差し替える
const isJudge = options => JSON.parse(options.body).response_format?.json_schema?.name === 'debate_judge';
const judgeReply = value => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] });
const sseEvents = text => [...text.matchAll(/event: (\w+)\ndata: (.*)\n/g)].map(m => [m[1], JSON.parse(m[2])]);

test('adaptive_debate を付けた画面だけ統合人格が判定し、聞いた人格だけで最大5回まで討議する', async () => {
  let judged = 0;
  const plain = worker(completion(), (url, options) => { if (isJudge(options)) { judged++; return judgeReply({ assessment: '', action: 'answer', questions: [] }); } });
  assert.equal(sseEvents(await (await plain.chat([{ role: 'user', content: 'q' }])).text()).at(-1)[0], 'done');
  assert.equal(judged, 0, '付けない画面（配布済みの古いアプリ）は2回で止める');

  const judges = [];
  const w = worker(completion(), (url, options) => {
    if (!isJudge(options)) return;
    judges.push(JSON.parse(options.body));
    const n = judges.length;
    return judgeReply({ assessment: 'メモ' + n, action: 'ask', questions: [
      { target: 'CASPER-3', question: '問い' + n }, { target: 'CASPER-3', question: '重複' }, { target: 'UNKNOWN', question: 'x' },
      ...(n === 1 ? [{ target: 'MELCHIOR-1', question: '熱の問い' }] : []),
    ] });
  });
  const events = sseEvents(await (await w.request('/magi2/chat', { messages: [{ role: 'user', content: 'q' }], adaptive_debate: true })).text());
  assert.equal(judges.length, 3, '第2〜4回の後だけ判定し、第5回の後は判定しない');
  assert.equal(judges[0].reasoning_effort, 'low');
  assert.equal('temperature' in judges[0], false, '推論ありでは temperature を送れない');
  assert.match(judges[0].messages[0].content, /第2回を終えた/);
  for (const [i, round] of [[0, 2], [1, 3]]) {
    const system = judges[i].messages[0].content;
    assert.match(system, new RegExp(`第${round}回を終えた`));
    assert.match(system, /追加の一往復で回答の理由・具体性・判断の質を改善できるか/);
    assert.match(system, /案の弱点や選ぶ基準が未検討なら/);
    assert.match(system, /既知の条件で選択肢の比較・弱点・判断基準を検討できるなら/);
    assert.doesNotMatch(system, /そのままだと答えが変わってしまう論点が残っているときだけ/);
  }
  assert.match(judges[2].messages[0].content, /第4回を終えた/);
  assert.match(judges[2].messages[0].content, /そのままだと答えが変わってしまう論点が残っているときだけ/);
  assert.doesNotMatch(judges[2].messages[0].content, /追加の一往復で回答の理由・具体性・判断の質を改善できるか/);
  assert.match(judges[2].messages[0].content, /次が第5回で、最後の回/);
  assert.deepEqual(events.filter(([e]) => e === 'ask').map(([, d]) => [d.round, d.questions.map(q => q.codename + ':' + q.text).join()]),
    [[3, 'CASPER-3:問い1,MELCHIOR-1:熱の問い'], [4, 'CASPER-3:問い2'], [5, 'CASPER-3:問い3']]);
  assert.deepEqual(events.filter(([e, d]) => e === 'persona' && d.round >= 3).map(([, d]) => d.codename + '@' + d.round).sort(),
    ['CASPER-3@3', 'CASPER-3@4', 'CASPER-3@5', 'MELCHIOR-1@3']);
  const memo = w.calls.find(c => c.stream).messages.at(-1).content;
  assert.match(memo, /第5回（自分の問い「問い3」への答え）/);
  assert.match(memo, /討議を見た自分のメモ\]\nメモ3/);
  assert.match(memo, /上限の5回で打ち切った/);
  assert.equal(events.at(-1)[0], 'done');
});

test('判定が答える・失敗するときは聞き返さずに統合し、judge イベントで無通信の見張りを延ばす', async () => {
  for (const reply of [() => judgeReply({ assessment: '割れているのは好みだけ', action: 'answer', questions: [] }), () => new Response('down', { status: 500 }), () => judgeReply('not json')]) {
    let judged = 0;
    const w = worker(completion(), (url, options) => { if (isJudge(options)) { judged++; return reply(); } });
    const events = sseEvents(await (await w.request('/magi2/chat', { messages: [{ role: 'user', content: 'q' }], adaptive_debate: true })).text());
    assert.equal(judged, 1);
    assert.equal(events.some(([e]) => e === 'ask'), false);
    assert.deepEqual(events.find(([e]) => e === 'judge')[1], { round: 2, action: 'answer' });
    assert.equal(events.at(-1)[0], 'done');
    assert.doesNotMatch(w.calls.find(c => c.stream).messages.at(-1).content, /上限/);
  }
});

test('履歴の followups はいちばん新しい意見を人格の過去の発言に使い、欠席の印は飛ばす', async () => {
  const w = worker();
  await (await w.request('/magi2/chat', { adaptive_debate: true, messages: [
    { role: 'user', content: '前の質問' },
    { role: 'assistant', content: '前の答え', debate: { 'CASPER-3': { round1: 'A1', round2: 'A2', followups: [{ round: 3, ask: 'q', text: 'A3' }, { round: 4, ask: 'q', text: '[NO RESPONSE]' }] } } },
    { role: 'user', content: '次の質問' },
  ] })).text();
  const casper = w.calls.find(c => !c.stream && c.messages[0].content.startsWith('あなたは、Shinya Takeda という一人の人間の中にある3つの面の1つ「Strategist」'));
  assert.equal(casper.messages.find(m => m.role === 'assistant').content, 'A3');
});

test('3画面は adaptive_debate を付け、聞き返しの枠を描き、履歴に followups を残す', () => {
  for (const src of [home, mobile, dj]) {
    assert.match(src, /adaptive_debate: true/);
    assert.match(src, /ask: (?:\(d\) =>|function \(d\))/);
    assert.match(src, /followupHTML\(/);
  }
  assert.match(home, /followups: \[\] \}\]\)\)/);
  assert.match(mobile, /followups: \[\] \};/);
  assert.match(dj, /followups: \(rounds \|\| \[\]\)\.slice\(2\)/);
});

// 発言の言語の判定（personas.js の INTENT_CLASSIFY）。Jev の口だけを差し替える
const jevReply = (choice, confidence = 0.99) => Response.json({ model: 'jev-1.13.0', answers: { language: { type: 'choice', choice, confidence, probabilities: { [choice]: confidence } } } });
async function chatWithJev(reply, messages, extra = {}) {
  const sent = [];
  const w = worker(completion(), (url, options) => {
    if (url !== 'https://api.typesafe.ai/v1/systemone') return;
    sent.push(JSON.parse(options.body));
    return reply();
  });
  w.env.MAGI_TYPESAFE_API_KEY = 'test';
  const text = await (await w.request('/magi2/chat', { messages, ...extra })).text();
  return { w, sent, text };
}

test('Jev で決めた出力の言語を全員に渡し、状況説明と AI の回答は Jev に送らない', async () => {
  const messages = [
    { role: 'user', content: 'DJを始めたい' }, { role: 'assistant', content: '前の答え' }, { role: 'user', content: 'PDFを結合する方法は？' },
  ];
  for (const [choice, expected] of [['ja', w => vm.runInContext('REPLY_LANGUAGE.ja', w.ctx)], ['en', w => vm.runInContext("REPLY_LANGUAGE.named('English')", w.ctx)]]) {
    const { w, sent, text } = await chatWithJev(() => jevReply(choice), messages, { context: '状況説明です', suggest: true });
    assert.match(text, /event: done/);
    assert.equal(sent.length, 1, '判定は1回だけ');
    assert.deepEqual(sent[0].state, { earlier_messages: ['DJを始めたい'], latest_message: 'PDFを結合する方法は？' });
    assert.equal(sent[0].model, 'jev-latest');
    assert.ok(!JSON.stringify(sent[0]).includes('状況説明') && !JSON.stringify(sent[0]).includes('前の答え'));
    const note = expected(w);
    for (const call of w.calls) assert.ok(call.messages.some(m => typeof m.content === 'string' && m.content.includes(note)), `${choice}: 全員に同じ指定`);
    assert.ok(!w.calls.some(c => JSON.stringify(c).includes('main language of the user')), '汎用の指示は使わない');
  }
});

test('Jev の失敗・言語の無い発言・低い確信・キー未設定では手元の規則に戻す', async () => {
  const messages = [{ role: 'user', content: 'PDFを結合する方法は？' }];
  for (const reply of [() => new Response('down', { status: 500 }), () => jevReply('other'), () => jevReply('ja', 0.3), () => jevReply('xx'), () => Response.json({})]) {
    const { w, sent, text } = await chatWithJev(reply, messages);
    assert.match(text, /event: done/);
    assert.equal(sent.length, 1);
    const fallback = vm.runInContext('REPLY_LANGUAGE.note', w.ctx)('PDFを結合する方法は？');
    assert.ok(w.calls.every(c => c.messages.some(m => typeof m.content === 'string' && m.content.includes(fallback))));
  }
  let jev = 0;
  const w = worker(completion(), url => { if (url.startsWith('https://api.typesafe.ai/')) jev++; });
  assert.match(await (await w.chat(messages)).text(), /event: done/);
  assert.equal(jev, 0, 'キーが無ければ呼ばない');
});

test('IP上限・全体上限・DB失敗で断るときは並行開始した分類を中止し、人格を呼ばない', async () => {
  for (const failure of ['ip', 'global', 'db']) {
    let aborted = 0, classificationCalls = 0;
    const w = worker(completion(), (url, options) => {
      if (url !== 'https://api.typesafe.ai/v1/systemone') return;
      classificationCalls++;
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => {
        aborted++; reject(new DOMException('aborted', 'AbortError'));
      }, { once: true }));
    });
    w.env.MAGI_TYPESAFE_API_KEY = 'test';
    w.env.DB = failure === 'db' ? { prepare() { throw new Error('DB unavailable'); } } : counts();
    if (failure === 'ip') w.ctx.defaults.daily_limit = 0;
    if (failure === 'global') w.ctx.defaults.global_daily_limit = 0;
    const res = await w.chat([{ role: 'user', content: 'q' }]);
    assert.equal(res.status, failure === 'db' ? 500 : 429, failure);
    await tick();
    assert.equal(classificationCalls, 1, failure); assert.equal(aborted, 1, failure);
    assert.equal(w.calls.length, 0, failure);
  }
});

test('分類はDBの確認中に進み、確認が済むまでSSEと人格の処理を始めない', async () => {
  let classified = false, releaseDb, enteredDb;
  const entered = new Promise(resolve => { enteredDb = resolve; });
  const held = new Promise(resolve => { releaseDb = resolve; });
  const w = worker(completion(), url => {
    if (url !== 'https://api.typesafe.ai/v1/systemone') return;
    classified = true; return jevReply('en');
  });
  w.env.MAGI_TYPESAFE_API_KEY = 'test';
  const db = counts();
  w.env.DB = { prepare(sql) { const stmt = db.prepare(sql); return {
    bind(...args) { stmt.bind(...args); return this; },
    async first() { enteredDb(); await held; return stmt.first(); },
    run() { return stmt.run(); },
  }; } };
  const pending = w.chat([{ role: 'user', content: 'Please help me.' }]);
  await entered; await tick();
  assert.equal(classified, true); assert.equal(w.calls.length, 0);
  assert.equal(db.rows.size, 0);
  releaseDb();
  assert.match(await (await pending).text(), /event: done/);
  assert.ok(w.calls.length > 0);
});

test('DBの確認中の接続切断でも分類を中止し、後から人格を呼ばない', async () => {
  let aborted = false, releaseDb, enteredDb;
  const entered = new Promise(resolve => { enteredDb = resolve; });
  const held = new Promise(resolve => { releaseDb = resolve; });
  const w = worker(completion(), (url, options) => {
    if (url !== 'https://api.typesafe.ai/v1/systemone') return;
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => {
      aborted = true; reject(new DOMException('aborted', 'AbortError'));
    }, { once: true }));
  });
  w.env.MAGI_TYPESAFE_API_KEY = 'test';
  w.env.DB = { prepare() { return {
    bind() { return this; },
    async first() { enteredDb(); await held; return { count: 1 }; },
  }; } };
  const controller = new AbortController();
  const pending = w.ctx.worker.fetch(new Request('https://workers.tk.st/magi2/chat', {
    method: 'POST', headers: { Origin: 'https://tk.st', 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Please help me.' }] }), signal: controller.signal,
  }), w.env, { waitUntil(p) { w.waits.push(p); } });
  await entered;
  controller.abort(); await tick(); assert.equal(aborted, true);
  releaseDb();
  assert.equal(await (await pending).text(), '');
  assert.equal(w.calls.length, 0);
});

const classifiedReply = (overrides = {}) => Response.json({ answers: {
  language: { choice: 'en', confidence: .99 }, votable: { choice: 'no', confidence: .99 },
  intent: { choice: 'consult', confidence: .99 }, site_pages: { choice: 'no', confidence: .99 }, ...overrides,
} });
const classifiedEvents = text => [...text.matchAll(/event: (\w+)\ndata: (.+)/g)].map(m => ({ name: m[1], data: JSON.parse(m[2]) }));

test('新契約の初回4問・継続3問は本文だけを送り、言語を引き継ぐ', async () => {
  const sent = [];
  const w = worker(undefined, (url, options) => {
    if (url.includes('api.typesafe.ai')) { sent.push(JSON.parse(options.body)); return classifiedReply(); }
  });
  w.env.MAGI_TYPESAFE_API_KEY = 'test';
  const body = { classification_state: true, ui_language: 'en', language_seed: 'Please help with a decision.',
    context: 'PRIVATE_CONTEXT', messages: [{ role: 'user', content: '日本語の最新の相談です。' }] };
  const first = classifiedEvents(await (await w.request('/magi2/chat', body)).text());
  const notice = first[0];
  assert.equal(notice.name, 'classification');
  assert.deepEqual(notice.data.reply_language, { version: 1, code: 'en', source: 'jev' });
  assert.equal(notice.data.magi_candidate, false);
  assert.deepEqual(Object.keys(sent[0].questions), ['language', 'votable', 'intent', 'site_pages']);
  assert.equal(sent[0].state.language_seed, body.language_seed);
  assert.ok(!JSON.stringify(sent[0]).includes('PRIVATE_CONTEXT'));
  await (await w.request('/magi2/chat', { ...body, reply_language: notice.data.reply_language, language_seed: undefined,
    messages: [{ role: 'user', content: '今度は音楽ではなく普通の話です。' }] })).text();
  assert.deepEqual(Object.keys(sent[1].questions), ['votable', 'intent', 'site_pages']);
  assert.equal(sent[1].state.language_seed, undefined);
});

test('分類は問いごとに閾値と有限数を検査し、失敗しても初回の言語を固定する', async () => {
  const w = worker();
  for (const confidence of [.6999, .7, .7001, 1, '0.7', null, NaN, Infinity, -1, 1.1]) {
    const got = w.ctx.acceptedChoice('votable', { choice: 'yes', confidence });
    assert.equal(got, typeof confidence === 'number' && Number.isFinite(confidence) && confidence >= .7 && confidence <= 1 ? 'yes' : null);
  }
  assert.equal(w.ctx.acceptedChoice('intent', { choice: 'music', confidence: .5 }), 'music');
  for (const [seed, ui, code, source] of [['日本語の相談です。', 'en', 'ja', 'rule'], ['Please help me.', 'ja', 'other', 'sample'], ['OK', 'en', 'en', 'ui'], ['', 'ja', 'ja', 'ui']]) {
    const language = w.ctx.fixedLanguage(seed, ui);
    assert.equal(language.code, code); assert.equal(language.source, source);
    assert.ok(w.ctx.cleanReplyLanguage(language));
  }
  for (const value of [{ version: 1, code: 'xx', source: 'jev' }, { version: 1, code: 'ja', source: 'sample' },
    { version: 1, code: 'fr', source: 'ui' }, { version: 1, code: 'other', source: 'sample', sample: 'a\u202Eb' }]) assert.equal(w.ctx.cleanReplyLanguage(value), null);
});

test('site/musicは2回討議、consultは従来の判定、旧DJは現行契約を維持する', async () => {
  for (const intent of ['site', 'music', 'consult']) {
    const w = worker(undefined, (url, options) => {
      if (url.includes('api.typesafe.ai')) return classifiedReply({ intent: { choice: intent, confidence: .99 } });
      const payload = options?.body && JSON.parse(options.body);
      if (payload?.response_format?.json_schema?.name === 'debate_judge') return searchReply({ assessment: 'ready', action: 'answer', questions: [] });
    });
    w.env.MAGI_TYPESAFE_API_KEY = 'test';
    const text = await (await w.request('/magi2/chat', { classification_state: true, ui_language: 'en', adaptive_debate: true,
      messages: [{ role: 'user', content: 'Help me with this.' }] })).text();
    assert.match(text, /event: done/);
    assert.equal(classifiedEvents(text).filter(e => e.name === 'persona').length, 6);
    assert.equal(classifiedEvents(text).some(e => e.name === 'judge'), intent === 'consult');
    assert.equal(w.calls.some(c => JSON.stringify(c).includes('【音楽・DJ・選曲の相談】')), intent === 'music');
  }
  const { sent, text } = await chatWithJev(() => jevReply('ja'), [{ role: 'user', content: '曲を相談したい' }], { entry: 'dj-request' });
  assert.deepEqual(Object.keys(sent[0].questions), ['language']); assert.doesNotMatch(text, /event: classification/);
});

test('新DJはmusic/no/no固定で初回だけ言語を聞き、継続時はJevを呼ばない', async () => {
  const sent = [];
  const w = worker(undefined, (url, options) => {
    if (url.includes('api.typesafe.ai')) { sent.push(JSON.parse(options.body)); return classifiedReply(); }
  });
  w.env.MAGI_TYPESAFE_API_KEY = 'test';
  const body = { entry: 'dj-request', classification_state: true, ui_language: 'ja', context: 'PRIVATE_DJ_CONTEXT',
    language_seed: 'Please recommend music.', messages: [{ role: 'user', content: 'この曲に賛成？' }] };
  const events = classifiedEvents(await (await w.request('/magi2/chat', body)).text());
  const notice = events[0].data;
  assert.equal(notice.intent, 'music'); assert.equal(notice.votable, 'no'); assert.equal(notice.site_pages, 'no');
  assert.deepEqual(Object.keys(sent[0].questions), ['language']);
  assert.deepEqual(sent[0].state, { language_seed: body.language_seed });
  await (await w.request('/magi2/chat', { ...body, reply_language: notice.reply_language })).text();
  assert.equal(sent.length, 1);
});

test('site_pagesの拒否とmusicでは索引や一覧を送らず、siteは検証済み候補を討議前に渡す', async () => {
  for (const [intent, choice] of [['site', 'yes'], ['site', 'no'], ['consult', 'no'], ['music', 'yes']]) {
    let indexCalls = 0;
    const w = enableSearch(worker(undefined, (url, options) => {
      if (url.endsWith('/site-search.json')) { indexCalls++; return Response.json(guideIndex); }
      if (url.includes('api.typesafe.ai')) return classifiedReply({ intent: { choice: intent, confidence: .99 }, site_pages: { choice, confidence: .99 } });
    }));
    w.env.MAGI_TYPESAFE_API_KEY = 'test';
    const text = await (await w.request('/magi2/chat', { classification_state: true, page: '/', site_pages: true,
      messages: [{ role: 'user', content: 'PDFをまとめたいです。' }] })).text();
    assert.match(text, /event: done/);
    assert.equal(indexCalls > 0, intent === 'site' && choice === 'yes');
    assert.equal(w.calls.some(c => c.response_format?.json_schema?.name === 'site_chat'), intent === 'site' && choice === 'yes');
    assert.equal(/event: pages/.test(text), intent === 'site' && choice === 'yes');
    const personalities = w.calls.filter(c => !c.stream && !c.response_format && c.max_completion_tokens !== 48);
    if (intent === 'site' && choice === 'yes') assert.ok(personalities.every(c => JSON.stringify(c).includes('PDF Studio')));
    else assert.ok(!w.calls.some(c => JSON.stringify(c).includes('サイトのページ一覧')));
  }
});

test('新契約は呼んでいない第2回のabsentを補わず、単独応答も判定せず統合する', async () => {
  const w = worker(undefined, url => /deepseek|googleapis/.test(url) ? new Response('unavailable', { status: 400 }) : undefined);
  const events = classifiedEvents(await (await w.request('/magi2/chat', { classification_state: true, adaptive_debate: true,
    messages: [{ role: 'user', content: 'Help me think.' }] })).text());
  assert.equal(events.filter(e => e.name === 'persona').length, 3);
  assert.equal(events.filter(e => e.name === 'persona' && e.data.round !== 1).length, 0);
  assert.equal(events.some(e => ['ask', 'judge'].includes(e.name)), false);
  assert.equal(events.at(-1).name, 'done');
});

test('404の対応通知の欠落・重複・不正値はAIも回数も使わず、新通知は共通討議8回を使う', async () => {
  const w = enableSearch(worker());
  for (const [suffix, status] of [['', 409], ['?site_debate=0', 400], ['?site_debate=1&site_debate=1', 400], ['?site_debate=1&mode=site', 400]]) {
    const res = await w.request('/magi2/site-search' + suffix, { query: 'PDFをまとめたい', locale: 'ja' });
    assert.equal(res.status, status);
    if (status === 409) assert.equal((await res.json()).error.retryable, false);
  }
  assert.equal(w.calls.length, 0); assert.equal(w.env.DB.rows.size, 0);
  const res = await searchRequest(w); assert.equal(res.status, 200);
  assert.equal(w.calls.length, 8); assert.equal(w.calls.at(-1).reasoning_effort, 'medium');
  assert.equal((await res.json()).comment, 'answer');
});

test('画面の共通分類処理は3画面で一致し、順序違反を拒否し、旧Workerと未知イベントを受け止める', async () => {
  const block = src => between(src, '// AGENT_CLASSIFY_BEGIN', '// AGENT_CLASSIFY_END');
  assert.equal(block(home), block(mobile)); assert.equal(block(home), block(dj));
  const ctx = vm.createContext({ TextDecoder });
  vm.runInContext(block(home) + '\n' + between(home, 'async function parseSSE(', '// --- マルチモーダル入力'), ctx);
  const notice = { version: 1, intent: 'consult', site_pages: 'no', votable: 'no', magi_candidate: false,
    reply_language: { version: 1, code: 'en', source: 'ui' } };
  for (const sequence of [event('classification', notice) + event('classification', notice),
    event('persona', {}) + event('classification', notice), event('motion', {})]) {
    await assert.rejects(ctx.parseSSE(new Response(sequence).body, {}), /invalid_classification|unexpected_magi_event/);
  }
  let received = 0;
  await ctx.parseSSE(new Response('event: future\ndata: invalid JSON\n\n' + event('title', {}) + event('classification', notice)
    + event('integrated', { delta: 'answer' }) + event('done', {}) + event('classification', notice)).body, { classification() { received++; } });
  assert.equal(received, 1);
  const history = [{ role: 'user', content: 'First sentence.' }, { role: 'user', content: 'Different language.' }];
  assert.equal(ctx.classificationFields(history, null, 'en').language_seed, 'First sentence.');
  assert.equal(ctx.classificationFields(history, notice.reply_language, 'ja').language_seed, undefined);
});


test('回答が失敗しても受信済みの会話言語を保存し、次の送信で判定し直さない', async () => {
  const language = { version: 1, code: 'en', source: 'jev' };
  for (const [src, isHome] of [[mobile, false], [home, true]]) {
    const c = client(src, isHome), bodies = [], stored = new Map();
    c.ctx.safeStore = (key, value) => { stored.set(key, value); };
    vm.runInContext(between(src, 'function saveAgentLanguage(', 'function archiveCurrentHistory('), c.ctx);
    c.ctx.fetch = async (_, options) => { bodies.push(JSON.parse(options.body)); return { ok: true, body: {} }; };
    c.ctx.parseSSE = async (_, handlers) => { handlers.classification({ reply_language: language }); throw new Error('connection failed'); };
    await c.ctx.agentSend();
    assert.equal(c.ctx.agentHistory.length, 0);
    assert.equal(stored.get('magi_current_language').id, 'test-session');
    assert.equal(stored.get('magi_current_language').reply_language.code, 'en');
    c.ctx.agentInput.value = '日本語で続ける';
    c.ctx.parseSSE = async (_, handlers) => { handlers.integrated({ delta: 'answer' }); handlers.done(); };
    await c.ctx.agentSend();
    assert.deepEqual(bodies[1].reply_language, language);
    assert.equal(Object.hasOwn(bodies[1], 'language_seed'), false);
    const helper = isHome ? between(src, 'const personaCardsHTML =', 'const agentTurnEl =') : between(src, 'function personaCardsHTML(', '// トップのインスクリプション');
    // 保存と書き出しに未実施回の印を補わない。
    assert.match(src, /round2 === '…'\) delete debateData\[cn\]\.round2/);
    assert.match(helper, isHome ? /!deb\.round2 \|\| deb\.round2 === '…'/ : /r2has \? '' : ' hidden'/);
  }
});

test('DJの開発用Originはフラグ・Workerホスト・ページOriginの3条件をすべて要求する', () => {
  const ctx = vm.createContext({ URL, ALLOWED_ORIGINS: ['https://tk.st', 'https://www.tk.st'] });
  vm.runInContext(between(read('workers/dj-request/src/index.js'), 'function allowedRequestOrigin(', 'function corsHeaders('), ctx);
  const allow = (origin, host, value) => ctx.allowedRequestOrigin(origin, { url: host + '/dj/api/req/board' }, { DJ_LOCAL_DEV: value });
  for (const host of ['http://localhost:8788', 'http://127.0.0.1:8788', 'http://[::1]:8788']) assert.equal(allow('http://localhost:8000', host, 'true'), true);
  for (const flag of [undefined, 'false', true]) assert.equal(allow('http://localhost:8000', 'http://localhost:8788', flag), false);
  assert.equal(allow('http://localhost:8000', 'http://tk.st', 'true'), false);
  for (const origin of ['http://127.0.0.1:8000', 'http://localhost.attacker.test', 'null']) assert.equal(allow(origin, 'http://localhost:8788', 'true'), false);
  assert.equal(allow('https://tk.st', 'https://tk.st', undefined), true);
});

test('DJの接続先上書きはlocalhostページで独立に検査し、資格情報・外部ホスト・パスを拒否する', () => {
  const ctx = vm.createContext({ URL, URLSearchParams, location: { protocol: 'http:', hostname: 'localhost', search: '' } });
  vm.runInContext(between(dj, 'function localApiOrigin(', 'const API ='), ctx);
  for (const dest of ['http://127.0.0.1:8787', 'http://[::1]:8787', 'http://localhost:8787']) {
    ctx.location.search = '?api=' + encodeURIComponent(dest); assert.equal(ctx.localApiOrigin('api', 'production'), dest);
  }
  for (const dest of ['https://external.test', 'http://user:pass@localhost:8787', 'http://localhost:8787/path', 'http://localhost:8787/?x=1', 'http://localhost:8787/#a']) {
    ctx.location.search = '?api=' + encodeURIComponent(dest); assert.equal(ctx.localApiOrigin('api', 'production'), 'production');
  }
  ctx.location.search = '?api=http://localhost:8787&req_api=https://external.test';
  assert.equal(ctx.localApiOrigin('api', 'production'), 'http://localhost:8787'); assert.equal(ctx.localApiOrigin('req_api', ''), '');
  ctx.location.hostname = 'tk.st'; assert.equal(ctx.localApiOrigin('api', 'production'), 'production');
});

test('要求されたページ選びに失敗したら候補なしと説明せず、未完了のDJ相談の言語も復元対象にする', async () => {
  const w = worker(undefined, (url, options) => {
    if (String(url).includes('api.typesafe.ai')) return classifiedReply({ intent: { choice: 'site', confidence: .99 }, site_pages: { choice: 'yes', confidence: .99 } });
    if (!String(url).includes('api.openai.com')) return;
    const body = JSON.parse(options.body);
    if (body.response_format?.json_schema?.name === 'site_chat') return new Response('failed', { status: 500 });
  });
  enableSearch(w); w.env.MAGI_TYPESAFE_API_KEY = 'test';
  await (await w.request('/magi2/chat', { classification_state: true, site_pages: true, page: '/', messages: [{ role: 'user', content: 'Find a tool.' }] })).text();
  assert.equal(w.calls.filter(b => b.stream).length, 1);
  assert.equal(w.calls.filter(b => b.messages && !b.stream && !b.response_format && b.max_completion_tokens !== 48).every(b => JSON.stringify(b.messages).includes('候補が存在しないとは判断できない')), true);
  assert.match(dj, /c\.turns\.length \|\| c\.reply_language/);
});


test('会話IDがない言語メタデータは新しい会話へ引き継がない', () => {
  for (const src of [home, mobile]) {
    const ctx = vm.createContext({ currentSessionId: null,
      safeGet: () => JSON.stringify({ id: null, reply_language: { version: 1, code: 'en', source: 'ui' } }),
      safeParse: JSON.parse });
    vm.runInContext(between(src, '// AGENT_CLASSIFY_BEGIN', '// AGENT_CLASSIFY_END'), ctx);
    vm.runInContext(between(src, 'var agentLanguageMeta =', 'function ensureAgentConversation('), ctx);
    assert.equal(ctx.agentReplyLanguage, null);
  }
});

test('Geminiの試行と429は用途別に匿名で数え、記録失敗で回答を止めない', async () => {
  let googleCalls = 0;
  const w = worker(undefined, (url) => {
    if (!String(url).includes('generativelanguage.googleapis.com')) return;
    googleCalls++;
    if (googleCalls === 1) return new Response('rate limit', { status: 429 });
  });
  const rows = new Map();
  w.env.DB = { prepare(sql) { return { bind(key, day, limit) { return { async first() {
    if (key.startsWith('usage:google:')) {
      assert.match(key, /^usage:google:(chat|404):(attempt|limited)$/);
      assert.match(day, /^\d{4}-\d{2}-\d{2}$/); assert.equal(limit, Number.MAX_SAFE_INTEGER);
      rows.set(key, (rows.get(key) || 0) + 1);
    }
    return { count: 1 };
  } }; } }; } };
  const first = await w.chat([{ role: 'user', content: 'Hello' }]);
  assert.match(await first.text(), /event: done/); await Promise.all(w.waits);
  assert.equal(rows.get('usage:google:chat:attempt'), googleCalls);
  assert.equal(rows.get('usage:google:chat:limited'), 1);
  // 入口が設定する実際の記録フックも実行する。失敗はwaitUntil内で吸収する。
  w.env.DB = { prepare() { return { bind(key) { return { first() { return key.startsWith('usage:google:')
    ? Promise.reject(new Error('database unavailable')) : Promise.resolve({ count: 1 }); } }; } }; } };
  const response = await w.chat([{ role: 'user', content: 'Hello' }]);
  assert.match(await response.text(), /event: done/); await Promise.all(w.waits);
});

test('文字数指定を外した人格の長い応答で次の討議入力を膨らませない', async () => {
  const w = worker(undefined, (url, options) => {
    if (!options?.body) return;
    const body = JSON.parse(options.body);
    if (!body.stream && !body.response_format && [512, 1024].includes(body.max_tokens || body.max_completion_tokens)) {
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '家'.repeat(5000) } }] });
    }
  });
  const text = await (await w.chat([{ role: 'user', content: 'Help me think.' }])).text();
  const events = [...text.matchAll(/event: persona\ndata: (.+)/g)].map(m => JSON.parse(m[1]));
  assert.equal(events.length, 6);
  assert(events.every(e => e.text.length === w.ctx.defaults.persona_response_max_chars));
  assert.match(text, /event: done/);
});

test('言語sampleはWorkerと3画面で全12双方向制御を拒否し、通常の文字は引き継ぐ', async () => {
  const w = worker();
  const controls = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
  const sample = text => ({ version: 1, code: 'other', source: 'sample', sample: text });
  for (const src of [home, mobile, dj]) {
    const ctx = vm.createContext({ TextDecoder });
    vm.runInContext(between(src, '// AGENT_CLASSIFY_BEGIN', '// AGENT_CLASSIFY_END'), ctx);
    for (const code of controls) {
      const value = sample('α' + String.fromCodePoint(code) + 'β');
      assert.equal(w.ctx.cleanReplyLanguage(value), null);
      assert.equal(ctx.cleanReplyLanguage(value), null);
      assert.equal(ctx.classificationFields([], value, 'en').reply_language, undefined);
      assert.throws(() => ctx.receiveClassification({ started: false, classified: false }, 'classification', {
        version: 1, intent: 'consult', votable: 'no', site_pages: 'no', magi_candidate: false, reply_language: value,
      }), /invalid_classification/);
    }
    for (const text of ['مرحبا بالعالم', 'α\u200dβ']) {
      assert.equal(w.ctx.cleanReplyLanguage(sample(text)).sample, text);
      assert.equal(ctx.cleanReplyLanguage(sample(text)).sample, text);
    }
  }
  const fallback = w.ctx.fixedLanguage('مرحبا\u061c بالعالم', 'en');
  assert.equal(fallback.code, 'en'); assert.equal(fallback.source, 'ui');
});

test('PWAの初回キャッシュとHTMLは同じ版のアプリJSを読む', () => {
  const html = read('magi-app/www/index.html'), sw = read('magi-app/www/sw.js');
  const version = html.match(/src="app\.js\?v=([^"]+)"/)[1];
  assert.ok(sw.includes('./app.js?v=' + version));
});


test('トップページとアプリは保存が禁止されても同じ会話の言語をメモリで引き継ぐ', async () => {
  const language = { version: 1, code: 'en', source: 'jev' };
  for (const [src, isHome] of [[home, true], [mobile, false]]) {
    const c = client(src, isHome), bodies = [];
    c.ctx.localStorage = {
      getItem() { throw new DOMException('blocked', 'SecurityError'); },
      setItem() { throw new DOMException('blocked', 'SecurityError'); },
      removeItem() { throw new DOMException('blocked', 'SecurityError'); },
    };
    const helpers = isHome
      ? between(src, '    const safeParse =', '    const verBadge =')
      : between(src, 'function safeParse(', 'var genMid');
    // 保存の安全ラッパーと実際の言語保存処理を使う。DOMと通信だけを差し替える。
    vm.runInContext(helpers + '\n' + between(src, 'function saveAgentLanguage(', 'function archiveCurrentHistory('), c.ctx);
    c.ctx.fetch = async (_, options) => { bodies.push(JSON.parse(options.body)); return { ok: true, body: {} }; };
    c.ctx.parseSSE = async (_, handlers) => {
      if (bodies.length === 1) handlers.classification({ reply_language: language });
      handlers.integrated({ delta: 'answer' }); handlers.done();
    };
    await c.ctx.agentSend();
    c.ctx.agentInput.value = '日本語で続きを相談する';
    await c.ctx.agentSend();
    assert.deepEqual(bodies[1].reply_language, language);
    assert.equal(Object.hasOwn(bodies[1], 'language_seed'), false);
    assert.equal(c.errors.length, 0);
  }
});


test('アプリの保存言語の復元時には、言語コード一覧が初期化されている', () => {
  const end=mobile.indexOf('function ensureAgentConversation(');
  const prefix=mobile.slice(0,end);
  const c=vm.createContext({URL,URLSearchParams,AbortController,setTimeout,clearTimeout,
    ResizeObserver:class { observe(){} },
    window:{},location:{protocol:'http:',hostname:'localhost',search:''},
    document:{getElementById:()=>({...element(),addEventListener(){}})},
    localStorage:{getItem(key){return key==='magi_current_session_id'?'saved':key==='magi_current_language'
      ?JSON.stringify({id:'saved',reply_language:{version:1,code:'en',source:'ui'}}):null;}}
  });
  vm.runInContext(prefix,c);assert.equal(c.agentReplyLanguage.code,'en');
});
