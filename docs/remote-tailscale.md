# 不在同一个 Wi-Fi 也能传：手机用流量 / 异地（Tailscale）

这一页只讲一件事：**手机不在家里那个 Wi-Fi 里**（开流量、在公司、在外面），怎么让它连上自己电脑上的 DropSluice。

局域网那套（同一个 Wi-Fi 扫码就传）是默认用法，不在这一页。这一页是「跨网」这条线。

---

## 0. 先说清楚这条路是怎么走的

DropSluice 本身只做一件事：在电脑上开一个 `18888` 端口的服务。**它自己不穿透公网、不做端口映射**——所以默认情况下，手机一旦离开同一个 Wi-Fi 就连不上。

跨网的做法有两种思路：

| 思路 | 例子 | 代价 |
| --- | --- | --- |
| 把端口开到公网 | 路由器端口映射、frp、ngrok、Cloudflare Tunnel | 公网任何人都能敲这个端口，必须自己再加一层访问控制，配错就是把整台电脑的文件目录挂在网上 |
| 组一个虚拟内网 | **Tailscale**（本项目用的）、ZeroTier | 两端都要装一个客户端并登录同一个账号；不装的人连地址都看不见 |

DropSluice 选的是第二种。理由很简单：

1. **默认就不对公网开放**。那条 `100.x` 地址只在你自己账号的虚拟内网里可路由，公网上扫不到、也 ping 不通。
2. **加密是现成的**。Tailscale 底层是 WireGuard，端到端加密，传输的字节不经过任何中转服务器的明文。
3. **客户端零开发**。不用自己写穿透、不用申请域名和证书，装完登录就能用。

代价也要说在前面：**两台设备都要装 Tailscale 并登录同一个账号**。这不是「扫码就能用」，是一次性配置。

---

## 1. 电脑端（只做一次）

### 1.1 装

```powershell
winget install --id Tailscale.Tailscale -e --accept-package-agreements --accept-source-agreements
```

- 这一步在干什么：从微软的包管理器装 Tailscale 官方的 Windows 客户端，同时会注册一个叫 `Tailscale` 的后台服务。
- 为什么用 winget：不用去官网下安装包、不用担心下到假的；装完服务会自己起来。
- 装完怎么确认：`Get-Service Tailscale` 应该看到 `Running`。

### 1.2 登录

```powershell
tailscale up --accept-dns=false --hostname=dropsluice-pc
```

- 这一步会打印一条 `https://login.tailscale.com/a/...` 的链接，**在浏览器里打开它**，用你的账号（GitHub / Google / 微软都行）登录并授权。
- `--accept-dns=false`：不让 Tailscale 接管系统 DNS。**这一条别去掉**——接管 DNS 会改掉整台电脑的域名解析行为，出问题时很难查。
- `--hostname=dropsluice-pc`：这台电脑在虚拟内网里的名字，后面面板上显示的就是它。

### 1.3 确认真的拿到地址了

```powershell
tailscale status
```

正常的输出里能看到自己这台机器和它的 `100.x.y.z` 地址、状态是 `Running`。更精确的检查：

```powershell
tailscale status --json | Select-String '"BackendState"|"DNSName"'
```

`BackendState` 应该是 `Running`，`DNSName` 是 `你的主机名.你的内网域名.ts.net`。

> 这一页里所有 `100.x.y.z` 和 `xxx.ts.net` 都是占位符，你机器上看到的是另一串——**照抄你自己屏幕上的**。

---

## 2. 手机端（只做一次）

1. 装 Tailscale：应用商店搜 `Tailscale`（iOS / Android 都有）。
2. 打开它，**登录同一个账号**（和电脑上那个账号必须一样，不然是两个互不相通的内网）。
3. 把开关打开，确认列表里能看到你那台电脑（名字是你在 1.2 里写的 `--hostname`）。

手机上装完不用配任何 IP——Tailscale 会给它一个 `100.x` 地址，两边自动能互相找到。

---

## 3. 在 DropSluice 里用这条线

电脑端启动服务之后，三个地方都会给出「跨网」这条地址（前提是 1.3 里检查过、Tailscale 在跑）：

| 在哪看 | 看到什么 |
| --- | --- |
| 电脑上的面板（`http://127.0.0.1:18888/desktop`） | 第二张卡片「不在同一个 Wi-Fi？用这条地址」，带二维码和 `http://100.x.y.z:18888/` |
| 终端窗口（`node server.mjs` 或 exe 启动时的横幅） | 「不在同一个 Wi-Fi？」一段，含地址和一键配对链接 |
| DeepSeek Harness 输入框上方的浮层 | 地址行下面多一行「…（手机用流量时用这条）」 |

用法和局域网一模一样：**手机先开 Tailscale，再打开 DropSluice App，扫那张「跨网」二维码**。

> 为什么还要扫码：跨网只是把「路」打通了，**进门仍然要配对**。这道闸没变——没配对过的设备读不到任何文件，手机浏览器也还是会被挡在「请用 App 打开」那一页。

