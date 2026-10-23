// 配布済みAPK 5.9の検査関数。CIの浅いcheckoutでも旧画面との互換を確かめる。
// 正本: fe3266a23b06edba8d4ed16313594b8213888d4b:magi-app/www/app.js
// 関数のSHA-256: b9a7866ea0ba9444e10cce1f504be2aa32f5a35a3c442055e4d194cc2a964d8a
function validAgentVersions(data) {
  return data && Array.isArray(data.versions) && data.versions.length > 0 && data.versions.length <= 60
    && data.versions.every(function (row) { return row && typeof row.version === 'string'
      && (/^\d{1,2}\.\d$/.test(row.version) || row.version === 'earlier')
      && (row.version === 'earlier' ? row.date === null : typeof row.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.date))
      && row.changes && ['ja','en'].every(function (lang) { return Array.isArray(row.changes[lang])
        && row.changes[lang].length >= 2 && row.changes[lang].length <= 4
        && row.changes[lang].every(function (text) { return typeof text === 'string' && text.length > 0 && Array.from(text).length <= 200; }); }); });
}
