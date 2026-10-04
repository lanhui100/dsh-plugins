# Agent Note: Fix host-root folding hiding local workspaces and unify the add-remote sidebar button

Status: implemented

## Problem

用户报告 `packages/dsh-plugin-remote-ssh/client.js` 两处显示缺陷：

1. 侧边栏「自动化任务」下方的「添加远程主机」按钮与官方「插件」「自动化任务」面板行按钮样式不一致：图标描边偏粗、垂直对齐错位、「添加远程主机」文字被遮蔽显示不全。
2. 工作区树中「本地」一栏在展开自家折叠后消失，必须展开远程主机（`dev`）的折叠才重新显示。

根因（对照官方 WorkspaceBrowser 源码与 `SidebarRoot.module.css`）：

- Bug 1：按钮同时挂 `dsh-btn-add-remote-workspace`（28×28 旧图标按钮样式，含 `width/height/padding/display/flex` 等布局属性）与 `dsh-panel-row-btn`（整行按钮样式）两个类；前者在注入样式表中定义更晚且优先级相同，覆盖后者的行布局属性，把按钮压成 28×28 小方块——整行文字溢出被裁，图标描边 1.2/1.3px 也粗于官方面板 Regular 图标的 1px。
- Bug 2：`installStyles()` 注入的折叠规则 `div[class*="groupSection"]:has(div[data-row-key$=":hostroot"]:not([aria-expanded="true"])) ~ div[class*="groupSection"]:has(div[data-row-key^="workspace:"]:not([data-row-key$=":hostroot"]))` 是**泛化的兄弟折叠规则**：只要前面任一 hostroot（默认即折叠）可匹配 `:has()`，其后任意含“非 hostroot 工作区行后代”的兄弟 groupSection 都会被 `display: none !important`。工作区树（`workspace-tree`）模式下「本地」hostroot 节正是 `dev` hostroot 节的后续兄弟，展开后其内部出现本地工作区行 → 整节被隐藏；展开 `dev` 使前置 `:has()` 失配后才重现。`syncHostFoldingStyles()` 生成的按主机折叠规则同理存在误伤风险。

## Decision

- **Bug 1（按钮样式统一）**：
  - 按钮只保留 `dsh-panel-row-btn` 一个类；删除冲突类 `dsh-btn-add-remote-workspace` 及其全部 CSS（`.dsh-btn-add-remote-workspace`、`:hover`、`:focus-visible`）。按钮现按官方 `panelRow` 布局渲染：`min-height:36px`、`margin:0 2px`、`padding:7px 8px`、`gap:8px`、`align-items:center`、`line-height:22px`（`margin` 由 `0 2px 2px` 校正为官方 `0 2px`）。
  - 图标统一为官方面板 glyph 规格：16×16（对应用户侧栏展开态 `size: wide ? 16 : 18`）、`stroke-width="1"`（官方 `IconPluginPinwheelOutlineRegular` / `IconClockOutlineRegular` 同款 Regular 描边），仍包在 `flex:none` 居中的 `span.dsh-panel-row-glyph` 容器内。
- **Bug 2（删除 CSS 兄弟折叠，回归原生折叠）**：删除全部基于 `:has()` + `~` 的兄弟折叠 CSS——`installStyles()` 内的静态规则，以及 `syncHostFoldingStyles()` 的动态规则（后者改为 no-op，并清空已注入的 `FOLDING_STYLE_ID` style 标签）。工作区树模式下 hostroot 折叠/展开由官方原生机制承担：`renderGroup` 仅在 `group.expanded` 时渲染子节，`groupExpansion[key] ?? ancestorKeys.has(key)` 决定默认展开，无需也无权再用 CSS 隐藏兄弟节。
- **测试固化**：`smoke-workspace-btn.mjs` 新增 2d–2f 回归断言：按钮 `className` 必须恰为 `dsh-panel-row-btn`；源码不得再出现 `dsh-btn-add-remote-workspace`；glyph 必须 16×16 viewBox 且按钮模板内不得出现 `stroke-width="1.2/1.3"`；不得再出现 `div[class*="groupSection"]:has(div[data-row-key$=":hostroot"]` 兄弟折叠规则；`syncHostFoldingStyles` 内不得再注入 `display: none !important`。

## Alternatives considered

- **保留 `dsh-btn-add-remote-workspace`，仅靠样式顺序/优先级调整规避覆盖**：留下两个样式源长期共存，任一未来改动都可能再触发同优先级覆盖；直接删除冲突类、收敛到单一 `panelRow` 适配才是根除。
- **给旧的折叠规则打补丁（如为「本地」加 `workspace:local:hostroot` 专属规则）**：只是给误伤规则打补丁；工作区树模式下官方已原生折叠，泛化兄弟 CSS 规则没有存在必要，且未来 DOM 结构再变仍可能误伤。语义正确的收敛是删除。
- **保留 CSS 折叠但仅对非树模式生效**：插件 `ensureWorkspaceTreeMode()` 强制 `workspace-tree` 分组，非树模式不可达，保留死分支只增加维护面。

## Consequences

- 「添加远程主机」与「插件」「自动化任务」行按钮外观一致：1px 描边 16px 图标、整行左对齐、文字完整显示。
- 「本地」与各远程主机各自独立折叠互不干扰：折叠 `dev` 不再隐藏「本地」；展开「本地」后本地工作区即时可见。
- `syncHostFoldingStyles(hosts)` 签名保留（调用点不变）但无副作用；`FOLDING_STYLE_ID` 不再残留旧规则。
- 与旧设计记录的关系：`2026-10-03-remote-host-first-level-workspace-folders.md` 中“折叠用声明式 `:has()/~` CSS 控制”部分被本修复取代（该条已链回）；host 文件夹、图标 `::after` mask、panel 行按钮等其余设计不变。按钮样式沿革另见 `2026-10-02-refine-remote-workspace-add-button.md`。README 同步更新按钮位置描述（侧边栏面板入口，非工作区头部）。
- 检验：`pnpm --filter dsh-plugin-remote-ssh test`（11 个 smoke 脚本，含新增 2d–2f 回归）全部通过。