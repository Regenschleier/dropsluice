/**
 * 磁盘空间闸门自测：声明的文件比剩余空间还大时，服务端必须先回 507，
 * 而不是让手机白传一半。
 *
 *   node verify/space.mjs
 *
 * 做法：起一个临时服务，上传上限放到 1 PB，然后用裸 http 声明一个
 * 「比这台机器剩余空间大得多」的 Content-Length（10 PB），只发头不发体。
 * 期望：507 + { error: 'no_space' }，且连接在响应后就能断，不会把 10 PB 收进来。
 */
import http from 'node:http';
import { startDropSluice } from '../lib/app.mjs';

let pass = 0;
let fail = 0;

function ok(name, detail = '') {
  pass++;
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
}

function bad(name, detail = '') {
  fail++;
  console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

const PORT = 18997;
const HUGE = 512 * 1024 ** 4; // 512 TB：比这台机器的盘大得多，又没到 1 PB 的上限

const server = await startDropSluice({
  port: PORT,
  host: '127.0.0.1',
  openPairing: true,
  maxUploadBytes: 1024 ** 5, // 让 413 那一关先放过它，好走到空间检查
  log: () => {},
});

// 配对拿 cookie
const state = await (await fetch(`http://127.0.0.1:${PORT}/api/admin/state`)).json();
const pair = await fetch(`http://127.0.0.1:${PORT}/api/pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: state.pairing.code, name: 'space-test' }),
});
const cookie = (pair.headers.getSetCookie?.() ?? []).join(';').match(/pd_session=([^;]+)/)?.[1];
if (!cookie) throw new Error('没拿到配对 cookie');

const target = encodeURIComponent(process.cwd());

function uploadAttempt() {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        method: 'POST',
        path: `/api/upload?path=${target}`,
        headers: {
          cookie: `pd_session=${cookie}`,
          'x-file-name': encodeURIComponent('space-probe.bin'),
          'content-type': 'application/octet-stream',
          'content-length': String(HUGE),
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on('error', reject);
    // 只发头，不发体：服务端在看到 Content-Length 时就该拒了
    req.flushHeaders();
    setTimeout(() => req.destroy(), 3000);
  });
}

try {
  const r = await uploadAttempt();
  let data = null;
  try {
    data = JSON.parse(r.body);
  } catch {
    // 非 JSON 也算失败，下面统一报
  }
  if (r.status === 507 && data?.error === 'no_space') {
    ok('声明 10 PB 时先回 507 no_space', data.message || '');
  } else {
    bad('声明 10 PB 时先回 507 no_space', `实际 ${r.status} ${r.body?.slice(0, 120)}`);
  }
  if (typeof data?.shortfall === 'number' && data.shortfall > 0) {
    ok('shortfall 给了还差多少字节', `${Math.round(data.shortfall / 1024 ** 3)} GB`);
  } else {
    bad('shortfall 给了还差多少字节', JSON.stringify(data));
  }
} finally {
  await server.close();
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
