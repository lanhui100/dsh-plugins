# Agent Note: Self-built SSH tunnel plus server-side remote API path

Status: implemented

## Problem

`dsh-plugin-remote-ssh` 需要经 SSH 通道与远程 DSH（dev，`127.0.0.1:3080`，0.2.0-rc.2）通信，拉取其工作区与会话。有两条待定案的技术路线：复用官方 `@deepseek-ai/dsh-ssh` 的 `ctx.ssh`，还是插件自建 SSH 隧道；以及远程 API 调用走浏览器 cookie 路径还是 server-side 路径。

## Decision

插件自建 SSH 本地端口转发隧道（OpenSSH `ssh -N -L` 子进程，密钥认证），由 `SshTunnel` 类负责端口就绪探测、存活守护与指数退避重连；在本地 Host 端经隧道读取远端 launch-token 并通过 `GET /?token=...` 获取 authority 绑定的 Cookie，直调远程 `/api`。不复用官方 `dsh-ssh`，不直接在浏览器跨域搬运 Cookie。

## Alternatives considered

- 复用官方 `dsh-ssh`（`ctx.ssh`）：该服务是"单 SSH 会话 + 版本匹配的远端 helper + POSIX 约束"的专用执行通道（`packages/ssh/ssh/src/index.ts`，Config 要求 `node/helper/helperHash/workspace`），面向远程命令执行而非 HTTP 转发；且本地为 Windows，POSIX 假设不成立。落选。
- 经隧道直接搬运远程已有的浏览器 cookie：在 `packages/client/connection/src/browser-auth.ts` 中 cookie 名与载荷均绑定请求 authority（`cookieName(authority)`、`payload.authority`），本地转发端口与远程 3080 不是同一 authority，远程签发的 cookie 在本地 authority 下必然验签失败。落选。实际方案改为在隧道本地 authority 下发起 token 换取，使得 Cookie 天然对齐本地 authority。

## Consequences

- 隧道子进程生命周期完全由插件自建模块内聚管理。
- 远端重启时 token 会轮换，`RemoteCaller` 在遇到 401 时自动重新读取日志中的 token 并换取新 Cookie。
