# Agent Note: fix-remote-workspace-lifecycle-add-delete-proxy

Status: implemented

## Problem
在远程主机菜单中添加或新建远程工作区，以及删除远程工作区时出现若干致命缺陷：
1. 新建/添加工作区时，`createWorkspace` 成功后遗漏清除 `RemoteCaller` 中的 30s `cachedBaseline` 缓存，导致新建或添加的工作区在接下来 30 秒内完全无法被拉取到；且前端 `snapshotFingerprint` 脏检查由于数据未变直接提前退出，导致侧边栏零响应。
2. 新建目录工作区路由 `/remote-ssh/add-workspace` 中调用 `session/create` 传参为 `{ cwd }` 而非 `{ workspaceId }`，导致远端服务端仅创建孤立会话而不执行 `workspace.attachSession`，新会话无法挂载到新工作区。
3. `manager.createHomeDirectory` 返回值丢弃了 `workspace` 实体，且路径包含末尾斜杠导致与远端 `realpath` 权威路径失配。
4. 删除远程工作区时报错 `workspace delete failed: workspace/not-found: Workspace "remote:dev:workspace%3A..." not found`，原因是在 `client.js` 的 `installSessionProxy` 中未代理拦截 `ctx.remote.workspace.delete`，导致请求带着远程合成工作区 ID 穿透至本地 DSH 报 not-found。

## Decision
1. 在 `remote.ts` 中：
   - 在 `createWorkspace` 返回成功后立即清除 `this.cachedBaseline`；
   - 增加 `clearBaselineCache()` 与 `deleteWorkspace(workspaceId)` 方法，在删除成功后清空缓存。
2. 在 `manager.ts` 中：
   - 让 `createHomeDirectory` 获取并回传远端 `workspace` 实体（含真实 `workspaceId`）。
3. 在 `route.ts` 中：
   - 增加 `WORKSPACE_DELETE_ROUTE = '/remote-ssh/workspace-delete'` 路由，解析远程主机与合成 ID 并映射到真实远端 UUID，调用远端 `workspace/delete`；
   - 规范化 `register-workspace` 与 `add-workspace` 路径（剥离末尾斜杠、规范展开 `~`）；
   - 在 `add-workspace` 中优先传递 `workspaceId` 调用 `session/create`。
4. 在 `client.js` 中：
   - 在 `installSessionProxy` 的 `wsMethods` 中加入 `delete`，拦截远程工作区删除请求，转发至 `/remote-ssh/workspace-delete`；
   - 在添加、新建及删除工作区成功后，重置 `lastSnapshotFingerprint = null`，并触发 `reconcileRemoteSource(ctx)` 驱动官方模型即时渲染。

## Alternatives considered
- *仅在前端本地调用 `removeView` 而不通知远端*：会导致远端 DSH 仍保留该工作区注册项，下一次轮询拉取 baseline 时已删除的工作区会“死而复生”，不符合持久化契约。
- *直接使用远端原生 UUID 作为前端 `workspaceId`*：在多主机环境下不同主机可能会存在 ID 冲突或无法区分所属主机，采用带命名空间的合成 ID 是多主机架构的核心基石，因此必须在中间层建立合成 ID 到真实 UUID 的双向映射与代理。
