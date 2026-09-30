# Agent Note: Client remote-session view and local Harness wiring

Status: implemented

## Problem

Host 半（隧道 + token-cookie + `session/list`）已实证打通，但远端会话尚未出现在本地 UI。需要确定 Client 视图的落点、Host→Client 的数据通道，以及本地联调的装配方式。

## Decision

- Client 落点：在 `sidebar.footer.action` 注册专属远程主机状态与操作按钮（指示灯 + 标题，接受 `{ wide: boolean }` 响应折叠/展开），点击弹窗显示连接细节与说明。
- 命令面兜底：Host 端注册 `/remote-ssh` 人类命令（实现 `registerRemoteSshCommand`），在对话输入框输入即可同步拉取并打印远端最新的完整会话列表（标题/cwd/运行状态）。
- 数据通道：Host 端注册 `RemoteSshService`（Typert Remote）暴露 `listSessions` 接口供 Client 端与脚本调用。
- 本地联调：在本地桌面端 profile `node_modules` 建立 Junction 软链接，并在 `cordis.patch.yml` 中声明装配。

## Alternatives considered

- 直接抢占 `sidebar.workspaces` single 槽：shadow 掉官方工作区树风险高（replaceRisk shadows-shipped-ui），且会破坏本地原有会话浏览；落选。
- Client 直连远端：浏览器经隧道 authority 能换 cookie，但 token 需经 SSH 读取（浏览器无 SSH 环境）；落选。

## Consequences

- 侧边栏提供了明确的远程服务状态指示，同时 `/remote-ssh` 人令提供了在任意对话中的免鼠标快捷查询通道。
- 插件以干净非侵入的方式集成到本地桌面 profile。
