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

import { isMobileBrowser } from '../lib/app.mjs';
import { isTailnetIp } from '../lib/net.mjs';

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
      inst = await startDropSluice({ port, host: '127.0.0.1', openPairing: true, maxUploadBytes: 1024 });
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

// ---------- 5.5 多选下载（勾选若干文件/文件夹打一个 zip） ----------
console.log('5.5) 多选下载 / 传输记录');
await check('GET /api/download-many 把选中的几项打进一个 zip', async () => {
  const q = new URLSearchParams();
  q.append('p', path.join(zipDir, 'a.txt'));
  q.append('p', path.join(zipDir, '子目录'));
  const r = await req(`/api/download-many?${q}`);
  assert(r.status === 200, `期望 200，实际 ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  assert(buf[0] === 0x50 && buf[1] === 0x4b, '不是 zip');
  const zipPath = path.join(tmp, 'many.zip');
  await writeFile(zipPath, buf);
  const out = path.join(tmp, 'unzip-many');
  rm(out, { recursive: true, force: true });
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${out}' -Force`], { stdio: 'pipe' });
  const a1 = await readFile(path.join(out, 'a.txt'));
  const b1 = await readFile(path.join(out, '子目录', 'b.bin'));
  assert(a1.equals(await readFile(path.join(zipDir, 'a.txt'))), 'a.txt 内容不符');
  assert(b1.equals(Buffer.from([0, 1, 2, 255, 254, 13, 10])), 'b.bin 内容不符');
  const cd = r.headers.get('content-disposition') || '';
  assert(cd.includes('.zip'), `文件名不像 zip：${cd}`);
  return `${(buf.length / 1024).toFixed(1)} KB`;
});

await check('GET /api/download-many 没有选中项时报 400', async () => {
  const r = await req('/api/download-many');
  assert(r.status === 400, `期望 400，实际 ${r.status}`);
  const d = await r.json();
  assert(d.error === 'no_items', `错误码不对：${d.error}`);
  return 'no_items';
});

await check('GET /api/history 里有刚传完的记录', async () => {
  const r = await req('/api/history');
  assert(r.status === 200, `期望 200，实际 ${r.status}`);
  const d = await r.json();
  assert(Array.isArray(d.history), 'history 不是数组');
  assert(d.history.length > 0, '一条记录都没有');
  const first = d.history[0];
  assert(typeof first.name === 'string' && first.name.length > 0, '记录没有文件名');
  assert(typeof first.bytes === 'number' && first.bytes > 0, '记录没有字节数');
  assert(first.ok === true, '成功的传输被标成失败');
  return `${d.history.length} 条，最近：${first.name}`;
});

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
await check('超过上限的上传被 413 挡下，且不留半截文件', async () => {
  const big = Buffer.alloc(4096, 7); // 服务在测试里把上限设成 1 KiB
  const r = await req(`/api/upload?path=${encodeURIComponent(tmp)}`, {
    method: 'POST',
    headers: { 'x-file-name': encodeURIComponent('太大了.bin'), 'content-type': 'application/octet-stream' },
    body: big,
  });
  assert(r.status === 413, `期望 413，实际 ${r.status}`);
  const d = await r.json();
  assert(d.error === 'too_large', `error 字段不对：${d.error}`);
  let left = false;
  try { await stat(path.join(tmp, '太大了.bin')); left = true; } catch {}
  assert(!left, '拒绝后还留下了半截文件');
  return `limit=${d.limit}`;
});

// ---------- 6.5 分块上传（断点续传） ----------
console.log('6.5) 分块上传（断点续传）');
const chunkQ = (name, size) => `path=${encodeURIComponent(tmp)}&name=${encodeURIComponent(name)}&size=${size}`;

