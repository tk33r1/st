// Workerと日次検査で共有する、I/Oなしの更新履歴の検査。
export const VERSION_HISTORY_LIMITS = Object.freeze({max_bytes: 65536, max_versions: 60, max_change_chars: 200});

// X.Y と X.YZ（Z は1〜9）を同じ尺度で比較する。5.9=590、5.91=591、6.0=600。
export function versionOrder(version) {
  if (typeof version !== 'string' || !/^\d{1,2}\.\d[1-9]?$/.test(version)) return null;
  const [major, fraction] = version.split('.');
  return Number(major) * 100 + Number(fraction.padEnd(2, '0'));
}

// 公開データを丸ごと検査する。一部だけを取り込んで履歴を欠落させない。
export function cleanVersionHistory(value) {
  const object = v => v && typeof v === 'object' && !Array.isArray(v);
  const date = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
    && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
  const text = v => typeof v === 'string' && !!v.trim() && Array.from(v).length <= VERSION_HISTORY_LIMITS.max_change_chars
    && !/[\u0000-\u001f\u007f-\u009f]/.test(v);
  if (!object(value) || Object.keys(value).some(k => k !== 'versions') || !Array.isArray(value.versions)
    || !value.versions.length || value.versions.length > VERSION_HISTORY_LIMITS.max_versions) return null;
  let previous = Infinity, previousDate = '9999-12-31';
  for (const [i, row] of value.versions.entries()) {
    if (!object(row) || Object.keys(row).some(k => !['version', 'date', 'changes'].includes(k))) return null;
    const earlier = row.version === 'earlier';
    if (earlier ? i !== value.versions.length - 1 || row.date !== null
      : versionOrder(row.version) === null || !date(row.date)) return null;
    const order = earlier ? -1 : versionOrder(row.version);
    if (order >= previous || !earlier && row.date > previousDate) return null;
    if (!object(row.changes) || Object.keys(row.changes).length !== 2 || !['ja', 'en'].every(lang =>
      Array.isArray(row.changes[lang]) && row.changes[lang].length >= 2 && row.changes[lang].length <= 4
      && row.changes[lang].every(text))) return null;
    previous = order; if (!earlier) previousDate = row.date;
  }
  return value;
}

