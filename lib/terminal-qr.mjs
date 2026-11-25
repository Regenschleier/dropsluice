/**
 * 把二维码矩阵画成终端里的方块字符。
 *
 * 用"上下半块"字符：一个字符盖两行模块，行数砍半，宽高比在多数终端里接近 1:1，
 * 手机扫上去不会变形。
 *   █  上下都是暗模块
 *   ▀  上暗下亮
 *   ▄  上亮下暗
 *   空格 上下都亮（含静区）
 */
import { encodeMatrix } from './qr.mjs';

const QUIET = 2;

export function terminalQrLines(text, { quiet = QUIET } = {}) {
  const { modules } = encodeMatrix(text);
  const n = modules.length;
  const size = n + quiet * 2;

  const get = (r, c) => {
    const rr = r - quiet;
    const cc = c - quiet;
    if (rr < 0 || cc < 0 || rr >= n || cc >= n) return 0;
    return modules[rr][cc] ? 1 : 0;
  };

  // 总行数补成偶数，最后一行才不会画歪
  const lines = [];
  for (let r = 0; r < size; r += 2) {
    let line = '';
    for (let c = 0; c < size; c++) {
      const top = get(r, c);
      const bottom = r + 1 < size ? get(r + 1, c) : 0;
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(line);
  }
  return lines;
}

export function printTerminalQr(text, out = console.log) {
  out(terminalQrLines(text).join('\n'));
}
