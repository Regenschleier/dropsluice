/**
 * 一条命令出全部成品：exe、APK、安装包、绿色包、SHA256SUMS。
 *
 *   node scripts/release.mjs                 # 全量
 *   node scripts/release.mjs --skip=apk      # 跳过安卓（只想重打 exe 时）
 *   node scripts/release.mjs --clean         # 先清空 dist/（不动 build/ 缓存）
 *   node scripts/release.mjs --verify        # 出完再跑一遍 e2e + 安全自检
 *
 * 全部离线：esbuild/postject/rcedit 在 build/tools 里，gradle 用 build/gradle-8.9
 * + GRADLE_USER_HOME=build/gradle-home --offline，Inno Setup 用本机装的 ISCC。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from './version.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist');
const BUILD = path.join(ROOT, 'build');

const argv = process.argv.slice(2);
const skip = new Set(
  argv
    .filter((a) => a.startsWith('--skip='))
    .flatMap((a) => a.slice('--skip='.length).split(','))
    .map((s) => s.trim())
    .filter(Boolean),
);
const CLEAN = argv.includes('--clean');
const VERIFY = argv.includes('--verify');

const ISCC = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 6', 'ISCC.exe');
const GRADLE = path.join(BUILD, 'gradle-8.9', 'bin', 'gradle.bat');
const APK_OUT = path.join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');

const t0 = Date.now();
const made = [];

function log(msg) {
  console.log(msg);
}

function step(name) {
  log(`\n▶ ${name}`);
  return Date.now();
}

function done(started) {
  log(`  完成，用时 ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

function run(cmd, args, opts = {}) {
  // Windows 上 .bat 不能直接 spawnSync（EINVAL），得经过 cmd /c；
  // 而 cmd /c 这一层必须用 windowsVerbatimArguments，否则 Node 会把内层引号转义成 \" 传进去。
  if (/\.(bat|cmd)$/i.test(cmd)) {
    const line = `"${cmd}" ${args.join(' ')}`;
    execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line], {
      cwd: ROOT,
      stdio: 'inherit',
      windowsVerbatimArguments: true,
      ...opts,
    });
    return;
  }
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
}

function sha256(file) {
  const h = createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex').toUpperCase();
}

function sizeMB(file) {
  return `${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB`;
}

/** 从 android/app/build.gradle 读 versionName，用来核对版本一致性。 */
function apkVersion() {
  const gradle = fs.readFileSync(path.join(ROOT, 'android', 'app', 'build.gradle'), 'utf8');
  const m = gradle.match(/versionName\s+"([^"]+)"/);
  return m ? m[1] : '0';
}

if (CLEAN) {
  log('▶ 清空 dist/');
  fs.rmSync(DIST, { recursive: true, force: true });
}
fs.mkdirSync(DIST, { recursive: true });

// ---------- 1. exe ----------
if (!skip.has('exe')) {
  const s = step('打包 exe（Node SEA + 图标/版本信息）');
  run(process.execPath, [path.join(HERE, 'build-desktop.mjs')]);
  done(s);
}

const exePath = path.join(DIST, 'DropSluice.exe');
if (!fs.existsSync(exePath)) {
  console.error('✗ 没有 dist/DropSluice.exe，后面几步没法做');
  process.exit(1);
}
made.push(['DropSluice.exe', exePath]);
log(`  exe：${sizeMB(exePath)}`);

