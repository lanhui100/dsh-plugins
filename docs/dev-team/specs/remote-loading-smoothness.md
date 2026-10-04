# Spec: 远程主机工作区与会话增量同步与性能丝滑度优化

## 1. 背景与目标
在添加远程主机并同步其工作区与会话时，存在瞬间主线程掉帧与少许操作卡顿：
- 客户端在指纹发生微小变动时对全量会话同步调用 `handleSessionAdded` 与 `handleSessionStatus`，无差别触发数十次状态派发与模型通知。
- DOM 装饰器针对 Host 节点进行重复 class 标记与节点查找。
- 后端获取工作区 baseline 频繁使用一次性 WebSocket 短连接握手，带来网络时延与连接波动。

**目标**：
1. 会话级增量 Diff：只向客户端模型派发新增、更新或状态变更的会话，已存在且内容一致的会话 0 开销跳过。
2. 调度平滑防卡顿：初次或大批量（>20个）会话加载时采用微任务/分批切片，消除 >50ms Long Task。
3. DOM 装饰器命中缓存与跳过优化：已处理过的 host 根节点与 ancestor 增加轻量级缓存，避免每次遍历。
4. 后端长连接与 Baseline 缓存机制健全：保持 baseline 缓存 30s，并在事件连接健康时优先复用或延长缓存，减少无谓重连。

## 2. 影响范围
- `packages/dsh-plugin-remote-ssh/client.js`
- `packages/dsh-plugin-remote-ssh/src/client/index.ts`
- `packages/dsh-plugin-remote-ssh/src/remote.ts`
- `packages/dsh-plugin-remote-ssh/src/route.ts`

## 3. 验收标准
1. `pnpm --filter dsh-plugin-remote-ssh build` 0 报错。
2. 全套 smoke 测试（包含 `smoke-client-bundle.mjs`, `smoke-performance.mjs` 等）100% 通过。
3. 新增/扩展 smoke 验证：增量会话更新时，未变动的会话不会重复触发 `handleSessionAdded`。
