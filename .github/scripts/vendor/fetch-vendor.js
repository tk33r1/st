#!/usr/bin/env node
/* SAFE TOOLS が使う外部ライブラリを assets/vendor/ に取り込む（手元で実行する。CI では動かさない）
 *
 *   node .github/scripts/vendor/fetch-vendor.js           取り込む（既にあるものは中身を確かめるだけ）
 *   node .github/scripts/vendor/fetch-vendor.js --check   取り込まず、置いてあるものが記録と同じかだけ見る
 *
 * CDN から読むスクリプトは、ページと同じ権限で動く（読み込んだファイルにも手が届く）。
 * CDN 側で中身が差し替わっても気づけないので、版を固定したものをこのサイトに置き、
 * どこから取ったか・中身の SHA-256 を assets/vendor/SOURCES.json に残す。
 * 版を上げるときは下の LIBS を直して実行し、SOURCES.json の差分ごとコミットする。
 *
 * ffmpeg-core.wasm（32MB）は Cloudflare Pages の1ファイル 25MB の上限を超えるので、
 * 2つに分けて置く（split）。使うときは tools/assets/tools-ui.js の STCommon.fetchVerified が
 * SOURCES.json の split を読んでつなぎ直し、元のファイルの SHA-256 と照らし合わせる。
 *
 * ページは Content-Security-Policy で 'unsafe-eval' を許していないので、文字列からコードを
 * 作るライブラリはそのままでは止まる。取り込みのたびに patches.js の置き換えを当て、当てた
 * あとの SHA-256 を記録する。
 * 同梱の JS に文字列からコードを作る処理が残っていないかも毎回確かめ、DYNAMIC_OK に
 * 理由を書いたもの以外が見つかったら止める。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..', '..');
const OUT = path.join(ROOT, 'assets', 'vendor');
const JSD = 'https://cdn.jsdelivr.net/npm/';
// @ffmpeg の3パッケージは同じリポジトリ（ffmpegwasm/ffmpeg.wasm、MIT）。npm には LICENSE が入っていない
const FFMPEG_WASM_LICENSE = 'https://raw.githubusercontent.com/ffmpegwasm/ffmpeg.wasm/v0.12.10/LICENSE';

// pdf.js の文字コード対応表（CMap）。フォントを埋め込まない日本語・中国語・韓国語の PDF から文字を取り出すのに要る
// （MAGI の添付。pdf.js は使う表だけを読む）。名前は pdfjs-dist@6.4.299 の cmaps/ の .bcmap すべて
const PDFJS_CMAPS = [
  '78-EUC-H', '78-EUC-V', '78-H', '78-RKSJ-H', '78-RKSJ-V', '78-V', '78ms-RKSJ-H', '78ms-RKSJ-V',
  '83pv-RKSJ-H', '90ms-RKSJ-H', '90ms-RKSJ-V', '90msp-RKSJ-H', '90msp-RKSJ-V', '90pv-RKSJ-H', '90pv-RKSJ-V',
  'Add-H', 'Add-RKSJ-H', 'Add-RKSJ-V', 'Add-V', 'Adobe-CNS1-0', 'Adobe-CNS1-1', 'Adobe-CNS1-2', 'Adobe-CNS1-3',
  'Adobe-CNS1-4', 'Adobe-CNS1-5', 'Adobe-CNS1-6', 'Adobe-CNS1-UCS2', 'Adobe-GB1-0', 'Adobe-GB1-1',
  'Adobe-GB1-2', 'Adobe-GB1-3', 'Adobe-GB1-4', 'Adobe-GB1-5', 'Adobe-GB1-UCS2', 'Adobe-Japan1-0',
  'Adobe-Japan1-1', 'Adobe-Japan1-2', 'Adobe-Japan1-3', 'Adobe-Japan1-4', 'Adobe-Japan1-5', 'Adobe-Japan1-6',
  'Adobe-Japan1-UCS2', 'Adobe-Korea1-0', 'Adobe-Korea1-1', 'Adobe-Korea1-2', 'Adobe-Korea1-UCS2', 'B5-H',
  'B5-V', 'B5pc-H', 'B5pc-V', 'CNS-EUC-H', 'CNS-EUC-V', 'CNS1-H', 'CNS1-V', 'CNS2-H', 'CNS2-V', 'ETen-B5-H',
  'ETen-B5-V', 'ETenms-B5-H', 'ETenms-B5-V', 'ETHK-B5-H', 'ETHK-B5-V', 'EUC-H', 'EUC-V', 'Ext-H', 'Ext-RKSJ-H',
  'Ext-RKSJ-V', 'Ext-V', 'GB-EUC-H', 'GB-EUC-V', 'GB-H', 'GB-V', 'GBK-EUC-H', 'GBK-EUC-V', 'GBK2K-H',
  'GBK2K-V', 'GBKp-EUC-H', 'GBKp-EUC-V', 'GBpc-EUC-H', 'GBpc-EUC-V', 'GBT-EUC-H', 'GBT-EUC-V', 'GBT-H',
  'GBT-V', 'GBTpc-EUC-H', 'GBTpc-EUC-V', 'H', 'Hankaku', 'Hiragana', 'HKdla-B5-H', 'HKdla-B5-V', 'HKdlb-B5-H',
  'HKdlb-B5-V', 'HKgccs-B5-H', 'HKgccs-B5-V', 'HKm314-B5-H', 'HKm314-B5-V', 'HKm471-B5-H', 'HKm471-B5-V',
  'HKscs-B5-H', 'HKscs-B5-V', 'Katakana', 'KSC-EUC-H', 'KSC-EUC-V', 'KSC-H', 'KSC-Johab-H', 'KSC-Johab-V',
  'KSC-V', 'KSCms-UHC-H', 'KSCms-UHC-HW-H', 'KSCms-UHC-HW-V', 'KSCms-UHC-V', 'KSCpc-EUC-H', 'KSCpc-EUC-V',
  'NWP-H', 'NWP-V', 'RKSJ-H', 'RKSJ-V', 'Roman', 'UniCNS-UCS2-H', 'UniCNS-UCS2-V', 'UniCNS-UTF8-H',
  'UniCNS-UTF8-V', 'UniCNS-UTF16-H', 'UniCNS-UTF16-V', 'UniCNS-UTF32-H', 'UniCNS-UTF32-V', 'UniGB-UCS2-H',
  'UniGB-UCS2-V', 'UniGB-UTF8-H', 'UniGB-UTF8-V', 'UniGB-UTF16-H', 'UniGB-UTF16-V', 'UniGB-UTF32-H',
  'UniGB-UTF32-V', 'UniJIS-UCS2-H', 'UniJIS-UCS2-HW-H', 'UniJIS-UCS2-HW-V', 'UniJIS-UCS2-V', 'UniJIS-UTF8-H',
  'UniJIS-UTF8-V', 'UniJIS-UTF16-H', 'UniJIS-UTF16-V', 'UniJIS-UTF32-H', 'UniJIS-UTF32-V', 'UniJIS2004-UTF8-H',
  'UniJIS2004-UTF8-V', 'UniJIS2004-UTF16-H', 'UniJIS2004-UTF16-V', 'UniJIS2004-UTF32-H', 'UniJIS2004-UTF32-V',
  'UniJISPro-UCS2-HW-V', 'UniJISPro-UCS2-V', 'UniJISPro-UTF8-V', 'UniJISX0213-UTF32-H', 'UniJISX0213-UTF32-V',
  'UniJISX02132004-UTF32-H', 'UniJISX02132004-UTF32-V', 'UniKS-UCS2-H', 'UniKS-UCS2-V', 'UniKS-UTF8-H',
  'UniKS-UTF8-V', 'UniKS-UTF16-H', 'UniKS-UTF16-V', 'UniKS-UTF32-H', 'UniKS-UTF32-V', 'V', 'WP-Symbol'
];

//   dir   … assets/vendor/ の下の置き場所（パッケージ名@版）
//   files … [取得元, 置く名前]。置く名前は dir からの相対
//   license … ライセンス文の取得元（dir/LICENSE に置く）。取れる場所が無いときは { text } で書く
const LIBS = [
  { dir: 'lucide@0.263.0', license: JSD + 'lucide@0.263.0/LICENSE',
    files: [[JSD + 'lucide@0.263.0/dist/umd/lucide.min.js', 'lucide.min.js']] },
  { dir: 'encoding-japanese@2.4.0', license: JSD + 'encoding-japanese@2.4.0/LICENSE',
    files: [[JSD + 'encoding-japanese@2.4.0/encoding.min.js', 'encoding.min.js']] },
  { dir: 'jszip@3.10.1', license: JSD + 'jszip@3.10.1/LICENSE.markdown',
    files: [[JSD + 'jszip@3.10.1/dist/jszip.min.js', 'jszip.min.js']] },
  { dir: 'sortablejs@1.15.2', license: JSD + 'sortablejs@1.15.2/LICENSE',
    files: [[JSD + 'sortablejs@1.15.2/Sortable.min.js', 'Sortable.min.js']] },
  // npm のパッケージに LICENSE が入っていないものは、リポジトリから取る
  { dir: 'heic2any@0.0.4', license: 'https://raw.githubusercontent.com/alexcorvi/heic2any/master/LICENSE.md',
    files: [[JSD + 'heic2any@0.0.4/dist/heic2any.min.js', 'heic2any.min.js']] },
  { dir: 'imagetracerjs@1.2.6', license: JSD + 'imagetracerjs@1.2.6/LICENSE',
    files: [[JSD + 'imagetracerjs@1.2.6/imagetracer_v1.2.6.js', 'imagetracer_v1.2.6.js']] },
  { dir: 'svgo@3.3.5', license: JSD + 'svgo@3.3.5/LICENSE',
    files: [[JSD + 'svgo@3.3.5/dist/svgo.browser.js', 'svgo.browser.js']] },
  // pdf-studio と MAGI の添付（トップページと magi-app）。CVE-2024-4367 を直した 4.2.67 以降を使う（6.4.299 は文字列からコードを作らない）。
  // 古い iPhone・Android の WebView でも動く互換版（legacy）。ES モジュールだが、Capacitor が .mjs の種類を返さない
  // おそれがあるので .js の名前で置く。cmaps は文字コード対応表、standard_fonts は埋め込まれていない標準フォントの代わり
  // （フォントをブラウザへ渡さない disableFontFace でも描ける）、wasm は JPEG2000・JBIG2（スキャンに多い）と色の変換、iccs は色の変換の既定
  { dir: 'pdfjs-dist@6.4.299', license: JSD + 'pdfjs-dist@6.4.299/LICENSE',
    files: [[JSD + 'pdfjs-dist@6.4.299/legacy/build/pdf.min.mjs', 'pdf.min.js'],
            [JSD + 'pdfjs-dist@6.4.299/legacy/build/pdf.worker.min.mjs', 'pdf.worker.min.js'],
            ...['cmaps/LICENSE', ...PDFJS_CMAPS.map(name => 'cmaps/' + name + '.bcmap'),
              ...['FoxitDingbats.pfb', 'FoxitFixed.pfb', 'FoxitFixedBold.pfb', 'FoxitFixedBoldItalic.pfb', 'FoxitFixedItalic.pfb',
                'FoxitSerif.pfb', 'FoxitSerifBold.pfb', 'FoxitSerifBoldItalic.pfb', 'FoxitSerifItalic.pfb', 'FoxitSymbol.pfb',
                'LiberationSans-Bold.ttf', 'LiberationSans-BoldItalic.ttf', 'LiberationSans-Italic.ttf', 'LiberationSans-Regular.ttf',
                'LICENSE_FOXIT', 'LICENSE_LIBERATION'].map(name => 'standard_fonts/' + name),
              ...['jbig2.wasm', 'openjpeg.wasm', 'qcms_bg.wasm', 'LICENSE_JBIG2', 'LICENSE_OPENJPEG', 'LICENSE_PDFJS_JBIG2',
                'LICENSE_PDFJS_OPENJPEG', 'LICENSE_PDFJS_QCMS', 'LICENSE_QCMS'].map(name => 'wasm/' + name),
              'iccs/CGATS001Compat-v2-micro.icc', 'iccs/LICENSE']
              .map(name => [JSD + 'pdfjs-dist@6.4.299/' + name, name])] },
  { dir: 'pdf-lib@1.17.1', license: JSD + 'pdf-lib@1.17.1/LICENSE.md',
    files: [[JSD + 'pdf-lib@1.17.1/dist/pdf-lib.min.js', 'pdf-lib.min.js']] },
  // リポジトリにもライセンス文のファイルが無い。package.json の license 欄（MIT）を書き残す
  { dir: '@pdf-lib/fontkit@1.1.1', license: { text: [
      '@pdf-lib/fontkit 1.1.1 は MIT License（package.json の license 欄）。',
      'npm のパッケージにもリポジトリ（github.com/Hopding/fontkit）にもライセンス文のファイルが無いため、この記録を置く。',
      '元になった fontkit（Devon Govett）も MIT License。', ''].join(String.fromCharCode(10)) },
    files: [[JSD + '@pdf-lib/fontkit@1.1.1/dist/fontkit.umd.min.js', 'fontkit.umd.min.js']] },
  { dir: '@ffmpeg/ffmpeg@0.12.10', license: FFMPEG_WASM_LICENSE,
    files: [[JSD + '@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js', 'ffmpeg.js'],
            [JSD + '@ffmpeg/ffmpeg@0.12.10/dist/umd/814.ffmpeg.js', '814.ffmpeg.js']] },
  { dir: '@ffmpeg/util@0.12.1', license: FFMPEG_WASM_LICENSE,
    files: [[JSD + '@ffmpeg/util@0.12.1/dist/umd/index.js', 'index.js']] },
  // wasm（32MB）は1ファイルでは置けないので、2つに分けて置く
  { dir: '@ffmpeg/core@0.12.6', license: FFMPEG_WASM_LICENSE,
    files: [[JSD + '@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.js', 'ffmpeg-core.js']],
    split: [[JSD + '@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.wasm', 'ffmpeg-core.wasm', 2]] },
  // jsquash は 'wasm-feature-detect' を名前だけで import する。使うページの import map で
  // 下の wasm-feature-detect へ向ける（ライブラリ自体は書き換えない）
  { dir: '@jsquash/avif@2.1.1', license: JSD + '@jsquash/avif@2.1.1/LICENSE',
    files: ['encode.js', 'meta.js', 'utils.js',
      'codec/enc/avif_enc.js', 'codec/enc/avif_enc.wasm',
      'codec/enc/avif_enc_mt.js', 'codec/enc/avif_enc_mt.wasm', 'codec/enc/avif_enc_mt.worker.mjs']
      .map(f => [JSD + '@jsquash/avif@2.1.1/' + f, f]) },
  { dir: '@jsquash/webp@1.4.0', license: JSD + '@jsquash/webp@1.4.0/LICENSE',
    files: ['encode.js', 'meta.js', 'utils.js', 'codec/LICENSE.codec.md',
      'codec/enc/webp_enc.js', 'codec/enc/webp_enc.wasm',
      'codec/enc/webp_enc_simd.js', 'codec/enc/webp_enc_simd.wasm']
      .map(f => [JSD + '@jsquash/webp@1.4.0/' + f, f]) },
  { dir: 'wasm-feature-detect@1.9.0', license: JSD + 'wasm-feature-detect@1.9.0/LICENSE',
    files: [[JSD + 'wasm-feature-detect@1.9.0/dist/esm/index.js', 'index.js']] },
  // pdf-studio の日本語の書き込み用（fontkit で PDF に埋め込むので TTF のまま）
  { dir: '@fontsource/noto-sans-jp@5.3.0', license: JSD + '@fontsource/noto-sans-jp@5.3.0/LICENSE',
    files: [['https://cdn.jsdelivr.net/fontsource/fonts/noto-sans-jp@5.3.0/japanese-400-normal.ttf', 'japanese-400-normal.ttf']] },
  // QR Palette の読み取りテスト（tools/qr-palette/qr-verify.js）に使うデコーダ
  { dir: 'jsqr@1.4.0', license: JSD + 'jsqr@1.4.0/LICENSE',
    files: [[JSD + 'jsqr@1.4.0/dist/jsQR.js', 'jsQR.js']] },
  { dir: 'zxing-wasm@3.1.3', license: JSD + 'zxing-wasm@3.1.3/LICENSE',
    files: [[JSD + 'zxing-wasm@3.1.3/dist/iife/reader/index.js', 'zxing_reader.js'],
            [JSD + 'zxing-wasm@3.1.3/dist/reader/zxing_reader.wasm', 'zxing_reader.wasm']] },
  // 本体だけ。呼び出し口（dist/index.mjs）は tk.st で書き直したので tools/qr-palette/qr-wechat.js に置いている
  { dir: 'qr-scanner-wechat@0.1.3', license: JSD + 'qr-scanner-wechat@0.1.3/LICENSE',
    files: [[JSD + 'qr-scanner-wechat@0.1.3/dist/wasm.mjs', 'wasm.js']] }
];

const { PATCHES, DYNAMIC_CODE, applyPatches } = require('./patches');

// 同梱の JS に残っていてよい「文字列からコードを作る処理」とその件数。どれも CSP の下では
// 通らない経路なので実害がない。件数が変わったら（版を上げたときなど）中身を見て判断し直す
const DYNAMIC_OK = {
  'assets/vendor/@ffmpeg/ffmpeg@0.12.10/ffmpeg.js': [1, 'globalThis が無い古い環境向けの予備（いまのブラウザでは通らない）'],
  'assets/vendor/jszip@3.10.1/jszip.min.js': [1, 'setImmediate に関数以外が渡されたときの予備（使われない）']
};

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

// 置き換えを当てる。{ buf, applied（今回当てた数）, count（当てるべき数） }。形が変わっていて
// 当てられないものがあれば止める（黙って当てないまま置くと、CSP の下で動かない）
function patchBuffer(key, buf) {
  const list = PATCHES[key];
  if (!list) return { buf, applied: 0, count: 0 };
  const r = applyPatches(buf.toString('utf8'), list);
  if (r.pending) throw new Error('置き換えを当てられない（ライブラリの形が変わった）: ' + key);
  return { buf: r.applied ? Buffer.from(r.text, 'utf8') : buf, applied: r.applied, count: list.length };
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(res.status + ' ' + url);
  return Buffer.from(await res.arrayBuffer());
}

(async () => {
  const checkOnly = process.argv.includes('--check');
  const recordFile = path.join(OUT, 'SOURCES.json');
  const prev = fs.existsSync(recordFile) ? JSON.parse(fs.readFileSync(recordFile, 'utf8')) : { files: {}, split: {} };
  const record = { files: {}, split: {} };
  let fetched = 0, bad = 0;

  for (const lib of LIBS) {
    const entries = lib.files.concat([[lib.license, 'LICENSE']]);
    for (const [from, name] of entries) {
      if (typeof from === 'object') {
        // 取得元の無いライセンスの記録。中身はここに書いたとおり
        const buf = Buffer.from(from.text, 'utf8');
        const file = path.join(OUT, lib.dir, name);
        if (!checkOnly) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, buf); }
        record.files[lib.dir + '/' + name] = { from: 'package.json', sha256: sha256(buf) };
        continue;
      }
      const rel = lib.dir + '/' + name;
      const file = path.join(OUT, lib.dir, name);
      const known = prev.files[rel];
      let buf;
      if (fs.existsSync(file)) {
        buf = fs.readFileSync(file);
      } else if (checkOnly) {
        console.error('置かれていない: ' + rel); bad++; continue;
      } else {
        buf = await get(from);
        fetched++;
      }
      const p = patchBuffer('assets/vendor/' + rel, buf);
      if (p.applied && checkOnly) { console.error('置き換えが当たっていない: ' + rel); bad++; }
      if (p.applied || !fs.existsSync(file)) {
        if (!checkOnly) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, p.buf); }
        if (p.applied) console.log('置き換えを当てた: ' + rel + '（' + p.applied + ' か所）');
      }
      const sum = sha256(p.buf);
      // 今回置き換えを当てたものは、記録と違って当然なので咎めない
      if (known && known.sha256 !== sum && !p.applied) { console.error('記録と違う: ' + rel); bad++; }
      record.files[rel] = p.count ? { from: from, sha256: sum, patched: p.count } : { from: from, sha256: sum };
    }
    // 分けて置くもの。<名前>.part1, .part2 … に分け、つないだときの SHA-256 も残す
    for (const [from, name, count] of lib.split || []) {
      const parts = Array.from({ length: count }, (_, i) => name + '.part' + (i + 1));
      const files = parts.map(p => path.join(OUT, lib.dir, p));
      let whole;
      if (files.every(f => fs.existsSync(f))) {
        whole = Buffer.concat(files.map(f => fs.readFileSync(f)));
      } else if (checkOnly) {
        console.error('置かれていない: ' + lib.dir + '/' + name + '.part*'); bad++; continue;
      } else {
        whole = await get(from);
        const size = Math.ceil(whole.length / count);
        files.forEach((f, i) => fs.writeFileSync(f, whole.subarray(i * size, (i + 1) * size)));
        fetched += count;
      }
      parts.forEach((p, i) => {
        const rel = lib.dir + '/' + p;
        const sum = sha256(fs.readFileSync(files[i]));
        if (prev.files[rel] && prev.files[rel].sha256 !== sum) { console.error('記録と違う: ' + rel); bad++; }
        record.files[rel] = { from: from + '（' + count + '分割の' + (i + 1) + '）', sha256: sum };
      });
      const key = lib.dir + '/' + name;
      const sum = sha256(whole);
      if (prev.split && prev.split[key] && prev.split[key].sha256 !== sum) { console.error('記録と違う: ' + key); bad++; }
      record.split[key] = { from: from, parts: parts.map(p => lib.dir + '/' + p), size: whole.length, sha256: sum };
    }
  }

  // 同梱の JS に、文字列からコードを作る処理が残っていないか（CSP の下で止まる）
  const re = new RegExp(DYNAMIC_CODE.source, 'g');
  for (const f of walk(OUT).filter(f => /\.m?js$/.test(f))) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    const n = (fs.readFileSync(f, 'utf8').match(re) || []).length;
    const ok = DYNAMIC_OK[rel] ? DYNAMIC_OK[rel][0] : 0;
    if (n !== ok) { console.error('文字列からコードを作る処理が ' + n + ' 件（許しているのは ' + ok + ' 件）: ' + rel); bad++; }
  }

  if (!checkOnly) fs.writeFileSync(recordFile, JSON.stringify(record, null, 1) + '\n');
  console.log('取得 ' + fetched + ' 件、記録 ' + Object.keys(record.files).length + ' 件' + (bad ? '、食い違い ' + bad + ' 件' : ''));
  if (bad) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
