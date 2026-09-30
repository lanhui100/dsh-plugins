# Agent Note: Remote DSH aggregation over SSH tunnel

Status: implemented

## Problem

本地 DSH 需要操作远程主机（ssh `dev`，密钥登录）上已运行的 DSH 实例（含其工作区与会话），但原生 UI 不支持跨实例聚合工作区。远程 DSH 监听 `127.0.0.1:3080`（经 `curl -sI` 验证返回 `401 Unauthorized`，即服务存活但需鉴权），不暴露公网端口。

## Decision

采用"双 DSH 实例聚合 + SSH 隧道（方案 B）"：本地 Cordis 插件通过 SSH 密钥连接 `dev`，建立本地端口转发隧道映射远程 3080 端口，经隧道与远程 DSH 的 RPC/WebSocket 握手；Host 端维护连接、Token-Cookie 交换与会话同步，并通过 Client 端 Slot 及命令注入远程工作区与会话操作入口。

## Alternatives considered

- 方案 A（SSHFS/Samba 文件挂载 + 本地 Agent 执行）：能看到远程文件，但无法复用远程已有会话历史与执行环境，延迟高；落选。
- 公网暴露远程 DSH HTTP/WS 端口：需防火墙开孔 + TLS + 公网鉴权，不如复用现有 SSH 密钥通道安全；落选。

## Consequences

- 远端无需暴露任何公网 HTTP/WS 端口，保持最大安全性。
- 本地 Host 端需要守护 SSH 端口转发子进程并实现断线重连。
