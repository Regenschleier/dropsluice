import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * 下载/上传历史：内存里一份，落盘一份（重启后还在）。
 * 只留最近 N 条，避免文件一直长。
 */
export function createHistory({ file, limit = 200 } = {}) {
  let items = [];

  if (file) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(raw)) items = raw.filter((x) => x && typeof x === 'object');
    } catch {
      items = [];
    }
  }

  let saving = null;
  async function persist() {
    if (!file) return;
    const body = JSON.stringify(items, null, 2);
    if (saving) await saving.catch(() => {});
    saving = fsp
      .mkdir(path.dirname(file), { recursive: true })
      .then(() => fsp.writeFile(`${file}.tmp`, body, 'utf8'))
      .then(() => fsp.rename(`${file}.tmp`, file))
      .catch(() => {});
    await saving;
  }

  return {
    /** 记录一条已结束的传输（下载 / 打包 / 上传都算）。 */
    add(entry) {
      const item = {
        id: String(entry.id ?? ''),
        kind: String(entry.kind ?? 'download'),
        name: String(entry.name ?? ''),
        bytes: Number(entry.bytes) || 0,
        total: Number(entry.total) || 0,
        ip: entry.ip ? String(entry.ip) : '',
        startedAt: Number(entry.startedAt) || Date.now(),
        endedAt: Number(entry.endedAt) || Date.now(),
        ok: entry.ok !== false,
      };
      items.unshift(item);
      if (items.length > limit) items.length = limit;
      void persist();
      return item;
    },
    list(kind) {
      return (kind ? items.filter((x) => x.kind === kind) : items).map((x) => ({ ...x }));
    },
    clear() {
      items = [];
      void persist();
    },
    get size() {
      return items.length;
    },
  };
}
