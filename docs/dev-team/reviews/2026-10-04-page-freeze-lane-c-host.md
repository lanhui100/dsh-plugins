# Lane C 审核：host 侧延迟/阻塞与长连接卫生（dsh-plugin-remote-ssh）

- 日期：2026-10-04
- 审核人：audit-host-latency（reviewer，偏边界/失败路径/性能）
- 范围：`packages/dsh-plugin-remote-ssh/src/route.ts`、`manager.ts`、`tunnel.ts`、`remote.ts`、`remote-launcher.ts`、`sessions.ts`、`source.ts`、`session-detail.ts`
- 方式：只读审核 + 内联 mock 探针实测（不修改任何源文件；lib/ 已有构建产物）
- 结论：**不通过**。存在直接命中"页面卡住"现象的 P0/P1 缺陷（sessions 轮询堆叠、add-host 长时间无反馈、单坏 host 拖垮全量快照、隧道首次失败永不重连）。

---

## 1. 问题总表

| 编号 | 级别 | file:line | 机制（为什么会让页面变慢/挂起/累积） | 修复方案 | 可验证命令 |
|---|---|---|---|---|---|
| C-01 | **P0** | `route.ts:368-393`（SESSIONS_ROUTE 多 host 分支）+ `remote-launcher.ts:83-90,28-38` + `manager.ts:194-198` | **每 poll、每 host 一次串行 SSH roundtrip 解析 $HOME，且无缓存**。`getHomeDirectory → launcher.homeDirectory → execFile ssh`（ConnectTimeout=10、execFile timeout=30s）。它与 `listRemoteSessions`（fetch，AbortSignal.timeout 30s）在同一个 async 块内**串行**执行（实测见 §3 探针 1）。单 host 最坏 ≈ 30s(list) + 30s(home) = 60s；401 重试链还会再加 readLaunchToken 20s + 重试 30s。配合客户端 60s 轮询**无 in-flight 守卫**（`client.js:436` fetch 无 signal，`client.js:3815-3816` setInterval 直接 `void reconcileRemoteSource(ctx)`），轮询逐次堆叠 → 页面长期"加载中"、SSH 进程并发爆炸。`manager.getHomeDirectory` 本身无任何缓存。 | ① home 目录缓存：tunnel ready 时解析一次（或 TTL ~10min），失败回退 `'~'`，路由不再每 poll 发 SSH；② 每 host 快照用 `Promise.allSettled` + 路由级 `AbortSignal.timeout(~40s)` 封顶（fast host 不被慢 host 拖住）；③ 把 home 解析与 list/baseline **并行**（home 不依赖 list 结果）；④ 客户端 in-flight 守卫（Lane B 协同）。 | 探针 1（见 §3，本次已跑，4661ms 实证串行）；`node smoke-timing.mjs`（真实隧道计时）；堆叠本身**靠 review** |
| C-02 | **P1** | `route.ts:368-481` | **单个 host 的 `listRemoteSessions` 失败会 502 掉整份 /remote-ssh/sessions 快照**：`Promise.all(readyCallers.map(...))` 内 list 无 per-host catch（baseline/home 有 catch，list 没有），任一 host 隧道死/远端挂起 → 整个 Promise.all reject → 全部主机 502；且最坏要等满 30s 才报错。多 host 场景下"一个坏 host 让所有主机在页面上消失"。 | 每 host 快照外包 `.catch` 返回降级条目 `{ host, error, workspaces: [], sessions: [] }`（快照级隔离）；配合 C-01 的 allSettled。 | 探针 2（见 §3，本次已跑，bad host 5s → 全量 502 实测） |
| C-03 | **P1** | `tunnel.ts:117-138`（spawnOnce）+ `tunnel.ts:86-115`（supervise） | **首次隧道启动失败 = 永久失败，且失败要等满 90s**：`spawnOnce` 只监听 child `'error'`（spawn 级），**不监听 child `'close'`**——ssh -L 因 forward 失败/认证失败秒退时，`waitForPort` 仍对本地端口轮询满 READY_TIMEOUT_MS=90s 才 reject；supervise 在 `first` 分支 reject 后直接 `return`，**监督循环终止，之后不再有任何重连**。add-host 与开机 startAll 的主机只要第一次失败就永久躺平（用户只能 remove 后重加或重启插件）。 | ① spawnOnce 把 `waitForPort` 与 child `'close'/'exit'` 做 race，child 先退出则立即 fail-fast；② supervise 首次失败不 return：由 `startHost`/`startPromises` 层决定对外成败，supervise 保留退避重试循环。 | **靠 review**（需要真实 ssh 失败环境：`ssh -o ConnectTimeout=3 dev` 不通即可模拟） |
| C-04 | **P1** | `route.ts:653-696`（ADD_HOST_ROUTE）+ `manager.ts:309-364`（addHost） | **add-host 最坏 ≈ 2 分钟，无路由超时、无进度反馈**：checkStatus（execFile ≤30s，典型 1-10s，ConnectTimeout=10）→ tunnel.start（≤90s，卡点即 C-03）→ warmup（fire-and-forget，不阻塞）→ savePersistedHosts（同步毫秒级）。页面按钮在此期间显示"正在连接…"无限转圈（客户端无超时，Lane B 范畴）；用户没有任何取消路径（并发幂等已由 `startPromises` 合并保证，但无 abort 传导）。 | ① 路由级 `AbortSignal.timeout(120s)` + `req` close → abort 传导到 startHost；② 依赖 C-03 的 fail-fast 把隧道失败降到秒级；③ 客户端加进度/取消按钮（Lane B 协同）；④ 持久化改为成功后原子写（与 C-09 合并）。 | **靠 review**（可用 `ssh -o BatchMode=yes -o ConnectTimeout=3 <不存在的host>` 实测 checkStatus 秒失败路径） |
| C-05 | **P2** | `tunnel.ts:86-115` + `manager.ts:239-304`（doStartHost） | **断线重连窗口内 `entry.isReady` 保持 true**：重连退避 5s×失败数、封顶 60s，期间 `getReadyCallers` 仍返回该 host，sessions 照常 502 全量（C-02）、follow/raw 打到死端口。ServerAliveInterval=15/CountMax=3 对半开连接 ~45-60s 检出 + 退避最多 60s → 断线到恢复最长 ~2 分钟页面全红。 | ① tunnel 暴露 `lost/restored` 事件 → manager 翻转 `entry.isReady`；② 断线期间 sessions 只聚合活 host；③ ServerAliveInterval 降到 10（CountMax=3 → ~30s 检出）。 | **靠 review** |
| C-06 | **P2** | `route.ts:984-1095`（SESSION_FOLLOW_ROUTE）+ `remote.ts:364-485`（followSession） | **SSE follow 无 idle 超时、无连接上限**：每打开一个远端会话 = 1 条 host→client SSE + 1 条 host→remote WS；远端停帧后 `for await` 永远挂起；多会话并行时连接数线性累积；无心跳。`req.on('close')→abort` 链路基本成立，但 `res.write` 在客户端已断开的竞态窗口内无 `res.on('error')` 兜底（Node 对已销毁响应写数据会 emit 'error'）。 | ① idle 定时器：N 分钟无帧 → 发 `: heartbeat` 注释帧；再 N 分钟 → 主动 close；② 每 host 并发 follow 上限（如 16 条，超限 503），或按 sessionId 去重复用单流；③ `res.on('error', noop)` 防竞态崩溃；④ 客户端会话切换必须 abort 旧流（Lane B 协同）。 | **靠 review** |
| C-07 | **P2** | `route.ts:399-408`（subagentParents） | **Map 无清理、只增不减**：每 poll 对每个 subagent 会话 set 4 个键（nsChild/nsParent/交叉），会话被归档/删除后条目永驻。长期运行（天级）内存缓慢增长；陈旧 parent 可能把新会话 id 路由到旧父会话。`pathToRemoteWorkspaceId` 有界（按工作区路径覆盖写）暂不构成问题。 | 每 poll 重建：`subagentParents.clear()` 后再按当轮 items 填充（当轮快照为准）。 | **靠 review** |
| C-08 | **P2** | `route.ts:758-876`（SESSION_RAW_ROUTE）、`route.ts:181-199`（workspaces 路由）、`route.ts:1167-1179`（create 兜底） | **打开会话/工作区选择存在长串行等待**：session-raw = projections(≤30s) + page(≤30s) 串行 → 最坏 ~60s 打开一个会话（session-detail.ts 同样结构，但 page 失败有 catch 降级）；workspaces 路由逐 host 串行 `listHomeDirectories`（每个一次 SSH ≤30s）→ 最坏 N×30s；create 在 cache miss 时 baseline(≤15s)+create(≤30s)。均无路由级超时。 | 路由级 `AbortSignal.timeout`；无依赖的调用并行化（workspaces 路由 `Promise.all`）；给 session-raw 加 ~45s 上限。 | **靠 review** |
| C-09 | **P3** | `route.ts:126-139`（readJsonBody） | **POST body 无大小上限、无 content-length 校验**：所有 POST 路由共用；超大 body 的 `JSON.parse` 同步阻塞事件循环（多 MB 级别即可见卡顿），内存无界累积。 | ① 读取前校验 content-length（如 >10MB 直接 413）；② 流式累积时按字节计数超限即 413 并 destroy；③ 可对 prompt 等大字段单独放宽但设硬上限。 | `curl -X POST .../remote-ssh/prompt -d @<大文件>`（靠 review 环境，机器不可复现则标**靠 review**） |
| C-10 | **P3** | `manager.ts:421-464`（load/savePersistedHosts） | **同步 readFileSync/writeFileSync**：调用频率极低（构造时 load、add/remove host 时 save）、文件极小（hosts 列表），事件循环阻塞可忽略；但 `writeFileSync` 非原子（进程崩溃中写 → JSON 损坏，load 有 catch 会静默丢注册表）。 | 低风险保留；可选原子写（tmp 文件 + rename）提升健壮性。 | `node smoke-manager.mjs`（现有冒烟） |
| C-11 | **P3** | `remote.ts:549`（pendingInteractions） | 未答复的 user-question 无 TTL，`cancel`/`respond` 才会清除；长挂问题永驻内存，且 `getPendingInteractionsForSession` 每 poll 全 Map 扫描。规模小（交互问题量级）风险低。 | 加 24h TTL 或按会话关闭清理。 | **靠 review** |