await check('分块上传：断在中间能续上，最后拼成原文件', async () => {
  const data = Buffer.alloc(900);
  for (let i = 0; i < data.length; i++) data[i] = i % 251;
  const q = chunkQ('分块.bin', data.length);
  const half = 450;

  const init = await (await req(`/api/upload/resume?${q}`)).json();
  assert(init.offset === 0, `初始断点应为 0，实际 ${init.offset}`);

  let r = await req(`/api/upload/resume/chunk?${q}&offset=0`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: data.subarray(0, half),
  });
  assert(r.status === 200, `第一块失败：${r.status}`);
  assert((await r.json()).offset === half, '第一块之后断点不对');

  // 模拟中途断线：重新问一次断点
  const again = await (await req(`/api/upload/resume?${q}`)).json();
  assert(again.offset === half, `重连后断点应为 ${half}，实际 ${again.offset}`);

  // 客户端记错偏移 → 409 并告诉它真断点
  r = await req(`/api/upload/resume/chunk?${q}&offset=0`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: data.subarray(0, 10),
  });
  assert(r.status === 409, `错偏移期望 409，实际 ${r.status}`);
  assert((await r.json()).offset === half, '409 里给的断点不对');

  // 收尾前不许落地
  let landed = true;
  try { await stat(path.join(tmp, '分块.bin')); } catch { landed = false; }
  assert(!landed, '还没 done 就已经把文件写进目标目录了');

  r = await req(`/api/upload/resume/chunk?${q}&offset=${half}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: data.subarray(half),
  });
  assert(r.status === 200, `第二块失败：${r.status}`);

  const done = await req(`/api/upload/resume/done?${q}`, { method: 'POST' });
  assert(done.status === 200, `收尾失败：${done.status} ${await done.text().catch(() => '')}`);
  const got = await readFile(path.join(tmp, '分块.bin'));
  assert(got.equals(data), '拼出来的文件内容不符');
  return `${data.length} B / 两块`;
});

await check('分块上传：没传完就 done 会被 409 挡下', async () => {
  const data = Buffer.alloc(600, 3);
  const q = chunkQ('半截.bin', data.length);
  await req(`/api/upload/resume/chunk?${q}&offset=0`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: data.subarray(0, 200),
  });
  const r = await req(`/api/upload/resume/done?${q}`, { method: 'POST' });
  assert(r.status === 409, `期望 409，实际 ${r.status}`);
  const d = await r.json();
  assert(d.error === 'incomplete' && d.offset === 200, `返回不对：${JSON.stringify(d)}`);

  // 放弃：DELETE 之后断点归零
  await req(`/api/upload/resume?${q}`, { method: 'DELETE' });
  const again = await (await req(`/api/upload/resume?${q}`)).json();
  assert(again.offset === 0, `放弃后断点应归零，实际 ${again.offset}`);
  return 'incomplete → 409 → 放弃归零';
});

await check('分块上传：声明的总大小超上限直接 413', async () => {
  const q = chunkQ('太大.bin', 4096); // 测试服务上限 1 KiB
  const r = await req(`/api/upload/resume?${q}`);
  assert(r.status === 413, `期望 413，实际 ${r.status}`);
  const d = await r.json();
  assert(d.error === 'too_large', `error 字段不对：${d.error}`);
  return `limit=${d.limit}`;
});

// ---------- 7. 手机端只认 App ----------console.log('7) 手机端只认 App（浏览器被挡在网页端外）');
await check('isMobileBrowser 判定（浏览器拦、App 不拦、桌面不拦）', async () => {
  const phone = 'Mozilla/5.0 (Linux; Android 14; V2465A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Mobile Safari/537.36';
  assert(isMobileBrowser(phone) === true, '安卓浏览器应被判为手机浏览器');
  assert(isMobileBrowser(`${phone} DropSluice/1.0.1`) === false, 'App 的 UA 不该被拦');
  assert(isMobileBrowser('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36') === false, '桌面浏览器不该被拦');
  assert(isMobileBrowser(null) === false, '没有 UA 不该被拦');
  return '4 种 UA 判定正确';
});

// 网关只在"非回环"生效，所以要另起一台监听 0.0.0.0 的实例、从局域网地址回连一次
const lanIp = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
if (!lanIp) {
  ok('网关集成测试', '跳过：这台机器没有局域网地址');
} else {
  const { startDropSluice } = await import('../lib/app.mjs');
  let gated = null;
  for (let attempt = 0; attempt < 12 && !gated; attempt++) {
    const port = 19200 + Math.floor(Math.random() * 700);
    try {
      gated = await startDropSluice({ port, host: '0.0.0.0', openPairing: true });
    } catch (err) {
      if (err?.code !== 'EADDRINUSE') throw err;
    }
  }
  const gbase = `http://${lanIp}:${gated.port}`;
  const phoneUA = 'Mozilla/5.0 (Linux; Android 14; V2465A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Mobile Safari/537.36';
  try {
    await check('手机浏览器 GET / → 403 + 引导页', async () => {
      const r = await fetch(`${gbase}/`, { headers: { 'user-agent': phoneUA }, redirect: 'manual' });
      assert(r.status === 403, `期望 403，实际 ${r.status}`);
      const text = await r.text();
      assert(text.includes('请用 DropSluice App'), '引导页文案不对');
      return '403';
    });
    await check('App 的 UA 不被拦（未配对 → 302 去 /pair）', async () => {
      const r = await fetch(`${gbase}/`, { headers: { 'user-agent': `${phoneUA} DropSluice/1.0.1` }, redirect: 'manual' });
      assert(r.status === 302, `期望 302，实际 ${r.status}`);
      return '302';
    });
    await check('HEAD /apk 给出安装包', async () => {
      const r = await fetch(`${gbase}/apk`, { method: 'HEAD' });
      assert(r.status === 200, `期望 200，实际 ${r.status}`);
      assert(/vnd\.android\.package-archive/.test(r.headers.get('content-type') || ''), `Content-Type 不对：${r.headers.get('content-type')}`);
      return `${r.headers.get('content-length')} B`;
    });
    // 引导页上的「下载安装包」按钮是从手机浏览器里点的：/apk 必须对它开放，否则按钮是死的
    await check('手机浏览器也能下 /apk（引导页按钮不是死的）', async () => {
      const head = await fetch(`${gbase}/apk`, { method: 'HEAD', headers: { 'user-agent': phoneUA } });
      assert(head.status === 200, `HEAD 期望 200，实际 ${head.status}`);
      const got = await fetch(`${gbase}/apk`, { headers: { 'user-agent': phoneUA } });
      assert(got.status === 200, `GET 期望 200，实际 ${got.status}`);
      const headLen = Number(head.headers.get('content-length'));
      const body = Buffer.from(await got.arrayBuffer());
      assert(body.length === headLen, `字节数不一致：HEAD ${headLen} / GET ${body.length}`);
      assert(body[0] === 0x50 && body[1] === 0x4b, '下载到的不是 zip 头（PK）');
      return `${body.length} B`;
    });
    // 引导页自己引用 /style.css；这张表被拦的话 403 页面就是裸的（曾经真的裸过）
    await check('手机浏览器能取 /style.css（引导页有样式）', async () => {
      const r = await fetch(`${gbase}/style.css`, { headers: { 'user-agent': phoneUA } });
      assert(r.status === 200, `期望 200，实际 ${r.status}`);
      const text = await r.text();
      assert(text.includes('--accent'), '样式表内容不对');
      return `${text.length} 字符`;
    });
  } catch (err) {
    bad('网关集成测试', `连不上本机局域网地址 ${gbase}：${err.message}`);
  } finally {
    await gated.close();
  }
}

