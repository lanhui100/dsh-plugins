# Task PAGE-FREEZE-REMEDIATION

- Status: Validation
- Complexity: B
- Scope: 实施 dsh-plugin-remote-ssh 页面卡顿与假死全链路修复（分 4 批次落地）。
- Owner: dev-team
- Spec: `docs/dev-team/specs/page-freeze-remediation.md`
- Reviews: completed (Lane A/B/C reviews archived in `docs/dev-team/reviews/`)

## 批次进度跟踪

- [x] 批次 1：Host 侧消灭串行 SSH 轮询与单坏雪崩 (`src/manager.ts`, `src/route.ts`)
- [x] 批次 2：Follow 会话流超时、心跳与快照降级保底 (`src/route.ts`, `client.js`)
- [x] 批次 3：主线程 DOM 观察者降噪与 Store 泄漏清理 (`client.js`)
- [x] 批次 4：客户端全局请求防堆叠与 Teardown 闭环 (`client.js`, `src/client/index.ts`)

## 验收证据

- `pnpm --filter dsh-plugin-remote-ssh build`：通过（TypeScript 编译 0 报错）。
- `node packages/dsh-plugin-remote-ssh/smoke-client-bundle.mjs`：通过（代理与快照兜底全通过）。
- `node packages/dsh-plugin-remote-ssh/smoke-multi-host.mjs`：通过（多 host 聚合与隔离通过）。
- `node packages/dsh-plugin-remote-ssh/smoke-performance.mjs`：通过（rAF 防抖与性能断言通过）。
