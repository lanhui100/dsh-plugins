# Agent Note: Desktop profile integration via insert patches and cross-instance tolerance

Status: implemented

## Problem

本地桌面版重启后，`dsh-plugin-remote-ssh` 的 Host 半未加载：`sidebar.footer.action` 无按钮、`/remote-ssh` 命令不存在。需要定位桌面 profile 的插件装配语义并修复。

## Decision

- 装配通道：桌面 Host 走标准 `loadProfileDirectory` + `runProfile`，读取 `cordis.patch.yml`（`PROFILE_PATCH_FILENAME`）。但该文件的顶层条目是 `PatchOptions`：`- id:` + `config:` 是 **id-targeted override**（`applyEntryPatches` 对树中不存在的 id 仅 warn 并跳过），**新增插件必须用 `- insert:` 列表**。已修正为 `- insert: [{ id: remote-ssh, name: dsh-plugin-remote-ssh, config: {...} }]`。
- 依赖实例：插件包解析到的 `@deepseek-ai/cordis` 副本与桌面 Host（app.asar 内）的 cordis 可能是不同模块实例，`TypertRemoteService` 的 `ctx.plugin()` 挂载可能失败。已将 Typert 挂载改为 `tryMountRemoteSshService` 容错兜底（失败仅 warn），`/remote-ssh` 命令与 SSH 隧道作为不依赖 Typert 的核心路径。
- Client 半（`sidebar.footer.action` 按钮）依赖 tsdown 构建的 `window.__ModuleLoader__.load` 格式 client bundle，当前仅有 tsc 产物（普通 ESM），静态 Client bundle 构建留待具备 monorepo 构建链的环境完成；可用动态插件（cordis_define / host.call）演示同等 UI。

## Alternatives considered

- 把 `remote-ssh` 条目写成顶层 `- id:`（override 形态）：对不存在 id 被静默跳过，不生效；落选（已实证）。
- 让插件强依赖 Typert 挂载成功：跨实例失败会整体破坏 apply；落选，降级为容错。

## Consequences

- 重启桌面后 `/remote-ssh` 命令可用（无需 Typert），隧道自动建立。
- Client 半 UI 需额外 client bundle 构建链；在具备 deepseek-harness 构建环境的机器上补 `tsdown.config.ts`（`clientBundle` preset）后产出 `lib/client.js`。
