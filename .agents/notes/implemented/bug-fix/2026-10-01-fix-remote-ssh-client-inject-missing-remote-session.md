# Agent Note: Fix remote-ssh client missing remote.session in inject list causing desktop web-boot crash

Status: implemented

## Problem

在提交 `aceb54e`（对应 ADR [.agents/notes/implemented/architecture/2026-10-01-reuse-official-workspace-session-ui.md](file:///D:/Documents/dsh-plugins/.agents/notes/implemented/architecture/2026-10-01-reuse-official-workspace-session-ui.md)）落地后，桌面端 DeepSeek Harness 启动直接崩溃并退出。日志 `crash-...-web-boot.log` 记录：
```
Error: web boot: 1 entry did not activate
dsh-plugin-remote-ssh: failed
```
经源码分析与本地 Cordis 运行复现，根因为：`dsh-plugin-remote-ssh` 的客户端入口 `packages/dsh-plugin-remote-ssh/client.js` 和 `src/client/index.ts` 声明的 `inject` 为 `['workspaces', 'sessions', 'remote']`，漏掉了 `'remote.session'`。

在 Cordis 4 框架下，命名空间服务（如 `remote.session`）关联在 `remote` 上，当执行 `installSessionProxy(ctx)` 内部的 `ctx.remote.session` 时，Context Proxy 检查当前插件 Fiber 的注入声明；由于缺少 `'remote.session'`，直接抛出 `Error: cannot get property "remote.session" without inject`。由于该异常在 `apply` 阶段同步抛出且未捕获，导致插件 Fiber 状态进入 `FAILED`（FiberState.FAILED = 3），前端引导器 `JS(e)` 将其判定为激活失败并向上报致命错误，致使桌面端主进程终止应用。

此外，原有的契约测试 `smoke-client-bundle.mjs` 使用了纯 JavaScript 字面量对象模拟 `ctx`，绕过了 Cordis 真实的 Context 属性代理访问检查，导致此前该缺失未能被冒烟测试拦截。

## Decision

1. **补全客户端服务注入声明**：
   - 在 `packages/dsh-plugin-remote-ssh/src/client/index.ts` 中将 `'remote.session'` 添加至 `inject` 数组及 Context 类型扩展中；
   - 在 `packages/dsh-plugin-remote-ssh/client.js` 中将 `exports.inject` 更新为 `['workspaces', 'sessions', 'remote', 'remote.session']`。
2. **测试加固（真实 Cordis 冒烟环境）**：
   - 改造 `packages/dsh-plugin-remote-ssh/smoke-client-bundle.mjs`，引入真实的 `@deepseek-ai/cordis` 实例来装载与运行 `clientExports.apply`，严格暴露任何未声明 service 的属性访问；
   - 显式断言 `clientExports.inject` 必须包含 `'remote.session'`；检查插件 Fiber 运行状态及 `_error`，杜绝未来类似漏填注入导致的静默崩溃。

## Alternatives considered

- **在 `installSessionProxy` 中做 try/catch 降级**：
  若 catch 掉 `cannot get property "remote.session" without inject` 错误，插件虽然能完成空加载，但代理会话流全部失效，用户点击远程会话将无法唤起远端记录。正确解法是在 Cordis 层明确声明所依赖的服务 `'remote.session'`。
- **沿用字面量 mock 并在测试里手动检查所有属性**：
  手动列举易遗漏，无法保证与 Cordis 框架内部 Context Proxy / tracker.associate 的行为一致。直接在测试中使用真实 Cordis `Context` 实例进行生命周期驱动是最可靠防线。

## Consequences

- 修复后桌面端 DeepSeek Harness 正常启动，web-boot 阶段所有插件正常激活，零崩溃日志生成。
- 契约测试 `smoke-client-bundle.mjs` 具备对缺失服务声明的非零退出阻断能力。
- 类型检查 `pnpm run typecheck` 和构建 `pnpm run build` 全部通过。
