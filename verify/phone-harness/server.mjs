/**
 * 手机端页面的"假数据服务器"——只给截图/文档用，不参与产品运行。
 *
 * 为什么要它：真服务列的是这台电脑上的真实目录，截图会带上本机用户名和私人文件名，
 * 不适合进仓库。这里用 `public/` 里真正的 HTML/CSS/JS，只把 /api 换成演示数据，
 * 截出来的图和真实手机页面长得一模一样。
 *
 * 用法：node verify/phone-harness/server.mjs [--port 18995] [--quick]
 *   --quick  只做内部自检（不发请求、不截图），给 CI/临时检查用
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { qrSvg } from '../../lib/qr.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(HERE, '../../public');
const DESKTOP = path.resolve(HERE, '../../desktop');

const argv = process.argv.slice(2);
const portArg = argv.indexOf('--port');
const PORT = portArg >= 0 ? Number(argv[portArg + 1]) : 18995;
const QUICK = argv.includes('--quick');

const HOME = 'C:\\Users\\Demo';

const ROOTS = {
  platform: 'win32',
  home: HOME,
  hostname: 'DEMO-PC',
  drives: ['C:\\', 'D:\\'],
  shortcuts: [
    { label: '桌面', path: `${HOME}\\Desktop` },
    { label: '下载', path: `${HOME}\\Downloads` },
    { label: '文档', path: `${HOME}\\Documents` },
    { label: '图片', path: `${HOME}\\Pictures` },
    { label: '视频', path: `${HOME}\\Videos` },
    { label: '音乐', path: `${HOME}\\Music` },
    { label: '整个用户目录', path: HOME },
  ],
};

const desktop = [
  { name: '项目资料', type: 'dir' },
  { name: '截图归档', type: 'dir' },
  { name: '视频素材', type: 'dir' },
  { name: '报销单', type: 'dir' },
  { name: '设计稿-首页.png', type: 'file', size: 2_483_456, mtime: Date.UTC(2026, 10, 21, 9, 12) },
  { name: '周报-第 47 周.docx', type: 'file', size: 38_912, mtime: Date.UTC(2026, 10, 22, 18, 40) },
  { name: '产品演示.mp4', type: 'file', size: 148_635_648, mtime: Date.UTC(2026, 10, 20, 14, 5) },
  { name: '会议录音.m4a', type: 'file', size: 8_912_896, mtime: Date.UTC(2026, 10, 19, 10, 33) },
  { name: '安装包-windows.exe', type: 'file', size: 92_274_688, mtime: Date.UTC(2026, 10, 18, 8, 2) },
  { name: '数据表-10月.xlsx', type: 'file', size: 245_760, mtime: Date.UTC(2026, 10, 17, 16, 21) },
  { name: '备忘.txt', type: 'file', size: 1_238, mtime: Date.UTC(2026, 10, 23, 7, 55) },
];

const LISTINGS = {
  'C:\\': [
    { name: 'Program Files', type: 'dir' },
    { name: 'Users', type: 'dir' },
    { name: 'Windows', type: 'dir' },
  ],
  [HOME]: [
    { name: 'Desktop', type: 'dir' },
    { name: 'Documents', type: 'dir' },
    { name: 'Downloads', type: 'dir' },
    { name: 'Pictures', type: 'dir' },
  ],
  [`${HOME}\\Desktop`]: desktop,
  [`${HOME}\\Downloads`]: [
    { name: 'Byteferry-1.0.1-portable.zip', type: 'file', size: 35_061_760, mtime: Date.UTC(2026, 10, 23, 1, 30) },
    { name: 'Byteferry-1.0.0.apk', type: 'file', size: 3_449_651, mtime: Date.UTC(2026, 10, 23, 1, 12) },
  ],
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

/* ---- 打包版电脑面板（desktop/desktop.html）的演示状态 ---- */
const DEMO_ORIGIN = 'http://192.168.1.20:18888';
const DEMO_CODE = '123456';
const hoursAgo = (h) => Date.now() - h * 3600_000;

const DEMO_STATE = {
  running: true,
  port: 18888,
  lan: '192.168.1.20',
  url: `${DEMO_ORIGIN}/`,
  addresses: ['192.168.1.20'],
  pairing: {
    open: true,
    code: DEMO_CODE,
    expiresAt: Date.now() + 6 * 60_000,
    url: `${DEMO_ORIGIN}/pair?c=${DEMO_CODE}`,
  },
  devices: [
    {
      id: 'demo-lan-device-0001',
      name: '我的手机',
      ip: '192.168.1.20',
      iface: 'WLAN',
      client: { kind: 'phone', model: 'iPhone', os: 'iOS 18.1', browser: 'Safari', label: 'iPhone · iOS 18.1 · Safari' },
      network: { kind: 'lan', iface: 'WLAN', ssid: 'MyWiFi-5G' },
      location: null,
      createdAt: hoursAgo(2),
      lastSeenAt: Date.now() - 30_000,
    },
    {
      id: 'demo-wan-device-0002',
      name: '旧 iPad',
      ip: '203.0.113.42',
      iface: null,
      client: { kind: 'tablet', model: 'iPad', os: 'iPadOS 16.6', browser: 'Safari', label: 'iPad · iPadOS 16.6 · Safari' },
      network: { kind: 'public', iface: null, ssid: null },
      location: { place: '中国 · 上海', isp: 'China Telecom', source: 'ip-api.com' },
      createdAt: hoursAgo(26),
      lastSeenAt: hoursAgo(3),
    },
  ],
};

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  if (p === '/api/roots') return json(res, 200, ROOTS);
  if (p === '/api/list') {
    const want = url.searchParams.get('path');
    const entries = LISTINGS[want];
    if (!entries) return json(res, 200, { path: want, parent: null, entries: [], truncated: false });
    return json(res, 200, { path: want, parent: HOME, entries, truncated: false });
  }
  if (p === '/api/me') {
    return json(res, 200, { name: '演示手机', ip: '192.168.1.57', private: true });
  }
  if (p === '/api/pairing') return json(res, 200, { open: true });

  /* 打包版电脑面板用的几个端点 */
  if (p === '/api/admin/state') return json(res, 200, DEMO_STATE);
  if (p === '/qr.svg') {
    const svg = qrSvg(DEMO_STATE.pairing.url, { size: 240 });
    res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(svg);
  }
  if (p === '/desktop' || p === '/desktop.html') {
    const buf = fs.readFileSync(path.join(DESKTOP, 'desktop.html'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(buf);
  }

  // 其余走静态文件（只允许 public/ 下的）
  const file = path.resolve(PUBLIC, `.${p === '/' ? '/index.html' : p}`);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

if (QUICK) {
  console.log('phone-harness quick check ok');
  process.exit(0);
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`手机页面假数据服务器： http://127.0.0.1:${PORT}/`);
  console.log('  /            盘符与常用目录（演示数据）');
  console.log('  /api/list    C:\\Users\\Demo\\Desktop 有一份演示文件清单');
});
