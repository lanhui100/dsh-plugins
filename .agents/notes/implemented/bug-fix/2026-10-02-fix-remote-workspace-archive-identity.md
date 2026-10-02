# Agent Note: normalize remote archive identities before client sync

Status: implemented

## Problem

远程工作区会话使用带主机命名空间的客户端 ID（`remote:<host>:<session>`）。归档与取消归档请求在 Host 端解码后调用远端 DSH，远端返回的是原始会话 ID。多主机模式下会话快照把归档 ID 命名空间化，但归档/置顶操作响应此前直接把原始集合返回给客户端。客户端因此把 raw ID 误判为本地归档并永久保留，已归档会话在轮询或 baseline 重置后重新出现在工作区树中；取消归档也无法清掉残留的 raw ID。

## Decision

- **Host 端（`src/route.ts`）**：在 `RemoteHostManager` 模式下，归档、取消归档、置顶、取消置顶四个 mutation 路由统一用已解析的目标主机对远端返回集合调用 `namespaceRemoteId` 后再返回客户端；legacy 单 caller 分支保持 raw ID，与其同样返回 raw 会话/归档 ID 的快照一致。
- **Client 端（`client.js`）**：
  - 独立维护 `remoteArchivedSessionIds` / `localArchivedSessionIds` 与 `remotePinnedSessionIds` / `localPinnedSessionIds`，不再通过「当前集合里不在 `remoteSessionIds` 的 ID」反推本地集合，避免远端归档会话不在 session/list 时被误判为本地并复活。
  - mutation 成功后按目标主机前缀合并远程集合，保留其它远程主机的 archived/pinned 状态。
  - `installWorkspaceGuardian` 的 `replaceArchived`/`replacePinned` 包装增加 reentrancy guard，避免 `syncArchivedSessions` 回写 `replaceArchived` 时自我递归。
  - 置顶/取消置顶真正同步到官方 `ctx.workspaces.list.pinnedSessionIds`，并在 reconcile、baseline 重置与 teardown 中与归档状态一致处理。
- **回归测试**：
  - `smoke-multi-host.mjs`：四类 mutation 的多主机请求解码、远端 raw 调用参数、namespaced 响应断言。
  - `smoke-archive-multi.mjs`（新增）：客户端模型层的多主机归档/置顶身份回归——归档/取消归档后无 raw ID 残留、单主机 mutation 不丢其它主机状态、本地 ID 跨 baseline 重置保留、置顶状态写入官方模型、teardown 只清远程状态。

## Alternatives considered

1. **仅在 client.js 中猜测并补回主机前缀**：不采纳。客户端可能同时管理多个远程主机，且路由已经拥有权威的目标主机解析结果；在客户端猜测会使集合合并依赖当前快照和主机数量，容易产生冲突。
2. **归档后只从本地 UI 列表删除会话**：不采纳。归档状态仍需由远端权威 baseline 持久化，且官方视图可能在 baseline 重置或轮询后重建列表；只删 UI 行不能修复身份不一致。
3. **修改远端 DSH 返回原始 ID 的契约**：不采纳。远端 RPC 的原始会话 ID 是其本地契约，SSH 聚合层应在边界处完成命名空间转换。
4. **legacy 单 caller 响应也强制命名空间化**：不采纳。legacy 快照返回的是 raw ID，mutation 若改为 namespaced 反而造成新的身份错配；保持 raw 与 raw 快照一致，命名空间化只作用于多主机快照已命名空间的模式。

## Consequences

- 多主机远程工作区点击归档后，官方工作区过滤器立即匹配，后续轮询或 baseline 重置不会把已归档会话重新当作未归档会话；取消归档可真正清除归档集合，无 raw ID 残留。
- 单主机的 legacy 行为保持不变。
- 归档与置顶状态在插件生命周期内与官方模型双向一致，卸载时只移除远程状态、保留本地状态。
