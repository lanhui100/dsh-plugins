# Agent Note: Mount remote hosts as first-level folders in the workspace tree

Status: implemented

## Problem

远程工作区此前以 `<主机名> : <工作区名称>` 作为单一工作区行标题注入官方 `WorkspaceBrowser`，导致主机图标、主机名与工作区文件夹混在同一层级；用户要求明确的**三级菜单**：主机（服务器图标 + 过长截取的主机名）→ 工作区（官方文件夹图标 + 工作区名称，默认折叠）→ 会话。

## Decision

- **Host 端（`src/route.ts`、`src/remote-launcher.ts`、`src/manager.ts`）**：`GET /remote-ssh/sessions` 新增 `homes` 字段，逐主机下发远端 `$HOME` 绝对路径（新增 `RemoteLauncher.homeDirectory` / `RemoteHostManager.getHomeDirectory`，经 SSH `printf '%s' "$HOME"` 解析，失败时降级为 `undefined`）。无工作区的占位“未知工作区”改用 `${home}/unknown-workspace` 作为 cwd，使其能嵌套在主机根文件夹之下。
- **Client 端（`client.js`）**：
  - 为每台已连接主机 upsert 一个一级**主机根工作区**：`workspaceId: 'remote:<host>:hostroot'`、`path: <远端 home>`、`title: formatHostLabel(host)`（过长截断）、`sessionIds: []`；
  - 每个真实远程工作区保留 `workspaceId: namespaceRemoteWorkspaceId(host, cwd)`，标题改回**纯工作区名称**（去掉 `<host> : ` 前缀）；
  - 官方 `WorkspaceBrowser` 的“工作区树”分组依据路径前缀祖先自动把工作区嵌套进主机根文件夹（`owningParentFolder` 严格前缀 + `/` 匹配，`/home/dm` 是 `/home/dm/<ws>` 的父目录），天然得到 主机 → 工作区 → 会话 三级结构，且默认折叠；客户端自动保障视图分组处于 `workspace-tree` 模式（`ensureWorkspaceTreeMode`），并且采用逆序 upsert 确保主机根节点排在列表顶部；
  - 移除旧的“天线角标”伪元素与 `.dsh-remote-host-badge` 标题注入；主机图标采用纯 CSS `::after` 遮罩（mask）呈现中性标签色（`currentColor`，不显示为蓝色），严禁直接使用 JS 修改 React 管理的 `folderEl.innerHTML`（避免 React 在展开/收起切换 `<svg>` 时抛出 `removeChild` 导致整个侧边栏白屏崩溃）；
  - 主机行的折叠控制采用纯声明式 CSS 联动（`:has()` 与 `~` 兄弟选择器结合 DSH 原生 `aria-expanded` 属性），精确匹配 URL 编码后的工作区前缀（`workspace:remote:${h}:`，规避 `%3A` 与 `:` 字面量不匹配问题），未展开时（`:not([aria-expanded="true"])`）默认保持折叠，展开与收起由 CSS 高性能控制，彻底解除对 JS 侵入式操作 React DOM 树的依赖；
  - 远程工作区与会话行强制取消任何多余左缩进（`--dsh-workspace-indent: 0px !important; padding-inline-start: 8px !important;`），与本地工作区完全严格左对齐，会话标题 `margin-left` 设为 `6px` 消除错位；远程工作区文件夹图标通过纯 CSS 伪元素在左下角叠加微型蓝色地球仪标识（带经纬线与白边轮廓），直观标识远程属性；
  - 本地工作区统一纳入一级折叠菜单：自动扫描本地工作区并注册 `local:hostroot`（标题为“本地”，图标为纯 CSS 遮罩生成的电脑显示器图标），使本地与远端工作区形成高度对称的一级折叠管理体系；
  - 添加远程主机按钮重构：不再放置于工作区小头部，而是作为侧边栏导航行（与工作区上方的“插件”、“自动化任务”按钮采用完全相同的 `panelRow` 样式与尺寸），点击弹出添加浮层；
  - `/remote-ssh/create` 路由对 `workspaceId` 以 `:hostroot` 结尾的请求直接返回友好错误（“主机根目录不是一个工作区，请展开主机后选择具体工作区新建会话。”），避免把无效 ID 转发到远端。

## Alternatives considered

- **继续 `<主机名> : <工作区名>` 平级标题**：被否决。用户明确指出主机与工作区被混在同一级，且无法表达三级菜单。
- **Client 自绘嵌套树替代官方 WorkspaceBrowser**：被否决。会破坏官方文件夹/折叠/会话行/右键菜单复用（既有 ADR `2026-10-01-reuse-official-workspace-session-ui.md` 的原则不变）。
- **用 DOM 劫持给工作区行加缩进伪嵌套**：被否决。脆弱、破坏官方展开/折叠状态机，且搜索与拖拽语义无法对齐。
- **只在“工作区树”分组生效**：接受。官方扁平“工作区”分组下所有工作区本就平铺（本地工作区同样如此），嵌套能力由官方 grouping 提供，插件只负责提供正确的 `path` 祖先数据。

## Consequences

- 官方“工作区树”分组下，远程侧边栏呈现 主机(服务器图标+截断名) → 工作区(文件夹图标+名称) → 会话 的三级结构，工作区默认折叠。
- `GET /remote-ssh/sessions` 契约新增可选 `homes` 字段；单 caller 分支新增 `home` 字段。
- `smoke-client-bundle.mjs` 更新为断言主机根视图（`remote:dev:hostroot`，path=`/tmp`，title=`dev`）与纯工作区名称标题。
