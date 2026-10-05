# Agent Note: Proxy remote workspace files for sidebar document preview and tree

Status: implemented

## Problem
In DeepSeek Harness Web GUI, clicking a workspace file or conversation deliverable in a remote session requests the `dsh-resource://file/session/<sessionId>/<path>` resource. The client file provider and sidebar preview (`ui-sidebar-documentpreview` and `ui-sidebar-files`) depend on `ctx.remote.workspaceFiles` methods (`stat`, `read`, `readBytes`, `list`).
Because `dsh-plugin-remote-ssh` did not proxy `ctx.remote.workspaceFiles`, calls for remote sessions fell through to the local Host, which cannot find remote sessions and errors out, causing remote file previews and remote workspace file trees to fail to open.

## Decision
1. **Host-side Relay Routes**:
   - Registered `/remote-ssh/workspace-file-stat`, `/remote-ssh/workspace-file-read`, `/remote-ssh/workspace-file-read-bytes`, and `/remote-ssh/workspace-file-list` on the local web server.
   - Added RPC methods in `RemoteCaller` calling remote DSH `workspaceFiles/stat`, `workspaceFiles/read`, `workspaceFiles/readBytes` (unpacking multipart binary bodies into `Uint8Array`), and `workspaceFiles/list`.
2. **Client-side Remote Proxy (`installWorkspaceFilesProxy`)**:
   - Declared `'remote.workspaceFiles'` in `exports.inject`.
   - Intercepted `ctx.remote.workspaceFiles` methods (`stat`, `read`, `readBytes`, `list`).
   - When the target session ID belongs to a remote session (`isRemote(sessionId)`), delegated to the plugin's Host routes through the SSH tunnel, decoding base64 data to `Uint8Array` for `readBytes`.
   - Local sessions pass through transparently to the original methods.
3. **Synchronize Client Contract & Build**:
   - Mirrored changes in `src/client/index.ts` and `client.js`.
   - Added `smoke-workspace-files.mjs` verifying remote routing, binary decoding, and local passthrough.

## Alternatives considered
1. *Proxy at raw HTTP `/api/file` and `/api/workspaceFiles/*` level*:
   - Rejected because `/api/*` is inside DSH connection authentication fence and requires modifying DSH core or hijacking global fetch. Wrapping Cordis service `ctx.remote.workspaceFiles` adheres to DSH's modular architecture and matches how `ctx.remote.session`, `ctx.remote.workspace`, `ctx.remote.commands`, and `ctx.fileUpload` are implemented.
2. *Read file content entirely through custom UI panel*:
   - Rejected because our core design philosophy is zero custom UI and complete reuse of official UI components (`ui-sidebar-documentpreview`, `ui-sidebar-files`, and `ui-deliverables`).

## Consequences
- Remote sessions can preview text, code, markdown, and binary/media files seamlessly in the official sidebar preview and tree tabs.
- Local sessions remain fully unaffected.
