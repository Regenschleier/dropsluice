# DropSluice 详情

一个 DSH bundle，同时也是一份能独立跑的文件服务。装上之后，输入框上方多一个「📱 传到手机」按钮：点开就是配对二维码，手机扫一次，之后就能在手机上浏览这台电脑的磁盘、原样下载文件、把文件传回来。

## 分成两半

| | 跑在哪 | 干什么 |
| --- | --- | --- |
| Host 半（`index.js`） | DSH 主进程 | 起/停 LAN 文件服务；给面板提供同源接口；注册 `phone_drop` 工具给 agent |
| Client 半（`client.js`） | 网页 | 在 `conversation.composer.dock` 放一个按钮；点开是浮层面板（portal 到 `document.body`） |

两半之间没有 IPC：Client 直接 `fetch('/phone-drop/state')`，Host 用 `webServer.register({kind:'prefix', path:'/phone-drop'})` 提供这些接口。好处是不用管 CORS、不用第二份状态、也不会出现"面板显示的和真实状态不一致"。

真正给手机用的服务是**另一个端口**（默认 18888），由 Host 半在 `apply()` 之后按需启动 —— 没点「传到手机」就不占端口，`stop` 就把端口还回去。

## 面板接口（只在电脑本机可用）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/phone-drop/state` | 运行状态、局域网地址、配对窗口、已配对设备、防火墙命令 |
| POST | `/phone-drop/start` | 启动（可选 `{port}`）；端口被占时尝试接管已在跑的那个实例 |
| POST | `/phone-drop/stop` | 停止并释放端口 |
| POST | `/phone-drop/pair` | 换新配对码（返回新状态；二维码用下面的 svg 取） |
| POST | `/phone-drop/revoke` | `{id}` 解除某台设备 |
| GET | `/phone-drop/qr.svg` | 当前配对码的二维码（SVG，512px） |

**为什么只给本机**：这些接口会吐出配对码，等于把"钥匙"放在兜里。DSH 的网页虽然现在只听 `127.0.0.1`，但它的 Mobile Access 会把同一个 origin 代理到局域网，而插件路由不在网页自己的令牌门后面。所以每个请求都检查 `Host` 头必须是回环地址，并且没有 `X-Forwarded-*`；否则 403。

`/phone-drop/state` 里每台设备的形状（`devicesDetailed()` 组装）：

```json
{
  "id": "6f1c…", "name": "我的手机",
  "ip": "192.168.1.20", "ipChangedAt": 1764050400000, "iface": "WLAN",
  "client": { "kind": "phone", "model": "iPhone", "os": "iOS 18.1", "browser": "Safari",
              "label": "iPhone · iOS 18.1 · Safari" },
  "network": { "kind": "lan", "iface": "WLAN", "ssid": "MyWiFi-5G" },
  "location": null,
  "createdAt": 1764046800000, "lastSeenAt": 1764050400000
}
```

- 公网设备（`network.kind === 'public'`）才有 `location`：`{place:'中国 · 上海', isp:'China Telecom', source:'ip-api.com', at}`，24 小时缓存。查询本身会把对端公网 IP 发给第三方，这点在 README 里明写了。
- `iface` 是**手机连进来的那条网卡**（用 `req.socket.localAddress` 反查），不是手机自己的网卡——手机那边的信息只能靠 UA 猜。
- `describeDevices()` 里永远不含 `tokenHash`，面板拿到的数据就算被截图/转发也换不到令牌。

## 每台设备的地域为什么只能是"同一局域网"

手机走局域网连进来时，服务端看到的 `remoteAddress` 是内网地址（`10.*`/`192.168.*`/`172.16–31.*`）。内网地址在每个 IP 库里都没有城市——NAT 后面的话全世界有无数台设备共用同一段。所以：

