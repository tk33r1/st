/*!
 * Diff Studio — diff engine
 * 無依存 / ブラウザ・Node 両対応 / 完全ローカル処理
 *
 * 流れ:
 *   1. tokenize()  … 粒度ごとにトークン列へ分割（書記素・単語・文・行）
 *   2. buildSeq()  … 「無視オプション」を適用した比較キー列を作る。
 *                    キーが空になったトークン（＝無視対象）は比較列から外れるので、
 *                    差分としては一切出てこない。描画時は eq 側へ寄せる。
 *   3. myers()     … O(ND) 差分。前後の共通部分を削ってから流す。
 *   4. diff()      … 上を束ねてチャンク列を返す。Accept/Reject はこの単位。
 */

/* ------------------------------------------------------------------ *
 * トークナイズ
 * ------------------------------------------------------------------ */

const segmenters = new Map();
function segmenter(granularity) {
  let s = segmenters.get(granularity);
  if (!s) {
    s = new Intl.Segmenter('ja', { granularity });
    segmenters.set(granularity, s);
  }
  return s;
}

/**
 * @param {string} text
 * @param {'char'|'word'|'sentence'|'line'} mode
 * @param {RegExp|null} atomRe 割ってはいけない語。char / word 粒度で効く（下の注記参照）
 * @returns {{v:string,i:number}[]} v=原文のまま / i=開始オフセット
 */
export function tokenize(text, mode = 'char', atomRe = null) {
  if (!text) return [];

  if (mode === 'line' || mode === 'sentence') {
    // 区切り文字は直前のトークンに含める（改行や句点が単独で差分に出ないように）
    const re = mode === 'line' ? /\n/g : /[。．！？!?\n]/g;
    const out = [];
    let start = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      out.push({ v: text.slice(start, m.index + m[0].length), i: start });
      start = m.index + m[0].length;
    }
    if (start < text.length) out.push({ v: text.slice(start), i: start });
    return out;
  }

  // char は書記素クラスタ単位。絵文字・結合文字・異体字セレクタが割れない。
  const granularity = mode === 'word' ? 'word' : 'grapheme';
  const out = [];

  // Intl.Segmenter は「行なう」を 行/な/う、「下さい」を 下/さい のように割る。
  // 割れたトークンには送り仮名の表が当たらないため、正規化したい語だけは先に
  // 切り出して1トークンにまとめる。v は原文のままなので、chunkText と
  // applyChunks が返す文字列は影響を受けない。
  if (atomRe) {
    let last = 0;
    let m;
    atomRe.lastIndex = 0;
    while ((m = atomRe.exec(text)) !== null) {
      if (m.index > last) segmentInto(out, text.slice(last, m.index), granularity, last);
      out.push({ v: m[0], i: m.index });
      last = m.index + m[0].length;
    }
    if (last < text.length) segmentInto(out, text.slice(last), granularity, last);
    return out;
  }

  segmentInto(out, text, granularity, 0);
  return out;
}

function segmentInto(out, text, granularity, offset) {
  for (const s of segmenter(granularity).segment(text)) {
    out.push({ v: s.segment, i: offset + s.index });
  }
}

/* ------------------------------------------------------------------ *
 * 正規化（無視オプション）
 * ------------------------------------------------------------------ */

// 記号の表記ゆれ。左を右へ寄せてから比較する。
const PUNCT_CANON = new Map(Object.entries({
  '，': '、', ',': '、', '．': '。', '.': '。',
  '－': '-', '‐': '-', '−': '-', '—': '-',
  '～': '~', '〜': '~',
  '“': '"', '”': '"', '„': '"',
  '‘': "'", '’': "'",
  '（': '(', '）': ')', '［': '[', '］': ']', '｛': '{', '｝': '}',
  '「': '"', '」': '"', '『': '"', '』': '"',
  '：': ':', '；': ';', '！': '!', '？': '?', '・': '/',
}));