### 补充说明（不单独成行）
- `remote.ts:94-97` `timeoutSignal`：`AbortSignal.timeout(30s)` 覆盖**整个** `callOnce` 的 fetch（含 `response.json()` 读 body），底层 socket 有兜底 —— 已确认，非缺陷。
- `fetchWorkspaceBaseline`（`remote.ts:201-323`）：WS 15s 超时 + 30s 缓存，cache 命中时 ~0ms —— 通常不是瓶颈；真正的大头是 C-01 的 home SSH。
- `sendJson` 每 poll 对全量快照 `JSON.stringify`：受 `groupSessionsByWorkspace(items, 50, …)` 分组 50 条上限约束，量级可控（P3 以下，不列行）。
- `ensureEventsListener`（`route.ts:387/528`）fire-and-forget，socket 已开时 O(1) 早退 —— 不阻塞，非缺陷。

---

## 2. 被挑战的假设与取舍

| # | 假设 | 裁决 | 说明 |
|---|---|---|---|
| A1 | "单 host 最坏 ~60s，整快照被最慢 host 拖住" | **采纳（并修正细节）** | 实测串行结构成立（§3 探针 1）。修正：baseline 有 15s 超时 + 30s 缓存，通常 ~0；真正大头是 **home SSH（每 poll 一次、无缓存、串行）**。最坏 = list 30s + home 30s ≈ 60s，恰好 ≥ 客户端 60s 轮询周期 → 堆叠。401 重试链可再叠加 20s(token)+30s(重试)，最坏 ~80s。 |
| A2 | "远端 dsh 慢/无响应时 socket 无超时；remote.ts 30s 是否覆盖 fetch" | **部分采纳** | `invoke/callOnce` 的 fetch 由 `AbortSignal.timeout(30s)` 全包（含 body 读取）——HTTP 层有兜底；WS baseline 15s。**不采纳**"无 socket 超时"这一半。但 followSession 的 WS 无超时（长连接设计使然，需靠 idle 定时器补，见 C-06）。 |
| A3 | "add-host 最坏 ~2.5 分钟" | **修正为 ~2 分钟** | checkStatus ≤30s（ConnectTimeout=10，典型 1-10s；ssh 不通时 ~10s 即 'dead'→秒失败）；tunnel.start ≤90s（卡点是 C-03：ssh 秒退但 waitForPort 仍轮询满 90s）；warmup fire-and-forget 不阻塞。真正的用户体验问题是"无进度、无取消、无路由超时"（C-04）。 |
| A4 | "ServerAliveInterval=15/CountMax=3 足够及时发现半开连接" | **部分采纳** | 对半开连接 ~45-60s 检出，可接受；对"连接活着但远端 dsh 挂起"**无效**（SSH 层探测不到应用层无响应）——靠 30s fetch 超时兜底。主要缺口不在探测参数，而在 C-05：断线窗口内 isReady 不翻转、首启失败永不重连（C-03）。 |
| A5 | "readFileSync/writeFileSync 是事件循环同步阻塞点" | **采纳为低风险（P3）** | 频率（add/remove 时）+ 规模（小 JSON）都可忽略；顺带发现非原子写问题，一并归 P3。 |
| A6 | "SSE follow：会话切换/关页是否都触发 req close→abort" | **链路成立，卫生缺失** | Node IncomingMessage `'close'` 在客户端断连时触发 → abort → `for await` 退出 → finally `res.end()`，链路完整。缺口：无 idle 超时、无连接上限、`res.write` 竞态无 `'error'` 兜底（C-06）；会话切换是否真的 abort 旧流取决于客户端（Lane B 交叉项）。 |
| A7 | "subagentParents/pathToRemoteWorkspaceId 每 poll set，是否有清理" | **采纳（一半）** | `pathToRemoteWorkspaceId` 有界（按路径覆盖）；`subagentParents` **只增不减**（C-07）。 |
| A8 | "readJsonBody 对超大 body 无限制" | **采纳（P3）** | 无上限、无 content-length 校验（C-09）。 |
| A9 | 任务建议的"每 host 快照 Promise.race 封顶" | **采纳变体** | 直接用 `Promise.race` 会"放弃"慢 host（被放弃的 SSH 仍在后台跑完，只是不占响应）——可用；更优组合是 `Promise.allSettled` + per-host 超时 + **home 缓存消灭大头**（C-01），三管齐下。 |

