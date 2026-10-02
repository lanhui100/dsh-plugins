# Agent Note: Refine remote workspace add button in workspace header

Status: implemented

## Problem

工作区侧边栏头部的“添加远程工作区”按钮存在以下体验与实现问题（用户逐条提出）：

1. 按钮插入位置在官方 `sectionHeader` 中搜索图标（`searchSlot`）之前，但未使用官方 `iconButton` 的 28×28 尺寸与对齐方式，与搜索、视图选项、新建工作区等原生图标按钮在右侧簇与垂直中心上不一致，观感偏离；
2. 按钮 tooltip 使用原生 HTML `title` 属性，与官方图标按钮（React `Tooltip`，`side: "bottom"`、`delayMs: 500`、暗色气泡）不一致；
3. 点击按钮展开的浮层中，每台主机的“添加”是带文字的常规按钮（`dsw-button dsw-button--primary`），不是极简纯图标按钮，与官方 icon-only 图标按钮风格不符；
4. 点击“添加”后的连接过程只有反馈文字（“连接中...”），没有 loading 状态；成功提示是浮层内的小段文字而非官方 Toast（顶部居中、深色气泡、成功绿勾、自动淡出）；
5. 启动配置中 `host` 字段把首台主机（如 `dev`）硬编码进 `cordis.patch.yml`，主机接入应统一走“添加远程主机”机制（`GET /remote-ssh/available-hosts` + `POST /remote-ssh/add-host` + 持久化），而非启动配置预置。

## Decision

- **按钮对齐与样式 (client.js)**：将按钮定位逻辑改为：优先在 `sectionHeader` 中搜索图标（`[class*="searchSlot"]`）左侧插入；无搜索插槽（rail 窄栏模式）时作为 `[class*="headerActions"]` 首个子项插入（右侧操作簇），兜底追加到 `sectionHeader`。按钮样式完全镜像官方 `iconButton`：`width/height: 28px`、`border-radius: var(--dsw-radius-sm)`、`color: var(--dsw-alias-label-secondary)`、hover `var(--dsw-alias-interactive-bg-hover)`、focus-visible 官方描边；去掉自定义 `margin-right`，间距由官方 `sectionHeader` 的 `gap: 4px` 承担，从而与右侧图标簇右侧对齐、垂直居中对齐。
- **tooltip 官方化 (client.js)**：移除原生 `title` 属性，改为插件内 vanilla 复刻官方 `Tooltip` 行为：`side: "bottom"`（气泡 `top = anchor.bottom + 8`，`left = anchor 水平中心`，`transform: translateX(-50%)`，视口边缘 clamp + 下方放不下时翻转到上方）、hover 延迟 500ms、`role="tooltip"`、气泡样式逐条镜像官方 `Tooltip.module.css`（`background: var(--dsw-alias-tooltip-bg)`、`color: var(--dsw-static-neutral-bluish-00)`、`13px/20px`、`padding: 3px 7px`、`radius-sm`、`tooltip-in 150ms` 动画），鼠标移出/失焦/点击即撤下。
- **浮层内添加按钮改纯图标 (client.js)**：`.dsh-remote-popover-item-btn` 由文字按钮改为 28×28 纯图标按钮，内嵌官方 `IconPlusOutlineRegular`（16×16，`M8 2V14` + `M2 8H14`）SVG，`aria-label` 标注“添加主机 <host>”，样式同官方 `iconButton`（hover 背景、focus 描边），去掉 `dsw-button dsw-button--primary`。
- **loading 与官方 Toast (client.js)**：点击添加后按钮进入 loading 态（禁用 + `aria-busy` + 旋转 spinner 替换图标），等待 `POST /remote-ssh/add-host` 返回；成功后在 `document.body` 渲染官方样式 Toast（`role="alert"`、顶部居中 `top: 40px`、`--dsh-toast-hold` 驱动 `dsh-toast-*` 同款 keyframes、成功绿勾 `IconCheckCircleOutlineRegular`、深色气泡、自动淡出移除），文案为“主机 <host> 连接成功”并当 `autoStarted` 为真时追加“，并已在远端自动启动 dsh 服务”；随后触发 `reconcileRemoteSource(ctx)` 并关闭浮层。失败仍走浮层内错误反馈并可重试。
- **主机不再硬编码 (src/config.ts, src/manager.ts, src/route.ts)**：`Config.host` 改为可选（`host?: string`）；`RemoteHostManagerOptions.primaryHost` 可选，仅当非空才注册首台主机；`src/index.ts` 无需改动（`config.host` 类型放宽后 `primaryHost: config.host` 天然兼容）。动态主机继续走 `registerConfiguredHost`/`addHost` 持久化到 `$DSH_HOME/remote-ssh-hosts.json`，重启自动恢复。`ADD_HOST_ROUTE` 响应新增 `autoStarted`（远端 dsh 服务由 `RemoteLauncher.ensureService` 自动拉起时为真）与 `harnessPath`，供客户端 Toast 提示“已在该远程机器上启动 dsh 服务”。README 的挂载示例移除 `host: "dev"`，改为说明主机统一通过头部按钮/设置面板添加。
- **评审加固（对抗评审后同批落地）**：
  - 定位选择器以 `[class*="sectionHeader"]` 为作用域再找 `searchSlot`/`headerActions`，杜绝全局首个匹配被无关节点劫持（评审 P2-1）。
  - `startHost` 缓存 in-flight promise，`startAll()` 与并发重加同一主机共享一次隧道建立，避免同一 localPort 双隧道与 `entry.caller` 互踩（评审 P2-2）。
  - 新主机添加“先内存注册、连接成功后再持久化”，失败即移除内存条目，避免 UI 无法恢复的墓碑主机；已连接主机重加时 `autoStarted` 按本次动作语义返回 `false`（评审 P2-3 / A-P3）。
  - tooltip `show()` 对已脱离 DOM 的 anchor 直接返回，杜绝 500ms 延迟窗口内的幽灵气泡；成功关闭窗口内按钮保持 disabled；浮层关闭路径统一移除 outside-click 监听（评审 A-P2-1 / P3）。
  - 静态 smoke 套件聚合为 `pnpm --filter dsh-plugin-remote-ssh test` 门禁命令；smoke 增加 HTMLCollection 语义回归守卫、tooltip 行为与幽灵气泡断言、成功态 disabled/图标恢复断言、无 primaryHost + 持久化恢复断言（评审 P2-4/5/6/7）。
