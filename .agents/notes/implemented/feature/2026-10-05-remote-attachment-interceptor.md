# Agent Note: Remote attachment interceptor for host file inputs

Status: implemented

## Problem

远程主机会话的附件与加号交互存在两个致命缺口，导致用户完全无法通过加号菜单添加宿主机文件：

1. **点击 `+` 加号面板不出现（崩溃）**：官方加号菜单弹出时，需要调用 `this.directory.ensureReady(sessionId)`，进而调用 `ctx.remote.commands.list(sessionId)`。此前插件未代理 `ctx.remote.commands`，导致远程会话请求穿透到本地 DSH Host，本地报 `session/not-found`，抛出未捕获异常导致加号菜单弹出面板直接崩溃、无法显示。
2. **桌面端路径引用误判**：即便文件选择器被拉起、或把本机文件拖进输入框时，桌面端默认逻辑经 `hostPathBridge`（`electron.webUtils.getPathForFile`）把非图片文件直接转成了本地绝对路径引用 `@"C:\..."` 文本插入输入框，而非进入 `uploads` 附件草稿栏。远端 Linux 模型够不着宿主机路径，文件实际发不出去。

## Decision

1. **Host 端新增命令代理路由**：
   - 注册 `POST /remote-ssh/commands-list`（`SESSION_COMMANDS_LIST_ROUTE`）与 `POST /remote-ssh/commands-execute`（`SESSION_COMMANDS_EXECUTE_ROUTE`）。
   - `list` 经隧道调用远端 `commands/list`（wire 参数 `{ agentId: sessionId }`），若远端未就绪或报错则优雅降级返回 `{ ok: true, value: [] }`，彻底杜绝加号菜单因远程命令拉取失败而崩溃。
   - `RemoteCaller` 补齐 `listRemoteCommands` 与 `executeRemoteCommand` helper。
2. **Client 端代理包装 `ctx.remote.commands`**：
   - 新增 `installCommandsProxy`，拦截 `list` 与 `execute` 方法，命中远程会话时走隧道路由，本地会话原样透传。
   - `exports.inject` 增加声明 `'remote.commands'`。
3. **拦截宿主机文件输入并转为附件上传**：
   - Client 端新增 `installRemoteAttachmentInterceptor` + `ensureFileCommandForRemoteSessions`：
   - 捕获 composer 内的 `<input type="file">` change 与 drop/dragover 事件，`stopImmediatePropagation` + `preventDefault` 拦掉默认的路径引用转换，经 `conversation.createDrafts()` 建草稿再 `shell.addAttachments()` 挂载，走既有隧道上传通道。
   - 确保 `+` 命令菜单的 `file` 命令在远程会话下的 `available` 恒为 true，点击优先拉起原生文件选择器，失败回退触发 composer 隐藏 file input。
   - apply 时安装、teardown 时经 disposer 恢复监听器与命令补丁；本地会话全程透传，不受影响。

## Alternatives considered

- **另加独立回形针按钮避开加号菜单**：被否决。加号按钮是官方输入栏的标准交互，额外加按钮不仅割裂界面，且治标不治本（无法解决加号菜单自身在远程会话下点击报错崩溃的问题）。必须修复加号菜单本身。
- **只修上传层（`installFileUploadProxy`）**：拦不住，Blob/File 类文件在到达 upload 前就被转成了路径文本，upload 根本收不到文件对象；落选。
- **全局拦截所有会话的文件选择**：会改变本地会话既有行为（本地路径引用是合法功能）；落选。拦截器以 `isRemote(sessionId)` 为闸。
- **让用户手动把文件先传到远端再引用远端路径**：把成本转嫁给用户，且 composer 交互断裂；落选。

## Consequences

- 远程会话点击加号 `+` 号按钮，面板正常顺畅弹出，其中的「文件」命令（回形针图标）常驻可用。
- 点击加号里的「文件」拉起宿主机原生文件选择框，选择的文件（或拖拽的文件）在输入框上方渲染出附件卡片，并在后台通过隧道上传远端暂存区绑定会话，远端模型正常读取。
- 全套冒烟测试（13 项用例）全部通过。
