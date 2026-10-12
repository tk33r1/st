// SVGを正本にAndroid/PWAを再生成し、生成器が消すmonochromeも復元する。
const {execFileSync} = require('node:child_process');
const {readFileSync, writeFileSync} = require('node:fs');
const {resolve, dirname} = require('node:path');
const assert = require('node:assert/strict');
const root = resolve(__dirname, '..');
const assets = dirname(require.resolve('@capacitor/assets/package.json'));
const sharp = require(require.resolve('sharp', {paths: [assets]}));
execFileSync(process.execPath, [resolve(assets, 'bin/capacitor-assets'), 'generate', '--android', '--assetPath', 'resources',
  '--iconBackgroundColor', '#0c0c0c', '--iconBackgroundColorDark', '#0c0c0c',
  '--splashBackgroundColor', '#0c0c0c', '--splashBackgroundColorDark', '#0c0c0c'], {cwd: root, stdio: 'inherit'});
const svg = readFileSync(resolve(root, 'resources/icon-monochrome.svg'), 'utf8');
const transform = /translate\((\d+) (\d+)\) scale\((\.[0-9]+)\) translate\((-\d+) (-\d+)\)/.exec(svg);
assert.ok(transform, '単色SVGの安全域の変換');
const [, x, y, scale, dx, dy] = transform.map(Number);
const paths = [...svg.matchAll(/<path d="([^"]+)"/g)].map(m => m[1]);
assert.equal(paths.length, 5);
const vector = '<?xml version="1.0" encoding="utf-8"?>\n'
  + '<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108">\n'
  + `    <group android:translateX="${x + scale * dx}" android:translateY="${y + scale * dy}" android:scaleX="${scale}" android:scaleY="${scale}">\n`
  + paths.map(d => `        <path android:pathData="${d}" android:fillColor="#00000000" android:strokeColor="#FFFFFFFF" android:strokeWidth="2" android:strokeLineJoin="round"/>\n`).join('')
  + '    </group>\n</vector>\n';
writeFileSync(resolve(root, 'android/app/src/main/res/drawable/ic_launcher_monochrome.xml'), vector);
for (const name of ['ic_launcher', 'ic_launcher_round']) {
  const file = resolve(root, 'android/app/src/main/res/mipmap-anydpi-v26', name + '.xml');
  const xml = readFileSync(file, 'utf8'); assert.ok(xml.includes('</adaptive-icon>'));
  writeFileSync(file, xml.replace(/\s*<monochrome\b[^>]*\/\s*>/g, '').replace('</adaptive-icon>', '    <monochrome android:drawable="@drawable/ic_launcher_monochrome" />\n</adaptive-icon>'));
}
(async () => {
  for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['icon-maskable-512.png', 512]]) {
    await sharp(resolve(root, 'resources/icon.svg')).resize(size, size).flatten({background: '#0c0c0c'}).png().toFile(resolve(root, 'www', name));
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
