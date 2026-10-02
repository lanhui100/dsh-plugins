# Agent Note: Support remote session actions and workspace proxy for archive, pin, and rename

Status: implemented

## Problem

用户在桌面端操作远程会话（右键菜单或侧边栏行操作）时，归档（archive）、取消归档（unarchive）、置顶（pin）、取消置顶（unpin）以及重命名（rename）毫无响应：
1. **调用链脱节**：官方侧边栏会话菜单中，归档/取消归档调用的是 `ctx.remote.workspace.archiveSession` / `unarchiveSession`，置顶/取消置顶调用的是 `ctx.remote.workspace.pinSession` / `unpinSession`，重命名调用的是 `ctx.remote.session.rename`。此前 `client.js` 仅拦截了 `remote.session`，完全未代理 `remote.workspace`，导致归档和置顶请求直冲本地 Host；本地 Host 找不到该远程会话抛出错误，而官方 `ui-workspace` 静默吞掉错误，表现为点击无任何响应；
2. **重命名未接通**：此前 `remote.session.rename` 写死为返回 `Promise.resolve({ ok: false, error: ... })`（未接通状态）；
3. **远端 Gateway RPC 协议参数结构要求**：远端 Typert 生成的 RPC 契约要求参数包裹在 `{ request: { ... } }` 对象中，直接传裸对象会报参数不匹配；且操作成功后若不清空 Host 端 `cachedBaseline` 缓存，30 秒内拉取的列表依然为陈旧状态。

## Decision

- **Host 端（`src/remote.ts` & `src/route.ts`）实现会话操作 RPC 与路由**：
  - 在 `RemoteCaller` 中实现 `archiveRemoteSession`、`unarchiveRemoteSession`、`pinRemoteSession`、`unpinRemoteSession` 与 `renameRemoteSession` 5 个方法；
  - 严格按照远端 Gateway Typert 契约将参数包裹为 `{ request: { sessionId, ... } }`，并正确解析返回的 `archivedSessionIds`、`pinnedSessionIds` 与 `{ title, seq }`；
  - 每次写操作成功后，立即将 `cachedBaseline = null` 清空缓存，确保后续快照拉取即时拿到远端最新状态；
  - 在 `src/route.ts` 中注册并暴露 5 个 HTTP POST 路由：
    - `/remote-ssh/session-archive`
    - `/remote-ssh/session-unarchive`
    - `/remote-ssh/session-pin`
    - `/remote-ssh/session-unpin`
    - `/remote-ssh/session-rename`
  - 在 `src/index.ts` 中导出对应的路由路径常量。
- **Client 端（`client.js` & `src/client/index.ts`）实现 `remote.workspace` 代理与状态合并**：
  - 在 `exports.inject` 与类型定义中增加 `'remote.workspace'`；
  - 在 `installSessionProxy` 中代理 `ctx.remote.workspace` 的 4 个方法（`archiveSession`, `unarchiveSession`, `pinSession`, `unpinSession`）；
  - 增加分支判断：当 `sessionId` 为远程会话时（`isRemote(sid)`），向对应的 Host POST 路由发起请求；非远程会话则 passthrough 调用本地原始方法；
  - 实现本地与远端状态的双向隔离与合并：对于归档状态，将远端返回的 `archivedSessionIds` 与本地本地独有的归档集合合并，调用 `syncArchivedSessions` 同步至官方 `ctx.workspaces.list` 并返回给官方调用方；对于置顶状态同理处理；
  - 重写 `wrap.rename`：远程会话向 `/remote-ssh/session-rename` 发起请求，并在本地 `ctx.sessions` 内存模型中即时回显标题，同时返回更新后的 `{ title, seq }`；
  - 在插件 `dispose` 清理链中增加 `restoreWorkspaceNs`，确保插件卸载时还原原始方法属性描述符。
- **双层测试矩阵保障行为与契约**：
  - `smoke-route.mjs`（Section 9）：在真实远端网关与 SSH 隧道环境下，对归档、取消归档、置顶、取消置顶、重命名进行全链路往返测试，并在测试完毕后自动复原现场；
  - `smoke-client-bundle.mjs`：在 Cordis Context 模拟环境中，对 `clientExports.inject` 声明、远程调用分支、本地 passthrough 分支、状态同步合并及 teardown 恢复进行 100% 机械断言。

## Alternatives considered

- **在客户端自绘替代菜单或劫持右键 DOM**：被否。官方侧边栏已经拥有高度成熟的无障碍支持、快捷键和主题渲染体系；通过 Cordis 依赖注入代理 `ctx.remote.workspace` 与 `ctx.remote.session` 是官方设计的标准扩展点，不仅侵入性最小，还能天然保持与官方原生 UI/交互完全一致。
- **仅在客户端内存中标记归档/置顶，不同步远端 Gateway**：被否。这会导致用户刷新桌面端、切换窗口或多端协同登录时归档/置顶状态全部丢失。必须持久化到远端权威 Gateway。
- **直接用远端返回的列表覆盖整个官方工作区列表**：被否。官方客户端可能同时管理本地 workspace 与远程 workspace，暴力覆盖会导致本地已归档/置顶的会话状态被远端冲掉。必须做双向隔离与 Set 合并。

## Consequences

- 桌面端侧边栏对远程会话的归档、取消归档、置顶、取消置顶和重命名点击即响应，远端即时持久化，界面状态实时更新。
- 本地会话所有操作行为保持 100% 原生行为不受影响。
- 全套测试（`smoke-route.mjs`、`smoke-client-bundle.mjs`、`smoke-question-card.mjs`、`smoke-timing.mjs`、`smoke-command.mjs`、`smoke-host-apply.mjs`）与全量 build / typecheck 均通过。
