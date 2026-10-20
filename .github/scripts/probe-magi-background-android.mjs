// B3の別ID APKでネイティブ受信と復元を確認する。AI・外部記事には接続しない。
// --adb=... --transport=... --mode=home|browser|lock --seconds=300 --label=...
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
const arg = (key, fallback = '') => process.argv.find(a => a.startsWith('--' + key + '='))?.slice(key.length + 3) || fallback;
const adb = arg('adb'), transport = arg('transport'), mode = arg('mode', 'home'), seconds = Number(arg('seconds', '300'));
const label = arg('label', mode), scenario = arg('case', 'success'), restart = arg('restart', 'off') === 'on';
const notification = arg('notification', 'off') === 'on', notifications = arg('notifications', 'granted');
const holdUi = arg('hold-ui', 'off') === 'on', keepForeground = arg('foreground', 'off') === 'on';
const interrupt = arg('interrupt', 'off') === 'on', succeeds = scenario === 'success' && !interrupt;
assert(adb && /^\d+$/.test(transport)); assert(['home', 'browser', 'lock'].includes(mode)); assert.match(label, /^[a-z0-9-]+$/);
assert(Number.isInteger(seconds) && seconds >= 20 && seconds <= 310); assert(['success', 'eof', 'error', 'invalid', 'http429', 'stall', 'stop'].includes(scenario));
assert(['granted', 'denied'].includes(notifications)); assert(!notification || !restart && mode !== 'lock' && notifications === 'granted');
const pkg = 'st.tk.magi.b3probe', port = 18765, debugPort = 19223;
const dir = fileURLToPath(new URL('../../workers/.wrangler/magi-b3-native-20261020/', import.meta.url)); mkdirSync(dir, { recursive: true });
const run = (...args) => execFileSync(adb, ['-t', transport, ...args], { encoding: 'utf8', timeout: 20000 });
const wakeHeld = () => run('shell', 'dumpsys', 'power').split(/\r?\n/).some(line => line.trimStart().startsWith('PARTIAL_WAKE_LOCK') && line.includes("'" + pkg + ":magi-conversation'"));
const apkSha256 = createHash('sha256').update(readFileSync(new URL('../../magi-app/android/app/build/outputs/apk/debug/app-debug.apk', import.meta.url))).digest('hex');
const installedApk = run('shell', 'pm', 'path', pkg).trim().replace(/^package:/, '');
assert.match(installedApk, /^\/data\/app\/[a-zA-Z0-9_./=+~-]+\/base\.apk$/);
assert.equal(createHash('sha256').update(execFileSync(adb, ['-t', transport, 'exec-out', 'cat', installedApk], { timeout: 20000, maxBuffer: 16 * 1024 * 1024 })).digest('hex'), apkSha256, '先に同じ候補APKをインストールする');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timers = new Set(), events = [];
let browser, streamStarted, requests = 0, nativeId, sessionId, report;
const started = new Promise(resolve => { streamStarted = resolve; });
const server = createServer((req, res) => {
  let body = ''; req.on('data', bytes => { body += bytes; });
  req.on('end', () => {
    requests++;
    let value; try { value = JSON.parse(body); } catch (_) { res.writeHead(400); res.end(); return; }
    if (requests !== 1 || req.method !== 'POST' || req.url !== '/magi2/chat' || value.messages.at(-1).content !== 'B3 synthetic background probe') { res.writeHead(400); res.end(); return; }
    const start = Date.now(); streamStarted();
    function send(event, data) { events.push({ event, elapsed: Date.now() - start }); res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); }
    function later(fraction, callback) { const timer = setTimeout(callback, Math.round(seconds * 1000 * fraction)); timers.add(timer); }
    if (scenario === 'http429') { later(0.5, () => { res.writeHead(429, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"Synthetic rate limit"}}'); }); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' }); res.write(':' + ' '.repeat(2048) + '\n\n');
    send('classification', { version: 1, intent: 'consult', mode: 'consult', fresh: 'no', votable: 'no', site_pages: 'no', magi_candidate: false, reply_language: { version: 1, code: 'en', source: 'ui' } });
    send('title', { text: 'B3 synthetic conversation' });
    const beat = setInterval(() => res.write(': ping\n\n'), 8000); timers.add(beat);
    const names = ['MELCHIOR-1', 'BALTHASAR-2', 'CASPER-3'];
    for (let n = 0; n < 6; n++) later(0.07 + n * 0.09, () => send('persona', { codename: names[n % 3], round: n < 3 ? 1 : 2, text: 'Synthetic discussion.' }));
    later(0.66, () => send('ask', { round: 3, questions: [{ codename: names[0], text: 'Synthetic follow-up?' }] }));
    later(0.72, () => send('persona', { codename: names[0], round: 3, text: 'Synthetic follow-up answer.' }));
    later(0.8, () => {
      if (scenario === 'stall') return;
      if (scenario === 'invalid') res.write('event: integrated\ndata: {not JSON}\n\n');
      else if (scenario === 'error') send('error', { message: 'Synthetic error', code: 'synthetic_error' });
      else { send('integrated', { delta: 'Synthetic background answer received.' }); if (scenario === 'success') send('done', {}); }
      res.end();
    });
    res.on('close', () => { for (const timer of timers) clearTimeout(timer); });
  });
});
async function connect() {
  let pid;
  for (let i = 0; i < 30; i++) { try { pid = run('shell', 'pidof', pkg).trim(); } catch (_) {} if (pid) break; await sleep(300); }
  assert.match(pid || '', /^\d+$/); run('forward', 'tcp:' + debugPort, 'localabstract:webview_devtools_remote_' + pid);
  for (let i = 0; i < 30 && !browser; i++) { try { browser = await chromium.connectOverCDP('http://127.0.0.1:' + debugPort, { timeout: 1000 }); } catch (e) { if (i === 29) throw e; await sleep(300); } }
  const page = browser.contexts()[0].pages().find(p => p.url().startsWith('https://localhost')); assert(page);
  page.on('pageerror', error => console.log(JSON.stringify({ label, page_error: error.message })));
  page.on('console', message => { if (message.type() === 'error') console.log(JSON.stringify({ label, console_error: message.text() })); });
  return { page, pid };
}
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
try {
  run('reverse', 'tcp:' + port, 'tcp:' + port); run('shell', 'am', 'start', '-n', pkg + '/st.tk.magi.MainActivity');
  let { page, pid } = await connect(); await page.waitForFunction(() => typeof nativeConversation !== 'undefined' && !!nativeConversation && !historyLoading && !agentBusy);
  // 正常に画面が取り込みを終えた場合も、検査前に証拠が削除されないようACKだけを待たせる。
  await page.evaluate(() => {
    const plugin = Capacitor.Plugins.MagiConversation, ack = plugin.acknowledge.bind(plugin);
    const held = new Promise(resolve => { window.releaseNativeTestAck = resolve; });
    plugin.acknowledge = async options => { await held; return ack(options); };
  });
  if (holdUi) await page.evaluate(() => {
    const plugin = Capacitor.Plugins.MagiConversation, read = plugin.read.bind(plugin);
    const held = new Promise(resolve => { window.releaseNativeTestRead = resolve; });
    plugin.read = async options => { await held; return read(options); };
  });
  if (notifications === 'denied') await page.evaluate(() => localStorage.setItem('magi_notifications_asked', '1'));
  await page.evaluate(() => {
    window.fetch = () => Promise.reject(new Error('B3 native test blocks JS fetch'));
    syncCurrentToSaved(); resetAgent(); agentInput.value = 'B3 synthetic background probe';
    const make = nativeConversation.id; nativeConversation.id = () => (window.nativeTestId = make());
    agentSend();
  });
  await Promise.race([started, sleep(20000).then(() => { throw Error('native_stream_not_started'); })]);
  ({ nativeId, sessionId } = await page.evaluate(() => ({ nativeId: window.nativeTestId, sessionId: currentSessionId })));
  assert.match(nativeId, /^request_/);
  assert.match(run('shell', 'dumpsys', 'activity', 'services', pkg), /isForeground=true/);
  const wakeAcquired = wakeHeld(); assert(wakeAcquired);
  if (scenario === 'stop') await page.evaluate(() => Capacitor.Plugins.MagiConversation.testNotificationAction({ kind: 'stop' }));
  await browser.close(); browser = null;
  if (interrupt) run('shell', 'run-as', pkg, 'kill', '-9', pid);
  if (keepForeground) { /* ネイティブの前面判定と通知抑止だけを別枠で検査する。 */ }
  else if (mode === 'lock') run('shell', 'input', 'keyevent', 'KEYCODE_SLEEP');
  else if (mode === 'browser') run('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', 'about:blank', '-p', 'com.android.chrome');
  else run('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  console.log(JSON.stringify({ label, phase: 'background', seconds }));
  const screenStates = [];
  for (let elapsed = 0; elapsed < seconds; elapsed += 30) {
    await sleep(Math.min(30, seconds - elapsed) * 1000);
    if (mode === 'lock' && !keepForeground) {
      const power = run('shell', 'dumpsys', 'power'), policy = run('shell', 'dumpsys', 'window', 'policy');
      const state = { elapsed: Math.min(elapsed + 30, seconds), wakefulness: power.match(/mWakefulness=(\w+)/)?.[1],
        locked: /KeyguardServiceDelegate[\s\S]*?\bshowing=true/.test(policy) };
      screenStates.push(state);
      writeFileSync(dir + label + '-screen.json', JSON.stringify(screenStates, null, 2) + '\n');
      assert(state.locked && /^(Dozing|Asleep)$/.test(state.wakefulness), '画面が点いた回は消灯試験の合格に数えない');
    }
    console.log(JSON.stringify({ label, elapsed: Math.min(elapsed + 30, seconds) }));
  }
  const meta = JSON.parse(run('shell', 'run-as', pkg, 'cat', 'files/magi/pending/' + nativeId + '/meta.json'));
  const data = run('shell', 'run-as', pkg, 'cat', 'files/magi/pending/' + nativeId + '/events.sse');
  const serviceStopped = !/isForeground=true/.test(run('shell', 'dumpsys', 'activity', 'services', pkg));
  const wakeReleased = !wakeHeld();
  report = { label, mode, seconds, scenario, restart, notification, notifications, holdUi, keepForeground, interrupt, paid_ai_calls: 0, devtools_disconnected: true, meta, serviceStopped, wakeAcquired, wakeReleased, receivedDone: /event: done\r?\n/.test(data), events, requests };
  writeFileSync(dir + label + '.json', JSON.stringify(report, null, 2) + '\n');
  assert.equal(meta.status, interrupt ? 'receiving' : succeeds ? 'complete' : scenario === 'stop' ? 'stopped' : 'failed');
  assert(serviceStopped && wakeReleased);
  if (scenario === 'stall') assert.equal(meta.error, 'timeout');
  if (!interrupt) { assert(meta.serviceStoppedAt); assert.equal(meta.notified, notifications === 'granted' && !keepForeground && scenario !== 'stop'); }
  if (restart) run('shell', 'run-as', pkg, 'kill', '-9', pid);
  if (mode === 'lock') {
    run('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
    if (/KeyguardServiceDelegate[\s\S]*?\bshowing=true/.test(run('shell', 'dumpsys', 'window', 'policy'))) {
      console.log(JSON.stringify({ label, phase: 'unlock-required', native_status: meta.status, notified: meta.notified }));
      let unlocked = false;
      for (let attempt = 0; attempt < 360; attempt++) {
        await sleep(5000);
        if (!/KeyguardServiceDelegate[\s\S]*?\bshowing=true/.test(run('shell', 'dumpsys', 'window', 'policy'))) { unlocked = true; break; }
      }
      assert(unlocked, 'unlock_required');
    }
  }
  if (notification) {
    ({ page } = await connect());
    await page.evaluate(() => Capacitor.Plugins.MagiConversation.testNotificationAction({ kind: 'open' }));
  } else {
    run('shell', 'am', 'start', '-n', pkg + '/st.tk.magi.MainActivity', '-a', 'android.intent.action.VIEW', '-d', 'magi://open?id=' + sessionId);
    ({ page } = await connect());
  }
  await page.evaluate(() => {
    if (window.releaseNativeTestAck) window.releaseNativeTestAck();
    if (window.releaseNativeTestRead) window.releaseNativeTestRead();
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    const ready = await page.evaluate(async ({ id, success }) => {
      if (typeof nativeConversation === 'undefined' || !nativeConversation || historyLoading) return false;
      const pending = await nativeConversation.pending();
      return !agentBusy && !pending.some(row => row.id === id)
        && (success ? agentHistory.some(m => m.role === 'assistant' && m.native_request === id) : agentInput.value === 'B3 synthetic background probe');
    }, { id: nativeId, success: succeeds });
    if (ready) break;
    if (attempt === 99) throw Error('reply_not_recovered');
    await sleep(300);
  }
  const result = await page.evaluate(async id => {
    await nativeHistory.flush(); return { users: agentHistory.filter(m => m.role === 'user' && m.native_request === id).length,
      answers: agentHistory.filter(m => m.role === 'assistant' && m.native_request === id).map(m => m.content), draft: agentInput.value,
      pending: (await nativeConversation.pending()).filter(row => row.id === id).length, current: currentSessionId };
  }, nativeId);
  assert.equal(result.current, sessionId); assert.equal(result.pending, 0); assert.equal(requests, 1);
  if (succeeds) { assert.equal(result.users, 1); assert.deepEqual(result.answers, ['Synthetic background answer received.']); }
  else { assert.equal(result.users, 0); assert.equal(result.answers.length, 0); assert.equal(result.draft, 'B3 synthetic background probe'); }
  report.recovered = result; writeFileSync(dir + label + '.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ label, passed: true, native_status: meta.status, serviceStopped, notified: meta.notified, recovered_once: true, requests }));
} finally {
  if (browser) await browser.close(); for (const timer of timers) clearTimeout(timer); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  for (const args of [['shell', 'am', 'force-stop', pkg], ['forward', '--remove', 'tcp:' + debugPort], ['reverse', '--remove', 'tcp:' + port]]) { try { run(...args); } catch (_) {} }
  writeFileSync(dir + label + '-meta.json', JSON.stringify({ apk_sha256: apkSha256, paid_ai_calls: 0, report_written: !!report }) + '\n');
}
