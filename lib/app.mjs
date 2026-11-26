/**
 * DropSluice 服务端核心。
 *
 * 只干一件事：把电脑上的文件，原样（0 压缩、字节完全一致）通过局域网发给已配对的手机。
 *
 * 路由一览
 *   页面   /            已配对 → 文件浏览页；未配对 → 配对页
 *          /pair        配对页（手机扫码后落在这里）
 *   静态   /style.css /app.js /pair.js
 *   配对   GET  /qr.svg           只在"本机回环地址"能取到，防止局域网里别人偷扫
 *          GET  /api/pairing     同上，返回配对状态/配对码/局域网地址
 *          POST /api/pair        用配对码换设备令牌（6 位码，限速）
 *   数据   GET  /api/me
 *          GET  /api/roots       盘符 + 常用目录
 *          GET  /api/list?path=  列目录
 *          GET  /api/download?path=   下载文件（支持 Range）
 *          GET  /api/zip?path=        打包下载整个文件夹（store，不压缩）
 *          POST /api/upload?path=     手机传文件回电脑
 *          POST /api/unpair           注销本机
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createTransfers } from './transfers.mjs';
import { createHistory } from './history.mjs';

import * as store from './state.mjs';
import { lanAddresses, primaryLanAddress, isLoopback, normalizeIp, interfaceForLocal, isPrivateIp, wifiInfo, isTailnetIp, tailscaleInfo } from './net.mjs';
import { describeDevice } from './ua.mjs';
import { lookupPlace } from './geo.mjs';
import { drives, shortcuts, listDir, resolveUserPath, mimeOf } from './files.mjs';
import { zipDirectory, zipPaths } from './zip.mjs';
import { qrSvg } from './qr.mjs';

import { appRoot } from './root.mjs';

const PUBLIC_DIR = path.join(appRoot(), 'public');
const DESKTOP_DIR = path.join(appRoot(), 'desktop');
const COOKIE = 'pd_session';

/**
 * 手机端只认 App。
 *
 * App 的 WebView 会在自己的 UA 后面追加 `DropSluice/1.0`（见 android 的 BuildConfig.UA_TAG），
 * 手机浏览器没有这个标记 —— 所以"像手机 + 没有标记"就等于"有人拿浏览器直接开"，
 * 这种情况不给网页，只给一页「请装 App」的引导。
 */
const APP_UA = /DropSluice\/\d/i;
const MOBILE_UA = /Android|iPhone|iPad|iPod|Mobile|HarmonyOS|MicroMessenger|MiuiBrowser|HuaweiBrowser/i;
// 引导页自身要用的静态资源：拦了它们，403 页面就没样式、按钮也就点不出安装包
const GATE_EXEMPT = new Set(['/apk', '/style.css']);

export function isMobileBrowser(ua) {
  if (!ua) return false;
  return MOBILE_UA.test(ua) && !APP_UA.test(ua);
}

/**
 * 找随程序放的安装包（引导页上的下载按钮要用）。
 * 顺序：DROPSLUICE_APK 指定的文件 → 程序目录 → 程序目录/dist。
 */
function findApk() {
  const dirs = [];
  if (process.env.DROPSLUICE_APK) {
    const p = path.resolve(process.env.DROPSLUICE_APK);
    if (fs.existsSync(p)) return { path: p, name: path.basename(p) };
  }
  dirs.push(path.dirname(process.execPath), appRoot(), path.join(appRoot(), 'dist'));
  for (const dir of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const hit = names.find((n) => /^DropSluice-[\d.]+\.apk$/i.test(n));
    if (hit) return { path: path.join(dir, hit), name: hit };
  }
  return null;
}

// ---------- 小工具 ----------
function send(res, status, headers, body) {
  res.writeHead(status, headers);
  if (body === undefined) return res.end();
  res.end(body);
}

function json(res, status, value, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  send(res, status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  }, body);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function tokenFrom(req) {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  return parseCookies(req.headers.cookie)[COOKIE] || null;
}

async function readJsonBody(req, limit = 1 << 20) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('请求体过大'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('JSON 解析失败'), { status: 400 });
  }
}

function fileSection(req) {
  // /api/download?path=... → { api: 'download', ... }
  const host = req.headers.host || 'localhost';
  const url = new URL(req.url, `http://${host}`);
  return { url, query: url.searchParams };
}

function contentDisposition(name, inline = false) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const kind = inline ? 'inline' : 'attachment';
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** 预览能直接渲染的类型；其它类型交回「下载／用别的应用打开」 */
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif', '.svg', '.heic', '.heif']);
const PDF_EXT = new Set(['.pdf']);
const OFFICE_EXT = new Set(['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx']);
const TEXT_EXT = new Set(['.txt', '.md', '.json', '.log', '.csv', '.ini', '.yml', '.yaml', '.xml', '.html', '.css', '.js', '.mjs', '.ts']);

