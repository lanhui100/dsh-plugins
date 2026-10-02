# Agent Note: Add remote SSH host from local config

Status: implemented

## Problem

此前 `dsh-plugin-remote-ssh` 仅支持在启动配置中静态声明单个远程主机（如 `dev`）。用户若想挂载机器上配置好的其他远程实例，无法通过 UI 完成，且手动输入 IP、端口和私钥容易出现拼写错误与安全隐患。用户明确要求：
1. 增加添加远程功能，前提是本机已经设置了远程密钥 SSH 配置，添加操作仅需从本地 SSH 配置中已经设置密钥连接的主机中选择未添加的某一个主机；
2. 不要使用 `/remote-ssh` 命令，改为在配置页面中增加一个添加远程主机的选项，使用下拉列表获取当前未加入的远程主机。

## Decision

- **本地 SSH 配置发现 (`src/ssh-config.ts`)**：实现对用户系统 OpenSSH 配置文件（`~/.ssh/config`）的跨平台解析器，精准提取配置了 `IdentityFile` 且非通配符的有效 Host 块（包含别名、目标 HostName、端口与用户名），提供 `getAvailableSshHosts` 过滤排除当前已添加的主机，得到安全的未添加候选列表。
- **多远程主机池化管理 (`src/manager.ts`)**：构建 `RemoteHostManager`，负责统一管理多套 `SshTunnel` 隧道与 `RemoteCaller` 客户端。初始加载静态配置的主机，支持动态调用 `addHost` 分配空闲端口、启动隧道握手并预热 Cookie。动态添加的主机轻量持久化至 `$DSH_HOME/remote-ssh-hosts.json`，重启时自动恢复连接。
- **聚合会话与精准路由 (`src/route.ts`)**：
  - `GET /remote-ssh/available-hosts`：提供已连接主机及未添加的密钥主机列表查询。
  - `POST /remote-ssh/add-host`：接收待添加主机名，校验后执行动态隧道启动与池化注册。
  - `GET /remote-ssh/sessions`：并发汇总所有就绪远程主机的工作区与会话快照，统一通过 `namespaceRemoteId(host, id)` 打上主机命名空间。
  - 单会话路由（raw、prompt、cancel、follow、archive 等）：统一由 `resolveSessionTarget` 根据 session 所属的 host 路由到对应主机的 Caller。
- **配置页面下拉卡片挂载 (`client.js`)**：
  - 在客户端设置弹窗（`VOzbGW_options` / `VOzbGW_panel` / `div[role="tabpanel"]`）挂载时，自动注入 `#dsh-remote-settings-card`。
  - 卡片内提供已连接主机状态徽章列表，以及“添加远程主机”下拉框（`.dsh-remote-host-select`）与“添加主机”按钮（`.dsh-remote-btn-add-host`）。
  - 下拉框动态从 `GET /remote-ssh/available-hosts` 拉取本机 `~/.ssh/config` 中已配置密钥且尚未添加的主机；点击添加后调用 `POST /remote-ssh/add-host` 并触发 `reconcileRemoteSource(ctx)` 刷新工作区。
- **命令行引导收口 (`src/command.ts`)**：
  - 弱化命令入口，禁止通过命令行添加主机；若用户输入 `/remote-ssh add` 等参数，直接提示前往客户端『设置 -> 远程主机聚合』页面操作。

## Alternatives considered

- **让用户在 UI 中手动输入 IP、端口、用户与私钥文本**：被否决。配置繁琐，极易输错，且在客户端暴露私钥文本存在巨大安全风险，与用户“根据本地已配置密钥连接的主机选择”要求相悖。
- **通过聊天框命令 `/remote-ssh add <host>` 添加**：被否决。用户明确指出“不要使用 /remote-ssh 命令，改为配置页面中增加一个添加远程主机的选项，使用下拉来获取当前未加入的远程主机”，保持图形化配置页面的单一职责与直觉交互。
- **直接改写 `$DSH_HOME/cordis.patch.yml` 添加新条目**：被否决。YAML 文本包含注释和桌面专用 patch 层结构，程序化无损重写脆弱；采用专门的 `$DSH_HOME/remote-ssh-hosts.json` 记录动态主机，启动时与 primary 配置合并，更为稳健。
- **单主机切换模式而非多主机并发聚合**：被否决。切换模式会导致上一台机器的实时 stream/interaction 断连，无法在侧边栏同时管理多个服务器的会话。

## Consequences

- 本机 `~/.ssh/config` 中所有配置了密钥的主机均能被插件秒级发现，并在设置面板的下拉列表中清晰可见。
- 用户无需记忆或在对话框中输入任何命令行指令，一键即可添加远程主机，会话与工作区自动同步。
- 动态添加的主机重启后自动重新连接并聚合，保持多主机持久状态。
- 多主机之间工作区与会话互不冲突，单会话操作按主机维度精准分流。
