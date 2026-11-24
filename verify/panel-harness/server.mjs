/**
 * 面板视觉验收用的小服务器（只在本机做 UI 截图时用，不参与产品运行）。
 *
 *   node verify/panel-harness/server.mjs [--port 18990]
 *
 * 做三件事：
 *   1. 把 harness.html 和 react UMD 发给浏览器；
 *   2. `/phone-drop/state` 返回一份写死的快照（running + 配对中 + 两台设备）；
 *   3. `/phone-drop/qr.svg` 直接转发真实 Host 路由的二维码，保证是真码不是占位图。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[process.argv.indexOf('--port') + 1]) || 18990;
const HOST_ORIGIN = process.env.DROPSLUICE_HOST_ORIGIN || 'http://127.0.0.1:18888';

const LAN = '192.168.1.20';
const code = process.env.DROPSLUICE_DEMO_CODE || '123456';

const now = Date.now();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/**
 * 写死的两条设备记录，字段与真 `devicesDetailed()` 的返回一一对应：
 * 一台局域网里的 iPhone（带 Wi-Fi 名），一台来自公网 IP 的旧平板（带城市名），
 * 这样截图能覆盖"局域网 / 公网 + 设备型号 + 时间"两种排布。
 */
const state = {
  ok: true,
  running: true,
  adopted: false,
  port: 18888,
  lan: LAN,
  url: `http://${LAN}:18888/`,
  pairing: {
    open: true,
    code,
    expiresAt: now + 7 * MIN,
    url: `http://${LAN}:18888/pair?c=${code}`,
    hasQr: true,
  },
  devices: [
    {
      id: 'demo-lan',
      name: '我的手机',
      createdAt: now - 2 * HOUR,
      lastSeenAt: now - 40 * 1000,
      ip: '192.168.1.20',
      iface: 'WLAN',
      client: { kind: 'phone', model: 'iPhone', os: 'iOS 18.1', browser: 'Safari', label: 'iPhone · iOS 18.1 · Safari' },
      network: { kind: 'lan', iface: 'WLAN', ssid: 'MyWiFi-5G' },
      location: null,
    },
    {
      id: 'demo-wan',
      name: '旧 iPad',
      createdAt: now - 26 * HOUR,
      lastSeenAt: now - 3 * HOUR,
      ip: '203.0.113.42',
      iface: 'WLAN',
      client: { kind: 'tablet', model: 'iPad', os: 'iPadOS 16.6', browser: 'Safari', label: 'iPad · iPadOS 16.6 · Safari' },
      network: { kind: 'public', iface: 'WLAN', ssid: null },
      location: { place: '中国 · 上海', isp: 'China Telecom', source: 'ip-api.com', at: now },
    },
  ],
  firewallCommand: 'New-NetFirewallRule -DisplayName "DropSluice"',
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (url.pathname === '/phone-drop/state') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(state));
    }
    if (url.pathname === '/phone-drop/qr.svg') {
      // 手机服务自己的二维码路由是 /qr.svg（面板那份是 Host 半转发的），别搞混
      const upstream = await fetch(`${HOST_ORIGIN}/qr.svg`);
      const body = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
      return res.end(body);
    }
    const rel = url.pathname === '/' ? 'harness.html' : url.pathname.slice(1);
    const isClient = rel === 'client.js';
    const file = isClient ? path.join(HERE, '..', '..', 'client.js') : path.join(HERE, rel);
    if (!isClient && !file.startsWith(HERE)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch (err) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(String(err?.message ?? err));
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`panel harness: http://127.0.0.1:${PORT}/`);
});
