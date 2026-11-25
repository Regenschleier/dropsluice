/**
 * 把 DropSluice 打包成单个 DropSluice.exe（Node SEA，绿色免安装）。
 *
 * 流程：
 *   1. esbuild 把 desktop/main.mjs 和它 import 的所有 lib/*.mjs 打成一个 CommonJS 文件
 *   2. 生成 sea-config.json（含 5 个手机页面 + 桌面面板 HTML，作为 SEA assets 打进 exe）
 *   3. node --experimental-sea-config 生成 blob
 *   4. 复制当前 node.exe → dist/DropSluice.exe，用 postject 把 blob 注进去
 *   5. 有 rcedit 的话再改一下版本信息和图标（可选，失败只警告）
 *
 * 用法：node scripts/build-desktop.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { VERSION } from './version.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUILD = path.join(ROOT, 'build', 'sea');
const DIST = path.join(ROOT, 'dist');
const TOOLS = path.join(ROOT, 'build', 'tools', 'node_modules');

const ASSETS = {
  'index.html': 'public/index.html',
  'app.js': 'public/app.js',
  'style.css': 'public/style.css',
  'pair.html': 'public/pair.html',
  'pair.js': 'public/pair.js',
  'desktop.html': 'desktop/desktop.html',
};

function step(msg) {
  console.log(`\n[${new Date().toLocaleTimeString('zh-CN')}] ${msg}`);
}

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
}

// ---------- 1. esbuild ----------
step('1/5 esbuild 打成一个 CommonJS 文件');
fs.mkdirSync(BUILD, { recursive: true });
const esbuild = await import(pathToFileURL(path.join(TOOLS, 'esbuild', 'lib', 'main.js')).href);
await esbuild.build({
  entryPoints: [path.join(ROOT, 'desktop', 'main.mjs')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: path.join(BUILD, 'dropsluice.cjs'),
  // import.meta.url 在 CJS 里不存在，lib/root.mjs 有 try/catch 兜底，这里别刷警告
  logOverride: { 'empty-import-meta': 'silent' },
  banner: {
    js: '/* DropSluice —— 由 scripts/build-desktop.mjs 生成，别手改 */',
  },
});

// ---------- 2. sea-config ----------
step('2/5 生成 sea-config.json');
const assets = {};
for (const [key, rel] of Object.entries(ASSETS)) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) throw new Error(`缺静态文件：${rel}`);
  // 写相对路径（相对仓库根）：Node 会把配置原样嵌进 blob，
  // 写绝对路径的话成品 exe 里会留下 C:\Users\<你>\... 这种本机痕迹。
  assets[key] = rel;
}
const seaConfig = {
  main: path.join('build', 'sea', 'dropsluice.cjs'),
  output: path.join('build', 'sea', 'dropsluice.blob'),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets,
};
const seaConfigPath = path.join(BUILD, 'sea-config.json');
fs.writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2));

// ---------- 3. blob ----------
step('3/5 node --experimental-sea-config');
run(process.execPath, ['--experimental-sea-config', seaConfigPath]);

// ---------- 4. 复制 node.exe、写图标、注入 blob ----------
step('4/5 复制 node.exe → 写图标/版本 → 注入 SEA blob');
fs.mkdirSync(DIST, { recursive: true });
const exePath = path.join(DIST, 'DropSluice.exe');
fs.copyFileSync(process.execPath, exePath);

// 注意顺序：rcedit 必须在 postject 之前。注入了 90 MB blob 之后再改资源会挂住不返回。
// 也直接用 rcedit 的 exe 而不是 npm 那层 cross-spawn 包装（包装在这台机器上会挂住）。
const rceditExe = path.join(TOOLS, 'rcedit', 'bin', 'rcedit-x64.exe');
const ico = path.join(ROOT, 'build', 'assets', 'dropsluice.ico');
if (fs.existsSync(rceditExe) && fs.existsSync(ico)) {
  const args = [
    exePath,
    '--set-icon', ico,
    '--set-file-version', `${VERSION}.0`,
    '--set-product-version', `${VERSION}.0`,
    '--set-version-string', 'CompanyName', 'DropSluice',
    '--set-version-string', 'FileDescription', 'DropSluice - 手机传文件',
    '--set-version-string', 'ProductName', 'DropSluice',
    '--set-version-string', 'OriginalFilename', 'DropSluice.exe',
    '--set-version-string', 'LegalCopyright', '本机自用',
  ];
  try {
    execFileSync(rceditExe, args, { stdio: 'pipe', timeout: 60000 });
    console.log('  图标和版本信息已写入');
  } catch (err) {
    console.log(`  ⚠ 写图标失败（不影响使用）：${err.message}`);
  }
} else {
  console.log('  跳过图标（没有 rcedit 或没有 ico）');
}

const postjectCli = path.join(TOOLS, 'postject', 'dist', 'cli.js');
if (!fs.existsSync(postjectCli)) throw new Error(`找不到 postject：${postjectCli}`);
run(process.execPath, [
  postjectCli,
  exePath,
  'NODE_SEA_BLOB',
  path.join(BUILD, 'dropsluice.blob'),
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
]);

// ---------- 5. 收尾 ----------
const out = fs.statSync(exePath);
step(`5/5 完成：${exePath}（${(out.size / 1024 / 1024).toFixed(1)} MB）`);
