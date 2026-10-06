# Agent Note: Fix Remote Running Session Showing Completed Green Dot

Status: implemented

## Problem

远程主机上正在运行的会话，在本地 DSH 侧边栏的会话行前却显示"已完成"的绿点（`StateDot[data-state='done']`），而不是"进行中"的 loading 旋转图标（`StateDot[data-state='ongoing']`）。

根因链（`packages/dsh-plugin-remote-ssh/client.js`）：

1. 官方 `UiSession.observeRunning()` 把一次 running `true→false` 转换（且会话不是主视图）登记为 `completionUnread`，侧边栏据此渲染"已完成"绿点——这是本地会话的完成提醒语义，本身是设计意图。
2. 插件 `wrap.follow` 的 SSE 帧消费循环里，`finally` 块**无条件**调用 `ctx.sessions.handleSessionStatus(id, false)`。当远端 agent 长时间不产出帧（长工具执行等），Host 路由的 30s 心跳保活会关闭 SSE 流，客户端据此触发 `false` 转换 → 会话被误标"已完成"。
3. 此时远端 `session/list` 仍报 `running=true`，而 `reconcileRemoteSource` 的整树指纹（`snapshotFingerprint`，见 `.agents/notes/implemented/bug-fix/2026-10-04-throttle-client-mutation-observer-and-deduplicate-reconcile.md`）未变化 → 60s 轮询**整段早退**，`handleSessionStatus(id, true)` 永远不会再次执行 → 绿点永久卡住，直至远端快照因其它原因变化。

补充触发面：非流式回退路径（SSE 不可用时的快照兜底）同样无条件 `handleSessionStatus(id, false)`，可在会话仍运行时打上绿点。

## Decision

在 `client.js` 落地三处修复：

1. **follow 流 `finally` 条件化复位**（修复触发源）：
   - 新增 `let sawTurnEnd = false`，在 `isTurnEnd` 分支置位。
   - `finally` 仅在 `sawTurnEnd || (signal && signal.aborted)` 时调用 `handleSessionStatus(id, false)`。传输中途断开（SSE 空闲超时 / 路由心跳 abort）不再把仍在运行的会话复位为 idle。
2. **轮询兜底修复 running 分歧**（修复早退盲区）：
   - 新增 `repairRunningStates(ctx, body)`：对 `body.sessions` 的每个会话，读取官方 live 列表存储（`ctx.sessions.list.getSnapshot().byId[sid].running`）与远端 `running` 比较，仅在分歧时调用 `handleSessionStatus(sid, remoteRunning)`。
   - 指纹未变早退分支改为先执行 `repairRunningStates(ctx, body)` 再返回；全量 reconcile 的会话循环中，per-session 指纹未变时同样用 live 存储做分歧检查并修复。两条路径都覆盖，确保最迟一个轮询周期（≤60s）内把误标绿点恢复为运行中。
3. **非流式回退路径移除无条件复位**：快照兜底不再调用 `handleSessionStatus(id, false)`，由轮询根据远端权威状态驱动。

`src/client/index.ts` 同步扩展 `RemoteSshClientModels['sessions']` 的 `list` 可选契约并在注释中说明运行态漂移修复。

## Alternatives considered

1. **直接缩短 `POLL_INTERVAL_MS` 以加速恢复**：被否。治标不治本（误标本身仍发生），且违背 `.agents/notes/implemented/bug-fix/2026-10-04-throttle-client-mutation-observer-and-deduplicate-reconcile.md` 的零开销轮询目标；本轮询修复在 60s 内恢复已足够。
2. **在 finally 里对会话做一次远端 running 查询再决定是否复位**：被否。每次流断开都多一次跨隧道 RPC，成本高且引入新的失败面；轮询已有权威快照，无需重复查询。
3. **完全移除 finally 复位（回到 2026-10-01 之前的悬挂 loading 态）**：被否。会复现 `.agents/notes/implemented/feature/2026-10-01-sync-remote-session-running-status-and-activity.md` 修复的"对话完成后 loading 无法复位"；条件化复位在保留 turn/end 与消费方 abort 复位的同时，仅豁免"传输中途断开"这一误标场景。

## Consequences

- 远程运行中会话不再被 follow 流传输中断误标为"已完成"绿点；即便已出现分歧，下一次轮询（≤60s）也会把状态修复为运行中 loading 图标。
- turn/end、cancel、用户导航关闭等正常结束路径的即时复位行为保持不变（与 2026-10-01 决策一致）。
- 指纹脏检查的零开销目标保持：仅在有真实分歧时才产生一次 `handleSessionStatus` 调用，对齐状态下轮询零额外写。
- 机械验证：`node packages/dsh-plugin-remote-ssh/smoke-running-repair.mjs`（新增回归：follow 中途断开不复位、未变指纹轮询修复双向分歧、对齐零冗余）；`smoke-client-bundle.mjs` 与 `smoke-performance.mjs` 保持全绿。
