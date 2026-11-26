/* 下载页：正在下载 + 手机里已下载的文件 + 这台电脑的传输记录 */
(() => {
  const $ = (id) => document.getElementById(id);
  const bridge = window.DropSluiceNative || null;

  function fmtBytes(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
  }

  function fmtSpeed(bps) {
    if (!bps) return '—';
    return `${fmtBytes(bps)}/s`;
  }

  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  const KIND = { download: '下载', upload: '上传', zip: '打包下载' };

  function row(name, sub, onClick) {
    const li = document.createElement('li');
    li.className = 'row';
    const left = document.createElement('div');
    left.className = 'row-main';
    const t = document.createElement('div');
    t.className = 'row-name';
    t.textContent = name;
    const s = document.createElement('div');
    s.className = 'row-sub';
    s.textContent = sub;
    left.append(t, s);
    li.append(left);
    if (onClick) {
      li.style.cursor = 'pointer';
      li.addEventListener('click', onClick);
    }
    return li;
  }

  /* ---------- 正在下载 ---------- */
  async function pollActive() {
    let data;
    try {
      const r = await fetch('/api/transfers', { cache: 'no-store' });
      if (!r.ok) return;
      data = await r.json();
    } catch {
      return;
    }
    const list = (data.transfers || []).filter((t) => !t.done);
    const box = $('active');
    box.textContent = '';
    $('activeEmpty').classList.toggle('hidden', list.length > 0);
    for (const t of list) {
      const pct = t.total ? Math.round((t.bytes / t.total) * 100) : null;
      const sub = `${KIND[t.kind] || t.kind} · ${fmtBytes(t.bytes)}${t.total ? ` / ${fmtBytes(t.total)}` : ''}` +
        `${pct === null ? '' : ` · ${pct}%`} · ${fmtSpeed(t.speed)}`;
      box.append(row(t.name, sub));
    }
  }

  /* ---------- 手机里已下载的文件 ---------- */
  function renderLocal() {
    const box = $('local');
    box.textContent = '';
    if (!bridge || typeof bridge.listDownloads !== 'function') {
      $('localEmpty').classList.add('hidden');
      $('openFolder').classList.add('hidden');
      $('localHint').classList.remove('hidden');
      $('localHint').textContent = '这一栏只有 DropSluice App 里才看得到（手机浏览器打不开网页版）。在 App 里能看到下过的文件，点一下就打开。';
      return;
    }
    let items = [];
    try {
      items = JSON.parse(bridge.listDownloads() || '[]');
    } catch {
      items = [];
    }
    $('localEmpty').classList.toggle('hidden', items.length > 0);
    for (const it of items) {
      box.append(row(it.name, `${fmtBytes(it.size)} · ${fmtTime(it.at)}`, () => {
        const ok = bridge.openDownload(it.id);
        if (!ok) alert('打不开这个文件：可能已经被删掉了，或者手机上没有能打开它的应用。');
      }));
    }
  }

  /* ---------- 传输记录 ---------- */
  async function loadHistory() {
    let data;
    try {
      const r = await fetch('/api/history', { cache: 'no-store' });
      if (!r.ok) return;
      data = await r.json();
    } catch {
      return;
    }
    const list = data.history || [];
    const box = $('history');
    box.textContent = '';
    $('historyEmpty').classList.toggle('hidden', list.length > 0);
    for (const h of list) {
      const sub = `${KIND[h.kind] || h.kind} · ${fmtBytes(h.bytes)}` +
        `${h.total && h.total > h.bytes ? ` / ${fmtBytes(h.total)}` : ''}` +
        ` · ${fmtTime(h.startedAt)}${h.ok ? '' : ' · 失败'}`;
      box.append(row(h.name, sub));
    }
  }

  $('refresh').addEventListener('click', () => {
    pollActive();
    renderLocal();
    loadHistory();
  });

  $('openFolder').addEventListener('click', () => {
    if (bridge && typeof bridge.openDownloadsFolder === 'function') bridge.openDownloadsFolder();
  });

  pollActive();
  setInterval(pollActive, 900);
  renderLocal();
  loadHistory();
})();
