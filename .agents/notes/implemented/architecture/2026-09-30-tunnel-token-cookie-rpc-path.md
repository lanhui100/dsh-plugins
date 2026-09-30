# Agent Note: Tunnel token-cookie RPC path to the remote DSH

Status: implemented

## Problem

`dsh-plugin-remote-ssh` 需要一条经 SSH 到达远端 DSH（dev，`127.0.0.1:3080`，0.2.0-rc.2）`/api` 的 server-side 调用路径。此前未知：隧道是否可行、cookie authority 绑定是否阻断转发、RPC 线格式为何。

## Decision

采用"SSH 本地转发 + launch-token 换 cookie + 携带 cookie 调 RPC"路径，全部环节已在 0.2.0-rc.2 上实测打通：

- 隧道：`ssh -N -o ExitOnForwardFailure=yes -o BatchMode=yes -L 39387:127.0.0.1:3080 dev`；Windows 下以独立进程启动，认证需约 50 秒，之后 `127.0.0.1:39387` 监听成立。
- 换 cookie：经隧道 `GET /?token=<launch-token>` 返回 303 + `Set-Cookie: dsh-auth-*`。cookie 的 authority 绑定的是隧道本地 authority（`127.0.0.1:39387`），天然可用——此前"远端签发 cookie 在本地失效"的担忧不成立（失效只发生在把远端 authority 下签发的 cookie 搬到本地用的情形；经隧道交换不存在该情形）。
- 调 RPC：`POST /api/<namespace>/<method>`，body 为 `{"type":"client-request","rpcId":…,"method":"<namespace>/<method>","payload":{"args":{…}}}`（payload 必须恰好含一个 plain-object `args` 字段；`session/list` 需 `args._request`）。实测 `session/list` 返回远端真实会话（含 sessionId/cwd/projections）。
- launch token 来源：远端 dsh web 启动日志的 `dsh web: http://127.0.0.1:3080/?token=…` 行（进程级内存值，重启轮换）；经 SSH 读取。插件策略为"读日志→换 cookie→401 则重读重换"。
- 不复用官方 `dsh-ssh`（专用执行通道，要求远端 helper 与 POSIX，见该包 `Config`），不直读远端签名密钥（`~/.dsh/.credentials.yaml`，无必要且越权）。

## Alternatives considered

- 复用官方 `dsh-ssh` 的 `ctx.ssh`：面向远程命令执行而非 HTTP 转发，且本地为 Windows；落选。
- 直读远端 cookie 签名密钥并本地签发 cookie：需读取远端凭证文件，越权且脆弱（密钥轮换即失效）；落选。token 交换是官方支持的入口（`BrowserAuth.authorizeIndex`）。
- 经隧道复用远端浏览器 cookie：authority 绑定使跨 authority 搬运不可行；落选（本路径改为在隧道 authority 下重新交换，不存在搬运）。

## Consequences

- 隧道子进程管理（就绪探测/保活/退避重连/释放）由插件自建（`packages/dsh-plugin-remote-ssh/src/tunnel.ts`）。
- 远端 RPC 调用封装在 `packages/dsh-plugin-remote-ssh/src/remote.ts`（token 读取、cookie 交换、信封编解码、401 重换）。
- 远端服务重启会轮换 token：调用层必须把 401 视为"重换 cookie"信号而非致命错误。
