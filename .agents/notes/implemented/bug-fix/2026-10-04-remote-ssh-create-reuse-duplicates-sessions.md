# Agent Note: fix remote-ssh create reuse duplicating the original session

Status: implemented

## Problem

在远程工作区点击「新会话」会**重复复制原有的空白会话**：每次点击都会在远端
真实多出一份新会话，且新会话的 id 是插件命名空间化字符串的再命名空间形态
（`remote:dev:session-…` → `remote:dev:remote%3Adev%3Asession-…` → 逐层加深），
会话树随之堆叠出原会话的一串"副本"。已在线上实测复现（3 次点击各新增 1 份，
前缀逐层加深），并在远端 `~/.dsh/sessions/*/remote~003Adev~003A*` 找到用户真实
使用留下的 4 处垃圾会话目录（含 `ponyllm` 下原会话与其双命名空间副本成对存在）。

根因链路：

1. 官方前端 `uiWorkspace.reuseOrCreateBlank`（`dsh-client-ui-workspace`）会先
   复用工作区里最近的空白会话：`ctx.sessions.create({ workspaceId, sessionId })`。
   插件把远程会话标成 `blank: true`，因此远程工作区几乎总是走复用分支，传入的
   `sessionId` 是插件命名空间化后的 id（`remote:<host>:<encodedId>`）。
2. `client.js` 的 `ctx.remote.session.create` 拦截器把请求原样转发到
   `/remote-ssh/create`。
3. `route.ts` 的 create 处理器只还原了 `workspaceId`（见
   [2026-10-02-fix-remote-workspace-session-creation](file:///D:/Documents/dsh-plugins/.agents/notes/implemented/bug-fix/2026-10-02-fix-remote-workspace-session-creation.md)），
   但 `body.sessionId` 被原样拼进远端请求 `{ workspaceId, sessionId }`。
4. 远端 `session/create`（`createOrAdopt`）查不到这个命名空间 id，于是把
   **命名空间字符串本身当作真实 id 新建会话**——原空白会话并未被复用，新副本
   每点击一次多一份；副本又是最新空白，下一次复用它就再加深一层命名空间。

其它会话路由（`page`/`prompt`/`cancel`/`rename`/`archive` 等）都经
`resolveTarget(raw).originalSessionId` 还原 id，唯独 create 遗漏。

## Decision

1. **Host 端（`src/route.ts`）create 处理器还原 `sessionId`**：转发前用
   `resolveTarget(rawSessionId).originalSessionId` 解码命名空间 id（与
   page/prompt/cancel/rename 同一还原路径）；命中已存在的远端空白 id 时远端按
   id 幂等 adopt（真正复用），未命中时以原始 uuid 新建。无 `sessionId` 的新建
   请求行为不变。
2. **`resolveTarget` legacy 单 caller 分支补齐命名空间解码**：此前只有
   `RemoteHostManager` 分支解码；legacy 分支原样返回导致同一缺陷在单 caller
   模式下依旧存在。两分支现共用同一解码逻辑（`remote:` 前缀 → split 第 3 段起
   join + `decodeURIComponent`，恰好还原单层与多层命名空间）。
3. **Client 端（`client.js`）复用 upsert 去重**：复用 adopt 返回的 id 可能已
   在 `workspace.sessionIds` 中，预插前先 `filter(id => id !== newSessionId)`，
   防止官方树把同一会话渲染成两行（本地工作区同样受益）。
4. **回归测试**：新增 `smoke-create-reuse.mjs`（fake caller、零网络、零远端
   变更）断言 create 转发的 `sessionId` 为还原后的远端 id（含单层/多层命名空间
   与 raw 透传、无 id 时不携带字段）；`smoke-client-bundle.mjs` 增补复用去重
   断言；`package.json` 的 `test` 门禁链加入 `smoke-create-reuse.mjs`。
5. **文档同步**：README 增补「新建会话与空白会话复用」语义条目（same-commit）。

## Alternatives considered

1. **在 `client.js` 代理里剥离命名空间再转发**：可行但会重复实现 id 解码，且
   legacy/manager 两种模式的解码语义应归 Host 单点负责（与其它会话路由一致）；
   若只改 client，绕过代理直连路由的消费方仍会踩同一缺陷。
2. **让远端复用路径彻底不传 `sessionId`（总是新建）**：违背官方
   `reuseOrCreateBlank` 的复用契约，空白会话会无限堆积（正是本次缺陷的另一半
   表象）；正确语义是"复用真正生效"。
3. **只修 manager 分支、不动 legacy `resolveTarget`**：legacy 单 caller 模式下
   缺陷依旧存在，且 id 解码逻辑散落两处；统一解码后再返回更稳。

## Consequences

- 远程工作区点击「新会话」：命中空白会话 → 真正复用（远端 id 幂等 adopt，不新增
  目录）；无空白 → 以原始 uuid 新建。会话树不再堆叠命名空间副本。
- 远端已生成的 `remote~003Adev~003A*` 垃圾会话目录可安全删除（删除后对应
  UI 行随下一次 60s 轮询消失）；本文诊断期间产生的复现目录已清理。
- `smoke-create-reuse.mjs` 进入 `pnpm --filter dsh-plugin-remote-ssh test` 门禁，
  此类回归将再次被机器捕获。
