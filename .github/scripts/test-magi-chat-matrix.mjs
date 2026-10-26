// 合成応答。Androidでは模擬プラグインを使わず、別ID APKのOkHttp・Java選別・保存を通す。
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {resolve, dirname, extname, sep} from 'node:path';
import {chromium, _android as playwrightAndroid} from 'playwright';
import {matrix, root, git, sha256, sourceFingerprint, checkContract} from './magi-chat-contract.mjs';

const arg = (name, fallback = '') => process.argv.find(v => v.startsWith('--' + name + '='))?.slice(name.length + 3) || fallback;
const android = process.argv.includes('--android'), adb = arg('adb'), device = arg('device'), apk = arg('apk');
const pkg = 'st.tk.magi.b3probe', nonce = randomBytes(10).toString('hex');
const output = resolve(arg('report', 'workers/.wrangler/magi-chat-gate/' + (android ? 'android' : 'browser') + '.json'));
const report = {schema: 1, kind: android ? 'android' : 'browser', pass: false, commit: git('rev-parse', 'HEAD'),
  fingerprint: sourceFingerprint(), started: new Date().toISOString(), cases: [], paidRequests: 0};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// エミュレーターは導入直後などに一時的にオフラインになる。通信の失敗だけを端末の復帰後にやり直し、
// コマンドの結果や中身の照合はやり直さない（照合の失敗はそのまま検査の失敗にする）。
const transport = error => /device offline|device '[^']*' not found|device not found|no devices|protocol fault|connection reset|closed|ETIMEDOUT/i
  .test(String(error.stderr || '') + ' ' + error.message);
const adbOnce = (args, options = {}) => execFileSync(adb, ['-s', device, ...args],
  {stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 16 * 1024 * 1024, ...options});
