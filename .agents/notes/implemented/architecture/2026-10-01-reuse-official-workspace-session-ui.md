# Agent Note: Reuse the official workspace and conversation UI for remote sessions

Status: implemented

## Problem

上一版 `remote-ssh` 以独立实现呈现远程内容：自定义 `main` 面板、自定义左侧工作区树、自定义每条消息的渲染。它没有复用官方 `WorkspaceBrowser` 的目录折叠/展开，没有复用官方会话区，也没有复用官方消息流组装。用户明确要求：整体 UI 只在侧边栏增加"远程工作区"并复用"工作区"，会话区完全复用官方实现。

## Decision

- **Host 新增原始 wire 路由** `GET /remote-ssh/session-raw?id=...`：把它定义为透传远端 `session/projections` + `session/page` 的原始记录（`asOfSeq`、`projections`、`records`），`records` 是官方 `SessionEventStream` / `ConversationNodeAssembler` 直接消费的 wire 事件（`user/message`、`assistant/message`、`tool/call`、`tool/result`、`turn/*`、`step/*`、`goal/change` 等，实测 860 条）。
- **Client 零槽位**：本插件不再注册任何面板/图标/侧边栏。`apply` 把远程快照 upsert 进官方客户端模型：
  - 每个远程 cwd 组 → `ctx.workspaces.list.upsertView({ workspaceId: 'remote:<cwd>', path: cwd, title: '远程 <name>', sessionIds, ... })`；
  - 每个远程会话 → `ctx.sessions.handleSessionAdded({ id, displayTitle, cwd, running, blank, updatedAt, retainedBy: {} })`。
  官方 `WorkspaceBrowser` 因此直接在侧边栏渲染远程工作区分组——文件夹折叠/展开、会话行、状态点、右键菜单全部来自官方组件。
- **代理会话流**：包装 `ctx.remote.session` 的 `page` / `follow` / `projections` / `prompt` / `cancel` / `rename` / `attachment`（`configurable` getter，保存原 descriptor 以便还原）。命中已知远程会话 id（`remoteSessionIds` 集合）时由隧道路由应答，否则原样穿透。侧边栏点击远程会话 → 官方 `openSession` → 官方 `ui-conversation` 打开 → 官方消息节点管道组装远程历史。
- **生命周期**：远程快照 60s 轮询刷新；卸载时移除注入的远程行并恢复被代理的方法 getter。

## Alternatives considered

- **继续自定义 main 面板/侧边栏/消息气泡**：被否。这正是用户指出的问题——独立新实现而非官方复用。
- **直接修改官方 `ui-workspace` 增加 source registry**：被否。桌面以打包 `app.asar` 交付，插件无法安全改写核心；而本方案通过官方已公开的 client 模型接口（`workspaces.list.upsertView` / `sessions.handleSessionAdded` + 可配置的 `remote.session` 方法）即可达成同等复用，无需改核心。
- **转发远程 `follow` 实时流**：正确方向但复杂（HTTP 流中继到 async iterable）。列为后续里程碑；当前以静态快照打开官方 journal，历史渲染完整，实时增量后补。
- **不可恢复地覆盖 `remote.session` 方法**：被否。HMR/卸载需要还原，故保存原 getter descriptor 并在 disposer 中恢复。

## Consequences

- 零自定义 UI：官方工作区树、会话区、消息流、主题 100% 复用。
- 只读里程碑：`prompt` / `cancel` / `rename` / `attachment` 对远程 id 返回明确的"未接通"错误，不会误发到本地。
- 远程 id 判定依赖 `remoteSessionIds` 集合；远程与本地为不同主机 UUID 命名空间，碰撞概率可忽略。
- 三条数据路由不经过 `/api` 浏览器鉴权围栏（loopback 只读）——安全边界与 `2026-09-30-remote-workspaces-panel.md` 一致。
- 本记录取代 `2026-09-30-remote-workspaces-panel.md` 与 `2026-09-30-client-remote-session-view.md` 中"自定义面板/状态按钮 + Typert Remote 数据通道"的方案取向。