// ---------- 2. APK ----------
let apkPath = null;
if (!skip.has('apk')) {
  const s = step('打包 APK（Gradle assembleRelease，离线）');
  const env = { ...process.env, GRADLE_USER_HOME: path.join(BUILD, 'gradle-home') };
  run(GRADLE, ['-p', 'android', 'assembleRelease', '--offline', '--console=plain', '-q'], { env });
  fs.rmSync(path.join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'output-metadata.json'), { force: true });
  if (!fs.existsSync(APK_OUT)) {
    console.error('✗ Gradle 跑完了但没找到 app-release.apk');
    process.exit(1);
  }
  const av = apkVersion();
  // 文件名统一跟 scripts/version.mjs 走，安卓的 versionName 只做一致性核对
  apkPath = path.join(DIST, `DropSluice-${VERSION}.apk`);
  fs.copyFileSync(APK_OUT, apkPath);
  made.push([path.basename(apkPath), apkPath]);
  log(`  APK：${sizeMB(apkPath)}（versionName ${av}）`);
  if (av !== VERSION) {
    log(`  ⚠ 安卓 versionName（${av}）和 scripts/version.mjs（${VERSION}）不一致，记得改 android/app/build.gradle`);
  }
  done(s);
}

// ---------- 3. 安装包 ----------
if (!skip.has('setup')) {
  const s = step('打安装包（Inno Setup）');
  if (!fs.existsSync(ISCC)) {
    console.error(`✗ 找不到 ISCC：${ISCC}`);
    process.exit(1);
  }
  run(ISCC, [`/DMyAppVersion=${VERSION}`, path.join(ROOT, 'installer', 'dropsluice.iss')]);
  const setup = path.join(DIST, `DropSluice-Setup-${VERSION}.exe`);
  if (!fs.existsSync(setup)) {
    console.error('✗ ISCC 跑完了但没找到安装包');
    process.exit(1);
  }
  made.push([path.basename(setup), setup]);
  log(`  安装包：${sizeMB(setup)}`);
  done(s);
}

// ---------- 4. 绿色包 ----------
if (!skip.has('zip')) {
  const s = step('打绿色包（store 里的三个文件 + UTF-8 文件名）');
  const portable = path.join(DIST, 'portable');
  fs.rmSync(portable, { recursive: true, force: true });
  fs.mkdirSync(portable, { recursive: true });
  fs.copyFileSync(exePath, path.join(portable, 'DropSluice.exe'));
  fs.copyFileSync(path.join(ROOT, 'desktop', '一键开始.bat'), path.join(portable, '一键开始.bat'));
  fs.copyFileSync(path.join(ROOT, 'desktop', '使用说明.txt'), path.join(portable, '使用说明.txt'));

  const zipPath = path.join(DIST, `DropSluice-${VERSION}-portable.zip`);
  const files = ['DropSluice.exe', '一键开始.bat', '使用说明.txt'].map((n) => path.join(portable, n));
  // PYTHONIOENCODING：控制台是 GBK 时，python 打印的中文会变乱码
  run('python', [path.join(HERE, 'make-zip.py'), zipPath, ...files], {
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  made.push([path.basename(zipPath), zipPath]);
  log(`  绿色包：${sizeMB(zipPath)}`);
  done(s);
}

// ---------- 5. SHA256SUMS ----------
const s = step('生成 SHA256SUMS.txt');
const lines = made.map(([name, file]) => `${sha256(file)}  ${name}`);
fs.writeFileSync(path.join(DIST, 'SHA256SUMS.txt'), lines.join('\n') + '\n', 'utf8');
for (const l of lines) log(`  ${l}`);
done(s);

// ---------- 6. 可选：跑验证 ----------
if (VERIFY) {
  step('跑 e2e（源码）');
  run(process.execPath, [path.join(ROOT, 'verify', 'e2e.mjs')]);
  step('跑 e2e（exe，临时端口 18950）');
  run(process.execPath, [path.join(ROOT, 'verify', 'exe-e2e.mjs'), '--exe', exePath, '--port', '18950']);
  step('跑安全自检（含 dist 二进制扫描）');
  run(process.execPath, [path.join(ROOT, 'verify', 'security.mjs'), '--dist']);
}

// ---------- 汇总 ----------
log('\n════════ 产物 ════════');
for (const [name, file] of made) log(`  ${name.padEnd(34)} ${sizeMB(file).padStart(10)}`);
log(`\n全部完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)} s`);
log(`版本 ${VERSION}；产物在 ${DIST}`);
