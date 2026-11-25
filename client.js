/**
 * DropSluice — Client half.
 *
 * A small "传到手机" button in the composer dock that opens a panel with the
 * pairing QR. Everything is fetched from the Host half on the same origin, so
 * no CORS and no second source of truth.
 */
window.__ModuleLoader__.load({
  id: '@local/phone-drop',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;

    let createPortal = null;
    try {
      const rd = require('react-dom');
      createPortal = rd?.createPortal ?? null;
    } catch {
      createPortal = null;
    }

    const API = '/phone-drop';

    const T = {
      card: 'var(--dsw-alias-bg-elevated, #1c1d21)',
      sunken: 'var(--dsw-alias-bg-sunken, #141519)',
      text: 'var(--dsw-alias-text-primary, #ececee)',
      muted: 'var(--dsw-alias-text-secondary, #9a9aa2)',
      border: 'var(--dsw-alias-border-default, rgba(255,255,255,0.12))',
      accent: 'var(--dsw-alias-accent, #4c8dff)',
      danger: 'var(--dsw-alias-text-danger, #ff6b6b)',
    };

    async function api(path, init) {
      const res = await fetch(API + path, {
        cache: 'no-store',
        ...init,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) {
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      return body;
    }

    const post = (path, payload) => api(path, { method: 'POST', body: JSON.stringify(payload ?? {}) });

    function fmtTime(ms) {
      if (!ms) return '—';
      const d = new Date(ms);
      return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    function fmtLeft(ms) {
      if (!ms) return '';
      const left = Math.max(0, ms - Date.now());
      const m = Math.floor(left / 60000);
      const s = Math.floor((left % 60000) / 1000);
      return `${m}:${String(s).padStart(2, '0')}`;
    }

    function Btn({ children, onClick, kind = 'default', disabled, title }) {
      const base = {
        font: 'inherit',
        fontSize: 12,
        lineHeight: '20px',
        padding: '2px 10px',
        borderRadius: 6,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        background: kind === 'primary' ? T.accent : 'transparent',
        color: kind === 'primary' ? '#fff' : kind === 'danger' ? T.danger : T.text,
        border: `1px solid ${kind === 'primary' ? T.accent : T.border}`,
        whiteSpace: 'nowrap',
      };
      return h('button', { type: 'button', style: base, onClick, disabled, title }, children);
    }

    /** 相对时间：刚刚 / 12 分钟前 / 3 小时前 / 11-24 22:10 */
    function relTime(ms) {
      if (!ms) return '—';
      const diff = Date.now() - ms;
      if (diff < 0) return '刚刚';
      if (diff < 60_000) return '刚刚';
      if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
      if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
      const d = new Date(ms);
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    /** 这台设备"从哪来"：局域网就说局域网 + Wi-Fi 名，公网就说城市 */
    function placeOf(d) {
      const net = d.network ?? {};
      if (net.kind === 'lan') {
        const bits = ['同一局域网'];
        if (net.ssid) bits.push(`Wi-Fi ${net.ssid}`);
        else if (net.iface) bits.push(net.iface);
        return bits.join(' · ');
      }
      if (net.kind === 'public') {
        const loc = d.location;
        if (loc?.place) return `${loc.place}${loc.isp ? ` · ${loc.isp}` : ''}`;
        return '公网 · 归属地查不到';
      }
      return '地址未知';
    }

    /** 一台已配对设备：名字 + IP/来路 + 设备型号/时间 + 解除 */
    function DeviceRow({ d, busy, onRevoke }) {
      const line = { fontSize: 11, color: T.muted, lineHeight: '17px' };
      const ip = d.ip ?? '还没连过';
      return h(
        'div',
        {
          style: {
            padding: '6px 0',
            borderTop: `1px dashed ${T.border}`,
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { style: { color: T.text, fontSize: 12.5, fontWeight: 600 } }, d.name || '未命名设备'),
          h('div', { style: { flex: 1 } }),
          h(Btn, { kind: 'danger', disabled: busy, onClick: onRevoke, title: '解除后这台手机必须重新扫码才能再连' }, '解除'),
        ),
        h(
          'div',
          { style: { ...line, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'baseline' } },
          h('span', { style: { fontFamily: 'ui-monospace, Consolas, monospace', color: T.text, opacity: 0.85 } }, ip),
          h('span', {}, '·'),
          h('span', {}, placeOf(d)),
        ),
        h(
          'div',
          { style: { ...line, display: 'flex', gap: 6, flexWrap: 'wrap' } },
          h('span', {}, d.client?.label ?? '未知设备'),
          h('span', {}, '·'),
          h('span', {}, `配对 ${relTime(d.createdAt)}`),
          h('span', {}, '·'),
          h('span', { style: { color: d.lastSeenAt ? T.text : T.muted, opacity: 0.8 } }, `最近 ${relTime(d.lastSeenAt)}`),
        ),
      );
    }

    function Panel({ onClose }) {
      const [snap, setSnap] = useState(null);
      const [error, setError] = useState(null);
      const [busy, setBusy] = useState(false);
      const [copied, setCopied] = useState(false);
      const [now, setNow] = useState(Date.now());
      const alive = useRef(true);

      const load = useCallback(async () => {
        try {
          const next = await api('/state');
          if (alive.current) {
            setSnap(next);
            setError(null);
          }
        } catch (err) {
          if (alive.current) setError(String(err?.message ?? err));
        }
      }, []);

      useEffect(() => {
        alive.current = true;
        void load();
        const poll = setInterval(() => void load(), 2500);
        const tick = setInterval(() => setNow(Date.now()), 1000);
        return () => {
          alive.current = false;
          clearInterval(poll);
          clearInterval(tick);
        };
      }, [load]);

      const run = useCallback(
        async (fn) => {
          setBusy(true);
          try {
            const next = await fn();
            if (alive.current && next && typeof next === 'object' && 'running' in next) setSnap(next);
            else await load();
            if (alive.current) setError(null);
          } catch (err) {
            if (alive.current) setError(String(err?.message ?? err));
          } finally {
            if (alive.current) setBusy(false);
          }
        },
        [load],
      );

      const running = Boolean(snap?.running);
      const pairing = snap?.pairing ?? {};
      const pairedCount = Array.isArray(snap?.devices) ? snap.devices.length : null;

      const copy = () => {
        const link = pairing.url ?? snap?.url;
        if (!link) return;
        navigator.clipboard?.writeText(link).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => {},
        );
      };

      const rows = [];
      rows.push(
        h(
          'div',
          { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 } },
          h('div', { style: { fontWeight: 600, fontSize: 14, color: T.text } }, '传到手机'),
          h(
            'span',
            {
              style: {
                fontSize: 11,
                padding: '1px 6px',
                borderRadius: 999,
                color: running ? T.accent : T.muted,
                border: `1px solid ${running ? T.accent : T.border}`,
              },
            },
            running ? (snap?.adopted ? '已在运行' : '运行中') : '未启动',
          ),
          h('div', { style: { flex: 1 } }),
          h(Btn, { onClick: onClose, title: '关闭' }, '✕'),
        ),
      );

      if (error) {
        rows.push(
          h(
            'div',
            {
              key: 'err',
              style: {
                fontSize: 12,
                color: T.danger,
                background: T.sunken,
                border: `1px solid ${T.border}`,
                borderRadius: 6,
                padding: '6px 8px',
                marginBottom: 8,
                wordBreak: 'break-word',
              },
            },
            error,
          ),
        );
      }

      if (!running) {
        rows.push(
          h(
            'div',
            { key: 'off', style: { fontSize: 12, color: T.muted, lineHeight: 1.7 } },
            '启动后，手机连同一个 Wi-Fi，扫二维码就能浏览这台电脑的全部文件和磁盘，原样下载（不转码、不压缩）。',
          ),
          h(
            'div',
            { key: 'offbtn', style: { marginTop: 10, display: 'flex', gap: 8 } },
            h(Btn, { kind: 'primary', disabled: busy, onClick: () => run(() => post('/start', {})) }, '启动'),
          ),
        );
      } else {
        rows.push(
          h(
            'div',
            { key: 'addr', style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 } },
            h(
              'code',
              {
                style: {
                  flex: 1,
                  fontSize: 12,
                  color: T.text,
                  background: T.sunken,
                  border: `1px solid ${T.border}`,
                  borderRadius: 6,
                  padding: '4px 8px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
              },
              snap?.url ?? '（没有局域网地址，先把电脑连上 Wi-Fi）',
            ),
            h(Btn, { onClick: copy, disabled: !snap?.url }, copied ? '已复制' : '复制'),
          ),
        );

        // 手机不在同一个 Wi-Fi（开着流量 / 借别人家网）时，走 Tailscale 那条
        const ts = snap?.tailnet;
        const remoteUrl = ts?.up && ts.url ? `${ts.url}（Tailscale）` : null;
        if (remoteUrl) {
          rows.push(
            h(
              'div',
              { key: 'tailnet', style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 } },
              h(
                'code',
                {
                  title: ts?.dnsName ? `MagicDNS：${ts.dnsName}` : undefined,
                  style: {
                    flex: 1,
                    fontSize: 12,
                    color: T.text,
                    background: T.sunken,
                    border: `1px solid ${T.border}`,
                    borderRadius: 6,
                    padding: '4px 8px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  },
                },
                remoteUrl,
              ),
              h(
                Btn,
                {
                  onClick: async () => {
                    try {
                      await navigator.clipboard.writeText(ts?.up && ts.url ? ts.url : tun.url);
                    } catch {
                      /* 复制不了就算了，地址本身能看 */
                    }
                  },
                },
                '复制',
              ),
            ),
          );
        }

        if (pairing.open) {
          rows.push(
            h(
              'div',
              { key: 'qr', style: { display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 10 } },
              h('img', {
                src: `${API}/qr.svg?t=${encodeURIComponent(pairing.code ?? '')}`,
                alt: '配对二维码',
                width: 148,
                height: 148,
                style: { width: 148, height: 148, borderRadius: 8, background: '#fff', padding: 4, flex: '0 0 auto' },
              }),
              h(
                'div',
                { style: { fontSize: 12, color: T.muted, lineHeight: 1.8 } },
                h('div', null, '用手机相机扫左边的码，或手动打开上面的地址。'),
                h(
                  'div',
                  { style: { marginTop: 6, color: T.text } },
                  '配对码 ',
                  h('span', { style: { letterSpacing: 2, fontWeight: 600 } }, pairing.code ?? '—'),
                ),
                h('div', null, `过期 ${fmtTime(pairing.expiresAt)}（还剩 ${fmtLeft(pairing.expiresAt) || '—'}）`),
              ),
            ),
          );
        } else {
          rows.push(
            h(
              'div',
              { key: 'nopair', style: { fontSize: 12, color: T.muted, marginBottom: 10 } },
              '配对窗口关着：手机配对成功后配对码会自动作废，这是设计好的。要给新手机配对就点「换个配对码」。',
            ),
          );
        }

        rows.push(
          h(
            'div',
            { key: 'actions', style: { display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' } },
            h(Btn, { kind: 'primary', disabled: busy, onClick: () => run(() => post('/pair', {})) }, '换个配对码'),
            h(Btn, { disabled: busy, onClick: () => run(() => post('/stop', {})) }, '停止'),
          ),
        );

        rows.push(
          h(
            'div',
            { key: 'devices', style: { borderTop: `1px solid ${T.border}`, paddingTop: 8, fontSize: 12 } },
            h('div', { style: { color: T.muted, marginBottom: 4 } }, `已配对设备${pairedCount === null ? '（接管实例，未知）' : ` · ${pairedCount}`}`),
            pairedCount === 0
              ? h('div', { style: { color: T.muted } }, '还没有配对过手机')
              : (snap?.devices ?? []).map((d) => h(DeviceRow, { key: d.id, d, busy, onRevoke: () => run(() => post('/revoke', { id: d.id })) })),
          ),
        );
      }

      return h(
        'div',
        {
          style: {
            width: 384,
            maxWidth: 'calc(100vw - 32px)',
            maxHeight: 'calc(100vh - 96px)', // 浮层贴着输入框上方（bottom:72），再留 24 的呼吸
            overflowY: 'auto',
            background: T.card,
            color: T.text,
            border: `1px solid ${T.border}`,
            borderRadius: 12,
            padding: 14,
            boxShadow: '0 18px 48px rgba(0,0,0,0.45)',
            fontFamily: 'inherit',
          },
        },
        rows,
      );
    }

    function DropSluiceDock() {
      const [open, setOpen] = useState(false);
      const [mounted, setMounted] = useState(false);

      useEffect(() => setMounted(true), []);

      const button = h(
        'button',
        {
          type: 'button',
          onClick: () => setOpen((v) => !v),
          title: '把这台电脑的文件传到手机（局域网、原样不压缩）',
          style: {
            font: 'inherit',
            fontSize: 12,
            lineHeight: '20px',
            padding: '2px 8px',
            borderRadius: 6,
            cursor: 'pointer',
            background: 'transparent',
            color: 'inherit',
            border: `1px solid ${T.border}`,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            opacity: 0.9,
          },
        },
        h('span', { 'aria-hidden': 'true' }, '📱'),
        h('span', null, '传到手机'),
      );

      const overlay = open
        ? h(
            'div',
            {
              style: {
                position: 'fixed',
                right: 16,
                bottom: 72,
                zIndex: 60,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-end',
              },
            },
            h(Panel, { onClose: () => setOpen(false) }),
          )
        : null;

      const floating =
        overlay && mounted && createPortal && typeof document !== 'undefined' && document.body
          ? createPortal(overlay, document.body)
          : overlay;

      return h(React.Fragment, null, button, floating);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'phone-drop', order: 6 },
            DropSluiceDock,
          ),
        );
      },
    };
  },
});
