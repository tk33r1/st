/* QR Atelier — QRコードのエンコーダ（JIS X 0510 / ISO/IEC 18004）
 *
 * 「モデル2のQRコードを組み立てて、明暗のマス目を返す」ところまでが担当。
 * 見た目（セル形状・色・ロゴ）は qr-style.js が受け持つので、ここでは
 * 一切描画しない。返す modules / func をもとに好きに描けばよい。
 *
 * 外部ライブラリなし。ブラウザ内で完結する。
 *
 *   const qr = QRCore.encode('https://tk.st/', { ec: 'H' });
 *   qr.size            → 一辺のモジュール数
 *   qr.at(x, y)        → true なら暗モジュール
 *   qr.isFunction(x,y) → true なら機能パターン（位置検出・位置合わせ・タイミング等）
 */
(function (global) {
  'use strict';

  // ------------------------------------------------------------------
  // 表（規格そのままの値。導出できないのでベタ書き）
  // ------------------------------------------------------------------

  // RSブロック構成。バージョン1→40の順、各行は L / M / Q / H を空白区切りで、
  // 「ブロック数, 総コード語数, データコード語数」の3つ組。グループが2つある
  // 版は3つ組を続けて2組書く。
  const RS_BLOCKS = [
    '1,26,19 1,26,16 1,26,13 1,26,9',
    '1,44,34 1,44,28 1,44,22 1,44,16',
    '1,70,55 1,70,44 2,35,17 2,35,13',
    '1,100,80 2,50,32 2,50,24 4,25,9',
    '1,134,108 2,67,43 2,33,15,2,34,16 2,33,11,2,34,12',
    '2,86,68 4,43,27 4,43,19 4,43,15',
    '2,98,78 4,49,31 2,32,14,4,33,15 4,39,13,1,40,14',
    '2,121,97 2,60,38,2,61,39 4,40,18,2,41,19 4,40,14,2,41,15',
    '2,146,116 3,58,36,2,59,37 4,36,16,4,37,17 4,36,12,4,37,13',
    '2,86,68,2,87,69 4,69,43,1,70,44 6,43,19,2,44,20 6,43,15,2,44,16',
    '4,101,81 1,80,50,4,81,51 4,50,22,4,51,23 3,36,12,8,37,13',
    '2,116,92,2,117,93 6,58,36,2,59,37 4,46,20,6,47,21 7,42,14,4,43,15',
    '4,133,107 8,59,37,1,60,38 8,44,20,4,45,21 12,33,11,4,34,12',
    '3,145,115,1,146,116 4,64,40,5,65,41 11,36,16,5,37,17 11,36,12,5,37,13',
    '5,109,87,1,110,88 5,65,41,5,66,42 5,54,24,7,55,25 11,36,12,7,37,13',
    '5,122,98,1,123,99 7,73,45,3,74,46 15,43,19,2,44,20 3,45,15,13,46,16',
    '1,135,107,5,136,108 10,74,46,1,75,47 1,50,22,15,51,23 2,42,14,17,43,15',
    '5,150,120,1,151,121 9,69,43,4,70,44 17,50,22,1,51,23 2,42,14,19,43,15',
    '3,141,113,4,142,114 3,70,44,11,71,45 17,47,21,4,48,22 9,39,13,16,40,14',
    '3,135,107,5,136,108 3,67,41,13,68,42 15,54,24,5,55,25 15,43,15,10,44,16',
    '4,144,116,4,145,117 17,68,42 17,50,22,6,51,23 19,46,16,6,47,17',
    '2,139,111,7,140,112 17,74,46 7,54,24,16,55,25 34,37,13',
    '4,151,121,5,152,122 4,75,47,14,76,48 11,54,24,14,55,25 16,45,15,14,46,16',
    '6,147,117,4,148,118 6,73,45,14,74,46 11,54,24,16,55,25 30,46,16,2,47,17',
    '8,132,106,4,133,107 8,75,47,13,76,48 7,54,24,22,55,25 22,45,15,13,46,16',
    '10,142,114,2,143,115 19,74,46,4,75,47 28,50,22,6,51,23 33,46,16,4,47,17',
    '8,152,122,4,153,123 22,73,45,3,74,46 8,53,23,26,54,24 12,45,15,28,46,16',
    '3,147,117,10,148,118 3,73,45,23,74,46 4,54,24,31,55,25 11,45,15,31,46,16',
    '7,146,116,7,147,117 21,73,45,7,74,46 1,53,23,37,54,24 19,45,15,26,46,16',
    '5,145,115,10,146,116 19,75,47,10,76,48 15,54,24,25,55,25 23,45,15,25,46,16',
    '13,145,115,3,146,116 2,74,46,29,75,47 42,54,24,1,55,25 23,45,15,28,46,16',
    '17,145,115 10,74,46,23,75,47 10,54,24,35,55,25 19,45,15,35,46,16',
    '17,145,115,1,146,116 14,74,46,21,75,47 29,54,24,19,55,25 11,45,15,46,46,16',
    '13,145,115,6,146,116 14,74,46,23,75,47 44,54,24,7,55,25 59,46,16,1,47,17',
    '12,151,121,7,152,122 12,75,47,26,76,48 39,54,24,14,55,25 22,45,15,41,46,16',
    '6,151,121,14,152,122 6,75,47,34,76,48 46,54,24,10,55,25 2,45,15,64,46,16',
    '17,152,122,4,153,123 29,74,46,14,75,47 49,54,24,10,55,25 24,45,15,46,46,16',
    '4,152,122,18,153,123 13,74,46,32,75,47 48,54,24,14,55,25 42,45,15,32,46,16',
    '20,147,117,4,148,118 40,75,47,7,76,48 43,54,24,22,55,25 10,45,15,67,46,16',
    '19,148,118,6,149,119 18,75,47,31,76,48 34,54,24,34,55,25 20,45,15,61,46,16'
  ];

  // 位置合わせパターンの中心座標（行と列の組み合わせすべてに置く。
  // ただし位置検出パターンと重なる3隅は除く）。
  const ALIGN_POS = [
    '', '6,18', '6,22', '6,26', '6,30', '6,34', '6,22,38', '6,24,42', '6,26,46',
    '6,28,50', '6,30,54', '6,32,58', '6,34,62', '6,26,46,66', '6,26,48,70',
    '6,26,50,74', '6,30,54,78', '6,30,56,82', '6,30,58,86', '6,34,62,90',
    '6,28,50,72,94', '6,26,50,74,98', '6,30,54,78,102', '6,28,54,80,106',
    '6,32,58,84,110', '6,30,58,86,114', '6,34,62,90,118', '6,26,50,74,98,122',
    '6,30,54,78,102,126', '6,26,52,78,104,130', '6,30,56,82,108,134',
    '6,34,60,86,112,138', '6,30,58,86,114,142', '6,34,62,90,118,146',
    '6,30,54,78,102,126,150', '6,24,50,76,102,128,154', '6,28,54,80,106,132,158',
    '6,32,58,84,110,136,162', '6,26,54,82,110,138,166', '6,30,58,86,114,142,170'
  ];

  // 誤り訂正レベル → 形式情報の2ビット（L=01, M=00, Q=11, H=10）と表の列。
  const EC = {
    L: { index: 0, formatBits: 1, ratio: 0.07 },
    M: { index: 1, formatBits: 0, ratio: 0.15 },
    Q: { index: 2, formatBits: 3, ratio: 0.25 },
    H: { index: 3, formatBits: 2, ratio: 0.30 }
  };

  const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

  // ------------------------------------------------------------------
  // GF(256) — 原始多項式 x^8+x^4+x^3+x^2+1 (0x11D)
  // ------------------------------------------------------------------
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11D;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  // 次数 degree の生成多項式（最高次の係数1は省いて保持する）
  function rsDivisor(degree) {
    const result = new Uint8Array(degree);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < degree; j++) {
        result[j] = gfMul(result[j], root);
        if (j + 1 < degree) result[j] ^= result[j + 1];
      }
      root = gfMul(root, 0x02);
    }
    return result;
  }

  function rsRemainder(data, divisor) {
    const result = new Uint8Array(divisor.length);
    for (let k = 0; k < data.length; k++) {
      const factor = data[k] ^ result[0];
      result.copyWithin(0, 1);
      result[result.length - 1] = 0;
      for (let i = 0; i < result.length; i++) result[i] ^= gfMul(divisor[i], factor);
    }
    return result;
  }

  // ------------------------------------------------------------------
  // ビットバッファ
  // ------------------------------------------------------------------
  function BitBuffer() {
    this.bits = [];
  }
  BitBuffer.prototype.put = function (value, length) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  };

  // ------------------------------------------------------------------
  // モード判定とデータ長
  // ------------------------------------------------------------------
  function detectMode(text) {
    if (/^[0-9]*$/.test(text)) return 'numeric';
    for (let i = 0; i < text.length; i++) {
      if (ALNUM.indexOf(text.charAt(i)) < 0) return 'byte';
    }
    return 'alnum';
  }

  const MODE_INDICATOR = { numeric: 1, alnum: 2, byte: 4 };
  const COUNT_BITS = {
    numeric: [10, 12, 14],
    alnum: [9, 11, 13],
    byte: [8, 16, 16]
  };

  function countBits(mode, version) {
    const group = version <= 9 ? 0 : version <= 26 ? 1 : 2;
    return COUNT_BITS[mode][group];
  }

  function toBytes(text) {
    return new TextEncoder().encode(text);
  }

  // データ本体のビット数（モード指示子と文字数指示子を含まない）
  function payloadBits(mode, text, bytes) {
    if (mode === 'numeric') {
      const n = text.length;
      return 10 * Math.floor(n / 3) + (n % 3 === 1 ? 4 : n % 3 === 2 ? 7 : 0);
    }
    if (mode === 'alnum') {
      const n = text.length;
      return 11 * Math.floor(n / 2) + (n % 2 ? 6 : 0);
    }
    return bytes.length * 8;
  }

  function writePayload(bb, mode, text, bytes) {
    if (mode === 'numeric') {
      for (let i = 0; i < text.length; i += 3) {
        const chunk = text.substr(i, 3);
        bb.put(parseInt(chunk, 10), chunk.length * 3 + 1);
      }
      return;
    }
    if (mode === 'alnum') {
      for (let i = 0; i < text.length; i += 2) {
        if (i + 1 < text.length) {
          bb.put(ALNUM.indexOf(text.charAt(i)) * 45 + ALNUM.indexOf(text.charAt(i + 1)), 11);
        } else {
          bb.put(ALNUM.indexOf(text.charAt(i)), 6);
        }
      }
      return;
    }
    for (let i = 0; i < bytes.length; i++) bb.put(bytes[i], 8);
  }

  // ------------------------------------------------------------------
  // バージョンごとのブロック構成
  // ------------------------------------------------------------------
  function blocksOf(version, ec) {
    const row = RS_BLOCKS[version - 1].split(' ')[EC[ec].index].split(',').map(Number);
    const groups = [];
    for (let i = 0; i < row.length; i += 3) {
      groups.push({ count: row[i], total: row[i + 1], data: row[i + 2] });
    }
    return groups;
  }

  function dataCapacityBits(version, ec) {
    return blocksOf(version, ec).reduce((sum, g) => sum + g.count * g.data, 0) * 8;
  }

  // ------------------------------------------------------------------
  // コード語の生成（誤り訂正・インターリーブまで）
  // ------------------------------------------------------------------
  function buildCodewords(version, ec, mode, text, bytes) {
    const capacity = dataCapacityBits(version, ec);
    const bb = new BitBuffer();
    bb.put(MODE_INDICATOR[mode], 4);
    bb.put(mode === 'byte' ? bytes.length : text.length, countBits(mode, version));
    writePayload(bb, mode, text, bytes);

    // 終端パターン（最大4ビット）→ バイト境界まで0埋め → 埋め草を交互に
    bb.put(0, Math.min(4, capacity - bb.bits.length));
    bb.put(0, (8 - (bb.bits.length % 8)) % 8);
    for (let pad = 0xEC; bb.bits.length < capacity; pad ^= 0xEC ^ 0x11) bb.put(pad, 8);

    const dataBytes = new Uint8Array(bb.bits.length / 8);
    for (let i = 0; i < bb.bits.length; i++) {
      dataBytes[i >>> 3] |= bb.bits[i] << (7 - (i & 7));
    }

    // ブロックに分けて、それぞれに誤り訂正コード語を付ける
    const groups = blocksOf(version, ec);
    const ecLen = groups[0].total - groups[0].data;
    const divisor = rsDivisor(ecLen);
    const dataBlocks = [];
    const ecBlocks = [];
    let offset = 0;
    groups.forEach(g => {
      for (let i = 0; i < g.count; i++) {
        const block = dataBytes.subarray(offset, offset + g.data);
        offset += g.data;
        dataBlocks.push(block);
        ecBlocks.push(rsRemainder(block, divisor));
      }
    });

    // インターリーブ：各ブロックの先頭から1バイトずつ拾っていく
    const totalCodewords = groups.reduce((sum, g) => sum + g.count * g.total, 0);
    const result = new Uint8Array(totalCodewords);
    let p = 0;
    const maxData = Math.max.apply(null, dataBlocks.map(b => b.length));
    for (let i = 0; i < maxData; i++) {
      for (let b = 0; b < dataBlocks.length; b++) {
        if (i < dataBlocks[b].length) result[p++] = dataBlocks[b][i];
      }
    }
    for (let i = 0; i < ecLen; i++) {
      for (let b = 0; b < ecBlocks.length; b++) result[p++] = ecBlocks[b][i];
    }
    return result;
  }

  // ------------------------------------------------------------------
  // マトリクス（モジュール配置）
  // ------------------------------------------------------------------
  function Matrix(version) {
    this.version = version;
    this.size = version * 4 + 17;
    this.modules = new Uint8Array(this.size * this.size);
    this.func = new Uint8Array(this.size * this.size);
  }
  Matrix.prototype.set = function (x, y, dark) {
    this.modules[y * this.size + x] = dark ? 1 : 0;
  };
  Matrix.prototype.get = function (x, y) {
    return this.modules[y * this.size + x] === 1;
  };
  Matrix.prototype.setFn = function (x, y, dark) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    this.set(x, y, dark);
    this.func[y * this.size + x] = 1;
  };
  Matrix.prototype.isFn = function (x, y) {
    return this.func[y * this.size + x] === 1;
  };

  function drawFunctionPatterns(m, ec) {
    const size = m.size;

    // タイミングパターン
    for (let i = 0; i < size; i++) {
      m.setFn(6, i, i % 2 === 0);
      m.setFn(i, 6, i % 2 === 0);
    }

    // 位置検出パターン（分離パターン込みで9x9を確保する）
    [[3, 3], [size - 4, 3], [3, size - 4]].forEach(c => {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          m.setFn(c[0] + dx, c[1] + dy, d !== 2 && d !== 4);
        }
      }
    });

    // 位置合わせパターン
    const pos = ALIGN_POS[m.version - 1];
    const list = pos ? pos.split(',').map(Number) : [];
    for (let i = 0; i < list.length; i++) {
      for (let j = 0; j < list.length; j++) {
        // 3隅は位置検出パターンと重なるので置かない
        if ((i === 0 && j === 0) || (i === 0 && j === list.length - 1) ||
            (i === list.length - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            m.setFn(list[j] + dx, list[i] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
        }
      }
    }

    // 形式情報の領域を先に機能モジュールとして押さえておく（値は後で上書き）
    drawFormatBits(m, ec, 0);
    drawVersionBits(m);
  }

  function drawFormatBits(m, ec, mask) {
    const size = m.size;
    const data = (EC[ec].formatBits << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = i => ((bits >>> i) & 1) === 1;

    for (let i = 0; i <= 5; i++) m.setFn(8, i, bit(i));
    m.setFn(8, 7, bit(6));
    m.setFn(8, 8, bit(7));
    m.setFn(7, 8, bit(8));
    for (let i = 9; i < 15; i++) m.setFn(14 - i, 8, bit(i));

    for (let i = 0; i < 8; i++) m.setFn(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) m.setFn(8, size - 15 + i, bit(i));
    m.setFn(8, size - 8, true); // 常に暗いモジュール
  }

  function drawVersionBits(m) {
    if (m.version < 7) return;
    let rem = m.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    const bits = (m.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = m.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      m.setFn(a, b, dark);
      m.setFn(b, a, dark);
    }
  }

  function drawCodewords(m, codewords) {
    const size = m.size;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // 縦のタイミングパターン列はまたぐ
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!m.isFn(x, y) && i < codewords.length * 8) {
            m.set(x, y, ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1);
            i++;
          }
        }
      }
    }
  }

  const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
  ];

  function applyMask(m, mask) {
    const fn = MASKS[mask];
    for (let y = 0; y < m.size; y++) {
      for (let x = 0; x < m.size; x++) {
        if (!m.isFn(x, y) && fn(x, y)) {
          m.modules[y * m.size + x] ^= 1;
        }
      }
    }
  }

  // 規格の4つの減点則。小さいほど読み取りやすい配置とみなす。
  function penalty(m) {
    const size = m.size;
    let score = 0;

    // 規則1：同色が5個以上続く並び／規則3：1:1:3:1:1 の紛らわしい並び
    const line = new Array(size);
    for (let dir = 0; dir < 2; dir++) {
      for (let i = 0; i < size; i++) {
        for (let j = 0; j < size; j++) line[j] = dir === 0 ? m.get(j, i) : m.get(i, j);

        let runLen = 1;
        for (let j = 1; j < size; j++) {
          if (line[j] === line[j - 1]) {
            runLen++;
            if (runLen === 5) score += 3;
            else if (runLen > 5) score += 1;
          } else {
            runLen = 1;
          }
        }

        for (let j = 0; j + 10 < size; j++) {
          if (matchFinderLike(line, j, false) || matchFinderLike(line, j, true)) score += 40;
        }
      }
    }

    // 規則2：2x2の同色ブロック
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = m.get(x, y);
        if (c === m.get(x + 1, y) && c === m.get(x, y + 1) && c === m.get(x + 1, y + 1)) {
          score += 3;
        }
      }
    }

    // 規則4：暗モジュールの比率が50%から離れているほど減点
    let dark = 0;
    for (let i = 0; i < m.modules.length; i++) dark += m.modules[i];
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    score += Math.max(0, k) * 10;
    return score;
  }

  // 位置検出パターンと紛らわしい11モジュールの並び。
  // 暗明暗暗暗明暗 のあとに明が4つ（reversed=true なら前に4つ）。
  const FINDER_LIKE = [true, false, true, true, true, false, true];
  function matchFinderLike(line, at, reversed) {
    for (let i = 0; i < 7; i++) {
      if (line[at + (reversed ? 4 + i : i)] !== FINDER_LIKE[i]) return false;
    }
    for (let i = 0; i < 4; i++) {
      if (line[at + (reversed ? i : 7 + i)] !== false) return false;
    }
    return true;
  }

  // ------------------------------------------------------------------
  // 公開API
  // ------------------------------------------------------------------
  function encode(text, options) {
    const opts = options || {};
    const ec = EC[opts.ec] ? opts.ec : 'M';
    const minVersion = Math.min(40, Math.max(1, opts.minVersion || 1));
    const mode = opts.mode && MODE_INDICATOR[opts.mode] ? opts.mode : detectMode(text);
    const bytes = mode === 'byte' ? toBytes(text) : new Uint8Array(0);

    // 収まる最小のバージョンを探す（文字数指示子の長さが版で変わるので毎回計算）
    let version = 0;
    let usedBits = 0;
    for (let v = minVersion; v <= 40; v++) {
      const need = 4 + countBits(mode, v) + payloadBits(mode, text, bytes);
      if (need <= dataCapacityBits(v, ec)) { version = v; usedBits = need; break; }
    }
    if (!version) {
      const e = new Error('データが大きすぎます');
      e.code = 'TOO_LONG';
      throw e;
    }

    const codewords = buildCodewords(version, ec, mode, text, bytes);
    const m = new Matrix(version);
    drawFunctionPatterns(m, ec);
    drawCodewords(m, codewords);

    // マスク選択：指定がなければ8通り試して減点の小さいものを採る
    let bestMask = typeof opts.mask === 'number' ? opts.mask : -1;
    if (bestMask < 0 || bestMask > 7) {
      let best = Infinity;
      for (let mask = 0; mask < 8; mask++) {
        applyMask(m, mask);
        drawFormatBits(m, ec, mask);
        const p = penalty(m);
        if (p < best) { best = p; bestMask = mask; }
        applyMask(m, mask); // 戻す（XORなので同じ操作で復元できる）
      }
    }
    applyMask(m, bestMask);
    drawFormatBits(m, ec, bestMask);

    const size = m.size;
    return {
      version: version,
      ec: ec,
      mode: mode,
      mask: bestMask,
      size: size,
      modules: m.modules,
      func: m.func,
      capacityBits: dataCapacityBits(version, ec),
      usedBits: usedBits,
      at: (x, y) => m.modules[y * size + x] === 1,
      isFunction: (x, y) => m.func[y * size + x] === 1
    };
  }

  // 指定レベルでその文字列が入りきるかの下調べ（UIの上限表示に使う）
  function capacityFor(ec, mode, version) {
    return Math.floor((dataCapacityBits(version, ec) - 4 - countBits(mode, version)) / 8);
  }

  global.QRCore = {
    encode: encode,
    detectMode: detectMode,
    capacityFor: capacityFor,
    ecRatio: level => (EC[level] || EC.M).ratio,
    LEVELS: ['L', 'M', 'Q', 'H']
  };
})(window);
