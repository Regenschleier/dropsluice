/**
 * 流式 ZIP（store 模式，**不压缩**）。
 *
 * 为什么要自己写：手机点一个文件夹时，逐个点开太麻烦，所以要"整包下载"；
 * 但用户要的是原样文件，所以用 store（method 0）——解压后的字节和磁盘上一模一样。
 * 不引入任何第三方包，边读边发，不在磁盘上落地临时文件。
 */
import fs from 'node:fs';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(buf, seed = 0) {
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return { time: 0, date: 0x0021 };
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

function localHeader({ nameBuf, time, date }) {
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(20, 4); // version needed
  h.writeUInt16LE(0x0808, 6); // bit3 = data descriptor, bit11 = UTF-8 文件名
  h.writeUInt16LE(0, 8); // method = store
  h.writeUInt16LE(time, 10);
  h.writeUInt16LE(date, 12);
  h.writeUInt32LE(0, 14); // crc 先写 0，真值放 data descriptor
  h.writeUInt32LE(0, 18);
  h.writeUInt32LE(0, 22);
  h.writeUInt16LE(nameBuf.length, 26);
  h.writeUInt16LE(0, 28);
  return Buffer.concat([h, nameBuf]);
}

function dataDescriptor({ crc, size }) {
  const d = Buffer.alloc(16);
  d.writeUInt32LE(0x08074b50, 0);
  d.writeUInt32LE(crc >>> 0, 4);
  d.writeUInt32LE(size >>> 0, 8);
  d.writeUInt32LE(size >>> 0, 12);
  return d;
}

function centralHeader(e) {
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE(20, 4);
  h.writeUInt16LE(20, 6);
  h.writeUInt16LE(0x0808, 8);
  h.writeUInt16LE(0, 10);
  h.writeUInt16LE(e.time, 12);
  h.writeUInt16LE(e.date, 14);
  h.writeUInt32LE(e.crc >>> 0, 16);
  h.writeUInt32LE(e.size >>> 0, 20);
  h.writeUInt32LE(e.size >>> 0, 24);
  h.writeUInt16LE(e.nameBuf.length, 28);
  h.writeUInt16LE(0, 30);
  h.writeUInt16LE(0, 32);
  h.writeUInt16LE(0, 34);
  h.writeUInt16LE(0, 36);
  h.writeUInt32LE(0, 38);
  h.writeUInt32LE(e.offset >>> 0, 42);
  return Buffer.concat([h, e.nameBuf]);
}

function eocd(count, cdSize, cdOffset) {
  const b = Buffer.alloc(22);
  b.writeUInt32LE(0x06054b50, 0);
  b.writeUInt16LE(0, 4);
  b.writeUInt16LE(0, 6);
  b.writeUInt16LE(count, 8);
  b.writeUInt16LE(count, 10);
  b.writeUInt32LE(cdSize >>> 0, 12);
  b.writeUInt32LE(cdOffset >>> 0, 16);
  b.writeUInt16LE(0, 20);
  return b;
}

/**
 * 把一个目录树打包成 zip 流。
 * @param {string} dirAbs 要打包的目录
 * @param {string} rootName zip 里的顶层目录名
 */
export async function* zipDirectory(dirAbs, rootName) {
  const entries = [];
  let offset = 0;

  async function* walk(current, rel) {
    const dirents = await fs.promises.readdir(current, { withFileTypes: true });
    dirents.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    for (const d of dirents) {
      const abs = `${current}${current.endsWith('\\') || current.endsWith('/') ? '' : '/'}${d.name}`;
      const relPath = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        yield* walk(abs, relPath);
      } else if (d.isFile()) {
        yield { abs, relPath };
      }
    }
  }

  // 目录条目（空目录也能保留）
  const dirs = [];
  async function collectDirs(current, rel) {
    let dirents;
    try {
      dirents = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    dirs.push(rel);
    for (const d of dirents) if (d.isDirectory()) await collectDirs(`${current}/${d.name}`, `${rel}/${d.name}`);
  }
  await collectDirs(dirAbs, rootName);

  for (const dirRel of dirs) {
    const nameBuf = Buffer.from(dirRel.replace(/\\/g, '/') + '/', 'utf8');
    const { time, date } = dosDateTime(Date.now());
    const header = localHeader({ nameBuf, time, date });
    yield header;
    offset += header.length;
    const entry = { nameBuf, time, date, crc: 0, size: 0, offset };
    entries.push(entry);
    offset += 0; // 目录没有 data descriptor 内容（size=0，crc=0）
  }

  for await (const file of walk(dirAbs, rootName)) {
    let st;
    try {
      st = await fs.promises.stat(file.abs);
    } catch {
      continue;
    }
    if (st.size > 0xffffffff) continue; // 单文件 >4GB 需要 zip64，跳过并提示
    const nameBuf = Buffer.from(file.relPath.replace(/\\/g, '/'), 'utf8');
    const { time, date } = dosDateTime(st.mtimeMs);
    const entry = { nameBuf, time, date, crc: 0, size: 0, offset };
    const header = localHeader(entry);
    yield header;
    entry.offset = offset;
    offset += header.length;

    let crc = 0;
    let size = 0;
    const stream = fs.createReadStream(file.abs, { highWaterMark: 1 << 16 });
    for await (const chunk of stream) {
      crc = crc32(chunk, crc);
      size += chunk.length;
      offset += chunk.length;
      yield chunk;
    }
    entry.crc = crc >>> 0;
    entry.size = size;
    const dd = dataDescriptor({ crc, size });
    offset += dd.length;
    yield dd;
    entries.push(entry);
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const e of entries) {
    const ch = centralHeader(e);
    cdSize += ch.length;
    yield ch;
  }
  yield eocd(entries.length, cdSize, cdStart);
}
