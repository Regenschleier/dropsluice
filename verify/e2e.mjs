/**
 * 端到端自测：不需要手机，用 node 直接跑一遍真实 HTTP 流程。
 *
 *   node verify/e2e.mjs [baseUrl]
 *
 * 覆盖：配对（错码/正码）→ /api/me → 盘符 → 列目录 → 下载 SHA256 与源文件一致
 *      → Range 206 分段一致 → HEAD 长度一致 → zip 打包 → 上传 → 解除配对。
 */
import { createHash } from 'node:crypto';
import { writeFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, extra = '') {
  pass++;
  console.log(`  ✓ ${name}${extra ? `  ${extra}` : ''}`);
}
function bad(name, detail) {
  fail++;
  failures.push(`${name}: ${detail}`);
  console.log(`  ✗ ${name}  ${detail}`);
}

async function check(name, fn) {
  try {
    const r = await fn();
    ok(name, typeof r === 'string' ? r : '');
  } catch (err) {
    bad(name, err.message);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

/** 极简 cookie jar：只记一个 pd_session */
class Jar {
  constructor() { this.cookie = null; }
  capture(res) {
    const raw = res.headers.getSetCookie?.() ?? [];
    for (const c of raw) {
      const [pair] = c.split(';');
      if (pair.startsWith('pd_session=')) {
        const v = pair.slice('pd_session='.length);
        this.cookie = v ? v : null;
      }
    }
  }
  headers() { return this.cookie ? { cookie: `pd_session=${this.cookie}` } : {}; }
}

const jar = new Jar();

// 不给 baseUrl 时自己起一台一次性服务（独立状态目录 + 随机端口），
// 绝不碰桌面上正在跑的那台 DropSluice（配对窗口是全局状态，共用会互相踢掉）。
const HOME = path.join(os.tmpdir(), `phone-drop-e2e-home-${Date.now()}`);
const BASE = process.argv[2] ?? (await (async () => {
  process.env.DROPSLUICE_HOME = HOME;
  const { startDropSluice } = await import('../lib/app.mjs');
  let inst = null;
  for (let attempt = 0; attempt < 12 && !inst; attempt++) {
    const port = 19100 + Math.floor(Math.random() * 800);
    try {
      inst = await startDropSluice({ port, host: '127.0.0.1', openPairing: true });
    } catch (err) {
      if (err?.code !== 'EADDRINUSE') throw err;
    }
  }
  if (!inst) throw new Error('找不到空闲端口起测试服务');
  globalThis.__cleanup = async () => {
    await inst.close();
    await rm(HOME, { recursive: true, force: true });
  };
  process.on('exit', () => { try { inst.close(); } catch {} });
  return `http://127.0.0.1:${inst.port}`;
})());

const req = (p, opts = {}) => fetch(`${BASE}${p}`, {
  redirect: 'manual',
  ...opts,
  headers: { ...jar.headers(), ...(opts.headers || {}) },
});

const tmp = path.join(os.tmpdir(), `phone-drop-e2e-${Date.now()}`);
await mkdir(tmp, { recursive: true });

console.log(`\nDropSluice 端到端自测 @ ${BASE}\n`);

// ---------- 0. 开一个全新的配对窗口 ----------
console.log('0) 打开配对窗口');
await check('POST /api/pairing/open 换新码', async () => {
  const r = await req('/api/pairing/open', { method: 'POST' });
  assert(r.status === 200, `期望 200，实际 ${r.status}`);
  const d = await r.json();
  assert(/^\d{6}$/.test(d.code || ''), `配对码格式不对：${d.code}`);
  globalThis.__fresh = d.code;
  return `code=${d.code}`;
});

// ---------- 1. 未配对时应被挡 ----------
console.log('1) 未配对状态');
await check('GET / 302 到 /pair', async () => {
  const r = await req('/');
  assert(r.status === 302, `期望 302，实际 ${r.status}`);
  assert(/\/pair/.test(r.headers.get('location') || ''), 'Location 不对');
  return r.headers.get('location');
});
await check('GET /api/roots 未授权 401', async () => {
  const r = await req('/api/roots');
  assert(r.status === 401, `期望 401，实际 ${r.status}`);
  return r.status;
});
await check('GET /api/pairing 本机可见配对码', async () => {
  const r = await req('/api/pairing');
  assert(r.status === 200, `期望 200，实际 ${r.status}`);
  const d = await r.json();
  assert(d.open === true, '配对窗口没打开');
  assert(/^\d{6}$/.test(d.code), `配对码格式不对：${d.code}`);
  assert(d.url?.includes(`c=${d.code}`), '配对 URL 没带码');
  globalThis.__code = d.code;
  return `code=${d.code}`;
});
await check('GET /qr.svg 是合法 SVG', async () => {
  const r = await req('/qr.svg');
  assert(r.status === 200, `期望 200，实际 ${r.status}`);
  const svg = await r.text();
  assert(svg.startsWith('<svg'), '不是 svg');
  assert(svg.length > 500, 'svg 太小');
  return `${svg.length} 字节`;
});

// ---------- 2. 配对 ----------
console.log('2) 配对');
await check('错码被拒（403）', async () => {
  jar.cookie = null;
  const r = await req('/api/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: '000000', name: '错误测试' }),
  });
  assert(r.status === 403, `期望 403，实际 ${r.status}`);
  return r.status;
});
await check('正码换到令牌（中文设备名）', async () => {
  const r = await req('/api/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: globalThis.__code, name: '自测手机 📱' }),
  });
  jar.capture(r);
  const d = await r.json().catch(() => ({}));
  assert(r.status === 200, `期望 200，实际 ${r.status} ${JSON.stringify(d)}`);
  assert(jar.cookie && jar.cookie.length > 30, `没拿到 cookie：${jar.cookie}`);
  return `deviceId=${d.deviceId}`;
});
await check('配对码用后作废（同码再配 403）', async () => {
  const r = await fetch(`${BASE}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: globalThis.__code, name: '第二个' }),
  });
  assert(r.status === 403, `期望 403，实际 ${r.status}`);
  return r.status;
});
await check('GET /api/me 认得出设备', async () => {
  const r = await req('/api/me');
  assert(r.status === 200, `期望 200，实际 ${r.status}`);
  const d = await r.json();
  assert(d.device?.name === '自测手机 📱', `设备名不对：${JSON.stringify(d)}`);
  return d.device.name;
});
await check('GET / 已配对可访问', async () => {
  const r = await req('/');
  assert(r.status === 200, `期望 200，实际 ${r.status}`);
  const html = await r.text();
  assert(html.includes('DropSluice'), '页面内容不对');
  return r.status;
});
await check('Bearer 头也能认证', async () => {
  const r = await fetch(`${BASE}/api/me`, { headers: { authorization: `Bearer ${decodeURIComponent(jar.cookie)}` } });
  assert(r.status === 200, `期望 200，实际 ${r.status}`);
  return r.status;
});

// ---------- 3. 浏览 ----------
console.log('3) 浏览磁盘');
let roots;
await check('GET /api/roots 列出盘符', async () => {
  const r = await req('/api/roots');
  assert(r.status === 200, `期望 200，实际 ${r.status}`);
  roots = await r.json();
  assert(Array.isArray(roots.drives) && roots.drives.length > 0, '没有盘符');
  assert(Array.isArray(roots.shortcuts) && roots.shortcuts.length > 0, '没有快捷入口');
  return roots.drives.join(' ') + ` / 快捷 ${roots.shortcuts.length}`;
});
await check('列盘符根目录', async () => {
  const drive = roots.drives[0];
  const r = await req(`/api/list?path=${encodeURIComponent(drive + '\\')}`);
  assert(r.status === 200, `期望 200，实际 ${r.status}`);
  const d = await r.json();
  assert(Array.isArray(d.entries), '没有 entries');
  const dirs = d.entries.filter((e) => e.type === 'dir').length;
  return `${d.entries.length} 项（${dirs} 目录）`;
});
await check('列本工作区目录', async () => {
  const here = process.cwd();
  const r = await req(`/api/list?path=${encodeURIComponent(here)}`);
  assert(r.status === 200, `期望 200，实际 ${r.status}`);
  const d = await r.json();
  assert(d.entries.some((e) => e.name === 'lib'), `没看到 lib：${d.entries.map((e) => e.name).join(',')}`);
  return `${d.entries.length} 项`;
});
await check('相对路径被拒', async () => {
  const r = await req('/api/list?path=foo');
  assert(r.status >= 400, `期望 4xx，实际 ${r.status}`);
  return r.status;
});

// ---------- 4. 下载：字节级一致 ----------
console.log('4) 下载（无压缩、逐字节一致）');
const bigFile = path.join(tmp, '测试 大文件.bin');
{
  // 4.5 MB 伪随机，含 0 字节与高位字节
  const buf = Buffer.alloc(4.5 * 1024 * 1024);
  for (let i = 0; i < buf.length; i += 4) buf.writeUInt32LE((i * 2654435761) >>> 0, i);
  await writeFile(bigFile, buf);
}
const bigSha = sha(await readFile(bigFile));
await check('下载 SHA256 与源文件一致', async () => {
  const r = await req(`/api/download?path=${encodeURIComponent(bigFile)}`);
  assert(r.status === 200, `期望 200，实际 ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  assert(buf.length === (await stat(bigFile)).size, `长度不符 ${buf.length}`);
  const got = sha(buf);
  assert(got === bigSha, `sha 不符\n  源 ${bigSha}\n  收 ${got}`);
  return `${(buf.length / 1048576).toFixed(2)} MB`;
});
await check('响应头：长度/类型/不缓存/文件名', async () => {
  const r = await req(`/api/download?path=${encodeURIComponent(bigFile)}`);
  const size = (await stat(bigFile)).size;
  assert(Number(r.headers.get('content-length')) === size, `Content-Length ${r.headers.get('content-length')}`);
  assert(r.headers.get('accept-ranges') === 'bytes', '没有 Accept-Ranges');
  assert(/no-store/.test(r.headers.get('cache-control') || ''), `Cache-Control: ${r.headers.get('cache-control')}`);
  assert(!/encoding/i.test(r.headers.get('content-encoding') || ''), '竟然带 Content-Encoding（会被压缩）');
  const cd = r.headers.get('content-disposition') || '';
  assert(cd.includes("filename*=UTF-8''"), 'Content-Disposition 缺 filename*');
  await r.body?.cancel?.();
  return cd.slice(0, 40) + '…';
});
await check('HEAD 与 GET 长度一致', async () => {
  const r = await req(`/api/download?path=${encodeURIComponent(bigFile)}`, { method: 'HEAD' });
  const size = (await stat(bigFile)).size;
  assert(r.status === 200, `期望 200，实际 ${r.status}`);
  assert(Number(r.headers.get('content-length')) === size, `HEAD 长度 ${r.headers.get('content-length')}`);
  return `${size}`;
});
await check('Range 分段拼接 == 原文件', async () => {
  const size = (await stat(bigFile)).size;
  const parts = [];
  const cuts = [0, 1000, 1048576, 2000000, size];
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i];
    const b = cuts[i + 1] - 1;
    const r = await req(`/api/download?path=${encodeURIComponent(bigFile)}`, {
      headers: { range: `bytes=${a}-${b}` },
    });
    assert(r.status === 206, `期望 206，实际 ${r.status}`);
    const cr = r.headers.get('content-range');
    assert(cr === `bytes ${a}-${b}/${size}`, `Content-Range 不对：${cr}`);
    const buf = Buffer.from(await r.arrayBuffer());
    assert(buf.length === b - a + 1, `分段长度 ${buf.length} != ${b - a + 1}`);
    parts.push(buf);
  }
  const joined = Buffer.concat(parts);
  const full = await readFile(bigFile);
  assert(joined.length === full.length, `拼接长度 ${joined.length} != ${full.length}`);
  assert(sha(joined) === bigSha, '拼接后 sha 不符');
  return `${cuts.length - 1} 段`;
});