// 送り仮名・表記ゆれの正規形。網羅ではなく実務で頻出するものを収録。
// 単語粒度で最も効く。増補しやすいよう素の表で持つ。
const OKURIGANA_CANON = new Map(Object.entries({
  '行なう': '行う', '行ない': '行い', '行なっ': '行っ',
  '問合せ': '問い合わせ', '問合わせ': '問い合わせ', 'お問合せ': 'お問い合わせ',
  '引越し': '引っ越し', '引越': '引っ越し',
  '申込': '申し込み', '申込み': '申し込み',
  '受付け': '受付', '受け付け': '受付',
  '取扱い': '取り扱い', '取扱': '取り扱い',
  '打合せ': '打ち合わせ', '打合わせ': '打ち合わせ',
  '差引き': '差し引き', '差引': '差し引き',
  '売上げ': '売上', '売り上げ': '売上',
  '見積り': '見積もり', '見積': '見積もり',
  '手続': '手続き',
  '組合せ': '組み合わせ', '組合わせ': '組み合わせ',
  '振込み': '振込', '振り込み': '振込',
  '割引き': '割引',
  '締切': '締め切り', '締切り': '締め切り',
  '但し': 'ただし', '尚': 'なお', '又は': 'または', '若しくは': 'もしくは',
  '出来る': 'できる', '出来ます': 'できます',
  '下さい': 'ください', '致します': 'いたします', '頂く': 'いただく',
}));

// 上の表を、長いものから順に試す1本の正規表現に畳む。tokenize に渡して
// 「行なう」「下さい」が語の途中で割れないようにするために使う。
//
// 表記ゆれ側（キー）だけでなく正規形（値）も入れること。片側だけを1トークンに
// まとめても、もう片方は Segmenter が割ってしまい、両者のトークン列が揃わない。
// 「行なっ」を1つにまとめるなら「行っ」も1つにまとめる必要がある。
let okuriganaAtomRe = null;
function okuriganaAtoms() {
  if (!okuriganaAtomRe) {
    const words = [...new Set([...OKURIGANA_CANON.keys(), ...OKURIGANA_CANON.values()])]
      .sort((a, b) => b.length - a.length);
    okuriganaAtomRe = new RegExp(words.join('|'), 'g');
  }
  return okuriganaAtomRe;
}

const WS_RE = /[\s　​﻿]/g;

/**
 * 比較用キーを作る。空文字を返した場合、そのトークンは「無視対象」。
 * @param {string} v
 * @param {object} opts
 */
export function normalizeKey(v, opts = {}) {
  let k = v;

  if (opts.ignoreOkurigana && OKURIGANA_CANON.has(k)) k = OKURIGANA_CANON.get(k);

  // NFKC が全角英数→半角・半角カナ→全角カナをまとめて片付ける
  if (opts.ignoreWidth) k = k.normalize('NFKC');

  if (opts.ignoreCase) k = k.toLowerCase();

  if (opts.ignorePunct) {
    let out = '';
    for (const ch of k) out += PUNCT_CANON.get(ch) ?? ch;
    k = out;
  }

  if (opts.ignoreSpace) k = k.replace(WS_RE, '');

  return k;
}

/**
 * 比較列を組み立てる。無視対象トークンは列から落とし、
 * idx で元トークン位置へ戻れるようにしておく。
 */
function buildSeq(tokens, opts) {
  const keys = [];
  const idx = [];
  for (let t = 0; t < tokens.length; t++) {
    const k = normalizeKey(tokens[t].v, opts);
    if (k === '') continue; // 無視対象 → 差分に出さない
    keys.push(k);
    idx.push(t);
  }
  return { keys, idx };
}

/* ------------------------------------------------------------------ *
 * Myers 差分
 * ------------------------------------------------------------------ */

/**
 * 編集グラフの最短経路を求める。
 * @returns {{type:'eq'|'del'|'ins', aStart, aEnd, bStart, bEnd}[]}
 *          maxD を超えた場合は null（呼び出し側で粒度を落とす）
 */
