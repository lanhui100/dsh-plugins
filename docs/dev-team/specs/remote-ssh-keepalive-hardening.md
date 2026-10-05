# Spec: remote-ssh SSH 隧道保活加固

## 1. 背景与目标
当前 `dsh-plugin-remote-ssh` 的 SSH 隧道保活存在以下差距与审查裁决：
- 重连退避抖动缺少下限保护（存在 0 延迟突发），且未打通端到端保活参数配置。
- `config.ts` 缺少 `ConnectTimeout`、`TCPKeepAlive`、`ServerAliveInterval`、`ServerAliveCountMax`、`reconnectDelayMs`、`reconnectMaxDelayMs` 导出，导致 manager 与 tunnel 使用硬编码默认值。
- `RemoteCaller` 的 `$events` WebSocket 断线无自愈，与隧道处于割裂状态，缺乏“隧道就绪驱动”唤醒机制。
- 断线时粗暴清理 `pendingInteractions` 会抹掉用户正在输入的问答卡片（需采用延后对账/保持现有交互在重连后继承新 clientId）。
- 本地端口分配未作真实 OS 可用性预检：主配置端口冲突应严格报错，动态端口分配应自动探测并自增寻优（Auto-hunt）。

**目标**：
1. 隧道重连采用指数退避 + 抖动（带 minDelay 下限保护），首轮失败立即 reject 不阻塞 start()。
2. 配置项完整透传：`config.ts` → `index.ts` → `manager.ts` → `SshTunnel` / `RemoteCaller`。
3. `SshTunnel` 具备生命周期事件（`onReady`, `onDown`），断线驱动 `RemoteCaller.onTunnelDown()` 暂停 $events 轮询，就绪触发 `RemoteCaller.onTunnelReady()` 立即重置退避并重连。
4. `$events` 自动重连（指数退避+抖动+门禁+安全清理），重连后继承新 `currentClientId`，避免闪断清空用户输入卡片。
5. 本地端口策略：主配置严格检测并抛错；动态主机分配增加 OS 级探测与自动寻优。

## 2. 影响范围
- `packages/dsh-plugin-remote-ssh/src/config.ts`
- `packages/dsh-plugin-remote-ssh/src/tunnel.ts`
- `packages/dsh-plugin-remote-ssh/src/remote.ts`
- `packages/dsh-plugin-remote-ssh/src/manager.ts`
- `packages/dsh-plugin-remote-ssh/src/index.ts`
- `packages/dsh-plugin-remote-ssh/README.md`
- 各 smoke 测试与新增测试

## 3. 验收标准
1. `pnpm --filter dsh-plugin-remote-ssh typecheck` 0 报错。
2. 全套 smoke 测试通过（无退化）。
3. 隧道与 $events 重连均具备指数退避 + 抖动（含下限保护），dispose 时彻底清理定时器与子进程。
4. 主配置端口冲突直接报错；动态端口分配探测到占用能自动顺延分配空闲端口。
5. $events 闪断重连后保留现有交互并更新 clientId。
6. README 配置与契约说明完全同步。

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