---

## 3. 本次实测（只读内联探针，未改任何文件）

**探针 1 — home SSH 串行 + 每 poll 一次**（mock launcher 注入延迟：list 1.5s / baseline 0.8s / home 3s）

```
事件顺序: list:start -> baseline:start -> baseline:done -> list:done -> home:start -> home:done
sessions route took 4661 ms (serial: list+baseline parallel, then home SSH)
```

结论：`getHomeDirectory` 在 list/baseline 完成后才发起，串行追加一次完整 SSH roundtrip；真实环境下该段最长 30s（execFile timeout）。

**探针 2 — 单坏 host 拖垮全量快照**（mock 双 host：good 100ms 返回、bad 5s 后抛错）

```
status: 502 | elapsed: 5012 ms
body: {"error":"remote-unavailable","message":"tunnel to bad host is dead"}
```

结论：`listRemoteSessions` 无 per-host catch → 全量 502（真实最坏等满 30s）。

**回归命令（修复后建议门禁）**
- `node packages/dsh-plugin-remote-ssh/smoke-multi-host.mjs` — 多 host 聚合/命名空间/归档钉选路径冒烟（exit 0）。
- `node packages/dsh-plugin-remote-ssh/smoke-timing.mjs` — 真实隧道下 listRemoteSessions 计时（需 `REMOTE_SSH_BASE_URL` 指向活隧道）。
- `node packages/dsh-plugin-remote-ssh/smoke-manager.mjs` — manager 生命周期冒烟。
- 探针复现命令（修复前复现、修复后应变为 ~list 时长；注意 `storagePath` 传临时路径，避免写真实 `$DSH_HOME`）：

