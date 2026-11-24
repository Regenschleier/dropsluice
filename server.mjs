#!/usr/bin/env node
/**
 * 命令行入口：双击或 `node server.mjs` 就把服务开起来，
 * 终端里直接打出二维码，手机扫一下就配对。
 *
 * 用法：
 *   node server.mjs                 # 默认 18888 端口，开配对窗口
 *   node server.mjs --port 18889    # 换端口
 *   node server.mjs --pair          # 服务已经在跑时，让它换一张新二维码
 *   node server.mjs --host 127.0.0.1  # 只允许本机访问（调试用）
 *   node server.mjs --open          # 顺便用浏览器打开本机页面
 */
import { startPhoneDrop } from './lib/app.mjs';
import { lanAddresses } from './lib/net.mjs';
import { printTerminalQr } from './lib/terminal-qr.mjs';

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const flag = (name) => argv.includes(`--${name}`);

const port = Number(arg('port', process.env.PHONE_DROP_PORT || 18888));
const host = arg('host', '0.0.0.0');

// `--pair`：服务已经在跑的时候，让它换一张新二维码（不用关掉重开）
if (flag('pair')) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/pairing/open`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    console.log(`\n  新的配对码：${d.code}（10 分钟内有效，配一台就用掉）`);
    if (d.url) {
      console.log('  用手机扫下面这个码：\n');
      printTerminalQr(d.url);
      console.log('');
    } else {
      console.log('  ⚠ 这台电脑没连局域网，手机可能连不上。');
    }
  } catch (err) {
    console.log(`\n  没连上正在运行的服务（${err.message}）。`);
    console.log(`  先直接跑：node server.mjs --port ${port}`);
  }
  process.exit(0);
}

const server = await startPhoneDrop({ port, host, openPairing: true, log: (m) => console.log(`[${new Date().toLocaleTimeString()}] ${m}`) });

const info = server.pairingInfo();
const lans = lanAddresses();

console.log('');
console.log('  Phone Drop 已启动');
console.log('');
for (const a of lans) {
  console.log(`  局域网地址：http://${a.address}:${port}/   （${a.iface}${a.virtual ? '，虚拟网卡，可能连不通' : ''}）`);
}
if (!lans.length) console.log('  ⚠ 没找到局域网地址：电脑是不是没连 Wi-Fi / 网线？');
console.log(`  本机地址：  http://127.0.0.1:${port}/`);
console.log('');

if (info.open && info.url) {
  console.log(`  配对码：${info.code}（10 分钟内有效，配一台就用掉）`);
  console.log('  用手机扫下面这个码：');
  console.log('');
  printTerminalQr(info.url);
  console.log('');
} else {
  console.log('  ⚠ 配对窗口没打开，请重新运行。');
}

console.log('  提示：手机连不上多半是 Windows 防火墙拦了。');
console.log('        管理员 PowerShell 里跑（把端口换成你的）：');
console.log(`        New-NetFirewallRule -DisplayName "Phone Drop" -Direction Inbound -Protocol TCP -LocalPort ${port} -Action Allow -Profile Private`);
console.log('');
console.log('  运行中可用（在窗口里敲字母再回车）：');
console.log('    p  换一张新二维码（还要配第二台手机时用）');
console.log('    d  看已经配对过哪些设备');
console.log('    q  退出（也可以 Ctrl+C）');

if (flag('open')) {
  const { exec } = await import('node:child_process');
  exec(`start "" "http://127.0.0.1:${port}/"`);
}

process.on('SIGINT', async () => {
  console.log('\n正在关闭…');
  await server.close();
  process.exit(0);
});

// 运行中换手机配对：敲 p 回车，重新出一张二维码（敲 q 回车退出）
if (process.stdin.isTTY) {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk) => {
    const cmd = String(chunk).trim().toLowerCase();
    if (cmd === 'p') {
      const p = server.startPairing();
      console.log(`\n  新的配对码：${p.code}（10 分钟内有效）`);
      printTerminalQr(p.url);
      console.log('');
    } else if (cmd === 'q') {
      console.log('\n正在关闭…');
      await server.close();
      process.exit(0);
    } else if (cmd === 'd') {
      const list = server.devices();
      console.log(list.length ? `\n  已配对设备：${list.length} 台` : '\n  还没有配对过设备');
      for (const d of list) console.log(`   - ${d.name}（最近 ${new Date(d.lastSeen).toLocaleString()}）`);
      console.log('');
    }
  });
  process.stdin.resume();
}
