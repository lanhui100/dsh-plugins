# Task REMOTE-LOADING-SMOOTHNESS

- Status: Done
- Complexity: B
- Scope: 解决添加远程主机并加载工作区/会话时的微卡顿，实施前端增量 Diff、时间切片渲染、DOM 装饰降噪与后端 baseline 缓存复用。
- Owner: dev-team
- Spec: `docs/dev-team/specs/remote-loading-smoothness.md`

## 验收证据
- `pnpm --filter dsh-plugin-remote-ssh typecheck`：通过（0 error）。
- 全量 smoke 测试套件（13 个回归测试脚本，包含 `smoke-client-bundle.mjs`、`smoke-performance.mjs` 等）全部一次性通过。
- 会话粒度变更时，未发生属性变动的存量会话不再重复调用 `handleSessionAdded` / `handleSessionStatus`。
- DOM 装饰器已完成缓存与重复遍历截断。
