# Agent Note: Support Remote Session Queue Update And Inbox Sync

Status: implemented

## Problem

在远程主机会话执行过程中，当用户发送后续消息时，系统处于 busy/running 状态，该消息进入排队队列（`inbox.next-turn`）。当前实现存在两个体验问题：

1. **排队消息未及时在对话框上方显示**：只有当用户切换到其他会话再切回时，上方排队消息条（`QueueDock`）才显示出来。
2. **点击插话发送没有及时响应**：在排队条中点击"插话发送"按钮（或按 Cmd/Ctrl+Enter 批量插话）无响应或报错。

根因：

1. **缺少 `session.updateQueue` 拦截与 Host 路由**：官方 UI 的"插话发送"按钮触发 `conversation.updateQueue(itemId, { kind: 'steer' })`，底层调用 `ctx.remote.session.updateQueue(...)`。`client.js` 的 `installSessionProxy` 的 `methods` 列表中遗漏 `updateQueue`，导致调用穿透到本地未挂载的 session 而报错；Host 侧 `src/route.ts` / `src/remote.ts` 也未实现 `/remote-ssh/session-update-queue` 路由与远程 RPC 转发。
2. **缺少对 `inbox` 投影的即时同步**：对话框上方的排队消息条由 `session.projections.faceOf('inbox')` 驱动。本地会话通过内部 control stream 实时下发投影变更，而远程插件仅在初次进入或切换会话时一次性拉取快照。用户在运行中通过 `prompt` 发送排队消息后，远端已成功入队，但本地未即时刷新该 session 的 `projections`，导致只有离开再重新进入时才能看到。

## Decision

1. **服务端增补 `session/updateQueue` RPC 与路由**：
   - `src/remote.ts`：新增 `updateRemoteSessionQueue(sessionId, itemId, action, signal)`，调用远端 `session/updateQueue`。
   - `src/route.ts`：新增 `SESSION_UPDATE_QUEUE_ROUTE = '/remote-ssh/session-update-queue'` 路由（校验 `sessionId`/`itemId`/`action`，tunnel 未就绪返回 503，透传远端结果）。
2. **客户端拦截代理 `updateQueue`**：
   - `client.js`：在 `installSessionProxy` 的 `methods` 列表加入 `updateQueue`，包装为向 `/remote-ssh/session-update-queue` 发起 POST；远程分支成功后立即同步投影并返回 `accepted`，失败返回结构化错误。
3. **即时刷新 `inbox` 投影**：
   - 新增 `syncSessionProjections(sessionId)`：远程会话成功 `prompt`、成功 `updateQueue` 后，以及 `follow` 流收到 `agent/inbox/spliced` 事件时，拉取一次远端 `projections` 并注入该 session 的 projection store（优先 `sessionModel.projections.seed`，回退 `ctx.sessions.handleControlFrame` 基线）。
   - `src/client/index.ts` 类型镜像同步（`RemoteSshClientModels['sessions']` 与 `installSessionProxy` 契约说明）。

## Alternatives considered

1. **完全建立全双工 `session/control` 流**：远端 `session/control` 包含全部会话控制状态，复杂度高且开销较大。现阶段采用"关键事件触发即时拉取（event-driven projection refresh）"加 follow 流协作，以最小改动和最高稳定性解决延迟问题。

## Consequences

- 排队消息条（`QueueDock`）在入队/插话后即时刷新，无需离开会话再切回。
- "插话发送"按钮在远程会话上可用（`updateQueue` 不再穿透到本地失败）。
- 机械验证：`node packages/dsh-plugin-remote-ssh/smoke-client-bundle.mjs`（新增 updateQueue 远程/本地分支断言）。
