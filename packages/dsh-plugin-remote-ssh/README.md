# dsh-plugin-remote-ssh

> 经 SSH 隧道把远端 DSH 实例的工作区与会话聚合到本地 UI（方案 B）。

## config

| 键 | 含义 | 默认 |
|---|---|---|
| `host` | OpenSSH 主机别名（含用户/密钥/known-hosts 配置）。**可选**：省略时不做任何主机预置，远程主机统一通过侧边栏“添加远程主机”入口/『设置』面板的动态接入机制添加并持久化 | 无 |
| `remotePort` | 隧道远端的 DSH web 端口 | `3080` |
| `localPort` | 本地回环转发端口 | `39387` |
| `reconnectDelayMs` | 隧道断开重连的基础延迟 (ms) | `5000` |
| `reconnectMaxDelayMs` | 隧道断开指数退避的最大延迟上限 (ms) | `60000` |
| `serverAliveInterval` | SSH 客户端心跳间隔秒数 (`-o ServerAliveInterval=N`) | `15` |
| `serverAliveCountMax` | SSH 客户端心跳未响应断开重连次数阈值 (`-o ServerAliveCountMax=N`) | `3` |
| `connectTimeout` | SSH 建立连接超时秒数 (`-o ConnectTimeout=N`) | `10` |
| `tcpKeepAlive` | 是否启用操作系统 TCP 探针 (`-o TCPKeepAlive=yes`) | `false` |

> “不预置”仅指启动配置不再隐含主机；已通过 UI 添加并持久化到 `$DSH_HOME/remote-ssh-hosts.json` 的主机（含升级前静态 `dev` 遗留下来的条目）重启后仍会照常恢复连接。

## semantics

