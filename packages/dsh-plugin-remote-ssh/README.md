# dsh-plugin-remote-ssh

> 经 SSH 隧道把远端 DSH 实例的工作区与会话聚合到本地 UI（方案 B）。

## config

| 键 | 含义 | 默认 |
|---|---|---|
| `host` | OpenSSH 主机别名（含用户/密钥/known-hosts 配置）。**可选**：省略时不做任何主机预置，远程主机统一通过工作区头部按钮/设置面板的“添加远程主机”机制动态接入并持久化 | 无 |
| `remotePort` | 隧道远端的 DSH web 端口 | `3080` |
| `localPort` | 本地回环转发端口 | `39387` |

> “不预置”仅指启动配置不再隐含主机；已通过 UI 添加并持久化到 `$DSH_HOME/remote-ssh-hosts.json` 的主机（含升级前静态 `dev` 遗留下来的条目）重启后仍会照常恢复连接。

## semantics

- 本地 Host 端持有 `ssh -N -o ExitOnForwardFailure=yes -o BatchMode=yes -L <localPort>:127.0.0.1:<remotePort> <host>` 隧道子进程，负责就绪探测、保活与指数退避重连。
- 自动经 SSH 读取远端 `dsh web` 启动日志的 `?token=`，经隧道 `GET /?token=...` 换取 authority 绑定的会话 Cookie，并在 401 时自动重新换取。
- **响应性**：隧道就绪即预热 Cookie（`caller.warmup()`），首次 `/remote-ssh` 跳过 SSH+token 往返（实测预热 ~1s + 列表 ~2s）；所有远端 fetch 有 30s 截止（`requestTimeoutMs`），取消信号从命令直传 RPC，杜绝无限挂起。
- 经隧道调用远端 `/api/session/list`（携带换取的 Cookie 与 `_request` 参数信封），拉取远端全部会话（包括标题、运行状态、工作目录 cwd）。
- Host 入口声明 `inject = ['commands']`（Cordis 在激活前解析服务；缺声明会让 `ctx.commands` 访问抛错、条目永不激活，在桌面还会连带清空用户 patch 层）。
- Client 入口声明 `inject = ['workspaces', 'sessions', 'remote', 'remote.session', 'remote.workspace']`（Cordis 严格校验 Context 属性访问权限；访问关联服务命名空间 `ctx.remote.session` 与 `ctx.remote.workspace` 必须显式声明，否则抛错导致桌面 web-boot 失败）。
- Host 端注册 `/remote-ssh` 人令（在对话输入框输入即可列出远端会话）。
- **完整复用官方 UI（零自定义界面）**：Client 半不注册任何槽位/面板/侧边栏。Host 注册只读路由 `GET /remote-ssh/sessions`（按 cwd 聚合的工作区与会话快照）、`GET /remote-ssh/session?id=...`（人性化详情）与 `GET /remote-ssh/session-raw?id=...`（原始 wire 事件，供官方会话管道直接消费）。
- **注入官方模型**：Client 端把远程工作区/会话 upsert 进 `ctx.workspaces.list`（`upsertView`）与 `ctx.sessions`（`handleSessionAdded`），因此远程工作区直接出现在官方 `WorkspaceBrowser` 侧边栏树里——官方文件夹折叠/展开、会话行、状态点、右键菜单全部原样生效。
- **代理会话流**：Client 端包装 `ctx.remote.session`（以及 `ctx.remote.subagents`）的 `page` / `follow` / `projections` / `prompt` / `cancel` / `rename` / `attachment`；命中已知远程会话 id 时从隧道路由应答，本地会话原样穿透。点击侧边栏远程会话即走官方 `openSession` → 官方 `ui-conversation` 用远程原始事件组装官方消息流。
- **会话操作代理（归档/置顶/重命名）**：Client 端拦截 `ctx.remote.workspace`（`archiveSession`, `unarchiveSession`, `pinSession`, `unpinSession`）与 `ctx.remote.session.rename`；命中已知远程会话时转发 Host 路由（`POST /remote-ssh/session-archive`、`session-unarchive`、`session-pin`、`session-unpin`、`session-rename`），并在本地与远端集合间执行双向隔离与合并，实时刷新官方 `WorkspaceBrowser` 树与会话标题；本地会话原样透传。多主机（`RemoteHostManager`）模式下操作响应与会话快照使用同一命名空间身份 `remote:<host>:<id>`，客户端按主机前缀合并远程归档/置顶集合并保留其它主机与本地状态；legacy 单 caller 保持原始 ID 行为。
- **消息续写与取消**：用户在远程会话界面发送消息或停止生成时，Client 端经由 Host 路由 `POST /remote-ssh/prompt` 与 `POST /remote-ssh/cancel` 转发至远端 `session/prompt`、`session/cancel`（子智能体路由到 `subagents/prompt`、`subagents/interruptByParent`），直接打通双向交互。
- **实时事件与打字机流**：Host 端提供 `GET /remote-ssh/session-follow` SSE 路由，连接远端 `/api/remote.mux` WebSocket 订阅 `session/follow`，将远端推送的事件增量与 assistant 打字机流实时中继到官方会话面板。
- **问答交互（`ask_user_question`）**：Host 端监听远端 WebSocket 的 `$events` 逻辑流，捕获模型发起的 `user-questions/request` 与取消事件，通过 `GET /remote-ssh/pending-interaction`、SSE 流实时分发以及 `POST /remote-ssh/interaction-respond` 提供应答通道；Client 端在 composer 输入区域就地挂载问答交互卡片（支持推荐徽标、单选/多选/自定义输入、跳过与提交），并接入 `uiSession.registerPendingInteraction` 驱动侧边栏待回答指示点，提交后调用远端 `$events/result` 解除工具挂起，形成双向交互闭环。
- **多远程主机池化与配置页面下拉添加**：内置 `RemoteHostManager` 与本地 OpenSSH 配置解析器（`ssh-config.ts`），自动读取本机 `~/.ssh/config` 中已配置 `IdentityFile` 密钥认证的有效主机条目，排除通配符与已添加主机；在客户端『设置』面板中自动挂载『远程主机聚合 (Remote SSH)』卡片，通过下拉框展示未添加的密钥主机，点击即可一键建立隧道连接、持久化至 `$DSH_HOME/remote-ssh-hosts.json` 并即时刷新工作区；收口 `/remote-ssh` 命令行，输入带参指令将直接提示前往设置页面操作。
- **工作区快捷添加与远端服务自动拉起**：在侧边栏工作区头部（`sectionHeader`）搜索图标左侧常驻“添加远程工作区”图标按钮（与官方 `iconButton` 完全同尺寸同样式，右侧操作簇内垂直对齐，tooltip 采用官方同款暗色气泡——底部、500ms 延迟），点击弹出浮层卡片，分为“已连接主机”与“可添加主机”两区（主机行间距紧凑、hover 为背景色变化）：已连接主机右侧为**断联图标按钮**（active 蓝色），点击即 `POST /remote-ssh/remove-host` 断开并移除（配置预置主机重启后会按配置恢复）；未连接主机右侧为**连接图标按钮**（官方链环图标，非 ＋ 的“重新添加”语义）。执行连接时按钮进入 loading 态（spinner），内置 `RemoteLauncher` 自动执行远端端口与服务状态探测：若远端已运行 `dsh web` 则直接建立隧道连接；若未运行，则自动在远端常见路径（`~`、`~/work`、`/data` 等）检索 `deepseek-harness` 目录或全局 `dsh` 二进制，并在后台以 `nohup dsh web --port 3080` 拉起服务，轮询等待就绪后完成隧道连接；成功后按钮以 active 蓝色展示连接成功图标，并弹出官方样式全局 Toast（顶部居中、成功绿勾、自动淡出），文案含“主机 <host> 连接成功”并在自动拉起时追加“并已在远端自动启动 dsh 服务”，随后刷新工作区聚合。
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

在 `$DSH_HOME/cordis.patch.yml` 写入（必须是 `- insert:`，写成顶层 `- id:` 会被静默跳过）。`host` 可省略——省略时启动不做主机预置，之后在工作区头部“添加远程工作区”按钮或『设置 -> 远程主机聚合』里一键添加并持久化：

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
- 远端主机需部署有 `deepseek-harness` 源码环境或安装有 `dsh`；若未启动，插件会在添加时自动探测并在后台启动 `dsh web`。
- 远端会话图片读取（`attachment`）尚未接通（代理返回明确未接通错误）。
- `/remote-ssh/*` 路由由本地 webserver 直接服务，**不经过 `/api` 的浏览器鉴权围栏**：本机任意进程可读该 JSON/SSE；若把 webserver 绑到非回环地址，网络侧同样可读（只读、默认回环绑定）。详见 `.agents/notes/implemented/architecture/2026-10-01-reuse-official-workspace-session-ui.md`。
- `client.js` 为手工产物，无 sourcemap（扫描器容忍缺失）。
