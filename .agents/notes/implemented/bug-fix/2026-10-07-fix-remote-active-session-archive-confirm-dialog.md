# 2026-10-07 修复远程会话有活跃任务时归档无确认弹窗问题

## Status
Implemented

## Context
在远程 DSH 会话中，当会话仍有正在进行的工作（例如后台任务、进行中的回合、运行中的子智能体等）时，尝试归档该会话，远端 DSH 服务端的 `workspace/archiveSession` 会主动拒绝归档并返回错误：
```json
{
  "code": "workspace/session-active",
  "message": "cannot archive session ...: the session is active (...)",
  "details": {
    "sessionId": "...",
    "activity": [ ... ]
  }
}
```
官方 UI 中的 `activeSessionRefusal(reason)` 依赖此错误包含 `rpcError` 结构（且其 `code === 'workspace/session-active'`，`details.activity` 为活动列表），以触发 `SessionArchiveConfirmDialog` 确认弹窗（“停止并归档此会话？”展示将被停止的工作并提供“停止并归档”按钮）。

但在 `dsh-plugin-remote-ssh` 中存在如下阻断链：
1. `RemoteCaller.callOnce` 在 RPC 抛出错误时仅抛出通用的 `Error('remote-ssh: ... failed (code): message')`，丢失了服务端的 `code` 与 `details` 结构。
2. 宿主路由 `/remote-ssh/session-archive` 捕获异常后仅将 `error.message` 返回给客户端，未下发 `code` 与 `details`。
3. 客户端插件 `client.js` 中的 `archiveSession` 代理在收到失败响应时，直接返回通用的 `{ ok: false, error: new Error(...) }`，缺少 `rpcError` 字段，且未暴露 `WorkspaceArchiveError` 所需的结构，导致上层捕获后无法识别为 `workspace/session-active`，弹窗未被唤起，用户看不到任何反馈。

## Decision
1. **RemoteCaller RPC 错误保真**：
   在 `src/remote.ts` 中引入 `RemoteInvocationError`，将远端下发的 `code` 与 `details` 完整保留到错误实例中。
2. **路由透传结构化错误**：
   在 `src/route.ts` 的 `SESSION_ARCHIVE_ROUTE` 处理器中，将错误中的 `code` 与 `details` 序列化并返回给前端调用方。
3. **客户端代理符合官方契约**：
   在 `client.js` 的 `archiveSession` 代理中，当收到失败响应时构造具备 `rpcError: { code, message, details }` 与 `isDSHRemoteError: true` 的错误对象，使得官方 UI 的 `WorkspaceArchiveError` / `activeSessionRefusal` 能够正确提取活动项并弹出确认停止归档对话框。
4. **支持停止并归档确认流**：
   当用户在确认弹窗中点击“停止并归档”时，请求会携带 `stopActivity: true`，服务端正常停止活动并成功归档会话。

## Alternatives considered
- **在客户端直接绕过服务端拒绝并强制静默停止**：不可行，违反了官方关于用户确认关键中断行为的交互设计原则，且可能导致未保存的工作状态丢失。
- **自定义独立弹窗组件**：不可行，官方 UI 已有完备的 `SessionArchiveConfirmDialog` 与本地化字典，遵循官方契约不仅代码轻量，而且与本地会话交互体验完全一致。

## Consequences
- 远程包含正在执行的后台任务或交互状态的会话在点击归档时，能正常弹出“停止并归档此会话？”确认弹窗，并列出即将被停止的工作项。
- 用户确认后携带 `stopActivity: true` 顺利完成归档与工作停止。
- 新增单元测试与冒烟测试校验 `workspace/session-active` 拒绝与确认停止流程。
