# Agent Note: Page-Freeze Audit and Remediation Plan

Status: implemented

Supersedes: none (builds on `.agents/notes/implemented/bug-fix/2026-10-04-throttle-client-mutation-observer-and-deduplicate-reconcile.md`)

## Problem

长时间运行或在多主机、弱网、会话停顿场景下，插件仍可能引发前端页面"卡住/无响应/加载中转圈"：
1. **主线程持续高频消耗**（Lane A）：`installTitleDecorator` 观察 `document.body` 全量 subtree，streaming 期每帧跑 4 函数（~8-10 次全文档扫描）；`:has()` 选择器使重算范围扩大；`ensureWorkspaceTreeMode` 在每轮 60s 轮询均调用 `store.create()` 重建 store 实例。
2. **异步永久挂起与长连接泄漏**（Lane B）：`wrap.follow` 的 `while(true) await reader.read()` 缺少重置式 idle 超时；当远端停帧时，循环永不退出，snapshot fallback 不可达，官方会话面板永久处于"加载中"；SSE 路由无 idle 关流与心跳。
3. **Host 侧串行 SSH 轮询堆叠与雪崩**（Lane C）：`/remote-ssh/sessions` 每轮逐 host 串行调用 `launcher.homeDirectory`（无缓存，最长 30s），与 list(30s) 串行，单 host 最坏达 60s（等于客户端轮询周期）；单 host 失败会导致整份聚合快照 502；隧道首次启动失败即终止循环。

## Decision

汇总 3 路 Reviewer 采纳意见，制定系统性四层加固方案：

1. **Host 侧消灭串行阻塞与故障隔离**：
   - 缓存远端 `$HOME` 目录（建连时获取一次），移除 SESSIONS_ROUTE 每次轮询的 SSH roundtrip；
   - SESSIONS_ROUTE 改用 `Promise.allSettled` 并隔离单 host 异常，坏 host 返回空列表，不拖垮活 host；
   - 路由增加超时兜底（~40s）。
2. **Follow 会话流生命周期与兜底保底**：
   - Host 侧 SSE 路由注入 15s 心跳帧与 30s idle 自动清理；
   - Client 侧 `reader.read()` 增加重置式超时（收到帧重置），超时主动 abort 并进入 snapshot fallback，彻底终结"永久加载中"；
   - 修复 `parseJsonResponse` 对 body 的双重读取缺陷。
3. **主线程装饰与观察者降噪**：
   - 观察目标收窄至工作区侧栏与相关容器，采用句柄缓存 + `requestIdleCallback` 错峰；
   - `ensureWorkspaceTreeMode` 仅在 `apply()` 执行一次，移除轮询内无效的 `store.create()`；
   - 将 CSS `:has()` 替代为装饰器打标记 class。
4. **客户端全局请求防堆叠与 Teardown 闭环**：
   - `reconcileRemoteSource` 增加全局 `reconciling` 互斥守卫，在途未完成时直接跳过；
   - 客户端统一配置 `AbortSignal.timeout`，插件 teardown 时 abort 全局 signal，回收在途请求与流。

## Alternatives considered

1. **将 60s 轮询改为服务端 WebSocket 全量双向推送**：
   - 成本与复杂度过高，且需改变与官方模型的交互契约。保持 60s 轮询并辅以 in-flight 守卫与 Host 缓存即可达到极佳性能。
2. **移除全部 DOM 注入，改为纯无痕拦截**：
   - 无法呈现"远程主机折叠"、"主机快捷添加工作区"及"交互式问答卡片"等官方缺少的交互能力。收窄 Observer 范围与句柄缓存已能消除绝大部分主线程损耗。

## Consequences

- 彻底根除远端停帧导致的会话面板永久"加载中"假死。
- 轮询耗时由秒级（SSH roundtrip）降至数十毫秒（纯内存/本地代理），单 host 异常不再瘫痪全局。
- streaming 打字期主线程掉帧显著降低。
