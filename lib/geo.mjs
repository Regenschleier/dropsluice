/**
 * IP 归属地查询（只在"对端是公网 IP"时用；局域网地址查不到城市）。
 *
 * - 走 ip-api.com 的免费接口（HTTP、不需要 key、支持中文），失败再退到 ipwho.is。
 * - 结果按 IP 缓存 24 小时，缓存写在 .data/state.json 的 geo 段里，重启不丢。
 * - 全程不抛异常：查不到就返回 place: null，页面显示"归属地未知"，绝不让面板崩。
 */
import { readGeo, writeGeo } from './state.mjs';

const TTL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 5000;

const inflight = new Map();

function shape({ place, isp, source }) {
  return { place: place || null, isp: isp || null, source, at: Date.now() };
}

async function viaIpApi(ip) {
  const url = `http://ip-api.com/json/${encodeURIComponent(ip)}?lang=zh-CN&fields=status,message,country,regionName,city,isp`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`ip-api HTTP ${res.status}`);
  const d = await res.json();
  if (d.status !== 'success') throw new Error(d.message || 'ip-api 查询失败');
  const place = [d.country, d.regionName, d.city].filter(Boolean);
  return shape({ place: [...new Set(place)].join(' · '), isp: d.isp, source: 'ip-api.com' });
}

async function viaIpWho(ip) {
  const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`ipwho.is HTTP ${res.status}`);
  const d = await res.json();
  if (!d.success) throw new Error(d.message || 'ipwho.is 查询失败');
  const place = [d.country, d.region, d.city].filter(Boolean);
  return shape({ place: [...new Set(place)].join(' · '), isp: d.connection?.isp, source: 'ipwho.is' });
}

/**
 * 查一个公网 IP 的归属地。命中缓存直接返回；同一 IP 并发只打一次请求。
 * @returns {Promise<{place: string|null, isp: string|null, source: string|null, at: number, error?: string}>}
 */
export async function lookupPlace(ip) {
  if (!ip) return { place: null, isp: null, source: null, at: 0, error: 'no_ip' };

  const cached = readGeo(ip);
  if (cached && Date.now() - (cached.at ?? 0) < TTL_MS) return cached;

  if (inflight.has(ip)) return inflight.get(ip);

  const task = (async () => {
    for (const fn of [viaIpApi, viaIpWho]) {
      try {
        const value = await fn(ip);
        writeGeo(ip, value);
        return value;
      } catch {
        // 换下一个源
      }
    }
    const failed = { place: null, isp: null, source: null, at: Date.now(), error: 'lookup_failed' };
    return failed; // 失败不缓存，下次再试
  })().finally(() => inflight.delete(ip));

  inflight.set(ip, task);
  return task;
}
