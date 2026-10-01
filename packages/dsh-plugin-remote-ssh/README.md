# dsh-plugin-remote-ssh

> 经 SSH 隧道把远端 DSH 实例的工作区与会话聚合到本地 UI（方案 B）。

## config

| 键 | 含义 | 默认 |
|---|---|---|
| `host` | OpenSSH 主机别名（含用户/密钥/known-hosts 配置） | 必填 |
| `remotePort` | 隧道远端的 DSH web 端口 | `3080` |
| `localPort` | 本地回环转发端口 | `39387` |

## semantics

- 本地 Host 端持有 `ssh -N -o ExitOnForwardFailure=yes -o BatchMode=yes -L <localPort>:127.0.0.1:<remotePort> <host>` 隧道子进程，负责就绪探测、保活与指数退避重连。
- 自动经 SSH 读取远端 `dsh web` 启动日志的 `?token=`，经隧道 `GET /?token=...` 换取 authority 绑定的会话 Cookie，并在 401 时自动重新换取。
- **响应性**：隧道就绪即预热 Cookie（`caller.warmup()`），首次 `/remote-ssh` 跳过 SSH+token 往返（实测预热 ~1s + 列表 ~2s）；所有远端 fetch 有 30s 截止（`requestTimeoutMs`），取消信号从命令直传 RPC，杜绝无限挂起。
- 经隧道调用远端 `/api/session/list`（携带换取的 Cookie 与 `_request` 参数信封），拉取远端全部会话（包括标题、运行状态、工作目录 cwd）。
- Host 入口声明 `inject = ['commands']`（Cordis 在激活前解析服务；缺声明会让 `ctx.commands` 访问抛错、条目永不激活，在桌面还会连带清空用户 patch 层）。
- Host 端注册 `/remote-ssh` 人令（在对话输入框输入即可列出远端会话）。
- **完整复用官方 UI（零自定义界面）**：Client 半不注册任何槽位/面板/侧边栏。Host 注册只读路由 `GET /remote-ssh/sessions`（按 cwd 聚合的工作区与会话快照）、`GET /remote-ssh/session?id=...`（人性化详情）与 `GET /remote-ssh/session-raw?id=...`（原始 wire 事件，供官方会话管道直接消费）。
- **注入官方模型**：Client 端把远程工作区/会话 upsert 进 `ctx.workspaces.list`（`upsertView`）与 `ctx.sessions`（`handleSessionAdded`），因此远程工作区直接出现在官方 `WorkspaceBrowser` 侧边栏树里——官方文件夹折叠/展开、会话行、状态点、右键菜单全部原样生效。
- **代理会话流**：Client 端包装 `ctx.remote.session` 的 `page` / `follow` / `projections` / `prompt` / `cancel` / `rename` / `attachment`；命中已知远程会话 id 时从隧道路由应答，本地会话原样穿透。点击侧边栏远程会话即走官方 `openSession` → 官方 `ui-conversation` 用远程原始事件组装官方消息流。
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

在 `$DSH_HOME/cordis.patch.yml` 写入（必须是 `- insert:`，写成顶层 `- id:` 会被静默跳过）：

```yaml
- insert:
    - id: remote-ssh
      name: "dsh-plugin-remote-ssh"
      config:
        host: "dev"
        remotePort: 3080
        localPort: 39387
```

包需在 profile 的 `node_modules` 下可解析（本地开发用 Junction 指向包目录）。

## limitations

- 仅支持通过 OpenSSH 密钥免密登录的主机配置（如 `~/.ssh/config` 中的 `Host dev`）。
- 远端 DSH 需要启动为 `dsh web` 模式并保留日志（默认 `/tmp/dsh-web.log`）。
- 远端会话当前为**只读查看**：官方会话区完整渲染远程历史对话、工具调用与目标；继续发送消息（`session/prompt`）、停止、重命名与图片读取尚未接通（代理对远程 id 返回明确的"未接通"错误）。
- `/remote-ssh/sessions`、`/remote-ssh/session` 与 `/remote-ssh/session-raw` 由本地 webserver 直接服务，**不经过 `/api` 的浏览器鉴权围栏**：本机任意进程可读该 JSON；若把 webserver 绑到非回环地址，网络侧同样可读（只读、默认回环绑定）。详见 `.agents/notes/implemented/architecture/2026-10-01-reuse-official-workspace-session-ui.md`。
- 远程会话 `follow` 流当前以静态快照打开（历史可见、无实时增量）；实时增量需在后续里程碑转发远程 follow 流本身。
- `client.js` 为手工产物，无 sourcemap（扫描器容忍缺失）。
