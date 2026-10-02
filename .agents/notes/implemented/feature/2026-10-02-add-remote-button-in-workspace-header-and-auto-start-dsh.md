# Agent Note: Add remote button in workspace header and auto start DSH service

Status: implemented

## Problem

此前添加远程主机需要进入客户端『设置』面板底部的配置卡片，操作路径较深，用户在工作区侧边栏树浏览时无法直观、快捷地添加新的远程实例。
同时，用户在添加远程主机时经常面临远端服务器尚未运行 `dsh web` 服务的情况。此前若服务未启动，虽然本地隧道能建立，但后续获取 Token 和拉取工作区时会遭遇连接被拒绝（ECONNREFUSED）报错，用户必须手动开启新的终端 SSH 登录远端服务器、定位项目目录并手动执行命令拉起服务，交互流程极其繁琐割裂。
用户明确要求：
1. 在侧边栏工作区的搜索图标前增加一个添加远程的语义图标，点击弹窗展示本机已在 `~/.ssh/config` 中配置好密钥连接但尚未添加的远程机器列表；
2. 点击列表中某台主机执行添加时，需检查该主机上是否有 dsh 启动的服务；如未启动则自动找到 `deepseek-harness` 文件夹运行 `dsh web`，待服务就绪后再连接；如已启动则直接连接。

## Decision

- **工作区头部挂载快捷语义图标 (`client.js`)**：
  - 官方侧边栏工作区头部 DOM 容器为 `div[class*="sectionHeader"]`，内部包含标签 `span[class*="sectionLabel"]` 与搜索区域 `div[class*="searchSlot"]`。
  - 通过 `findWorkspaceSearchSlot()` 精准定位，在其父容器中插入位于 `searchSlot` 前的 `#dsh-add-remote-workspace-btn` 按钮，内嵌服务器加号（Server with Plus）语义 SVG 图标，视觉样式与官方原生工具图标完全对齐。
- **快捷浮层弹窗交互 (`client.js`)**：
  - 点击按钮展开 `#dsh-add-remote-popover` 浮层卡片；
  - 浮层就地请求 `GET /remote-ssh/available-hosts` 获取未添加的密钥主机列表；
  - 点击某台主机项右侧的『添加』按钮，触发 `POST /remote-ssh/add-host`；按钮与反馈区展示『正在检测远端服务并建立隧道...』；
  - 收到成功响应后（展示是否自动拉起服务），即时调用 `reconcileRemoteSource(ctx)` 将新主机的工作区与会话聚合到官方侧边栏树，并在 900ms 后自动关闭弹窗；
  - 支持外部点击关闭（`handleOutsideClick` 进行防御性 `contains` 校验）与右上角关闭按钮，并在生命周期卸载时完全清理。
- **远端服务探测与自动拉起模块 (`src/remote-launcher.ts`)**：
  - 构建 `RemoteLauncher` 类：
    - `checkStatus(host, port)`：通过 SSH 远程组合执行 `ss -tlnH`、`netstat -tlpn`、`lsof -iTCP` 与 `curl -s -f` 快速探测指定端口是否有 HTTP/TCP 监听，超时 4 秒。
    - `findHarnessPath(host)`：优先按顺序检查常见部署路径（`$HOME/deepseek-harness`、`$HOME/work/deepseek-harness`、`/data/deepseek-harness`、`/opt/deepseek-harness` 等），若未命中则通过带深度和超时限制的 `find` 以及 `which dsh` 进行兜底检索。
    - `ensureService(host, port)`：若端口已就绪，返回 `autoStarted: false`；若未启动，定位到 harness 目录后在远端以 `nohup ... dsh web --port <port> > /tmp/dsh-web.log 2>&1 &` 脱机后台拉起，并每秒轮询一次端口状态（最多等待 15 秒）直至就绪，返回 `autoStarted: true`。
- **多主机管理器与入口联动 (`src/manager.ts` & `src/index.ts`)**：
  - `RemoteHostManager` 引入 `RemoteLauncher`，在 `startHost` 拉起 SSH 端口转发隧道前调用 `launcher.ensureService(host, remotePort)`，打通“探测/启动 -> 隧道建立 -> Token 获取与预热 -> 会话聚合”的全自动闭环。
  - 在 `src/index.ts` 导出 `RemoteLauncher` 与对应接口定义，支持外部依赖注入与单测模拟。

## Alternatives considered

- **强依赖用户在远端手动启动 `dsh web`**：被否决。远端常因机器重启、休眠或服务崩溃处于未启动状态，强行要求用户手动在外部命令行启动严重破坏了一键连接的体验。
- **前台长连接执行 `dsh web`**：被否决。前台进程挂在当前 SSH session 上容易因网络波动断开而收到 SIGHUP 退出，且无法与端口转发隧道复用连接；采用 `nohup ... &` 后台常驻并轮询端口探测更为稳定可靠。
- **全屏 Modal 对话框代替浮层 Popover**：被否决。全屏 Modal 会遮蔽侧边栏的工作区与会话层级，破坏上下文感知；轻量 Popover 挂靠在工作区标题栏附近，视觉更加聚焦且不打断操作流。
- **在聊天框中使用 `/remote-ssh` 命令传参添加**：被否决。用户明确拒绝聊天框命令行交互，指定在工作区搜索图标前挂载原生体验的图标与弹窗。

## Consequences

- 工作区侧边栏新增了显式、便捷的“添加远程”快捷入口，用户无需离开主界面进入设置即可添加主机。
- 真正实现“零手工终端操作”：只要远端机器配置了 SSH 密钥认证并拥有 harness 环境，插件即可全自动检查并拉起服务、建立隧道并完成工作区挂载。
- 弹窗包含详尽的状态反馈与错误提示，交互清晰直观。
- 全套单元测试与端到端 smoke 测试 100% 验证通过。
