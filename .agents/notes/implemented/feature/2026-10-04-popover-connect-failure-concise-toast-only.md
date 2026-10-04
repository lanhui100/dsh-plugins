# Agent Note: Connect failure in add-remote-host popover — concise toast only, no in-panel red reason

Status: implemented

## Problem

侧边栏「添加远程主机」按钮弹出的浮层（`#dsh-add-remote-popover`，标题「添加远程工作区」）
里，点击某台可添加主机的连接图标后，若连接失败——典型如远端 dsh 服务未启动，Host 端
`src/manager.ts` 的 `doStartHost` 会抛出长错误（`远端主机 "<host>" 的 dsh 服务未启动（端口 … 无可用服务），
已禁止连接。请先在远端启动 dsh web 后重试。`），`POST /remote-ssh/add-host` 以 500 返回该 message——

`client.js` 的 `doAdd` 失败分支把同一段完整错误同时渲染成两处：

1. 主机行下方的**红字原因**（`.dsh-popover-feedback.dsh-feedback-error`）；
2. 全局 **toast**（`showRemoteToast(errMsg, 'error')`）。

长文案在窄浮层内双重复现、视觉噪音大；且红字会长期驻留面板，用户必须手动重试或关闭浮层
才能清除。用户要求：**移除浮层内红字原因，仅保留 toast 提醒失败，且 toast 文案要非常精简**。

## Decision

`client.js` 的 `doAdd` 两个失败分支（`else` 分支：响应非 ok/非 ok 体；`catch` 分支：fetch 异常）
统一改为：

- **不再写红字**：`feedbackEl` 复位为 `'dsh-popover-feedback'` 且 `textContent = ''`
  （同时清掉先前「正在检测远端 dsh 服务并建立隧道...」的挂起文案，避免失败后残留误导）；
- **仅保留极简 toast**：`showRemoteToast('连接失败', 'error')` —— 不携带主机名、不携带
  服务端错误详情，所有连接失败一视同仁。

作用域仅限该浮层的**连接**动作；浮层内**断开**动作的红字错误反馈与『设置 → 远程主机聚合』
卡片内「添加主机」的错误反馈保持不变。服务端仍返回完整 `message`（Host 日志可查），只是
不再投递到浮层 UI。

本决策部分取代
[2026-10-02-refine-remote-workspace-add-button](file:///D:/Documents/dsh-plugins/.agents/notes/implemented/feature/2026-10-02-refine-remote-workspace-add-button.md)
中「失败仍走浮层内错误反馈并可重试」与「连接失败透传服务端的具体错误详情（浮层内）」两个
子决策（客户端展示侧）。

## Alternatives considered

- **保留红字、仅缩短文案**：被否决。用户明确要求去除红字，只留 toast；红字本身（非文案长度）
  是要求移除的对象。
- **toast 携带主机名或失败原因（如 `preprod 连接失败` / `dsh 未启动`）**：被否决。用户要求
  「非常精简」；统一的最小文案 `连接失败` 满足要求，且无需按错误内容分支（不引入对服务端
  message 的字符串匹配），更简单、零误判。
- **仅对 dsh 未启动类失败去掉红字、其它失败保留**：被否决。失败路径是同构的（同一 `else`/
  `catch` 分支），按内容区分会让行为分裂且依赖错误文案格式；统一去掉红字、统一极简 toast 最干净。
- **把服务端完整错误改为仅返回错误码**：被否决。服务端 `message` 仍是 Host 日志与调试的有用
  事实；保留返回、仅客户端不再展示，改动面最小。

## Consequences

- 浮层内连接失败：面板内不再出现红字原因，也不残留「正在检测...」挂起文案；仅一条极简
  toast「连接失败」提醒，用户可立即重试或继续其它操作。
- dsh 未启动等长错误详情不再投递到 UI（`client.js` 不再引用 `postData.message` 于失败提示），
  Host 端 `manager.ts`/`route.ts` 的返回与日志不变。
- 既有 smoke 门禁 `pnpm --filter dsh-plugin-remote-ssh test` 保持通过：
  `smoke-workspace-btn.mjs` 仅断言连接**成功** toast 与断开失败红字，不覆盖连接失败 toast
  文案，故无需改测试。
