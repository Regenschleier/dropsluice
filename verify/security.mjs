/**
 * 安全自检：上桌前跑一遍，确认没有把本机痕迹、凭证、构建产物带出去。
 *
 *   node verify/security.mjs            # 常规检查
 *   node verify/security.mjs --dist     # 顺带扫 dist/ 里的成品二进制
 *
 * 只读：不改文件、不发网络请求。任何一项失败都以 exit 1 结束。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VERSION } from '../scripts/version.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const WITH_DIST = process.argv.includes('--dist');

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, extra = '') {
  pass++;
  console.log(`  ✓ ${name}${extra ? `  ${extra}` : ''}`);
}
function bad(name, detail) {
  fail++;
  failures.push(`${name}: ${detail}`);
  console.log(`  ✗ ${name}  ${detail}`);
}

function tracked() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

const files = tracked();
const textExt = new Set(['.mjs', '.js', '.json', '.md', '.html', '.css', '.txt', '.xml', '.gradle', '.java', '.kts', '.properties', '.iss', '.bat', '.sh', '.yml', '.yaml', '.gitignore', '.gitattributes', '']);

// ---------- 1. 受控文件里不该出现的本机痕迹 / 凭证 ----------
console.log('1) 受控文件内容扫描');

// 本机用户名不在代码里写死：一是换台机器还能跑，二是这个文件自己也要过扫描
const HOME_USER = os.userInfo().username;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const SECRET_RULES = [
  { name: `本机绝对路径（C:\\Users\\${HOME_USER}）`, re: new RegExp(`C:\\\\?Users\\\\?${escapeRe(HOME_USER)}`, 'i') },
  { name: `本机用户名 ${HOME_USER}`, re: new RegExp(escapeRe(HOME_USER), 'i') },
  { name: '真实局域网 IP（10.17.x.x）', re: /\b10\.17\.\d{1,3}\.\d{1,3}\b/ },
  { name: 'GitHub token', re: /(github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{30,}|gho_[A-Za-z0-9]{30,})/ },
  { name: '私钥块', re: /-----BEGIN (?:OPENSSH|RSA|EC|DSA|PGP) PRIVATE KEY-----/ },
  { name: 'keystore 口令明文', re: /(?:store|key)Password\s*=\s*\S+/ },
];

const hits = [];
for (const rel of files) {
  const abs = path.join(ROOT, rel);
  const ext = path.extname(rel).toLowerCase();
  if (!textExt.has(ext)) continue;
  let st;
  try {
    st = statSync(abs);
  } catch {
    continue;
  }
  if (st.size > 2 * 1024 * 1024) continue;
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    continue;
  }
  const lines = text.split('\n');
  for (const rule of SECRET_RULES) {
    lines.forEach((line, i) => {
      if (rule.re.test(line)) hits.push(`${rel}:${i + 1} ${rule.name}`);
    });
  }
}

if (hits.length === 0) ok('没有任何本机痕迹 / 凭证', `${files.length} 个受控文件`);
else for (const h of hits.slice(0, 20)) bad('发现敏感内容', h);

// ---------- 2. 不该被跟踪的文件 ----------
console.log('2) 受控文件清单');

const FORBIDDEN = [
  { name: '构建产物目录 build/', re: /^build\// },
  { name: '发布产物目录 dist/', re: /^dist\// },
  { name: '运行状态目录 .data/', re: /^\.data\// },
  { name: '签名库 .jks', re: /\.jks$/i },
  { name: '二进制包 .apk/.exe/.zip', re: /\.(apk|exe|zip)$/i },
  { name: '交接笔记 HANDOFF*', re: /HANDOFF/i },
  { name: 'token 缓存文件', re: /gh-token|\.token$/i },
  { name: '依赖目录 node_modules/', re: /node_modules\// },
  { name: '浏览器/MCP 残留', re: /\.playwright-mcp\// },
];

const misplaced = [];
for (const rel of files) {
  for (const f of FORBIDDEN) {
    if (f.re.test(rel)) misplaced.push(`${rel}（${f.name}）`);
  }
}
if (misplaced.length === 0) ok('没有把产物 / 密钥 / 缓存提交进去');
else for (const m of misplaced.slice(0, 20)) bad('不该被跟踪', m);

// ---------- 3. 关键安全实现仍在位（防回归） ----------
console.log('3) 安全实现自检');

function readRel(rel) {
  const abs = path.join(ROOT, rel);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : '';
}

const app = readRel('lib/app.mjs');
const CHECKS = [
  { name: '会话 Cookie 带 HttpOnly', ok: /HttpOnly/i.test(app) },
  { name: '会话 Cookie 带 SameSite', ok: /SameSite=/i.test(app) },
  { name: '上传有大小上限（maxUploadBytes）', ok: /maxUploadBytes/.test(app) },
  { name: '超限返回 413', ok: /status:\s*413|json\(res,\s*413/.test(app) || /413/.test(app) },
  { name: '配对错误有限速（tooManyAttempts）', ok: /tooManyAttempts/.test(app) },
  { name: 'JSON 请求体有上限（readJsonBody limit）', ok: /readJsonBody\(req,\s*limit/.test(app) || /limit\s*=\s*1\s*<<\s*20/.test(app) },
  { name: '下载响应禁缓存/禁改写', ok: /no-store,\s*no-transform/.test(app) },
  { name: '面板接口只允许本机 Host', ok: /isLoopback|loopback/i.test(app) },
];
for (const c of CHECKS) {
  if (c.ok) ok(c.name);
  else bad(c.name, '代码里没找到');
}

// ---------- 4. 成品二进制里不该带本机痕迹 ----------
if (WITH_DIST) {
  console.log('4) dist/ 成品扫描');
  const distDir = path.join(ROOT, 'dist');
  const targets = ['DropSluice.exe', `DropSluice-${VERSION}.apk`];
  const needles = [Buffer.from(`C:\\Users\\${HOME_USER}`), Buffer.from('10.17.'), Buffer.from('github_pat_')];
  for (const t of targets) {
    const abs = path.join(distDir, t);
    if (!existsSync(abs)) {
      bad(`${t} 不存在`, '先跑 scripts/release.mjs');
      continue;
    }
    const buf = readFileSync(abs);
    const found = needles.filter((n) => buf.includes(n)).map((n) => n.toString());
    if (found.length === 0) ok(`${t} 无本机痕迹`, `${(buf.length / 1024 / 1024).toFixed(1)} MB`);
    else bad(`${t} 含敏感串`, found.join(', '));
  }
}

// ---------- 汇总 ----------
console.log('');
if (fail === 0) {
  console.log(`结果：${pass} 通过，0 失败`);
  process.exit(0);
}
console.log(`结果：${pass} 通过，${fail} 失败`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
