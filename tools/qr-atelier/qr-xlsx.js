/* qr-xlsx.js — Excel ブック（.xlsx）の読み書き。
 *
 * CSV には「選べる値」を持たせる場所がない。暗号化方式に "オープン" と
 * 書かれても、ファイルの側は何も言えず、読む側が推測するしかなかった。
 * xlsx なら列にドロップダウンを埋められるので、打ち間違いが起きる前に
 * 止められる。Excel でも Google スプレッドシートでも同じように効く。
 *
 *   QRXlsx.canRead()            → この環境で読めるか（DecompressionStream の有無）
 *   QRXlsx.build(opts)          → Blob（ダウンロード用のひな形）
 *   QRXlsx.read(arrayBuffer)    → Promise<{ rows, sheet }>
 *
 * 書き出しは無圧縮で詰める（QRBulk.zip と同じ考え方で、そのまま流用する）。
 * 読み込みだけは相手が圧縮してくるので、DecompressionStream で展開する。
 * 実行時に外へ出る通信はない。
 */
(function (global) {
  'use strict';

  const LF = String.fromCharCode(10);
  const AMP = String.fromCharCode(38);
  const LT = String.fromCharCode(60);
  const GT = String.fromCharCode(62);
  const QUOT = String.fromCharCode(34);

  const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const NS_CT = 'http://schemas.openxmlformats.org/package/2006/content-types';

  // ------------------------------------------------------------------
  // 共通
  // ------------------------------------------------------------------
  function esc(v) {
    let out = '';
    const s = String(v == null ? '' : v);
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      // XML 1.0 が持てない制御文字は落とす。残すとブックごと開けなくなる
      if (code < 32 && code !== 9 && code !== 10 && code !== 13) continue;
      const ch = s.charAt(i);
      if (ch === AMP) out += AMP + 'amp;';
      else if (ch === LT) out += AMP + 'lt;';
      else if (ch === GT) out += AMP + 'gt;';
      else if (ch === QUOT) out += AMP + 'quot;';
      else out += ch;
    }
    return out;
  }

  // 0 → A, 25 → Z, 26 → AA
  function colName(n) {
    let s = '';
    let i = n;
    do {
      s = String.fromCharCode(65 + (i % 26)) + s;
      i = Math.floor(i / 26) - 1;
    } while (i >= 0);
    return s;
  }

  function colIndex(ref) {
    let n = 0;
    for (let i = 0; i < ref.length; i++) {
      const c = ref.charCodeAt(i);
      if (c < 65 || c > 90) break;
      n = n * 26 + (c - 64);
    }
    return n - 1;
  }

  const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + LF;

  function bytes(text) { return new TextEncoder().encode(text); }

  // 日付として通す範囲（Excel の連番）。2000-01-01 〜 2099-12-31
  const DATE_MIN = 36526;
  const DATE_MAX = 73050;

  // ------------------------------------------------------------------
  // 書き出し
  // ------------------------------------------------------------------
  // opts: {
  //   sheets: [{
  //     name,                 シート名（31文字まで）
  //     grid: [[string]],     そのまま置く格子
  //     headerRow: bool,      1行目を見出しとして太字＋固定する
  //     boldRows: [番号],     太字にする行（0起点）
  //     lists: [{ col, values }],  その列をドロップダウンにする
  //     dates: [col],         その列を日付の列にする（書式＋入力規則）
  //     hidden: bool
  //   }],
  //   maxRows: ドロップダウンを効かせる行数（既定 1000）
  // }
  function build(opts) {
    const o = opts || {};
    const sheets = (o.sheets || []).filter(Boolean);
    const maxRows = o.maxRows || 1000;
    const listSheet = '選択肢';

    // 選択肢はブック全体で1枚の隠しシートに集める。シートごとに持たせると
    // 枚数が倍に増えて、開いた人が何を見ればよいのか分からなくなる。
    const listCols = [];
    sheets.forEach(sh => {
      (sh.lists || []).forEach(l => {
        l._at = listCols.length;
        listCols.push(l.values || []);
      });
    });

    function cell(ref, value, style) {
      if (value == null || value === '') return '';
      return '<c r="' + ref + '"' + (style ? ' s="' + style + '"' : '') +
        ' t="inlineStr"><is><t xml:space="preserve">' + esc(value) + '</t></is></c>';
    }

    function sheetXml(sh) {
      const grid = sh.grid || [];
      const bold = {};
      (sh.boldRows || []).forEach(n => { bold[n] = true; });
      if (sh.headerRow) bold[0] = true;

      const body = grid.map((row, n) => {
        const cells = (row || []).map((v, i) =>
          // すべて文字列として置く。日付を数値で持たれると、読み戻したときに
          // 45931.5416… のような連番になり、開始日時が壊れる。
          cell(colName(i) + (n + 1), v, bold[n] ? '1' : '2')).join('');
        return cells ? '<row r="' + (n + 1) + '">' + cells + '</row>' : '';
      }).join('');

      const dv = (sh.lists || []).map(l => {
        const col = colName(l.col);
        const at = colName(l._at);
        const range = "'" + listSheet + "'!$" + at + '$1:$' + at + '$' + (l.values || []).length;
        return '<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1"' +
          ' errorTitle="' + esc('選べない値です') + '"' +
          ' error="' + esc('この列は一覧から選んでください。') + '"' +
          ' sqref="' + col + '2:' + col + maxRows + '">' +
          '<formula1>' + esc(range) + '</formula1></dataValidation>';
      });

      // 日付の列。Excel には素のセルにカレンダーを出す仕組みが無いので、
      // ここでできるのは「日付として妥当か」を見ることまで。
      // Google スプレッドシートはこの入力規則をカレンダー選択として扱うので、
      // 向こうで開けばダブルクリックで日付を選べる。
      (sh.dates || []).forEach(col => {
        const c = colName(col);
        dv.push('<dataValidation type="date" operator="between" allowBlank="1"' +
          ' showInputMessage="1" showErrorMessage="1"' +
          ' promptTitle="' + esc('日付と時刻') + '"' +
          ' prompt="' + esc('2026/11/05 10:30 のように入れてください。') + '"' +
          ' errorTitle="' + esc('日付として読めません') + '"' +
          ' error="' + esc('2026/11/05 10:30 のように入れてください。') + '"' +
          ' sqref="' + c + '2:' + c + maxRows + '">' +
          '<formula1>' + DATE_MIN + '</formula1>' +
          '<formula2>' + DATE_MAX + '</formula2></dataValidation>');
      });

      let width = 0;
      grid.forEach(r => { width = Math.max(width, (r || []).length); });
      const isDate = {};
      (sh.dates || []).forEach(c => { isDate[c] = true; });
      const cols = [];
      for (let i = 0; i < width; i++) {
        let len = 12;
        grid.forEach(r => {
          const v = r && r[i];
          if (v != null) len = Math.max(len, String(v).length);
        });
        // 日付の列は列ごと日付書式にする。文字列のままだと、カレンダーから
        // 選んだ値が「45966.4375」のような数字に見えてしまう。
        const style = isDate[i] ? '3' : '2';
        cols.push('<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' +
          Math.min(48, len * 1.6 + 4).toFixed(1) + '" customWidth="1" style="' + style + '"/>');
      }

      return XML_HEAD +
        '<worksheet xmlns="' + NS_MAIN + '">' +
        (sh.headerRow
          ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2"' +
            ' activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
          : '') +
        (cols.length ? '<cols>' + cols.join('') + '</cols>' : '') +
        '<sheetData>' + body + '</sheetData>' +
        (dv.length ? '<dataValidations count="' + dv.length + '">' + dv.join('') +
          '</dataValidations>' : '') +
        '</worksheet>';
    }

    const all = sheets.slice();
    if (listCols.length) {
      let tallest = 0;
      listCols.forEach(c => { tallest = Math.max(tallest, c.length); });
      const grid = [];
      for (let r = 0; r < tallest; r++) {
        grid.push(listCols.map(c => c[r]));
      }
      all.push({ name: listSheet, grid: grid, hidden: true });
    }

    const parts = [];
    const sheetTags = [];
    const rels = [];
    const overrides = [];
    all.forEach((sh, n) => {
      const file = 'sheet' + (n + 1) + '.xml';
      parts.push({ name: 'xl/worksheets/' + file, bytes: bytes(sheetXml(sh)) });
      sheetTags.push('<sheet name="' + esc(String(sh.name || ('シート' + (n + 1))).slice(0, 31)) +
        '" sheetId="' + (n + 1) + '"' + (sh.hidden ? ' state="hidden"' : '') +
        ' r:id="rId' + (n + 1) + '"/>');
      rels.push('<Relationship Id="rId' + (n + 1) + '" Type="' + NS_REL +
        '/worksheet" Target="worksheets/' + file + '"/>');
      overrides.push('<Override PartName="/xl/worksheets/' + file +
        '" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>');
    });

    const workbook = XML_HEAD +
      '<workbook xmlns="' + NS_MAIN + '" xmlns:r="' + NS_REL + '">' +
      '<sheets>' + sheetTags.join('') + '</sheets></workbook>';

    const wbRels = XML_HEAD +
      '<Relationships xmlns="' + NS_PKG_REL + '">' + rels.join('') +
      '<Relationship Id="rIdStyles" Type="' + NS_REL + '/styles" Target="styles.xml"/>' +
      '</Relationships>';

    const rootRels = XML_HEAD +
      '<Relationships xmlns="' + NS_PKG_REL + '">' +
      '<Relationship Id="rId1" Type="' + NS_REL + '/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>';

    // Excel は fills の 0 番が none、1 番が gray125 でないと開けないと言ってくる。
    // cellStyles が無いと「既定のスタイルが無い」と言って修復を促してくる。
    const styles = XML_HEAD +
      '<styleSheet xmlns="' + NS_MAIN + '">' +
      '<numFmts count="2"><numFmt numFmtId="164" formatCode="@"/>' +
      '<numFmt numFmtId="165" formatCode="yyyy/mm/dd\\ hh:mm"/></numFmts>' +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>' +
      '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="4">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>' +
      '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '</cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>';

    const contentTypes = XML_HEAD +
      '<Types xmlns="' + NS_CT + '">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      overrides.join('') +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '</Types>';

    const files = [
      { name: '[Content_Types].xml', bytes: bytes(contentTypes) },
      { name: '_rels/.rels', bytes: bytes(rootRels) },
      { name: 'xl/workbook.xml', bytes: bytes(workbook) },
      { name: 'xl/_rels/workbook.xml.rels', bytes: bytes(wbRels) },
      { name: 'xl/styles.xml', bytes: bytes(styles) }
    ].concat(parts);

    const zip = global.QRBulk.zip(files);
    return new Blob([zip], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
  }

  // ------------------------------------------------------------------
  // 読み込み
  // ------------------------------------------------------------------
  function canRead() { return typeof global.DecompressionStream === 'function'; }

  async function inflateRaw(data) {
    const ds = new global.DecompressionStream('deflate-raw');
    const stream = new Blob([data]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // 中央ディレクトリから引く。ローカルヘッダだけを頭からなめると、
  // データ記述子つきの項目（大きさが後ろに書いてある）で長さが読めない。
  async function unzip(buffer) {
    const u = new Uint8Array(buffer);
    const view = new DataView(u.buffer, u.byteOffset, u.byteLength);
    let eocd = -1;
    const floor = Math.max(0, u.length - 66000);
    for (let i = u.length - 22; i >= floor; i--) {
      if (view.getUint32(i, true) === 0x06054B50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a zip');

    const count = view.getUint16(eocd + 10, true);
    let p = view.getUint32(eocd + 16, true);
    const out = {};
    const dec = new TextDecoder('utf-8');
    for (let n = 0; n < count; n++) {
      if (view.getUint32(p, true) !== 0x02014B50) break;
      const method = view.getUint16(p + 10, true);
      const size = view.getUint32(p + 20, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const cmtLen = view.getUint16(p + 32, true);
      const local = view.getUint32(p + 42, true);
      const name = dec.decode(u.subarray(p + 46, p + 46 + nameLen));

      // データの位置はローカルヘッダ側の長さで決まる（中央側とは別物）
      const lNameLen = view.getUint16(local + 26, true);
      const lExtraLen = view.getUint16(local + 28, true);
      const start = local + 30 + lNameLen + lExtraLen;
      const raw = u.subarray(start, start + size);
      out[name] = method === 0 ? raw : await inflateRaw(raw);

      p += 46 + nameLen + extraLen + cmtLen;
    }
    return out;
  }

  function parseXml(u8) {
    if (!u8) return null;
    const text = new TextDecoder('utf-8').decode(u8);
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    return doc.querySelector('parsererror') ? null : doc;
  }

  function tagsIn(node, name) {
    return Array.prototype.slice.call(node.getElementsByTagNameNS(NS_MAIN, name));
  }

  // 日付が入っている書式かどうか。数値のまま返すと 45931.5416… になる。
  const DATE_BUILTIN = [14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58];

  function dateStyles(stylesDoc) {
    const out = {};
    if (!stylesDoc) return out;
    const custom = {};
    tagsIn(stylesDoc, 'numFmt').forEach(f => {
      const id = Number(f.getAttribute('numFmtId'));
      const code = String(f.getAttribute('formatCode') || '');
      // 記号を除いて y / m / d / h が残れば日付か時刻の書式
      const bare = code.replace(/\[[^\]]*\]/g, '').replace(/"[^"]*"/g, '');
      custom[id] = /[ymdh]/i.test(bare);
    });
    const xfs = stylesDoc.getElementsByTagNameNS(NS_MAIN, 'cellXfs')[0];
    if (!xfs) return out;
    tagsIn(xfs, 'xf').forEach((xf, i) => {
      const id = Number(xf.getAttribute('numFmtId') || 0);
      out[i] = custom[id] === true || DATE_BUILTIN.indexOf(id) >= 0;
    });
    return out;
  }

  // Excel の連番 → "YYYY-MM-DDTHH:MM"（画面の日時入力と同じ書き方）
  function serialToText(n) {
    const ms = Math.round((n - 25569) * 86400000);
    const d = new Date(ms);
    if (isNaN(d.getTime())) return String(n);
    const p = v => String(v).padStart(2, '0');
    const date = d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
    const frac = n - Math.floor(n);
    if (frac < 1 / 86400) return date;
    return date + 'T' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
  }

  function sharedStrings(doc) {
    if (!doc) return [];
    return tagsIn(doc, 'si').map(si => tagsIn(si, 't').map(t => t.textContent).join(''));
  }

  // ブックに入っているシートを、並び順のまま列挙する。どれを読むかは
  // 呼ぶ側が決める（1つのブックに種類ぶんのシートが入ることがある）。
  function sheetList(wb, rels) {
    if (!wb || !rels) {
      return [{ name: '', hidden: false, path: 'xl/worksheets/sheet1.xml' }];
    }
    const relList = Array.prototype.slice.call(rels.getElementsByTagName('Relationship'));
    return tagsIn(wb, 'sheet').map((sh, n) => {
      const rid = sh.getAttributeNS(NS_REL, 'id') || sh.getAttribute('r:id');
      const rel = relList.find(r => r.getAttribute('Id') === rid);
      let path = 'xl/worksheets/sheet' + (n + 1) + '.xml';
      if (rel) {
        const target = String(rel.getAttribute('Target') || '').replace(/^\//, '');
        path = target.indexOf('xl/') === 0 ? target : 'xl/' + target;
      }
      return {
        name: sh.getAttribute('name') || '',
        hidden: (sh.getAttribute('state') || 'visible') !== 'visible',
        path: path
      };
    });
  }

  function sheetRows(doc, strings, dates) {
    const rows = [];
    let width = 0;
    tagsIn(doc, 'row').forEach(row => {
      const cells = [];
      tagsIn(row, 'c').forEach(c => {
        const ref = c.getAttribute('r') || '';
        const at = ref ? colIndex(ref) : cells.length;
        const type = c.getAttribute('t') || 'n';
        let text = '';
        if (type === 'inlineStr') {
          text = tagsIn(c, 't').map(t => t.textContent).join('');
        } else if (type === 's') {
          const v = tagsIn(c, 'v')[0];
          text = v ? (strings[Number(v.textContent)] || '') : '';
        } else {
          const v = tagsIn(c, 'v')[0];
          text = v ? v.textContent : '';
          // 日付は連番で入っている。書式を見てから文字に戻す
          if (type === 'n' && text !== '' && dates[Number(c.getAttribute('s') || 0)]) {
            const num = Number(text);
            if (isFinite(num)) text = serialToText(num);
          }
        }
        while (cells.length < at) cells.push('');
        cells[at] = text;
      });
      const r = Number(row.getAttribute('r') || (rows.length + 1));
      while (rows.length < r - 1) rows.push([]);
      rows[r - 1] = cells;
      width = Math.max(width, cells.length);
    });
    // 末尾の空行は落とす。行番号がずれないよう、途中の空行は残す
    while (rows.length && !rows[rows.length - 1].some(v => String(v || '').trim())) rows.pop();
    rows.forEach(r => { while (r.length < width) r.push(''); });
    return rows;
  }

  async function read(buffer) {
    if (!canRead()) throw new Error('no inflate');
    const zip = await unzip(buffer);
    if (!zip['xl/workbook.xml']) throw new Error('not xlsx');

    const wb = parseXml(zip['xl/workbook.xml']);
    const rels = parseXml(zip['xl/_rels/workbook.xml.rels']);
    const strings = sharedStrings(parseXml(zip['xl/sharedStrings.xml']));
    const dates = dateStyles(parseXml(zip['xl/styles.xml']));

    const sheets = [];
    sheetList(wb, rels).forEach(sh => {
      const doc = parseXml(zip[sh.path]);
      if (!doc) return;
      sheets.push({ name: sh.name, hidden: sh.hidden, rows: sheetRows(doc, strings, dates) });
    });
    if (!sheets.length) throw new Error('no sheet');
    return { sheets: sheets };
  }

  global.QRXlsx = {
    canRead: canRead,
    build: build,
    read: read,
    colName: colName
  };
})(window);
