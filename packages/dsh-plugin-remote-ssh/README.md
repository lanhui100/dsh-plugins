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
- Host 端挂载 `RemoteSshService`（Typert Remote）暴露 `listSessions` 接口，并向 Host 命令系统注册 `/remote-ssh` 人令（在对话输入框中输入即可列出远端会话）。
- Client 端在 `sidebar.footer.action` 注入远程主机状态按钮（指示灯 + 主机标签），支持点击交互。

## limitations

- 仅支持通过 OpenSSH 密钥免密登录的主机配置（如 `~/.ssh/config` 中的 `Host dev`）。
- 远端 DSH 需要启动为 `dsh web` 模式并保留日志（默认 `/tmp/dsh-web.log`）。
