# Spec: Page-Freeze Remediation (dsh-plugin-remote-ssh)

- Task ID: `PAGE-FREEZE-REMEDIATION`
- Status: Proposed
- Complexity: B
- Author: @orchestrator (Dev Team)

## 1. 背景与目标

经 Agent Team 3 路独立只读审核（Lane A/B/C），确立导致页面"卡住/假死/掉帧"的核心缺陷：
1. **P0 会话永久加载中**：`follow` 流在远端停帧时 `reader.read()` 永不返回，snapshot fallback 不可达；
2. **P0 SSH 轮询堆叠**：`/remote-ssh/sessions` 每 60s 逐 host 串行 SSH 解析 `$HOME`（无缓存），叠加最坏达 60s 触发轮询堆叠；
3. **P1 单坏主机雪崩**：多主机单 host 失败导致全量快照 502；
4. **P0/P1 主线程掉帧与泄漏**：MutationObserver 观察全 body，打字期每帧全文档扫描；`ensureWorkspaceTreeMode` 轮询内重复 `store.create()`；`:has()` 选择器重算。

目标：消除全部确定性卡死与串行堆叠，降低主线程开销，实现全链路优雅降级与超时兜底。

## 2. 实施批次划分

### 批次 1：Host 侧消灭串行 SSH 轮询与单坏雪崩
- `src/manager.ts`: `ActiveHostEntry` 增加 `homeDirectory?: string` 缓存；首次解析后持久存内存；
- `src/route.ts`: `SESSIONS_ROUTE` 中多 host `Promise.allSettled` 并行化；单个 host 失败隔离降级为 `{ workspaces: [], sessions: [] }`；home 与 list 并行；注入超时兜底。

### 批次 2：Follow 流超时、心跳与快照降级保底
- `src/route.ts`: `SESSION_FOLLOW_ROUTE` 注入 15s 心跳帧（`: heartbeat\n\n`）与 30s idle 超时自动关流；
- `client.js`: `wrap.follow` 为 `reader.read()` 加重置式超时（20s），超时取消流并进入 `if (!streamed)` 快照 fallback；
- `client.js`: `parseJsonResponse` 改为单次读取并解析，修复已消费流二次读取的异常掩盖。

### 批次 3：主线程 DOM 观察者降噪与 Store 泄漏清理
- `client.js`: `installTitleDecorator` 观察范围收窄至侧栏及局部容器；节点句柄缓存；
- `client.js`: 移除 `reconcileRemoteSource` 内部的 `ensureWorkspaceTreeMode(ctx)`（仅保留 `apply()` 启动单次执行）；
- `client.js`: 移除 CSS 中的 `:has()` 选择器，改为装饰器标记 class。

### 批次 4：客户端全局请求防堆叠与 Teardown 闭环
- `client.js`: `reconcileRemoteSource` 增加全局 `reconciling` 互斥标志位；
- `client.js`: 页面 fetch 统一使用带超时的 signal；
- `client.js`: `ctx.effect` teardown 注入全局 abort 与清理闭环。
- 同步更新类型镜像 `src/client/index.ts`。

## 3. 验收标准与测试门禁

1. `pnpm --filter dsh-plugin-remote-ssh build` 编译通过；
2. `node packages/dsh-plugin-remote-ssh/smoke-multi-host.mjs` 多 host 隔离与聚合冒烟通过；
3. `node packages/dsh-plugin-remote-ssh/smoke-client-bundle.mjs` 客户端模型注入与会话代理冒烟通过；
4. `node packages/dsh-plugin-remote-ssh/smoke-performance.mjs` 性能防抖冒烟通过；
5. 新增/扩充冒烟脚本验证 homeDirectory 缓存与单 host 故障隔离。