export function myers(a, b, maxD = 1500) {
  const N = a.length;
  const M = b.length;

  // 共通の前後を削る。実文書ではここで大半が落ちて O(ND) が現実的になる。
  let pre = 0;
  while (pre < N && pre < M && a[pre] === b[pre]) pre++;
  let post = 0;
  while (post < N - pre && post < M - pre && a[N - 1 - post] === b[M - 1 - post]) post++;

  const A = a.slice(pre, N - post);
  const B = b.slice(pre, M - post);
  const n = A.length;
  const m = B.length;

  const ops = [];
  const push = (type, aS, aE, bS, bE) => {
    if (aS === aE && bS === bE) return;
    const last = ops[ops.length - 1];
    if (last && last.type === type) {
      last.aEnd = aE;
      last.bEnd = bE;
      return;
    }
    ops.push({ type, aStart: aS, aEnd: aE, bStart: bS, bEnd: bE });
  };

  if (pre) push('eq', 0, pre, 0, pre);

  if (n === 0 || m === 0) {
    if (n) push('del', pre, pre + n, pre, pre);
    if (m) push('ins', pre + n, pre + n, pre, pre + m);
  } else {
    const max = Math.min(n + m, maxD);
    const off = max;
    const size = 2 * max + 2;
    const V = new Int32Array(size);
    const trace = [];
    let found = false;

    outer: for (let D = 0; D <= max; D++) {
      trace.push(V.slice());
      for (let k = -D; k <= D; k += 2) {
        let x;
        if (k === -D || (k !== D && V[k - 1 + off] < V[k + 1 + off])) x = V[k + 1 + off];
        else x = V[k - 1 + off] + 1;
        let y = x - k;
        while (x < n && y < m && A[x] === B[y]) { x++; y++; }
        V[k + off] = x;
        if (x >= n && y >= m) { found = true; break outer; }
      }
    }

    if (!found) return null; // 差分が大きすぎる

    // 経路を逆順に復元する
    const path = [];
    let x = n;
    let y = m;
    for (let D = trace.length - 1; D >= 0; D--) {
      const Vp = trace[D];
      const k = x - y;
      let prevK;
      if (k === -D || (k !== D && Vp[k - 1 + off] < Vp[k + 1 + off])) prevK = k + 1;
      else prevK = k - 1;
      const prevX = Vp[prevK + off];
      const prevY = prevX - prevK;

      while (x > prevX && y > prevY) { x--; y--; path.push(['eq', x, y]); }
      if (D > 0) path.push([x === prevX ? 'ins' : 'del', prevX, prevY]);
      x = prevX;
      y = prevY;
    }
    path.reverse();

    for (const [type, ax, by] of path) {
      if (type === 'eq') push('eq', pre + ax, pre + ax + 1, pre + by, pre + by + 1);
      else if (type === 'del') push('del', pre + ax, pre + ax + 1, pre + by, pre + by);
      else push('ins', pre + ax, pre + ax, pre + by, pre + by + 1);
    }
  }

  if (post) push('eq', N - post, N, M - post, M);
  return ops;
}

/* ------------------------------------------------------------------ *
 * チャンク化
 * ------------------------------------------------------------------ */

/**
 * ops（比較列インデックス）をトークン範囲へ展開する。
 * 無視トークンは直近の eq チャンクへ吸収させ、差分として表示されないようにする。
 */
