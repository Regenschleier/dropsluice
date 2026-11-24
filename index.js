/**
 * DropSluice — Host half.
 *
 * Starts (or adopts) the LAN file server and exposes it to this GUI and to the
 * agent as one tool. The phone talks to the server directly on the LAN; this
 * half only manages it and serves the same-origin things the panel needs.
 */
import { startDropSluice } from './lib/app.mjs';
import { qrSvg } from './lib/qr.mjs';
import { primaryLanAddress } from './lib/net.mjs';

export const name = 'phone-drop';
export const inject = ['tools'];

const PREFIX = '/phone-drop';
const DEFAULT_PORT = Number(process.env.DROPSLUICE_PORT) || 18888;
const PROBE_TIMEOUT_MS = 700;

const TAG = '[phone-drop]';
const log = (...args) => console.log(TAG, ...args);

/** @type {Awaited<ReturnType<typeof startDropSluice>> | null} */
let running = null;
/** @type {Promise<any> | null} */
let starting = null;

function targetPort(port) {
  const n = Number(port);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
}

function firewallCommand(port) {
  return `New-NetFirewallRule -DisplayName "DropSluice" -Direction Inbound -Protocol TCP -LocalPort ${port} -Action Allow -Profile Private,Public -RemoteAddress LocalSubnet`;
}

/** Snapshot of a server this plugin started. */
async function localSnapshot() {
  const s = running;
  if (!s) return null;
  const info = s.pairingInfo();
  return {
    ok: true,
    running: true,
    adopted: false,
    port: s.port,
    lan: s.lan,
    url: s.url,
    pairing: {
      open: info.open,
      code: info.code,
      expiresAt: info.expiresAt,
      url: info.url,
      hasQr: Boolean(info.qrSvg),
    },
    devices: await s.devicesDetailed(),
    firewallCommand: firewallCommand(s.port),
  };
}

/**
 * A standalone DropSluice (started from server.mjs, or another session's
 * plugin) may already own the port. Its loopback API is enough to show the
 * same pairing panel, so adopt it instead of failing.
 */
async function probeExisting(port = DEFAULT_PORT) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/pairing`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (typeof body !== 'object' || body === null || !('open' in body)) return null;
    return { port, pairing: body, lan: primaryLanAddress() };
  } catch {
    return null;
  }
}

async function snapshot(port) {
  const local = await localSnapshot();
  if (local) return local;
  const probe = await probeExisting(targetPort(port));
  if (probe) {
    return {
      ok: true,
      running: true,
      adopted: true,
      port: probe.port,
      lan: probe.lan,
      url: probe.lan ? `http://${probe.lan}:${probe.port}/` : null,
      pairing: {
        open: Boolean(probe.pairing.open),
        code: probe.pairing.code ?? null,
        expiresAt: probe.pairing.expiresAt ?? null,
        url: probe.pairing.url ?? null,
        hasQr: Boolean(probe.pairing.url),
      },
      devices: null,
      firewallCommand: firewallCommand(probe.port),
    };
  }
  return {
    ok: true,
    running: false,
    adopted: false,
    port: targetPort(port),
    lan: primaryLanAddress(),
    url: null,
    pairing: { open: false, code: null, expiresAt: null, url: null, hasQr: false },
    devices: [],
    firewallCommand: firewallCommand(targetPort(port)),
  };
}

async function ensureStarted(port) {
  if (running) return running;
  if (starting) return starting;
  const want = targetPort(port);
  starting = (async () => {
    try {
      const inst = await startDropSluice({ port: want, host: '0.0.0.0', openPairing: true, log });
      running = inst;
      log('服务已启动', inst.url);
      return inst;
    } catch (err) {
      if (err && err.code === 'EADDRINUSE') {
        const probe = await probeExisting(want);
        if (probe) {
          log('端口已被另一个 DropSluice 占用，改为接管', want);
          return { adopted: true, port: want };
        }
        throw new Error(
          `端口 ${want} 已被别的程序占用。换一个端口再试：把环境变量 DROPSLUICE_PORT 设成空闲端口。`,
        );
      }
      throw err;
    }
  })().finally(() => {
    starting = null;
  });
  return starting;
}

async function stopServer() {
  if (!running) return false;
  const inst = running;
  running = null;
  await inst.close();
  log('服务已停止');
  return true;
}

// ── HTTP surface for the panel (same origin as the GUI, no CORS) ──────────────
//
// DSH's route layer only lets GET/HEAD through on `resource` routes (anything
// else gets 405 Allow: GET, HEAD), so the panel uses a node-style `handler`
// route and does its own method dispatch.

function sendJson(res, value, status = 200) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': body.length,
  });
  res.end(body);
}

function sendSvg(res, svg) {
  const body = Buffer.from(svg, 'utf8');
  res.writeHead(200, {
    'content-type': 'image/svg+xml; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': body.length,
  });
  res.end(body);
}

function header(req, name) {
  const v = req.headers?.[name];
  return Array.isArray(v) ? v[0] : v;
}

