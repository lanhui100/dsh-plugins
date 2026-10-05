# Spec: remote-ssh SSH 隧道保活加固

## 1. 背景与目标
当前 `dsh-plugin-remote-ssh` 的 SSH 隧道保活存在以下差距：
- 重连为线性退避（`reconnectDelayMs * failures`），README 却声称“指数退避重连”，文档与实现不符。
- `ssh` 子进程缺少 `ConnectTimeout` 与 `TCPKeepAlive`，连接阶段与半开连接的探测都依赖单一路径。
- `ServerAliveInterval/CountMax` 硬编码，不可按网络环境调整。
- `ssh` stderr 只消费不记录，断因无法诊断。
- `RemoteCaller.ensureEventsListener` 的 `$events` WebSocket 无主动自动重连与应用层心跳超时。
- 本地端口分配未预检占用，失败重连会重复命中同一 `ExitOnForwardFailure` 错误。

**目标**：
1. 重连策略改为真正的指数退避 + 抖动，首轮失败仍立即 reject，不阻塞 start()；同时修正 README 描述。
2. SSH 子进程参数补齐 `ConnectTimeout`、`TCPKeepAlive`，`ServerAliveInterval/CountMax` 可配置化。
3. 留存 `ssh` stderr 诊断日志（截断），便于定位断因。
4. `$events` 监听具备自动重连（指数退避+抖动、tunnel 状态 gate、dispose 可安全取消）；心跳帧不作死判，死判依托 ssh 子进程保活 + WS close/error。
5. 本地端口分配前预检占用，但就绪主判据 = child 存活 + stderr 排除 ExitOnForwardFailure + 端口监听（waitForPort 仅作子条件）。

## 2. 影响范围
- `packages/dsh-plugin-remote-ssh/src/tunnel.ts`
- `packages/dsh-plugin-remote-ssh/src/remote.ts`
- `packages/dsh-plugin-remote-ssh/src/manager.ts`
- `packages/dsh-plugin-remote-ssh/src/config.ts`（必须暴露新配置项）
- `packages/dsh-plugin-remote-ssh/README.md`
- 受影响 smoke：`smoke-manager.mjs`、`smoke-multi-host.mjs`、`smoke-command.mjs` 等

## 3. 验收标准
1. `pnpm --filter dsh-plugin-remote-ssh typecheck` 0 报错。
2. 全套 smoke 测试 100% 通过。
3. 已建立隧道断开后，`SshTunnel` 重连延迟呈指数增长（含抖动），上限可配置；首次连接失败立即 reject 不进退避；README 描述与实现一致。
4. SSH 子进程参数包含 `ConnectTimeout` 与 `TCPKeepAlive`；`ServerAliveInterval/CountMax` 可配置，且 config.ts → manager.ts → tunnel.ts 透传链路完整。
5. 隧道 flap 或 socket close/error 后，`$events` 按退避重连（gate：仅隧道 ready 才重试）；dispose 后不再重连、无悬挂定时器；重连后非 `mock-` 前缀的 pendingInteractions 被清空并收到 cancel 通知，`currentClientId` 等待新 ready 帧重建。
6. 本地端口被占用时，`startHost` 报出明确端口冲突错误；隧道就绪判定 = child 存活 + stderr 无 ExitOnForwardFailure + 端口监听，waitForPort 仅作子条件。

## 4. 方案与替代方案
- 指数退避 + full jitter vs 线性退避：选前者，避免集中重连；保留 `reconnectDelayMs` 作为 base，`reconnectMaxDelayMs` 为上限。
- $events 死判三选一：(a) 无帧超时——错，$events 无周期帧，误杀；(b) mux 加 ping——跨包，不值；(c) 现状链式传输层判据 = ssh child 保活 + WS close/error。选 (c)，附 ADR。
- 应用层心跳 vs 仅依赖 SSH keepalive：不叠加；死判不依赖应用层心跳。
- $events 重连 vs 隧道重连：gate（仅隧道 ready 才重试），退避各自独立+抖动，无逆边；$events dispose 时随隧道一并取消。
- 可配置保活参数 vs 硬编码：选可配置，默认值保持当前等价行为。

## 5. 任务拆解与并行边界
- T1 `tunnel.ts`：指数退避+抖动（首轮失败立即 reject）、ConnectTimeout/TCPKeepAlive/可配置 ServerAlive、stderr 截断日志、就绪判据改为 child 存活 + stderr 排除 ExitOnForwardFailure + 端口监听。
- T2 `remote.ts`：`$events` 自动重连（指数退避+抖动、tunnel 状态 gate、disposed 标志防复活、dispose 清定时器）+ 重连后 pending/clientId 清理策略。
- T3 `manager.ts` + `config.ts` + `index.ts`：端口预检快路径报错、配置项端到端透传（config.ts → index.ts apply → manager → SshTunnel/RemoteCaller）。
- T4 测试与文档：README 配置表/语义节对齐、smoke 注入固定 jitter 与 fake-WS 校验。

## 6. 风险、回滚与迁移
- 风险：自动重连改变事件流语义；远端 $events 是否重放 waterfall 事件未确认（客户端策略已按不重放设计、重放亦兼容）；检测延迟上限 ≈ ServerAliveInterval×(CountMax+1)；TOCTOU 窗口仍在但由 child 存活+stderr 排除兜底。回滚为还原 `tunnel.ts`/`remote.ts`/`manager.ts`/`config.ts`/`index.ts` 改动并 revert README。
- 迁移：新增配置项均有默认值，旧配置可无缝继续使用；`remote-ssh-hosts.json` 旧条目缺新字段时按默认填充。

## 7. 测试计划
- 现有 smoke 全量回归。
- 新增针对退避间隔、端口冲突提示、`$events` 重连的 smoke/单测。