// ---------- 5. zip 打包 ----------
console.log('5) 文件夹打包（store 模式，不压缩）');
const zipDir = path.join(tmp, '打包 测试');
await mkdir(path.join(zipDir, '子目录'), { recursive: true });
await writeFile(path.join(zipDir, 'a.txt'), 'hello 世界\n'.repeat(100));
await writeFile(path.join(zipDir, '子目录', 'b.bin'), Buffer.from([0, 1, 2, 255, 254, 13, 10]));
await writeFile(path.join(zipDir, '空的.txt'), '');
await check('GET /api/zip 返回合法 zip 且内容一致', async () => {
  const r = await req(`/api/zip?path=${encodeURIComponent(zipDir)}`);
  assert(r.status === 200, `期望 200，实际 ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  assert(buf[0] === 0x50 && buf[1] === 0x4b, '不是 zip');
  const zipPath = path.join(tmp, 'out.zip');
  await writeFile(zipPath, buf);
  const out = path.join(tmp, 'unzip');
  rm(out, { recursive: true, force: true });
  // 用 PowerShell 解压（Windows 自带），-Force 覆盖
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${out}' -Force`], { stdio: 'pipe' });
  const a1 = await readFile(path.join(out, '打包 测试', 'a.txt'));
  const b1 = await readFile(path.join(out, '打包 测试', '子目录', 'b.bin'));
  const e1 = await readFile(path.join(out, '打包 测试', '空的.txt'));
  assert(a1.equals(await readFile(path.join(zipDir, 'a.txt'))), 'a.txt 内容不符');
  assert(b1.equals(Buffer.from([0, 1, 2, 255, 254, 13, 10])), 'b.bin 内容不符');
  assert(e1.length === 0, '空文件不符');
  return `${(buf.length / 1024).toFixed(1)} KB`;
});