- 本地 Host 端持有 `ssh -N -o ExitOnForwardFailure=yes -o BatchMode=yes -o ConnectTimeout=... -o ServerAliveInterval=... -o ServerAliveCountMax=... -L <localPort>:127.0.0.1:<remotePort> <host>` 隧道子进程，负责就绪探测、保活与带抖动保护的指数退避重连（下限 1s，防止惊群风暴）。
- **双层保活与状态总线**：`SshTunnel` 对外派发 `onReady` 与 `onDown` 生命周期事件，底层隧道网络断开时联动挂起 `RemoteCaller` 的 `$events` WebSocket 轮询重连；隧道物理重连就绪时主动唤醒 `$events` 并立即复位退避计数重连。
- **本地端口冲突预检与自增寻优**：静态主配置端口若被占用严格 Fail-Fast 报错；动态添加主机通过操作系统 `net.createServer` 预检空闲端口并自动自增寻优（Auto-hunt），杜绝端口冲突。
- 自动经 SSH 读取远端 `dsh web` 启动日志的 `?token=`，经隧道 `GET /?token=...` 换取 authority 绑定的会话 Cookie，并在 401 或网络重启后自动清空缓存重新换取。
- **响应性**：隧道就绪即预热 Cookie（`caller.warmup()`），首次 `/remote-ssh` 跳过 SSH+token 往返（实测预热 ~1s + 列表 ~2s）；所有远端 fetch 有 30s 截止（`requestTimeoutMs`），取消信号从命令直传 RPC，杜绝无限挂起。
- 经隧道调用远端 `/api/session/list`（携带换取的 Cookie 与 `_request` 参数信封），拉取远端全部会话（包括标题、运行状态、工作目录 cwd）。
- Host 入口声明 `inject = ['commands']`（Cordis 在激活前解析服务；缺声明会让 `ctx.commands` 访问抛错、条目永不激活，在桌面还会连带清空用户 patch 层）。
- Client 入口声明 `inject = ['workspaces', 'sessions', 'remote', 'remote.session', 'remote.workspace', 'fileUpload', 'remote.commands', 'remote.workspaceFiles']`（Cordis 严格校验 Context 属性访问权限；访问关联服务命名空间 `ctx.remote.session`、`ctx.remote.workspace`、`ctx.remote.commands` 与 `ctx.remote.workspaceFiles` 必须显式声明，否则抛错导致桌面 web-boot 失败）。
- Host 端注册 `/remote-ssh` 人令（在对话输入框输入即可列出远端会话）。
- **完整复用官方 UI（零自定义界面）**：Client 半不注册任何槽位/面板/侧边栏。Host 注册只读路由 `GET /remote-ssh/sessions`（按 cwd 聚合的工作区与会话快照）、`GET /remote-ssh/session?id=...`（人性化详情）与 `GET /remote-ssh/session-raw?id=...`（原始 wire 事件，供官方会话管道直接消费）。
- **注入官方模型**：Client 端把远程工作区/会话 upsert 进 `ctx.workspaces.list`（`upsertView`）与 `ctx.sessions`（`handleSessionAdded`），因此远程工作区直接出现在官方 `WorkspaceBrowser` 侧边栏树里——官方文件夹折叠/展开、会话行、状态点、右键菜单全部原样生效。远程树采用**三级层级**：每台已连接主机注册一个一级主机根文件夹（`remote:<host>:hostroot`，路径为远端 `$HOME`，标题为截断后的主机别名，图标替换为服务器图标），其下按官方“工作区树”分组的路径前缀自动嵌套各远程工作区文件夹（文件夹图标 + 工作区名称），会话为第三级菜单；`GET /remote-ssh/sessions` 新增 `homes` 字段下发每台主机的远端 home 路径。
- **工作区会话筛选与容器归档存活（`archivedFilter` 原生对接）**：`GET /remote-ssh/sessions` 为每个工作区分组下发权威 `sessionIds`（由远端 baseline 权威顺序与当次新发现会话并集生成），Client 端优先使用 `ws.sessionIds` 建立工作区视图，在“全部会话”（`show`）模式下完整渲染工作区内的已归档远程会话；同时为本地与各远程主机根容器（`local:hostroot` 及 `remote:<host>:hostroot`）注入恰好 1 个代表已归档会话（远程容器从同级工作区成员中剔除该代表以杜绝重复行，本地容器选用非远程已归档会话且不修改官方模型），确保主机折叠菜单与各工作区在官方“仅显示已归档”（`only`）模式下不被官方空组剔除机制丢弃。
- **代理会话与工作区文件流**：Client 端包装 `ctx.remote.session`（以及 `ctx.remote.subagents`）的 `page` / `follow` / `projections` / `prompt` / `cancel` / `rename` / `selectModel` / `attachment` 与 `ctx.remote.workspaceFiles`（`stat` / `read` / `readBytes` / `list`）；命中已知远程会话 id 时从隧道路由应答，本地会话原样穿透。点击侧边栏远程会话即走官方 `openSession` → 官方 `ui-conversation` 用远程原始事件组装官方消息流，右侧工作区文件树与文件预览卡片原生可用。
- **新建会话（`create`）与空白会话复用**：Client 端拦截 `ctx.remote.session.create`；官方 UI 会先用 `sessionId` 复用工作区里最近的空白会话，插件将命名空间化的会话 id 还原为远端原始 id 后再经 `POST /remote-ssh/create` 转发，远端按 id 幂等 adopt——因此远程工作区点击「新会话」不会在远端生成重复的空白会话副本；命中已知 id 时真正复用，未命中时新建。
- **会话操作代理（归档/置顶/重命名）**：Client 端拦截 `ctx.remote.workspace`（`archiveSession`, `unarchiveSession`, `pinSession`, `unpinSession`）与 `ctx.remote.session.rename`；命中已知远程会话时转发 Host 路由（`POST /remote-ssh/session-archive`、`session-unarchive`、`session-pin`、`session-unpin`、`session-rename`），并在本地与远端集合间执行双向隔离与合并，实时刷新官方 `WorkspaceBrowser` 树与会话标题；本地会话原样透传。多主机（`RemoteHostManager`）模式下操作响应与会话快照使用同一命名空间身份 `remote:<host>:<id>`，客户端按主机前缀合并远程归档/置顶集合并保留其它主机与本地状态；legacy 单 caller 保持原始 ID 行为。
- **附件与加号菜单代理（attachment / file upload / commands）**：Client 端包装 `ctx.remote.session.attachment`、`ctx.remote.fileUploads.upload`、`ctx.fileUpload.upload` 与 `ctx.remote.commands`；解决此前远程会话中点击输入框加号（`+`）因本地缺失远程会话命令目录报错导致面板不弹出的故障，确保加号菜单顺畅打开且「文件」命令常驻。用户通过加号选择或拖拽宿主机文件时，DOM 捕获阶段拦截默认路径引用行为，直接转为附件草稿并通过隧道上传至远端暂存区；本地会话原样透传。
- **模型切换（`selectModel`）**：用户在远程会话的模型选择器中更换模型时，Client 端拦截 `ctx.remote.session.selectModel`，命中远程会话则经 Host 路由 `POST /remote-ssh/session-select-model` 转发至远端 `session/selectModel`，成功后就地更新本地 `modelSelection` 投影缓存保持 UI 即时回显；本地会话原样透传。修复了远程会话换模型报 `session/not-found`（此前 `selectModel` 未被代理、穿透到本地 Host 找不到远程会话）。
- **消息续写与取消**：用户在远程会话界面发送消息或停止生成时，Client 端经由 Host 路由 `POST /remote-ssh/prompt` 与 `POST /remote-ssh/cancel` 转发至远端 `session/prompt`、`session/cancel`（子智能体路由到 `subagents/prompt`、`subagents/interruptByParent`），直接打通双向交互。
- **实时事件与打字机流**：Host 端提供 `GET /remote-ssh/session-follow` SSE 路由，连接远端 `/api/remote.mux` WebSocket 订阅 `session/follow`，将远端推送的事件增量与 assistant 打字机流实时中继到官方会话面板。
- **问答交互（`ask_user_question`）**：Host 端监听远端 WebSocket 的 `$events` 逻辑流，捕获模型发起的 `user-questions/request` 与取消事件，通过 `GET /remote-ssh/pending-interaction`、SSE 流实时分发以及 `POST /remote-ssh/interaction-respond` 提供应答通道；Client 端在 composer 输入区域就地挂载问答交互卡片（支持推荐徽标、单选/多选/自定义输入、跳过与提交），并接入 `uiSession.registerPendingInteraction` 驱动侧边栏待回答指示点，提交后调用远端 `$events/result` 解除工具挂起，形成双向交互闭环。
- **多远程主机池化与配置页面下拉添加**：内置 `RemoteHostManager` 与本地 OpenSSH 配置解析器（`ssh-config.ts`），自动读取本机 `~/.ssh/config` 中已配置 `IdentityFile` 密钥认证的有效主机条目，排除通配符与已添加主机；在客户端『设置』面板中自动挂载『远程主机聚合 (Remote SSH)』卡片，通过下拉框展示未添加的密钥主机，点击即可一键建立隧道连接、持久化至 `$DSH_HOME/remote-ssh-hosts.json` 并即时刷新工作区；收口 `/remote-ssh` 命令行，输入带参指令将直接提示前往设置页面操作。
- **主机与工作区管理体验优化**：
  - 侧边栏「自动化任务」下方的面板导航区保留「添加远程主机」全局按钮（与官方「插件」「自动化任务」面板行按钮同款样式：16px、1px 描边 Regular 图标，整行左对齐、文字完整显示），专职管理主机的连接与断开生命周期。
  - **远程主机工作区添加**：从全局弹窗剥离，沉降到各远程主机菜单行（`remote:<host>:hostroot`）的最右端。按钮采用官方 `IconProjectAddOutlineRegular` 风格纯图标，并在左下角附加微型地球仪角标（与远程工作区文件夹角标一致），点击弹出针对该主机的专属添加/新建目录浮层。
  - **本地工作区添加**：原样保留官方顶栏右侧原生「添加工作区」功能，避免跨组件强行挂载导致节点竞争崩溃与重复图标问题。
