# Agent Note: Desktop profile integration via insert patches and a hand-shipped client bundle

Status: implemented

## Problem

本地桌面版加载 `dsh-plugin-remote-ssh` 时启动失败并**禁用了插件**（用户 patch 层被清空）。需要定位桌面 profile 的装配语义、Client 半的产物格式要求，以及"禁用"这一动作的确切机制。

## Decision

- **装配通道**：桌面 Host 走标准 `loadProfileDirectory` + `runProfile`，读取 `cordis.patch.yml`（`PROFILE_PATCH_FILENAME`）。该文件顶层是 `PatchOptions`：`- id:` + `config:` 是 **id-targeted override**（`applyEntryPatches` 对树中不存在的 id 仅 `warn` 并跳过），**新增插件必须写成 `- insert:` 列表**。
- **装配层选择**：`readProfilePatches` 的组合顺序是 bundle → profile 的 `cordis.patch.yml` → **`$DSH_HOME/cordis.patch.yml`（home 层）** → `--patch` 覆盖。桌面应用按自己的设置库重写 **profile 层**，因此手写条目只放 **home 层**——它不与任何应用设置写入冲突。
- **Client 半产物格式**：浏览器端模块系统是"惰性 CJS 表"。client 入口必须是闭包工厂产物 `window.__ModuleLoader__.load({ id, factory: (require) => {…} })`，`exports.apply` / `exports.inject` 是插件面。原始 ESM（`export function apply`）会在浏览器报 `SyntaxError: Unexpected token 'export'`。本仓库**手工维护** `client.js`（官方管线用 tsdown 的 `clientBundle` preset 从 `src/client/index.ts` 产出同形产物；该 preset 需要 deepseek-harness monorepo 工具链）。`exports["./client"].default` 指向它，`types` 仍取 tsc 产物。
- **不声明 `dsh.client.inject` 包行边**：插件只依赖基线模块表的 `react` 与 `slots` 服务；包行边一旦未按时到达会让条目 pending 而再次触发启动失败。槽位声明顺序由 `ctx.slots.inject` 在运行时等待，不需要包边。
- **Host 入口必须声明 `inject`**：`apply` 里访问 `ctx.commands` 前，入口须 `export const inject = ['commands']`。Cordis 在激活前解析注入；缺声明时 `ctx.commands` 访问抛错 → 条目永不激活（实测：条目在树里、Client 半却已活跃、而 Host 侧隧道进程从未生成）。
- **移除 Typert Remote 挂载**：Client 半当前不消费它，而任何 Host 侧挂载失败都可能连带触发 profile 恢复、清空用户 patch 层。删除 `src/service.ts`、其依赖 `@deepseek-ai/dsh-typert-protocol` 与冒烟脚本。**恢复条件**：当 Client 半需要实时远端会话数据时再加回——届时须显式声明所需的 Typert 服务 `inject`，并以"失败不得影响条目激活"的形态挂载（不随 Client 首次渲染而崩）。

## Alternatives considered

- 顶层 `- id:` override 形态新增插件：对不存在 id 被静默跳过，不生效；落选（已实证：Host 完全没看到条目）。
- 用 `lib/client/index.js`（tsc 的 ESM 产物）当 client 入口：浏览器语法错误 → 启动断言失败 → 触发 profile 恢复清空用户 patch 层；落选（已实证）。
- 强依赖 Typert 挂载成功：跨实例失败会连带破坏 apply，且 Client 半当前并不消费它；落选，已整体移除并立法恢复条件。
- Host 入口不声明 `inject` 而直接访问 `ctx.commands`：实测条目在树中但 Host 侧从不激活（隧道进程从未生成）；落选。

## Consequences

- **危险机制（须记住）**：任一客户端条目激活失败会让 Web 启动断言抛错，桌面随即执行 `sanitizeProfile`——把 `cordis.patch.yml` **整体改名备份**（`.bak-<epoch-ms>`）并只保留恢复 bundles，随后应用按自己的设置库重写该文件。这会连带丢弃用户手写的 `ui-theme`、`llm-pi-ai` 等行，不只是失败的那一条。
- 因此 client 半必须一次加载成功；本仓库以 `client.js` 的手工产物 + 契约冒烟（`smoke-client-bundle.mjs`）守住这一点。
- 恢复路径：`.bak-<epoch-ms>` 是完整快照；`cordis.patch.yml` 的 `- insert:` 片段见包 README。
