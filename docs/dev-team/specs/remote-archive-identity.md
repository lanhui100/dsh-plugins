# Remote archive identity normalization

Status: Implemented

## Background and goal

远程会话在客户端以 `remote:<encoded-host>:<encoded-session-id>` 标识；远端 DSH 的 workspace RPC 只认识原始会话 ID。归档、取消归档、置顶和取消置顶必须在 Host 路由边界完成双向转换，保证操作响应与会话快照处于同一身份空间。

## Scope

- 修改 `packages/dsh-plugin-remote-ssh/src/route.ts` 的四个 workspace session mutation routes。
- 在 `packages/dsh-plugin-remote-ssh/smoke-multi-host.mjs` 增加多主机 mutation 回归测试。
- 必要时同步包 README 的当前契约说明。

## Non-goals

- 不修改远端 DSH RPC 契约。
- 不改变本地会话的 archive/pin 行为。
- 不重写 client.js 的列表投影算法，不用 UI DOM 删除替代权威状态同步。

## Behavior

1. 请求包含命名空间 ID 时，Host 使用 `resolveTarget` 定位 host/caller，并将原始 session ID 发送给远端。
2. RemoteHostManager 模式下，远端返回 `archivedSessionIds` / `pinnedSessionIds` 原始 ID 集合时，Host 用目标 host 调用 `namespaceRemoteId` 后返回；legacy 单 caller 保持 raw ID 与其 raw 快照一致。
3. 客户端独立维护本地/远程 archived 与 pinned 集合，mutation 按目标主机前缀合并，保留其它主机与本地状态。
4. 官方 `replaceArchived`/`replacePinned` 包装带 reentrancy guard；置顶状态同步到官方模型。

## Technical approach

Host 端共享 helper `namespaceSessionMutationResult(host, result, field)` 只转换对应字段并保留其它字段，在 `isManager` 分支用于四类 mutation 响应。客户端用 `mergeRemoteMutationIds` 按主机前缀保留其它主机集合，`syncArchivedSessions`/`syncPinnedSessions` 合并本地+远程并带 `syncingArchived`/`syncingPinned` 递归保护。

### Alternatives considered

- 只在 client.js 侧给 raw ID 猜测主机：多主机场景无法可靠判定归属。
- 归档后只从 UI 列表移除：轮询/baseline 重置会恢复错误状态。
- 改远端 DSH 返回 namespaced ID：违反远端本地契约。
- legacy 单 caller 强制 namespaced：与其 raw 快照冲突，不采纳。

## Impact and dependencies

依赖 `resolveTarget` 的 host 解析和 `namespaceRemoteId`。影响 Host HTTP mutation 响应契约（仅 manager 模式）与客户端状态合并；legacy 单 caller 行为不变。

## Task breakdown

- [x] Diagnose raw-vs-namespaced response mismatch.
- [x] Add decision/task records.
- [x] Implement shared response normalization helper (manager mode).
- [x] Implement client local/remote set split, per-host merge, pin sync, recursion guard.
- [x] Add multi-host archive/unarchive/pin/unpin assertions (route + client level).
- [x] Run tests, typecheck, build, and independent code review.

## Risks, rollback, migration

回滚只需恢复 route helper、client 状态合并与 smoke 断言；无需数据迁移，远端持久化集合不变。`smoke-route.mjs` 需真实远端 fixture（含写操作），离线环境不执行。

## Test plan

- `node packages/dsh-plugin-remote-ssh/smoke-multi-host.mjs`
- `node packages/dsh-plugin-remote-ssh/smoke-archive-multi.mjs`
- `node packages/dsh-plugin-remote-ssh/smoke-client-bundle.mjs`
- `node packages/dsh-plugin-remote-ssh/smoke-manager.mjs` 等离线 smoke
- `pnpm --filter dsh-plugin-remote-ssh typecheck`
- `pnpm --filter dsh-plugin-remote-ssh build`

## Acceptance criteria

- [x] Manager-mode mutation responses contain namespaced IDs for archive, unarchive, pin and unpin.
- [x] The remote caller receives raw IDs and the route sends raw IDs to it.
- [x] Local and other-host remote archived/pinned IDs are preserved by client-side merge.
- [x] No raw-ID residue survives archive→reconcile→unarchive→reconcile.
- [x] Official replaceArchived/replacePinned wrappers do not recurse.
- [x] Existing smoke/typecheck/build checks pass.

## Review record

- Plan/spec review A (根因审查): 确认 multi-host 身份不一致为根因；P1 指出 mutation 未统一 namespaced、反推本地集合不可靠、乱序覆盖风险。
- Plan/spec review B (测试设计): 指出 legacy/manager 契约差异、guardian 递归、pin 未同步、缺多主机 mutation 覆盖；提供可执行门禁清单。
- Plan/spec review C (架构复核): 确认方案可实现；要求四路统一 helper、递归保护、pin 同步、多主机测试。
- Code review A/B: 结论为修复方向正确；采纳四路 helper、per-host 合并、递归 guard、pin 同步与 smoke-archive-multi 回归；legacy 分支保持 raw 与快照一致。
- Consultant: 未升级（局部 route/client 契约问题，聚焦回归足够）。

