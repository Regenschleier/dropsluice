/**
 * 找"程序自己所在的目录"，以及决定"状态文件放哪"。
 *
 * 平时（源码运行）：import.meta.url 指到这个文件，上一级就是仓库目录。
 * 打包成单个 exe 之后（Node SEA，代码被塞进 CommonJS bundle 里）：
 * import.meta.url 不存在，这里会抛错，于是退回"可执行文件所在的目录"。
 *
 * 单独一个文件是为了让 app.mjs / state.mjs 都走同一套规则，避免以后改一处漏一处。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let cached = null;

export function appRoot() {
  if (cached) return cached;
  try {
    cached = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  } catch {
    cached = path.dirname(process.execPath);
  }
  return cached;
}

/** 这个目录能不能真的写进去（建得出来 + 写得进去），不能就别用它 */
function usable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const probe = path.join(dir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

let dataDirCache = null;

/**
 * 私有数据目录（设备令牌、配对窗口、归属地缓存）。
 *
 * 顺序（第一个"真能写"的胜出）：
 *   1. `DROPSLUICE_HOME`（测试/CLI 用它把状态隔离到临时目录）
 *   2. 源码形态：`<仓库>/.data`
 *   3. `%LOCALAPPDATA%\\DropSluice`（装好的 exe 应该用这里）
 *   4. exe 旁边的 `.data`（绿色版常见位置；Program Files 里写不了会自动跳过）
 *   5. 系统临时目录 `DropSluice`
 *
 * 为什么要逐级试：装到 Program Files、或者被某些安全策略限制时，前两个位置可能
 * 直接 `EPERM`。原地报错的话用户只看到窗口一闪就没了——所以宁可退到下一个能写的地方。
 */
export function dataDir() {
  if (dataDirCache) return dataDirCache;
  const override = process.env.DROPSLUICE_HOME;
  if (override) {
    dataDirCache = path.resolve(override);
    return dataDirCache;
  }

  const root = appRoot();
  const candidates = [];
  try {
    if (fs.existsSync(path.join(root, 'package.json'))) candidates.push(path.join(root, '.data'));
  } catch {
    // 读不到就当没有 package.json
  }
  const local = process.env.LOCALAPPDATA || process.env.XDG_DATA_HOME;
  if (local) candidates.push(path.join(local, 'DropSluice'));
  candidates.push(path.join(root, '.data'));
  candidates.push(path.join(os.tmpdir(), 'DropSluice'));

  for (const dir of candidates) {
    if (usable(dir)) {
      dataDirCache = dir;
      return dataDirCache;
    }
  }
  // 全都不行：还是返回第一个候选，让上层报出它本来想用的路径（错误信息更有用）
  dataDirCache = candidates[0];
  return dataDirCache;
}

/** 数据目录是"退而求其次"选出来的吗（用户可能想知道状态文件放哪了） */
export function dataDirIsFallback() {
  const chosen = dataDir();
  const local = process.env.LOCALAPPDATA || process.env.XDG_DATA_HOME;
  const preferred = local ? path.join(local, 'DropSluice') : null;
  if (process.env.DROPSLUICE_HOME) return false;
  try {
    if (fs.existsSync(path.join(appRoot(), 'package.json'))) return false;
  } catch {
    // 忽略
  }
  return preferred ? path.resolve(chosen) !== path.resolve(preferred) : false;
}
