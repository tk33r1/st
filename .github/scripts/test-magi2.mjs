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
      if (/^https:\/\/tk\.st\/data\/(tools|game|glitch)\.json$/.test(url)) return Response.json(JSON.parse(read('data/' + url.split('/').at(-1))));
      const body = JSON.parse(options.body); calls.push(body);
      if (body.response_format?.type === 'json_schema') return Response.json({ choices: [{ message: { content: JSON.stringify({ selections: ['tool:7'], ...(body.response_format.json_schema.name === 'site_search' ? { comment: 'PDF Studioでまとめられます。' } : {}), daily: null }) }, finish_reason: 'stop' }] });
      return body.stream ? new Response(stream) : Response.json({ choices: [{ message: { content: 'opinion' }, finish_reason: 'stop' }] });
    },
  });
  const strip = s => s.replace(/^import .*;\r?\n/gm, '').replace(/export const /g, 'const ').replace(/export (?=(?:async )?function)/g, '');
  vm.runInContext(strip(read('workers/magi2/personas.js')) + '\n'
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
const searchRequest = (w, body = { query: 'PDFをまとめたい', locale: 'ja' }, ip) => w.request('/magi2/site-search', body, ip);
const searchReply = (value, finish = 'stop', refusal = null) => Response.json({ choices: [{ finish_reason: finish, message: { content: typeof value === 'string' ? value : JSON.stringify(value), refusal } }] });
const validSearch = { selections: ['tool:7'], comment: '私のPDF Studioでまとめられます。(>_<)', daily: null };

test('出力言語は混在文を日本語に固定せず、記号や短い返答では直前の言語を維持する', () => {
  const w = worker();
  const ja = vm.runInContext('REPLY_LANGUAGE.ja', w.ctx);
  const note = vm.runInContext('REPLY_LANGUAGE.note', w.ctx);
  const user = content => ({ role: 'user', content });
  for (const text of ['個人情報保護方針について教えて', 'この曲はどうですか？', 'ｺﾉｷｮｸﾊﾄﾞｳ？']) {
    assert.equal(w.ctx.replyLanguageNote([user(text)]), ja);
  }
  for (const text of ['What do you think of サカナクション?', 'What does 「こんにちは」 mean in English?',
    'Which sounds better: jazz・funk or house?', 'PDFを結合する方法は？', '你好', '안녕하세요']) {
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
  assert.equal((await w.request('/magi2/site-search', '{}', undefined, { 'Content-Type': 'text/plain' })).status, 400);
  assert.equal((await w.request('/magi2/site-search', '{}', undefined, { Origin: 'https://outside.example' })).status, 401);
  w.env.SITE_SEARCH_ENABLED = 'false'; assert.equal((await searchRequest(w)).status, 503);
  assert.equal(w.calls.length, 0); assert.equal(w.env.DB.rows.size, 0);
  w.env.SITE_SEARCH_ENABLED = 'true'; const db = w.env.DB; delete w.env.DB;
  assert.equal((await searchRequest(w)).status, 503); w.env.DB = db;
  const broken = enableSearch(worker(undefined, url => url.endsWith('/game.json') ? Response.json({}) : undefined));
  assert.equal((await searchRequest(broken)).status, 503); assert.equal(broken.env.DB.rows.size, 0); assert.equal(broken.calls.length, 0);
  const res = await searchRequest(w), body = await res.json();
  assert.equal(res.status, 200); assert.equal(res.headers.get('Cache-Control'), 'no-store'); assert.ok(body.request_id);
  assert.equal(body.results[0].title, 'PDF Studio'); assert.equal(body.results[0].url, '/tools/pdf-studio/');
  const call = w.calls.at(-1); assert.equal(call.max_completion_tokens, 300); assert.equal(call.temperature, .4);
  assert.equal(call.reasoning_effort, 'none'); assert.equal(call.response_format.json_schema.strict, true);
});

test('検索のIP上限を超えた要求は全体を進めず、通常チャットとは別に数える', async () => {
  const w = enableSearch(worker()), day = new Date().toISOString().slice(0, 10);
  const responses = await Promise.all(Array.from({ length: 14 }, () => searchRequest(w)));
  assert.equal(responses.filter(r => r.status === 200).length, 10);
  assert.equal(responses.filter(r => r.status === 429).length, 4);
  assert.equal(w.env.DB.rows.get('search:global|' + day), 10);
  assert.equal(w.env.DB.rows.get('search:192.0.2.1|' + day), 10);
  assert.equal(w.calls.length, 10); assert.equal(w.env.DB.rows.has('global|' + day), false);
  assert.match(await (await w.chat([{ role: 'user', content: 'q' }])).text(), /event: done/);
  assert.equal(w.env.DB.rows.get('global|' + day), 1); assert.equal(w.env.DB.rows.get('search:global|' + day), 10);
  w.ctx.searchConfig.global_daily_limit = 10;
  assert.equal((await searchRequest(w, undefined, '192.0.2.2')).status, 429);
  assert.equal(w.env.DB.rows.get('search:192.0.2.2|' + day), 1);
  assert.equal(w.env.DB.rows.get('search:global|' + day), 10);
});

test('AIの未知ID・日刊の不正値・コメントの記号を検証し、実在するURLだけを作る', () => {
  const w = worker(), pages = w.ctx.makeSitePages(['tools', 'game', 'glitch'].map(name => JSON.parse(read('data/' + name + '.json'))));
  assert.equal(pages.length, ['tools', 'game', 'glitch'].map(name => { const data = JSON.parse(read('data/' + name + '.json')); return (data.articles || data).length; }).reduce((a, b) => a + b, 11));
  const html = read('404.html');
  for (const [id, url, ja, en, descJa, descEn] of w.ctx.searchConfig.pages) {
    const link = html.match(new RegExp('<a[^>]*data-entry="' + id + '"[^>]*>'))[0];
    for (const [attribute, value] of [['href', url], ['data-title-ja', ja], ['data-title-en', en], ['data-description-ja', descJa], ['data-description-en', descEn]]) assert.ok(link.includes(attribute + '="' + value + '"'));
  }
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
  for (const raw of ['https://outside.example/tools/a/', 'https://tk.st/tools/a/?q=x', 'https://tk.st/tools/a/#x', 'https://tk.st/tools/%3Fbad/', 'https://tk.st/tools/%5Cbad/', 'https://user@tk.st/tools/a/', 'https://tk.st/game/a/']) assert.equal(w.ctx.siteHref(raw, 'tools'), null);
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
  const w = enableSearch(worker(undefined, url => broken && url.endsWith('/game.json') ? Response.json({}) : undefined));
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
      await c.ctx.agentSend(); assert.equal(outbound[0].site_pages, true);
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
    const ctx = vm.createContext({ TextDecoder }); vm.runInContext(between(src, 'async function parseSSE(', end), ctx);
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
  return { dataset: {}, style: {}, classList: { add() {}, remove() {}, contains() { return false; } }, querySelector: element, querySelectorAll: () => [], appendChild() {}, remove() {}, focus() {} };
}
function client(src, isHome = false) {
  const timers = new Map(), errors = [];
  const ctx = vm.createContext({
    AbortController, JSON, TextDecoder, console: { error() {} }, window: {}, AGENT_API: 'mock', AGENT_MAX_HISTORY: 12, AGENT_PERSONAS: [],
    setTimeout(fn, ms) { const id = {}; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
    document: { createElement: element, documentElement: { getAttribute: () => 'light' } },
    agentLog: { ...element(), children: [] }, agentInput: { ...element(), value: 'q' }, agentSendBtn: element(), attachBtn: element(), agentDegraded: element(),
    agentHistory: [], agentBusy: false, agentDead: false, agentGen: 0, agentCtrl: null, attachments: [], attachNotice: '', pendingReactions: {},
    localStorage: { removeItem() {} }, genMid: () => 'm1', setAgentSuggestion() {}, fitAgentInput() {}, renderAttachTray() {}, userContentHTML: () => '',
    userBubbleEl: element, agentTurnEl: element, splashOnly: () => false, isDarkNow: () => false, cssEsc: s => s, tr: s => s, announceAgent() {},
    personaCardsHTML: () => '', reactionBarHTML: () => '', agentScroll() {}, safeStore() {}, safeRemove() {}, saveCurrentHistory() {}, syncCurrentToSaved() {}, updateAgentActionButtons() {},
    archiveCurrentHistory() {}, closeAgentPanels() {}, setAgentTitle() {}, showSplashIfEmpty() {}, renderAgentPages() {}, renderAgentError(e) { errors.push(e); }, agentDegrade() {}, setAgentInputEnabled(enabled) { ctx.agentInput.disabled = !enabled; },
  });
  vm.runInContext(between(src, 'function prepareAgentMessages(', isHome ? 'agentSendBtn.addEventListener(' : '// ---- Reaction network'), ctx);
  return { ctx, timers, errors };
}

test('両画面はdone欠落を保存せず、開始後の無通信で入力を戻す', async () => {
  for (const [src, isHome] of [[mobile, false], [home, true]]) {
    const c = client(src, isHome);
    c.ctx.fetch = async () => ({ ok: true, body: {} });
    c.ctx.parseSSE = async (_, handlers) => { assert.equal([...c.timers.values()][0].ms, 70000); handlers.integrated({ delta: 'partial' }); };
    await c.ctx.agentSend();
    assert.equal(c.ctx.agentHistory.length, 0); assert.equal(c.errors.at(-1).code, 'incomplete_reply'); assert.equal(c.timers.size, 0);
    c.ctx.agentInput.value = 'retry';
    c.ctx.parseSSE = async (_, handlers) => { handlers.integrated({ delta: 'complete' }); handlers.done(); };
    await c.ctx.agentSend(); assert.equal(c.ctx.agentHistory.at(-1).content, 'complete');
    c.ctx.agentInput.value = 'stalled';
    c.ctx.fetch = async (_, { signal }) => ({ ok: true, body: { signal } });
    c.ctx.parseSSE = async body => new Promise((_, reject) => body.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    const pending = c.ctx.agentSend(); await tick();
    assert.equal([...c.timers.values()][0].ms, 70000); [...c.timers.values()][0].fn(); await pending;
    assert.equal(c.ctx.agentBusy, false); assert.equal(c.ctx.agentInput.disabled, false); assert.equal(c.errors.at(-1).code, 'timeout'); assert.equal(c.timers.size, 0);
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
    assert.equal(c.ctx.agentHistory.length, 1); assert.equal(c.ctx.agentHistory[0].role, 'user'); assert.equal(c.ctx.agentBusy, false);
  }
});

test('両画面は削除トークンを保存し、登録中の取り消しでもトークン付きで削除する', async () => {
  for (const [src, end] of [[mobile, 'function flashReactBtn('], [home, '// agent-log 内の全クリック']]) {
    const store = {}, posts = [];
    let release;
    const receipt = { id: 7, delete_token: 'a'.repeat(64) };
    let delayed = false;
    const ctx = vm.createContext({ REACT_API: 'mock', reactionStoreFor: () => store, persistReactions() {},
      fetch: async (_, options) => {
        const body = JSON.parse(options.body); posts.push(body);
        if (body.op === 'remove') return Response.json({ ok: true });
        if (delayed) await new Promise(r => { release = r; });
        return Response.json(receipt);
      },
    });
    vm.runInContext(between(src, 'async function sendReaction(', end), ctx);
    ctx.registerReaction({}, 'integrated', '👍', { request: 'q', response: 'a' });
    await tick(); assert.equal(store.integrated.delete_token, receipt.delete_token);
    ctx.unregisterReaction({}, 'integrated');
    assert.equal(posts.at(-1).delete_token, receipt.delete_token);
    const count = posts.length;
    ctx.deleteReaction('integrated', { id: 7 }); assert.equal(posts.length, count);
    delayed = true;
    ctx.registerReaction({}, 'integrated', '👍', { request: 'q', response: 'a' });
    ctx.unregisterReaction({}, 'integrated'); release(); await tick();
    assert.equal(posts.at(-1).op, 'remove'); assert.equal(posts.at(-1).delete_token, receipt.delete_token);
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
