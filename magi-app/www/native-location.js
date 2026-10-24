/* Androidの送信時の測位。権限・測位失敗はIP由来へ戻し、座標を保存しない。 */
(function (root) {
  'use strict';
  function plugin() {
    var cap = root.Capacitor;
    return cap && cap.isNativePlatform() && cap.getPlatform() === 'android' && cap.Plugins && cap.Plugins.MagiLocation;
  }
  function clean(value) {
    var age = value && value.age_ms;
    if (!value || !Number.isFinite(value.latitude) || Math.abs(value.latitude) > 90
      || !Number.isFinite(value.longitude) || Math.abs(value.longitude) > 180
      || !Number.isFinite(value.accuracy) || value.accuracy < 0 || value.accuracy > 10000
      || !Number.isFinite(age) || age < 0 || age > 120000) return null;
    var result = { latitude: Math.round(value.latitude * 10000) / 10000, longitude: Math.round(value.longitude * 10000) / 10000,
      accuracy: Math.ceil(value.accuracy), age_ms: age };
    ['country', 'city', 'region', 'timezone'].forEach(function (key) { if (typeof value[key] === 'string') result[key] = value[key]; });
    return result;
  }
  async function permission(request) {
    var native = plugin();
    return native ? native.permission({ request: !!request }) : { precision: 'none', canAsk: false };
  }
  async function current(signal) {
    var native = plugin();
    if (!native || signal && signal.aborted) return null;
    var cancelled = false;
    function cancel() { cancelled = true; native.cancel().catch(function () {}); }
    if (signal) signal.addEventListener('abort', cancel, { once: true });
    try {
      var state = await permission(false);
      if (!cancelled && state.precision === 'none' && state.canAsk) state = await permission(true);
      if (cancelled || state.precision === 'none') return null;
      var value = await native.current();
      return cancelled ? null : clean(value);
    } catch (_) { return null; }
    finally { if (signal) signal.removeEventListener('abort', cancel); }
  }
  root.MagiNativeLocation = { current: current, permission: permission, cancel: function () {
    var native = plugin(); if (native) return native.cancel().catch(function () {});
    return Promise.resolve();
  } };
})(typeof window !== 'undefined' ? window : globalThis);
