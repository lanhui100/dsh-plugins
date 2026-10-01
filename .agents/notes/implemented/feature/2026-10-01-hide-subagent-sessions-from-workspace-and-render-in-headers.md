# Agent Note: Hide subagent and team sessions from workspace tree and render in session headers

Status: implemented

## Problem

在远程工作区接入官方桌面端侧边栏后，用户指出存在以下两处会话归属与展示的结构性缺陷：
1. **子智能体会话平铺在工作区侧边栏树中**：
   - 远程主机会话中包含大量由父会话派生的子智能体（subagent）会话以及 Agent Team 的 teammate 会话；
   - 此前插件 Host 端在 `groupSessionsByWorkspace` 中未做过滤，且丢弃了远端会话的 `origin: 'subagent'` 和 `parentSessionId` 标记；
   - 导致所有子会话被直接平铺塞入工作区文件夹中，污染了原本清晰的顶层会话列表。
2. **头部子智能体下拉框与 Agent Team 协同栏无法感知远程会话**：
   - 官方桌面端原生通过主会话的 `subagentCatalog` 和 `agentTeam` 投影，在窗口顶部渲染子智能体下拉树（`CatalogDropdown`）和团队协同栏（`AgentTeamBar`）；
   - 由于原插件未透传主会话的投影数据，且未在客户端 `ctx.sessions` 中以正确元数据注册子会话，导致顶部组件无法渲染子智能体树和团队状态；
   - 同时，当客户端请求子会话内容时，远端 DSH 强校验要求子智能体会话必须携带 `kind: 'subagent'` 与父会话地址，否则报错拒绝。

## Decision

1. **Host 端保全会话源信息与精准裁剪投影**：
   - 在 `RemoteSessionItem` 中补齐 `origin?: string`、`parentSessionId?: string` 和 `projections`；
   - 在 `listRemoteSessions` 中安全提取远端原始元数据，并将投影 values 精准收敛为 UI 必需的关键字段（`title`、`subagentCatalog`、`agentTeam`、`subagent`、`modelSelection`），大幅削减网络传输体积（从全量 2.18 MB 压缩至 1.06 MB）；
   - 在 `groupSessionsByWorkspace` 中显式过滤 `item.origin === 'subagent'`，确保工作区直属会话数组 `ws.sessions` 和计数 `total` 仅包含根主会话。
2. **全量会话下发与子智能体寻址适配**：
   - `GET /remote-ssh/sessions` 在下发 `workspaces` 的同时，新增下发清洗后的全量 `sessions` 列表；
   - 在 Host 端维护 `subagentParents` 映射；在 `GET /remote-ssh/session-raw` 中支持读取 `parentId` 参数，并对子智能体会话动态构造 `{ kind: 'subagent', parentSessionId, childSessionId, mode: 'unknown' }` durable address，彻底解决远端 `session/page` 对子智能体必须携带父地址的硬性鉴权校验。
3. **Client 端分流注入与官方头部组件联动**：
   - `reconcileRemoteSource` 将 `ws.sessions` 的 ID 赋给 `workspace.sessionIds`（工作区树只渲染主会话）；
   - 向 `ctx.sessions.handleSessionAdded` 全量注入会话（带 `origin: 'subagent'`、`parentId: parentSessionId` 与 `projections`）：
     - 官方 `sessionVisible` 依据 `origin === 'subagent'` 自动将其从侧边栏工作区树中排除；
     - 官方 `SessionsService.applyListBlock` 依据 `projections` 自动在 `projectionsBySession` 中建立 `subagentCatalog` 和 `agentTeam` 存储；
     - 官方 `CatalogDropdown` 与 `AgentTeamBar` 原生从 `projectionsBySession` 与 `byId` 中匹配子智能体列表、运行状态圆点与显示标题，渲染于会话头部。
4. **客户端代理无缝劫持子会话**：
   - `installSessionProxy` 在拦截 `page`、`follow`、`projections` 时，通过 `sessionTargetOfRequest` 解析 `address.childSessionId` 与 `parentSessionId`；
   - 调用 `remoteFetchRaw` 时透传 `parentId`，使点击头部子智能体或 Agent Team 成员跳转查看会话记录完全原样工作。

## Alternatives considered

- **完全丢弃子智能体会话数据（不注入 `ctx.sessions`）**：
  被否。若完全不注入，官方头部 `CatalogDropdown` 和 `AgentTeamBar` 在渲染子节点时无法在 `ctx.sessions.list.byId` 中找到对应记录，导致标题显示为 raw uuid、丢失 running 状态，且点击打开子会话时官方路由因找不到会话而报错。
- **将子智能体会话作为嵌套折叠项直接挂在侧边栏主会话下方**：
  被否。官方侧边栏工作区树采用扁平会话列表结构，本身不支持任意层级嵌套会话；官方原生交互模式即是“侧边栏只留主会话，子智能体与 Team 统一在顶部栏导航与切换”，遵循官方规范才能获得最佳体验。
- **由客户端逐个向远端拉取每个主会话的投影**：
  被否。远端有上百个主会话，若每个主会话独立发起 RPC 拉取投影，启动时将产生海量网络往返；在 `SESSIONS_ROUTE` 中统一附带清洗后的投影单次交付效率最高。

## Consequences

- 侧边栏远程工作区文件夹内仅展示顶层主会话，子智能体与 teammate 会话不再平铺刷屏；
- 会话头部原生激活子智能体下拉树（显示子会话数量、运行指示点、各层级展开导航）；
- 涉及 Agent Team 的会话顶部原生激活团队成员协同栏；
- 点击子智能体与团队成员能够无缝通过代理拉取远端历史记录并正常浏览；
- 契约冒烟测试全面覆盖子会话与主会话的分流断言、投影字段保全与父地址代理校验。
