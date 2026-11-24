/* 配对页：电脑本机显示二维码；手机扫进来则只需输 6 位码。 */
(() => {
  const $ = (id) => document.getElementById(id);
  const msg = $('msg');
  const codeInput = $('code');
  const nameInput = $('name');
  const qrBox = $('qrBox');
  const qrImg = $('qr');
  const codeText = $('codeText');

  function guessName() {
    const ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    if (/Android/.test(ua)) {
      const m = ua.match(/Android[^;]*;\s*([^)]+?)(?:\s+Build|\))/);
      return (m?.[1] || 'Android 手机').trim().slice(0, 32);
    }
    if (/Windows/.test(ua)) return '电脑上的浏览器';
    if (/Macintosh/.test(ua)) return 'Mac';
    return '浏览器';
  }

  function setMsg(text, ok) {
    msg.textContent = text;
    msg.className = `msg ${ok ? 'ok' : 'err'}`;
  }

  async function submit() {
    const code = codeInput.value.trim();
    if (!/^\d{6}$/.test(code)) {
      setMsg('请输入 6 位数字配对码', false);
      return;
    }
    $('go').disabled = true;
    setMsg('正在连接…', true);
    try {
      const res = await fetch('/api/pair', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, name: nameInput.value.trim() || guessName() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg(data.message || '配对失败', false);
        $('go').disabled = false;
        return;
      }
      setMsg('连接成功，正在进入…', true);
      location.href = '/';
    } catch (err) {
      setMsg(`网络错误：${err.message}`, false);
      $('go').disabled = false;
    }
  }

  $('go').onclick = submit;
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 6);
    if (codeInput.value.length === 6) submit();
  });
  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });

  (async () => {
    nameInput.value = guessName();
    const fromUrl = new URLSearchParams(location.search).get('c');
    if (fromUrl) {
      codeInput.value = fromUrl.replace(/\D/g, '').slice(0, 6);
      submit();
      return;
    }
    // 只有在电脑本机（127.0.0.1）打开时，服务端才允许取二维码
    try {
      const res = await fetch('/api/pairing', { credentials: 'same-origin' });
      if (!res.ok) return;
      const info = await res.json();
      if (!info.open) {
        setMsg('电脑那边的配对窗口没打开：请重新运行 DropSluice 或点"重新配对"。', false);
        return;
      }
      qrImg.src = '/qr.svg';
      codeText.textContent = (info.code || '').replace(/(\d{3})(\d{3})/, '$1 $2');
      qrBox.classList.remove('hidden');
    } catch {
      /* 手机端会 403，正常 */
    }
  })();
})();