function waitDevice() {
  adbOnce(['wait-for-device'], {timeout: 120000});
  const deadline = Date.now() + 120000;
  for (;;) {
    try {
      if (adbOnce(['shell', 'getprop', 'sys.boot_completed'], {encoding: 'utf8'}).trim() === '1'
        && adbOnce(['shell', 'pm', 'path', 'android'], {encoding: 'utf8'}).startsWith('package:')) return;
    } catch (error) { if (!transport(error)) throw error; }
    if (Date.now() > deadline) throw new Error('ADB端末が準備完了にならない');
    pause(1000);
  }
}
function run(...args) {
  for (let attempt = 1; ; attempt++) {
    try { return adbOnce(args, {encoding: 'utf8'}).trim(); }
    catch (error) {
      if (!transport(error) || attempt >= 3) throw error;
      step('adb再接続: ' + args.join(' ')); waitDevice();
    }
  }
}
// 端末から読み戻したAPKが途中で切れたときだけ読み直す。hashの照合は呼び出し側でそのまま行う。
function readInstalledApk(path, size) {
  let bytes = Buffer.alloc(0);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { bytes = adbOnce(['exec-out', 'cat', path], {timeout: 120000}); if (bytes.length === size) return bytes; }
    catch (error) { if (!transport(error) || attempt >= 3) throw error; }
    step('APKの読み戻しをやり直す（' + bytes.length + '/' + size + ' bytes）'); waitDevice();
  }
  return bytes;
}
function step(name) { report.step = name; console.error('[magi-chat-gate] ' + new Date().toISOString() + ' ' + name); }
const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const features = {privacy_contract: 1, personalization: true, temporary_chat: true, temporary_personalization: true, temporary_speech: false, speech: false};
const requests = [], errors = [];
let server, browser, context, page, androidDevice, delayed = false;
function reply(body, transport) {
  const question = body.messages.at(-1).content;
  assert.equal(typeof question, 'string'); assert(question.startsWith('MAGI-GATE-' + nonce + '-'));
  assert.equal(transport, body.conversation_mode === 'temporary' || !android ? 'browser' : 'native');
  requests.push({question, body, transport});
  return (body.privacy_contract ? event('session', {conversation_mode: body.conversation_mode, personalization_applied: !!body.personalization}) : '')
    + event('classification', {version: 1, intent: 'research', mode: 'fact', fresh: 'no', votable: 'no', site_pages: 'no',
      magi_candidate: false, reply_language: {version: 1, code: 'en', source: 'ui'}})
    + event('integrated', {delta: 'ANSWER-' + question}) + event('done', {});
}
async function routes(ctx) {
  // WebViewの一時チャットもWebSocketを使う。HTTPのrouteだけではこの通信を遮断できない。
  // connectToServerは呼ばず、全ソケットをプロセス内の合成応答へ閉じる。
  await ctx.routeWebSocket('**/*', socket => {
    socket.onMessage(text => {
      try {
        const message = JSON.parse(text);
        if (message.type === 'stop') return socket.close();
        assert.equal(message.type, 'chat');
        const stream = reply(message.body, 'browser');
        for (const block of stream.trim().split('\n\n')) {
          const [name, data] = block.split('\n');
          socket.send(JSON.stringify({event: name.slice(7), data: JSON.parse(data.slice(6))}));
        }
      } catch (error) { errors.push(error.message); socket.close(); }
    });
  });
  await ctx.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.hostname === 'workers.tk.st' && url.pathname === '/magi2/models') return route.fulfill({json: {features}});
    if (url.hostname === 'workers.tk.st' && url.pathname === '/magi2/usage') return route.fulfill({json: {used: 0, limit: 60}});
    if (url.hostname === 'workers.tk.st' && url.pathname === '/magi2/chat') return route.fulfill({contentType: 'text/event-stream', body: reply(req.postDataJSON(), 'browser')});
    if (url.hostname === 'localhost' && android) return route.continue(); // WebView同梱資産
    if (url.origin === 'https://tk.st' && !android) {
      const file = resolve(root, '.' + (url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname));
      if (file.startsWith(root + sep) && existsSync(file) && extname(file)) return route.fulfill({body: readFileSync(file),
        contentType: ({'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json'})[extname(file)] || 'application/octet-stream'});
    }
    return route.abort();
  });
}
async function ready() {
  // エミュレーターの初回起動ではWebViewの準備に20秒を超えることがある。準備の条件は変えない。
  await page.waitForFunction(native => typeof agentBusy !== 'undefined' && !agentBusy && (typeof historyLoading === 'undefined' || !historyLoading)
    && (!native || nativeConversation && nativeHistory?.active), android, {timeout: 60000, polling: 100});
}
// 時間制限の無い待ちに上限を付ける。attachの印が付いたものだけを、アプリを起動し直して1回だけやり直す。
class AttachTimeout extends Error {}
function limit(promise, ms, label, Kind = Error) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Kind('時間切れ: ' + label)), ms); })])
    .finally(() => clearTimeout(timer));
}
async function attach() {
  waitDevice();
  if (!androidDevice) {
    step('接続: Playwrightの端末取得');
    const devices = await limit(playwrightAndroid.devices({host: '127.0.0.1', omitDriverInstall: true}), 60000, '端末取得', AttachTimeout);
    androidDevice = devices.find(d => d.serial() === device);
    assert(androidDevice, '指定したADB端末が見つからない');
  }
  step('接続: WebViewの検出');
  const deadline = Date.now() + 60000;
  let view;
  while (!view && Date.now() < deadline) {
    // 起動直後はプロセスがまだ無く、pidofが失敗する。その間は待つ。
    let pid = 0;
    try { pid = Number(run('shell', 'pidof', pkg)); } catch (error) { if (transport(error)) throw error; }
    view = pid && androidDevice.webViews().find(v => v.pkg() === pkg && v.pid() === pid);
    if (!view) await sleep(300);
  }
  if (!view) throw new AttachTimeout('検証用WebViewへ接続できない');
  // 通常Chrome用のCDP接続は、古いWebViewで未対応のBrowser管理命令を使う。
  // PlaywrightのAndroid用接続を使い、ドライバーAPKの追加インストールも行わない。
  step('接続: WebViewのページ取得');
  page = await limit(view.page(), 60000, 'WebViewのページ取得', AttachTimeout); context = page.context(); browser = {close: () => context.close()};
  await routes(context);
  step('接続: 画面の準備完了待ち');
  page.on('pageerror', e => errors.push(e.message)); await ready();
  step('接続: ネイティブプラグインの確認');
  assert.equal(await limit(page.evaluate(() => Capacitor.Plugins.MagiConversation.information()), 60000, 'ネイティブプラグインの応答').then(v => v.test), true);
}
async function connect() {
  try { await attach(); }
  catch (error) {
    if (!(error instanceof AttachTimeout)) throw error;
    // WebViewへのデバッグ接続が応答しないことがある。端末側の接続を作り直し、アプリを起動し直して1回だけ試す。
    step('接続をやり直す（' + error.message + '）');
    const stale = androidDevice; androidDevice = null; page = null;
    await limit(Promise.resolve(stale?.close()), 10000, '古い接続の終了').catch(() => {});
    run('shell', 'am', 'force-stop', pkg); run('shell', 'am', 'start', '-n', pkg + '/st.tk.magi.MainActivity');
    await sleep(1500); await attach();
  }
}
async function send(question, background = false) {
  const before = await page.evaluate(() => ({sequence: agentSendSequence, answers: agentHistory.filter(m => m.role === 'assistant').length}));
  const count = requests.length;
  await page.locator('#agent-input').fill(question);
  // WebViewは端末の描画休止で座標の安定待ちが進まないことがある。送信の実イベントハンドラーを起動する。
  if (android) await page.locator('#agent-send').evaluate(button => button.click());
  else await page.locator('#agent-send').click();
  if (background) return {before, count};
  await page.waitForFunction(({sequence, text}) => agentSendSequence > sequence && !agentBusy && !agentPrivacyState.preparing
    && agentHistory.at(-1)?.content === text, {sequence: before.sequence, text: 'ANSWER-' + question}, {timeout: 15000, polling: 100});
  assert.equal(await page.evaluate(() => agentHistory.filter(m => m.role === 'assistant').length), before.answers + 1);
  assert.equal(await page.locator('.agent-reply-body').last().innerText(), 'ANSWER-' + question);
  assert.equal(requests.length, count + 1, '1回の操作が1回の要求になる');
  const body = requests.at(-1).body;
  assert.equal(body.messages.at(-1).content, question);
  if (before.answers) assert(body.messages.some(m => m.role === 'assistant'), '継続では前の回答を送る');
  if (android && body.conversation_mode !== 'temporary') {
    await page.evaluate(() => nativeHistory.flush());
    await page.waitForFunction(async () => !(await nativeConversation.pending()).length, null, {polling: 100});
  }
  assert.equal(await page.locator('.agent-error').count(), 0);
  return body;
}

