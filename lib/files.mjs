/** 磁盘浏览的小工具：盘符/常用目录、目录列表、MIME 猜测。 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const MIME = {
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.zip': 'application/zip',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.apk': 'application/vnd.android.package-archive',
  '.psd': 'image/vnd.adobe.photoshop',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function mimeOf(p) {
  return MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream';
}

/** Windows 盘符列表；其它系统返回 ['/']。 */
export function drives() {
  if (process.platform !== 'win32') return ['/'];
  const found = [];
  for (let i = 65; i <= 90; i++) {
    const d = `${String.fromCharCode(i)}:\\`;
    try {
      fs.accessSync(d, fs.constants.R_OK);
      found.push(d);
    } catch {
      /* 不存在的盘 */
    }
  }
  return found;
}

/** 常用目录快捷入口。 */
export function shortcuts() {
  const home = os.homedir();
  const candidates = [
    ['桌面', path.join(home, 'Desktop')],
    ['下载', path.join(home, 'Downloads')],
    ['文档', path.join(home, 'Documents')],
    ['图片', path.join(home, 'Pictures')],
    ['视频', path.join(home, 'Videos')],
    ['音乐', path.join(home, 'Music')],
    ['整个用户目录', home],
  ];
  return candidates
    .filter(([, p]) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    })
    .map(([label, p]) => ({ label, path: p }));
}

const MAX_ENTRIES = 3000;

/**
 * 列目录。返回 { path, parent, entries, truncated }。
 * 符号链接 / 设备文件直接跳过，避免手机端点出奇怪的东西。
 */
export async function listDir(dirAbs, { showHidden = false } = {}) {
  const st = await fs.promises.stat(dirAbs);
  if (!st.isDirectory()) throw Object.assign(new Error('不是文件夹'), { code: 'ENOTDIR' });

  const dirents = await fs.promises.readdir(dirAbs, { withFileTypes: true });
  const entries = [];
  let truncated = false;

  for (const d of dirents) {
    if (!showHidden && d.name.startsWith('.')) continue;
    if (!showHidden && /^(System Volume Information|\$RECYCLE\.BIN)$/i.test(d.name)) continue;
    if (entries.length >= MAX_ENTRIES) {
      truncated = true;
      break;
    }
    const abs = path.join(dirAbs, d.name);
    let info;
    try {
      info = await fs.promises.stat(abs);
    } catch {
      continue; // 权限不足 / 已被删除
    }
    const isDir = info.isDirectory();
    entries.push({
      name: d.name,
      type: isDir ? 'dir' : 'file',
      size: isDir ? 0 : info.size,
      mtime: info.mtimeMs,
    });
  }

  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'zh') : a.type === 'dir' ? -1 : 1));

  const parent = path.dirname(dirAbs);
  return {
    path: dirAbs,
    parent: parent === dirAbs ? null : parent,
    entries,
    truncated,
  };
}

/** 把用户传来的路径变成绝对路径，并挡掉明显越界/奇怪的输入。 */
export function resolveUserPath(input) {
  if (typeof input !== 'string' || !input.trim()) throw Object.assign(new Error('缺少 path 参数'), { code: 'EBADPATH' });
  const raw = input.trim();
  if (raw.includes('\0')) throw Object.assign(new Error('路径非法'), { code: 'EBADPATH' });
  const abs = path.resolve(raw);
  if (!path.isAbsolute(abs)) throw Object.assign(new Error('需要绝对路径'), { code: 'EBADPATH' });
  return abs;
}

export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)}${units[i]}`;
}
