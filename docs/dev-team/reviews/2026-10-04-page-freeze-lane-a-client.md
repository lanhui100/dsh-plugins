# Lane A 审核：client.js 页面主线程卡顿风险（2026-10-04）

- 审核人：audit-perf-client（独立性能 reviewer）
- 范围：`packages/dsh-plugin-remote-ssh/client.js`（3856 行，浏览器实际加载产物）+ `src/client/index.ts`（258 行类型镜像，stub 说明，无实现分歧——全部实现以 client.js 为准）
- 方法：全文通读 client.js + index.ts，对照 smoke-client-bundle.mjs / smoke-performance.mjs 契约，定点 grep 校准行号
- 状态：**有条件通过**（无确定性硬卡死；存在 streaming 期持续卡顿 + 规模化冻结风险，P0/P1 修复完成前不放行）

## 结论

Lane A 内**没有**找到"必然把主线程锁死"的无限循环或同步死等；rAF 合并、fingerprint 脏检查、idempotent 守卫这三处防护真实存在且有效（smoke-performance.mjs 已覆盖）。但存在两类真实风险：

1. **持续卡顿（确定性）**：MutationObserver 观察全 body，streaming 期间每帧跑一次"4 函数 ≈ 8-10 次全文档扫描"的装饰 pass；长会话 DOM（1-2 万节点）下每次扫描 0.5-2ms，合 3-15ms/帧，占 20-90% 帧预算 → 每个 streaming turn 期间 UI 持续掉帧。合并只限频（60 次/s），未降单次成本。
2. **规模化冻结（条件性）**：任一字段变化即全量 fan-out（N 会话 ×2 模型写入 + M 工作区 upsertView 同一同步 tick），数百会话时单次 10-100ms+，数千会话（首次连入繁忙远端）可达秒级"卡住"；且 interval 与手动 reconcile（add host/delete/add-workspace/disconnect）并发无 in-flight 守卫，双写撕裂共享状态。

真正的"页面一直等待/挂起"类缺陷（fetch 无超时、follow 无 idle 关闭、SSE 泄漏）在 Lane B/C，本报告只做交叉引用。

## 问题表

### P0（必须修：确定性持续卡顿）

| 编号 | file:line | 卡住/卡顿机制 | 具体修复方案 | 可验证命令 |
|---|---|---|---|---|
| A-01 | client.js:3743-3776（runDecorations 3757-3763、observe 3776） | observer 观察 `document.body` 全量 subtree；回调只把工作合并到**每帧一次** pass，但每次 pass 仍同步执行 4 个函数 ≈ 8-10 次全文档扫描：`decorateHostRoots`（`querySelectorAll('div[data-row-key$=":hostroot"]')` + 每行 2 次 row.querySelector）、`checkAndRenderActiveQuestion`（`div[data-conversation-content][data-conversation-session]` 全文档扫描）、`checkAndRenderSettingsCard`（findSettingsContainer 最多 5 个全文档 class* 子串扫描 + 容器内 query）、`checkAndRenderWorkspaceAddButton`（getElementById + 缓存面板，较便宜）。streaming 期 text/元素追加触发 childList mutation 100+ 次/s > 60fps → **每个动画帧都跑一次完整 pass**；长会话 DOM 下单次扫描 0.5-2ms，pass 合计 3-15ms/帧，与 React 自身渲染抢同一帧预算。空闲时（DOM 静止）observer 不触发、零开销——但"空闲"在长会话页面几乎不存在。自注入收敛：4 处注入均有 idempotent 守卫（addBtn 已存在 / 卡已存在 / 按钮 isConnected），每次注入只多 1 帧 pass，无无限环。 | 1) 收窄 observer：分别观察 sidebar workspace 树容器、settings 容器、composer seat（React 重建容器时按容器句柄失效重扫一次兜底），不再盯全 body；2) 目标容器句柄缓存（复用 cachedSidebarPanelList 的 isConnected 失效模式）消除每帧全文档扫描；3) findSettingsContainer 加可见性判断（checkVisibility/display），settings 页签未开不扫；4) 装饰 pass 改走 requestIdleCallback（rAF 兜底首帧确定性），与 React 渲染错峰；5) 保留现有合并语义（每帧至多一次）。 | 现有回归门禁：`node smoke-performance.mjs`（rAF 合并：8 mutation → 1 pass，已通过）。新增修复门禁（修复后应退出 0，当前退出 1）：`node -e "const s=require('fs').readFileSync('packages/dsh-plugin-remote-ssh/client.js','utf8'); if (/observer\.observe\(document\.body,/.test(s)) process.exit(1)"`。单帧成本降低 靠 review（DevTools Performance 录制 streaming 期长任务数）。 |

### P1（应修：规模化冻结 + 周期 hitch + 样式风暴）

