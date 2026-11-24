/**
 * 设备令牌（设备白名单）的持久化。
 *
 * 设计：
 *  - 每个配对过的手机 = 一台 device，存 id / 名字 / 令牌的 sha256 / 时间。
 *  - 令牌原文只存在手机的 Cookie 里，服务端只存哈希（数据库泄露也拿不到令牌）。
 *  - 配对码有有效期，过期自动换；配对窗口关掉后二维码不再签新设备。
 *  - 全部写在 .data/state.json，原子替换（先写 .tmp 再 rename）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { dataDir as resolveDataDir } from './root.mjs';

/**
 * 数据目录：`BYTEFERRY_HOME` 优先，否则由 root.mjs 逐级挑一个"真能写"的位置
 * （源码运行是 `<包目录>/.data`，装好的 exe 是 `%LOCALAPPDATA%\Byteferry`，
 *   连这个都写不了时退到 exe 旁边或临时目录）。
 * 故意做成"每次调用时算"，而不是 import 时算一次——
 * 否则测试/CLI 在 import 之后再设 BYTEFERRY_HOME 就不生效，会踩到线上那份 state.json。
 */
export function dataDir() {
  return resolveDataDir();
}
const stateFile = () => path.join(dataDir(), 'state.json');

const PAIR_CODE_TTL_MS = 10 * 60 * 1000; // 配对码 10 分钟有效

let state = null;

function emptyState() {
  return {
    devices: [],
    pair: { code: null, expiresAt: 0, open: false },
    geo: {},
  };
}

export function load() {
  if (state) return state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    state.devices ??= [];
    state.pair ??= { code: null, expiresAt: 0, open: false };
    state.geo ??= {};
  } catch {
    state = emptyState();
  }
  return state;
}

export function save() {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = stateFile();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function newToken() {
  return 'pd_' + crypto.randomBytes(24).toString('base64url');
}

/** 生成 6 位配对码，并把配对窗口打开。 */
export function openPairing(ttlMs = PAIR_CODE_TTL_MS) {
  const s = load();
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  s.pair = { code, expiresAt: Date.now() + ttlMs, open: true };
  save();
  return s.pair;
}

export function closePairing() {
  const s = load();
  s.pair.open = false;
  save();
}

/** 取当前有效的配对码；过期就换一个新的（若窗口仍开着）。 */
export function currentPairing() {
  const s = load();
  if (!s.pair.open) return null;
  if (Date.now() > s.pair.expiresAt) {
    return openPairing();
  }
  return s.pair;
}

/** 校验配对码；成功后登记设备并返回令牌原文。 */
export function pairDevice(code, name, meta = {}) {
  const s = load();
  const now = Date.now();
  if (!s.pair.open || !s.pair.code) return { error: 'pairing_closed' };
  if (now > s.pair.expiresAt) return { error: 'code_expired' };
  if (String(code ?? '').trim() !== s.pair.code) return { error: 'bad_code' };

  const token = newToken();
  s.devices.push({
    id: crypto.randomUUID(),
    name: String(name || '未命名设备').slice(0, 64),
    tokenHash: sha256(token),
    createdAt: now,
    lastSeenAt: now,
    // 从哪来的：IP、网卡、UA 原文（面板上给用户看"这台是谁"）
    ip: meta.ip ?? null,
    iface: meta.iface ?? null,
    userAgent: meta.userAgent ? String(meta.userAgent).slice(0, 400) : null,
  });
  // 一次性码：配对成功后立刻作废，第二台手机要重新开窗口（Steam 令牌那样的行为）
  s.pair = { code: null, expiresAt: 0, open: false };
  save();
  return { token, deviceId: s.devices.at(-1).id };
}

/**
 * 每次带令牌的请求都会调一次：刷新最后活跃时间、IP、网卡、UA。
 * 写盘节流：同一分钟内、且 IP/UA 没变化，就不动磁盘。
 */
export function touchDevice(id, meta = {}) {
  const s = load();
  const dev = s.devices.find((d) => d.id === id);
  if (!dev) return null;
  const now = Date.now();
  let dirty = false;

  if (now - (dev.lastSeenAt || 0) > 60_000) {
    dev.lastSeenAt = now;
    dirty = true;
  }
  if (meta.ip && dev.ip !== meta.ip) {
    dev.ip = meta.ip;
    dev.ipChangedAt = now;
    dirty = true;
  }
  if (meta.iface && dev.iface !== meta.iface) {
    dev.iface = meta.iface;
    dirty = true;
  }
  if (meta.userAgent && dev.userAgent !== meta.userAgent) {
    dev.userAgent = String(meta.userAgent).slice(0, 400);
    dirty = true;
  }
  if (dirty) save();
  return dev;
}

/** 令牌 → 设备；顺便刷新 lastSeenAt（每分钟最多写一次盘）。 */
export function findDevice(token) {
  if (!token) return null;
  const s = load();
  const h = sha256(token);
  const dev = s.devices.find((d) => d.tokenHash === h);
  if (!dev) return null;
  const now = Date.now();
  if (now - (dev.lastSeenAt || 0) > 60_000) {
    dev.lastSeenAt = now;
    save();
  }
  return dev;
}

export function revokeDevice(id) {
  const s = load();
  const before = s.devices.length;
  s.devices = s.devices.filter((d) => d.id !== id);
  save();
  return before !== s.devices.length;
}

export function listDevices() {
  return load().devices.map(({ id, name, createdAt, lastSeenAt }) => ({ id, name, createdAt, lastSeenAt }));
}

/** 面板要的完整信息（含 IP / 网卡 / UA 原文，令牌哈希不外泄）。 */
export function describeDevices() {
  return load().devices.map((d) => ({
    id: d.id,
    name: d.name,
    createdAt: d.createdAt ?? null,
    lastSeenAt: d.lastSeenAt ?? null,
    ip: d.ip ?? null,
    ipChangedAt: d.ipChangedAt ?? null,
    iface: d.iface ?? null,
    userAgent: d.userAgent ?? null,
  }));
}

/** 归属地缓存（按 IP）。 */
export function readGeo(ip) {
  const s = load();
  return s.geo?.[ip] ?? null;
}

export function writeGeo(ip, value) {
  const s = load();
  s.geo ??= {};
  s.geo[ip] = value;
  // 只留最近 200 条，别无限长
  const keys = Object.keys(s.geo);
  if (keys.length > 200) {
    for (const k of keys.slice(0, keys.length - 200)) delete s.geo[k];
  }
  save();
}
