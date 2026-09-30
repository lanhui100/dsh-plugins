# Agent Note: Client remote-session view and local Harness wiring

Status: proposed

## Problem

Host 半（隧道 + token-cookie + `session/list`）已实证打通，但远端会话尚未出现在本地 UI。需要确定 Client 视图的落点、Host→Client 的数据通道，以及本地联调的装配方式。

## Proposal

- Client 落点：`shell.overlay` 弹层承载"远端会话"面板（独立面板，不抢 `sidebar.workspaces`），`sidebar.footer.action` 放连接状态按钮作为入口。`sidebar.workspaces.session.menu.item` 行级动作待面板稳定后再加。
- 数据通道：Host 注册 `TypertRemoteService` 子类（`remoteSsh`，`@Remote('listSessions')`），经隧道调用远端 `session/list`；Client 经 `ctx.remote.remoteSsh.listSessions()` 读取。Host `inject = ['commands']` 另注册 `/remote-ssh` 人令做无 UI 兜底。
- 联调：`dsh plugin --profile desktop add <本地包>`（或 `--patch` 叠加 + `--dump-config` 验层），本地桌面端验证。

## Alternatives considered

- 直接抢占 `sidebar.workspaces` single 槽：shadow 掉官方工作区树风险高（replaceRisk shadows-shipped-ui），且远端/本地会话的归属与交互语义尚未定案；落选，待面板验证后再议。
- Client 直连远端：浏览器经隧道 authority 能换 cookie，但 token 需经 SSH 读取（浏览器无 SSH），且把 launch token 暴露给前端扩大了信任边界；落选。token 读取保留在 Host 端。

## Acceptance criteria

- [ ] 本地 sidebar 出现远端连接入口，面板列出远端会话（含标题/cwd/running）。
- [ ] `/remote-ssh` 人令在无 UI 时同样可列出远端会话。
- [ ] 远端服务重启（token 轮换）后首次调用自动重换 cookie，不需重启本地端。

## Risks

- 本地桌面版为打包产物：`dsh plugin --profile desktop add` 对本地包路径的解析方式需实测；不行则退到 `--patch` 叠加。
- 公网 `@deepseek-ai/dsh-client-ui-sidebar` 仅含类型契约（peer），实际渲染组件（React 19、 Skor slot 运行时）只能在 Harness 进程内联调，无法在插件仓库内单测。