- 内网 → `network.kind='lan'`，面板显示「同一局域网 · Wi-Fi <ssid>」，`location` 保持 `null`，**不发任何外部请求**。
- 公网 → 才调 `lib/geo.mjs`（`ip-api.com` 中文优先，失败退 `ipwho.is`），拿不到就 `place:null`，面板写「归属地查不到」，功能不受影响。
- 手机真实 GPS 位置：浏览器只在 HTTPS 页面允许 `navigator.geolocation`，局域网 `http://` 直接拒绝。要做必须给手机端上自签证书 + 手动信任，代价大，所以刻意不做。

## 手机端接口（默认 18888 端口，配对后才可用）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` `/pair` | 文件列表页 / 配对页 |
| GET | `/qr.svg` | 配对二维码（**仅回环**，手机上的页面看不到它） |
| GET | `/api/pairing` | 当前配对码与 URL（**仅回环**） |
| POST | `/api/pairing/open` | 换一张新码（**仅回环**） |
| POST | `/api/pair` | `{code, name}` 用 6 位码换设备令牌（限速：5 分钟 5 次错码） |
| GET | `/api/me` | 我是哪台设备 |
| POST | `/api/unpair` | 删除自己这条设备记录 |
| GET | `/api/roots` | 盘符 + 常用目录 |
| GET | `/api/list?path=` | 列目录（目录优先，最多 3000 条，带 `truncated`） |
| GET/HEAD | `/api/download?path=` | 单文件下载，支持 `Range`（206），`filename*=UTF-8''` |
| GET | `/api/zip?path=` | 整个目录流式打包（store 模式，chunked，不落临时文件） |
| POST | `/api/upload?path=` | 上传：`x-file-name` 头 + 原始 body，重名自动加 ` (n)` |

身份：Cookie `pd_session`（HttpOnly、SameSite=Lax、1 年）或 `Authorization: Bearer <token>`。

## 安全模型（和 Steam 令牌同一套路）

1. 电脑上开一个 10 分钟的配对窗口，窗口里只有一个 6 位数字码（`crypto.randomInt`），服务端存的是这个码的**哈希**。
2. 手机拿码换令牌：`pd_` + 24 字节随机数。服务端只存令牌的 SHA256 —— 就算 `.data/state.json` 被读走，也反不回可用的令牌。
3. **一次性**：配对成功立刻作废这张码并关窗口。第二台手机要重新开窗口。
4. 输错 5 次（同 IP、5 分钟）锁 5 分钟。只有"码本身错"才计数，窗口过期/已关闭不算（这条是实测发现并修的 bug，否则用户手慢一点就被锁）。
5. 解除配对 = 删记录，令牌立刻失效（有自测覆盖）。

## 为什么自己写二维码编码器

不想为了一个配对页引第三方依赖。`lib/qr.mjs` 是完整实现：Byte 模式、纠错等级 M、版本 1–10、Reed-Solomon（GF(256)）、对齐图形、8 种掩码 + 罚分选优、格式信息 BCH(15,5) + 掩码异或 `0x5412`、版本信息 BCH(18,6)。

验证方式不是"看起来像"，是逐格比对：

- Reed-Solomon 单元先用 ISO/IEC 18004 的已知向量验证：数据 `10 20 0C 56 61 80 EC 11 EC 11 EC 11 EC 11 EC 11`、10 个纠错码字，算出 `a5 24 d4 c1 ed 36 c7 87 2c 55`，与标准答案一致。
- 再拿 `python-qrcode` 当基准：16 组文本（1–213 字节，含中文和 emoji）× 8 种掩码 = **128 个矩阵逐格完全一致**（`python-qrcode` 必须用 `QRData(raw, mode=MODE_8BIT_BYTE)` 强制 byte 模式，否则它会自己换模式，比出来的差异是假的）。
- 每个矩阵再用 `zxing-cpp` 解码，全部读回原文。
- 注意：`segno` 不适合当逐格基准，它在 v2 以上会换填充策略，解码结果对但矩阵不同。

