/**
 * 正在传输的文件登记表（只在内存里，不落盘、不记录历史）。
 *
 * 为什么要它：手机点一个 2 GB 的视频，界面要能显示「在传什么、传了多少、多快」，
 * 而不是一个转圈的菊花。服务端知道字节从谁流到谁，所以由这里记，前端只管轮询。
 *
 * 每个条目：
 *   { id, kind, name, total, bytes, speed, startedAt, ip, done, failed }
 * kind: 'download' | 'upload' | 'zip'
 */
export function createTransfers() {
  const map = new Map();
  let seq = 0;
  const KEEP_MS = 6000; // 传完之后还留几秒，界面上"完成"那一下不至于瞬间消失

  function start(meta) {
    const id = ++seq;
    map.set(id, {
      id,
      kind: meta.kind,
      name: meta.name,
      total: Number(meta.total) || 0,
      bytes: 0,
      ip: meta.ip || '',
      startedAt: Date.now(),
      samples: [{ t: Date.now(), b: 0 }],
      done: false,
      failed: false,
    });
    return id;
  }

  /** 累加已传字节；顺便留 5 秒窗口的采样点用来算瞬时速率。 */
  function add(id, n) {
    const t = map.get(id);
    if (!t || !n) return;
    t.bytes += n;
    const now = Date.now();
    t.samples.push({ t: now, b: t.bytes });
    while (t.samples.length > 2 && now - t.samples[0].t > 5000) t.samples.shift();
  }

  function end(id, opts = {}) {
    const t = map.get(id);
    if (!t) return;
    t.done = true;
    t.failed = Boolean(opts.failed);
    t.endedAt = Date.now();
    setTimeout(() => map.delete(id), KEEP_MS).unref?.();
  }

  /** 瞬时速率（字节/秒）：最近 5 秒窗口里的平均，采样不足就退回「总量 / 已用时间」。 */
  function speedOf(t) {
    const s = t.samples;
    if (s.length >= 2) {
      const first = s[0];
      const last = s[s.length - 1];
      const dt = (last.t - first.t) / 1000;
      if (dt >= 0.2) return Math.max(0, Math.round((last.b - first.b) / dt));
    }
    const elapsed = (Date.now() - t.startedAt) / 1000;
    return elapsed > 0.2 ? Math.round(t.bytes / elapsed) : 0;
  }

  function list() {
    return [...map.values()]
      .map((t) => ({
        id: t.id,
        kind: t.kind,
        name: t.name,
        total: t.total,
        bytes: t.bytes,
        speed: t.done ? 0 : speedOf(t),
        ip: t.ip,
        startedAt: t.startedAt,
        endedAt: t.endedAt || 0,
        done: t.done,
        failed: t.failed,
      }))
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /** 给「有没有在传」这种快速判断用 */
  function active() {
    return list().filter((t) => !t.done).length;
  }

  return { start, add, end, list, active };
}

/** 人读的速率：1.2 MB/s */
export function fmtSpeed(bytesPerSec) {
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let n = bytesPerSec;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}
