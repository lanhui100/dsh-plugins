# Agent Note: fix remote workspace session creation

Status: implemented

## Problem

在远端工作区点击「新会话」或调用 `create` 增加新会话时出现错误：`remote-ssh: session/create failed (workspace/not-found): workspace "remote:dev:workspace%3A..." not found`。

根本原因分析：
1. 官方前端 `uiWorkspace.connectWorkspace(workspaceId)` 会先尝试复用空白会话，若无空白会话则调用 `ctx.sessions.create({ workspaceId: workspace.workspaceId })`，传入的是客户端注入的合成工作区 ID（形如 `remote:dev:workspace%3A%2Fhome%2Fdm%2Fdsh-q20-web`）。
2. `client.js` 中的 `ctx.remote.session.create` 拦截器将该请求原封不动转发给本地 Host 服务的 `/remote-ssh/create` 路由。
3. `/remote-ssh/create` 仅简单提取了 host 标签，然后将带有命名空间的原始合成工作区 ID `originalWorkspaceId` 直接作为 `request.workspaceId` 透传给远端 DSH 的 `session/create` 接口。
4. 远端 DSH 内部的 `workspaceRegistry.get(workspaceId)` 寻找该 ID 时自然无法找到，抛出 `workspace/not-found` 错误。

此外：
- 当创建成功后，`client.js` 未向本地 `ctx.sessions.handleSessionAdded` 注册会话元数据（包含 `cwd`, `blank: true`, `running: false`），导致会话管理器的空会话展示和状态同步可能延迟或缺失。

## Decision

1. **在 Host 端 (`route.ts`) 规范化处理目标工作区与路径**：
   - 解析传入的 `workspaceId`。如果是以 `remote:` 前缀包装的合成工作区 ID，提取目标 host 与路径 `cwd`（或原始远端 UUID）。
   - 如果解析出的是远端文件系统路径 `targetCwd`，优先在 `pathToRemoteWorkspaceId` 缓存中匹配远端真实的 `workspaceId`；若无缓存则尝试从远端 baseline 中动态填充。
   - 若匹配到真实远端工作区 ID，使用 `{ workspaceId: realId }` 调用远端 `session/create`；若远端并未将该目录纳入工作区注册表，则使用 `{ cwd: targetCwd }` 调用远端接口（远端 DSH `session/create` 原生支持直接指定 `cwd` 创建会话并按需采用）。
   - 正确命名空间化返回的新会话 ID 并返回。

2. **在 Client 端 (`client.js`) 完善创建上下文与状态同步**：
   - 提取工作区的 `path` 作为备选 `cwd` 一并传递给 `/remote-ssh/create`，防止无命名空间合成 ID 时的降级。
   - 创建成功后，不仅更新 `ctx.workspaces.list` 视图，还调用 `ctx.sessions.handleSessionAdded` 注册包含 `blank: true`、`cwd`、`retainedBy: {}` 的会话元数据，确保官方会话管理器立即识别并渲染。

## Alternatives considered

1. **直接修改前端 UI 不传 workspaceId 只传 cwd**：违背插件无缝接入官方 UI 的设计，破坏与官方 `uiWorkspace` 和 `connectWorkspace` 的契约兼容性。
2. **在 client.js 侧完全剥离合成 workspaceId 转为 cwd**：虽然可行，但丢失了如果远端确实存在真实 workspaceId 时无法自动关联 attach 的能力；Host 端统一处理更安全可靠。

## Consequences

- 用户在官方侧边栏点击远端工作区的「新会话」图标时，能顺畅在远端对应目录创建新会话，不再抛出 `workspace/not-found` 错误。
- 新创建的空白会话立即显示在对应工作区下并处于就绪状态，可直接交互。
