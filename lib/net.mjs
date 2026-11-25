/** 找本机在局域网里的 IPv4 地址（手机要连的那个），以及每个连接来自哪块网卡。 */
import os from 'node:os';
import { execFile, execFileSync } from 'node:child_process';

const VIRTUAL_HINTS = [/vethernet/i, /hyper-v/i, /virtualbox/i, /vmware/i, /loopback/i, /wsl/i, /docker/i];

/** 返回 [{ iface, address, virtual }]，按"越像真网卡越靠前"排序。 */
export function lanAddresses() {
  const out = [];
  const nics = os.networkInterfaces();
  for (const [iface, addrs] of Object.entries(nics)) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.address.startsWith('169.254.')) continue; // 自动私有地址 = 没连上
      out.push({ iface, address: a.address, virtual: VIRTUAL_HINTS.some((r) => r.test(iface)) });
    }
  }
  const score = (x) => (x.virtual ? 100 : 0) + (x.address.startsWith('192.168.') ? 0 : x.address.startsWith('10.') ? 5 : 10);
  return out.sort((a, b) => score(a) - score(b));
}

export function primaryLanAddress() {
  return lanAddresses()[0]?.address ?? null;
}

/**
 * Tailscale 给设备分的地址是 100.64.0.0/10（RFC 6598 那段共享地址空间）。
 *
 * 认出它有什么用：
 *   1. 手机用流量、或者连了别的 Wi-Fi 时，走的是这条隧道，地址长这样；
 *   2. 这类地址**不能**当成"公网来客"去查城市（查了也是错的），
 *      在设备列表里应该显示成"同一 Tailnet"。
 */
export function isTailnetIp(raw) {
  const ip = normalizeIp(raw);
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return false;
  return p[0] === 100 && p[1] >= 64 && p[1] <= 127;
}

// ---- Tailscale 状态（没装 / 没登录 / 正常）----
let tsCache = { at: 0, value: null };
const TS_TTL_MS = 30_000;

/** 找 tailscale 可执行文件：优先 PATH，其次 Windows 默认安装目录。 */
function tailscaleExe() {
  const candidates = [];
  if (process.platform === 'win32') {
    candidates.push('tailscale.exe');
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files']) {
      if (base) candidates.push(`${base}\\Tailscale\\tailscale.exe`);
    }
  } else {
    candidates.push('tailscale', '/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale');
  }
  return candidates;
}

function runTailscale(args, timeout = 4000) {
  for (const exe of tailscaleExe()) {
    try {
      const out = execFileSync(exe, args, { windowsHide: true, timeout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return String(out).trim();
    } catch {
      // 没装 / 没登录 / 这条子命令不支持，换下一个候选
    }
  }
  return null;
}

/**
 * Tailscale 现在的状态：{ up, ip, dnsName } 或 { up: false }。
 * 只在本机查（调 tailscale 自己的命令），不联网；结果缓存 30 秒。
 */
export function tailscaleInfo() {
  const now = Date.now();
  if (now - tsCache.at < TS_TTL_MS) return tsCache.value;
  let value = { up: false, ip: null, dnsName: null };
  const ip = runTailscale(['ip', '-4']);
  if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip.split(/\r?\n/)[0].trim())) {
    value = { up: true, ip: ip.split(/\r?\n/)[0].trim(), dnsName: null };
    // 顺带取 MagicDNS 名字（有就显示，没有也不影响）
    const st = runTailscale(['status', '--json']);
    if (st) {
      try {
        const self = JSON.parse(st).Self;
        if (self?.DNSName) value.dnsName = String(self.DNSName).replace(/\.$/, '');
      } catch {
        // 状态 JSON 解析不了就只留 IP
      }
    }
  }
  tsCache = { at: now, value };
  return value;
}

/** `::ffff:192.168.1.7` / `[::1]` → `192.168.1.7` / `::1` */
export function normalizeIp(raw) {
  if (!raw) return '';
  let ip = String(raw).trim();
  ip = ip.replace(/^\[|\]$/g, '');
  ip = ip.replace(/^::ffff:/i, '');
  const pct = ip.indexOf('%'); // fe80::1%WLAN 这种带 zone 的
  if (pct > 0) ip = ip.slice(0, pct);
  return ip;
}

export function isLoopback(remote) {
  const ip = normalizeIp(remote);
  return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.');
}

/** 私网 / 链路本地地址（这类地址查不到城市，只能说是"局域网"）。 */
export function isPrivateIp(raw) {
  const ip = normalizeIp(raw);
  if (!ip) return true;
  if (ip.includes(':')) {
    // IPv6：fc00::/7 唯一本地、fe80::/10 链路本地、::1 环回
    const low = ip.toLowerCase();
    return low === '::1' || low.startsWith('fc') || low.startsWith('fd') || /^fe[89ab]/.test(low);
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    a === 0
  );
}

/** 远端地址 → 本机这边是哪块网卡在接（`req.socket.localAddress` 反查）。 */
export function interfaceForLocal(localAddress) {
  const want = normalizeIp(localAddress);
  if (!want) return null;
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (normalizeIp(a.address) === want) return iface;
    }
  }
  return null;
}

// ---- Wi-Fi 名字（无线网卡才有；有线/虚拟网卡拿不到也没关系）----
let wifiCache = { at: 0, value: null };
const WIFI_TTL_MS = 60_000;

/**
 * 读一次 `netsh wlan show interfaces`，返回 { ssid } 或 null。
 *
 * 只取 SSID 这一项：字段名 "SSID" 在中文系统里也是英文原文，而网卡名 "Name"
 * 在中文系统里是「名称」，按字节解析会乱码 —— 网卡名改用 os.networkInterfaces()
 * 里的名字（调用方拿 primaryLanAddress 反查），不依赖 netsh 的本地化字段。
 */
export function wifiInfo() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  const now = Date.now();
  if (now - wifiCache.at < WIFI_TTL_MS) return Promise.resolve(wifiCache.value);
  return new Promise((resolve) => {
    execFile('netsh', ['wlan', 'show', 'interfaces'], { windowsHide: true, timeout: 4000 }, (err, stdout) => {
      if (err || !stdout) {
        wifiCache = { at: now, value: null };
        return resolve(null);
      }
      const ssidLine = String(stdout)
        .split(/\r?\n/)
        .find((l) => /^\s*SSID\s*:/.test(l));
      const ssid = ssidLine ? ssidLine.slice(ssidLine.indexOf(':') + 1).trim() : null;
      const value = ssid ? { ssid } : null;
      wifiCache = { at: now, value };
      resolve(value);
    });
  });
}
