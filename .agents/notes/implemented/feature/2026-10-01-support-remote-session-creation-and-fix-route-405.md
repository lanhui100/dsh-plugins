# Agent Note: Support remote session creation and fix route 405

Status: implemented

## Problem

用户在远程工作区内操作时遇到阻断性问题：
1. **远程会话新建失败**：官方客户端点击新建会话时调用 `ctx.remote.session.create({ workspaceId: 'remote:<cwd>' })`。此前 `installSessionProxy` 未代理 `create` 方法，请求直接穿透到本地 Cordis 宿主，本地因不识别 `remote:<cwd>` 路径而报错失败；
2. **消息续写弹出 HTTP 405**：此前 Host 端新增了 `POST /remote-ssh/prompt` 路由，但官方 WebServer 在路由未命中时落入静态文件服务器 fallback（`dsh-host-frontend-static`），对非 GET/HEAD 请求硬编码返回 405。桌面客户端若未重启，旧 Node 进程未加载新注册的 POST 路由，前端发送 prompt 就会命中 static fallback 报 405。

## Decision

- **Host 端开通 `POST /remote-ssh/create`（`SESSION_CREATE_ROUTE`）**：
  - 接收客户端传入的 `workspaceId` 与 `cwd`；
  - 自动剥离 `remote:` 前缀，并根据本地缓存和 baseline 映射为远端合法的 `workspaceId`；
  - 严格遵循远端 `session/create` 接口互斥契约（`accepts workspaceId or cwd, not both`），调用远端 RPC 并返回 `{ ok: true, value: { sessionId, agentPreset } }`。
- **Client 端实现 `wrap.create` 拦截与即时状态注册**：
  - 在 `client.js` 与 `src/client/index.ts` 的代理方法表中加入 `'create'`；
  - 判断目标工作区是否以 `remote:` 开头或属于注入的远程工作区；远程请求转发至 `/remote-ssh/create`，本地请求无感穿透；
  - 成功获取远端分配的 `sessionId` 后，立即将其写入 `remoteSessionIds`，并同步更新工作区视图的 `sessionIds` 列表，确保后续对该新建空白会话的 `page`、`follow`、`prompt` 立即走远程链路。
- **完善全套端到端与契约冒烟测试**：
  - `smoke-route.mjs`：覆盖 `/remote-ssh/create` 请求与响应结构校验；
  - `smoke-client-bundle.mjs`：覆盖远程 create 路由拦截、`remoteSessionIds` 实时更新与本地 create 穿透。

## Alternatives considered

- **在客户端本地虚拟伪造 sessionId**：被否。远端执行引擎有其上下文和状态管理机制，伪造的 sessionId 在后续调用 `follow` 或 `prompt` 时会被远端判定为未知会话；必须走远端 RPC 创建真实会话。
- **同时传递 workspaceId 与 cwd 给远端**：被否。经实测远端 RPC 严格校验两者互斥，必须解析后按条件只传其中一个。
- **创建后不更新本地集合，等待下一轮 60 秒轮询**：被否。创建会话后前端立刻会调用 `follow` 和 `prompt`，若不即刻加入 `remoteSessionIds`，后续调用会被当成本地会话穿透报错。

## Consequences

- 远程工作区支持创建全新会话并在其中正常交互与流式收发消息，会话管理实现全生命周期闭环。
- 阐明了 Host 路由注册与 Electron 宿主进程生命周期的关联关系（新增 Node 端路由须重启桌面客户端）。
