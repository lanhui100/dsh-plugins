# dsh-plugin-remote-ssh

> 经 SSH 隧道把远端 DSH 实例的工作区与会话聚合到本地 UI（方案 B）。

## config

| 键 | 含义 | 默认 |
|---|---|---|
| `host` | OpenSSH 主机别名（含用户/密钥/known-hosts 配置） | 必填 |
| `remotePort` | 隧道远端的 DSH web 端口 | `3080` |
| `localPort` | 本地回环转发端口 | `39387` |

## semantics

- 本地 Host 端持有 `ssh -L <localPort>:127.0.0.1:<remotePort> <host>` 隧道子进程，负责保活与断线重连。
- 经隧道直调远端 `/api`（server-side 路径）；浏览器 cookie 鉴权因 authority 绑定不可复用（见 `.agents/notes/proposed/architecture/2026-09-30-self-built-tunnel-and-server-side-api.md`）。
- Client 端在 sidebar 注入远端连接状态与工作区/会话视图（`sidebar.footer.action` 起步）。

## limitations

- 远端 `/api` 的 server-side 身份尚待实测定案（候选：profile credential / launch token / loopback 代理）。
- 仅支持密钥认证的 OpenSSH 主机；Windows 本地隧道子进程管理自建。
