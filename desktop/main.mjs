/**
 * 桌面版入口（DropSluice.exe 跑的也是这个文件）。
 *
 * 干的事：
 *   1. 起 DropSluice 服务（默认 18888）
 *   2. 在控制台打一遍地址和配对码，并把二维码用半块字符画出来（手机扫这个也能扫）
 *   3. 打开默认浏览器到本机面板 http://127.0.0.1:<端口>/desktop（那里有正经二维码和已配对设备）
 *
 * 为什么面板走浏览器而不是自己画窗口：单文件、零 GUI 依赖，装完就能用，
 * 也省得为一个二维码引一整套 Electron/WebView2。
 */
import { spawn } from 'node:child_process';

import { startDropSluice } from '../lib/app.mjs';
import { printTerminalQr } from '../lib/terminal-qr.mjs';
import { lanAddresses } from '../lib/net.mjs';
import { dataDir } from '../lib/state.mjs';

/** 打进 exe 里的静态文件清单（顺序无所谓，但名字要和路由里用的一致） */
const ASSET_FILES = [
  'index.html',
  'app.js',
  'style.css',
  'pair.html',
  'pair.js',
  'desktop.html',
];

/** 单文件 exe 里没有磁盘上的 public/，静态资源从 SEA 里取 */
function loadSeaAssets() {
  const sea = process.getBuiltinModule?.('node:sea');
  if (!sea?.isSea?.()) return null;
  const out = {};
  for (const name of ASSET_FILES) {
    try {
      out[name] = sea.getAsset(name, 'utf8');
    } catch {
      // 没打进去的就算了，serveStatic 会退回去读磁盘
    }
  }
  return out;
}

