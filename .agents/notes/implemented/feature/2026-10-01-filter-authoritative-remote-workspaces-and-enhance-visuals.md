# Agent Note: Filter authoritative remote workspaces, integrate archived filter, and enhance workspace visuals

Status: implemented

## Problem

在远程工作区整合至官方侧边栏后，用户提出了以下三点体验与功能缺陷：
1. **工作区命名与图标不符合预期**：
   - 远程工作区前缀使用了硬编码的“远程”二字，占用宝贵视宽且不够直观；
   - 期望格式为 `<远程主机名（bold，过长截断）> + : + <工作区文件夹名称>`；
   - 官方侧边栏使用的是普通文件夹图标，缺乏远程环境的视觉元素标识。
2. **已删除工作区未被剔除**：
   - 远程 DSH 历史上累积了数千个会话（位于 `~/.dsh/sessions/`），原插件 Host 端单纯按会话记录中的历史 `cwd` 粗暴分组，导致远端早被物理删除或已弃用的孤立工作区也被推送到前端侧边栏，形成干扰。
3. **已归档会话全量暴露**：
   - 远端存在 2121 个已归档会话，但此前 Host 端未透传归档集合，Client 端也未与官方 `ctx.workspaces.list.archivedSessionIds` 联动，导致侧边栏不论在何种视图选项下都将所有归档会话当成活跃会话展示。

## Decision

1. **Host 端通过 WebSocket 提取权威 Baseline**：
   - 在 `RemoteCaller` 中实现 `fetchWorkspaceBaseline()`，通过隧道向远端 WebSocket `/api/remote.mux` 发送 `workspace/follow` 流订阅，获取远端权威 `baseline`（包含真实存在的 10 个工作区 `items` 以及 2122 个 `archivedSessionIds`），结果在内存中做 30 秒短时缓存；
   - 在 `sessions.ts` 的 `groupSessionsByWorkspace` 中引入权威路径白名单映射 `validWorkspaces`，严格剔除不在权威列表中的孤立旧目录，并保留远端配置的自定义标题；
   - 在 `GET /remote-ssh/sessions` 路由中将 `archivedSessionIds`、`pinnedSessionIds` 与清洗后的 `workspaces` 一并下发。
2. **Client 端工作区命名与加粗视觉**：
   - 移除“远程 ”前缀，格式严格调整为 `${displayHost} : ${ws.name}`；
   - 主机名通过 `formatHostLabel` 在超过 14 字符时以 `…` 优雅截断；
   - 在客户端模型中保持 `workspace.title` 为纯字符串，确保官方 `labelOf(summary).toLowerCase()` 搜索不报错；
   - 通过微型样式与 `MutationObserver` 在 DOM 层将标题的主机名部分转为 `<strong class="dsh-remote-host-prefix">` 粗体展示。
3. **文件夹图标增添远程元素**：
   - 注入微型样式规则，在 `div[data-row-key^="workspace:remote:"] span[class*="folder"]` 的伪元素 `::after` 上叠加醒目的微型无线/天线 Badge 角标，与官方文件夹的展开/闭合 SVG 动画和谐共存。
4. **原生对接官方工作区视图选项**：
   - Client 端维护 `remoteArchivedSessionIds` 集合；
   - 通过 `syncArchivedSessions` 将远程归档 ID 动态合并到 `ctx.workspaces.list.archivedSessionIds` 中；
   - 在 `installWorkspaceGuardian` 中同时包装官方模型的 `replaceBaseline` 与 `replaceArchived`，保障远程归档状态在官方状态重置或变更时不被冲刷；
   - 官方侧边栏的“隐藏已归档”、“显示已归档”、“仅显示已归档”原生且实时对远程会话及工作区生效。
5. **远程主机搜索与筛选**：
   - 标题前缀统一包含主机名，用户在侧边栏顶部搜索框直接输入主机名（如 `dev` 或 `dev:`）即可原生精准筛选该主机下的全部工作区与会话。

## Alternatives considered

- **在 Host 端仅执行 `ssh test -d <path>` 逐个检测目录**：
  被否。逐个 SSH 探查网络开销大、效率低，且无法获取用户在远端 DSH 中显式删除的工作区状态，更无法感知远端会话的归档标记；直接通过 `workspace/follow` 订阅官方 Baseline 是权威真源。
- **直接将 React 节点传入 `workspace.title`**：
  被否。官方搜索逻辑 `labelOf(summary).toLowerCase()` 要求标题必须是字符串，传入 JSX 节点会在用户搜索时触发 `toLowerCase is not a function` 导致应用闪退。采用“纯字符串模型 + DOM 层样式/strong 装饰”既安全又满足视觉需求。
- **自定义侧边栏 Tab 独立展示远程工作区**：
  被否。违背用户“在侧边栏复用工作区”的根本诉求，且破坏了官方折叠树、拖拽排序与视图过滤的统一体验。

## Consequences

- 远端已删除的工作区彻底从侧边栏消失，只保留远端真实的活跃工作区；
- 2122 个远端已归档会话不再淹没侧边栏，跟随官方视图选项（默认隐藏）一键切换；
- 远程工作区以 `<主机名> : <文件夹名>` 呈现，主机名醒目加粗，图标带有精致的远程天线角标；
- 契约冒烟测试完整覆盖了标题格式、归档状态合并与官方 baseline 冲刷防回归。
