# Agent Note: 远端会话附件接通——attachment 读取 + fileUploads 上传经隧道转发

Status: implemented

## Problem

远程主机会话的附件链路有四个缺口，用户无法在远端会话里正常使用宿主机附件：

1. **读取缺接**：官方会话管道在渲染历史消息中的图片时调用 `ctx.remote.session.attachment({ sessionId, attachmentId })`，插件 client 代理对远程 id 直接返回「尚未接通」错误，历史图片无法回显。
2. **通用文件上传缺接**：官方 composer 为非图片文件创建草稿时立即调用 `ctx.fileUpload.upload(sessionId, file, name)`——`Blob` 分支直接 POST 到**本地** `/api/session/uploadFileBinary`，本地 Host 不认识远程 `remote:*` 会话 id，上传失败；即使走 `Uint8Array` 分支的 `ctx.remote.fileUploads.upload`，同样未被代理而穿透到本地。
3. **receiptId 错配**：即便上传成功，receiptId 也绑定在本地 `fileUploads` 服务上，远端 `session/prompt` 的 `resolvePromptFileReceipts` 找不到对应 staged file，`{type:"file", receiptId}` 会被拒（`session/attachment-invalid`）。
4. **桌面端路径引用误判**：桌面端原生逻辑使用 `hostPathBridge`（`electron.webUtils.getPathForFile`）获取宿主机路径；用户点击输入框原生「+」加号菜单选择「文件」（或拖拽宿主机文件）时，非图片文件被官方代码直接转换为了本地路径引用文本 `@"C:\..."`，而非进入 `uploads` 附件草稿栏；远端 Linux 机器找不到 Windows 宿主机路径，导致无法读取。

图片本身（`{type:"image", mediaType, data}` base64）随 prompt content 内联经 `POST /remote-ssh/prompt` 转发，无格式缺口。

## Decision

1. **Host 端新增两个隧道路由**（`src/route.ts` + `src/index.ts` 导出常量）：
   - `POST /remote-ssh/attachment`（`SESSION_ATTACHMENT_ROUTE`）：按 `{sessionId, attachmentId}` 调用远端 `session/attachment`，回传 `{attachment, data}`。
   - `POST /remote-ssh/file-upload`（`SESSION_FILE_UPLOAD_ROUTE`）：按 `{sessionId, data, name?}` 调用远端 `fileUploads/upload`（wire 参数 `{agentId: sessionId, request}`），回传 `{receiptId, file}`。
   - 路由实现对齐既有 select-model/rename 路由：`resolveTarget` 路由到正确主机，caller 缺失返回 503 `tunnel-not-ready`，缺参 400，错误 200 `{ok:false, error:{message}}`。
2. **RemoteCaller 新增两个 helper**（`src/remote.ts`）：`readRemoteAttachment(sessionId, attachmentId, signal?)` 与 `uploadRemoteFile(sessionId, request, signal?)`，分别 invoke `session/attachment` 与 `fileUploads/upload`。
3. **Client 端接通 `attachment` 代理**（`client.js` + `src/client/index.ts` 镜像）：远程 id → `POST /remote-ssh/attachment`，返回 `{ok, value:{attachment, data}}`；本地 id 透传。
4. **Client 端新增 `installFileUploadProxy`**：
   - 包装 `ctx.fileUpload.upload`：远程 id 时把 `Blob/File` 经 `arrayBuffer()` 编码为 base64（`Uint8Array` 直接编码），POST `/remote-ssh/file-upload`，返回 `{ok, value:{receiptId, file:{attachmentId,name,bytes}}}`；本地 id 完全透传。
   - 同时包装 `ctx.remote.fileUploads.upload`：远程 id 时 POST 同一路由；防御 `ctx.remote.fileUploads` 缺失的场景。
   - apply 安装、teardown 经 disposer 恢复（`src/client/index.ts` 的 vite 镜像同步）。
   - `exports.inject` 增加 `'fileUpload'`（桌面端 `dsh-web-app` 已含 `dsh-client-file-upload` 服务，依赖方显式声明）。
