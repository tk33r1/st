#!/usr/bin/env node
// HTML の中の JS に直書きしたデータ定数を、名前で取り出して JSON で出す（magi-context.py が呼ぶ）。
// トップページの年表・自己紹介・性格検査は JS が画面に描くので、HTML の本文には無く data-magi の目印で読めない。
//
// 使い方: node magi-js-data.mjs <HTML のパス> <定数名>...   → {"定数名": 値, ...}
//
// 「const 名前 = 」の直後の [ か { から、対応する閉じ括弧までを切り出して評価する。文字列とコメントの中の括弧は数えない。
// 評価するのはこのリポジトリのファイルの、データだけのリテラル。関数呼び出しなどが混ざっていれば評価に失敗して止まる。
// （正規表現や文字列にバックスラッシュを書かないのは、手元の編集環境でエスケープが化けることがあるため）
import { readFileSync } from 'node:fs';

const [file, ...names] = process.argv.slice(2);
if (!file || !names.length) { console.error('使い方: node magi-js-data.mjs <HTML のパス> <定数名>...'); process.exit(2); }
const src = readFileSync(file, 'utf8');
const BACKSLASH = String.fromCharCode(92);
const NEWLINE = String.fromCharCode(10);

function literalOf(name) {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error(`定数名が不正: ${name}`);
  const m = new RegExp('const ' + name + ' *= *').exec(src);
  if (!m) throw new Error(`${file} に const ${name} が見つからない`);
  const start = m.index + m[0].length;
  if (src[start] !== '[' && src[start] !== '{') throw new Error(`const ${name} の値が配列かオブジェクトのリテラルではない`);
  let depth = 0;
  let quote = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === BACKSLASH) i++;           // エスケープされた次の1文字は飛ばす
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf(NEWLINE, i); if (i < 0) break; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; if (i <= 0) break; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`const ${name} の閉じ括弧が見つからない`);
}

const out = {};
for (const name of names) {
  try {
    out[name] = Function(`"use strict"; return (${literalOf(name)});`)();
  } catch (e) {
    console.error(`${name}: ${e.message}`);
    process.exit(1);
  }
}
process.stdout.write(JSON.stringify(out));
