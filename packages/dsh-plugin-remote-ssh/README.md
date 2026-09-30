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
- 经隧道调用远端 `/api/session/list`（携带换取的 Cookie 与 `_request` 参数信封），拉取远端全部会话（包括标题、运行状态、工作目录 cwd）。
- Host 端按需挂载 `RemoteSshService`（Typert Remote）暴露 `listSessions`；跨 cordis 实例时该挂载降级为警告，不影响命令与隧道。
- Host 端注册 `/remote-ssh` 人令（在对话输入框输入即可列出远端会话），这是不依赖 Typert 的核心路径。

## 产物与构建

| 产物 | 来源 | 说明 |
|---|---|---|
| `lib/*.js` | `pnpm build`（tsc） | Host 半，原始 ESM，由 Node 加载 |
| `client.js` | **手工维护** | Client 半，必须是 DSH 闭包工厂产物 `window.__ModuleLoader__.load({ id, factory })`；`src/client/index.ts` 是它的类型真源 |

官方管线用 tsdown 的 `clientBundle` preset 从 `src/client/index.ts` 产出同形 client 产物；该 preset 需要 deepseek-harness monorepo 工具链，因此本仓库直接维护等价产物，改动行为时两者同步。契约由 `smoke-client-bundle.mjs` 守住。

`client.js` 不得发布为原始 ESM：浏览器会报 `SyntaxError: Unexpected token 'export'`，触发启动断言失败，进而让桌面执行 profile 恢复、**清空整个用户 patch 层**（见 `.agents/notes/implemented/architecture/2026-09-30-desktop-profile-integration.md`）。

## 桌面 profile 装配

在 `$DSH_HOME/profiles/<name>/cordis.patch.yml` 末尾追加（必须是 `- insert:`，写成顶层 `- id:` 会被静默跳过）：

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
- 远端会话为**只读列表**：点击远端会话打开/交互尚未实现。
- `client.js` 为手工产物，无 sourcemap（扫描器容忍缺失）。