function parseArgs(argv) {
  const opts = { port: Number(process.env.DROPSLUICE_PORT || 18888), open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') opts.port = Number(argv[++i]);
    else if (a === '--no-open') opts.open = false;
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  if (!Number.isFinite(opts.port) || opts.port <= 0) opts.port = 18888;
  return opts;
}

function openBrowser(url) {
  const platform = process.platform;
  try {
    if (platform === 'win32') {
      // 用 cmd /c start 才能让默认浏览器接管；直接 spawn 浏览器 exe 不通用
      spawn('cmd', ['/c', 'start', '""', url], { stdio: 'ignore', windowsHide: true, detached: true }).unref();
    } else if (platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    }
    return true;
  } catch {
    return false;
  }
}

/** 端口被占时，看看是不是已经有一个 DropSluice 在跑；是的话直接把面板打开 */
async function probeExisting(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/state`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * 双击启动时，控制台窗口是"进程的窗口"：进程一退，窗口立刻消失，用户什么都看不到。
 * 所以在任何"要退出了"的路径上，只要是交互式控制台（双击就是），就等一次回车再退。
 * 被脚本/自测拉起时 stdin 不是 TTY，不会卡住；`一键开始.bat` 自己会 pause，用 DROPSLUICE_NO_PAUSE 跳过。
 */
function pauseIfInteractive() {
  if (process.env.DROPSLUICE_NO_PAUSE) return Promise.resolve();
  if (!process.stdin.isTTY) return Promise.resolve();
  return new Promise((resolve) => {
    console.log('');
    console.log('  按一下回车键关掉这个窗口…');
    process.stdin.resume();
    const done = () => {
      process.stdin.pause();
      resolve();
    };
    process.stdin.once('data', done);
    setTimeout(done, 10 * 60 * 1000).unref?.();
  });
}

function banner({ port, lan, code, pairUrl, expiresAt, existing }) {
  const line = '─'.repeat(60);
  console.log('');
  console.log(line);
  console.log('  DropSluice · 手机传文件');
  console.log(line);
  if (existing) {
    console.log('  这个端口上已经有一个 DropSluice 在跑了，直接用它。');
    console.log('');
    console.log(`  地址： http://${lan || '127.0.0.1'}:${port}/`);
    console.log(`  面板： http://127.0.0.1:${port}/desktop`);
    if (existing.pairing?.code) {
      console.log(`  配对码： ${existing.pairing.code}`);
      if (existing.pairing.expiresAt) {
        console.log(`           有效期到 ${new Date(existing.pairing.expiresAt).toLocaleTimeString('zh-CN')}`);
      }
    }
    console.log('');
    console.log('  已配对的手机：');
    if (!existing.devices?.length) console.log('    （还没有）');
    for (const d of existing.devices ?? []) {
      console.log(`    - ${d.name || '未命名设备'}  ${d.ip ?? ''}  ${d.client?.label ?? ''}`);
    }
    console.log(line);
    return;
  }

  console.log('  手机和电脑连同一个 Wi-Fi，然后：');
  console.log('');
  if (lan) {
    console.log(`    1) 用手机扫下面的二维码，或在手机浏览器里打开：`);
    console.log(`         http://${lan}:${port}/`);
    if (pairUrl) console.log(`       一键配对链接（含配对码）： ${pairUrl}`);
    console.log(`    2) 配对码： ${code}`);
    if (expiresAt) console.log(`       有效期到 ${new Date(expiresAt).toLocaleTimeString('zh-CN')}`);
  } else {
    console.log('    ⚠ 没找到局域网地址：这台电脑好像没连网络（或者只有虚拟网卡）。');
    console.log('      先在电脑上连上 Wi-Fi / 插上网线，再重新打开这个程序。');
  }

  const others = lanAddresses();
  if (others.length > 1) {
    console.log('');
    console.log('  这台电脑还有这些地址（如果上面那个连不上，可以试这些）：');
    for (const a of others) {
      console.log(`    http://${a.address}:${port}/         （${a.iface}）`);
    }
  }

  console.log('');
  console.log('  电脑上的面板（二维码 / 已配对设备 / 解除权限）：');
  console.log(`    http://127.0.0.1:${port}/desktop`);
  console.log('');
  console.log('  关掉这个窗口 = 停止服务。');
  console.log(`  数据目录： ${dataDir()}`);
  console.log(line);
  console.log('');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('用法：DropSluice.exe [--port 18888] [--no-open]');
    await pauseIfInteractive();
    return;
  }

  const assets = loadSeaAssets();
  const log = (msg) => console.log(`  · ${msg}`);

  let app;
  let usedPort = opts.port;
  try {
    app = await startDropSluice({
      port: opts.port,
      assets,
      log,
      onQuit: () => process.exit(0),
    });
  } catch (err) {
    if (err?.code !== 'EADDRINUSE') throw err;

    // ① 端口上跑的是不是另一个 DropSluice？是 → 直接用它，省得开两套服务
    const existing = await probeExisting(opts.port);
    if (existing) {
      banner({ port: opts.port, lan: existing.lan, existing });
      const panel = `http://127.0.0.1:${opts.port}/desktop`;
      if (opts.open) openBrowser(panel);
      console.log(`  面板已经在浏览器里打开了：${panel}`);
      console.log('  这个窗口可以直接关掉（它只是把面板叫出来的，没有在跑服务）。');
      console.log(`  想另起一个独立的服务、不和它共用端口： DropSluice.exe --port 18899`);
      await pauseIfInteractive();
      return;
    }

    // ② 被别的程序占了 → 往后试几个端口，别让用户自己去改命令行
    let picked = null;
    for (let p = opts.port + 1; p <= opts.port + 9 && !picked; p++) {
      try {
        app = await startDropSluice({ port: p, assets, log, onQuit: () => process.exit(0) });
        picked = p;
      } catch (e) {
        if (e?.code !== 'EADDRINUSE') throw e;
      }
    }
    if (!picked) {
      console.error(`\n  端口 ${opts.port}–${opts.port + 9} 全被占用了。`);
      console.error(`  换个端口再来： DropSluice.exe --port 19000\n`);
      process.exitCode = 2;
      await pauseIfInteractive();
      return;
    }
    usedPort = picked;
    console.log(`\n  ⚠ 端口 ${opts.port} 被别的程序占用了，这次改用 ${picked}。`);
    console.log(`    （手机上记得用 ${picked} 这个端口，地址见下面）\n`);
  }

  const pair = app.startPairing();
  banner({ port: usedPort, lan: app.lan, code: pair.code, pairUrl: pair.url, expiresAt: pair.expiresAt });
  if (pair.url && pair.code) printTerminalQr(pair.url);

  if (opts.open) {
    const panel = `http://127.0.0.1:${usedPort}/desktop`;
    const ok = openBrowser(panel);
    console.log(ok ? `  已尝试打开浏览器：${panel}` : `  没能自动打开浏览器，请手动访问 ${panel}`);
    console.log('');
  }

  const shutdown = async (signal) => {
    console.log(`\n  收到 ${signal}，正在关闭…`);
    try {
      await app.close();
    } catch {
      // 关闭失败也照退
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('Ctrl+C'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(async (err) => {
  console.error('\n  启动失败：', err?.stack || err, '\n');
  process.exitCode = 1;
  await pauseIfInteractive();
});
