# Agent Note: Support ask_user_question interaction component and bidirectional response for remote sessions

Status: implemented

## Problem

当远程会话中的模型调用 `ask_user_question` 工具时，远端通过 Gateway `$events` 逻辑流下发 `user-questions/request` 挂起工具等待用户输入。然而此前 `dsh-plugin-remote-ssh` 未接通 `$events` 事件通道，也未向客户端提供交互卡片与应答路由，导致：
1. 桌面端输入框区域未显示原生问答交互组件（问题标题、detail 提示、推荐徽章、单选互斥/多选复选、自定义输入框、提交/跳过按钮）；
2. 侧边栏未通过 `uiSession.registerPendingInteraction` 展示待回答指示点；
3. 用户在桌面端无法提交答案或跳过问题，远端会话一直阻塞等待超时，造成用户感知卡死。

## Decision

- **Host 端（`src/remote.ts` & `src/route.ts`）接通 `$events` 与交互路由**：
  - 在 `RemoteCaller` 中实现 `ensureEventsListener()`，常驻连接远端 WebSocket `/api/remote.mux` 的 `$events` 逻辑流；捕获 `ready` 帧提取 `clientId`，捕获 `waterfall`（`event: "user-questions/request"`）和 `cancel` 帧，并在本地维护 `activeInteractions` Map；
  - 实现 `respondRemoteEvent()`，通过 HTTP POST 向远端 `/api/$events/result` 发送结构化答案（`kind: 'result'`）或取消（`kind: 'rejected'`，`code: 'ASK_CANCELLED'`），解除远端工具挂起；
  - 在 `RemoteCaller.dispose()` 中显式断开 WebSocket 长连接，防止测试或插件卸载后句柄悬挂；
  - 在 `route.ts` 中注册 `GET /remote-ssh/pending-interaction?sessionId=...` 与 `POST /remote-ssh/interaction-respond`；
  - 在 `/remote-ssh/sessions` 快照中为处于等待交互的会话注入 `pendingInteraction: 'question'`，并在 `SESSION_FOLLOW_ROUTE`（SSE 流）中下发 `interaction/request` 与 `interaction/cancel`。
- **Client 端（`client.js` & `src/client/index.ts`）挂载问答卡片与驱动侧边栏**：
  - 在 `wrap.follow` 接收流与快照同步中监听 `interaction/request` 与 `interaction/cancel`；
  - 通过 `ctx.inject(['uiSession'])` 注册待回答状态（`uiSession.registerPendingInteraction`），驱动侧边栏交互状态圆点；
  - 在会话 composer 输入区域挂载问答交互卡片（`.dsh-remote-question-card`），支持推荐徽标识别（`.dsh-rq-rec-tag`）、单选互斥、多选复选、自定义文本输入、跳过与提交；
  - 提交或取消后向 `POST /remote-ssh/interaction-respond` 发送 `outcome`，并在成功后移除卡片、恢复原本输入框的显示；
  - 通过会话容器属性校验（`checkAndRenderActiveQuestion`）实现前后台会话隔离，防止非当前会话的交互串扰当前界面；
  - 同步更新 `src/client/index.ts` 中的全套 TypeScript 类型契约。
- **三层测试矩阵锁定机械契约**：
  - `smoke-route.mjs`：真实远端与隧道环境下测试交互状态查询、SSE 交互下发、结果提交与清理；
  - `smoke-client-bundle.mjs`：测试 Cordis Service 与 `uiSession` 侧边栏交互挂起与注销；
  - `smoke-question-card.mjs`：在 DOM 环境下测试问答卡片的挂载、推荐徽标、选项选择、自定义输入、提交与跳过全生命周期。

## Alternatives considered

- **让客户端直接通过 WebSocket 连接远端 mux 端口**：被否。远端 mux 处于内网或需通过 SSH 隧道，直接暴露给前端浏览器会有跨域、动态端口、认证 Cookie 与隧道保活问题；统一由 Host 插件在宿主层维持长连接并通过既有的 Host HTTP/SSE 路由转发最为安全可控。
- **使用独立的 Modal 对话框代替输入框区域嵌入**：被否。`ask_user_question` 语义是智能体发起的问题输入，其自然上下文就是当前会话的输入区（composer）；使用全局 Modal 会阻挡用户查看上方的历史对话内容，打断思路并破坏桌面原生嵌入感。
- **仅在 SSE follow 流中推送，不提供快照拉取与独立查询路由**：被否。若用户在提问发起后才打开客户端，或切换工作区重新加载，纯靠 SSE 流会丢失当前正在挂起的待答状态；通过 `pendingInteraction` 快照与 `GET /pending-interaction` 兜底实现了断线重连与刷新不丢失。

## Consequences

- 远程会话中模型发起 `ask_user_question` 时，桌面端无缝弹出问答卡片并标记侧边栏待回答状态。
- 用户选择或输入后点击提交，远端挂起立即解除并继续生成，双向交互形成完整闭环。
- 全套测试 100% 通过（`smoke-route.mjs`、`smoke-client-bundle.mjs`、`smoke-question-card.mjs`）。