```bash
node --input-type=module -e "
import { RemoteHostManager } from './packages/dsh-plugin-remote-ssh/lib/manager.js';
import { registerRemoteSshRoute, SESSIONS_ROUTE } from './packages/dsh-plugin-remote-ssh/lib/route.js';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const launcher = { homeDirectory: async () => { await sleep(3000); return '/home/u'; }, listHomeDirectories: async () => [], createHomeDirectory: async () => ({name:'x',path:'/home/u/x'}), checkStatus: async () => 'alive', findHarnessPath: async () => '/x', ensureService: async () => ({}) };
const manager = new RemoteHostManager({ primaryHost:'dev', primaryRemotePort:3080, primaryLocalPort:39387, launcher, storagePath: process.env.TEMP + '/probe-hosts.json' });
manager.registerConfiguredHost({host:'dev', remotePort:3080, localPort:39387});
const e = manager.getAllEntries()[0]; e.isReady = true;
e.caller = { invoke: async () => ({ items: [] }), fetchWorkspaceBaseline: async () => ({ items: [], archivedSessionIds: [], pinnedSessionIds: [] }), getPendingInteractionsForSession: () => [], ensureEventsListener: async () => {} };
const routes = new Map();
const ctx = { inject: (deps, cb) => cb({ webServer: { register: (r) => { routes.set(r.path, r.handler); return () => {} } }, effect: (fn) => { fn(); return () => {} } }) };
registerRemoteSshRoute(ctx, manager, 'dev');
const t0 = Date.now(); await routes.get(SESSIONS_ROUTE)({}, { writeHead(){}, end(){} });
console.log('sessions route took', Date.now()-t0, 'ms');
"
```

**标"靠 review"的项**（需真实 SSH/远端环境或长时运行，本环境不可机械验证）：C-03 首次失败 90s 挂起与永不重连、C-04 add-host 全链路时长、C-05 断线窗口行为、C-06 SSE 泄漏与竞态、C-07 Map 增长、C-08 串行等待、C-09 大 body、C-11 无 TTL。

---

## 4. 优先级结论

- 必须先修：C-01（P0，页面卡住主因）、C-02（P1，一坏全坏）、C-03（P1，90s 挂起 + 永不重连）、C-04（P1，add-host 无反馈）。
- 应修：C-05、C-06、C-07、C-08（P2，卫生与边界）。
- 可缓：C-09、C-10、C-11（P3，加固项）。
