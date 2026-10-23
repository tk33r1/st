import bundledVersions from '../../data/magi-versions.json';
import { VERSION_HISTORY } from './personas.js';

import { cleanVersionHistory, versionOrder, VERSION_HISTORY_LIMITS } from './version-history.js';
export { cleanVersionHistory, versionOrder } from './version-history.js';

let versionHistoryCache = null, versionHistoryExpires = 0, versionHistoryPending = null;
export async function getVersionHistory() {
  if (versionHistoryCache && Date.now() < versionHistoryExpires) return versionHistoryCache;
  if (versionHistoryPending) return versionHistoryPending;
  versionHistoryPending = (async () => {
    const controller = new AbortController(); let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => {
      controller.abort(); reject(new Error('versions_timeout'));
    }, VERSION_HISTORY.fetch_timeout_ms); });
    try {
      const load = async () => {
        const response = await fetch(VERSION_HISTORY.url, {signal:controller.signal});
        if (!response.ok) { response.body?.cancel().catch(() => {}); throw new Error('versions_unavailable'); }
        const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', {fatal:true});
        let body = '', size = 0;
        const cancel = () => { reader.cancel().catch(() => {}); };
        controller.signal.addEventListener('abort', cancel, {once:true});
        if (controller.signal.aborted) cancel();
        try {
          while (true) {
            const {done, value} = await reader.read(); if (done) break;
            size += value.byteLength;
            if (size > VERSION_HISTORY_LIMITS.max_bytes) throw new Error('versions_too_large');
            body += decoder.decode(value, {stream:true});
          }
          body += decoder.decode();
        } finally { controller.signal.removeEventListener('abort', cancel); cancel(); }
        const data = cleanVersionHistory(JSON.parse(body));
        if (!data) throw new Error('versions_invalid');
        // Workerを画面より先に出す間も、そのWorkerに同梱した最新の版を欠かさない。
        if (data.versions[0].version === 'earlier'
          || versionOrder(data.versions[0].version) < versionOrder(bundledVersions.versions[0].version)) throw new Error('versions_older');
        return data;
      };
      versionHistoryCache = await Promise.race([load(), deadline]);
    } catch (_) {
      versionHistoryCache = cleanVersionHistory(bundledVersions);
      if (!versionHistoryCache) throw new Error('bundled_versions_invalid');
    } finally { clearTimeout(timer); }
    versionHistoryExpires = Date.now() + VERSION_HISTORY.cache_ms;
    return versionHistoryCache;
  })();
  try { return await versionHistoryPending; } finally { versionHistoryPending = null; }
}
