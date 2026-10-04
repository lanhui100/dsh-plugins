# Agent Note: Support remote session model selection and proxy session.selectModel RPC

Status: implemented

## Problem

在远程主机 SSH 会话中，当用户在 Web GUI 顶部或底部模型切换选择器中更换模型时，界面报错：
`session/not-found: session "<session-id>" not found`。

经排查根因如下：
1. 官方前端模型选择器模块 `@deepseek-ai/dsh-client-ui-model-selection` 的 `ModelDirectory` 在用户选择模型时，直接调用其持有的 `this.sessions.selectModel({ sessionId, provider, model, reasoningEffort })`。
2. 该 `this.sessions` 引用在 `ModelDirectoryResolver.directoryFor(sessionId)` 中传入，其真实对象为官方 RPC 客户端 `ctx.remote.session`（对应服务端 `@deepseek-ai/dsh-api-session-controller#session/selectModel`）。
3. 在 `dsh-plugin-remote-ssh` 中，客户端拦截器 `installSessionProxy(ctx)` 仅代理了 `page`、`follow`、`projections`、`prompt`、`cancel`、`rename`、`attachment`、`create` 等 8 个方法，未包含 `selectModel`。
4. 因此，当用户在远程会话中切换模型时，`selectModel` 请求未被代理，而是穿透发往本地 DSH Host。本地 DSH 会话表中不存在该远程会话（`ApiSessionNotFound`），遂返回 `session/not-found` 错误。

## Decision

1. **Host 端提供远程模型切换路由与 RemoteCaller 接口**：
   - 在 `packages/dsh-plugin-remote-ssh/src/remote.ts` 为 `RemoteCaller` 增加 `selectRemoteSessionModel(sessionId, provider, model, reasoningEffort?, signal?)` 方法，通过隧道向远端 DSH 发送 `session/selectModel` 调用。
   - 在 `packages/dsh-plugin-remote-ssh/src/route.ts` 注册 `POST /remote-ssh/session-select-model`（常量 `SESSION_SELECT_MODEL_ROUTE`），解析请求中的 `sessionId`、`provider`、`model`、`reasoningEffort`，通过 `resolveTarget(rawSessionId)` 路由到正确的远端主机并调用 `selectRemoteSessionModel`。
2. **Client 端代理拦截 `ctx.remote.session.selectModel`**：
   - 在 `packages/dsh-plugin-remote-ssh/client.js` 与 `src/client/index.ts` 的 `installSessionProxy` 中将 `selectModel` 加入被代理的 `methods` 数组。
   - 当调用目标 `sessionId` 命中 `isRemote(id)` 时，转发至 Host 的 `SESSION_SELECT_MODEL_ROUTE`；调用成功后就地更新本地会话 projections 缓存中的 `modelSelection` 投影，保持 UI 状态一致与即时回显；本地会话继续原样透传。
3. **增加契约与冒烟测试**：
   - 新增 `smoke-select-model.mjs`（不依赖实时隧道的独立冒烟）：断言 `SESSION_SELECT_MODEL_ROUTE` 已注册、缺参返回 400、合法请求转发至 caller（携带原始 sessionId/provider/model/reasoningEffort）并回传 selected、隧道故障优雅降级为 200 ok:false。
   - 在 `smoke-client-bundle.mjs` 中增加针对 `ctx.remote.session.selectModel` 的代理拦截与透传行为测试（远端命中 `/remote-ssh/session-select-model`，本地原样透传）。
   - 在 `smoke-route.mjs` 中注册 `SESSION_SELECT_MODEL_ROUTE` 并加入路由存在性校验与缺参 400 分支（随实时隧道用例运行）。

## Alternatives considered

- **在本地 DSH 创建占位空会话（Stub Session）欺骗本地 selectModel**：
  破坏了会话持久化与状态隔离，且无法将模型切换指令同步给真实远端主机，远端执行仍然使用旧模型。
- **让客户端直接通过 WebSocket 或裸 fetch 请求远端 DSH**：
  破坏了统一的 Host 隧道及鉴权体系（cookie + token + 多主机路由），不可行。

## Consequences

- 远程会话更换模型时不再报错 `session/not-found`，指令正确发往远端主机生效。
- **端到端实证**：`smoke-select-model-live.mjs` 经真实 dev 隧道对远端会话执行同值 `session/selectModel`，成功返回 `selected`（`ponyllm/gemini-3.8-flash-high`）；被远端活跃写句柄占用的会话返回 `session/writer-held`（官方 UI 按其「会话被占用」文案处理）——两者都证明 RPC 已穿透到远端 DSH，修复前该请求会打到本地并报 `session/not-found`。
- 自动化构建、类型检查与冒烟测试全部通过（`smoke-select-model.mjs` 离线路由级 + `smoke-client-bundle.mjs` 客户端代理级 + live 端到端）。