---

## 4. 防火墙：为什么还要多一条规则

Windows 防火墙默认只放行「本地子网」的连入。`100.x` 在你的机器看来**不是本地子网**，所以原来的规则会把 Tailscale 的流量挡掉，表现就是「手机明明连着，但一直转圈」。

以管理员身份跑一次（端口不是 18888 就换成你的）：

```powershell
New-NetFirewallRule -DisplayName "DropSluice (Tailscale)" -Direction Inbound -Protocol TCP `
  -LocalPort 18888 -Action Allow -Profile Any -RemoteAddress 100.64.0.0/255.192.0.0
```

逐段解释：

- `-Profile Any`：不管当前网络被 Windows 判成「公用」还是「专用」都放行（换 Wi-Fi 时判定会变）。
- `-RemoteAddress 100.64.0.0/255.192.0.0`：**只放行 Tailscale 的地址段**（`100.64.0.0/10`）。不要省掉这一段——省掉就等于对任何来源开放这个端口。
- 检查是否生效：`Get-NetFirewallRule -DisplayName "DropSluice (Tailscale)"`，`Enabled` 应为 `True`。

---

## 5. 连不上时的排查顺序

按这个顺序查，基本两分钟能定位：

| 现象 | 先查什么 | 怎么查 |
| --- | --- | --- |
| 面板上根本没有「跨网」那张卡片 | Tailscale 是不是没登录 / 没起来 | `tailscale status`，`BackendState` 不是 `Running` 就是没连上 |
| 面板有地址，手机扫码后一直转圈 | 防火墙那条规则 | 第 4 节的两条命令；`Get-NetFirewallRule` 看 `Enabled` |
| 手机上看不到这台电脑 | 两边登录的是不是同一个账号 | 手机上 Tailscale 的机器列表里应该能看到电脑的主机名 |
| 能看到、能连、但很慢 | 是不是走了中继 | `tailscale ping 你的电脑名`，显示 `via DERP` 就是中继，`direct` 才是点对点 |
| 服务自己没开 | 18888 有没有在听 | `Get-NetTCPConnection -LocalPort 18888 -State Listen` |
| App 报明文 HTTP 被拦 | 这条已经处理过，不用你改 | App 的 `network_security_config` 已允许明文（Android 9+ 默认禁止 `http://`），`usesCleartextTraffic="true"` |

---

## 6. 这条线在这台机器上验过什么

写清楚「哪些是实测的、哪些没有」，免得把推断当结论：

**已实测（2026-11-25，Windows 11 + Tailscale 1.104.7）**

- `winget install --id Tailscale.Tailscale -e` 装成功，服务 `Tailscale` 状态 `Running`
- `tailscale up --accept-dns=false --hostname=dropsluice-pc` 授权后用 `tailscale status --json` 读到 `BackendState=Running`、`Self.Online=true`、一个 `100.x` 地址和一个 `xxx.ts.net` 名字
- 防火墙规则 `DropSluice (Tailscale)` 建好后：`Enabled=True`、`Profile=Any`、`TCP/18888`、`RemoteAddress=100.64.0.0/255.192.0.0`
- 服务在 `18888` 上监听时，本机请求 `/api/admin/state` 返回的 `tailnet` 段里有 `up/ip/dnsName/url/pairUrl`
- `/qr.svg?target=remote` 返回 200，二维码内容是指向 `100.x` 的配对链接
- 面板、终端横幅、DSH 浮层三处都显示了这条地址
- 自测覆盖：`100.64/10` 判定的 9 个边界值（`100.64.0.1`、`100.127.255.254` 算内网；`100.63.255.255`、`100.128.0.1`、`192.168.x.x`、`8.8.8.8` 不算），以及状态里带 `tailnet` 段

**未实测（别当结论看）**

- **真手机 + 真流量**：手机装 Tailscale、切流量、扫跨网码、传完一个文件——这条没走过。
- **速度数字**：直连能跑多少、走 DERP 中继能跑多少，没有测过。只知道「直连是点对点、中继会慢」这件事是 Tailscale 的公开机制。
- **iOS 版**：只按公开文档写了「装完登录同一账号」，没有在 iPhone 上实际操作过。

---

## 7. 不想装 Tailscale 的话

`cloudflared`（Cloudflare Tunnel）、`ngrok`、`frp` 也都能把端口开出去，效果上是「手机上知道一个公网地址就能连」。

但它们和 Tailscale 有一个本质区别：**那条地址对公网是可达的**。你必须自己再加一层认证（Cloudflare Access、ngrok 的 basic auth、frp 的 token + TLS），否则任何人扫到端口就能列你整台电脑的目录。

DropSluice 的配对闸门能挡住「读文件」，但**挡不住别人对你的电脑做端口探测和连接尝试**。所以默认推荐还是 Tailscale：它连「能不能连上」这一步都不对外暴露。
