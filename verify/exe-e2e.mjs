/**
 * 验收 dist\DropSluice.exe（打包出来的单文件版）：
 * 起进程 → 面板接口 → 配对 → 列目录 → 下载并比 SHA256 → 二维码 SVG → 关掉。
 *
 * 用法：node verify/exe-e2e.mjs [--exe dist/DropSluice.exe] [--port 18899]
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const EXE = path.resolve(ROOT, argOf('--exe', 'dist/DropSluice.exe'));
const PORT = Number(argOf('--port', 18899));
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 读 PE 可选头第 68 字节：2=GUI（双击不弹窗），3=控制台（双击弹黑窗口）。 */
function peSubsystem(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const dos = Buffer.alloc(0x40);
    fs.readSync(fd, dos, 0, dos.length, 0);
    const peOff = dos.readUInt32LE(0x3c);
    if (dos.toString('latin1', 0, 2) !== 'MZ') throw new Error('不是 PE 文件');
    const buf = Buffer.alloc(2);
    fs.readSync(fd, buf, 0, 2, peOff + 4 + 20 + 68);
    return buf.readUInt16LE(0);
  } finally {
    fs.closeSync(fd);
  }
}

/** 裸 socket 发一个 GET，只取状态码（用来伪造 Host，fetch 不允许改 Host）。 */
function rawStatus(port, hostHeader, pathname) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => {
      sock.write(`GET ${pathname} HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`);
    });
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (d) => (buf += d));
    sock.on('error', reject);
    sock.on('end', () => {
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(buf);
      resolve(m ? Number(m[1]) : 0);
    });
  });
}