function previewKind(name) {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (PDF_EXT.has(ext)) return 'pdf';
  if (OFFICE_EXT.has(ext)) return 'office';
  if (TEXT_EXT.has(ext)) return 'text';
  return 'other';
}

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m) return null;
  let start = m[1] === '' ? null : Number(m[1]);
  let end = m[2] === '' ? null : Number(m[2]);
  if (start === null && end === null) return null;
  if (start === null) {
    start = Math.max(0, size - end);
    end = size - 1;
  } else if (end === null || end >= size) {
    end = size - 1;
  }
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}

async function statOrNull(p) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

// ---------- 主体 ----------

/**
 * 面板/管理接口只能本机访问。
 * 光看 remoteAddress 还不够：浏览器插件、手机投屏、反代都可能把请求"从本机"转发进来，
 * 所以同时要求 Host 头就是回环地址（反代通常会把 Host 改写成局域网地址）。
 */
function isLoopbackRequest(req, ip) {
  if (!isLoopback(ip)) return false;
  const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  if (req.headers['x-forwarded-host'] || req.headers['x-forwarded-for']) return false;
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1' || host === '';
}

/**
 * 设备清单的"富信息"版本：IP、从哪块网卡进来（无线的话带 Wi-Fi 名）、
 * 这看起来是台什么设备；公网 IP 再补一个归属地（失败不影响返回）。
 */
async function enrichDevices(lan) {
  const wifi = await wifiInfo();
  const lanIface = interfaceForLocal(lan);
  const rows = store.describeDevices();
  return Promise.all(
    rows.map(async (d) => {
      // Tailscale 的 100.64/10 是私有段，但语义上不是"局域网"——它是"同一个 Tailnet"，
      // 手机用流量也是从这个地址进来的，面板上要能一眼区分。
      const tailnet = d.ip ? isTailnetIp(d.ip) : false;
      const priv = d.ip ? isPrivateIp(d.ip) : null;
      let location = null;
      if (d.ip && priv === false && !tailnet) {
        location = await lookupPlace(d.ip);
      }
      const onWifi = Boolean(wifi?.ssid && lanIface && d.iface === lanIface);
      return {
        ...d,
        client: describeDevice(d.userAgent),
        network: {
          kind: tailnet ? 'tailnet' : priv === null ? 'unknown' : priv ? 'lan' : 'public',
          iface: d.iface ?? null,
          ssid: onWifi ? wifi.ssid : null,
        },
        location,
      };
    }),
  );
}

/**
 * 手机传文件回电脑的默认上限。20 GB 级的视频/压缩包要传得动，
 * 所以给到 32 GiB；嫌大可以设 DROPSLUICE_MAX_UPLOAD_MB 调小/调大。
 */
const DEFAULT_MAX_UPLOAD = 32 * 1024 ** 3;
/** 断点续传的块大小：8 MiB。手机端按这个切，服务端按同一份节奏追加。 */
const CHUNK_UPLOAD = 8 * 1024 * 1024;

