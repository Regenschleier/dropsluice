/**
 * 验证「终端二维码」画出来能被还原成正确的矩阵：
 *   矩阵 → 半块字符 → 反推矩阵 → 原矩阵
 * 三个都要逐格相等，否则手机扫终端里的码就会扫错。
 *
 *   node verify/terminal-qr.mjs
 */
import { encodeMatrix } from '../lib/qr.mjs';
import { terminalQrLines } from '../lib/terminal-qr.mjs';

const QUIET = 2;

/** 半块字符反推回 0/1 网格 */
function parseLines(lines) {
  const map = { '█': [1, 1], '▀': [1, 0], '▄': [0, 1], ' ': [0, 0] };
  const rows = [];
  for (const line of lines) {
    const top = [];
    const bottom = [];
    for (const ch of line) {
      const [a, b] = map[ch] ?? [0, 0];
      top.push(a);
      bottom.push(b);
    }
    rows.push(top, bottom);
  }
  return rows;
}

const cases = [
  'http://192.168.1.20:18888/pair?c=123456',
  'http://192.168.1.5:18888/pair?c=000000',
  'http://127.0.0.1:18888/',
  'a',
  '中文测试 http://10.0.0.2:18888/pair?c=999999',
];

let pass = 0;
let fail = 0;

for (const text of cases) {
  const { modules, version, size: n } = encodeMatrix(text);   // n = 模块数（不含静区）
  const full = n + QUIET * 2;                                 // 含静区的边长
  const lines = terminalQrLines(text);
  const grid = parseLines(lines);
  const problems = [];

  if (lines.length !== Math.ceil(full / 2)) problems.push(`行数 ${lines.length} != ${Math.ceil(full / 2)}`);
  if (lines.some((l) => l.length !== full)) problems.push('有行的列数不等于含静区边长');

  let diff = 0;
  for (let r = 0; r < full; r++) {
    for (let c = 0; c < full; c++) {
      const rr = r - QUIET;
      const cc = c - QUIET;
      const inCode = rr >= 0 && cc >= 0 && rr < n && cc < n;
      const want = inCode && modules[rr][cc] ? 1 : 0;
      const got = grid[r]?.[c] ?? 0;
      if (want !== got) {
        if (diff < 5) problems.push(`(${r},${c}) 期望 ${want} 实得 ${got}`);
        diff++;
      }
    }
  }
  if (diff) problems.push(`共 ${diff} 格不一致`);

  if (problems.length) {
    fail++;
    console.log(`✗ ${text.slice(0, 40)}  v${version} ${n}×${n}`);
    for (const p of problems.slice(0, 6)) console.log(`    ${p}`);
  } else {
    pass++;
    console.log(`✓ ${text.slice(0, 40)}  v${version} ${n}×${n} 模块 → ${lines.length} 行终端字符，逐格一致`);
  }
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