// ---------- 7.5 传输进度 ----------
console.log('7.5) 传输进度（正在传什么、多快）');
await check('登记表能算出速率并标记完成', async () => {
  const { createTransfers } = await import('../lib/transfers.mjs');
  const tr = createTransfers();
  const id = tr.start({ kind: 'download', name: 'demo.bin', total: 1000, ip: '1.2.3.4' });
  tr.add(id, 200);
  await new Promise((r) => setTimeout(r, 260));
  tr.add(id, 300);
  const [t] = tr.list();
  assert(t && t.name === 'demo.bin', '没登记上');
  assert(t.bytes === 500, `字节数不对：${t.bytes}`);
  assert(t.speed > 0, `速率没算出来：${t.speed}`);
  tr.end(id);
  const [done] = tr.list();
  assert(done.done === true, '没标记完成');
  return `${Math.round(t.speed)} B/s`;
});

await check('下载进行中时 /api/transfers 里有 download 条目', async () => {
  const size = 4 * 1024 * 1024;
  const big = path.join(tmp, 'xfer-big.bin');
  await writeFile(big, Buffer.alloc(size, 7));
  const r = await req(`/api/download?path=${encodeURIComponent(big)}`);
  assert(r.status === 200, `期望 200，实际 ${r.status}`);
  const reader = r.body.getReader();
  await reader.read(); // 先收一块，流还开着
  const mid = await req('/api/transfers');
  assert(mid.status === 200, `transfers 期望 200，实际 ${mid.status}`);
  const data = await mid.json();
  const hit = (data.transfers || []).find((t) => t.kind === 'download' && t.name === 'xfer-big.bin');
  while (!(await reader.read()).done) { /* 把剩下的读完，别让服务端挂着 */ }
  assert(hit, `没看到 download 条目：${JSON.stringify(data.transfers)}`);
  assert(hit.total === size, `total 不对：${hit.total}`);
  return `${hit.bytes} B / ${hit.total} B`;
});

// ---------- 8. 解除配对 ----------
console.log('8) 解除配对');
await check('unpair 后令牌失效', async () => {
  const r1 = await req('/api/unpair', { method: 'POST' });
  assert(r1.status === 200, `期望 200，实际 ${r1.status}`);
  jar.cookie = null;
  const r2 = await req('/api/roots');
  assert(r2.status === 401, `期望 401，实际 ${r2.status}`);
  return '401';
});

// ---------- 9. Tailscale / 跨网络 ----------
console.log('9) Tailscale（不在同一个 Wi-Fi）');
await check('isTailnetIp 只认 100.64/10', async () => {
  const cases = [
    ['100.64.0.1', true],
    ['100.127.255.254', true],
    ['100.102.209.27', true],
    ['100.63.255.255', false],
    ['100.128.0.1', false],
    ['192.168.1.5', false],
    ['8.8.8.8', false],
    ['', false],
    ['not-an-ip', false],
  ];
  const wrong = cases.filter(([ip, want]) => isTailnetIp(ip) !== want);
  assert(!wrong.length, `判定错的：${wrong.map(([ip, w]) => `${ip} 期望 ${w}`).join('，')}`);
  return `${cases.length} 个边界值`;
});
await check('状态里有 tailnet 段（面板据此显示远程那张码）', async () => {
  const r = await fetch(`${BASE}/api/admin/state`);
  assert(r.status === 200, `期望 200，实际 ${r.status}`);
  const s = await r.json();
  assert(s.tailnet && typeof s.tailnet === 'object', '没有 tailnet 字段');
  assert(typeof s.tailnet.up === 'boolean', 'tailnet.up 不是布尔');
  return s.tailnet.up ? `已连：${s.tailnet.ip}` : '未登录 Tailscale（也能正常跑）';
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
