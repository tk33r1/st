// サイトに同梱済みの pdf.js（assets/vendor。取り込みは .github/scripts/vendor/fetch-vendor.js）を出荷物へ写す。
// Capacitor はアプリに www/ しか入れないので、添付の PDF から文字とページ画像を作るために複製を持つ。
// assets/vendor/SOURCES.json にその版で記録したファイルをすべて写す（本体・Worker・cmaps・standard_fonts・wasm・iccs・ライセンス）。
// 写す前に記録の SHA-256 と照合し、食い違えば止める。版を上げたら VERSION も直して実行し直す（前の版の複製は消す）。
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const VERSION = 'pdfjs-dist@6.4.299';
const site = path.resolve(__dirname, '../../assets/vendor');
const dest = path.resolve(__dirname, '../www/vendor/pdfjs');
const recorded = JSON.parse(fs.readFileSync(path.join(site, 'SOURCES.json'), 'utf8')).files;
const names = Object.keys(recorded).filter(key => key.startsWith(VERSION + '/')).map(key => key.slice(VERSION.length + 1));
if (!names.length) throw new Error('not recorded: ' + VERSION);
fs.rmSync(dest, { recursive: true, force: true });
const hashes = {};
for (const name of names) {
  const bytes = fs.readFileSync(path.join(site, VERSION, name));
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  if (recorded[VERSION + '/' + name].sha256 !== hash) throw new Error('SHA-256 mismatch: ' + name);
  fs.mkdirSync(path.dirname(path.join(dest, name)), { recursive: true });
  fs.writeFileSync(path.join(dest, name), bytes);
  hashes[name] = hash;
}
fs.writeFileSync(path.join(dest, 'SOURCES.json'), JSON.stringify({ name: 'pdfjs-dist', version: VERSION.split('@')[1],
  source: 'assets/vendor/' + VERSION + ' (https://cdn.jsdelivr.net/npm/' + VERSION + '/legacy/build/ ほか)',
  license: 'Apache-2.0（cmaps/・standard_fonts/・wasm/・iccs/ はそれぞれの LICENSE*）', sha256: hashes }, null, 2) + '\n');
