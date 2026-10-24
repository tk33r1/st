// B3: 耐久保存された列を既存パーサーへ渡す橋渡し。実AIは呼ばない。
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../../magi-app/www/native-background.js', import.meta.url), 'utf8');

test('一時/設定: 一時要求は通知許可・ネイティブ受信・ファイル作成へ渡さない', async () => {
  const f = fixture({ permission: 'prompt' }), n = await f.create();
  await assert.rejects(n.open(JSON.stringify({ conversation_mode: 'temporary' }), request()), /temporary_native_receive_forbidden/);
  assert.equal(f.calls.filter(c => ['begin','permission'].includes(c[0])).length, 0);
});
function fixture({ native = true, permission = 'granted', status = 'complete', text = 'event: integrated\ndata: {"delta":"日本語"}\n\nevent: done\ndata: {}\n\n' } = {}) {
  const calls = [], storage = new Map(), bytes = Buffer.from(text), rows = [{ id: 'request_1', sessionId: 'session_1' }, { id: 'request_2', sessionId: 'session_2' }];
  const plugin = {
    information: async () => ({ test: false }),
    notificationPreference: async () => ({ enabled: true }),
    setNotificationPreference: async ({ enabled }) => { plugin.notificationPreference = async () => ({ enabled }); calls.push(['notifications', enabled]); }, checkPermissions: async () => ({ display: permission }),
    requestPermissions: async () => { calls.push(['permission']); return { display: 'denied' }; },
    begin: async o => { calls.push(['begin', o]); }, cancel: async o => { calls.push(['cancel', o.id]); },
    acknowledge: async o => { calls.push(['acknowledge', o.id]); }, pending: async () => ({ runs: rows }),
    openNotificationSettings: async () => { calls.push(['settings']); },
    read: async ({ offset }) => { const part = bytes.subarray(offset, offset + 3); return { offset: offset + part.length, length: bytes.length, base64: part.toString('base64'), status }; },
  };
  const ctx = vm.createContext({ setTimeout, clearTimeout, ReadableStream, DOMException, atob, crypto: webcrypto,
    localStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) } }); vm.runInContext(source, ctx);
  const cap = { isNativePlatform: () => native, getPlatform: () => 'android', get Plugins() { calls.push(['plugins']); return { MagiConversation: plugin }; } };
  return { calls, plugin, create: () => ctx.MagiNativeConversation.create({ cap }) };
}
const request = (overrides = {}) => ({ id: 'request_1', sessionId: 'session_1', mid: 'mid_1', title: 'A title', ctrl: new AbortController(), ...overrides });
test('B3: Web/PWAはネイティブの橋渡しに触らない', async () => {
  const f = fixture({ native: false }); assert.equal(await f.create(), null); assert.deepEqual(f.calls, []);
});
test('B3: 分割UTF-8を同じSSEのまま読み、会社や接続先をJSから指定しない', async () => {
  const f = fixture(), n = await f.create(), r = request(); const res = await n.open('{"messages":[]}', r);
  assert.match(await new Response(res.body).text(), /日本語/);
  const begin = f.calls.find(c => c[0] === 'begin')[1]; assert.equal(begin.sessionId, r.sessionId); assert.equal(begin.test, false);
  assert.ok(!Object.hasOwn(begin, 'url')); assert.ok(!Object.hasOwn(begin, 'provider'));
  await n.acknowledge(r.id); assert.deepEqual(f.calls.slice(-2), [['cancel', r.id], ['acknowledge', r.id]]);
});
test('B3: 通知拒否でも会話を開始し、許可の初回案内を重ねない', async () => {
  const f = fixture({ permission: 'prompt' }), n = await f.create();
  for (let i = 0; i < 2; i++) { const res = await n.open('{}', request()); await new Response(res.body).text(); }
  assert.equal(f.calls.filter(c => c[0] === 'permission').length, 1); assert.equal(f.calls.filter(c => c[0] === 'begin').length, 2);
});
test('B3: 完了済み列の復元ではHTTP開始・許可要求を繰り返さない', async () => {
  const f = fixture({ permission: 'prompt' }), n = await f.create(); const res = await n.open('', request({ resume: true }));
  assert.match(await new Response(res.body).text(), /event: done/); assert.equal(f.calls.filter(c => ['begin', 'permission'].includes(c[0])).length, 0);
});
test('B3: 停止した要求IDだけを取り消し、通知停止も既存のAbortへ戻す', async () => {
  for (const bySignal of [true, false]) {
    const f = fixture({ status: bySignal ? 'receiving' : 'stopped', text: '' }), n = await f.create(), r = request();
    const res = await n.open('{}', r), pending = new Response(res.body).text();
    if (bySignal) r.ctrl.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    if (bySignal) assert.ok(f.calls.some(c => c[0] === 'cancel' && c[1] === r.id));
    else assert.equal(r.ctrl.userStopped, true);
  }
});
test('B3: 不正な読取位置と中断状態を正常完了にせず、未保存の列を消さない', async () => {
  for (const invalidOffset of [true, false]) {
    const f = fixture({ status: 'failed', text: '' }), n = await f.create();
    if (invalidOffset) f.plugin.read = async () => ({ offset: 99, length: 0, base64: '', status: 'complete' });
    const res = await n.open('{}', request()); await assert.rejects(new Response(res.body).text());
    assert.equal(f.calls.filter(c => c[0] === 'acknowledge').length, 0);
  }
});
test('B3: 会話削除はその会話の列だけ、全削除はすべての列を取消後に取り除く', async () => {
  const f = fixture(), n = await f.create(); await n.clear('session_2');
  assert.deepEqual(f.calls.filter(c => c[0] === 'acknowledge'), [['acknowledge', 'request_2']]);
  await n.clear(); assert.equal(f.calls.filter(c => c[0] === 'acknowledge').length, 3);
});

test('通知設定: オフでは許可を求めず、オンでOS許可を案内する', async () => {
  const f = fixture({ permission: 'prompt' }), n = await f.create();
  await n.setNotifications(false);
  assert.equal((await n.notificationState()).enabled, false);
  await new Response((await n.open('{}', request())).body).text();
  assert.equal(f.calls.filter(c => c[0] === 'permission').length, 0);
  await n.setNotifications(true);
  assert.equal(f.calls.filter(c => c[0] === 'permission').length, 1);
  assert.equal(f.calls.filter(c => c[0] === 'settings').length, 1);
});
