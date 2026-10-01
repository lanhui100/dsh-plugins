# Agent Note: Connect remote session prompt cancel and live follow stream

Status: implemented

## Problem

在上一里程碑（见 `2026-10-01-reuse-official-workspace-session-ui.md`）中，`dsh-plugin-remote-ssh` 实现了将远程工作区与会话注入官方客户端模型并只读查看会话历史。但由于 `remote.session.prompt` 和 `cancel` 被硬编码为占位报错（`remote-ssh: 远端会话续写尚未接通（当前只读里程碑）`），且 `remote.session.follow` 在产出初始快照后即永久挂起，导致用户在远程会话中无法发送消息续写、无法取消生成，也无法看到 AI 回复的打字机流式输出。

## Decision

- **Host 端开通 Prompt 与 Cancel 路由**：
  - 注册 `POST /remote-ssh/prompt`：接收客户端的 prompt 请求（包含 `sessionId`、`requestId`、`mode`、`content`、`clientTimeZone` 等）；若目标会话为子智能体（带有 `parentSessionId` 或记录在 `subagentParents` 表），调用远端 `subagents/prompt`；普通根会话调用远端 `session/prompt`；返回 `{ ok: true, value: { accepted: true } }`（或透传错误）。
  - 注册 `POST /remote-ssh/cancel`：接收客户端的 cancel 请求（包含 `sessionId`）；若目标会话为子智能体，调用远端 `subagents/interruptByParent(childSessionId, parentSessionId, 'continuable')`；普通根会话调用远端 `session/cancel`。
- **Host 端开通 Follow SSE 实时中继路由**：
  - 注册 `GET /remote-ssh/session-follow?id=...&parentId=...`；
  - 设置响应头 `Content-Type: text/event-stream; charset=utf-8`；
  - `RemoteCaller` 实现 `followSession` 异步生成器，通过本地隧道连接远端 `/api/remote.mux` WebSocket 订阅 `session/follow`（参数携带 `address` 与 `assistantStream: true`）；
  - 每收到远端推送的一帧 `SessionFollowFrame`（包括 `snapshot`、增量 `event` 与 `assistant-stream` 帧），以标准 SSE 格式 `data: ${JSON.stringify(frame)}\n\n` 实时写入响应；
  - 客户端连接关闭或 abort 时，Host 自动向远端发送 `{ type: 'cancel', streamId }` 并关闭 socket，释放资源。
- **Client 端接通代理与流式消费**：
  - `wrap.prompt`：对远程会话发送 `POST /remote-ssh/prompt`，返回网关结果；
  - `wrap.cancel`：对远程会话发送 `POST /remote-ssh/cancel`，返回网关结果；
  - `wrap.follow`：通过 `fetch(SESSION_FOLLOW_ROUTE)` 获取 SSE 流，经 `response.body.getReader()` 逐行解析 `data:` 帧并实时 `yield frame`，打通打字机流；在流失败或无 reader 环时自动降级静态快照兜底；
  - 在 `installSessionProxy` 中同时拦截并代理 `ctx.remote.subagents` 的 `prompt` 与 `interruptByParent`，使子智能体会话续写同样生效。

## Alternatives considered

- **客户端直接与远端 WebSocket 通信**：被否。远端位于 SSH 隧道之后，且需要鉴权 Token 与 Cookie Jar 握手；浏览器端受同源策略和 Cookie 限制，由 Host 端本地回环隧道代持 WebSocket 并转为标准 SSE，客户端只需消费本地同源 HTTP，架构最干净且零鉴权泄露风险。
- **轮询通过 `session/page` 抓取增量**：被否。轮询无法提供亚秒级的打字机实时体验，无法获取 `assistant-stream` 细粒度 token 帧，且频繁轮询消耗远端与隧道资源；远端原生支持 `session/follow` 流，直接中继是正道。
- **仅支持根会话忽略子智能体会话续写**：被否。官方客户端已将子智能体与 Team 会话拆分并挂载到顶部栏，用户切换到子智能体输入框时会调用 `remote.subagents.prompt`；如果不代理子智能体，向子智能体会话发消息会落空报错。

## Consequences

- 远程会话彻底脱离“只读里程碑”，支持双向发送消息、打字机流式回复与中断取消。
- 官方界面组件完全透明：官方 `Conversation` 控件与 `Session` 模型无感知，底层流与本地体验 100% 一致。
- 本地与远端资源生命周期严格受控：连接断开与 abort 信号级联传递给远端 WebSocket，杜绝悬挂连接。