async function waitReady(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/admin/state`);
      if (r.ok) return await r.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(300);
  }
  throw new Error('服务没起来');
}

const PHONE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36';

async function main() {
  if (!fs.existsSync(EXE)) throw new Error(`没有 exe：${EXE}`);
  // 数据目录放在仓库 build/ 下：系统的 %TEMP% 可能是 8.3 短路径，mkdir 会 EPERM
  const dataHome = fs.mkdtempSync(path.join(ROOT, 'build', 'exe-test-'));

  console.log(`启动 ${path.basename(EXE)}（端口 ${PORT}，数据目录 ${path.basename(dataHome)}）`);
  const child = spawn(EXE, ['--port', String(PORT), '--no-open'], {
    env: { ...process.env, DROPSLUICE_HOME: dataHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d.toString()));
  child.stderr.on('data', (d) => (out += d.toString()));

  const cleanup = async () => {
    try {
      await fetch(`${BASE}/api/admin/quit`, { method: 'POST' });
    } catch {
      /* 忽略 */
    }
    await sleep(500);
    if (!child.killed) child.kill();
    fs.rmSync(dataHome, { recursive: true, force: true });
  };

  try {
    const state = await waitReady();
    ok('进程起来了，admin state 可读', state.running === true, `port=${state.port}`);
    ok('终端里打印了配对链接', /\/pair\?c=\d{6}/.test(out));

    const sub = peSubsystem(EXE);
    ok('exe 是 GUI 子系统（双击不弹黑窗口）', sub === 2, `Subsystem=${sub}`);

    const logFile = path.join(dataHome, 'server.log');
    const logText = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    ok('没有控制台时把日志写进数据目录', logText.includes('DropSluice'), logFile);

    const desktop = await fetch(`${BASE}/desktop`);
    const desktopHtml = await desktop.text();
    ok(
      'GET /desktop 200 且是面板 HTML',
      desktop.status === 200 && desktopHtml.includes('DropSluice'),
      `${desktopHtml.length} 字节`,
    );

    const phoneCss = await fetch(`${BASE}/style.css`);
    ok('GET /style.css 200（手机 UI 静态资源）', phoneCss.status === 200, `${(await phoneCss.text()).length} 字节`);

    const root = await fetch(`${BASE}/`, { redirect: 'manual' });
    ok('未配对访问 / 被 302 到 /pair', root.status === 302, root.headers.get('location') || '');

    const qr = await fetch(`${BASE}/qr.svg?t=1`);
    const qrText = qr.status === 200 ? await qr.text() : '';
    ok('GET /qr.svg 200 且是 SVG', qr.status === 200 && qrText.startsWith('<svg'), `${qrText.length} 字节`);

    const pairRes = await fetch(`${BASE}/api/admin/pair`, { method: 'POST' });
    const pairJson = await pairRes.json();
    const code = pairJson.pairing?.code;
    ok('POST /api/admin/pair 给出 6 位码', /^\d{6}$/.test(String(code)), String(code));

    const wrong = await fetch(`${BASE}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': PHONE_UA },
      body: JSON.stringify({ code: '000000' }),
    });
    ok('错码被拒', wrong.status === 403, String(wrong.status));

    const good = await fetch(`${BASE}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': PHONE_UA },
      body: JSON.stringify({ code, name: 'exe 自测手机' }),
    });
    const cookie = (good.headers.getSetCookie?.() || []).join('; ').split(';')[0];
    ok('正确配对码换到会话 Cookie', good.status === 200 && cookie.startsWith('pd_session='), `${cookie.slice(0, 22)}…`);

    const auth = { cookie };

    const roots = await (await fetch(`${BASE}/api/roots`, { headers: auth })).json();
    ok(
      '配对后能列盘符和常用目录',
      Array.isArray(roots.drives) && roots.drives.length > 0 && Array.isArray(roots.shortcuts),
      `${(roots.drives || []).map((d) => d.path).join(' ')} / ${(roots.shortcuts || []).length} 个快捷入口`,
    );

    const tinyFile = path.join(dataHome, 'exe-check.bin');
    const payload = crypto.randomBytes(64 * 1024);
    fs.writeFileSync(tinyFile, payload);
    const dl = await fetch(`${BASE}/api/download?path=${encodeURIComponent(tinyFile)}`, { headers: auth });
    const body = Buffer.from(await dl.arrayBuffer());
    ok(
      '下载 64KB 文件，SHA256 与源文件一致',
      dl.status === 200 && sha256(body) === sha256(payload),
      `${body.length} 字节 / ${sha256(body).slice(0, 12)}…`,
    );
    ok(
      '下载响应头声明不压缩、不缓存',
      dl.headers.get('content-encoding') === null && /no-store/.test(dl.headers.get('cache-control') || ''),
      dl.headers.get('cache-control') || '(无 cache-control)',
    );
    ok(
      '文件名按 UTF-8 编码给出',
      /filename\*=UTF-8''/.test(dl.headers.get('content-disposition') || ''),
      dl.headers.get('content-disposition') || '',
    );

    const me = await (await fetch(`${BASE}/api/me`, { headers: auth })).json();
    ok('设备信息里有 IP/型号', !!me.device?.name && !!me.ip, JSON.stringify(me).slice(0, 100));

    const st2 = await (await fetch(`${BASE}/api/admin/state`)).json();
    const dev = st2.devices?.[0];
    ok('面板能看到刚配对的设备', !!dev, dev ? `${dev.name || dev.id} @ ${dev.ip || '?'}` : '空');
    if (dev) {
      const rv = await fetch(`${BASE}/api/admin/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: dev.id }),
      });
      const after = await fetch(`${BASE}/api/me`, { headers: auth });
      ok('面板解除设备后旧 Cookie 立即 401', rv.status === 200 && after.status === 401, `revoke=${rv.status} me=${after.status}`);
    }

    const spoof = await rawStatus(PORT, `192.168.1.50:${PORT}`, '/api/admin/state');
    ok('面板接口拒绝非本机 Host', spoof === 403, `HTTP ${spoof}`);
    const localHost = await rawStatus(PORT, `127.0.0.1:${PORT}`, '/api/admin/state');
    ok('本机 Host 能访问面板接口', localHost === 200, `HTTP ${localHost}`);
  } finally {
    await cleanup();
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) {
    console.log('\n--- exe 输出 ---\n' + out.split('\n').slice(-30).join('\n'));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('自测崩了：', err);
  process.exitCode = 1;
});
