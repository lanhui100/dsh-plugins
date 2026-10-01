# dsh-plugins

> DeepSeek Harness 远程 SSH 工作区连接与实例聚合插件集合（Cordis 插件，TypeScript）。

## 文档家（每个事实一个家）

- 文档标准 / tier 分类 / 写作规则：`docs/AGENTS.md`（agent 自动加载）
- 决策记录（ADR）：`.agents/notes/`
- 本 README：人读契约（config / semantics / limitations）

## 现状

- `packages/dsh-plugin-remote-ssh`（已落地）：经 SSH 隧道聚合远程 DSH 实例的工作区与会话到本地 UI（方案 B）。
  - SSH 隧道自动维护与重连 (`tunnel.ts`)
  - 远端进程 Token 读取与 authority 绑定 Cookie 自动置换，隧道就绪即预热 (`remote.ts`)
  - 远端 `/api/session/list` 会话聚合 + 按 cwd 归并成"远程工作区" (`sessions.ts`)
  - 对话输入框 `/remote-ssh` 人类命令（`inject = ['commands']`）(`command.ts`)
  - 只读面板数据路由 `GET /remote-ssh/sessions` 与 `GET /remote-ssh/session`（可选注入 `webServer`）(`route.ts`, `session-detail.ts`)
  - 「远程工作区: \<host\>」面板：`sidebar.panellist` 图标 + `main` 面板，左侧展示远程工作区树（带搜索/折叠），右侧展示选中会话的真实历史对话记录与目标状态，DSH 闭包工厂产物 (`client.js`，手工维护；`src/client/index.ts` 为类型真源)

## 快速开始与验证

1. 构建与冒烟：
   ```bash
   pnpm --filter dsh-plugin-remote-ssh build
   node packages/dsh-plugin-remote-ssh/smoke-client-bundle.mjs   # Client 半契约（panel + icon）
   node packages/dsh-plugin-remote-ssh/smoke-host-apply.mjs      # Host 入口契约（命令 + 路由）
   node packages/dsh-plugin-remote-ssh/smoke-route.mjs           # 面板数据（走已就绪隧道）
   node packages/dsh-plugin-remote-ssh/smoke-command-live.mjs    # /remote-ssh 端到端（自建隧道）
   ```
2. 本地 Desktop 挂载：写入 **home 层** `$DSH_HOME/cordis.patch.yml`（**不要写 profile 层**——桌面应用会按自己的设置库重写 `profiles/<name>/cordis.patch.yml`，手写行会被抹掉）。必须是 `- insert:`，顶层 `- id:` 会被静默跳过：
   ```yaml
   - insert:
       - id: remote-ssh
         name: "dsh-plugin-remote-ssh"
         config:
           host: "dev"
           remotePort: 3080
           localPort: 39387
   ```
   包需在 profile 的 `node_modules` 下可解析（本地用 Junction 指向包目录）。

> 警告：客户端条目激活失败会让桌面执行 profile 恢复并**清空整个用户 patch 层**（含 `ui-theme`、`llm-pi-ai` 等手写行）。改 `client.js` 后先跑 `smoke-client-bundle.mjs`。详见 [`.agents/notes/implemented/architecture/2026-09-30-desktop-profile-integration.md`](.agents/notes/implemented/architecture/2026-09-30-desktop-profile-integration.md)。
