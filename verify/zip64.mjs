/**
 * zip64 自测：小包仍产出普通 zip；大包（≥4 GiB）自动切到 zip64。
 *
 *   node verify/zip64.mjs          # 只跑结构和头字段（秒级）
 *   node verify/zip64.mjs --big    # 额外造一个 4.3 GiB 稀疏文件真打一遍（几十秒，占磁盘 ~4.3 GB）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipDirectory, centralHeader, zip64Extra } from '../lib/zip.mjs';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dropsluice-zip64-'));

async function collect(gen) {
  const chunks = [];
  for await (const c of gen) chunks.push(c);
  return Buffer.concat(chunks);
}

console.log('1) 头字段计算');
{
  const nameBuf = Buffer.from('a.txt', 'utf8');
  const small = centralHeader({ nameBuf, time: 0, date: 0x21, crc: 1, size: 10, offset: 0 });
  ok('小文件用 20 版、无 zip64 额外字段', small.readUInt16LE(6) === 20 && small.readUInt16LE(30) === 0);

  const big = centralHeader({ nameBuf, time: 0, date: 0x21, crc: 1, size: 5 * 1024 ** 3, offset: 10 });
  const extraLen = big.readUInt16LE(30);
  const extraAt = 46 + nameBuf.length;
  const extraId = extraLen ? big.readUInt16LE(extraAt) : 0;
  const sizeInExtra = extraLen >= 12 ? Number(big.readBigUInt64LE(extraAt + 4)) : 0;
  ok('≥4 GiB 的文件用 45 版', big.readUInt16LE(6) === 45);
  ok('尺寸字段写 0xFFFFFFFF', big.readUInt32LE(20) === 0xffffffff && big.readUInt32LE(24) === 0xffffffff);
  ok('额外字段是 0x0001 且带真实尺寸', extraId === 0x0001 && sizeInExtra === 5 * 1024 ** 3, `extraLen=${extraLen} size=${sizeInExtra}`);

  const far = centralHeader({ nameBuf, time: 0, date: 0x21, crc: 1, size: 10, offset: 6 * 1024 ** 3 });
  const farLen = far.readUInt16LE(30);
  const farAt = 46 + nameBuf.length;
  ok('偏移 ≥4 GiB 时偏移写 0xFFFFFFFF', far.readUInt32LE(42) === 0xffffffff);
  ok('偏移值进额外字段', farLen === 12 && Number(far.readBigUInt64LE(farAt + 4)) === 6 * 1024 ** 3);

  ok('zip64Extra 空数组返回 0 字节', zip64Extra([]).length === 0);
}

console.log('2) 小目录打出来还是普通 zip');
{
  const dir = path.join(tmp, 'small');
  fs.mkdirSync(path.join(dir, '子目录'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  fs.writeFileSync(path.join(dir, '子目录', 'b.bin'), Buffer.alloc(1000, 7));
  const zip = await collect(zipDirectory(dir, 'small'));
  const nameAt = zip.length - 22;
  ok('结尾是普通 EOCD', zip.readUInt32LE(nameAt) === 0x06054b50, `size=${zip.length}`);
  ok('没有 zip64 EOCD', zip.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06])) < 0);
  ok('条目数 = 2 文件 + 2 目录', zip.readUInt16LE(nameAt + 8) === 4, `count=${zip.readUInt16LE(nameAt + 8)}`);
  ok('中央目录大小合理', zip.readUInt32LE(nameAt + 12) > 0);
}

if (process.argv.includes('--big')) {
  console.log('3) 4.3 GiB 稀疏文件：真打一遍，检查是否切到 zip64');
  const dir = path.join(tmp, 'big');
  fs.mkdirSync(dir, { recursive: true });
  const bigFile = path.join(dir, 'big.bin');
  const fd = fs.openSync(bigFile, 'w');
  const size = Math.floor(4.3 * 1024 ** 3);
  fs.ftruncateSync(fd, size);
  fs.closeSync(fd);
  fs.writeFileSync(path.join(dir, 'tail.txt'), 'after-big');

  const out = path.join(tmp, 'big.zip');
  const sink = fs.createWriteStream(out);
  let total = 0;
  const startedAt = Date.now();
  for await (const chunk of zipDirectory(dir, 'big')) {
    total += chunk.length;
    if (!sink.write(chunk)) await new Promise((r) => sink.once('drain', r));
  }
  await new Promise((r) => sink.end(r));
  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);

  const stat = fs.statSync(out);
  ok('产物超过 4 GiB', stat.size > 4 * 1024 ** 3, `${(stat.size / 1024 ** 3).toFixed(2)} GiB，耗时 ${secs}s`);

  // 末尾 22 字节：普通 EOCD，但偏移/大小写 0xFFFFFFFF 作哨兵
  const fh = fs.openSync(out, 'r');
  const tail = Buffer.alloc(4096);
  fs.readSync(fh, tail, 0, 4096, stat.size - 4096);
  fs.closeSync(fh);
  ok('普通 EOCD 的偏移写成 0xFFFFFFFF 哨兵', tail.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06])) && tail.readUInt32LE(tail.length - 22 + 16) === 0xffffffff);
  ok('存在 zip64 EOCD 记录', tail.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])));
  ok('存在 zip64 EOCD locator', tail.includes(Buffer.from([0x50, 0x4b, 0x06, 0x07])));
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (process.argv.includes('--keep')) console.log(`临时目录保留在：${tmp}`);
else fs.rmSync(tmp, { recursive: true, force: true });
if (fail) process.exitCode = 1;
