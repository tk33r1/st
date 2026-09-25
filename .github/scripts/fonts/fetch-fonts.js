#!/usr/bin/env node
/* SAFE TOOLS が使う Web フォントを data/fonts/ に取り込む（手元で実行する。CI では動かさない）
 *
 *   node .github/scripts/fonts/fetch-fonts.js
 *
 * Google Fonts をページから直接読むと、画面に出した字（＝使う人が打った字）に
 * 応じて字の範囲ごとのファイルを Google へ取りに行く。QR Atelier の書き出しは
 * さらに、ラベルの字そのものを問い合わせていた。どちらも「アップロードなし」と
 * 並べるには苦しいので、Google が配っている分割済みのファイルをそのまま手元に置く。
 *
 * 分割はそのまま残す。日本語の書体は1ファイルにすると数 MB になるが、字の範囲
 * （unicode-range）ごとに分けておけば、ブラウザは使う字の分だけを取りに行くし、
 * 書き出しも使った字を含むファイルだけを SVG に埋め込めばよい。
 *
 * 書き出すもの:
 *   data/fonts/<書体>/*.woff2  … 分割されたフォント本体（Google のファイル名のまま）
 *   data/fonts/<書体>/OFL.txt  … ライセンス（どれも SIL Open Font License 1.1）
 *   data/fonts/<CSS名>.css     … ページが読む @font-face（下の CSS_FILES の単位）
 *
 * 書き出し（QR Atelier）は別の索引を持たず、ページが読み込んだこの CSS の
 * @font-face をそのまま引く。索引を別に作ると、CSS と食い違ったときに気づけない。
 *
 * 書体や太さを足すときは FAMILIES に足して実行し直す。同じファイルは取り直さない。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', '..', '..', 'data', 'fonts');

// woff2 と unicode-range 付きの CSS を返してもらうため、今のブラウザを名乗る
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

//   query … Google Fonts css2 の family 指定
//   dir   … data/fonts/ の下の置き場所
//   ofl   … google/fonts リポジトリでのライセンスの場所
//   css   … どの CSS に入れるか（ページごとに要る書体だけを読ませる）
const FAMILIES = [
  { query: 'Inter:wght@400;500;600;700;800', dir: 'inter', ofl: 'ofl/inter', css: 'ui' },
  { query: 'JetBrains Mono:wght@400;600;700', dir: 'jetbrains-mono', ofl: 'ofl/jetbrainsmono', css: 'ui' },
  // この書体だけ、ライセンスの置き場の名前が違う（mplusrounded1c には OFL.txt が無い。
  // 著作権者は同じ The Rounded M+ Project Authors）
  { query: 'M PLUS Rounded 1c:wght@700', dir: 'm-plus-rounded-1c', ofl: 'ofl/roundedmplus1c', css: 'jp' },
  { query: 'Noto Serif JP:wght@700', dir: 'noto-serif-jp', ofl: 'ofl/notoserifjp', css: 'jp' }
];

const CSS_FILES = {
  ui: '画面の文字（SAFE TOOLS 共通の Inter と JetBrains Mono）',
  jp: '日本語の書体（QR Atelier のラベルと文字ロゴ）'
};

async function get(url, binary) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(res.status + ' ' + url);
  return binary ? Buffer.from(await res.arrayBuffer()) : res.text();
}

// Google の CSS から @font-face を拾う。コメント（/* latin */ など）は捨てる。
function parseFaces(css) {
  const faces = [];
  for (const m of css.matchAll(/@font-face\s*{([^}]*)}/g)) {
    const body = m[1];
    const pick = re => { const x = body.match(re); return x ? x[1].trim() : ''; };
    faces.push({
      family: pick(/font-family:\s*'([^']+)'/),
      style: pick(/font-style:\s*([^;]+);/),
      weight: Number(pick(/font-weight:\s*([^;]+);/)),
      url: pick(/src:\s*url\(([^)]+)\)/),
      range: pick(/unicode-range:\s*([^;]+);/)
    });
  }
  return faces;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const cssOut = {};
  let faces = 0;
  let fetched = 0, kept = 0;

  for (const fam of FAMILIES) {
    const css = await get('https://fonts.googleapis.com/css2?family=' +
      encodeURIComponent(fam.query).replace(/%20/g, '+').replace(/%3A/g, ':').replace(/%40/g, '@').replace(/%3B/g, ';') +
      '&display=swap');
    const dir = path.join(OUT, fam.dir);
    fs.mkdirSync(dir, { recursive: true });

    for (const face of parseFaces(css)) {
      const name = path.basename(new URL(face.url).pathname);
      const file = path.join(dir, name);
      if (fs.existsSync(file)) {
        kept++;
      } else {
        fs.writeFileSync(file, await get(face.url, true));
        fetched++;
      }
      const rel = fam.dir + '/' + name;
      faces++;
      (cssOut[fam.css] = cssOut[fam.css] || []).push(
        '@font-face{font-family:"' + face.family + '";font-style:' + face.style +
        ';font-weight:' + face.weight + ';font-display:swap;src:url(' + rel +
        ') format("woff2");unicode-range:' + face.range + ';}');
    }

    fs.writeFileSync(path.join(dir, 'OFL.txt'),
      await get('https://raw.githubusercontent.com/google/fonts/main/' + fam.ofl + '/OFL.txt'));
    console.log(fam.query);
  }

  for (const [name, rules] of Object.entries(cssOut)) {
    fs.writeFileSync(path.join(OUT, name + '.css'),
      '/* ' + CSS_FILES[name] + '。.github/scripts/fonts/fetch-fonts.js が作る。手で直さない */\n' +
      rules.join('\n') + '\n');
  }
  console.log('woff2: 取得 ' + fetched + ' / 既存 ' + kept + '、@font-face ' + faces + ' 件');
})().catch(e => { console.error(e); process.exit(1); });
