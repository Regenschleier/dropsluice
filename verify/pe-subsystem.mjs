import fs from 'node:fs';

const file = process.argv[2] || 'dist/DropSluice.exe';
const fd = fs.openSync(file, 'r');
const head = Buffer.alloc(0x40);
fs.readSync(fd, head, 0, head.length, 0);
const peOff = head.readUInt32LE(0x3c);
const at = peOff + 4 + 20 + 68;
const buf = Buffer.alloc(2);
fs.readSync(fd, buf, 0, 2, at);
fs.closeSync(fd);
const sub = buf.readUInt16LE(0);
console.log(`${file}  Subsystem=${sub} (${sub === 2 ? 'GUI：双击无窗口' : sub === 3 ? '控制台：双击会弹窗口' : '其他'})`);
process.exitCode = sub === 2 ? 0 : 1;
