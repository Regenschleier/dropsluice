/**
 * 极简 QR 码编码器（Byte 模式，纠错等级 M，版本 1–10）。
 * 只依赖 ISO/IEC 18004 的表，不引入任何第三方包。
 * 输出 SVG 字符串（给 <img> 或内联用），像素级无损。
 */

const EC_BITS = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };

// version -> { ec: 每块纠错码字数, groups: [[块数, 每块数据码字数], ...] }
const M_TABLE = {
  1: { ec: 10, groups: [[1, 16]] },
  2: { ec: 16, groups: [[1, 28]] },
  3: { ec: 26, groups: [[1, 44]] },
  4: { ec: 18, groups: [[2, 32]] },
  5: { ec: 24, groups: [[2, 43]] },
  6: { ec: 16, groups: [[4, 27]] },
  7: { ec: 18, groups: [[4, 31]] },
  8: { ec: 22, groups: [[2, 38], [2, 39]] },
  9: { ec: 22, groups: [[3, 36], [2, 37]] },
  10: { ec: 26, groups: [[4, 43], [1, 44]] },
};

const ALIGN = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

function dataCapacity(version) {
  const t = M_TABLE[version];
  return t.groups.reduce((n, [c, d]) => n + c * d, 0);
}

// ---------- GF(256) / Reed-Solomon ----------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data, degree) {
  const gen = rsGenerator(degree);
  const res = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.shift();
    res.push(0);
    if (factor !== 0) {
      for (let i = 0; i < degree; i++) res[i] ^= mul(gen[i + 1], factor);
    }
  }
  return res;
}

// ---------- 数据编码 ----------
function pickVersion(byteLen) {
  for (let v = 1; v <= 10; v++) {
    const cap = dataCapacity(v);
    const headerBits = 4 + (v <= 9 ? 8 : 16);
    if (cap * 8 >= headerBits + byteLen * 8) return v;
  }
  throw new Error(`内容太长（${byteLen} 字节），本编码器最高支持版本 10 / 213 字节`);
}

class BitBuffer {
  constructor() { this.bits = []; }
  put(value, length) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  get length() { return this.bits.length; }
}

function encodeData(bytes, version) {
  const buf = new BitBuffer();
  buf.put(0b0100, 4);
  buf.put(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) buf.put(b, 8);

  const capacityBits = dataCapacity(version) * 8;
  const terminator = Math.min(4, capacityBits - buf.length);
  buf.put(0, terminator);
  while (buf.length % 8 !== 0) buf.bits.push(0);

  const dataBytes = [];
  for (let i = 0; i < buf.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | buf.bits[i + j];
    dataBytes.push(v);
  }
  const pads = [0xec, 0x11];
  let k = 0;
  while (dataBytes.length < dataCapacity(version)) dataBytes.push(pads[k++ % 2]);
  return dataBytes;
}

function interleave(dataBytes, version) {
  const t = M_TABLE[version];
  const blocks = [];
  let offset = 0;
  for (const [count, size] of t.groups) {
    for (let i = 0; i < count; i++) {
      const chunk = dataBytes.slice(offset, offset + size);
      offset += size;
      blocks.push({ data: chunk, ec: rsRemainder(chunk, t.ec) });
    }
  }
  const out = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  }
  for (let i = 0; i < t.ec; i++) {
    for (const b of blocks) out.push(b.ec[i]);
  }
  return out;
}

// ---------- 矩阵 ----------
function newMatrix(size, fill) {
  return Array.from({ length: size }, () => new Uint8Array(size).fill(fill));
}

function placeFinder(m, row, col) {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
      const inner = r >= 0 && r <= 6 && c >= 0 && c <= 6;
      const dark = inner && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
      m[rr][cc] = dark ? 1 : 0;
    }
  }
}

function placeAlignment(m, version) {
  const centers = ALIGN[version];
  const size = m.length;
  for (const r of centers) {
    for (const c of centers) {
      // 跳过与三个定位图形重叠的角落
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          m[r + dr][c + dc] = dark ? 1 : 0;
        }
      }
    }
  }
}

function placeTiming(m) {
  const size = m.length;
  for (let i = 8; i < size - 8; i++) {
    m[6][i] = i % 2 === 0 ? 1 : 0;
    m[i][6] = i % 2 === 0 ? 1 : 0;
  }
}

function formatBits(mask) {
  const data = (EC_BITS.M << 3) | mask;
  let rest = data << 10;
  for (let i = 4; i >= 0; i--) {
    if (rest & (1 << (i + 10))) rest ^= 0x537 << i;
  }
  return ((data << 10) | rest) ^ 0x5412;
}

function versionBits(version) {
  let rest = version << 12;
  for (let i = 5; i >= 0; i--) {
    if (rest & (1 << (i + 12))) rest ^= 0x1f25 << i;
  }
  return (version << 12) | rest;
}

function placeFormat(m, mask) {
  const size = m.length;
  const bits = formatBits(mask);
  const get = (i) => (bits >> i) & 1;
  // 第一副本（左上）
  for (let i = 0; i <= 5; i++) m[i][8] = get(i);
  m[7][8] = get(6);
  m[8][8] = get(7);
  m[8][7] = get(8);
  for (let i = 9; i <= 14; i++) m[8][14 - i] = get(i);
  // 第二副本（右上 / 左下）
  for (let i = 0; i <= 7; i++) m[8][size - 1 - i] = get(i);
  for (let i = 8; i <= 14; i++) m[size - 15 + i][8] = get(i);
}