function buildChunks(aLen, bLen, sa, sb, ops) {
  const out = [];
  let ai = 0;
  let bi = 0;

  const pushEq = (aEnd, bEnd) => {
    if (aEnd <= ai && bEnd <= bi) return;
    const last = out[out.length - 1];
    if (last && last.type === 'eq') {
      last.a[1] = aEnd;
      last.b[1] = bEnd;
    } else {
      out.push({ type: 'eq', a: [ai, aEnd], b: [bi, bEnd] });
    }
    ai = aEnd;
    bi = bEnd;
  };

  for (const op of ops) {
    if (op.type === 'eq') {
      pushEq(sa.idx[op.aEnd - 1] + 1, sb.idx[op.bEnd - 1] + 1);
    } else if (op.type === 'del') {
      const end = sa.idx[op.aEnd - 1] + 1;
      pushEq(sa.idx[op.aStart], bi); // 手前の無視トークンを eq として先に吐く
      out.push({ type: 'del', a: [ai, end], b: [bi, bi] });
      ai = end;
    } else {
      const end = sb.idx[op.bEnd - 1] + 1;
      pushEq(ai, sb.idx[op.bStart]);
      out.push({ type: 'ins', a: [ai, ai], b: [bi, end] });
      bi = end;
    }
  }
  pushEq(aLen, bLen); // 末尾に残った無視トークン

  // 隣接する del + ins は「置換」に畳む。Accept/Reject の単位として自然なため。
  const merged = [];
  for (const c of out) {
    const last = merged[merged.length - 1];
    if (last && last.type === 'del' && c.type === 'ins') {
      merged[merged.length - 1] = { type: 'replace', a: last.a, b: c.b };
    } else merged.push(c);
  }
  return merged.filter((c) => c.a[0] !== c.a[1] || c.b[0] !== c.b[1]);
}

/* ------------------------------------------------------------------ *
 * 公開 API
 * ------------------------------------------------------------------ */

/**
 * @param {string} before
 * @param {string} after
 * @param {object} opts
 *   mode: 'char'|'word'|'sentence'|'line'
 *   ignoreWidth / ignoreSpace / ignorePunct / ignoreCase / ignoreOkurigana
 * @returns {{a, b, chunks, stats, mode}}
 */
export function diff(before, after, opts = {}) {
  const mode = opts.mode || 'char';
  const atomRe = opts.ignoreOkurigana ? okuriganaAtoms() : null;
  const a = tokenize(before, mode, atomRe);
  const b = tokenize(after, mode, atomRe);

  const sa = buildSeq(a, opts);
  const sb = buildSeq(b, opts);

  let ops = myers(sa.keys, sb.keys, opts.maxD ?? 1500);

  // 差分が大きすぎる場合は粒度を落として再試行する
  if (ops === null && mode !== 'line') {
    return diff(before, after, { ...opts, mode: 'line' });
  }
  if (ops === null) {
    ops = [];
    if (sa.keys.length) ops.push({ type: 'del', aStart: 0, aEnd: sa.keys.length, bStart: 0, bEnd: 0 });
    if (sb.keys.length) ops.push({ type: 'ins', aStart: 0, aEnd: 0, bStart: 0, bEnd: sb.keys.length });
  }

  const chunks = buildChunks(a.length, b.length, sa, sb, ops);
  return { a, b, chunks, stats: countStats(a, b, chunks), mode };
}

function graphemeLen(s) {
  let n = 0;
  for (const _ of segmenter('grapheme').segment(s)) n++;
  return n;
}

function countStats(a, b, chunks) {
  let removed = 0;
  let added = 0;
  let unchanged = 0;
  for (const c of chunks) {
    const aText = chunkText(a, c.a);
    const bText = chunkText(b, c.b);
    if (c.type === 'eq') unchanged += graphemeLen(aText);
    else {
      removed += graphemeLen(aText);
      added += graphemeLen(bText);
    }
  }
  return { added, removed, unchanged, delta: added - removed };
}

/** チャンク範囲から原文の文字列を取り出す */
export function chunkText(tokens, range) {
  let s = '';
  for (let i = range[0]; i < range[1]; i++) s += tokens[i].v;
  return s;
}

/**
 * チャンクの採否から最終テキストを組み立てる。
 * AI 提案の Accept / Reject はこれで反映する。
 * @param {object} result diff() の戻り値
 * @param {Set<number>} rejected 却下したチャンクの添字
 */
export function applyChunks(result, rejected = new Set()) {
  let out = '';
  result.chunks.forEach((c, i) => {
    if (c.type === 'eq') out += chunkText(result.b, c.b);
    else if (rejected.has(i)) out += chunkText(result.a, c.a); // 元に戻す
    else out += chunkText(result.b, c.b);                      // 提案を採用
  });
  return out;
}
