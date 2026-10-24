// 読み上げ（読み上げ設計書 5.2・5.3）。統合人格の回答を読み上げ用の文と区切りにし、署名を作る・確かめる。
// 区切りは署名の後に Worker が作り直すので、同じ入力から毎回同じになるようにする（時刻・乱数を使わない）。
import { RESEARCH, SPEECH } from './personas.js';

const NOTE_LANGS = Object.keys(SPEECH.code_note);
const noteFor = (table, lang) => table[NOTE_LANGS.includes(lang) ? lang : 'en'];
// 画面が送る言語（会話の reply_language）。ISO 639-1 の2文字だけを受け、ほかは英語の注記にする
export const speechLanguage = value => typeof value === 'string' && /^[a-z]{2}$/.test(value) ? value : null;

const graphemes = text => {
  const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return Array.from(seg.segment(text), s => s.segment);
};

// 表の1行を列に分ける（先頭と末尾の | は外す）
const tableCells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
const isTableRule = line => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

// 回答の Markdown を読み上げ用の文にする（設計§5.3）。改行は文の区切りとして残す
export function speechText(markdown, lang) {
  let text = String(markdown || '').replace(/\r\n?/g, '\n');
  // Web の回答の先頭の確認日時（画面が付ける ISO の時刻）は読まない
  for (const label of Object.values(RESEARCH.checked_label)) {
    if (text.startsWith(label)) { text = text.replace(/^[^\n]*\n*/, ''); break; }
  }
  const code = noteFor(SPEECH.code_note, lang);
  text = text.replace(/```[\s\S]*?(?:```|$)/g, `\n${code}\n`).replace(/~~~[\s\S]*?(?:~~~|$)/g, `\n${code}\n`);
  const lines = text.split('\n'), out = [];
  for (let i = 0; i < lines.length; i++) {
    // 表: 見出しの行と区切りの行がそろったら、各行を「列名、値」の文にする
    if (lines[i].includes('|') && i + 1 < lines.length && isTableRule(lines[i + 1])) {
      const head = tableCells(lines[i]);
      i += 2;
      for (; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) {
        const cells = tableCells(lines[i]);
        out.push(cells.map((c, k) => head[k] && c ? `${head[k]}、${c}` : c || '').filter(Boolean).join('。') + '。');
      }
      i--;
      continue;
    }
    out.push(lines[i]);
  }
  text = out.join('\n')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '')                  // 画像は読まない
    .replace(/\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)/g, '$1')  // リンクは文字だけ
    .replace(/<?(?:https?|ftp):\/\/[^\s<>)]+>?/gi, '')         // 裸の URL は読まない
    .replace(/`([^`\n]*)`/g, '$1')                             // インラインのコードは中身を読む
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')                       // 見出し
    .replace(/^\s{0,3}>\s?/gm, '')                             // 引用
    .replace(/^\s*(?:[-*+•]|\d{1,3}[.)])\s+/gm, '')            // 箇条書き・番号
    .replace(/^\s*(?:[-*_]\s*){3,}$/gm, '')                    // 区切り線
    .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')        // 強調・取り消し線
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1$2')
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1$2')
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{FE0E}\u{FE0F}\u{20E3}\u{200D}]/gu, '')
    .replace(/[*#|<>{}\\^]/g, '');
  text = text.split('\n').map(l => l.replace(/[ \t\u{3000}]+/gu, ' ').trim()).filter(Boolean).join('\n');
  const chars = graphemes(text);
  if (chars.length <= SPEECH.max_chars) return text;
  return chars.slice(0, SPEECH.max_chars).join('').trimEnd() + '\n' + noteFor(SPEECH.cut_note, lang);
}

const SENTENCE_END = new Set(['。', '．', '！', '？', '!', '?', '\n']);
const SOFT_BREAK = new Set(['、', '，', ',', '；', ';', '：', ':', ' ']);

// 文に分ける。英語の「.」は後ろが空白か終わりのときだけ文の終わりにする（3.5 や tk.st で切らない）
function sentences(chars) {
  const list = [];
  let cur = [];
  for (let i = 0; i < chars.length; i++) {
    cur.push(chars[i]);
    const end = SENTENCE_END.has(chars[i]) || chars[i] === '.' && (i + 1 === chars.length || /\s/.test(chars[i + 1]));
    if (end) { list.push(cur); cur = []; }
  }
  if (cur.length) list.push(cur);
  return list;
}

// 長すぎる1文を、読点・空白で、それでも長ければ文字数で切る。区切るたびに上限を選び直す
function* splitLong(chars, getLimit) {
  while (chars.length > getLimit()) {
    const limit = getLimit();
    let at = -1;
    for (let k = limit; k > limit / 3; k--) if (SOFT_BREAK.has(chars[k - 1])) { at = k; break; }
    if (at < 0) at = limit;
    yield chars.slice(0, at); chars = chars.slice(at);
  }
  if (chars.length) yield chars;
}

// 読み上げの区切り（設計§5.1・5.3）。最初は短く、だんだん長く詰める。空の区切りは作らない
export function speechParts(markdown, lang) {
  const parts = [];
  let buf = [];
  const limit = () => SPEECH.part_chars[Math.min(parts.length, SPEECH.part_chars.length - 1)];
  const flush = () => { const t = buf.join('').replace(/\s+/g, ' ').trim(); if (t) parts.push(t); buf = []; };
  for (const s of sentences(graphemes(speechText(markdown, lang)))) {
    if (!s.join('').trim()) continue;
    if (buf.length && buf.length + s.length > limit()) flush();
    if (s.length > limit()) {
      for (const piece of splitLong(s, limit)) { buf = piece; flush(); }
      continue;
    }
    buf.push(...s);
  }
  flush();
  if (parts.length > SPEECH.max_parts) {
    parts.length = SPEECH.max_parts;
    parts[parts.length - 1] += ' ' + noteFor(SPEECH.cut_note, lang);
  }
  return parts;
}

const hex = buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
const hmacKey = (secret, usage) => crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);

// 署名（設計§5.2）: HMAC-SHA256(SPEECH_SIGN_KEY, "v1\n" + 回答の本文) の16進
export async function speechSign(secret, text) {
  return hex(await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), new TextEncoder().encode('v1\n' + text)));
}
// 照合は subtle.verify に任せる（比較の時間で一致した長さを漏らさない）
export async function speechVerify(secret, text, sig) {
  if (typeof sig !== 'string' || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const bytes = new Uint8Array(sig.match(/../g).map(h => parseInt(h, 16)));
  return crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), bytes, new TextEncoder().encode('v1\n' + text));
}
