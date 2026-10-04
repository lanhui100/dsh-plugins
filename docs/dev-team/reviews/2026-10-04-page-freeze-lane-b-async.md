# Lane B 审核：异步挂起与竞态（页面"卡死"类）— dsh-plugin-remote-ssh

- 日期：2026-10-04
- 审核人：audit-async-hang（正确性 / 失败路径）
- 范围：`packages/dsh-plugin-remote-ssh/client.js`（3856 行）、`src/route.ts`（1484 行）；参考 `src/remote.ts`、`src/tunnel.ts`、`src/manager.ts`、`src/sessions.ts`、`src/remote-launcher.ts`
- 性质：只读审核，未修改任何源文件
- 关联：Lane A（client.js 主线程卡顿，audit-perf-client）、Lane C（host 侧延迟/长连接卫生，audit-host-latency）。本文聚焦"页面**一直等待/挂起**"；主线程帧率问题见 Lane A，host 侧 SSH 延迟量化见 Lane C。

## 结论：**不通过**

存在 1 个 P0：follow 链路无任何 idle 超时/心跳，远端停帧后官方会话面板永久停在"加载中"，且 snapshot fallback 在该场景下永远不可达（fetch 挂起时 `reader.read()` 永不 settle）。另有多项 P1（SSE 长连接泄漏、teardown 未 abort 未决请求、并发 reconcile 无 in-flight 守卫、旧快照晚到覆盖新状态）。修复 P0 + P1 后再放行。

---

## 问题总表

### P0 — 页面确定性卡死（无任何自救路径）

| # | file:line | 挂起机制（为什么页面会卡住） | 修复方案 | 可验证命令 |
|---|---|---|---|---|
| **B-01** | `client.js:721-767`（follow while 循环）<br>`client.js:772-797`（snapshot fallback）<br>`remote.ts:470-480`（queue wait，479 行 `await new Promise(notify)` 无超时）<br>`route.ts:1077-1083`（SSE `for await` 无 idle 关闭） | 官方会话面板打开远端会话 → `wrap.follow` fetch SSE（client.js:712）→ host 路由 `for await (frame of caller.followSession(...))` → `followSession` 在无帧时 `await new Promise(notify)`（remote.ts:479）**永不 resolve**（无 idle 超时、无心跳）→ SSE 既不推帧也不关闭 → 客户端 `await reader.read()`（client.js:722）**永不返回** → `streamed` 恒为 false，循环永不退出 → snapshot fallback（client.js:772，仅 `!streamed` 且循环退出后触发）**永远不可达** → 官方会话面板永久"加载中"。远端不发帧的触发条件：会话空闲、远端 mux 静默、follow 流在首帧前停帧（如 fromSeq 已到末尾、远端事件系统无新事件）。 | 三层兜底，以 host 侧为准：<br>① `remote.ts followSession`：queue wait 改重置式 idle 定时器（60s 无帧 → `terminate(new Error('follow idle timeout'))`）→ 生成器抛错 → 路由 catch 写 error 帧 → `res.end()`。<br>② `route.ts SESSION_FOLLOW_ROUTE`：加 idle 定时器（30s 无 `res.write` → `res.end()` 强制关流）+ 心跳帧（每 15s `data: {"type":"heartbeat"}`），停帧后连接必然回收。<br>③ `client.js wrap.follow`：`reader.read()` 外包重置式超时（AbortSignal.timeout 每次收帧重置），超时 abort 本次 fetch 后落回 snapshot fallback；同时把 fallback 后 `await new Promise(abort)`（client.js:793-796）改为带超时或直接 `return`。 | `rg -n "heartbeat\|FOLLOW_IDLE\|followIdle" packages/dsh-plugin-remote-ssh/src/route.ts packages/dsh-plugin-remote-ssh/src/remote.ts` — **当前 exit 1**（无心跳/无 idle），修复后 exit 0。<br>`rg -n "while \(true\)" packages/dsh-plugin-remote-ssh/client.js` — 当前命中 721（裸循环），修复后循环体应含 idle 超时分支。 |

### P1 — 条件性挂起 / 长连接泄漏 / 清理缺口