## 实现上几个不显然的点

- **zip 为什么是 store 模式**：用户要的是"原样传输"。用 deflate 压一遍再解开，字节也一致，但会多耗 CPU、让下载变慢、而且"压缩过"这件事本身就让人怀疑有没有动过内容。store 模式每个文件就是原封不动的字节，跳过 >4 GB 的文件（没实现 zip64）。
- **local header 的 flag 用 `0x0808`**：bit3 = 后面有 data descriptor（因为流式发送时还不知道 CRC 和大小），bit11 = 文件名是 UTF-8（中文名必须开，否则 Windows 解压会乱码）。
- **`Cache-Control: no-store, no-transform`**：防止中间层（尤其是浏览器扩展、代理）改写响应体。
- **列目录跳过隐藏项和 `System Volume Information`/`$RECYCLE.BIN`**：回收站和系统卷信息里有权限拒绝，逐个 stat 会让整页卡住。
- **局域网地址挑选给虚拟网卡降权**：Hyper-V `Default Switch`、WSL、VMware 的地址（常见 `172.x`、`192.168.56.x`）手机连不通，优先 `192.168.*`/`10.*`。挑错时用户得手动换 IP，README 里写了怎么查。
- **`X-File-Name` 而不是 multipart**：手机页面用 `fetch(body: file)` 直接发原始字节，省掉 multipart 解析（服务端零依赖，不值得为它写一个 parser）。

## 打包成可分发的东西（电脑端 + 手机端）

同一套代码有四种"跑起来"的形态，功能完全一样：

| 形态 | 入口 | 说明 |
| --- | --- | --- |
| DSH 插件 | `index.js` + `client.js` | 在 DSH 网页里点按钮；服务由 Host 半起 |
| 命令行 | `server.mjs` | 纯 Node，终端里画二维码 |
| 单文件 exe | `desktop/main.mjs` → SEA | 内嵌 Node 运行时 + 六个网页资源，双击就跑 |
| APK | `android/` | WebView 外壳 + CameraX 扫码，打开上面那套手机网页 |

打包相关的几个实现点：

- **SEA 里没有 `import.meta.url`**：bundle 成 CJS 之后这个符号为空，所以 `lib/root.mjs` 里 `appRoot()` 先 try `fileURLToPath(import.meta.url)`，失败就退回 `path.dirname(process.execPath)`——exe 场景下就是"exe 所在目录"。
- **数据目录是"逐级试写"挑出来的**，不是写死一个路径：`DROPSLUICE_HOME` → `%LOCALAPPDATA%\DropSluice` → exe 旁边 `.data` → 临时目录，每个候选都 `mkdir` + 写一个探针文件再删掉，第一个真能写的胜出（结果缓存）。原因很具体：某些机器/安全策略下 `%LOCALAPPDATA%\DropSluice` 的 `mkdir` 会直接 `EPERM`，写死的话 exe 一启动就崩、窗口一闪就没。选中路径会打印在终端 banner 和面板上。
- **所有退出路径都要"等一次回车"**（`desktop/main.mjs` 的 `pauseIfInteractive()`）：双击启动时控制台是进程自己的窗口，进程一退窗口立刻消失，用户什么都看不到。判断条件是 `process.stdin.isTTY`，所以被脚本/自测拉起时不会卡住；`DROPSLUICE_NO_PAUSE=1` 可跳过（`一键开始.bat` 就是这么用的，它自己 `pause`）。
- **端口被占时的两条路**：占着 18888 的如果是另一个 DropSluice（比如 DSH 插件那半），就打它的 `/api/admin/state` 拿来配对码、打开它的面板、然后停在自己的暂停提示上；如果是别的程序，自动往后试 18889…18897，并把换端口的事写进窗口。
- **静态资源走 `assets` 注入**：`serveStatic()` 先查内存里的 `assets`（exe 内嵌），再查磁盘上的 `public/`、`desktop/`。所以同一份 `app.mjs` 在源码和 exe 里都能跑。
- **打包版自带一个本机面板**（`/desktop` + `/api/admin/*`），因为它不跑在 DSH 里、没有 composer dock 可挂。`/api/admin/*` 和插件面板一样只认回环 `Host`。
- **rcedit 必须在 postject 之前**：先注入 90 MB blob 再改 PE 资源，rcedit 会卡死（实测 `ETIMEDOUT`）。而且直接调 `rcedit-x64.exe`，不走 npm 包装层（那层在这台机器上会挂起）。
- **安装包用 Inno 的多模式**：`PrivilegesRequired=lowest` + `PrivilegesRequiredOverridesAllowed=dialog`，让用户自己选「所有用户」（UAC → Program Files）还是「只为我」（`%LOCALAPPDATA%\Programs`）。防火墙那条 `netsh` 带 `Check: IsAdminMode`，权限不够时干脆不显示，避免装完弹一个必然失败的步骤。
- **APK 不重做 UI**：只做「扫码 → 记住地址 → WebView 打开」。这样手机端和电脑端永远同一份页面，不用维护两套；下载交给系统 `DownloadManager`，文件名用 `URLUtil.guessFileName()` 保留原样。