// ---------- 6. 上传 ----------
console.log('6) 上传');
await check('上传后文件字节一致', async () => {
  const payload = Buffer.from('上传回来的内容\n第二行 🚀', 'utf8');
  const dest = path.join(tmp, '上传件.txt');
  const r = await req(`/api/upload?path=${encodeURIComponent(tmp)}`, {
    method: 'POST',
    headers: { 'x-file-name': encodeURIComponent('上传件 带空格.txt'), 'content-type': 'application/octet-stream' },
    body: payload,
  });
  assert(r.status === 200, `期望 200，实际 ${r.status} ${await r.text().catch(() => '')}`);
  const got = await readFile(path.join(tmp, '上传件 带空格.txt'));
  assert(got.equals(payload), '上传内容不符');
  return '上传件 带空格.txt';
});
await check('重名自动改名（不覆盖）', async () => {
  const payload = Buffer.from('第二个', 'utf8');
  const r = await req(`/api/upload?path=${encodeURIComponent(tmp)}`, {
    method: 'POST',
    headers: { 'x-file-name': encodeURIComponent('上传件 带空格.txt'), 'content-type': 'application/octet-stream' },
    body: payload,
  });
  assert(r.status === 200, `期望 200，实际 ${r.status}`);
  const d = await r.json();
  assert(d.name !== '上传件 带空格.txt', `没改名：${d.name}`);
  const first = await readFile(path.join(tmp, '上传件 带空格.txt'));
  assert(first.toString() === '上传回来的内容\n第二行 🚀', '原文件被覆盖了');
  return d.name;
});

// ---------- 7. 解除配对 ----------
console.log('7) 解除配对');
await check('unpair 后令牌失效', async () => {
  const r1 = await req('/api/unpair', { method: 'POST' });
  assert(r1.status === 200, `期望 200，实际 ${r1.status}`);
  jar.cookie = null;
  const r2 = await req('/api/roots');
  assert(r2.status === 401, `期望 401，实际 ${r2.status}`);
  return '401';
});

// ---------- 汇总 ----------
await rm(tmp, { recursive: true, force: true });
await globalThis.__cleanup?.();
console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
