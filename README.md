# dsh-plugins

> DeepSeek Harness 远程 SSH 工作区连接与实例聚合插件集合（Cordis 插件，TypeScript）。

## 文档家（每个事实一个家）

- 文档标准 / tier 分类 / 写作规则：`docs/AGENTS.md`（agent 自动加载）
- 决策记录（ADR）：`.agents/notes/`
- 本 README：人读契约（config / semantics / limitations）

## 现状

- `packages/dsh-plugin-remote-ssh`（已落地）：经 SSH 隧道聚合远程 DSH 实例的工作区与会话到本地 UI（方案 B）。
  - SSH 隧道自动维护与重连 (`tunnel.ts`)
  - 远端进程 Token 读取与 authority 绑定 Cookie 自动置换 (`remote.ts`)
  - 远端 `/api/session/list` 会话聚合与模型投影提取 (`sessions.ts`)
  - Host 端 Typert 远程服务 `RemoteSshService` (`service.ts`)
  - 对话输入框 `/remote-ssh` 人类命令 (`command.ts`)
  - Client 侧边栏底部状态与动作按钮注入 (`src/client/index.ts`)

## 快速开始与验证

1. 启动远端测试或冒烟：
   ```bash
   pnpm --filter dsh-plugin-remote-ssh build
   node scripts/smoke-remote-sessions.mjs
   ```
2. 本地 Desktop 桌面端挂载配置（在 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 中追加）：
   ```yaml
   - id: remote-ssh
     name: "dsh-plugin-remote-ssh"
     config:
       host: "dev"
       remotePort: 3080
       localPort: 39387
   ```
