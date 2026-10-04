# Agent Note: relocate workspace add buttons to host menu rows

Status: implemented

## Problem

在多主机架构与一级主机折叠目录（`local:hostroot` 与 `remote:<host>:hostroot`）引入后：
1. 原先添加远程工作区的操作嵌入在「添加远程主机」全局浮层中，层级过深且上下文不明确；
2. 官方原生「添加工作区」按钮位于工作区顶栏右侧（`sectionHeader` 内的 `headerActions`），在多主机模式下该按钮实际上只能添加本地工作区，位于顶栏容易使用户误以为是全局行为，且与远程主机的工作区管理割裂；
3. 用户希望将远程工作区添加功能从添加远程主机浮层中剥离，直接放置在各远程主机菜单行（`remote:<host>:hostroot`）的最右侧，表现为纯图标按钮，且左下角携带微型地球仪角标（与远程工作区文件夹图标角标呼应）；同时，将官方顶栏添加本地工作区的功能移动并沉降到「本地」主机菜单行（`local:hostroot`）的最右侧。

## Decision

1. **远程主机菜单行右侧添加工作区按钮**：
   - 在 `decorateHostRoots()` 中，为每个 `remote:<host>:hostroot` 根行注入 `.dsh-host-row-actions` 容器；
   - 注入纯图标按钮 `.dsh-host-action-btn.dsh-host-action-btn--remote`，采用官方 `IconProjectAddOutlineRegular` 16px 矢量 SVG 造型；
   - 增加 CSS 样式 `.dsh-host-action-btn--remote::after`，在图标左下角附加尺寸为 9×9px 的微型地球仪角标（包含蓝底与经纬线），直观标识远程属性；
   - 点击该图标弹出针对该主机的专用轻量浮层 `#dsh-host-add-workspace-popover`，标题为 `添加远程工作区 [<host>]`，直接列出该远程主机 `~/` 下现有目录或新建目录，简化添加流程。
2. **剥离添加远程主机全局浮层中的工作区表单**：
   - 侧边栏「添加远程主机」全局按钮的 popover 仅保留「已连接主机」与「可添加主机」的主机连接/断开生命周期管理，不再混入工作区添加表单。
3. **官方本地添加工作区按钮移动至「本地」主机行最右侧**：
   - 在 `decorateHostRoots()` 处理 `workspace:local:hostroot` 时，动态探测官方 `headerActions` 中的「添加工作区」按钮（通过 `aria-label="添加工作区"` 或快捷键 `workspace.add`）；
   - 将该官方按钮节点直接移动并挂载到本地主机行的 `.dsh-host-row-actions` 容器中；若官方节点尚未就绪，则注入代理按钮并在点击时委托给官方操作，确保快捷键与官方目录选择流程（`WorkspacePickFlow`）原样保留且无缝工作。
4. **自动化测试守约**：
   - 更新 `smoke-workspace-btn.mjs`，增加用例验证远程与本地主机菜单行右侧添加工作区按钮的挂载、地球仪角标 CSS、以及点击弹出专属远程工作区添加卡片与关闭交互。

## Alternatives considered

- **方案 B：将侧边栏底部的「添加远程主机」按钮本身改成纯图标移动到远程主机行**：
  否决。用户仍然需要管理多台远程主机的接入与断开，且可能存在尚未连接任何远程主机的情况（此时尚无任何远程主机行）。保留侧边栏底部的全局主机管理入口更符合直觉。
- **直接通过官方 slot 注入菜单**：
  否决。官方 `WorkspaceBrowser` 组件未在 `ProjectRowItem` 行末开放插件 slot，采用受 MutationObserver 与 requestAnimationFrame 节流保护的 DOM 注入与节点迁移是保持无侵入且与官方 UI 像素级一致的最佳途径。