export function createDropSluice({
  log = () => {},
  assets = null,
  onQuit = null,
  maxUploadBytes = DEFAULT_MAX_UPLOAD,
} = {}) {
  /** 配对尝试限速：每个 IP 5 分钟内最多 5 次错码 */
  const attempts = new Map();

  function tooManyAttempts(ip) {
    const now = Date.now();
    const rec = attempts.get(ip);
    if (!rec || now > rec.resetAt) {
      attempts.set(ip, { n: 0, resetAt: now + 5 * 60 * 1000 });
      return false;
    }
    return rec.n >= 5;
  }

  function noteAttempt(ip, ok) {
    const rec = attempts.get(ip) ?? { n: 0, resetAt: Date.now() + 5 * 60 * 1000 };
    if (ok) attempts.delete(ip);
    else {
      rec.n += 1;
      attempts.set(ip, rec);
    }
  }

  function pairUrl() {
    const lan = primaryLanAddress();
    const pair = store.currentPairing();
    if (!lan || !pair) return null;
    return `http://${lan}:${state.port}/pair?c=${pair.code}`;
  }

  /** 手机用流量也能扫的那张码（走 Tailscale 的 100.x 地址）；没登录就返回 null。 */
  function tailnetPairUrl() {
    const ts = tailscaleInfo();
    const pair = store.currentPairing();
    if (!ts.up || !ts.ip || !pair) return null;
    return `http://${ts.ip}:${state.port}/pair?c=${pair.code}`;
  }

  /** 把文件流写回响应，同时登记到「正在传」里（面板/手机用它显示文件名和速率）。 */
  function streamDownload(stream, res, name, total, ip) {
    const id = transfers.start({ kind: 'download', name, total, ip });
    stream.on('data', (chunk) => transfers.add(id, chunk.length));
    stream.on('error', () => transfers.end(id, { failed: true }));
    res.on('close', () => transfers.end(id));
    return pipeline(stream, res).catch(() => {});
  }

  /**
   * 目标盘够不够写。够了返回 null；不够返回「还差多少字节」。
   * 留 64 MB 给系统——别把盘写满到连临时文件都开不出来。
   * 拿不到 statfs（老系统/异常）时当作够：检查本身不该成为失败原因。
   */
  async function spaceShortfall(dir, need) {
    if (!Number.isFinite(need) || need <= 0) return null;
    try {
      const st = await fsp.statfs(dir);
      const free = Number(st.bavail) * Number(st.bsize);
      const reserve = 64 * 1024 * 1024;
      return need + reserve > free ? Math.round(need + reserve - free) : null;
    } catch {
      return null;
    }
  }

  function gbText(bytes) {
    return `${Math.round((bytes / 1024 ** 3) * 10) / 10} GB`;
  }

  const state = {
    port: 18888,
    host: '0.0.0.0',
    server: null,
  };

  // 传完之后留一条记录（下载页的「历史」就是它）
  const history = createHistory({ file: path.join(store.dataDir(), 'history.json') });

  // 正在传的文件（内存里，给面板和手机页面轮询用）
  const transfers = createTransfers({ onEnd: (entry) => history.add(entry) });
  /** 分块上传的「这一轮的传输条目」：id → transfers 里的 transferId（跨块复用，断点后重建） */
  const uploadEntry = new Map();

  /**
   * 发一个静态文件。
   * 打包成单文件 exe 时磁盘上没有 public/ 目录，文件内容由 SEA assets 提供；
   * 源码运行时才去读磁盘（先 public/，再 desktop/，面板页放在 desktop/ 下）。
   */
  function serveStatic(res, file, type, status = 200) {
    let buf = null;
    if (assets && Object.prototype.hasOwnProperty.call(assets, file)) {
      buf = Buffer.from(assets[file], 'utf8');
    } else {
      for (const dir of [PUBLIC_DIR, DESKTOP_DIR]) {
        try {
          buf = fs.readFileSync(path.join(dir, file));
          break;
        } catch {
          // 继续找下一个目录
        }
      }
    }
    if (!buf) {
      return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found');
    }
    send(res, status, {
      'Content-Type': type,
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache',
    }, buf);
  }

  async function handle(req, res) {
    const { url, query } = fileSection(req);
    const p = url.pathname;
    const ip = normalizeIp(req.socket.remoteAddress);
    const iface = interfaceForLocal(req.socket.localAddress);
    const userAgent = req.headers['user-agent'] ?? null;
    const loopback = isLoopback(ip);
    const device = store.findDevice(tokenFrom(req));
    const authed = Boolean(device);
    if (device) store.touchDevice(device.id, { ip, iface, userAgent });

    // 统一的安全响应头
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');

    // ---- 手机端只认 App ----
    // 拿手机浏览器直接开网页的，一律给引导页（403）；App 的 WebView 带 DropSluice/<版本>，照常放行。
    // 本机回环（电脑自己的浏览器、自测脚本）不受影响。
    // 例外：引导页自己要用的东西（样式表、安装包）必须放行，否则 403 页面是裸的，
    // 引导页上那个「下载安装包」按钮也点不出东西。
    if (!GATE_EXEMPT.has(p) && !loopback && isMobileBrowser(userAgent)) {
      return serveStatic(res, 'need-app.html', 'text/html; charset=utf-8', 403);
    }

    // ---- 页面 ----
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      if (!authed) return res.writeHead(302, { Location: '/pair' }).end();
      return serveStatic(res, 'index.html', 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && p === '/pair') {
      if (authed) return res.writeHead(302, { Location: '/' }).end();
      return serveStatic(res, 'pair.html', 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && p === '/style.css') return serveStatic(res, 'style.css', 'text/css; charset=utf-8');
    if (req.method === 'GET' && p === '/app.js') return serveStatic(res, 'app.js', 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && (p === '/downloads' || p === '/downloads.html')) {
      if (!authed) return res.writeHead(302, { Location: '/pair' }).end();
      return serveStatic(res, 'downloads.html', 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && p === '/downloads.js') return serveStatic(res, 'downloads.js', 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && (p === '/preview' || p === '/preview.html')) {
      if (!authed) return res.writeHead(302, { Location: '/pair' }).end();
      return serveStatic(res, 'preview.html', 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && p === '/preview.js') return serveStatic(res, 'preview.js', 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && p === '/pdfjs/pdf.min.mjs') {
      return serveStatic(res, 'pdfjs/pdf.min.mjs', 'text/javascript; charset=utf-8');
    }
    if (req.method === 'GET' && p === '/pdfjs/pdf.worker.min.mjs') {
      return serveStatic(res, 'pdfjs/pdf.worker.min.mjs', 'text/javascript; charset=utf-8');
    }
    if (req.method === 'GET' && p === '/pair.js') return serveStatic(res, 'pair.js', 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && p === '/manifest.webmanifest') {
      return json(res, 200, {
        name: 'DropSluice',
        short_name: 'DropSluice',
        start_url: '/',
        display: 'standalone',
        background_color: '#0f1115',
        theme_color: '#0f1115',
      }, { 'Content-Type': 'application/manifest+json' });
    }

    // 装 App 用的安装包：引导页上的「下载安装包」按钮指向这里。
    // 找不到就明确说没有，别让手机点出一个 200 的 HTML。
    if ((req.method === 'GET' || req.method === 'HEAD') && p === '/apk') {
      const apk = findApk();
      if (!apk) {
        return json(res, 404, {
          error: 'apk_missing',
          message: '这台电脑旁边没放安装包。把 DropSluice-<版本>.apk 放到程序目录（或 dist/），或者设 DROPSLUICE_APK 指向它。',
        });
      }
      const stat = fs.statSync(apk.path);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(apk.name)}`,
        'Cache-Control': 'no-store, no-transform',
      });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(apk.path).pipe(res);
    }

    // ---- 配对相关 ----
    if (req.method === 'GET' && p === '/qr.svg') {
      if (!loopback) return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found');
      // ?target=remote → Tailscale 那条（同一个虚拟局域网）
      const target = url.searchParams.get('target');
      const u = target === 'remote' ? tailnetPairUrl() : pairUrl();
      if (!u) {
        const why = target === 'remote' ? 'Tailscale 没连上' : '配对窗口未打开';
        return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, why);
      }
      const svg = qrSvg(u, { size: 512, margin: 4, dark: '#000000', light: '#ffffff' });
      return send(res, 200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Content-Length': Buffer.byteLength(svg), 'Cache-Control': 'no-store' }, svg);
    }

    if (req.method === 'GET' && p === '/api/pairing') {
      if (!loopback) return json(res, 403, { error: 'only_from_this_pc' });
      const pair = store.currentPairing();
      const lan = primaryLanAddress();
      return json(res, 200, {
        open: Boolean(pair),
        code: pair?.code ?? null,
        expiresAt: pair?.expiresAt ?? null,
        url: pairUrl(),
        lan,
        addresses: lanAddresses(),
      });
    }

    if (req.method === 'POST' && p === '/api/pairing/open') {
      if (!loopback) return json(res, 403, { error: 'only_from_this_pc' });
      const pair = store.openPairing();
      log(`配对窗口已打开，配对码 ${pair.code}`);
      const lan = primaryLanAddress();
      return json(res, 200, { open: true, code: pair.code, expiresAt: pair.expiresAt, url: pairUrl(), lan });
    }

    // ---- 桌面面板（浏览器里打开的那个窗口）----
    if (req.method === 'GET' && (p === '/desktop' || p === '/desktop.html')) {
      if (!isLoopbackRequest(req, ip)) {
        return send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' },
          '这个页面只能在电脑本机打开');
      }
      return serveStatic(res, 'desktop.html', 'text/html; charset=utf-8');
    }

    // ---- 桌面面板的管理接口（同样只允许本机）----
    if (p.startsWith('/api/admin/')) {
      if (!isLoopbackRequest(req, ip)) return json(res, 403, { error: 'only_from_this_pc' });

      const snapshot = async () => {
        const lan = primaryLanAddress();
        const pair = store.currentPairing();
        const ts = tailscaleInfo();
        return {
          running: true,
          port: state.port,
          lan,
          url: lan ? `http://${lan}:${state.port}/` : null,
          addresses: lanAddresses(),
          // 手机用流量 / 连别的 Wi-Fi 时走这条（Tailscale 组网）；没装或没登录就是 up:false
          tailnet: {
            up: Boolean(ts.up),
            ip: ts.ip,
            dnsName: ts.dnsName,
            url: ts.up ? `http://${ts.ip}:${state.port}/` : null,
            pairUrl: ts.up && pair ? `http://${ts.ip}:${state.port}/pair?c=${pair.code}` : null,
          },
          pairing: {
            open: Boolean(pair),
            code: pair?.code ?? null,
            expiresAt: pair?.expiresAt ?? null,
            url: pair && lan ? `http://${lan}:${state.port}/pair?c=${pair.code}` : null,
          },
          devices: await enrichDevices(lan),
        };
      };

      if (req.method === 'GET' && p === '/api/admin/state') return json(res, 200, await snapshot());
      if (req.method === 'GET' && p === '/api/admin/transfers') return json(res, 200, { transfers: transfers.list() });

      if (req.method === 'POST' && p === '/api/admin/pair') {
        const pair = store.openPairing();
        log(`配对窗口已打开，配对码 ${pair.code}`);
        return json(res, 200, await snapshot());
      }

      if (req.method === 'POST' && p === '/api/admin/revoke') {
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          return json(res, 400, { error: 'bad_body' });
        }
        const target = body?.id
          ? store.describeDevices().find((d) => d.id === body.id)
          : null;
        const gone = body?.id ? store.revokeDevice(body.id) : false;
        if (!gone) return json(res, 404, { error: 'no_such_device' });
        log(`已解除设备：${target?.name || body.id}`);
        return json(res, 200, await snapshot());
      }

      if (req.method === 'POST' && p === '/api/admin/quit') {
        json(res, 200, { ok: true });
        // 先把响应发出去，再关进程，否则浏览器看到的是连接被重置
        setTimeout(() => (onQuit ? onQuit() : process.exit(0)), 80);
        return;
      }

      return json(res, 404, { error: 'no_such_api' });
    }

    if (req.method === 'POST' && p === '/api/pair') {
      if (tooManyAttempts(ip)) return json(res, 429, { error: 'too_many_attempts' });
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return json(res, err.status ?? 400, { error: 'bad_body' });
      }
      const result = store.pairDevice(body.code, body.name, { ip, iface, userAgent });
      if (result.error) {
        // 只有"码不对"算失败尝试；窗口过期/已关闭不算，免得用户白等 5 分钟
        if (result.error === 'bad_code') noteAttempt(ip, false);
        const messages = {
          pairing_closed: '配对窗口没打开，请在电脑上重新生成二维码',
          code_expired: '配对码已过期，请在电脑上重新生成',
          bad_code: '配对码不对',
        };
        return json(res, 403, { error: result.error, message: messages[result.error] ?? '配对失败' });
      }
      noteAttempt(ip, true);
      log(`新设备已配对：${body.name || '未命名设备'} (${ip})`);
      return json(res, 200, { ok: true, deviceId: result.deviceId }, {
        'Set-Cookie': `${COOKIE}=${encodeURIComponent(result.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}`,
      });
    }

    // ---- 以下都需要令牌 ----
    if (p.startsWith('/api/') && !authed) return json(res, 401, { error: 'unauthorized' });

    if (req.method === 'GET' && p === '/api/transfers') {
      return json(res, 200, { transfers: transfers.list(), active: transfers.active() });
    }

    if (req.method === 'GET' && p === '/api/history') {
      return json(res, 200, { history: history.list() });
    }

    if (req.method === 'GET' && p === '/api/me') {
      return json(res, 200, {
        paired: true,
        device: { id: device.id, name: device.name },
        ip,
        private: isPrivateIp(ip),
        client: describeDevice(userAgent),
      host: os.hostname(),
      });
    }

    if (req.method === 'POST' && p === '/api/unpair') {
      store.revokeDevice(device.id);
      return json(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` });
    }

    if (req.method === 'GET' && p === '/api/roots') {
      return json(res, 200, {
        platform: process.platform,
        home: process.env.USERPROFILE || process.env.HOME || '',
        drives: drives(),
        shortcuts: shortcuts(),
        hostname: (await import('node:os')).hostname(),
      });
    }

    if (req.method === 'GET' && p === '/api/list') {
      const raw = query.get('path');
      if (!raw) {
        return json(res, 200, { path: null, parent: null, entries: [], roots: true });
      }
      let dir;
      try {
        dir = resolveUserPath(raw);
      } catch (err) {
        return json(res, 400, { error: 'bad_path', message: err.message });
      }
      try {
        const listing = await listDir(dir);
        return json(res, 200, listing);
      } catch (err) {
        const code = err.code === 'ENOENT' ? 404 : err.code === 'EACCES' || err.code === 'EPERM' ? 403 : 400;
        return json(res, code, { error: err.code ?? 'error', message: err.message, path: dir });
      }
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && p === '/api/preview-info') {
      let abs;
      try {
        abs = resolveUserPath(query.get('path'));
      } catch (err) {
        return json(res, 400, { error: 'bad_path', message: err.message });
      }
      const st = await statOrNull(abs);
      if (!st) return json(res, 404, { error: 'not_found', path: abs });
      const name = path.basename(abs) || abs;
      return json(res, 200, {
        name,
        path: abs,
        size: st.size,
        isDirectory: st.isDirectory(),
        kind: st.isDirectory() ? 'dir' : previewKind(name),
        mtime: st.mtimeMs,
      });
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && p === '/api/download') {
      const raw = query.get('path');
      let abs;
      try {
        abs = resolveUserPath(raw);
      } catch (err) {
        return json(res, 400, { error: 'bad_path', message: err.message });
      }
      const st = await statOrNull(abs);
      if (!st) return json(res, 404, { error: 'not_found', path: abs });
      if (st.isDirectory()) return json(res, 400, { error: 'is_directory', message: '文件夹请用 /api/zip' });
      if (!st.isFile()) return json(res, 400, { error: 'not_a_file' });

      const name = path.basename(abs);
      const inline = query.get('inline') === '1';
      const headers = {
        'Content-Type': mimeOf(abs),
        'Content-Disposition': contentDisposition(name, inline),
        'Accept-Ranges': 'bytes',
        // 关键：告诉中间层别转码/压缩，保证收到的是原文件字节
        'Cache-Control': 'no-store, no-transform',
        'X-Content-Type-Options': 'nosniff',
      };

      const range = parseRange(req.headers.range, st.size);
      if (range === 'invalid') {
        return send(res, 416, { 'Content-Range': `bytes */${st.size}` }, '');
      }
      if (range) {
        const { start, end } = range;
        headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
        headers['Content-Length'] = end - start + 1;
        res.writeHead(206, headers);
        if (req.method === 'HEAD') return res.end();
        return streamDownload(fs.createReadStream(abs, { start, end }), res, name, end - start + 1, ip);
      }

      headers['Content-Length'] = st.size;
      res.writeHead(200, headers);
      if (req.method === 'HEAD') return res.end();
      return streamDownload(fs.createReadStream(abs), res, name, st.size, ip);
    }

    if (req.method === 'GET' && p === '/api/zip') {
      let abs;
      try {
        abs = resolveUserPath(query.get('path'));
      } catch (err) {
        return json(res, 400, { error: 'bad_path', message: err.message });
      }
      const st = await statOrNull(abs);
      if (!st) return json(res, 404, { error: 'not_found' });
      if (!st.isDirectory()) return json(res, 400, { error: 'not_a_directory' });

      const name = path.basename(abs) || 'root';
      const zipName = `${name}.zip`;
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': contentDisposition(zipName),
        'Cache-Control': 'no-store, no-transform',
        'Transfer-Encoding': 'chunked',
      });
      try {
        const zipId = transfers.start({ kind: 'zip', name: zipName, total: 0, ip });
        res.on('close', () => transfers.end(zipId));
        for await (const chunk of zipDirectory(abs, name)) {
          transfers.add(zipId, chunk.length);
          if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
        }
        transfers.end(zipId);
      } catch (err) {
        log(`打包失败：${err.message}`);
      }
      return res.end();
    }

    // 勾选多个文件/文件夹 → 打一个 zip 流回去（和单个文件夹打包同一条代码路径）
    if (req.method === 'GET' && p === '/api/download-many') {
      const raw = query.getAll('p').filter(Boolean);
      if (raw.length === 0) return json(res, 400, { error: 'no_items', message: '没有选中任何文件' });
      if (raw.length > 200) return json(res, 400, { error: 'too_many', message: '一次最多选 200 项' });

      const items = [];
      for (const r of raw) {
        let abs;
        try {
          abs = resolveUserPath(r);
        } catch (err) {
          return json(res, 400, { error: 'bad_path', message: err.message });
        }
        const st = await statOrNull(abs);
        if (!st) return json(res, 404, { error: 'not_found', message: `找不到：${path.basename(abs) || r}` });
        items.push({ abs, name: path.basename(abs) || 'root', isDirectory: st.isDirectory() });
      }

      const stamp = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const zipName = items.length === 1 && !items[0].isDirectory
        ? items[0].name
        : `所选 ${items.length} 项 ${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}.zip`;

      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': contentDisposition(zipName),
        'Cache-Control': 'no-store, no-transform',
        'Transfer-Encoding': 'chunked',
      });
      try {
        const zipId = transfers.start({ kind: 'zip', name: zipName, total: 0, ip });
        res.on('close', () => transfers.end(zipId));
        for await (const chunk of zipPaths(items)) {
          transfers.add(zipId, chunk.length);
          if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
        }
        transfers.end(zipId);
      } catch (err) {
        log(`打包（多选）失败：${err.message}`);
      }
      return res.end();
    }

    if (req.method === 'POST' && p === '/api/upload') {
      let dir;
      try {
        dir = resolveUserPath(query.get('path'));
      } catch (err) {
        return json(res, 400, { error: 'bad_path', message: err.message });
      }
      const st = await statOrNull(dir);
      if (!st?.isDirectory()) return json(res, 400, { error: 'not_a_directory' });

      let name;
      try {
        name = decodeURIComponent(req.headers['x-file-name'] || '');
      } catch {
        name = '';
      }
      name = path.basename(name || '');
      if (!name || name === '.' || name === '..') return json(res, 400, { error: 'bad_name' });

      const ext = path.extname(name);
      const base = path.basename(name, ext);
      let target = path.join(dir, name);
      for (let i = 1; (await statOrNull(target)) && i < 1000; i++) {
        target = path.join(dir, `${base} (${i})${ext}`);
      }

      // 上传大小上限：手机端乱传/恶意占满磁盘的兜底。
      // 先看 Content-Length 直接拒（省得白传一遍），再看实际写入字节数兜底 chunked 上传。
      const limitText = `${Math.round((maxUploadBytes / 1024 ** 3) * 10) / 10} GB`;
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxUploadBytes) {
        req.resume();
        return json(res, 413, {
          error: 'too_large',
          limit: maxUploadBytes,
          message: `文件太大（上限 ${limitText}）`,
        });
      }
      // 盘不够就别白传：先看余量
      if (Number.isFinite(declared) && declared > 0) {
        const short = await spaceShortfall(dir, declared);
        if (short) {
          req.resume();
          return json(res, 507, {
            error: 'no_space',
            shortfall: short,
            message: `目标盘空间不够，还差 ${gbText(short)}`,
          });
        }
      }

      let written = 0;
      const upId = transfers.start({
        kind: 'upload',
        name: path.basename(target),
        total: Number.isFinite(declared) && declared > 0 ? declared : 0,
        ip,
      });
      res.on('close', () => transfers.end(upId));
      const limiter = new Transform({
        transform(chunk, _enc, cb) {
          written += chunk.length;
          transfers.add(upId, chunk.length);
          if (written > maxUploadBytes) {
            return cb(Object.assign(new Error(`文件超过 ${limitText} 上限`), { code: 'TOO_LARGE' }));
          }
          cb(null, chunk);
        },
      });

      try {
        await pipeline(req, limiter, fs.createWriteStream(target));
        transfers.end(upId);
      } catch (err) {
        transfers.end(upId, { failed: true });
        await fsp.rm(target, { force: true }).catch(() => {});
        if (err?.code === 'TOO_LARGE') {
          req.destroy();
          return json(res, 413, { error: 'too_large', limit: maxUploadBytes, message: err.message });
        }
        return json(res, 500, { error: 'write_failed', message: err.message });
      }
      const out = await fsp.stat(target);
      return json(res, 200, { ok: true, path: target, size: out.size });
    }

    // ---- 分块上传（断点续传）----
    // 三件事：问断点（GET）、传一块（PUT）、收尾（POST done）。临时块按「目标目录+文件名+大小」
    // 的哈希命名，所以服务端重启、手机换 Wi-Fi、App 被切后台，只要再问一次断点就能接着传。
    if (p.startsWith('/api/upload/resume')) {
      let rdir;
      try {
        rdir = resolveUserPath(query.get('path'));
      } catch (err) {
        return json(res, 400, { error: 'bad_path', message: err.message });
      }
      if (!(await statOrNull(rdir))?.isDirectory()) return json(res, 400, { error: 'not_a_directory' });

      let rname;
      try {
        rname = decodeURIComponent(req.headers['x-file-name'] || query.get('name') || '');
      } catch {
        rname = '';
      }
      rname = path.basename(rname || '');
      if (!rname || rname === '.' || rname === '..') return json(res, 400, { error: 'bad_name' });

      const total = Number(query.get('size'));
      if (!Number.isFinite(total) || total <= 0) return json(res, 400, { error: 'bad_size' });
      const limitGB = `${Math.round((maxUploadBytes / 1024 ** 3) * 10) / 10} GB`;
      if (total > maxUploadBytes) {
        return json(res, 413, { error: 'too_large', limit: maxUploadBytes, message: `文件太大（上限 ${limitGB}）` });
      }

      const id = crypto.createHash('sha1').update(`${rdir}\u0000${rname}\u0000${total}`).digest('hex').slice(0, 32);
      const partDir = path.join(store.dataDir(), 'uploads');      await fsp.mkdir(partDir, { recursive: true });
      const part = path.join(partDir, `${id}.part`);
      const have = (await statOrNull(part))?.size ?? 0;

      if (p === '/api/upload/resume' && req.method === 'GET') {
        // 盘不够就别让它白传 20 GB：先算余量（留 64 MB 给系统）
        const short = await spaceShortfall(rdir, total - have);
        if (short) {
          return json(res, 507, {
            error: 'no_space',
            shortfall: short,
            message: `目标盘空间不够，还差 ${gbText(short)}`,
          });
        }
        // 断点：客户端拿这个 offset 接着传；没有临时块就是 0
        return json(res, 200, { id, offset: have, size: total, chunkSize: CHUNK_UPLOAD });
      }

      if (p === '/api/upload/resume' && req.method === 'DELETE') {
        await fsp.rm(part, { force: true });
        const tid = uploadEntry.get(id);
        if (tid) { transfers.end(tid, { failed: true }); uploadEntry.delete(id); }
        return json(res, 200, { ok: true });
      }

      if (p === '/api/upload/resume/chunk' && req.method === 'PUT') {
        const at = Number(query.get('offset'));
        if (!Number.isFinite(at) || at < 0) return json(res, 400, { error: 'bad_offset' });
        // 断点必须严丝合缝：客户端以为的偏移和服务端文件大小不一致时，让它按服务端的来
        if (at !== have) return json(res, 409, { error: 'offset_mismatch', offset: have, size: total });

        let got = 0;
        // 面板/手机底部要能看到「正在传哪个文件、多快」：第一块建条目，后面按块累加
        let tid = uploadEntry.get(id);
        if (!tid) {
          tid = transfers.start({ kind: 'upload', name: rname, total, ip });
          uploadEntry.set(id, tid);
        }
        const chunkLimit = new Transform({
          transform(chunk, _enc, cb) {
            got += chunk.length;
            transfers.add(tid, chunk.length);
            if (have + got > total) {
              return cb(Object.assign(new Error('这一块超过声明的文件大小'), { code: 'CHUNK_TOO_BIG' }));
            }
            cb(null, chunk);
          },
        });

        try {
          await pipeline(req, chunkLimit, fs.createWriteStream(part, { flags: 'a' }));
        } catch (err) {
          if (err?.code === 'CHUNK_TOO_BIG') {
            req.destroy();
            const tid = uploadEntry.get(id);
            if (tid) { transfers.end(tid, { failed: true }); uploadEntry.delete(id); }
            return json(res, 400, { error: 'chunk_too_big', offset: (await statOrNull(part))?.size ?? 0 });
          }
          return json(res, 500, { error: 'write_failed', message: err.message });
        }
        const now = (await statOrNull(part))?.size ?? 0;
        return json(res, 200, { id, offset: now, size: total });
      }

      if (p === '/api/upload/resume/done' && req.method === 'POST') {
        const got = (await statOrNull(part))?.size ?? 0;
        if (got !== total) return json(res, 409, { error: 'incomplete', offset: got, size: total });

        const ext = path.extname(rname);
        const base = path.basename(rname, ext);
        let target = path.join(rdir, rname);
        for (let i = 1; (await statOrNull(target)) && i < 1000; i++) {
          target = path.join(rdir, `${base} (${i})${ext}`);
        }
        try {
          await fsp.rename(part, target);
        } catch {
          // 跨盘（临时目录和目标不在同一个盘）时 rename 会 EXDEV，退回复制+删除
          await fsp.copyFile(part, target);
          await fsp.rm(part, { force: true });
        }
        const out = await fsp.stat(target);
        const tid = uploadEntry.get(id);
        if (tid) { transfers.end(tid); uploadEntry.delete(id); }
        return json(res, 200, { ok: true, path: target, size: out.size });
      }

      return json(res, 404, { error: 'no_such_api' });
    }

    if (p.startsWith('/api/')) return json(res, 404, { error: 'no_such_api' });
    return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log(`请求出错 ${req.method} ${req.url}: ${err?.stack || err}`);
      if (!res.headersSent) json(res, 500, { error: 'internal', message: String(err?.message || err) });
      else res.end();
    });
  });
  server.on('connection', (socket) => socket.setNoDelay(true));

  return {
    server,
    transfers,
    get port() { return state.port; },
    set port(v) { state.port = v; },
    get host() { return state.host; },
    set host(v) { state.host = v; },
  };
}

/** 启动服务；返回 { port, url, startPairing, close }。 */
export async function startDropSluice({
  port = 18888,
  host = '0.0.0.0',
  openPairing = true,
  log = () => {},
  assets = null,
  onQuit = null,
  maxUploadBytes = Number(process.env.DROPSLUICE_MAX_UPLOAD_MB || 0) * 1024 ** 2 || DEFAULT_MAX_UPLOAD,
} = {}) {
  const app = createDropSluice({ log, assets, onQuit, maxUploadBytes });
  app.port = port;
  app.host = host;

  if (openPairing) store.openPairing();

  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(port, host, () => resolve());
  });

  const lan = primaryLanAddress();

  return {
    port,
    lan,
    get url() {
      return lan ? `http://${lan}:${port}/` : null;
    },
    startPairing: () => {
      const pair = store.openPairing();
      return {
        ...pair,
        url: lan ? `http://${lan}:${port}/pair?c=${pair.code}` : null,
        lan,
        qrSvg: lan ? qrSvg(`http://${lan}:${port}/pair?c=${pair.code}`, { size: 512, margin: 4 }) : null,
      };
    },
    pairingInfo: () => {
      const pair = store.currentPairing();
      const ts = tailscaleInfo();
      return {
        open: Boolean(pair),
        code: pair?.code ?? null,
        expiresAt: pair?.expiresAt ?? null,
        url: lan && pair ? `http://${lan}:${port}/pair?c=${pair.code}` : null,
        qrSvg: lan && pair ? qrSvg(`http://${lan}:${port}/pair?c=${pair.code}`, { size: 512 }) : null,
        // 手机用流量也能连的那条线（Tailscale）；没装/没登录时 up 为 false
        tailnet: {
          up: Boolean(ts.up),
          ip: ts.ip,
          dnsName: ts.dnsName,
          url: ts.up ? `http://${ts.ip}:${port}/` : null,
          pairUrl: ts.up && pair ? `http://${ts.ip}:${port}/pair?c=${pair.code}` : null,
        },
      };
    },
    devices: store.describeDevices,
    /** 面板用的设备清单（IP / 网卡 / Wi-Fi 名 / 设备型号 / 归属地） */
    devicesDetailed: () => enrichDevices(lan),
    close: () =>
      new Promise((resolve) => {
        app.server.close(() => resolve());
        app.server.closeAllConnections?.();
      }),
    app,
  };
}
