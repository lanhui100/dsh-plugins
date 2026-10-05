# Agent Note: Remote attachment interceptor for host file inputs

Status: implemented

## Problem

远程会话里点 composer 的 `+` → 文件、或把本机文件拖进输入框时，桌面端默认逻辑经 `hostPathBridge` 把非图片文件转成本地 `@"C:\..."` 路径引用。远端 Linux 模型够不着这条本机路径，文件实际发不出去——远程会话的附件入口形同虚设（图片 base64 内联与 fileUploads receiptId 通道本身是通的，见 2026-10-05-remote-session-attachments）。

## Decision

Client 端新增 `installRemoteAttachmentInterceptor` + `ensureFileCommandForRemoteSessions`（`packages/dsh-plugin-remote-ssh/client.js` 实现，`src/client/index.ts` 同步类型真源声明），只对远程会话 id 生效：

- 捕获 composer 内的 `<input type="file">` change 与 drop/dragover 事件，`stopImmediatePropagation` + `preventDefault` 拦掉默认的路径引用转换，经 `conversation.createDrafts()` 建草稿再 `shell.addAttachments()` 挂载，走既有隧道上传通道。
- 补齐 `+` 命令菜单的 `file` 命令在远程会话下的 `available`（远程恒为 true）与 `ui.run`（优先调原实现拉起文件选择器，失败则回退到直接点击 composer 内 input）。
- apply 时安装、teardown 时经 disposer 恢复监听器与命令补丁；本地会话全程透传，不受影响。`smoke-client-bundle.mjs` 覆盖 `file` 命令在远程可用 / 本地策略保留的断言（曾因拦截器内 `ensureFileCommandForRemoteSessions` 未被调用导致冒烟失败，修复后全绿）。

## Alternatives considered

- 只修上传层（`installFileUploadProxy`）：拦不住，Blob/File 类文件在到达 upload 前就被转成了路径文本，upload 根本收不到文件对象；落选。
- 全局拦截所有会话的文件选择：会改变本地会话既有行为（本地路径引用是合法功能）；落选。拦截器以 `isRemote(sessionId)` 为闸。
- 让用户手动把文件先传到远端再引用远端路径：把成本转嫁给用户，且 composer 交互断裂；落选。

## Consequences

- 远程会话的 `+` 加文件与拖拽投递可用，文件经隧道上传远端暂存区并绑定会话；本地会话行为不变。
- `src/client/index.ts` 的 `installRemoteAttachmentInterceptor` 目前是类型真源占位（空实现），真实逻辑在手工维护的 `client.js`；改行为时两者同步，契约由 `smoke-client-bundle.mjs` 守住（既有 client.js 手工产物约定）。
