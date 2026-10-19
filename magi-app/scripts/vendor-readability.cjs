// 固定npmパッケージから出荷物へ写し、版・出典・生バイトhashを記録する。
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '..'), pkg = path.join(root, 'node_modules/@mozilla/readability');
const dest = path.join(root, 'www/vendor');
fs.mkdirSync(dest, { recursive: true });
const info = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json')));
if (info.version !== '0.6.0') throw new Error('Unexpected Readability version');
const files = [['Readability.js', 'Readability.js'], ['LICENSE.md', 'LICENSE']];
const hashes = {};
for (const [source, name] of files) {
  const bytes = fs.readFileSync(path.join(pkg, source));
  fs.writeFileSync(path.join(dest, name), bytes);
  hashes[name] = crypto.createHash('sha256').update(bytes).digest('hex');
}
fs.writeFileSync(path.join(dest, 'SOURCES.json'), JSON.stringify({ name: '@mozilla/readability', version: info.version, source: 'https://github.com/mozilla/readability/tree/0.6.0', license: 'Apache-2.0', sha256: hashes }, null, 2) + '\n');