function ensureOwner(peer) {
  const kind = peer?.principal?.kind;
  return kind === undefined || kind === 'owner';
}

/**
 * The panel API is only for the computer itself: it hands out pairing codes.
 * The GUI listens on loopback today, but Mobile Access proxies the same origin
 * from the LAN, and plugin routes are not behind the GUI's own token gate — so
 * check the Host header (which a LAN proxy does not rewrite) as well.
 */
function isLoopbackRequest(req) {
  const host = String(header(req, 'host') ?? '').toLowerCase();
  const name = host.replace(/:\d+$/, '');
  const loopback = name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1';
  if (!loopback) return false;
  const forwarded = header(req, 'x-forwarded-host') ?? header(req, 'x-forwarded-for');
  return !forwarded;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('请求体太大');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : {};
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

async function handlePanelRequest(req, res, peer) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const sub = url.pathname.slice(PREFIX.length) || '/';
  const method = String(req.method ?? 'GET').toUpperCase();

  if (!ensureOwner(peer)) return sendJson(res, { ok: false, error: 'forbidden' }, 403);
  if (!isLoopbackRequest(req)) return sendJson(res, { ok: false, error: 'loopback_only' }, 403);

  try {
    if (sub === '/state' && (method === 'GET' || method === 'HEAD')) {
      return sendJson(res, await snapshot(url.searchParams.get('port')));
    }

    if (sub === '/start' && method === 'POST') {
      const body = await readBody(req);
      await ensureStarted(body.port);
      return sendJson(res, await snapshot(body.port));
    }

    if (sub === '/stop' && method === 'POST') {
      await stopServer();
      return sendJson(res, await snapshot());
    }

    if (sub === '/pair' && method === 'POST') {
      if (!running) {
        const inst = await ensureStarted();
        if (inst?.adopted) {
          const probe = await fetch(`http://127.0.0.1:${inst.port}/api/pairing/open`, {
            method: 'POST',
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          });
          if (!probe.ok) throw new Error('接管的那台 DropSluice 拒绝换码');
        }
      }
      const pair = running?.startPairing();
      if (!pair?.url) throw new Error('没有可用的局域网地址（Wi-Fi 没连上？）');
      return sendJson(res, await snapshot());
    }

    if (sub === '/revoke' && method === 'POST') {
      const body = await readBody(req);
      if (!running) throw new Error('服务没在运行，无法解除设备');
      const hit = running.devices().find((d) => d.id === body.id);
      if (!hit) throw new Error('没有这台设备');
      const { revokeDevice } = await import('./lib/state.mjs');
      revokeDevice(hit.id);
      return sendJson(res, await snapshot());
    }

    if (sub === '/qr.svg' && (method === 'GET' || method === 'HEAD')) {
      const info = running ? running.pairingInfo() : null;
      const link = info?.url ?? (await probeExisting(targetPort(url.searchParams.get('port'))))?.pairing?.url;
      if (!link) return sendJson(res, { ok: false, error: 'no_pairing' }, 404);
      return sendSvg(res, qrSvg(link, { size: 512, margin: 4 }));
    }

    return sendJson(res, { ok: false, error: 'not_found' }, 404);
  } catch (err) {
    log('面板请求失败', sub, err?.message ?? err);
    return sendJson(res, { ok: false, error: String(err?.message ?? err) }, 500);
  }
}

// ── The agent-facing tool ────────────────────────────────────────────────────

function textResult(text, ok = true) {
  return { ok, text };
}