| 编号 | file:line | 卡住/卡顿机制 | 具体修复方案 | 可验证命令 |
|---|---|---|---|---|
| A-02 | client.js:433 + 397-429（apply 处另见 3810） | `ensureWorkspaceTreeMode` 在**每次** reconcile 顶部运行：`slots.entries('sidebar.workspaces')` 后对每个 entry 无条件 `store.create()` 新建 store 实例。每 60s poll 一次 + 每次手动 reconcile（add host / add-workspace / delete / disconnect 共 4 处 `void reconcileRemoteSource(ctx)`）一次；启动时 apply(3810) + 首次 reconcile(433) 双调。若 `create()` 带订阅注册则**监听器随实例泄漏**（未回收），数小时后每轮 store 通知触发 N 份 handler → 卡顿；即便无订阅，每 poll 也白建实例 + getSnapshot。`setGroupBy` 有 groupBy 比对守卫，不会每轮触发重渲染（只有首次）。 | 只在 `apply()` 做一次（3810 已调）；删掉 reconcile 内 433 行；若需重试（用户改回其他分组模式），缓存已建实例并复查 groupBy，而非重新 create。 | 修复门禁（当前 2 处调用 → 退出 1；修复后 1 处 → 0）：`node -e "const s=require('fs').readFileSync('packages/dsh-plugin-remote-ssh/client.js','utf8'); const m=s.match(/ensureWorkspaceTreeMode\(ctx\)/g)||[]; if (m.length>1) process.exit(1)"`。建议新增 smoke-lane-a-perf：3 轮手动 poll 断言 store.create 计数 === 1（当前 === 3，退出 1）。 |
| A-03 | client.js:614-626 + 629-643 + 3815-3816（手动触发：1218/2812/2856/3105/3590/3658） | fan-out 无 per-row 差分：fingerprint 只回答"有变化"，不回答"哪行变了"。任一会话 running/title/updatedAt 变化 → 全量 `handleSessionAdded` ×N + `handleSessionStatus` ×N + `upsertView` ×M，同一同步 tick 内完成；官方模型每写触发订阅 → 大侧栏树整体重渲染，单次 10-100ms+（数百会话），数千会话秒级"卡住"（首次连入繁忙远端即触发）。**无 in-flight 守卫**：60s interval 与 6 处手动 `void reconcileRemoteSource` 可并发——两个 reconcile 同时 fetch、同时写 `remoteSessionIds`/`injectedWorkspaceIds`/`lastSnapshotFingerprint`，removeView/upsert 决策基于互相覆盖的共享状态 → 双写 + 撕裂。 | 1) 模块级 `let reconciling = false` + 完成后置 false；并发时直接 return（或 coalesce 成最后一次）；2) 按行差分：per-session/per-workspace 轻量指纹（如 `id|running|updatedAt|title` 拼接），只 fan-out 变化行；3) 6 处手动触发与 interval 走同一入口（带守卫），`lastSnapshotFingerprint = null` 逻辑保留。 | 新增 smoke-lane-a-perf：changed 快照仅 1 行变化时断言 handleSessionAdded 调用数 === 1（当前 === N，退出 1）；两次并发 poll 断言 upserted 无重复行。现有 `node smoke-client-bundle.mjs`（契约）与 `node smoke-performance.mjs`（脏检查）继续作为回归门禁。 |
| A-04 | client.js:1771, 1796（installStyles 1642-2620 全段） | 两条 `div[class*="groupSection"]:has(div[data-row-key^="workspace:"]:not([data-row-key$=":hostroot"])) …` 规则：`:has()` 需对每个候选 groupSection 做子树匹配搜索，且 `class*=`/`data-row-key^=`/`$=` 属性选择器本身昂贵；mutation 使受影响子树样式失效集扩散，streaming 100 mutations/s + 长会话大侧栏 → 样式重算放大到 10-30ms/帧。另有 `.dsh-rq-btn { transition: all 120ms ease }`（2136）hover 时全属性过渡，低频、次要。 | 用装饰器在 host 行/工作区行打状态类（如 `dsh-has-remote-ws`，装饰器本就每帧跑，顺带 add/remove class），CSS 改纯后代选择器 `div[class*="groupSection"].dsh-has-remote-ws div[data-row-key^="session:"]`；保留 `[data-row-key$=":hostroot"]` 等纯属性规则。 | 修复门禁（当前 2 处 :has → 退出 1；修复后 0）：`node -e "const s=require('fs').readFileSync('packages/dsh-plugin-remote-ssh/client.js','utf8'); if (/:has\(/.test(s)) process.exit(1)"`。真实重算毫秒数 靠 review（DevTools Performance 录制 streaming 期 Style recalculation 时间）。 |

