# 不在同一个 Wi-Fi 也能传：开公网地址（Cloudflare 快速隧道）

> 这篇只讲**公网地址**这条路：手机不用装任何东西，什么网络都能连。
> 想要「只有自己人可达、地址固定」的，看 [remote-tailscale.md](remote-tailscale.md)。

## 这页解决什么

手机和电脑不在同一个网络（手机用流量、连别人家的 Wi-Fi、公司网），又要传文件。局域网地址（`192.168.x.x`）在这时完全不可达，Tailscale 又要求两端都装并登录同一个账号——如果对面那台手机不方便装东西，就只剩公网这条路。

做法：在电脑面板上点一下「**开公网地址**」，DropSluice 自己拉起 `cloudflared` 快速隧道，把本机 `18888` 端口挂到一个临时 HTTPS 域名上；手机扫那张码就连上了。

## 它到底做了什么

1. `POST /api/admin/tunnel/start`（只在电脑本机可用）；
2. 服务 `spawn` 一个 `cloudflared tunnel --url http://127.0.0.1:18888 --no-autoupdate` 子进程；
3. 从它的输出里抓 `https://<随机词>.trycloudflare.com`，存进状态；
4. 面板用 `/qr.svg?target=tunnel` 画「域名 + 当前配对码」的二维码。

隧道是**服务的子进程**：点「关掉公网地址」或停服务，`close()` 里会 `tunnel.stop()` 把它杀掉，不会留孤儿进程。日志在数据目录的 `tunnel.log`。

## 电脑端准备（一次性）

有 `cloudflared` 就行，三种装法任选：

```powershell
winget install --id Cloudflare.cloudflared -e
```

或从 Cloudflare 官网下载 `cloudflared-windows-amd64.exe`，改名 `cloudflared.exe` 放进 `PATH` 里某个目录。

或完全不放进 PATH，用环境变量指过去：

```powershell
setx DROPSLUICE_CLOUDFLARED "D:\tools\cloudflared\cloudflared.exe"
```

没装的时候，面板那张卡片会写「没装 cloudflared」；点开会返回 503 `tunnel_unavailable`，**不会把服务搞挂**，局域网照常。

## 手机端

1. 装 DropSluice App（[README 的下载区](../README.md#-直接下载v1011)）；
2. 电脑面板点「开公网地址」，等卡片上出现二维码和 `https://xxx.trycloudflare.com`；
3. App 里点扫码，扫这张码。

**不用装 Tailscale，也不用和电脑同一个 Wi-Fi。**

## 域名为什么每次都变

`trycloudflare.com` 的临时域名是 Quick Tunnel 每次随机生成的，**关掉或重启电脑就换一个**。所以：

- 手机里别存这个地址，每次扫新的码；
- 配对 Cookie 是**绑 origin 的**：换了域名就相当于换了站点，要重新扫一次码（这也是为什么「昨天那个链接今天打不开」）。

想固定域名只有一条路：用 Cloudflare **具名隧道**（Named Tunnel）——要你自己的域名托管在 Cloudflare、建一个 tunnel、拿它的 token：

```powershell
setx DROPSLUICE_TUNNEL_TOKEN "<token>"
setx DROPSLUICE_TUNNEL_URL "https://files.example.com"
```

这时 `cloudflared` 走的是 `tunnel run --token`，地址由你的域名决定，`DROPSLUICE_TUNNEL_URL` 只是告诉面板「怎么显示、二维码画哪个地址」。

## 安全：公网能看到什么

| 路径 | 从公网访问 |
| --- | --- |
| `/`（文件页面） | 未配对 → 302 到 `/pair` |
| `/pair`、`/pair.js` | 200，配对页本身 |
| `/desktop`（面板） | **403**，只允许本机 |
| `/api/admin/*` | **403**，只允许本机 |
| `/apk`、`/style.css` | 200（引导页要用） |
| `/api/download`、`/api/upload*` | 需要配对 Cookie，否则 401 |

也就是说：**公网只多了一条「配对入口」**，配对码还是 6 位、10 分钟有效、一次性；配对成功的设备才有 Cookie。隧道不改变「谁能进门」这件事。

## 排查表

| 现象 | 可能原因 | 怎么办 |
| --- | --- | --- |
| 卡片不存在 | 面板版本太旧 | 升级到 1.0.11+ |
| 卡片写着「没装 cloudflared」 | PATH 里找不到 | `winget install --id Cloudflare.cloudflared`，或设 `DROPSLUICE_CLOUDFLARED` |
| 点开公网地址报 503 `tunnel_unavailable` | 同上 | 同上 |
| 一直转圈「正在开…」 | Cloudflare 侧慢 / 本机出网被拦 | 看数据目录 `tunnel.log`；公司网可能需要放行 `*.argotunnel.com` |
| 手机扫了码打不开 | 域名变了 / 隧道已关 | 重新点开公网地址，扫新码 |
| 手机能开配对页，配对后 401 | Cookie 是旧域名留下的 | 清 App 数据或换手机重扫 |
| 速度很慢 | 走 Cloudflare 中转 | 同网时优先用局域网码；要快又固定就用 Tailscale |

## 和 Tailscale 怎么选

| | 公网地址 | Tailscale |
| --- | --- | --- |
| 手机装什么 | 只装 App | App + Tailscale |
| 跨任意网络 | ✅ | 仅限同一个 Tailnet |
| 地址固定 | ❌（具名隧道可以） | ✅ |
| 谁能连 | 有地址 + 配对码的人 | 只有你 Tailnet 里的设备 |
| 速度 | 中转，慢一些 | 直连时快 |

## 已经实测到哪一步（2026-11-25）

- ✅ 用真实 `cloudflared` 起过隧道：5 秒拿到域名、`/qr.svg?target=tunnel` 200、`stop` 后子进程退出；
- ✅ 公网访问 `/desktop`、`/api/admin/state` 一律 403；
- ✅ 没装 cloudflared 时 `POST /api/admin/tunnel/start` 返回 503 `tunnel_unavailable`，服务不受影响；
- ❌ 真手机用流量扫码连上去传文件，还没走过（需要在手机上验）。