| # | file:line | 挂起机制 | 修复方案 | 可验证命令 |
|---|---|---|---|---|
| **B-02** | `route.ts:1017-1093`（SESSION_FOLLOW_ROUTE 写头后无心跳、无 idle 关闭） | 远端停帧后 `for await` 卡在 `followSession`，路由 handler 永不返回：每打开一个远端会话就泄漏 1 条 host HTTP 长连接 + 1 条远端 `remote.mux` WS 流，直到会话切换或页面关闭（依赖 `req 'close'` → `abortController.abort()`，route.ts:1026-1029，链路本身存在但只在客户端主动断开时生效）。静默会话长期占用连接。 | 与 B-01 ② 同：host 侧 idle 定时器强制 `res.end()` + 心跳帧。另建议 `res.flushHeaders?.()` 后启动定时器，确保半开连接可探测。 | 与 B-01 命令相同（心跳/idle 条目）。连接数佐证（靠运行时，非纯静态）：反复开/切 N 个远端会话后 `netstat -ano \| findstr 127.0.0.1:39` 统计 ESTABLISHED 是否随 N 单调增长。 |
| **B-03** | `client.js:3815`（setInterval 每 60s `void reconcileRemoteSource`）+ `client.js:436`（SESSIONS_ROUTE fetch 无 AbortSignal、无 in-flight 守卫）+ 5 处手动触发（client.js:1218/2812/2856/3105/3590/3638） | 并发 reconcile 无守卫：手动触发（add-host/删工作区/断开）与定时 poll 交错；最坏延迟下（每 host：invoke 30s ∥ baseline WS 15s → home SSH 30s，route.ts:368-393）单轮 ~60s，与轮询间隔同量级 → 慢请求堆叠；旧快照（晚到）覆盖新状态 → 侧栏闪烁/回退；SSH 进程每轮堆积。 | ① reconcile 全局 in-flight 守卫：`if (reconcileInFlight) { reconcileQueued = true; return }`，完成时若 queued 再跑一轮（或直接丢弃 + 依赖下一轮 poll）。② fetch 加 `AbortSignal.timeout(35_000)`（host 侧 60s 最坏 → 客户端 35s 截断 + 下一轮刷新，宁可少一轮也不堆叠）。③ teardown 时 abort 在途 fetch（见 B-04）。 | `rg -n "reconcileInFlight\|reconcileRunning" packages/dsh-plugin-remote-ssh/client.js` — **当前 exit 1**，修复后 exit 0。<br>`rg -n "AbortSignal.timeout" packages/dsh-plugin-remote-ssh/client.js` — **当前 exit 1**，修复后 exit 0。 |
| **B-04** | `client.js:3833-3849`（ctx.effect teardown） | teardown 遗漏未决异步：① 在途 reconcile fetch（436，无 abort）→ teardown 后仍 resolve，向已还原的 ctx.sessions/workspaces 写模型（post-teardown 复活远程行）；② 进行中的 follow SSE（wrap.follow 无插件级登记，官方 caller 的 abort 与插件 teardown 无耦合）；③ popover/settings 在途 fetch（AVAILABLE_HOSTS/ADD_HOST/ADD_WORKSPACE/register-workspace/REMOVE_HOST）不跟踪不 abort，完成后写已移除 DOM + 弹 toast；④ 模块级 `registerPendingPublisher`（client.js:174）teardown 未置 null（二次 apply 会经 inject 重注入，影响小）。已覆盖项：clearInterval、restoreProxy/Guardian/Styles/Decorator、removeRemoteSource、uiSessionDisposers 全量 unregister、activeInteractions 清空 —— 正确。 | ① 模块级 `AbortController`（或共享 signal）传入所有页面 fetch，teardown 统一 `abort()`。② follow 流登记进 `Set<AbortController>`，teardown 逐一 abort（host 侧经 `req close` → 路由收尾）。③ popover cleanup（client.js:2670-2674）里 abort 其作用域 fetch。④ teardown 置 `registerPendingPublisher = null`。 | `rg -n -A 22 "ctx\.effect\(\(\) =>" packages/dsh-plugin-remote-ssh/client.js \| rg -c "abort"` — **当前 0**，修复后 ≥1。 |
| **B-05** | `client.js:436/596/712/805/838/874/979/1096/1123/1150/1177/1205/1295/2794/2838/3095/3544/3582/3640/3684`（全量页面 fetch 审计） | 所有页面 fetch 均无 `AbortSignal.timeout`；其中 ADD_HOST（route.ts:680 → manager.addHost → checkStatus SSH 30s + `SshTunnel.start` → `waitForPort` READY_TIMEOUT_MS=90s，tunnel.ts:18）**最长 ~90s+ 无取消路径**：popover spinner 无限转、页面请求 pending；close popover 后 fetch 继续，完成时写已移除 DOM。`cancel/rename/archive/unarchive/pin/unpin/create/respond` 等 POST 亦无 signal（host 侧 invoke 30s 兜底，但按钮期间不可取消）。 | 统一封装：`fetchJson(url, { signal: AbortSignal.any([callerSignal, AbortSignal.timeout(30_000)]) })`；ADD_HOST 用 100s 超时 + 按钮期取消。交互类 POST 至少加 30s 超时（host 侧 invoke 本有 30s，客户端超时仅作护栏）。 | `rg -n "AbortSignal.timeout\|AbortSignal.any" packages/dsh-plugin-remote-ssh/client.js` — **当前 exit 1**，修复后 exit 0。 |