function placeVersion(m, version) {
  if (version < 7) return;
  const size = m.length;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const bit = (bits >> i) & 1;
    const r = Math.floor(i / 3);
    const c = i % 3;
    m[size - 11 + c][r] = bit;
    m[r][size - 11 + c] = bit;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function buildBase(version) {
  const size = 17 + version * 4;
  const m = newMatrix(size, 0);
  const reserved = newMatrix(size, 0); // 1 = 功能图形，不参与数据填充

  const markFinder = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r, cc = col + c;
        if (rr >= 0 && cc >= 0 && rr < size && cc < size) reserved[rr][cc] = 1;
      }
    }
  };
  placeFinder(m, 0, 0);
  placeFinder(m, 0, size - 7);
  placeFinder(m, size - 7, 0);
  markFinder(0, 0);
  markFinder(0, size - 7);
  markFinder(size - 7, 0);

  placeTiming(m);
  for (let i = 8; i < size - 8; i++) { reserved[6][i] = 1; reserved[i][6] = 1; }

  placeAlignment(m, version);
  const centers = ALIGN[version];
  for (const r of centers) for (const c of centers) {
    if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) reserved[r + dr][c + dc] = 1;
  }

  // 格式信息 / 版本信息区域占位
  for (let i = 0; i < 9; i++) { reserved[8][i] = 1; reserved[i][8] = 1; }
  for (let i = 0; i < 8; i++) { reserved[8][size - 1 - i] = 1; reserved[size - 1 - i][8] = 1; }
  reserved[size - 8][8] = 1;
  m[size - 8][8] = 1; // dark module
  if (version >= 7) {
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) {
      reserved[size - 11 + j][i] = 1;
      reserved[i][size - 11 + j] = 1;
    }
  }
  return { m, reserved, size };
}

function placeData(m, reserved, codewords) {
  const size = m.length;
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // 跳过竖直定时图形
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (let k = 0; k < 2; k++) {
        const c = col - k;
        if (reserved[row][c]) continue;
        let bit = 0;
        if (bitIndex < totalBits) {
          bit = (codewords[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1;
        }
        m[row][c] = bit;
        bitIndex++;
      }
    }
    upward = !upward;
  }
}

function applyMask(m, reserved, mask) {
  const size = m.length;
  const fn = MASKS[mask];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!reserved[r][c] && fn(r, c)) m[r][c] ^= 1;
    }
  }
}

function penalty(m) {
  const size = m.length;
  let score = 0;
  // 规则 1：同色连续 5 个以上
  for (let r = 0; r < size; r++) {
    let run = 1;
    for (let c = 1; c < size; c++) {
      if (m[r][c] === m[r][c - 1]) run++;
      else { if (run >= 5) score += 3 + (run - 5); run = 1; }
    }
    if (run >= 5) score += 3 + (run - 5);
  }
  for (let c = 0; c < size; c++) {
    let run = 1;
    for (let r = 1; r < size; r++) {
      if (m[r][c] === m[r - 1][c]) run++;
      else { if (run >= 5) score += 3 + (run - 5); run = 1; }
    }
    if (run >= 5) score += 3 + (run - 5);
  }
  // 规则 2：2x2 同色
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }
  // 规则 3：1:1:3:1:1 且一侧有 4 个空白的图形
  const p1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const p2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const check = (get, i) => {
    let ok1 = true, ok2 = true;
    for (let k = 0; k < 11; k++) {
      if (get(i + k) !== p1[k]) ok1 = false;
      if (get(i + k) !== p2[k]) ok2 = false;
    }
    return (ok1 ? 1 : 0) + (ok2 ? 1 : 0);
  };
  for (let r = 0; r < size; r++) {
    for (let c = 0; c + 11 <= size; c++) score += 40 * check((i) => m[r][i], c);
  }
  for (let c = 0; c < size; c++) {
    for (let r = 0; r + 11 <= size; r++) score += 40 * check((i) => m[i][c], r);
  }
  // 规则 4：暗块比例
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += m[r][c];
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

export function encodeMatrix(text, opts = {}) {
  const bytes = Buffer.from(String(text), 'utf8');
  const version = opts.version ?? pickVersion(bytes.length);
  const codewords = interleave(encodeData(bytes, version), version);
  const { m, reserved } = buildBase(version);
  placeData(m, reserved, codewords);

  let best = null;
  const fixed = opts.mask;
  for (let mask = 0; mask < 8; mask++) {
    if (fixed !== undefined && mask !== fixed) continue;
    const trial = m.map((row) => Uint8Array.from(row));
    applyMask(trial, reserved, mask);
    placeFormat(trial, mask);
    placeVersion(trial, version);
    const score = penalty(trial);
    if (!best || score < best.score) best = { mask, score, matrix: trial };
  }
  return { version, mask: best.mask, size: best.matrix.length, modules: best.matrix };
}

export function toSvg(matrix, { size = 256, margin = 4, dark = '#000000', light = '#ffffff' } = {}) {
  const count = matrix.length;
  const total = count + margin * 2;
  const scale = size / total;
  let path = '';
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (matrix[r][c]) {
        path += `M${(c + margin) * scale} ${(r + margin) * scale}h${scale}v${scale}h-${scale}z`;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">`
    + `<rect width="${size}" height="${size}" fill="${light}"/>`
    + `<path d="${path}" fill="${dark}"/></svg>`;
}

export function qrSvg(text, opts) {
  return toSvg(encodeMatrix(text).modules, opts);
}

export const __debug = { penalty, encodeData, interleave, buildBase, placeData, placeFormat, placeVersion, applyMask, pickVersion };