- **连接/断联语义与已连接主机管理（第二、三轮优化迭代，同批落地）**：
  - 浮层改为“已连接主机 / 可添加主机”两区：已连接主机始终展示，右侧为**断开图标按钮**（插头与插座左右分离、保留清晰间隙，不使用斜线或删除符号，active 蓝色 `--dsw-alias-state-business-primary`）；未连接主机右侧为**连接图标按钮**（插头双脚从左侧水平插入插座插孔并形成咬合式样），彻底去掉 “＋” 的“重新添加”语义。主机行带灰色圆角底（`--dsw-alias-bg-module-platform`）、hover 背景加深（`--dsw-alias-interactive-bg-hover`）。
  - Host 端新增 `RemoteHostManager.removeHost`（复用现有 dispose 链路，拒绝在 in-flight 连接期间移除）与 `POST /remote-ssh/remove-host` 路由；`GET /remote-ssh/available-hosts` 新增 `connectedHosts`（含 `~/.ssh/config` 详情的已连接主机），客户端断开成功后重取列表并刷新聚合。
  - 连接成功后按钮转为 active 蓝色成功图标（短暂态，随后浮层关闭）；`setAddBusy` 支持按按钮语义恢复图标（连接/断联各自还原）。
  - 面板间距收紧（主机行 `gap: 4px` → 后续再收紧至 `2px`、内边距 `6px → 4px`），hover 改为背景色变化（`--dsw-alias-interactive-bg-hover`），不再使用边框。
  - **容错响应解析与错误信息透传**：连接/断联/列表等所有 fetch 响应改走 `parseJsonResponse`（先 `text()` 后 `json()` 双通道、全程不抛），若响应为空（如未重启桌面端导致新路由未命中落入 405 静态 fallback）显示明确引导“服务端无响应，请重启桌面端后重试”；连接失败透传服务端的具体错误详情（而不是仅抛出 `add-failed` 状态码），且 `startHost` 不再因自动探查 harness 路径未果而过早放弃，允许后续 SSH 隧道尝试连接已存在的后台服务。

## Alternatives considered

- **继续使用原生 `title` 做 tooltip**：被否决。用户明确要求与官方图标按钮的 tooltip 实现一致；原生 title 无法匹配官方的暗色气泡、延迟、定位与动画。
- **在浮层保留文字按钮、仅改样式**：被否决。用户明确要求“极简的纯图标按钮”；文字按钮在窄浮层内占用宽度且与官方 icon-only 操作风格不符。
- **复用官方 React `Tooltip`/`Toast` 组件**：被否决。插件 client 是 vanilla DOM（closure-factory 格式），无 React 运行上下文；改为逐条镜像官方 CSS 变量与关键帧（`--dsw-alias-tooltip-bg`、`--dsw-alias-toast-bg`、`dsh-toast-in/fade` 同值 keyframes 用插件前缀命名避免冲突），视觉与交互 1:1 对齐且对官方构建哈希变化免疫。
- **保留 `config.host` 必填、把“dev”换成默认空串继续启动**：被否决。用户要求“不能硬编码”，改为可选配置 + 纯动态添加机制，启动配置不再隐含任何主机假设。
- **浮层成功提示沿用浮层内反馈文字**：被否决。用户明确要求“官方 toast 样式提醒连接成功”；浮层内文字无法表达全局级完成通知，且会被随后的浮层关闭带走。
- **继续使用 “＋” 图标作连接操作**：被否决。用户明确要求去掉“重新添加”语义，连接用官方链环图标；已连接主机用断联图标表达可断开状态。
- **已连接主机不在浮层展示 / 断联仅关隧道不清除注册**：被否决。用户要求已连接服务器也同面板展示并带断联操作；仅关隧道会让主机处于“既不在已连接区也不在可添加区”的纠缠态，采用完全移除（注册与持久化一并清除），配置预置主机重启时由配置恢复。

## Consequences

- 头部按钮与官方图标按钮在尺寸、颜色、hover、focus、垂直对齐与右侧簇位置完全一致，tooltip 呈现官方暗色气泡（底部、500ms 延迟）。
- 浮层内主机添加为纯图标按钮，点击后可见 loading 态；连接成功出现官方样式全局 Toast，并明确提示远端 dsh 服务是否被自动拉起。
- 不再需要把首台主机写入启动配置；主机接入全部经由统一添加机制，`host` 可选，既有静态首台主机配置仍兼容（提供 `host` 时行为不变）。
- 浮层面板同时呈现已连接与可添加主机：连接（插头插入插座、loading、active 蓝成功态、官方 Toast）与断开（分离的插头插座图标、`remove-host` 路由）形成双向闭环；配置预置主机断开后重启恢复，动态主机断开即移除可重新连接。
- 既有 smoke 套件（workspace-btn / settings-ui / manager / multi-host / route 等）保持通过，workspace-btn 与 manager smoke 增加对纯图标按钮、loading、Toast、无首台主机场景的断言；本轮再增已连接区/断联流程与 `connectedHosts`/`remove-host` 路由断言。
