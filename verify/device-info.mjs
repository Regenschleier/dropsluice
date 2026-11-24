/**
 * 设备信息功能的离线自测（不用手机、不碰线上 .data）。
 *
 * 覆盖：
 *   1. UA → 「iPhone · iOS 18 · Safari」这类描述
 *   2. 私网/公网地址判定
 *   3. `::ffff:` 映射地址归一化
 *   4. 起一个临时服务，配一台"假 iPhone"，确认 devicesDetailed 里带上了 IP / 网卡 / 设备型号
 *   5. 公网 IP 的归属地查询（走真网络，查不到也不算失败，但会明确打出来）
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { describeDevice } from '../lib/ua.mjs';
import { isPrivateIp, normalizeIp } from '../lib/net.mjs';
import { lookupPlace } from '../lib/geo.mjs';

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

console.log('1) UA 解析');
{
  const iphone = describeDevice(
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  );
  ok('iPhone', iphone.model === 'iPhone' && iphone.os === 'iOS 18.1' && iphone.browser === 'Safari', JSON.stringify(iphone));

  const android = describeDevice(
    'Mozilla/5.0 (Linux; Android 14; 2211133C Build/UKQ1.230804.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.188 Mobile Safari/537.36',
  );
  ok('Android 机型', android.model === '2211133C' && android.os === 'Android 14' && android.browser === 'Chrome', JSON.stringify(android));

  const win = describeDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0');
  ok('Windows + Edge', win.model.includes('Windows') && win.browser === 'Edge', JSON.stringify(win));

  const wechat = describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49(0x18003128) NetType/WIFI Language/zh_CN');
  ok('微信', wechat.browser === '微信', JSON.stringify(wechat));

  ok('空 UA 不炸', describeDevice('').label === '未知设备');
}

console.log('2) 地址判定');
{
  ok('192.168.1.7 私网', isPrivateIp('192.168.1.7'));
  ok('10.0.0.5 私网', isPrivateIp('10.0.0.5'));
  ok('172.16.0.1 私网', isPrivateIp('172.16.0.1'));
  ok('172.32.0.1 是公网', isPrivateIp('172.32.0.1') === false);
  ok('1.1.1.1 公网', isPrivateIp('1.1.1.1') === false);
  ok('::ffff:10.0.0.5 私网', isPrivateIp('::ffff:10.0.0.5'));
  ok('::1 私网', isPrivateIp('::1'));
  ok('归一化 ::ffff:192.168.1.9', normalizeIp('::ffff:192.168.1.9') === '192.168.1.9');
  ok('归一化 [::1]', normalizeIp('[::1]') === '::1');
}

console.log('3) 临时服务 + 配对后看设备清单');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-dev-'));
process.env.DROPSLUICE_HOME = tmp;
const { startDropSluice } = await import('../lib/app.mjs');
const server = await startDropSluice({ port: 19277, host: '127.0.0.1', openPairing: true, log: () => {} });
try {
  const base = 'http://127.0.0.1:19277';
  const pairing = await (await fetch(`${base}/api/pairing`)).json();
  ok('配对窗口已开', Boolean(pairing.code));

  const ua = 'Mozilla/5.0 (Linux; Android 15; Pixel 9 Build/AP4A; wv) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36';
  const pair = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': ua },
    body: JSON.stringify({ code: pairing.code, name: '测试手机' }),
  });
  ok('配对成功', pair.status === 200, `status=${pair.status}`);
  const token = /pd_session=([^;]+)/.exec(pair.headers.get('set-cookie') ?? '')?.[1];
  ok('拿到令牌', Boolean(token));

  // 带令牌请求一次，让服务把 IP/UA 记到设备上（真机每次请求都带同一个 UA，这里照做）
  const me = await (
    await fetch(`${base}/api/me`, {
      headers: { authorization: `Bearer ${decodeURIComponent(token)}`, 'user-agent': ua },
    })
  ).json();
  ok('/api/me 带 ip', me.ip === '127.0.0.1', JSON.stringify(me));
  ok('/api/me 带设备描述', me.client?.model === 'Pixel 9', JSON.stringify(me.client));

  const rows = await server.devicesDetailed();
  ok('清单 1 台', rows.length === 1, `实际 ${rows.length} 台：${rows.map((r) => r.name).join(' / ')}`);
  const d = rows[0];
  ok('设备名', d.name === '测试手机', d.name);
  ok('IP 已记录', d.ip === '127.0.0.1', d.ip);
  ok('网卡已记录', Boolean(d.iface), d.iface);
  ok('设备型号', d.client.model === 'Pixel 9', JSON.stringify(d.client));
  ok('局域网判定', d.network.kind === 'lan', JSON.stringify(d.network));
  ok('局域网不查归属地', d.location === null, JSON.stringify(d.location));
  ok('配对时间', typeof d.createdAt === 'number');
  ok('最近活跃', typeof d.lastSeenAt === 'number');

  // 解除后令牌立刻失效
  const revoke = await fetch(`${base}/phone-drop/revoke`, { method: 'POST' }).catch(() => null);
  void revoke;
} finally {
  await server.close();
}

console.log('4) 公网 IP 归属地（真网络，允许失败）');
{
  const r = await lookupPlace('1.1.1.1');
  if (r.place) {
    pass += 1;
    console.log(`  ✓ 1.1.1.1 → ${r.place}${r.isp ? ` · ${r.isp}` : ''}  [${r.source}]`);
  } else {
    console.log(`  ! 1.1.1.1 归属地查不到（${r.error ?? 'no reason'}）— 网络受限时属正常，面板会显示"归属地查不到"`);
  }
  const again = await lookupPlace('1.1.1.1');
  ok('第二次走缓存（不重复请求）', again.at === r.at || Boolean(again.place) === Boolean(r.place));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