async function runAction(args) {
  const action = String(args?.action ?? 'status');
  const port = args?.port;

  if (action === 'start') {
    const inst = await ensureStarted(port);
    const snap = await snapshot(port);
    if (inst?.adopted) {
      return textResult(
        `DropSluice 已经在运行（接管了占端口 ${snap.port} 的那个实例）。\n` +
          `手机地址：${snap.url ?? '（没有局域网 IPv4）'}\n` +
          `配对码：${snap.pairing.code ?? '（未开启配对窗口）'}`,
      );
    }
    return textResult(
      `DropSluice 已启动。\n` +
        `手机（同一 Wi-Fi）打开：${snap.url ?? '（没找到局域网地址）'}\n` +
        `配对码 ${snap.pairing.code ?? '—'}（10 分钟内有效，用一次就作废）。\n` +
        `二维码在网页右下角「传到手机」里，也可以手机扫这个码。\n` +
        `手机连不上时，用管理员 PowerShell 放行端口：\n${snap.firewallCommand}`,
    );
  }

  if (action === 'stop') {
    const stopped = await stopServer();
    return textResult(stopped ? 'DropSluice 已停止，端口已释放。' : 'DropSluice 本来就没在运行。');
  }

  if (action === 'pair') {
    if (!running) await ensureStarted(port);
    if (!running) {
      const adopted = await probeExisting(targetPort(port));
      if (!adopted) throw new Error('服务没起来，配对窗口开不了');
      const res = await fetch(`http://127.0.0.1:${adopted.port}/api/pairing/open`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      return textResult(
        `已换新配对码：${body.code ?? '—'}（接管的是已在运行的 DropSluice）。\n手机打开：${body.url ?? '—'}`,
      );
    }
    const pair = running.startPairing();
    if (!pair.url) throw new Error('没有可用的局域网 IPv4，先把电脑连上 Wi-Fi');
    return textResult(
      `新配对码 ${pair.code}（10 分钟内有效，成功配对后立刻作废）。\n` +
        `手机打开：${pair.url}\n` +
        `或者手机相机扫网页里的二维码（网页右下角「传到手机」）。`,
    );
  }

  if (action === 'devices') {
    const snap = await snapshot(port);
    if (!snap.running) return textResult('DropSluice 没在运行，所以没有已配对的设备信息。');
    if (snap.devices === null) return textResult('这台 DropSluice 是接管来的实例，设备列表只看得到在它自己的界面上。');
    if (!snap.devices.length) return textResult('还没有手机配对过。点「传到手机」出二维码，手机扫码配对。');
    const lines = snap.devices.map((d) => {
      const where =
        d.network?.kind === 'lan'
          ? ['局域网', d.network.ssid ? `Wi-Fi ${d.network.ssid}` : d.network.iface].filter(Boolean).join(' · ')
          : d.location?.place
            ? `${d.location.place}${d.location.isp ? ` · ${d.location.isp}` : ''}`
            : '来路未知';
      const when = d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString('zh-CN') : '还没连过';
      return `- ${d.name}（${d.id.slice(0, 8)}…）\n    IP ${d.ip ?? '—'} · ${where} · ${d.client?.label ?? '未知设备'}\n    最近活跃 ${when}`;
    });
    return textResult(`已配对 ${snap.devices.length} 台手机：\n${lines.join('\n')}\n\n要踢掉某台：phone_drop action=revoke deviceId=<id>`);
  }

  if (action === 'revoke') {
    const id = String(args?.deviceId ?? '').trim();
    if (!id) throw new Error('revoke 需要 deviceId（先用 devices 看列表）');
    if (!running) throw new Error('服务没在运行，无法解除设备');
    const hit = running.devices().find((d) => d.id === id || d.id.startsWith(id));
    if (!hit) throw new Error('没有匹配的设备');
    const { revokeDevice } = await import('./lib/state.mjs');
    revokeDevice(hit.id);
    return textResult(`已解除「${hit.name}」的访问权限，它手里的令牌立刻失效。`);
  }

  // status (default)
  const snap = await snapshot(port);
  if (!snap.running) {
    return textResult(
      `DropSluice 没在运行。用 phone_drop action=start 启动，然后在网页右下角「传到手机」出二维码。\n` +
        `（端口会开在 ${snap.port}）`,
    );
  }
  const pairLine = snap.pairing.open
    ? `配对码 ${snap.pairing.code}，${new Date(snap.pairing.expiresAt).toLocaleTimeString('zh-CN')} 过期`
    : '配对窗口关着（配对成功就自动关）';
  return textResult(
    `DropSluice ${snap.adopted ? '（接管已在运行的实例）' : ''}运行中。\n` +
      `手机地址：${snap.url ?? '（没有局域网 IPv4）'}\n` +
      `${pairLine}\n` +
      `已配对设备：${snap.devices === null ? '未知（接管实例）' : `${snap.devices.length} 台`}`,
  );
}

const tool = {
  name: 'phone_drop',
  description:
    'Start, inspect or stop DropSluice — the LAN server that lets the user browse this computer from a phone and download files byte-for-byte (no re-encoding, no compression). Pairing is a 6-digit code shown as a QR on the computer; the phone scans it once and keeps a device token. Use action=start when the user wants to send something to their phone, action=pair to hand out a fresh code, action=status to read the address, action=devices / revoke to manage phones.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['start', 'status', 'pair', 'devices', 'revoke', 'stop'],
        description: 'start 启动服务；status 看地址与配对状态；pair 换一个新配对码；devices 列已配对手机；revoke 解除某台手机；stop 停止服务并释放端口。',
      },
      port: { type: 'number', description: '可选端口，默认 18888。' },
      deviceId: { type: 'string', description: 'action=revoke 时要解除的设备 id（可从 devices 的结果里取，前缀匹配即可）。' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
      required: ['ok', 'text'],
    },
    render(_args, value) {
      return [{ type: 'text', text: String(value?.text ?? '') }];
    },
  },
  async execute(args) {
    try {
      return await runAction(args ?? {});
    } catch (err) {
      return textResult(`出错了：${err?.message ?? err}`, false);
    }
  },
};

export function apply(ctx) {
  ctx.effect(() => ctx.tools.register(tool));

  const webServer = ctx.get?.('webServer');
  if (webServer && typeof webServer.register === 'function') {
    ctx.effect(() =>
      webServer.register({
        kind: 'prefix',
        path: PREFIX,
        handler: (req, res, peer) => handlePanelRequest(req, res, peer),
      }),
    );
  } else {
    log('没有 webServer 服务，网页面板不可用（工具照常能用）');
  }

  ctx.effect(() => () => {
    void stopServer();
  });
}
