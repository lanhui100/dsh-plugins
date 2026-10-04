# Agent Note: Fix stale remote host and workspace rows remaining after disconnect

Status: implemented

## Problem

在 Web GUI 工作区侧边栏中，通过「添加远程主机」弹窗断开已连接的远程主机后，工作区侧边栏中的该远程主机根目录（hostroot）以及所属的所有远程工作区和会话未能正常消失。

经诊断排查，根因包含服务端和客户端两层：
1. **服务端 `/remote-ssh/sessions` 路由对零主机返回 503 阻断同步**：
   当用户断开唯一的远程主机（或断开所有远程主机）后，`manager.removeHost(host)` 移除了主机条目，`manager.getHostNames()` 为空。但在 `packages/dsh-plugin-remote-ssh/src/route.ts` 中，`readyCallers.length === 0` 分支未区分「尚在连接中」与「无任何主机注册」，无条件返回 `503 { error: 'tunnel-not-ready', hosts: [] }`。
2. **客户端 `reconcileRemoteSource` 遇到非 200 响应直接中断**：
   在 `packages/dsh-plugin-remote-ssh/client.js` 中，`reconcileRemoteSource` 收到 503 后执行 `if (!response.ok) return;`，导致侧边栏模型（`ctx.workspaces.list` 与 `ctx.sessions`）无法接收到移除旧视图的指令，已断开主机的视图（包括 `cachedWorkspaceViews`）全部残留，甚至在官方 `replaceBaseline` 重置时还会被守卫逻辑重新注入。
3. **缺少断开主机的主动清理机制**：
   断开按钮的点击回调中，在调用 `POST /remote-ssh/remove-host` 成功后仅触发异步的 `void reconcileRemoteSource(ctx)`，缺少客户端侧的显式主机资源同步卸载函数，一旦后续网络轮询失败或遇到多主机中其余主机未就绪（503），已断开的主机视图依然滞留。

## Decision

1. **服务端修正：零主机场景返回空集合 200 响应**：
   - 在 `packages/dsh-plugin-remote-ssh/src/route.ts`（及对应 `lib/route.js`）的 `SESSIONS_ROUTE` 处理器中，增加优先判断：当 `manager.getHostNames().length === 0` 时，直接返回 `200 { hosts: [], homes: [], total: 0, workspaces: [], sessions: [], archivedSessionIds: [], pinnedSessionIds: [] }`，允许客户端顺畅执行清空动作。
2. **客户端实现宿主主动卸载与 503 差异化修剪**：
   - 在 `client.js` 与 `src/client/index.ts` 中实现 `removeRemoteHost(ctx, targetHost)`：
     - 精准匹配属于 `targetHost` 的会话 ID（从 `remoteSessionIds` 移除并调用 `sessions.handleSessionRemoved`）；
     - 精准匹配属于 `targetHost` 的工作区和 hostroot 视图（从 `injectedWorkspaceIds` 移除并调用 `workspaces.removeView`）；
     - 从 `cachedWorkspaceViews` 中过滤掉该主机视图，防止 baseline 守卫死灰复燃；
     - 清理该主机的归档、固定会话状态、交互弹窗及相关索引，并重置快照指纹。
   - 在断开按钮（`discBtn`）的点击成功路径中，立即同步调用 `removeRemoteHost(ctx, item.host)`，保证侧边栏与工作区瞬时响应。
   - 在 `reconcileRemoteSource` 的非 ok 分支中，当状态码为 503 且响应体携带有效 `hosts` 列表时，比对当前注入的工作区主机，自动修剪任何不在 `hosts` 列表中的残留远程主机（若 `hosts` 为空则移除全部远程主机）。
3. **测试覆盖**：
   - 在 `smoke-workspace-btn.mjs` 中对 `WorkspacesService` 注入 `removeView` 记录器，断言断开主机操作派发后，对应主机的 `remote:dev:hostroot` 已被确切移除。
   - 在 `smoke-multi-host.mjs` 中增加测试用例：移除全部主机后，请求 `/remote-ssh/sessions` 必须正确返回 200 状态码及空的 workspaces/sessions 列表，而非 503 报错。

## Alternatives considered

- **仅在客户端硬编码根据响应 503 清空全部数据**：
  若存在多台远程主机且其中某台隧道临时重连，会误将未断开的远程主机工作区全部清空，不可行。
- **仅在服务端改 200，不加客户端即时清理**：
  依然依赖网络轮询往返，且在多主机存在离线节点时依然无法解决 503 导致的残留问题。

## Consequences

- 断开远程主机后，工作区侧边栏中的该主机根目录（hostroot）以及所属工作区和会话立即正常消失。
- 无论单主机断开还是多主机逐一断开，侧边栏均能即时、可靠地清理对应条目，不再出现视图滞留。
- 既有 13 项 smoke 测试全数通过（含拓展断言）。