- **主机接入不硬编码**：`config.host` 可选；省略时 `RemoteHostManager` 启动为空，全部主机经上述添加机制动态接入并持久化到 `$DSH_HOME/remote-ssh-hosts.json`，重启自动恢复。
- 刷新：远程快照 60s 轮询（`POLL_INTERVAL_MS`），离开时移除注入行并恢复被代理的方法。

## 产物与构建

| 产物 | 来源 | 说明 |
|---|---|---|
| `lib/*.js` | `pnpm build`（tsc） | Host 半，原始 ESM，由 Node 加载 |
| `client.js` | **手工维护** | Client 半，必须是 DSH 闭包工厂产物 `window.__ModuleLoader__.load({ id, factory })`；`src/client/index.ts` 是它的类型真源 |

官方管线用 tsdown 的 `clientBundle` preset 从 `src/client/index.ts` 产出同形 client 产物；该 preset 需要 deepseek-harness monorepo 工具链，因此本仓库直接维护等价产物，改动行为时两者同步。契约由 `smoke-client-bundle.mjs` 守住。

`client.js` 不得发布为原始 ESM：浏览器会报 `SyntaxError: Unexpected token 'export'`，触发启动断言失败，进而让桌面执行 profile 恢复、**清空整个用户 patch 层**（见 `.agents/notes/implemented/architecture/2026-09-30-desktop-profile-integration.md`）。

