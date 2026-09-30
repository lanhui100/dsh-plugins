# Agent Note: Remote DSH aggregation over SSH tunnel

Status: proposed

## Problem

本地 DSH 需要操作远程主机（ssh `dev`，密钥登录）上已运行的 DSH 实例（含其工作区与会话），但原生 UI 不支持跨实例聚合工作区。远程 DSH 监听 `127.0.0.1:3080`（经 `curl -sI` 验证返回 `401 Unauthorized`，即服务存活但需鉴权），不暴露公网端口。

## Proposal

采用"双 DSH 实例聚合 + SSH 隧道（方案 B）"：本地 Cordis 插件通过 SSH 密钥连接 `dev`，建立本地端口转发隧道映射远程 3080 端口，经隧道与远程 DSH 的 RPC/WebSocket 握手；Host 端维护连接与会话同步，Client 端通过 Slot 注入"远程工作区"视图与操作入口。隧道鉴权与远程 DSH 的 401 鉴权机制在实现阶段探明（候选：profile token / boot 注入）。

## Alternatives considered

- 方案 A（SSHFS/Samba 文件挂载 + 本地 Agent 执行）：能看到远程文件，但无法复用远程已有会话历史与执行环境，延迟高；落选。
- 公网暴露远程 DSH HTTP/WS 端口：需防火墙开孔 + TLS + 公网鉴权，不如复用现有 SSH 密钥通道安全；落选。

## Acceptance criteria

- [ ] `ssh dev` 密钥连接与隧道建立可复现（含断线重连策略）。
- [ ] 本地 UI 出现远程工作区列表，含其下会话。
- [ ] 点击远程会话可查看/交互，会话流双向同步。
- [ ] 远程 DSH 未运行时插件可经 SSH 按需拉起或给出明确错误。

## Risks

- 远程 DSH 的 401 鉴权协议未探明：若 token 获取机制封闭，可能需随 DSH 版本跟进适配。
- RPC 订阅流的断线语义：SSH 隧道抖动时会话增量可能丢帧，需幂等基线重同步。
