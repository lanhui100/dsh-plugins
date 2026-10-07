# 黑盒验收契约：工作区归档筛选（全部会话 / 仅显示已归档）

> 冻结于诊断完成、Executor 动工之前。Test Agent 据此写红相验收测试，Executor 只读此契约、禁改验收测试。

## 官方契约（只读事实，来源：DSH 客户端包）

1. `deriveGroups` → `groupByWorkspace`（`dsh-client-ui-workspace/lib/client.js`）：
   - 每个工作区视图的成员 = `workspace.sessionIds ∩ list.byId`，再经 `sessionVisible` 过滤；
   - `sessionVisible`：`origin === 'subagent'` 永不显示；`blank` 只显示当前选中那条；归档按 `archivedFilter`：`default` 隐藏、`show` 全显示、`only` 只显示已归档；
   - **`archivedFilter === 'only'` 且成员数为 0 的分组整组丢弃**。
2. 工作区树按路径前缀嵌套（`owningParentFolder`），父分组不在渲染集合时子分组被提升到根级（`childrenByParent`）。
3. 客户端会话列表 `list.byId` 是唯一的会话摘要来源；已归档会话的摘要同样来自 `session/list`（官方会话域不感知归档）。
4. 官方工作区 baseline 的 `items[].sessionIds` 是权威成员集合（含已归档）。

## 缺陷定位

- **D1（全部会话不显示已归档）**：插件把工作区视图的 `sessionIds` 取自 `groupSessionsByWorkspace(items, 50, validMap)` 的分组结果——按 `updatedAt` 倒序**截断到每工作区 50 条**，且丢弃了 baseline 的权威成员集合。已归档会话更旧，永远进不了任何视图成员，故 `show` 模式下也不显示。
- **D2（仅显示已归档：折叠菜单消失 + 工作区显示不全）**：
  - `local:hostroot` 与 `remote:<host>:hostroot` 是插件合成的**容器视图**，`sessionIds` 恒为 `[]`；官方在 `only` 模式丢弃空分组 → 容器连同折叠层级一起消失；
  - 受 D1 影响，所有远程工作区视图在 `only` 模式下成员为空 → 同样被丢弃 → 工作区"显示不全"。

## 契约条目（验收测试逐条锚定）

### C1 — Host 快照下发权威成员集合
`GET /remote-ssh/sessions` 的每个 `workspaces[]` 元素新增字段 `sessionIds: string[]`（已命名空间化）：
- 顺序 = baseline `items[].sessionIds`（该 cwd）顺序在前，其后追加本轮发现但 baseline 未收录的会话 id；
- 去重；全部经 `namespaceRemoteId(host, id)`；
- 多主机聚合分支与单 caller 回退分支**行为一致**；baseline 缺失时退化为现有分组结果（不得抛错）。

### C2 — 客户端视图使用权威成员集合
`reconcileRemoteSource` 构造远程工作区视图时：`sessionIds` 取 `ws.sessionIds`（存在且为数组时），否则回退 `ws.sessions.map(s => String(s.sessionId))`。
推论：已归档远程会话成为其所属工作区视图的成员 → `show` 模式下在工作区内可见、`only` 模式下工作区分组不再被丢弃。

### C3 — 容器视图在"仅显示已归档"下存活
每个 `*:hostroot` 视图的 `sessionIds` **恰好持有 1 个代表会话**（其余保持不变）：
- 选择规则：在该容器作用域内的已归档会话中，优先选**不被任何同级工作区视图成员集合收录**的（避免重复行）；无此候选时退化为选最近更新的已归档会话；
- 远程容器（`remote:<host>:hostroot`）：代表会话 id 从**插件自己拥有的**同级远程工作区视图成员集合中剔除（不产生重复行）；
- 本地容器（`local:hostroot`）：代表会话取自官方 `archivedSessionIds` 中的非远程 id；插件**不得修改官方工作区视图**（不得改写官方 `items`），因此当代表会话已被官方工作区视图收录时，允许出现 1 行重复；
- 作用域内没有已归档会话时，容器 `sessionIds` 保持 `[]`（此时 `only` 模式丢弃该容器是正确行为）；
- 代表会话必须真实存在于 `list.byId` 且 `origin !== 'subagent'`、非 `blank`（否则 `sessionVisible` 恒 false，容器仍会被丢弃）。

## 非目标（Non-Goals）

- 不改官方 DSH 任何代码/模型。
- 不改归档/取消归档/置顶的 RPC 语义与身份空间（既有 ADR 保持）。
- 不做筛选器 UI 本地化、不新增自定义面板。
- 不追求"仅显示已归档"下容器行内直接铺开全部归档会话（会与工作区行重复）。

## 验收门禁

- `pnpm --filter dsh-plugin-remote-ssh test` 全绿（含新增验收测试）。
- `pnpm --filter dsh-plugin-remote-ssh typecheck` 零错误。
- 红相先行：新增验收测试在实现前必须以 AssertionError 失败，并单独锚定提交。