### P2（建议修：并发风暴 + 残留泄漏 + 卡片抖动）

| 编号 | file:line | 卡住/卡顿机制 | 具体修复方案 | 可验证命令 |
|---|---|---|---|---|
| A-05 | client.js:594-608 | 变化轮中，每个 `s.pendingInteraction` 且不在 `activeInteractions` 的会话发 1 个**无节流、无 abort、无超时**的 `fetch(pending-interaction)`——N 个 pending 会话 → N 并发 fetch；host 慢/离线时挂起连接堆积（Lane B 交叉）；N 响应同 tick 到达 → N 次 `handleInteractionRequest` → `publishToUiSession`（官方 uiSession 注册）→ 官方 UI 级联重渲染。fetch 失败被 catch 吞掉，下一变化轮重试 → 每 60s 风暴重复。 | 1) 每会话 in-flight Set 防重；2) 每会话"上次尝试时间戳"节流（如 60s 窗口内至多 1 次）；3) 全部加 `AbortSignal.timeout`（15s 量级）；4) 交互发现主路径改为 follow 流（proxy 已推 interaction/request），poll 兜底降频。 | 新增 smoke-lane-a-perf：同 pending 会话 3 轮 poll 断言 pending-interaction fetch 次数 === 1（当前 === N 变化轮次）。超时/节流存在性 部分 靠 review。 |
| A-06 | client.js:2910-2927（注入）+ 3788-3791（teardown） | `decorateHostRoots` 把按钮 append 到 `row.querySelector('span[class*="rowActions"])`（首匹配）；teardown 只删 `.dsh-host-row-actions` 元素——若 actions 是含 "rowActions" 的 span 而非 `.dsh-host-row-actions`，**按钮残留 DOM**，带活监听器与 `_dshTooltipDisposer`；re-apply 时 `if (!addBtn)` 守卫跳过重建 → 按钮闭包旧 ctx，点击走旧上下文（功能错乱 + 旧闭包滞留）。React 重建行时旧按钮随旧行被替换，无长期泄漏（可 GC），但每行重建反复 create/dispose。 | 1) 维护注入注册表 `Map<rowKey, {btn, disposer}>`，teardown 逐条 remove + 调 disposer；2) 守卫升级为"按钮 isConnected && data-host === 当前激活代"，reactivation 时替换而非跳过；3) teardown 对 hostroot 行内 `.dsh-host-action-btn` 全量 `querySelectorAll` 清理兜底。 | 新增 smoke：apply → 注入按钮 → `dispose()` → 断言 `document.querySelectorAll('.dsh-host-action-btn').length === 0`（当前残留则退出 1）；再 apply 断言按钮 click 走新 ctx。 |
| A-07 | client.js:1350-1613（renderQuestionCard，守卫 1355-1356，隐藏循环 1360-1364，innerHTML 1442）+ 1615-1627（checkAndRenderActiveQuestion 每帧 1-4 次全文档扫描） | 卡片挂进 `findComposerSeat`（1311-1330，最多 3 次全文档 querySelector）返回的 composer seat；streaming 期 React 重建 composer 容器 → 旧 seat（含卡片）被替换 → 下一帧：新 seat 无卡片 → `removeQuestionCard` + **整卡重建**（innerHTML + 重绑全部监听 + appendChild → observer 再触发）→ 每次 composer 重建一次 rebuild，提问 + streaming 同现时反复抖动。另对 React 子节点 `classList.add('dsh-hide-for-question')`（1360-1364）直接改 React 不知情的 className，与 React diff 打架 → 类名抖动/隐藏失效。 | 1) 卡片挂到稳定祖先（如 `data-conversation-content` 会话容器）而非 composer seat 内；2) 隐藏改用 CSS 规则（`seat[data-dsh-question] 后代选择器`）而非逐子 classList；3) seat 句柄缓存 + isConnected 失效；4) `checkAndRenderActiveQuestion` 仅在 `activeInteractions` 非空时做该分支扫描。 | 新增 smoke：模拟 composer 重建 ×5，断言 `.dsh-remote-question-card` 数量 === 1 且 `document.createElement` 卡片计数 === 1（当前 === 5，退出 1）。每帧扫描次数降低由 A-01 修复覆盖。 |

### P3（观察项/低风险）

