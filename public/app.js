/* 手机端文件浏览。纯原生 JS，无构建、无依赖。 */
(() => {
  const $ = (id) => document.getElementById(id);
  const list = $('list');
  const crumbs = $('crumbs');
  const rootsBox = $('roots');
  const statusBox = $('status');
  const emptyBox = $('empty');
  const filterInput = $('filter');
  const filterWrap = $('filterWrap');

  let cwd = null;          // 当前目录（绝对路径）
  let entries = [];        // 当前目录内容
  let selecting = false;   // 多选模式（长按文件/文件夹进入）
  const selected = new Set(); // 选中的绝对路径
  let rootsData = null;

  const fmtSize = (n) => {
    if (!n) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = n, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)}${u[i]}`;
  };

  const fmtTime = (ms) => {
    const d = new Date(ms);
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const iconFor = (e) => {
    if (e.type === 'dir') return '📁';
    const ext = (e.name.split('.').pop() || '').toLowerCase();
    if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'heic', 'svg'].includes(ext)) return '🖼️';
    if (['mp4', 'mov', 'mkv', 'webm', 'avi'].includes(ext)) return '🎬';
    if (['mp3', 'flac', 'wav', 'm4a', 'ogg'].includes(ext)) return '🎵';
    if (['zip', '7z', 'rar', 'tar', 'gz'].includes(ext)) return '🗜️';
    if (['pdf'].includes(ext)) return '📕';
    if (['doc', 'docx', 'txt', 'md'].includes(ext)) return '📄';
    if (['xls', 'xlsx', 'csv'].includes(ext)) return '📊';
    if (['ppt', 'pptx'].includes(ext)) return '📽️';
    if (['exe', 'msi', 'apk'].includes(ext)) return '⚙️';
    return '📦';
  };

  let hostName = '';

  async function api(url, opts) {
    const res = await fetch(url, { credentials: 'same-origin', ...opts });
    if (res.status === 401) { location.href = '/pair'; throw new Error('unauthorized'); }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) {
      const msg = data?.message || data?.error || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  }

  function setStatus(text, isError = false) {    if (!text) { statusBox.classList.add('hidden'); return; }
    statusBox.classList.remove('hidden');
    statusBox.textContent = text;
    statusBox.style.color = isError ? 'var(--danger)' : 'var(--fg-dim)';
  }

  function renderCrumbs() {
    crumbs.textContent = '';
    if (!cwd) return;
    const parts = cwd.split(/[\\/]+/).filter(Boolean);
    const isWin = /^[A-Za-z]:/.test(cwd);
    let acc = isWin ? '' : '/';
    const nodes = [];
    if (!isWin) {
      nodes.push({ label: '根目录', path: '/' });
    } else {
      parts.forEach((seg, i) => {
        acc = i === 0 ? `${seg}\\` : `${acc}${acc.endsWith('\\') ? '' : '\\'}${seg}`;
        nodes.push({ label: i === 0 ? seg : seg, path: acc });
      });
    }
    nodes.forEach((n, i) => {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'sep';
        sep.textContent = '/';
        crumbs.append(sep);
      }
      const b = document.createElement('button');
      b.textContent = n.label;
      b.onclick = () => load(n.path);
      crumbs.append(b);
    });
  }

  function renderList() {
    list.textContent = '';
    const q = filterInput.value.trim().toLowerCase();
    const shown = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries;
    emptyBox.classList.toggle('hidden', shown.length > 0);

    for (const e of shown) {
      const li = document.createElement('li');
      const a = document.createElement(e.type === 'dir' ? 'button' : 'a');
      a.className = 'row';
      if (e.type === 'dir') {
        a.onclick = () => load(joinPath(cwd, e.name));
      } else {
        a.href = `/api/download?path=${encodeURIComponent(joinPath(cwd, e.name))}`;
        a.setAttribute('download', e.name);
      }
      a.innerHTML = `<span class="ico">${iconFor(e)}</span><span class="name"></span><span class="meta"></span>`;
      a.querySelector('.name').textContent = e.name;
      a.querySelector('.meta').textContent = e.type === 'dir' ? '' : fmtSize(e.size);

      const full = joinPath(cwd, e.name);
      a.dataset.path = full;
      a.innerHTML += '<span class="check" aria-hidden="true"></span>';
      attachSelect(a, full);
      if (selected.has(full)) a.classList.add('selected');
      li.append(a);
      list.append(li);
    }
    renderSelBar();
  }

  /* ---------- 多选：长按进入，选中的一起打包下载 ---------- */
  function attachSelect(el, full) {
    let timer = null;
    let moved = false;

    el.addEventListener('pointerdown', (ev) => {
      moved = false;
      timer = setTimeout(() => {
        if (moved) return;
        if (!selecting) setSelecting(true);
        toggleSelected(full);
        if (navigator.vibrate) navigator.vibrate(10);
      }, 450);
      void ev;
    });
    el.addEventListener('pointermove', () => { moved = true; });
    el.addEventListener('pointerup', () => clearTimeout(timer));
    el.addEventListener('pointercancel', () => clearTimeout(timer));

    el.addEventListener('click', (ev) => {
      if (!selecting) return;         // 正常模式：照原来的行为（进目录 / 下载）
      ev.preventDefault();
      ev.stopPropagation();
      toggleSelected(full);
    }, true);
  }

  function setSelecting(on) {
    selecting = on;
    if (!on) selected.clear();
    $('selBar').classList.toggle('hidden', !on);
    document.body.classList.toggle('selecting', on);
    renderList();
  }

  function toggleSelected(full) {
    if (selected.has(full)) selected.delete(full);
    else selected.add(full);
    if (selected.size === 0 && selecting) return setSelecting(false);
    renderSelBar();
    for (const el of list.querySelectorAll('.row')) {
      el.classList.toggle('selected', selected.has(el.dataset.path));
    }
  }

  function renderSelBar() {
    if (!selecting) return;
    $('selCount').textContent = `已选 ${selected.size} 项`;
    $('selDownload').disabled = selected.size === 0;
  }

  function joinPath(a, b) {
    if (!a) return b;
    if (/[\\/]$/.test(a)) return a + b;
    return `${a}${a.includes('\\') ? '\\' : '/'}${b}`;
  }

  function parentOf(p) {
    if (!p) return null;
    const cleaned = p.replace(/[\\/]+$/, '');
    const m = cleaned.match(/^(.*)[\\/]([^\\/]+)$/);
    if (!m) return null;
    const parent = m[1];
    if (!parent || parent === cleaned) return null;
    return parent;
  }

  async function load(path, opts = {}) {
    const push = opts.push !== false;
    setStatus('加载中…');
    try {
      const data = await api(`/api/list?path=${encodeURIComponent(path)}`);
      cwd = data.path;
      entries = data.entries;
      renderCrumbs();
      renderList();
      filterWrap.classList.toggle('hidden', entries.length < 12);
      rootsBox.classList.add('hidden');
      setStatus(data.truncated ? '文件太多，只显示前 3000 项' : '');
      $('zipBtn').disabled = false;
      // 记一条历史：安卓的手势返回 / 返回键走的是 WebView 的历史，
      // 不记的话一划就直接退出 App。
      if (push) history.pushState({ path: cwd }, '', `#${encodeURIComponent(cwd)}`);
      else history.replaceState({ path: cwd }, '', `#${encodeURIComponent(cwd)}`);
      window.scrollTo({ top: 0 });
    } catch (err) {
      setStatus(`打不开：${err.message}`, true);
    }
  }

  async function showRoots(opts = {}) {
    const push = opts.push === true;
    setStatus('加载中…');
    try {
      const data = rootsData ?? (rootsData = await api('/api/roots'));
      list.textContent = '';
      emptyBox.classList.add('hidden');
      filterWrap.classList.add('hidden');
      crumbs.textContent = '';
      rootsBox.textContent = '';
      rootsBox.classList.remove('hidden');
      cwd = null;
      if (push) history.pushState({ path: null }, '', '#');
      else if (opts.replace !== false) history.replaceState({ path: null }, '', '#');

      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = hostName || '这台电脑';
      crumbs.append(title);

      for (const d of data.drives) {
        const b = document.createElement('button');
        b.textContent = d;
        const small = document.createElement('small');
        small.textContent = '本地磁盘';
        b.append(small);
        b.onclick = () => load(d);
        rootsBox.append(b);
      }
      for (const s of data.shortcuts) {
        const b = document.createElement('button');
        b.textContent = s.label;
        const small = document.createElement('small');
        small.textContent = s.path;
        b.append(small);
        b.onclick = () => load(s.path);
        rootsBox.append(b);
      }
      $('zipBtn').disabled = true;
      setStatus('');
    } catch (err) {
      setStatus(`读不到磁盘列表：${err.message}`, true);
    }
  }

  $('home').onclick = () => showRoots();
  $('refresh').onclick = () => (cwd ? load(cwd, { push: false }) : showRoots());

  // 安卓手势返回：WebView 回退到上一条历史，我们把它翻译成「回上一层目录」。
  window.addEventListener('popstate', (ev) => {
    const st = ev.state;
    if (st && st.path) load(st.path, { push: false });
    else showRoots({ push: false, replace: false });
  });
  filterInput.oninput = renderList;

  $('zipBtn').onclick = () => {
    if (!cwd) return;
    location.href = `/api/zip?path=${encodeURIComponent(cwd)}`;
  };

  $('selCancel').onclick = () => setSelecting(false);

  $('selDownload').onclick = () => {
    if (selected.size === 0) return;
    const qs = [...selected].map((p) => `p=${encodeURIComponent(p)}`).join('&');
    location.href = `/api/download-many?${qs}`;
    setSelecting(false);
  };

  // 大文件走分块断点续传：断了、切后台、换网络，重新问一次断点就能接着传。
  // 小文件还是老样子一次 POST，省得为几 KB 的文件开三条请求。
  const RESUMABLE_FROM = 8 * 1024 * 1024;
  const CHUNK = 4 * 1024 * 1024;

  async function uploadResumable(dir, file) {
    const q = `path=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}&size=${file.size}`;
    let { offset } = await api(`/api/upload/resume?${q}`);
    while (offset < file.size) {
      const end = Math.min(offset + CHUNK, file.size);
      let attempt = 0;
      for (;;) {
        try {
          const res = await fetch(`/api/upload/resume/chunk?${q}&offset=${offset}`, {
            method: 'PUT',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/octet-stream' },
            body: file.slice(offset, end),
          });
          const data = await res.json().catch(() => ({}));
          if (res.status === 409) { offset = data.offset; break; }   // 服务端说断点变了，按它的来
          if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
          offset = data.offset;
          setStatus(`上传中：${file.name}（${Math.floor((offset / file.size) * 100)}%）`);
          break;
        } catch (err) {
          if (++attempt > 3) throw err;
          await new Promise((r) => setTimeout(r, 600 * attempt));
          // 断线后先问服务端到底收到哪了，避免重复传
          offset = (await api(`/api/upload/resume?${q}`)).offset;
        }
      }
    }
    return api(`/api/upload/resume/done?${q}`, { method: 'POST' });
  }

  $('uploadInput').onchange = async (ev) => {
    const files = [...ev.target.files];
    if (!files.length) return;
    if (!cwd) { setStatus('先打开一个文件夹再传', true); return; }
    for (const f of files) {
      setStatus(`上传中：${f.name}（${fmtSize(f.size)}）`);
      try {
        if (f.size >= RESUMABLE_FROM) {
          await uploadResumable(cwd, f);
        } else {
          const res = await fetch(`/api/upload?path=${encodeURIComponent(cwd)}`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'x-file-name': encodeURIComponent(f.name), 'content-type': 'application/octet-stream' },
            body: f,
          });
          if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || `HTTP ${res.status}`);
        }
      } catch (err) {
        setStatus(`上传失败：${err.message}（大文件重新选一次会接着断点传）`, true);
        ev.target.value = '';
        return;
      }
    }
    ev.target.value = '';
    setStatus('上传完成');
    load(cwd);
  };

  $('unpair').onclick = async () => {
    if (!confirm('解除配对后，这台手机需要重新扫码才能再连。确定吗？')) return;
    await api('/api/unpair', { method: 'POST' });
    location.href = '/pair';
  };

  // ---- 正在传输：轮询 /api/transfers，显示文件名 / 速率 / 百分比 ----
  const xferBox = document.getElementById('xfer');

  function fmtBytes(n) {
    if (!n) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
  }

  function fmtSpeed(bps) {
    return bps > 0 ? `${fmtBytes(bps)}/s` : '—';
  }

  const KIND_TEXT = { download: '下载', upload: '上传', zip: '打包下载' };

  function renderXfer(list) {
    const active = (list || []).filter((t) => !t.done);
    if (!active.length) {
      xferBox.classList.add('hidden');
      xferBox.textContent = '';
      return;
    }
    // 同时有多条时，优先显示最近开始的那条
    const t = active.slice().sort((a, b) => b.startedAt - a.startedAt)[0];
    const pct = t.total > 0 ? Math.min(100, Math.round((t.bytes / t.total) * 100)) : null;

    xferBox.textContent = '';
    xferBox.classList.remove('hidden');

    const icon = document.createElement('span');
    icon.textContent = t.kind === 'upload' ? '⬆' : '⬇';

    const name = document.createElement('span');
    name.className = 'xfer-name';
    name.textContent = `${KIND_TEXT[t.kind] || ''} ${t.name}`;
    name.title = t.name;

    const speed = document.createElement('span');
    speed.className = 'xfer-speed';
    speed.textContent = pct === null
      ? fmtSpeed(t.speed)
      : `${pct}% · ${fmtSpeed(t.speed)}`;

    xferBox.append(icon, name, speed);

    if (pct !== null) {
      const bar = document.createElement('span');
      bar.className = 'xfer-bar';
      bar.style.transform = `scaleX(${pct / 100})`;
      xferBox.append(bar);
    }
  }

  // 传大文件时把屏幕钉住：手机锁屏后系统会断网，20 GB 就白传了。
  // 只有 App 的 WebView 里有这个桥，普通浏览器里是空操作。
  let awake = false;
  function setAwake(on) {
    if (on === awake) return;
    awake = on;
    try {
      window.DropSluiceNative && window.DropSluiceNative.keepAwake(on);
    } catch {
      // 没有桥就当不支持
    }
  }

  async function pollXfer() {
    if (document.visibilityState !== 'visible') return;
    try {
      const res = await fetch('/api/transfers', { credentials: 'same-origin' });
      if (!res.ok) return;
      const data = await res.json();
      renderXfer(data.transfers);
      setAwake((data.transfers || []).some((t) => !t.done));
    } catch {
      // 断线/服务停了就静默，别打扰用户
    }
  }

  pollXfer();
  setInterval(pollXfer, 900);

  // 首次进入：地址里带着 #<目录> 就回到那一层（刷新/被系统杀掉再回来都不丢位置）
  api('/api/me')
    .then((me) => {
      if (me && me.host) {
        hostName = me.host;
        document.title = `DropSluice · ${hostName}`;
      }
    })
    .catch(() => {})
    .finally(() => {
      const startPath = decodeURIComponent((location.hash || '').replace(/^#/, ''));
      if (startPath) load(startPath, { push: false });
      else showRoots({ replace: false });
    });
})();