## 自测

```powershell
node verify/e2e.mjs                          # 23 项端到端（自己起临时端口的服务）
node verify/exe-e2e.mjs                      # 18 项对 dist/DropSluice.exe 的端到端
node verify/device-info.mjs                  # 30 项设备信息（UA / 内网判定 / 清单字段 / 归属地）
node verify/all.mjs; python verify/all.py    # 二维码 128 格逐格比对
node verify/terminal-qr.mjs                  # 终端二维码画法回归
python verify/decode-panel-qr.py <svg>       # 面板二维码栅格化 + zxing 解码
```

`e2e.mjs` 覆盖的正面结论：

- 4.5 MB 文件下载后 SHA256 与源文件相同
- `Range` 四段拼接后逐字节等于原文件
- 文件夹 zip 打包后 `Expand-Archive` 解开逐字节相同（含中文名、空文件、二进制）
- 上传字节完全相同；重名不覆盖
- 配对码一次性；解除配对后旧令牌 401

## 限制（先说清楚）

- 只做局域网，没有 TLS、没有公网穿透。外网要用自己套 VPN。
- 没有 zip64：单文件 > 4 GB 打包时会被跳过（直接下载单个文件不受影响）。
- 目录列表最多 3000 条，超出会标 `truncated`，靠手机页面上的筛选框缩小范围。
- 面板的长相是用 `verify/panel-harness/`（真 `client.js` + 真 react + 假数据）截图核对的，**没有在真 DSH 页面里点开过**（DSH 网页需要启动令牌才能登录）；真机扫码也没有实测。截图见 `verify/shots/`。
- 归属地的线上表现没测：面板上那台"公网设备"是假数据（`203.0.113.42` 是文档专用地址）；离线脚本只验过 `1.1.1.1` 能查到「澳大利亞 · Queensland · South Brisbane」。
- 设备名靠 UA：浏览器把 UA 改掉或隐私模式屏蔽 UA，就只能显示「未知设备」；这不影响权限和解除。
- **安装包（Setup.exe）的安装过程没能在本机跑通**：Inno 的安装进程在这台机器上写 `Program Files` / `%LOCALAPPDATA%\Programs` / `HKCU\...\Uninstall` 一律 `错误 5`，连三行的最小脚本也一样——本机环境限制（DSH 的进程全提权，Inno 切到的受限令牌被拒），不是脚本问题。绿色包（`dist/DropSluice-1.0.1-portable.zip`）已实测可跑。
- **APK 没在真手机装过**：产物、签名、manifest 都验了，相机预览与扫码这条链路需要真机确认一次。
