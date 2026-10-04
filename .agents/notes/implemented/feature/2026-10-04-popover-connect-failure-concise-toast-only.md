# Agent Note: Connect failure in add-remote-host popover — toast-only (concise dsh-not-started cause), no in-panel status text

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
才能清除。用户要求：**移除浮层内红字原因，仅保留 toast 提醒失败，toast 文案精简但需点明
失败原因（dsh 未启动）**；且连接过程中主机行下方也不要出现任何状态文字。

## Decision

`client.js` 的 `doAdd`（连接动作）统一改为：

- **主机行下方全程无状态文字**：`feedbackEl` 保持空（不写挂起文案 `正在检测远端 dsh 服务并
  建立隧道...`，失败也不写红字）；按钮本身的 loading 态（禁用 + `aria-busy` + spinner）保留。
- **仅保留 toast，且按原因精简**：新增 `connectFailToast(errMsg)` 助手——
  当服务端 message 含 `未启动`/`无可用服务`（dsh 未启动类失败）时 toast 为
  `连接失败：远程机器未启动 dsh 服务`；其它失败（非法主机、网络异常等）仍为极简
  `连接失败`。不携带主机名、不携带服务端完整错误详情，只点明最常见的失败原因。
- **面板注释修正（hint）**：顶部提示语由「已连接的主机可断开；未连接的主机一键接入，
  若远端未启动将自动拉起 dsh web 服务。」改为「远程连接主机，但注意该主机需已启动
  dsh 服务。」——与真实行为一致（`doStartHost` 对 dsh 未启动直接失败），不再宣称
  会自动拉起服务。

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
- **toast 原样携带服务端完整错误详情**：被否决。dsh 未启动的长错误（`远端主机 … 请先在远端
  启动 dsh web 后重试`）正是第一轮要精简的对象；统一映射成一句简明的
  `连接失败：远程机器未启动 dsh 服务`，比透传原文更符合「精简但点明原因」。
- **所有失败统一「连接失败」不带原因**：第一轮如此实现，被用户否掉——「太过于精简」，
  用户希望 toast 点明 dsh 未启动这一最常见原因；改为按 message 中 `未启动`/`无可用服务`
  做字符串匹配，只有命中才带原因，其它失败仍是极简文案，保持真实不误导。
- **仅对 dsh 未启动类失败去掉红字、其它失败保留**：被否决。失败路径是同构的（同一 `else`/
  `catch` 分支），按内容区分会让行为分裂；统一去掉红字、统一 toast 最干净。
- **把服务端完整错误改为仅返回错误码**：被否决。服务端 `message` 仍是 Host 日志与调试的有用
  事实；保留返回、仅客户端按需映射展示，改动面最小（`route.ts`/`manager.ts` 不动）。
- **保留原注释「若远端未启动将自动拉起 dsh web 服务」**：被否决。当前
  `manager.doStartHost` 对 dsh 未启动直接失败、不会自动拉起，原注释与实际行为矛盾、误导
  用户；改为如实提示远端需已启动 dsh 服务。

## Consequences

- 浮层内连接：主机行下方全程无状态文字（挂起/失败都不显示）；失败仅一条 toast——
  dsh 未启动类失败显示 `连接失败：远程机器未启动 dsh 服务`，其它失败显示 `连接失败`，
  用户可立即重试或继续其它操作。
- 面板顶部注释与行为一致（远端需已启动 dsh 服务），不再宣称「未启动会自动拉起」。
- dsh 未启动等长错误详情不再投递到 UI（`client.js` 失败提示不再展示 `postData.message` 全文），
  Host 端 `manager.ts`/`route.ts` 的返回与日志不变。
- 既有 smoke 门禁 `pnpm --filter dsh-plugin-remote-ssh test` 保持通过：
  `smoke-workspace-btn.mjs` 仅断言连接**成功** toast 与断开失败红字，不覆盖连接失败 toast
  文案与挂起文字，故无需改测试。