// 文件预览页：图片、PDF、纯文本直接渲染；Office 与其它格式给下载入口。
const $ = (id) => document.getElementById(id);
const body = $('body');
const nameEl = $('name');
const subEl = $('sub');
const dlEl = $('download');
const backEl = $('back');

const qs = new URLSearchParams(location.search);
const target = qs.get('path') || '';

function fmtSize(n) {
  if (!n || n < 0) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

function downloadUrl(p) {
  return `/api/download?path=${encodeURIComponent(p)}`;
}

function note(html) {
  body.innerHTML = `<div class="pv-note">${html}</div>`;
}

function actions(p) {
  return `<div class="pv-actions">
      <a class="btn primary" href="${downloadUrl(p)}">下载这个文件</a>
      <button class="btn" id="backTo">回到列表</button>
    </div>`;
}

function wireBackToList() {
  const b = $('backTo');
  if (b) b.onclick = () => history.back();
}

async function showImage(info) {
  const wrap = document.createElement('div');
  wrap.className = 'pv-img-wrap';
  const img = document.createElement('img');
  img.className = 'pv-img';
  img.alt = info.name;
  img.src = `/api/download?path=${encodeURIComponent(info.path)}&inline=1`;
  img.onerror = () => note(`<span class="big">🖼️</span><b>这张图打不开</b><br>可能是格式手机浏览器不支持（例如 HEIC），可以下载后用相册看。${actions(info.path)}`) || wireBackToList();
  img.onclick = () => img.classList.toggle('zoomed');
  wrap.appendChild(img);
  body.replaceChildren(wrap);
}

async function showText(info) {
  const res = await fetch(`/api/download?path=${encodeURIComponent(info.path)}&inline=1`, { headers: { Range: 'bytes=0-204799' } });
  const text = await res.text();
  const pre = document.createElement('pre');
  pre.className = 'pv-pre';
  pre.textContent = text.length >= 204800 ? text + '\n\n—— 只显示前 200 KB ——' : text;
  body.replaceChildren(pre);
}

async function showPdf(info, url) {
  const hint = document.createElement('div');
  hint.className = 'pv-progress';
  hint.textContent = '正在载入 PDF…';
  body.replaceChildren(hint);

  let pdfjsLib;
  try {
    pdfjsLib = await import('/pdfjs/pdf.min.mjs');
    pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';
  } catch (err) {
    note(`<span class="big">📄</span><b>PDF 渲染器没加载起来</b><br>${err.message}${actions(info.path)}`);
    wireBackToList();
    return;
  }

  try {
    const doc = await pdfjsLib.getDocument({ url, withCredentials: true }).promise;
    subEl.textContent = ` · ${doc.numPages} 页`;
    const pages = document.createElement('div');
    body.replaceChildren(pages);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const cssWidth = Math.min(window.innerWidth - 16, base.width);
      const scale = (cssWidth / base.width) * dpr;
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.className = 'pv-page';
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      canvas.style.width = `${Math.floor(cssWidth)}px`;
      pages.appendChild(canvas);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    }
  } catch (err) {
    note(`<span class="big">📄</span><b>这个 PDF 打不开</b><br>${err.message}<br>可能加了密码，或者文件损坏。${actions(info.path)}`);
    wireBackToList();
  }
}

async function showOffice(info) {
  note(`<span class="big">📄</span><b>Office 文件先下载再看</b><br>
    手机里的 WPS / Office 打开最稳（${info.name}）。<br>
    电脑上装了 Word / Excel 的，可以让我做「转成 PDF 再看」这条路。${actions(info.path)}`);
  wireBackToList();
}

async function showOther(info) {
  note(`<span class="big">📦</span><b>这个格式不预览</b><br>${info.name}${actions(info.path)}`);
  wireBackToList();
}

async function main() {
  if (!target) {
    note('没带文件路径。');
    return;
  }
  dlEl.href = downloadUrl(target);
  backEl.href = '/';

  let info;
  try {
    const res = await fetch(`/api/preview-info?path=${encodeURIComponent(target)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    info = await res.json();
  } catch (err) {
    note(`<span class="big">⚠️</span><b>读不到这个文件</b><br>${err.message}`);
    return;
  }

  nameEl.textContent = info.name;
  document.title = `DropSluice · ${info.name}`;
  if (info.isDirectory) {
    note('这是个文件夹，回到列表里点「打包下载」。');
    return;
  }
  subEl.textContent = ` · ${fmtSize(info.size)}`;

  const inlineUrl = `/api/download?path=${encodeURIComponent(info.path)}&inline=1`;
  if (info.kind === 'image') return showImage(info);
  if (info.kind === 'pdf') return showPdf(info, inlineUrl);
  if (info.kind === 'text') return showText(info);
  if (info.kind === 'office') return showOffice(info);
  return showOther(info);
}

main();
