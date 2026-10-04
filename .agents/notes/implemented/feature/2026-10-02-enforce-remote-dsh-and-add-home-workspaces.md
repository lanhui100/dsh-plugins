# Agent Note: Enforce remote DSH readiness and expose remote home workspaces

Status: implemented

## Problem

远程主机聚合目前会在远端 `dsh web` 未启动时尝试自动拉起服务并继续连接，无法满足“服务未启动则禁止连接”的明确契约；SSH 配置列表还会把 GitHub 这类代码托管配置误识别为远程主机。工作区侧边栏只依据会话 cwd 聚合，因此没有会话的远程工作区不可见，也无法从“添加远程工作区”入口选择 `~/` 下已有目录或创建新目录。

## Decision

- 连接远程主机前只执行远端 dsh 服务存活探测；探测不到监听服务时返回可读失败原因，不自动启动服务，客户端以失败 Toast 告知用户。
- SSH 配置发现排除 `github`、`github.com` 及其 `HostName` 为 GitHub 的条目，同时继续排除通配符和无 IdentityFile 条目。
- 远程 sessions 路由以远端 workspace baseline 为权威来源，即使工作区没有会话也投影为工作区行；baseline 缺失时保留一个服务器未知工作区占位，避免连接成功后侧边栏空白。
- 新增远程工作区候选与创建路由：仅暴露远端 `~/` 的一级目录；创建目标限制在 `~/` 下并通过 SSH `mkdir -p` 验证权限。客户端添加工作区浮层提供已存在目录选择和新建目录输入，失败以 Toast 告知原因。

## Alternatives considered

- **继续自动执行 `dsh web`**：被否决。用户要求服务未启动时禁止连接，自动启动会掩盖远端服务状态并造成不可预期的进程副作用。
- **仅按 session cwd 聚合工作区**：被否决。没有会话的已存在工作区会被隐藏，无法满足远程工作区浏览与添加需求。
- **允许任意远程绝对路径创建目录**：被否决。会扩大 SSH 操作范围；限制在 `~/` 下可将权限错误明确反馈并降低误操作风险。
- **在客户端自绘替代官方工作区树**：被否决。继续通过官方 workspace model 投影，以保留官方文件夹图标、折叠和交互语义。

## Consequences

连接流程不再替用户启动远程服务；用户需先启动 dsh web。远程工作区 baseline 的空会话项也会显示，目录创建权限由远端 SSH 结果决定。新增的远程目录路由与输入校验需要配套 smoke 测试。
