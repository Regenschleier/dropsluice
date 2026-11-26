/**
 * 流式 ZIP（store 模式，**不压缩**）。
 *
 * 为什么要自己写：手机点一个文件夹时，逐个点开太麻烦，所以要"整包下载"；
 * 但用户要的是原样文件，所以用 store（method 0）——解压后的字节和磁盘上一模一样。
 * 不引入任何第三方包，边读边发，不在磁盘上落地临时文件。
 *
 * 大文件（zip64）：单个文件 ≥ 4 GiB、整包 ≥ 4 GiB、条目偏移 ≥ 4 GiB 时，
 * 32 位字段装不下，必须走 zip64——额外字段里放 8 字节的尺寸/偏移，
 * 并在结尾写 zip64 EOCD + locator。这里实现的是"只在需要时"用 zip64，
 * 小包仍然产出普通 zip（老工具也能解）。
 */
import fs from 'node:fs';

const U32MAX = 0xffffffff;
const U16MAX = 0xffff;

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

/** zip64 额外字段（0x0001）：按需塞 8 字节的 原始大小 / 压缩大小 / 本地头偏移。 */
export function zip64Extra(values) {
  if (!values.length) return Buffer.alloc(0);
  const b = Buffer.alloc(4 + values.length * 8);
  b.writeUInt16LE(0x0001, 0);
  b.writeUInt16LE(values.length * 8, 2);
  values.forEach((v, i) => b.writeBigUInt64LE(BigInt(v), 4 + i * 8));
  return b;
}

function localHeader({ nameBuf, time, date, zip64 = false, size = 0 }) {
  const extra = zip64 ? zip64Extra([size, size]) : Buffer.alloc(0);
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(zip64 ? 45 : 20, 4); // version needed：45 = 支持 zip64
  h.writeUInt16LE(0x0808, 6); // bit3 = data descriptor, bit11 = UTF-8 文件名
  h.writeUInt16LE(0, 8); // method = store
  h.writeUInt16LE(time, 10);
  h.writeUInt16LE(date, 12);
  h.writeUInt32LE(0, 14); // crc 先写 0，真值放 data descriptor
  h.writeUInt32LE(zip64 ? U32MAX : 0, 18);
  h.writeUInt32LE(zip64 ? U32MAX : 0, 22);
  h.writeUInt16LE(nameBuf.length, 26);
  h.writeUInt16LE(extra.length, 28);
  return Buffer.concat([h, nameBuf, extra]);
}

function dataDescriptor({ crc, size, zip64 = false }) {
  if (zip64) {
    const d = Buffer.alloc(24);
    d.writeUInt32LE(0x08074b50, 0);
    d.writeUInt32LE(crc >>> 0, 4);
    d.writeBigUInt64LE(BigInt(size), 8);
    d.writeBigUInt64LE(BigInt(size), 16);
    return d;
  }
  const d = Buffer.alloc(16);
  d.writeUInt32LE(0x08074b50, 0);
  d.writeUInt32LE(crc >>> 0, 4);
  d.writeUInt32LE(size >>> 0, 8);
  d.writeUInt32LE(size >>> 0, 12);
  return d;
}

/** 中央目录条目。字段是 0xFFFFFFFF 的，按顺序把真值放进 zip64 额外字段。 */
export function centralHeader(e) {
  const sizeNeeds64 = e.size >= U32MAX;
  const offsetNeeds64 = e.offset >= U32MAX;
  const values = [];
  if (sizeNeeds64) values.push(e.size, e.size);
  if (offsetNeeds64) values.push(e.offset);
  const extra = zip64Extra(values);

  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE(values.length ? 45 : 20, 4); // version made by
  h.writeUInt16LE(values.length ? 45 : 20, 6); // version needed
  h.writeUInt16LE(0x0808, 8);
  h.writeUInt16LE(0, 10);
  h.writeUInt16LE(e.time, 12);
  h.writeUInt16LE(e.date, 14);
  h.writeUInt32LE(e.crc >>> 0, 16);
  h.writeUInt32LE(sizeNeeds64 ? U32MAX : e.size >>> 0, 20);
  h.writeUInt32LE(sizeNeeds64 ? U32MAX : e.size >>> 0, 24);
  h.writeUInt16LE(e.nameBuf.length, 28);
  h.writeUInt16LE(extra.length, 30);
  h.writeUInt16LE(0, 32);
  h.writeUInt16LE(0, 34);
  h.writeUInt16LE(0, 36);
  h.writeUInt32LE(0, 38);
  h.writeUInt32LE(offsetNeeds64 ? U32MAX : e.offset >>> 0, 42);
  return Buffer.concat([h, e.nameBuf, extra]);
}

