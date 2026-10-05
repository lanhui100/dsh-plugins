# Task REMOTE-SSH-KEEPALIVE-HARDENING

- Status: Done
- Complexity: B
- Scope: 加固 dsh-plugin-remote-ssh 的 SSH 隧道保活稳定性：真正的指数退避重连（下限保护）、端到端可配置保活参数、连接超时、生命周期事件总线、`$events` 自动重连与状态挂起协同、本地端口冲突 Fail-Fast 预检与动态自增寻优。
- Owner: dev-team
- Spec: `docs/dev-team/specs/remote-ssh-keepalive-hardening.md`

## 验收证据
- `pnpm --filter dsh-plugin-remote-ssh typecheck` 0 报错通过。
- `pnpm --filter dsh-plugin-remote-ssh build` 0 报错通过。
- 14 个 smoke 测试全部通过（含新增 `smoke-keepalive.mjs`）：
  - `smoke-client-bundle.mjs`
  - `smoke-create-reuse.mjs`
  - `smoke-host-apply.mjs`
  - `smoke-manager.mjs`
  - `smoke-multi-host.mjs`
  - `smoke-ssh-config.mjs`
  - `smoke-question-card.mjs`
  - `smoke-settings-ui.mjs`
  - `smoke-workspace-btn.mjs`
  - `smoke-archive-multi.mjs`
  - `smoke-command.mjs`
  - `smoke-launcher.mjs`
  - `smoke-performance.mjs`
  - `smoke-keepalive.mjs`
- 架构/顾问/双审查员对抗评审意见均已采纳并回改（无挂起定时器，无僵尸死锁，兼容同步端口分配 API）。
