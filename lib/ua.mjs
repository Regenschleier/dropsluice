/**
 * 从 UA 里读出"这是台什么设备"。
 *
 * 不做指纹识别，只做一眼能认的程度：iPhone / 小米 · Android 14 / Windows · Edge。
 * 拿不到就老实说"未知设备"，不猜。
 */

const BROWSERS = [
  [/EdgA?\/(\d+)/, 'Edge'],
  [/OPR\/(\d+)/, 'Opera'],
  [/MicroMessenger\/(\d+)/, '微信'],
  [/QQBrowser\/(\d+)/, 'QQ 浏览器'],
  [/UCBrowser\/(\d+)/, 'UC'],
  [/Firefox\/(\d+)/, 'Firefox'],
  [/CriOS\/(\d+)/, 'Chrome'],
  [/Chrome\/(\d+)/, 'Chrome'],
  [/Version\/(\d+).*Safari/, 'Safari'],
  [/Safari\/(\d+)/, 'Safari'],
];

function androidModel(ua) {
  // "Mozilla/5.0 (Linux; Android 14; 2211133C Build/UKQ1...)" → 2211133C
  const m = ua.match(/Android\s+([\d.]+)[^;)]*;\s*([^;)]+?)(?:\s+Build[/;]|\))/i);
  if (m) return { os: `Android ${m[1]}`, model: m[2].trim() };
  const plain = ua.match(/Android\s+([\d.]+)/i);
  return plain ? { os: `Android ${plain[1]}`, model: null } : null;
}

/** "CPU iPhone OS 18_1 like" → "iOS 18.1" */
function iosVer(ua, prefix) {
  const v = ua.match(/OS (\d+[_\d]*)/)?.[1];
  return v ? `${prefix} ${v.replace(/_/g, '.')}` : prefix;
}

export function describeDevice(ua) {
  const s = String(ua ?? '');
  if (!s) return { kind: 'unknown', label: '未知设备' };

  const browser = BROWSERS.find(([re]) => re.test(s))?.[1] ?? null;

  if (/iPhone/i.test(s)) return pack('phone', 'iPhone', iosVer(s, 'iOS'), browser);
  if (/iPad/i.test(s)) return pack('tablet', 'iPad', iosVer(s, 'iPadOS'), browser);
  if (/iPod/i.test(s)) return pack('phone', 'iPod touch', null, browser);

  const android = androidModel(s);
  if (android) {
    return pack(
      /Mobile/i.test(s) ? 'phone' : 'tablet',
      android.model ?? 'Android 设备',
      android.os,
      browser,
    );
  }

  if (/Windows NT 10\.0/i.test(s)) return pack('desktop', 'Windows 10/11 电脑', null, browser);
  if (/Windows/i.test(s)) return pack('desktop', 'Windows 电脑', null, browser);
  if (/Macintosh|Mac OS X/i.test(s)) return pack('desktop', 'Mac', s.match(/Mac OS X (\d+[_.\d]*)/)?.[1]?.replace(/_/g, '.'), browser);
  if (/Linux/i.test(s)) return pack('desktop', 'Linux 电脑', null, browser);

  return { kind: 'unknown', label: '未知设备', browser };
}

function pack(kind, model, os, browser) {
  const label = [model, os, browser].filter(Boolean).join(' · ');
  return { kind, model, os: os ?? null, browser, label };
}
