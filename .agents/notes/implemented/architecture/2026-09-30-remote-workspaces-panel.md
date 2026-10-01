# Agent Note: Remote workspaces panel over a loopback HTTP route

Status: implemented

## Problem

方案 B 的目标是"像本地工作区一样"看远端：启动即显示"远程工作区: dev"及其下会话。第一步只交付了 `/remote-ssh` 对话命令与一个状态按钮——没有可供浏览器渲染的远端数据通道，也没有工作区视图的落点。

## Decision

- **数据通道：Host 注册只读 HTTP 路由**。Host 半经 `ctx.inject(['webServer'])`（可选注入，缺失时条目照常激活）注册 `exact /remote-ssh/sessions`，返回 `{ host, total, workspaces[] }`。浏览器与页面同源，直接 `fetch`，无需在浏览器侧处理 token/cookie。
- **UI 落点：全局面板**，不抢工作区浏览区。`sidebar.panellist`（list）注册 `id: 'remote'` 图标 + `main`（keyed）注册 `key: 'remote'` 面板；两者 id 对齐，侧边栏按钮由 shell 拥有，`replaceRisk: none`。
- **分组口径：按会话 `cwd` 聚合**，而非远端 Workspace 注册表。`session/list` 已携带每个会话的 `cwd`，因此不需要额外往返，且对未注册为 Workspace 的目录同样成立。每组按 `updatedAt` 倒序、显示上限 50 条并附剩余计数。

## Alternatives considered

- **抢占 `sidebar.workspaces`**（single 槽，被 ui-workspace 占据）以插入"远程工作区"分组：会 shadow 官方工作区树（`replaceRisk: shadows-shipped-ui`），并让本地工作区与远端会话的归属语义纠缠；落选。面板独立成页，两者互不干扰。
- **用 Typert Remote 传数据**：插件解析到的 `@deepseek-ai/cordis`/`typert-protocol` 副本与桌面 Host（app.asar 内）可能不是同一模块实例，挂载失败此前已连带触发 profile 恢复、清空用户 patch 层；落选（其恢复条件仍记在 `2026-09-30-desktop-profile-integration.md`）。
- **浏览器经隧道直连远端 `/api`**：浏览器没有 SSH，拿不到只存在于远端日志里的 launch token；落选。

## Consequences

- **安全边界**：该路由由本地 webserver 直接服务，**不经过 `/api` 的浏览器鉴权围栏**——本机任意进程可读取远端会话标题与 cwd；若部署把 webserver 绑到非回环地址，这些信息也会暴露给网络。当前为只读、默认回环绑定；若将来需要，可改走 `ctx.connection` 的受信路由。
- **数据新鲜度**：面板在打开/点"刷新"时取一次快照，无推送流；远端会话变化不会自动出现。
- **规模上限**：工作区按会话数排序，每组最多携带 50 条会话（余量以一行计数呈现），避免一次响应过大。
- 路由注册与命令注册都只依赖 Host 的语义接口（`ctx.commands` / `ctx.webServer`），插件 Host 半仍**零 `@deepseek-ai` 运行时导入**。