// 応答の無い待ちでジョブの上限（25分）まで止まらないよう、どの段階で止まったかを残して先に失敗させる。
const watchdog = setTimeout(() => {
  report.error = '時間切れ: ' + (report.step || '開始前'); report.finished = new Date().toISOString();
  mkdirSync(dirname(output), {recursive: true}); writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.error('[magi-chat-gate] ' + report.error); process.exit(1);
}, 10 * 60000);

try {
  step('契約の確認'); checkContract();
  if (android) {
    assert(adb && device && apk, '--androidでは--adb= --device= --apk=が必須');
    step('端末の準備を待つ'); waitDevice();
    // 任意のアプリは操作しない。先にインストールした別IDのAPKだけを照合する。
    const installed = run('shell', 'pm', 'path', pkg).replace(/^package:/, '');
    assert.match(installed, /^\/data\/app\/[^\r\n]+\/base\.apk$/);
    step('導入済みAPKの照合'); const expected = readFileSync(apk);
    const bytes = readInstalledApk(installed, expected.length);
    report.apkSha256 = sha256(expected); assert.equal(sha256(bytes), report.apkSha256);
    const bundled = JSON.parse(execFileSync('python', ['-c', 'import zipfile,json,hashlib,sys; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({n:hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist() if n.startswith("assets/public/") and not n.endswith("/")}))', apk], {encoding: 'utf8'}));
    for (const file of git('ls-files', '--', 'magi-app/www/').split('\n')) assert.equal(bundled['assets/public/' + file.slice('magi-app/www/'.length)], sha256(readFileSync(resolve(root, file))), '検査APKの画面が対象ソースと一致: ' + file);
    report.packagedWwwVerified = true;
    run('shell', 'am', 'force-stop', pkg); assert.equal(run('shell', 'pm', 'clear', pkg), 'Success');
    server = createServer((req, res) => {
      let text = ''; req.on('data', b => { text += b; }); req.on('end', () => {
        try {
          assert.equal(req.method, 'POST'); assert.equal(req.url, '/magi2/chat');
          const body = reply(JSON.parse(text), 'native');
          res.writeHead(200, {'Content-Type': 'text/event-stream'});
          if (delayed) { res.write(': waiting\n\n'); setTimeout(() => res.end(body), 2500); } else res.end(body);
        } catch (error) { errors.push(error.message); res.writeHead(400); res.end(); }
      });
    });
    await new Promise(r => server.listen(18765, '127.0.0.1', r));
    run('reverse', 'tcp:18765', 'tcp:18765'); run('shell', 'am', 'start', '-n', pkg + '/st.tk.magi.MainActivity');
    step('検証アプリへ接続'); await sleep(1500); await connect();
  } else browser = await chromium.launch({headless: true});

  for (const surface of android ? ['android'] : ['web', 'pwa']) {
    step('画面: ' + surface);
    if (!android) {
      context = await browser.newContext({viewport: {width: surface === 'web' ? 1400 : 390, height: 900}, serviceWorkers: 'block', reducedMotion: 'reduce'});
      await context.addInitScript(() => { sessionStorage.setItem('magi_transport', 'sse'); localStorage.setItem('st-analytics', 'off'); });
      await routes(context); page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
      await page.goto('https://tk.st/' + (surface === 'pwa' ? 'magi-app/www/' : ''));
      if (surface === 'web' && await page.locator('#agentdock').evaluate(el => el.classList.contains('collapsed'))) await page.locator('[data-act="agent"]').click();
      await ready();
    }
    for (const id of matrix) {
      const temporary = id.startsWith('temporary'), personal = id.endsWith('-on');
      step('条件: ' + surface + '/' + id);
      await page.evaluate(async ({temporary, personal, android}) => {
        if (agentTemporary()) await toggleAgentTemporary();
        resetAgent();
        localStorage.setItem('magi_location_enabled', '0'); localStorage.setItem('magi_notifications_asked', '1');
        saveAgentPersonalization({version: 1, enabled: personal, preferred_name: 'SYNTHETIC', custom_instructions: 'Synthetic instructions.'});
        if (android) await Capacitor.Plugins.MagiConversation.setNotificationPreference({enabled: false});
        if (temporary) { await toggleAgentTemporary(); agentPrivacyState.temporaryPersonalization = personal; syncAgentPrivacyUI(); }
      }, {temporary, personal, android});
      for (const turn of [1, 2]) {
        const question = `MAGI-GATE-${nonce}-${surface}-${id}-${turn}`, body = await send(question);
        assert.equal(!!body.personalization, personal);
        assert.equal(body.conversation_mode === 'temporary', temporary);
        report.cases.push({id: surface + '/' + id + '/' + turn, pass: true, newAnswer: true, rendered: true, complete: true, requests: 1});
      }
      if (!temporary) {
        const expected = await page.evaluate(() => agentHistory.at(-1).content);
        if (android) await page.evaluate(() => nativeHistory.flush());
        await page.reload(); await ready();
        await page.waitForFunction(text => agentHistory.at(-1)?.content === text, expected, {polling: 100});
        assert.equal(await page.locator('.agent-reply-body').last().innerText(), expected);
        report.cases.push({id: surface + '/' + id + '/saved', pass: true, restored: true});
      }
    }
    if (!android) await context.close();
  }

  if (android) {
    step('バックグラウンド受信と再起動後の復元');
    await page.evaluate(async () => {
      if (agentTemporary()) await toggleAgentTemporary(); resetAgent();
      saveAgentPersonalization({version: 1, enabled: true, preferred_name: 'SYNTHETIC', custom_instructions: ''});
      const read = Capacitor.Plugins.MagiConversation.read.bind(Capacitor.Plugins.MagiConversation);
      Capacitor.Plugins.MagiConversation.read = async args => { await new Promise(() => {}); return read(args); };
    });
    delayed = true; const question = `MAGI-GATE-${nonce}-android-restart`;
    const count = requests.length; await send(question, true);
    await page.waitForFunction(() => !!agentHistory.at(-1)?.native_request, null, {polling: 100});
    const id = await page.evaluate(() => agentHistory.at(-1).native_request);
    const deadline = Date.now() + 10000;
    while (requests.length === count && Date.now() < deadline) await sleep(50);
    assert.equal(requests.length, count + 1, 'ネイティブ要求が開始していない');
    run('shell', 'input', 'keyevent', 'KEYCODE_HOME');
    await browser.close(); browser = null;
    const savedDeadline = Date.now() + 20000;
    let meta, serviceStopped = false;
    do {
      await sleep(300);
      meta = JSON.parse(run('shell', 'run-as', pkg, 'cat', 'files/magi/pending/' + id + '/meta.json'));
      serviceStopped = !/isForeground=true/.test(run('shell', 'dumpsys', 'activity', 'services', pkg));
    } while ((meta.status !== 'complete' || !serviceStopped) && Date.now() < savedDeadline);
    assert.equal(meta.status, 'complete');
    assert.match(run('shell', 'run-as', pkg, 'cat', 'files/magi/pending/' + id + '/events.sse'), /^event: session\r?\n/);
    assert(serviceStopped, '受信サービスが終了していない');
    run('shell', 'am', 'force-stop', pkg); run('shell', 'am', 'start', '-n', pkg + '/st.tk.magi.MainActivity');
    await sleep(1500); await connect();
    await page.waitForFunction(text => agentHistory.at(-1)?.content === text && !agentBusy, 'ANSWER-' + question, {polling: 100});
    await page.evaluate(() => nativeHistory.flush()); await page.reload(); await ready();
    assert.equal(await page.evaluate(text => agentHistory.filter(m => m.content === text).length, 'ANSWER-' + question), 1);
    assert.equal(requests.length, count + 1);
    report.cases.push({id: 'android/background-restart', pass: true, restored: true, requests: 1, answers: 1, serviceStopped: true});
  }
  assert.deepEqual(errors, []); report.pass = true;
} catch (error) {
  report.error = error.message; report.requests = requests.map(r => ({question: r.question, transport: r.transport})); report.errors = errors;
  if (page && !page.isClosed()) try { report.state = await page.evaluate(() => ({busy: agentBusy, preparing: agentPrivacyState.preparing,
    sequence: agentSendSequence, hidden: document.hidden, answers: agentHistory.filter(m => m.role === 'assistant').length,
    notices: document.querySelector('#agent-status')?.textContent})); } catch {}
  throw error;
}
finally {
  clearTimeout(watchdog);
  report.finished = new Date().toISOString(); mkdirSync(dirname(output), {recursive: true}); writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  await browser?.close();
  await androidDevice?.close();
  if (android && adb && device) {
    for (const args of [['shell', 'am', 'force-stop', pkg], ['reverse', '--remove', 'tcp:18765']]) try { run(...args); } catch {}
  }
  server?.closeAllConnections(); if (server) await new Promise(r => server.close(r));
}
console.log(JSON.stringify({pass: report.pass, kind: report.kind, cases: report.cases.length, report: output}));