### P2 — 错误掩盖 / 有界等待过长

| # | file:line | 机制 | 修复方案 | 可验证命令 |
|---|---|---|---|---|
| **B-06** | `client.js:3348-3363`（parseJsonResponse） | 双重读取：先 `res.text()`（已消费 body），再 `res.json()`。当响应体为非空但非 JSON 文本（如 host 返回 HTML 错误页/纯文本 500）时：`JSON.parse(text)` 抛 → 进第二分支 → `res.json()` 因 body 已消费抛 "Body is unusable" → 被 catch → 返回 `null`。**真实错误体被静默掩盖**，UI 一律显示"响应为空/读取失败"，丢失诊断信息（不挂起，但掩盖失败原因，且多一次无效读）。 | 单次读取：`const text = await res.text()`；空串 → null；`JSON.parse(text)` 失败 → 返回 `{ parseError: text.slice(0, 200) }` 或 null，**删除 json() 分支**。 | `rg -n "res\.json\(\)" packages/dsh-plugin-remote-ssh/client.js` — 当前命中 parseJsonResponse 内 json() 双读（3348-3363）；修复后该函数内应无 `res.json()`。 |
| **B-07** | `client.js:596`（reconcile 内 pending-interaction fetch）+ `client.js:1295`（interaction-respond） | pending-interaction fetch 无超时、fire-and-forget、teardown 后 resolve 仍调 `handleInteractionRequest` → `renderQuestionCardIfActive`（DOM/模型写）。路由本身是本地同步查找（route.ts:1241），实际秒回，风险低——但属于无护栏的未决 promise。 | 并入 B-05 的封装（30s 超时 + teardown abort）；`.then` 前检查 teardown 标志。 | 并入 B-05 命令。 |

### P3 — 低危 / 有兜底

| # | file:line | 机制 | 修复方案 | 可验证命令 |
|---|---|---|---|---|
| **B-08** | `client.js:793-796` | snapshot fallback 之后 `await new Promise(resolve)` 等 abort：signal 提供但永不 abort → 生成器成为僵尸（面板已水合，不再卡 UI，但官方 for-await 永久 pending）。 | 改带超时（如 30s 后 return）或直接 return。 | 靠 review（行为需运行时观察）。 |
| **B-09** | `route.ts:1073` vs `remote.ts:466` | abort→unlisten 的监听注册于 route 内，而 `followSession` 内部 onAbort 在 `ensureCookie()`（最坏 30s）之后才注册（remote.ts:371 → 466）：cookie 交换窗口内客户端 abort 不触发 WS terminate。socket.onclose 兜底 terminate，实际泄漏窗口 ≤ TCP 超时。 | 在 remote.ts `followSession` 中把 `signal.addEventListener('abort')` 提前到 WS 创建后、await 之前。 | 靠 review。 |
| **B-10** | `manager.ts:379-381`（removeHost 对 in-flight startHost 抛错）+ `client.js:3576-3603`（popover 断开） | removeHost 与进行中 add-host 冲突：throw "still connecting"。UI 侧**有保护**（popover catch 显示错误并恢复按钮），不挂起。但 connecting 中的 host 已被 `getHostNames()` 计入 → 显示在"已连接"列表（manager.ts:90-92 + registerConfiguredHost 同步入表），点击断开必错，UX 困惑。 | 列表区分 `isReady` 状态（已连接/连接中），connecting 时不渲染断开按钮。 | 靠 review。 |
| **B-11** | `client.js:2921/3573/3629/3733`（attachTooltip disposer） | hostroot addBtn / popover 按钮的 `_dshTooltipDisposer` 在 restoreDecorator（client.js:3788-3791 直接 remove 节点）与 removeAddRemotePopover（3225-3231）中未显式调用。安全网：`show()` 检查 `anchor.isConnected`（3285）早退，定时器/闭包随节点 GC 自愈，无泄漏。 | 顺手在 remove 路径调用 `_dshTooltipDisposer` 收尾即可。 | 靠 review。 |

---

## 被挑战的假设与取舍

