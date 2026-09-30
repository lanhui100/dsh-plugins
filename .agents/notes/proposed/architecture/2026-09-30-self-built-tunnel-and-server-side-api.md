# Agent Note: Self-built SSH tunnel plus server-side remote API path

Status: proposed

## Problem

`dsh-plugin-remote-ssh` 需要经 SSH 通道与远程 DSH（dev，`127.0.0.1:3080`，0.2.0-rc.2）通信，拉取其工作区与会话。有两条待定案的技术路线：复用官方 `@deepseek-ai/dsh-ssh` 的 `ctx.ssh`，还是插件自建 SSH 隧道；以及远程 API 调用走浏览器 cookie 路径还是 server-side 路径。

## Proposal

插件自建 SSH 本地端口转发隧道（OpenSSH `ssh -L` 子进程，密钥认证），并在本地 Host 端经隧道直调远程 `/api`。不复用官方 `dsh-ssh`，不走浏览器 cookie 鉴权。

## Alternatives considered

- 复用官方 `dsh-ssh`（`ctx.ssh`）：该服务是"单 SSH 会话 + 版本匹配的远端 helper + POSIX 约束"的专用执行通道（`packages/ssh/ssh/src/index.ts`，Config 要求 `node/helper/helperHash/workspace`），面向远程命令执行而非 HTTP 转发；且本地为 Windows，POSIX 假设不成立。落选。
- 经隧道复用远程浏览器 cookie：在 `packages/client/connection/src/browser-auth.ts` 中 cookie 名与载荷均绑定请求 authority（`cookieName(authority)`、`payload.authority`），本地转发端口与远程 3080 不是同一 authority，远程签发的 cookie 在本地 authority 下必然验签失败。落选。
- 远程 `/api` 的 `requestRejection`（`packages/client/connection/src/rpc-host.ts`）对 `/api` 同时施加 loopback/Origin 围栏（`isTrustedApiRequest`，loopback 放行）与 cookie 鉴权（`browserAuth.isAuthenticated`）：经 `127.0.0.1:<local-port>` 转发的 server-side 请求能过围栏但过不了 cookie 鉴权。因此 server-side 路径还需探明远程是否有 token/预共享密钥类的 API 身份（候选：profile credential、launch token 交换、或新增一个仅监听 loopback 的本地代理）。该子问题在实现阶段以实测为准，本条保持开放。

## Acceptance criteria

- [ ] 隧道建立/保活/断线重连策略可复现（`ssh -L <local>:127.0.0.1:3080 dev`）。
- [ ] 经隧道的 server-side `/api` 调用路径实测打通（含鉴权方式定案）。
- [ ] 包形态与官方双入口规范一致（Host `lib/index.js` + Client `./client` + `dsh.client` 字段）。

## Risks

- 远程 `/api` 若无 server-side 身份可用，退路是"本地起一个仅 loopback 的代理页 + 复用远程 cookie 流程"，复杂度上升。
- Windows 本地 `ssh -L` 子进程管理（存活监控、端口冲突、已知主机校验）需自建，无现成 Cordis 服务可用。
