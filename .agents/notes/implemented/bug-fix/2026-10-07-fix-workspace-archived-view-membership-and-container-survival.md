# Agent Note: Fix Workspace Archived View Membership And Container Survival

Status: implemented

## Problem

用户在使用 `dsh-plugin-remote-ssh` 插件时反馈两项与工作区会话筛选相关的缺陷：
1. **工作区会话筛选选择“全部会话”（`show`）时，工作区内不显示已归档会话**。
2. **选择“仅显示已归档”（`only`）时，原有的本地和远程主机折叠菜单（hostroot）消失，且工作区显示不全**。

根因分析：
1. **工作区视图缺少权威成员列表**：
   - Host 端 `GET /remote-ssh/sessions`（`src/route.ts`）在下发 `workspaces[]` 时仅携带 `sessions: RemoteSessionItem[]`（受活跃会话与 50 条上限截断），未携带权威 baseline 中的完整 `sessionIds`。
   - Client 端（`client.js`）的 `reconcileRemoteSource` 构造远程工作区视图时，`sessionIds` 仅通过 `ws.sessions.map(...)` 提取，导致已归档的远程会话从未进入工作区视图的成员集合，因而在官方 `sessionVisible` / `groupByWorkspace` 的 `show` 模式下无法在工作区内渲染。
2. **容器视图 `sessionIds` 为空导致官方归档筛选器整组剔除**：
   - 合成的主机容器视图 `local:hostroot`（`C:/`）与 `remote:<host>:hostroot` 的 `sessionIds` 恒为空数组 `[]`。
   - 官方 `groupByWorkspace` 规则在 `archivedFilter === 'only'` 时，若工作区组没有匹配的可见归档会话（`members.length === 0`），会将该工作区分组直接剔除（drop）。这导致本地与远程主机折叠菜单整行消失；同时缺少归档会话的远程工作区也被剔除，导致工作区展示残缺。

前序关联决策：
- 链入 [.agents/notes/implemented/feature/2026-10-01-filter-authoritative-remote-workspaces-and-enhance-visuals.md](.agents/notes/implemented/feature/2026-10-01-filter-authoritative-remote-workspaces-and-enhance-visuals.md)（该条接入了远端 Baseline，但此前未下发 `workspaces[].sessionIds`）。

## Decision

按照冻结黑盒契约（`docs/dev-team/specs/workspace-archived-view-contract.md`）实现 C1/C2/C3：

1. **C1 — Host 路由下发权威成员集合**：
   - 在 `packages/dsh-plugin-remote-ssh/src/route.ts` 与 `lib/route.js` 的多主机聚合和单 caller 回退两个分支中，为每个 `workspaces[]` 组下发命名空间化的 `sessionIds: string[]`。
   - 顺序：baseline `items[].sessionIds`（权威排序）在前，本轮新发现会话追加在后，去重后统一通过 `namespaceRemoteId(host, id)`；
   - baseline 缺失时安全降级为当前分组结果，不产生 502。
   - 在 `packages/dsh-plugin-remote-ssh/src/sessions.ts` 与 `src/client/index.ts` 补充对应接口字段声明。

2. **C2 — Client 端工作区视图使用权威成员集合**：
   - 在 `packages/dsh-plugin-remote-ssh/client.js` 的 `reconcileRemoteSource` 中，构造远程工作区视图时优先取 `Array.isArray(ws.sessionIds) ? ws.sessionIds.map(String) : (ws.sessions || []).map((s) => String(s.sessionId))`。
   - `snapshotFingerprint` 同步纳入 `ws.sessionIds`，确保权威成员更新能触发轻量重渲染。
   - 远端已归档会话顺利进入对应远程工作区视图成员列表，在 `show` 模式下正常渲染。

3. **C3 — 主机容器视图归档存活与代表会话选择**：
   - 为每个 `*:hostroot` 容器视图注入恰好 1 个代表已归档会话，使其在官方 `only` 模式下保留非空分组从而存活：
   - **远程容器 (`remote:<host>:hostroot`)**：在属于该 host 的远程已归档会话中，优先挑选不被任何同级远程工作区视图收录的会话；若所有归档会话均归属某工作区，则选择最近更新的归档会话，并将其从插件自有远程工作区视图成员列表中剔除，确保树中不产生重复行。
   - **本地容器 (`local:hostroot`)**：从官方 `archivedSessionIds` 中挑选非远程会话作为代表，插件严禁篡改官方工作区项。
   - 代表会话必须存在于会话索引中且非 subagent、非 blank。若作用域内无有效已归档会话，则 `sessionIds` 保持 `[]`。

## Alternatives considered

1. **修改官方 `groupByWorkspace` 过滤逻辑**：
   被否决。官方 DSH 前端核心分发包（`dsh-client-ui-workspace`）为宿主运行时，插件无法也不应侵入修改官方包源码；必须通过插件自身的视图与状态适配官方模型规则。
2. **将主机下全部已归档会话直接平铺塞入 `hostroot`**：
   被否决。会导致原本归属于某个工作区的已归档会话在宿主根节点与子工作区节点重复出现两次，破坏工作区树状层级关系。
3. **本地容器修改官方 `workspaces.items` 剔除代表**：
   被否决。官方本地工作区属于宿主私有状态，外部插件强行篡改会导致本地工作区持久化配置损坏。按契约保持官方工作区只读。

## Consequences

- 工作区会话筛选切为“全部会话”（`show`）时，工作区内完整展示活跃与已归档远程会话。
- 工作区会话筛选切为“仅显示已归档”（`only`）时，本地主机菜单 `[本地]` 与各远程主机折叠菜单 `[<host>]` 稳定存活，不被官方筛选器整组丢弃。
- 机械门禁：56 条断言黑盒验收测试 `smoke-workspace-archived-views.mjs` 以及现有 16 项 smoke 测试全绿通过；`tsc` 零类型报错。