1. **"host 路由被 SSH 30s 超时拖住 → 页面 fetch 无限期 pending → 60s poll 无限堆叠"（任务卡原话）——不采纳"无限"部分。**
   证据：host 侧所有远程耗时都有硬超时兜底——`RemoteCaller.invoke` 30s（remote.ts:94-97 timeoutSignal）、`fetchWorkspaceBaseline` WS 15s（remote.ts:221-223）、SSH execFile 20/30s（remote.ts:32、remote-launcher.ts:32）。SESSIONS_ROUTE 单 host 最坏 ≈ max(30s, 15s) + home SSH 30s ≈ 60s，多 host 并行 ≈ 60s，**恰与 60s 轮询间隔同量级**。结论：是"近边界堆叠 + 旧覆盖新 + 无取消"，不是无限堆叠——因此定为 P1（B-03）而非 P0；但修复优先级等同 P0（轮询间隔必须 > 路由最坏延迟，或加 in-flight 守卫）。
2. **"follow 挂起 → 会话面板永远'加载中'"——采纳为 P0，但前提要写清楚。** 只有当远端 follow 流在**首帧之前/之后停帧**且客户端不切换会话时才成立（B-01）。若远端先推了 snapshot 帧再静默，面板已水合，变成"连接泄漏 + 静默僵尸"（B-02/B-08）——两种场景都需 idle 超时。
3. **"snapshot fallback 只在 !streamed 时触发"——采纳。** 已核对 client.js:710 `streamed=false` 初始化、733 收帧才置 true、772 条件。fetch 挂起（reader.read 永不 settle）时循环永不退出，fallback 不可达。这是 B-01 的机制核心。
4. **"remote.ts 30s requestTimeoutMs 覆盖 followSession 流式读取"——不成立。** `timeoutSignal`（remote.ts:94-97）只用于 `callOnce`（invoke）和 `exchange`；`followSession`（remote.ts:364-485）完全不经过 timeoutSignal，且作为流式通道**不应**用一次性 30s 超时——修复方向是"重置式 idle 超时 + 心跳"，不是套固定 deadline（采纳：不破坏活跃流）。
5. **"add-host 双击/并发"——采纳"UI 有保护"。** popover `setAddBusy`（3666-3672）与 settings 卡 `addBtn.disabled`（3090-3092）挡双击；`manager.startHost` 的 `startPromises`（manager.ts:247-253）合并同 host 并发；`allocateLocalPort` 为同步读表 → 无端口竞争。残留问题仅是 90s 无取消等待（B-05）与连接中显示（B-10）。
6. **teardown 中 "uiSessionDisposers（已清）"——采纳正确；但 registerPendingPublisher 未置 null、在途 fetch/SSE 未 abort 为真实缺口（B-04）。**

## 修复优先级建议

1. B-01（P0）+ B-02（P1，同一修复：follow 三层 idle/心跳）→ 解锁"会话面板永久加载中"与"长连接泄漏"。
2. B-03 + B-05（reconcile 守卫 + 全量 fetch 超时封装，含 ADD_HOST 100s）。
3. B-04（teardown abort 链）。
4. B-06（parseJsonResponse 单读）、B-07（pending-interaction 护栏）。
5. B-08~B-11（P3，随重构顺手）。

## 验证命令汇总（均非零退出语义）

- V1 `rg -n "AbortSignal.timeout" packages/dsh-plugin-remote-ssh/client.js` → 当前 **exit 1**（无任何超时）；修复后 exit 0。
- V2 `rg -n "heartbeat|FOLLOW_IDLE|followIdle" packages/dsh-plugin-remote-ssh/src/route.ts packages/dsh-plugin-remote-ssh/src/remote.ts` → 当前 **exit 1**；修复后 exit 0。
- V3 `rg -n "reconcileInFlight|reconcileRunning" packages/dsh-plugin-remote-ssh/client.js` → 当前 **exit 1**；修复后 exit 0。
- V4 `rg -n -A 22 "ctx\.effect\(\(\) =>" packages/dsh-plugin-remote-ssh/client.js | rg -c "abort"` → 当前 **0**；修复后 ≥1。
- V5 `rg -n "res\.json\(\)" packages/dsh-plugin-remote-ssh/client.js` → 当前命中 parseJsonResponse 双读；修复后该函数内无 `res.json()`。
- 运行时佐证（靠 review + netstat）：反复开/切远端会话后 `netstat -ano | findstr 127.0.0.1:39` 的 ESTABLISHED 计数不应随会话数单调增长（B-02 收敛验证）。