| 编号 | file:line | 机制 | 修复 | 验证 |
|---|---|---|---|---|
| A-08 | client.js:236-256 + 449-451 | `snapshotFingerprint` 每 60s 对全量快照做一次 JSON.stringify（O(n)）；数百会话 <1-3ms，可接受。 | 可改增量/哈希，非必须；保持现状。 | 计时脚本：构造 1000 会话 body 调 `snapshotFingerprint`，断言 <10ms（当前应过，作回归门禁）：`node -e "…"`（实现于 smoke-lane-a-perf）。 |
| A-09 | client.js:475, 484, 487, 528 | `decodeURIComponent` 未包 try；畸形 `%` 编码的会话/主机 id 使整个 reconcile 抛错 → `void` 吞掉 → 本轮 fan-out 全丢，且每 60s 重复未处理 rejection（永久不更新，非卡顿）。 | 包装 safeDecode 函数（try/catch 返回原串）。 | `node -e`：以含 `%zz` 的 sessionId 喂 reconcile，断言不抛（当前抛 → 退出 1）。 |
| A-10 | client.js:3258-3341（attachTooltip）+ 3784-3791 | teardown 时挂起的 tooltip `setTimeout`：`show()` 已做 `anchor.isConnected` 检查，不建气泡；闭包随节点 GC。无 jank。 | 维持现状（removeWorkspaceAddButton 已示范正确模式：dispose 后再 remove）。 | 靠 review。 |

## 被挑战的假设

1. **"rAF 合并到每帧一次就够了"（被挑战）**：合并只限频 60 次/s，单 pass 仍是 ~10 次全文档扫描。streaming 期每帧都被占 3-15ms，与 React 渲染抢同一帧。采纳：主路径 requestIdleCallback、保留 rAF 兜底保证首帧确定性。
2. **"observer 看全 body 可接受，因为合并了"（被挑战）**：合并减的是触发次数，不是扫描成本。采纳：收窄到装饰器真正触碰的容器，用"容器句柄 isConnected 失效 + 容器级重建时重扫一次"兜底 React 迁移。
3. **"fingerprint 脏检查让 60s poll 免费"（部分成立）**：跳过 fan-out 是真的，但 `ensureWorkspaceTreeMode`+`store.create()`（A-02）、fetch、JSON 解析、stringify 每轮照跑。修复后 poll 内只剩 fetch + stringify。
4. **":has() 静态 CSS 便宜"（被挑战）**：静态规则在 mutation 风暴下每帧重算，:has() 的子树搜索放大失效集。采纳：装饰器打类替代；不采纳纯 JS 布局（保持声明式）。
5. **"reactivation 是干净的重建"（被挑战）**：hostroot 按钮 teardown 不保证移除（A-06），re-apply 守卫复用旧 ctx 闭包。采纳：注册表式 teardown + 激活代校验。
6. **不采纳项**：把 pending-interaction 从 reconcile 整体删除（保留 follow 流为主 + poll 兜底，加节流/超时）；把 60s 轮询改 SSE 推送（超出 Lane A 范围，交 Lane B/C 评估长连接卫生）。

## 与 Lane B/C 的交叉引用（非本 lane 结论）

- fetch 无 AbortSignal.timeout（reconcile 436、pending-interaction 596、popover 2729/2794/2838/2955/3544/3684/3640、session-raw 673 等）→ Lane B 挂起堆积。
- `follow` while(true) reader.read() 无 idle 关闭（721-760）+ snapshot fallback 只在 `!streamed` 触发（772-797）→ Lane B "加载中"卡死。
- reconcile 无 in-flight 守卫的并发竞态 → Lane B 竞态项，本报告 A-03 从主线程双写视角同源。
- host 侧每 poll SSH roundtrip / 30s 超时 → Lane C 轮询堆叠。

## 验证命令汇总

修复前应失败（退出 1）、修复后应通过（退出 0）的门禁：

```bash
# A-01 observer 收窄（当前匹配 document.body → 退出 1）
node -e "const s=require('fs').readFileSync('packages/dsh-plugin-remote-ssh/client.js','utf8'); if (/observer\.observe\(document\.body,/.test(s)) process.exit(1)"

# A-02 ensureWorkspaceTreeMode 仅 apply 一次（当前 2 处 → 退出 1）
node -e "const s=require('fs').readFileSync('packages/dsh-plugin-remote-ssh/client.js','utf8'); const m=s.match(/ensureWorkspaceTreeMode\(ctx\)/g)||[]; if (m.length>1) process.exit(1)"

# A-04 移除 :has()（当前 2 处 → 退出 1）
node -e "const s=require('fs').readFileSync('packages/dsh-plugin-remote-ssh/client.js','utf8'); if (/:has\(/.test(s)) process.exit(1)"
```

已有回归门禁（继续保留，验收时须全绿）：`node smoke-client-bundle.mjs`、`node smoke-performance.mjs`、`node smoke-workspace-btn.mjs`、`node smoke-settings-ui.mjs`、`node smoke-question-card.mjs`（`npm test` 全部）。

建议新增 `smoke-lane-a-perf.mjs`（本报告 A-02/A-03/A-05/A-06/A-07 断言，均由实现者落地），非零退出即回归信号。