## 桌面 profile 装配

**装到 home 层**，不要装到 profile 层：桌面应用会按自己的设置库重写 `profiles/<name>/cordis.patch.yml`，手写行随时可能被抹掉；`$DSH_HOME/cordis.patch.yml` 是独立的用户层（组合顺序：bundle → profile → home → `--patch`），应用不写它。

在 `$DSH_HOME/cordis.patch.yml` 写入（必须是 `- insert:`，写成顶层 `- id:` 会被静默跳过）。`host` 可省略——省略时启动不做主机预置，之后在侧边栏“添加远程主机”入口或『设置 -> 远程主机聚合』里一键添加并持久化：

```yaml
- insert:
    - id: remote-ssh
      name: "dsh-plugin-remote-ssh"
      config:
        remotePort: 3080
        localPort: 39387
```

包需在 profile 的 `node_modules` 下可解析（本地开发用 Junction 指向包目录）。

## limitations

- 仅支持通过 OpenSSH 密钥免密登录的主机配置（如 `~/.ssh/config` 中带 `IdentityFile` 的 `Host` 块）；主机列表由该配置动态发现，无需在插件配置中预写主机别名。
- 动态添加的主机持久化到 `$DSH_HOME/remote-ssh-hosts.json`，可通过头部浮层/设置面板的“断开”操作移除（`POST /remote-ssh/remove-host`）；**配置预置（`config.host`）的主机断开后仅本会话失联，重启会按配置恢复**。连接失败的新主机不会持久化，可直接重试。
- 远端主机需已启动 `dsh web`（默认端口 `3080`）；建立隧道前插件会执行存活探测，未启动时禁止连接并返回明确错误提示，不擅自在远端自启后台进程（见 `.agents/notes/implemented/feature/2026-10-02-enforce-remote-dsh-and-add-home-workspaces.md`）。
- `/remote-ssh/*` 路由由本地 webserver 直接服务，**不经过 `/api` 的浏览器鉴权围栏**：本机任意进程可读该 JSON/SSE；若把 webserver 绑到非回环地址，网络侧同样可读（只读、默认回环绑定）。详见 `.agents/notes/implemented/architecture/2026-10-01-reuse-official-workspace-session-ui.md`。
- `client.js` 为手工产物，无 sourcemap（扫描器容忍缺失）。