function eocd(count, cdSize, cdOffset) {
  const need64 = count > U16MAX || cdSize >= U32MAX || cdOffset >= U32MAX;
  const parts = [];
  if (need64) {
    const z = Buffer.alloc(56);
    z.writeUInt32LE(0x06064b50, 0); // zip64 end of central directory record
    z.writeBigUInt64LE(44n, 4); // 这条记录剩下多少字节
    z.writeUInt16LE(45, 12); // version made by
    z.writeUInt16LE(45, 14); // version needed
    z.writeUInt32LE(0, 16); // 本分卷号
    z.writeUInt32LE(0, 20); // 起始分卷号
    z.writeBigUInt64LE(BigInt(count), 24);
    z.writeBigUInt64LE(BigInt(count), 32);
    z.writeBigUInt64LE(BigInt(cdSize), 40);
    z.writeBigUInt64LE(BigInt(cdOffset), 48);
    parts.push(z);

    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0); // zip64 EOCD locator
    loc.writeUInt32LE(0, 4);
    loc.writeBigUInt64LE(BigInt(cdOffset + cdSize), 8); // 上面那条记录所在位置
    loc.writeUInt32LE(1, 16);
    parts.push(loc);
  }

  const b = Buffer.alloc(22);
  b.writeUInt32LE(0x06054b50, 0);
  b.writeUInt16LE(0, 4);
  b.writeUInt16LE(0, 6);
  b.writeUInt16LE(Math.min(count, U16MAX), 8);
  b.writeUInt16LE(Math.min(count, U16MAX), 10);
  b.writeUInt32LE(need64 ? U32MAX : cdSize >>> 0, 12);
  b.writeUInt32LE(need64 ? U32MAX : cdOffset >>> 0, 16);
  b.writeUInt16LE(0, 20);
  parts.push(b);
  return Buffer.concat(parts);
}

/**
 * 把一批已经展开好的目录/文件写成一个 zip 流。
 * @param {string[]} dirs zip 里要保留的目录条目（相对路径，不带结尾斜杠）
 * @param {{abs: string, relPath: string}[]} files 要打包的文件
 */
async function* emitZip(dirs, files) {
  const entries = [];
  let offset = 0;

  for (const dirRel of dirs) {
    const nameBuf = Buffer.from(dirRel.replace(/\\/g, '/') + '/', 'utf8');
    const { time, date } = dosDateTime(Date.now());
    const header = localHeader({ nameBuf, time, date });
    const entryOffset = offset;
    yield header;
    offset += header.length;
    entries.push({ nameBuf, time, date, crc: 0, size: 0, offset: entryOffset });
  }

  for (const file of files) {
    let st;
    try {
      st = await fs.promises.stat(file.abs);
    } catch {
      continue;
    }
    const nameBuf = Buffer.from(file.relPath.replace(/\\/g, '/'), 'utf8');
    const { time, date } = dosDateTime(st.mtimeMs);
    // 大小或当前偏移超过 4 GiB 就必须走 zip64
    const zip64 = st.size >= U32MAX || offset >= U32MAX;
    const header = localHeader({ nameBuf, time, date, zip64, size: st.size });
    const entryOffset = offset;
    yield header;
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
    const dd = dataDescriptor({ crc, size, zip64 });
    offset += dd.length;
    yield dd;
    entries.push({ nameBuf, time, date, crc: crc >>> 0, size, offset: entryOffset });
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const e of entries) {
    const ch = centralHeader(e);
    cdSize += ch.length;
    yield ch;
  }
  offset += cdSize;
  yield eocd(entries.length, cdSize, cdStart);
}

/**
 * 收集一个目录树里的目录与文件（用于打包）。
 * @param {string} dirAbs
 * @param {string} rootName zip 里的顶层目录名
 */
async function collectTree(dirAbs, rootName) {
  const dirs = [];
  const files = [];

  async function walk(current, rel) {
    let dirents;
    try {
      dirents = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    dirs.push(rel);
    for (const d of dirents) {
      const sep = current.endsWith('\\') || current.endsWith('/') ? '' : '/';
      const abs = `${current}${sep}${d.name}`;
      const relPath = `${rel}/${d.name}`;
      if (d.isDirectory()) await walk(abs, relPath);
      else if (d.isFile()) files.push({ abs, relPath });
    }
  }

  await walk(dirAbs, rootName);
  return { dirs, files };
}

/**
 * 把一个目录树打包成 zip 流。
 * @param {string} dirAbs 要打包的目录
 * @param {string} rootName zip 里的顶层目录名
 */
export async function* zipDirectory(dirAbs, rootName) {
  const { dirs, files } = await collectTree(dirAbs, rootName);
  yield* emitZip(dirs, files);
}

/**
 * 把「用户勾选的一批路径」打包成 zip 流：文件按自己的名字进包，目录整棵进包。
 * @param {{abs: string, name: string, isDirectory: boolean}[]} items
 */
export async function* zipPaths(items) {
  const dirs = [];
  const files = [];
  const used = new Set();

  const uniqueName = (name) => {
    let base = name;
    let i = 2;
    while (used.has(base.toLowerCase())) {
      base = `${name} (${i})`;
      i += 1;
    }
    used.add(base.toLowerCase());
    return base;
  };

  for (const item of items) {
    const top = uniqueName(item.name);
    if (item.isDirectory) {
      const tree = await collectTree(item.abs, top);
      dirs.push(...tree.dirs);
      files.push(...tree.files);
    } else {
      files.push({ abs: item.abs, relPath: top });
    }
  }

  yield* emitZip(dirs, files);
}
