/**
 * 抓 Inno Setup 的简体中文语言包（ChineseSimplified.isl）到 build/tools/。
 *
 * 为什么要脚本：raw.githubusercontent.com 在这台机器上连不上，但 api.github.com 能连；
 * 用 contents API 拿 base64，再自己解码写文件，绕开 raw 域。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'build', 'tools', 'ChineseSimplified.isl');

const CANDIDATES = [
  ['kira-96/Inno-Setup-Chinese-Simplified-Translation', 'master', 'ChineseSimplified.isl'],
  ['kira-96/Inno-Setup-Chinese-Simplified-Translation', 'main', 'ChineseSimplified.isl'],
  ['jrsoftware/issrc', 'main', 'Files/Languages/Unofficial/ChineseSimplified.isl'],
];

const get = async (url) => {
  const res = await fetch(url, { headers: { 'user-agent': 'phone-drop-build', accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
};

let done = false;
for (const [repo, branch, file] of CANDIDATES) {
  try {
    const api = `https://api.github.com/repos/${repo}/contents/${file}?ref=${branch}`;
    const json = await get(api);
    if (!json.content) throw new Error('没有 content 字段');
    const buf = Buffer.from(json.content, 'base64');
    if (buf.length < 8000) throw new Error(`内容太小（${buf.length} 字节）`);
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, buf);
    console.log(`已保存 ${OUT}（${buf.length} 字节，来自 ${repo}@${branch}:${file}）`);
    done = true;
    break;
  } catch (err) {
    console.log(`  ✗ ${repo}@${branch}:${file} — ${err.message}`);
  }
}

if (!done) {
  console.error('没抓到中文语言包；安装向导会用英文界面。');
  process.exitCode = 1;
}
