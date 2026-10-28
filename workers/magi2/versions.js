import bundledVersions from '../../data/magi-versions.json';
import { VERSION_HISTORY } from './personas.js';
import { readSearchText, searchDeadline } from './site-search.js';

import { cleanVersionHistory, versionOrder, VERSION_HISTORY_LIMITS } from './version-history.js';

let versionHistoryCache = null, versionHistoryExpires = 0, versionHistoryPending = null;
export async function getVersionHistory() {
  if (versionHistoryCache && Date.now() < versionHistoryExpires) return versionHistoryCache;
  if (versionHistoryPending) return versionHistoryPending;
  versionHistoryPending = (async () => {
    try {
      // 時間切れ・上限超え・壊れた本文は、どれも下の同梱の版に替える
      const body = await searchDeadline(VERSION_HISTORY.fetch_timeout_ms, async signal =>
        readSearchText(await fetch(VERSION_HISTORY.url, {signal}), signal, VERSION_HISTORY_LIMITS.max_bytes));
      const data = cleanVersionHistory(JSON.parse(body));
      if (!data) throw new Error('versions_invalid');
      // Workerを画面より先に出す間も、そのWorkerに同梱した最新の版を欠かさない。
      if (data.versions[0].version === 'earlier'
        || versionOrder(data.versions[0].version) < versionOrder(bundledVersions.versions[0].version)) throw new Error('versions_older');
      versionHistoryCache = data;
    } catch (_) {
      versionHistoryCache = cleanVersionHistory(bundledVersions);
      if (!versionHistoryCache) throw new Error('bundled_versions_invalid');
    }
    versionHistoryExpires = Date.now() + VERSION_HISTORY.cache_ms;
    return versionHistoryCache;
  })();
  try { return await versionHistoryPending; } finally { versionHistoryPending = null; }
}
