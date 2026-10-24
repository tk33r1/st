// GPSの橋渡しを模擬し、実際の測位・通信はしない。
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../../magi-app/www/native-location.js', import.meta.url), 'utf8');
const position = () => ({ latitude: 35.123456, longitude: 139.123456, accuracy: 12.3, age_ms: 100, city: 'Synthetic City', country: 'JP', private_field: 'discard' });
function fixture(overrides = {}, platform = 'android', clock = Date) {
  const calls = [];
  const plugin = {
    async permission(o) { calls.push(['permission', o.request]); return { precision: 'precise', canAsk: false }; },
    async current() { calls.push(['current']); return position(); },
    async cancel() { calls.push(['cancel']); }, ...overrides,
  };
  const ctx = vm.createContext({ Date: clock, window: { Capacitor: { isNativePlatform: () => platform !== 'web', getPlatform: () => platform, Plugins: { MagiLocation: plugin } } } });
  vm.runInContext(source, ctx);
  return { api: ctx.window.MagiNativeLocation, calls };
}
test('GPS: Web・iOSはネイティブの権限も測位も呼ばない', async () => {
  for (const platform of ['web', 'ios']) {
    const f = fixture({}, platform);
    assert.equal(await f.api.current(), null); await f.api.permission(true);
    assert.equal(f.calls.length, 0);
  }
});
test('GPS: 未許可の初回だけ要求し、おおよその位置も尊重し、座標を丸めて余分な項目を落とす', async () => {
  const requests = [];
  const f = fixture({ async permission(o) { requests.push(o.request); return { precision: o.request ? 'approximate' : 'none', canAsk: true }; } });
  const value = await f.api.current();
  assert.deepEqual(requests, [false, true]);
  assert.equal(value.latitude, 35.1235); assert.equal(value.longitude, 139.1235); assert.equal(value.accuracy, 13);
  assert.equal(value.city, 'Synthetic City'); assert.equal(value.private_field, undefined);
});
test('GPS: 拒否・サービス停止・古い位置・不正な値で失敗を閉じ込める', async () => {
  const denied = fixture({ async permission() { return { precision: 'none', canAsk: false }; } });
  assert.equal(await denied.api.current(), null); assert.equal(denied.calls.length, 0);
  assert.equal(await fixture({ async current() { throw Error('location_disabled'); } }).api.current(), null);
  for (const change of [{ age_ms: 180000 }, { age_ms: -1 }, { age_ms: '100' }, { age_ms: undefined }, { latitude: 91 }, { longitude: '139' }, { accuracy: 10001 }, { accuracy: -1 }])
    assert.equal(await fixture({ async current() { return { ...position(), ...change }; } }).api.current(), null);
});
test('GPS: 時計が遅れ・進み・送信中に変わっても、新鮮な測位を捨てない', async () => {
  for (const offset of [-86400000, -30000, 180000, 86400000]) {
    class DeviceDate extends Date { static now() { return Date.now() + offset; } }
    const value = await fixture({}, 'android', DeviceDate).api.current();
    assert.equal(value.age_ms, 100); assert.equal(value.latitude, 35.1235); assert.equal(value.timestamp, undefined);
  }
});
test('GPS: 停止中は測位せず、権限の応答待ちや測位中の停止後に座標を返さない', async () => {
  const stopped = new AbortController(); stopped.abort();
  const f = fixture(); assert.equal(await f.api.current(stopped.signal), null); assert.equal(f.calls.length, 0);
  for (const stage of ['permission', 'current']) {
    let resume, entered;
    const ready = new Promise(r => { entered = r; });
    const f = fixture({ [stage]: () => { entered(); return new Promise(r => { resume = r; }); } });
    const ctrl = new AbortController(), result = f.api.current(ctrl.signal);
    await ready; ctrl.abort();
    resume(stage === 'permission' ? { precision: 'precise' } : position());
    assert.equal(await result, null); assert.equal(f.calls.filter(c => c[0] === 'cancel').length, 1);
    if (stage === 'permission') assert.equal(f.calls.some(c => c[0] === 'current'), false);
  }
});