5. **坚持使用官方原生加号按钮与加号菜单**：
   - 不另加多余的外部独立按钮，保持与官方本地会话 100% 一致的加号（`+`）菜单交互。
   - `ensureFileCommandForRemoteSessions`：在 `commandUi` 贡献层确保 `file` 命令在远程会话中始终 `available`，点击时唤起宿主机原生文件选择框。
   - `installRemoteAttachmentInterceptor`：在 DOM 捕获阶段拦截远程会话的 `<input type="file">` `change` 与 `drop` 事件，阻止官方逻辑将宿主机路径错误转为 `@"C:\..."` 路径引用；直接调用 `conversation.createDrafts` + `shell.addAttachments`，将宿主机选中的任何文件转化为输入框上方真实的附件草稿，并自动通过隧道异步上传至远端暂存区。
6. **进度回调近似**：浏览器将 Blob 一次性转 base64，无法提供逐字节进度，上传完成后补发一次 `onProgress({loaded, total})`；reconnecting/aborted 语义沿用官方 AbortSignal，路由层按 signal 取消 fetch。
7. **测试**：`smoke-client-bundle.mjs` 增加 attachment 读取转发、file-upload 转发、加号菜单 `file` 选项常驻断言与本地透传断言，既有 13 个 smoke 用例全量回归通过。

## Alternatives considered

- **另加一个独立的回形针附件按钮**：被否决。官方在输入框设计了加号按钮（`+`）承载 `/file` 附件入口；额外增加按钮破坏了与原生界面的一致性。坚持使用原汁原味的加号按钮。
- **让远端 `fileUploads/upload` 直接消费本地 HTTP 路由**：`ctx.fileUpload` 的 Blob 分支 POST 到本地 `/api/session/uploadFileBinary`，该路由由本地 Host 的 FileUploads 服务处理，agent 作用域解析只认本地会话 id，远程 id 无法解析。被否决。
- **浏览器端直连远端 DSH web 服务上传文件**：绕过统一的 Host 隧道（cookie/token/多主机路由/SSE 复用），鉴权状态与本地 Host 不一致，也失去 SSH 隧道的唯一入站优势。被否决。
- **把文件字节顺道塞进 `session/prompt` content**：标准 content 只接受 base64 image 与 receiptId 形态的 file，通用文件必须走 fileUploads 的 receiptId 机制；改协议面伤害官方客户端契约。被否决。
- **仍用 `ctx.remote.fileUploads.upload` 但不动 `ctx.fileUpload`**：官方 composer 传的是 `File`（Blob）而非 base64，stock 实现走 HTTP 路径，包装远程命名空间无法拦截 Blob 分支。被否决。
- **图片附件也改走 file-upload 通道**：图片在官方设计里随 prompt content base64 内联，已有完整链路；额外上传是重复劳动。图片坚持内联、文件走 receiptId。未采纳。

## Consequences

- 远程会话现在可以添加附件：图片以 base64 随 prompt 投递，通用文件经隧道上传远端暂存区并通过 receiptId 绑定到远端会话，composer 官方草稿/上传/提示整链路透明可用。
- 远程会话历史中的图片附件可回显：`attachment` 代理接通为 `/remote-ssh/attachment` 转发 `session/attachment` 的真实数据。
- `exports.inject` 新增 `fileUpload`，桌面端官方组合（`dsh-web-app`）已提供该服务；非官方 profile 若缺失，插件激活即失败（Cordis 契约），与现有 `remote` 等注入声明同一为对齐原则。
- 既有 smoke 门禁全部通过（`pnpm --filter dsh-plugin-remote-ssh test`：client-bundle、create-reuse、host-apply、manager、multi-host、ssh-config、question-card、settings-ui、workspace-btn、archive-multi、command、launcher、performance）。
