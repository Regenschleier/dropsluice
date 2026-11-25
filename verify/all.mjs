import { encodeMatrix } from '../lib/qr.mjs';
import fs from 'node:fs';

const texts = [
  'A',
  'https://example.com',
  'http://192.168.1.20:18888/pair?c=123456',
  'x'.repeat(14),
  'x'.repeat(26),
  'x'.repeat(42),
  'x'.repeat(62),
  'x'.repeat(84),
  'x'.repeat(106),
  'x'.repeat(122),
  'x'.repeat(152),
  'x'.repeat(180),
  'x'.repeat(213),
  '中文测试：手机传文件 不压缩 🔥',
  'Z'.repeat(30),
  '00112233',
];

const out = texts.map((t) => {
  const auto = encodeMatrix(t);
  const perMask = [];
  for (let m = 0; m < 8; m++) {
    const r = encodeMatrix(t, { mask: m });
    perMask.push(r.modules.map((row) => Array.from(row).join('')));
  }
  return {
    text: t,
    bytes: Buffer.byteLength(t, 'utf8'),
    version: auto.version,
    mask: auto.mask,
    rows: auto.modules.map((row) => Array.from(row).join('')),
    perMask,
  };
});
fs.writeFileSync('qr-all.json', JSON.stringify(out));
console.log('wrote', out.length, 'entries');
