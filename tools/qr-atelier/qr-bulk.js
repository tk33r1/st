/* qr-bulk.js — CSV を読んで、まとめて書き出すための部品。
 *
 * ここに置くのは「読む・名前をつける・ZIPに詰める」だけ。何をどう描くかは
 * app.js 側が決める。DOM にも state にも触らないので、単体で試せる。
 *
 * 圧縮はしない（格納のみ）。中身は PNG や JPEG で、すでに圧縮済みのものを
 * もう一度縮めても縮まらないのに、時間だけかかる。
 *
 *   QRBulk.decodeText(buffer)  → { text, encoding }
 *   QRBulk.parse(text)         → { rows, delimiter }
 *   QRBulk.safeName(s)         → ファイル名に使える文字列（残らなければ ''）
 *   QRBulk.nameTaker()         → 重複しない名前を配る関数
 *   QRBulk.zip(files)          → Blob
 *
 * 実行時に外へ出る通信はない。
 */
(function (global) {
  'use strict';

  const LF = String.fromCharCode(10);
  const CR = String.fromCharCode(13);
  const TAB = String.fromCharCode(9);
  const QUOTE = String.fromCharCode(34);

  // ------------------------------------------------------------------
  // 文字コード
  // ------------------------------------------------------------------
  // 日本語の CSV は Excel から出たものが多く、その多くが Shift_JIS。BOM が
  // あればそれに従い、無ければ「UTF-8 として厳密に読めるか」で決める。
  // UTF-8 のバイト並びは偶然そろいにくいので、通れば UTF-8、弾かれたら Shift_JIS。
  function decodeText(buffer) {
    const b = new Uint8Array(buffer);
    if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) {
      return { text: new TextDecoder('utf-8').decode(b.subarray(3)), encoding: 'UTF-8 (BOM)' };
    }
    if (b.length >= 2 && b[0] === 0xFF && b[1] === 0xFE) {
      return { text: new TextDecoder('utf-16le').decode(b.subarray(2)), encoding: 'UTF-16LE' };
    }
    if (b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF) {
      return { text: new TextDecoder('utf-16be').decode(b.subarray(2)), encoding: 'UTF-16BE' };
    }
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(b), encoding: 'UTF-8' };
    } catch (e) {
      try {
        return { text: new TextDecoder('shift_jis').decode(b), encoding: 'Shift_JIS' };
      } catch (e2) {
        // Shift_JIS を持たない環境（まずない）は、置換文字つきで通す
        return { text: new TextDecoder('utf-8').decode(b), encoding: 'UTF-8（読めない文字あり）' };
      }
    }
  }

  // ------------------------------------------------------------------
  // 区切り文字と解析
  // ------------------------------------------------------------------
  // 引用符の外にある候補だけを数える。"社名, 部署" のようなカンマ入りの
  // セルがあると、素朴に数えたほうは必ずカンマだと言い張ってしまう。
  function sniffDelimiter(text) {
    const cands = [',', TAB, ';'];
    const head = String(text).slice(0, 8000);
    const count = {};
    cands.forEach(d => { count[d] = 0; });
    let inQuote = false;
    let lines = 0;
    for (let i = 0; i < head.length; i++) {
      const ch = head.charAt(i);
      if (ch === QUOTE) { inQuote = !inQuote; continue; }
      if (inQuote) continue;
      if (ch === LF) { lines++; if (lines >= 20) break; continue; }
      if (count[ch] !== undefined) count[ch]++;
    }
    let best = ',';
    cands.forEach(d => { if (count[d] > count[best]) best = d; });
    return count[best] > 0 ? best : ',';
  }

  // RFC 4180。引用符の中の改行と、二重にした引用符を通す。
  // 末尾の空行だけ落とし、途中の空行は行として残す（行番号がずれると
  // 「何行目が落ちたか」を伝えられなくなる）。
  function parse(text, delimiter) {
    const d = delimiter || sniffDelimiter(text);
    const s = String(text);
    const n = s.length;
    const rows = [];
    let row = [];
    let field = '';
    let inQuote = false;
    let dirty = false;   // この行に何か書かれたか
    let i = 0;

    const endField = () => { row.push(field); field = ''; };
    const endRow = () => { endField(); rows.push(row); row = []; dirty = false; };

    while (i < n) {
      const ch = s.charAt(i);
      if (inQuote) {
        if (ch === QUOTE) {
          if (s.charAt(i + 1) === QUOTE) { field += QUOTE; i += 2; continue; }
          inQuote = false; i++; continue;
        }
        field += ch; i++; continue;
      }
      if (ch === QUOTE) { inQuote = true; dirty = true; i++; continue; }
      if (ch === d) { endField(); dirty = true; i++; continue; }
      if (ch === CR) { i++; if (s.charAt(i) === LF) i++; endRow(); continue; }
      if (ch === LF) { i++; endRow(); continue; }
      field += ch; dirty = true; i++;
    }
    if (dirty || field.length || row.length) endRow();

    while (rows.length && rows[rows.length - 1].every(c => c === '')) rows.pop();
    return { rows: rows, delimiter: d };
  }

  // ------------------------------------------------------------------
  // ファイル名
  // ------------------------------------------------------------------
  // Windows で作れない名前をつくらない。ZIP を開いた先で名前が化けたり、
  // 展開そのものが失敗したりすると、何百枚ぶんの書き出しが丸ごと無駄になる。
  const BAD_CHARS = [String.fromCharCode(92), '/', ':', '*', '?', QUOTE, '<', '>', '|'];
  const RESERVED = ['CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'];

  function safeName(input) {
    const s = String(input == null ? '' : input);
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code < 32 || code === 127) { out += ' '; continue; }
      const ch = s.charAt(i);
      out += BAD_CHARS.indexOf(ch) >= 0 ? '_' : ch;
    }
    // 空白は1つに畳む
    out = out.split(/\s+/).join(' ').trim();

    // 長すぎる名前は展開先のパス長に響く。切るのは末尾を整える前に行う
    // （後だと、切った拍子に末尾のドットや空白がまた顔を出す）。
    if (out.length > 60) {
      out = out.slice(0, 60);
      // サロゲートペアの片割れが残ると、ZIP の名前で置換文字に化ける
      const tail = out.charCodeAt(out.length - 1);
      if (tail >= 0xD800 && tail <= 0xDBFF) out = out.slice(0, -1);
    }

    // 末尾のドットと空白は Windows が黙って削るので、こちらで先に落として
    // 名前がぶつからないようにしておく
    while (out.length && (out.charAt(out.length - 1) === '.' || out.charAt(out.length - 1) === ' ')) {
      out = out.slice(0, -1);
    }
    if (!out) return '';
    if (RESERVED.indexOf(out.toUpperCase()) >= 0) out = '_' + out;
    return out;
  }

  // 同じ名前が来たら -2, -3 … と足す。大文字小文字だけ違う名前も、
  // Windows と macOS では同じものとして扱われるので衝突とみなす。
  function nameTaker() {
    const taken = new Set();
    return function (base, ext) {
      const stem = base || 'qr';
      let name = stem + '.' + ext;
      let k = 2;
      while (taken.has(name.toLowerCase())) { name = stem + '-' + k + '.' + ext; k++; }
      taken.add(name.toLowerCase());
      return name;
    };
  }

  // ------------------------------------------------------------------
  // ZIP（格納のみ）
  // ------------------------------------------------------------------
  let CRC_TABLE = null;
  function crcTable() {
    if (CRC_TABLE) return CRC_TABLE;
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    CRC_TABLE = t;
    return t;
  }

  function crc32(bytes) {
    const t = crcTable();
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // MS-DOS の日時。1980年起点で、秒は2秒刻み。
  function dosStamp(d) {
    const y = Math.max(1980, d.getFullYear());
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    };
  }

  const ZIP_MAX = 0xFFFFFFFF;   // ZIP64 は使わないので、ここが上限

  /* files: [{ name, bytes }] → Blob。中身はすでに圧縮済みの画像なので格納で詰める。 */
  function zip(files) {
    const enc = new TextEncoder();
    const stamp = dosStamp(new Date());
    const parts = [];
    const centrals = [];
    let offset = 0;

    files.forEach(f => {
      const name = enc.encode(f.name);
      const data = f.bytes;
      const sum = crc32(data);
      if (offset + 30 + name.length + data.length > ZIP_MAX) throw new Error('zip too large');

      const local = new Uint8Array(30 + name.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034B50, true);
      lv.setUint16(4, 20, true);        // 展開に必要なバージョン
      lv.setUint16(6, 0x0800, true);    // bit 11: 名前は UTF-8
      lv.setUint16(8, 0, true);         // 圧縮方法: 格納
      lv.setUint16(10, stamp.time, true);
      lv.setUint16(12, stamp.date, true);
      lv.setUint32(14, sum, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, name.length, true);
      lv.setUint16(28, 0, true);
      local.set(name, 30);

      const central = new Uint8Array(46 + name.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014B50, true);
      cv.setUint16(4, 20, true);        // 作成したバージョン
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, stamp.time, true);
      cv.setUint16(14, stamp.date, true);
      cv.setUint32(16, sum, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      central.set(name, 46);

      parts.push(local, data);
      centrals.push(central);
      offset += local.length + data.length;
    });

    let centralSize = 0;
    centrals.forEach(c => { centralSize += c.length; });
    if (offset + centralSize > ZIP_MAX || files.length > 0xFFFF) throw new Error('zip too large');

    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054B50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);

    return new Blob(parts.concat(centrals, [end]), { type: 'application/zip' });
  }

  global.QRBulk = {
    decodeText: decodeText,
    sniffDelimiter: sniffDelimiter,
    parse: parse,
    safeName: safeName,
    nameTaker: nameTaker,
    crc32: crc32,
    zip: zip
  };
})(window);
