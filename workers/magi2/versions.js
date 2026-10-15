import bundledVersions from '../../data/magi-versions.json';
import { VERSION_HISTORY } from './personas.js';

// 公開データを丸ごと検査する。一部だけを取り込んで履歴を欠落させない。
export function cleanVersionHistory(value) {
  const object = v => v && typeof v === 'object' && !Array.isArray(v);
  const date = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
    && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
  const text = v => typeof v === 'string' && !!v.trim() && Array.from(v).length <= VERSION_HISTORY.max_change_chars
    && !/[\u0000-\u001f\u007f-\u009f]/.test(v);
  if (!object(value) || Object.keys(value).some(k => k !== 'versions') || !Array.isArray(value.versions)
    || !value.versions.length || value.versions.length > VERSION_HISTORY.max_versions) return null;
  const seen = new Set(); let previous = Infinity, previousDate = '9999-12-31';
  for (const [i, row] of value.versions.entries()) {
    if (!object(row) || Object.keys(row).some(k => !['version', 'date', 'changes'].includes(k))) return null;
    const earlier = row.version === 'earlier';
    if (earlier ? i !== value.versions.length - 1 || row.date !== null
      : typeof row.version !== 'string' || !/^\d{1,2}\.\d$/.test(row.version) || !date(row.date)) return null;
    const order = earlier ? -1 : Number(row.version.split('.')[0]) * 10 + Number(row.version.split('.')[1]);
    if (seen.has(row.version) || order >= previous || !earlier && row.date > previousDate) return null;
    if (!object(row.changes) || Object.keys(row.changes).length !== 2 || !['ja', 'en'].every(lang =>
      Array.isArray(row.changes[lang]) && row.changes[lang].length >= 2 && row.changes[lang].length <= 4
      && row.changes[lang].every(text))) return null;
    seen.add(row.version); previous = order; if (!earlier) previousDate = row.date;
  }
  return value;
}

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
            if (size > VERSION_HISTORY.max_bytes) throw new Error('versions_too_large');
            body += decoder.decode(value, {stream:true});
          }
          body += decoder.decode();
        } finally { controller.signal.removeEventListener('abort', cancel); cancel(); }
        const data = cleanVersionHistory(JSON.parse(body));
        if (!data) throw new Error('versions_invalid');
        // Workerを画面より先に出す間も、そのWorkerに同梱した最新の版を欠かさない。
        if (Number(data.versions[0].version) < Number(bundledVersions.versions[0].version)) throw new Error('versions_older');
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
