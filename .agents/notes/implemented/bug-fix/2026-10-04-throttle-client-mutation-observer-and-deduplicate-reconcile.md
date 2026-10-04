# Agent Note: Throttle Client MutationObserver And Deduplicate Reconcile

Status: implemented

## Problem

长时间使用 DeepSeek Harness 客户端后出现严重卡顿，页面响应迟缓。排查发现 `packages/dsh-plugin-remote-ssh/client.js` 存在两处严重的资源与重绘消耗：
1. `installTitleDecorator` 对 `document.body` 挂载了带有 `{ childList: true, subtree: true }` 的全局 `MutationObserver`，且回调函数没有任何节流或防抖。在会话交互（尤其是 assistant token 打字机流、滚动、光标闪烁）中，每秒可能产生数百次 DOM 变更回调，无条件触发 `querySelectorAll`、DOM 树遍历和布局计算（Layout Thrashing），引发严重的卡顿与线程阻塞。
2. 每 60 秒的 `reconcileRemoteSource` 轮询中，无论远端工作区和会话数据是否有变更，均无条件重新调用 `sessions.handleSessionAdded` 与 `workspaces.upsertView`，迫使宿主 React/Cordis 响应式模型对整个树形工作区及会话列表进行全量刷新与 DOM 重建。
3. `checkAndRenderWorkspaceAddButton` 以及 `attachTooltip` 在节点重新挂载/定位时未彻底清理遗留定时器与监听，存在潜藏内存泄露。

## Decision

1. **MutationObserver 微任务/rAF 节流合并**：
   - 引入 `requestAnimationFrame`（在 Node/非浏览器测试环境降级为 `setTimeout`）节流机制，将微小的连续 DOM 变动合并到同一帧执行一次。
   - 过滤无关变更，针对未包含目标挂载位或目标属性的 DOM 突变避免重复执行全量子查询。
2. **`reconcileRemoteSource` 引入轻量指纹/脏检查对比（Dirty Check）**：
   - 在向官方模型分发前，计算包含工作区列表、会话状态（running/updatedAt/title/pendingInteraction）、归档与固定列表的结构指纹。若指纹未变，则直接跳过 `sessions.handleSessionAdded` 和 `workspaces.upsertView`，避免无效触发前端响应式重新挂载。
3. **安全回收资源与幂等性保证**：
   - `checkAndRenderWorkspaceAddButton` 确保旧按钮挂载的所有清理函数（tooltip disposer、timeout）在重新定位或创建时严格清理。
   - 保持全部公开接口和既有行为（如交互卡片渲染、主机分组显示）完全兼容，并通过全部自动化测试。

## Alternatives considered

1. **将 MutationObserver 拆分为只监听特定容器（如侧边栏、对话容器）**：
   - 考虑过只挂在 `.WorkspaceBrowser` 或特定的 composer 节点上。但由于宿主 React 界面可能在不同路由下卸载并重新挂载这些容器，无法一次性稳定捕获所有子容器生命周期，依旧需要观测根容器或特定层级。采用 rAF 批量节流是既保持健壮性又彻底消除卡顿的最优解。
2. **完全依赖定时器轮询替代 MutationObserver**：
   - 移除 MutationObserver 改为纯定时轮询会导致 UI 元素（如按钮、问题交互卡片）在切换对话或打开设置时有肉眼可见的延迟和跳变。节流后的 Observer 可以保证即时响应（0-16ms）且不会造成主线程拥堵。

## Consequences

- 彻底消除流式打字与滚动时的 DOM Observer 重复计算风暴，长时间运行不再掉帧卡顿。
- 定时轮询在静止无变更状态下零开销，不会引发宿主 React 树重绘。
