/**
 * 公网地址（Cloudflare 快速隧道）。
 *
 * 为什么需要它：同一 Wi-Fi / Tailscale 都要求「两端能互相路由」，
 * 借别人家 Wi-Fi、酒店网、公司网这种场景会卡在路由上。快速隧道不需要
 * 账号，`cloudflared tunnel --url` 一跑就给一个 https 域名，手机用流量
 * 也能开。
 *
 * 代价（写进 README）：域名每次重启都变；流量走 Cloudflare 中转，
 * 比局域网慢；这只是「让外面能连进来」，配对码和 Cookie 仍然照旧。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const URL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;

/** cloudflared 在哪：显式环境变量 → PATH → 几个常见安装位置。 */
export function findCloudflared() {
  const explicit = process.env.DROPSLUICE_CLOUDFLARED;
  if (explicit && fs.existsSync(explicit)) return explicit;

  const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, exe);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {}
  }

  const guesses = process.platform === 'win32'
    ? [
        path.join(process.env.LOCALAPPDATA || '', 'cloudflared', 'cloudflared.exe'),
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'cloudflared', 'cloudflared.exe'),
        // winget 装的是 32 位 MSI，落在这里（本机实测：C:\Program Files (x86)\cloudflared）
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'cloudflared', 'cloudflared.exe'),
        path.join(process.env.ProgramW6432 || 'C:\\Program Files', 'cloudflared', 'cloudflared.exe'),
        path.join(process.env.ProgramData || 'C:\\ProgramData', 'cloudflared', 'cloudflared.exe'),
        path.join(os.homedir(), 'cloudflared', 'cloudflared.exe'),
      ]
    : ['/usr/local/bin/cloudflared', '/opt/homebrew/bin/cloudflared', '/usr/bin/cloudflared'];

  for (const p of guesses) {
    try {
      if (p && fs.statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

export function createTunnel({ exe } = {}) {
  let child = null;
  let url = null;
  let startedAt = 0;
  let lastError = null;
  const waiters = [];
  let logStream = null;

  function emit() {
    const snapshot = status();
    for (const w of waiters.splice(0)) w(snapshot);
  }

  function status() {
    return {
      supported: Boolean(exe || findCloudflared()),
      running: Boolean(child),
      url,
      startedAt,
      error: lastError,
    };
  }

  function attach(stream) {
    stream.setEncoding('utf8');
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk;
      if (logStream) logStream.write(chunk);
      if (!url) {
        const m = buf.match(URL_RE);
        if (m) {
          url = m[0].replace(/\/+$/, '');
          lastError = null;
          emit();
        }
      }
      if (buf.length > 65536) buf = buf.slice(-8192);
    });
  }

  function start({ port, logFile } = {}) {
    if (child) return Promise.resolve(status());
    const bin = exe || findCloudflared();
    if (!bin) {
      lastError = '没找到 cloudflared';
      return Promise.reject(new Error(lastError));
    }
    if (logFile) {
      try {
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        logStream = fs.createWriteStream(logFile, { flags: 'a' });
      } catch {}
    }

    const token = process.env.DROPSLUICE_TUNNEL_TOKEN;
    const args = token
      ? ['tunnel', '--no-autoupdate', 'run', '--token', token]
      : ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`];

    startedAt = Date.now();
    lastError = null;
    url = process.env.DROPSLUICE_TUNNEL_URL || null;
    // 自测/调试时允许指一个 .mjs 假隧道：这种就用 node 来跑它
    const asScript = /\.(mjs|cjs|js)$/i.test(bin);
    const cmd = asScript ? process.execPath : bin;
    const argv = asScript ? [bin, ...args] : args;
    child = spawn(cmd, argv, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    attach(child.stdout);
    attach(child.stderr);
    child.on('exit', (code) => {
      if (code !== 0 && !url) lastError = `cloudflared 退出，代码 ${code}`;
      child = null;
      url = null;
      emit();
    });
    child.on('error', (err) => {
      lastError = String(err && err.message ? err.message : err);
      child = null;
      emit();
    });

    // 最多等 30 秒拿域名；拿不到就把进程留着（可能只是慢）
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(), 30000);
      const waiter = () => {
        if (!url) return;
        clearTimeout(timer);
        done();
      };
      function done() {
        clearTimeout(timer);
        const i = waiters.indexOf(waiter);
        if (i >= 0) waiters.splice(i, 1);
        resolve(status());
      }
      if (url) return done();
      waiters.push(waiter);
    });
  }

  function stop() {
    if (!child) {
      url = null;
      return status();
    }
    try {
      child.kill();
    } catch {}
    child = null;
    url = null;
    startedAt = 0;
    return status();
  }

  return { start, stop, status };
}
