# Agent Note: Synchronize remote session running and loading status bidirectionally

Status: implemented

## Problem

在远程会话发送消息后，桌面端未实时进入 running 态（无“深度求索中...”指示器，发送按钮未变成 Stop 停止按钮，侧边栏无运行中指示）；而当远端对话完成（`turn/end`）时，桌面端却持续显示进行中的 loading 态无法复位。

根因排查：
官方 UI 运行状态由 `Session.running` 单一真源驱动，而 `Session.running` 唯一由 `Session.handleRunning(running)` 驱动，后者唯一由 `manager.handleSessionStatus(sessionId, running)` 触发。本地会话由 Node 宿主代理层抛出本地事件驱动；而远程会话由插件接管，此前 `client.js` 在 `prompt`、`cancel`、`follow` 消费 SSE 帧时从未调用 `ctx.sessions.handleSessionStatus`，导致 stream 时本地始终为 false，对话完成后残留的 loading 态又无法被复位。

## Decision

- **发送即时进入 running 态**：
  在 `client.js` 的 `wrap.prompt` 中，当 POST 请求发送成功后，立即调用 `ctx.sessions.handleSessionStatus(id, true)`，使发送按钮瞬间变为 Stop 按钮，并启动计时指示器。
- **取消即时复位 idle 态**：
  在 `wrap.cancel` 中，当 POST 请求成功后，立即调用 `ctx.sessions.handleSessionStatus(id, false)`，使中断操作瞬间响应。
- **SSE 流事件精准驱动状态闭环与活动时间**：
  在 `wrap.follow` 的 SSE 帧分发循环中：
  - 收到 `assistant-stream` 帧或 `event.type === 'turn/start'` 时，触发 `ctx.sessions.handleSessionStatus(id, true)`；
  - 收到 `event.type === 'turn/end'` 时，触发 `ctx.sessions.handleSessionStatus(id, false)`，使 `<RunningStatus>` 彻底卸载，消除悬挂 loading 态；
  - 收到带有 `event.time` 的事件帧时，触发 `ctx.sessions.handleSessionActivity(id, frame.event.time)`，使侧边栏会话排序实时置顶；
  - 在 `finally` 块中（流结束、abort 或连接断开）执行底线兜底：调用 `ctx.sessions.handleSessionStatus(id, false)`，防止异常断网残留 loading 态。
- **快照与类型契约同步**：
  在 `reconcileRemoteSource` 快照同步中，对每个会话同步 `handleSessionStatus(s.sessionId, Boolean(s.running))`；在 `src/client/index.ts` 中显式扩展 `RemoteSshClientModels['sessions']` 类型契约。

## Alternatives considered

- **依赖 60 秒轮询更新 `SessionSummary.running`**：被否。轮询延迟最高达 60 秒，无法支撑人机交互实时的打字机与 Stop 按钮翻转；且即便调用 `handleSessionAdded`，官方源码中对已激活的会话实例也根本不更新 `session.running`，必须显式调用 `handleSessionStatus`。
- **让 Host 端通过独立 WebSocket RPC 推送运行态**：被否。SSE `follow` 流本身就是官方原生事件通道（天然携带 `turn/start`、`assistant-stream`、`turn/end`），无需引入任何新协议，直接在客户端帧消费层触发状态驱动最为简洁直接。
- **仅在 `follow` 连接断开时设为 false**：被否。一次问答回合完成后，长连接可能保持挂载等待用户下一句提问；如果不精准消费 `turn/end` 帧，连接保持期间 UI 将永久卡在 loading 态。

## Consequences

- 远程会话发送消息、流式接收、完成回复、取消中断的全链路交互状态与本地会话 100% 对齐。
- 彻底消除了对话完成后 `<RunningStatus>` 悬挂的 loading 态。
- 机械验证全绿：`node packages/dsh-plugin-remote-ssh/smoke-client-bundle.mjs`。
