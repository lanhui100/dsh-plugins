# Agent Note: Persist remote workspaces across official baseline resets and restore custom models

Status: implemented

## Problem

在修复桌面端 web-boot 插件激活崩溃后，出现两个次生问题：
1. **自定义模型未加载**：此前因插件启动崩溃，桌面端在安全恢复/无插件模式下将 profile 层的 `cordis.patch.yml` 备份为 `cordis.patch.yml.bak-1790849163584`，并重置为了仅包含三项 UI 偏好的空配置，导致 `ponyllm` 提供商及 14 个自定义模型配置丢失。
2. **远程工作区短暂出现后再次消失**：
   - 官方模型冲刷：桌面端加载后，官方 WebSocket 状态流建立连接并向 `ClientWorkspaceModel` 推送 `baseline` 帧，调用 `replaceBaseline(baseline)` 将模型工作区重置为本地服务端给定的 `baseline.items`，冲掉了此前通过 `upsertView` 注入的远程工作区。
   - Diff 键值失配与误判拉黑：在 `client.js` 的 `reconcileRemoteSource` 中，`injectedWorkspaceIds` 存储的键为 `remote:<cwd>`，但在判断过期工作区时写成了 `if (!workspaceByCwd.has(wid)) workspaces.removeView(wid)`。由于 `workspaceByCwd` 的键为原始 `cwd`，判断恒为 `false`，导致误调用 `removeView(wid)`。`ClientWorkspaceModel.removeView` 会执行 `this.removedIds.add(workspaceId)`，将该 ID 永久拉入黑名单，后续所有 `upsertView` 均被静默丢弃。
   - 会话对象缺少 `sessionId`：官方 `ClientSessions.handleSessionAdded` 消费的是 `summary.sessionId`，原传递参数仅有 `id`，导致会话未能正常与模型关联。

## Decision

1. **恢复自定义模型配置**：
   从桌面端 profile 恢复流程生成的带时间戳备份文件（`cordis.patch.yml.bak-*`，位于 profile 目录）恢复全部配置至 `cordis.patch.yml`，找回包含 `ponyllm` 及 14 个自定义模型的完整声明与默认模型指向。
2. **守护官方工作区 Baseline**：
   在 `packages/dsh-plugin-remote-ssh/client.js` 中新增 `installWorkspaceGuardian`，包装 `ctx.workspaces.list.replaceBaseline`。官方推送 baseline 重构本地列表后，立即自动重新调用 `reapplyRemoteWorkspaces(ctx)`，将内存缓存的远程工作区重新写入 `items`，确保官方状态流推流不冲刷远程数据。
3. **解除黑名单并修复 Diff 移除键**：
   - 修正 diff 判定：统一使用 `workspaceId`（`remote:${cwd}`）作为比对键，避免误删；
   - 写入前防御：检查并主动从 `workspaces.removedIds` 中剔除待注入的 `workspaceId`，解除任何历史黑名单锁定。
4. **会话参数补齐**：
   在 `handleSessionAdded` 参数对象中同时提供 `id` 和 `sessionId: id`。
5. **测试加固**：
   在 `packages/dsh-plugin-remote-ssh/smoke-client-bundle.mjs` 中模拟官方 `replaceBaseline` 触发过程，断言远程工作区在 baseline 重置后依然存活，且 `handleSessionAdded` 必须提供 `sessionId`。

## Alternatives considered

- **仅依赖定时器每 60 秒重新拉取注入**：
  被否。从官方 baseline 冲刷到下一次 60s 轮询之间，侧边栏会出现长达一分钟的空白，体验割裂；且若触发黑名单机制，轮询重试同样失效。包装 `replaceBaseline` 为即时且确定的事件驱动保障。
- **让 Host 端直接劫持官方 `/api/workspace/state` WebSocket**：
  被否。改动核心 RPC 路由风险过高，且容易随桌面版本升级而破坏传输协议契约；在 Client 端模型边界进行透明适配最小且正交。

## Consequences

- 桌面端重启后完整恢复 14 个自定义模型选项；
- 远程工作区稳定常驻于官方侧边栏，不再因 WebSocket baseline 推送而闪退消失；
- 冒烟测试覆盖了 baseline 冲刷场景防回归。
