# Agent Note: Official Workspace UI requires a core source extension

Status: rejected — superseded by official-model injection and session-namespace proxy (2026-10-01-reuse-official-workspace-session-ui.md)

## Problem

The current `remote-ssh` browser panel renders remote workspace groups and Session rows independently. It proves the SSH/RPC path, but duplicates the official WorkspaceBrowser presentation and cannot reuse the official conversation/session detail flow.

The DSH 0.2.0-rc.2 composition does not expose a plugin-only source extension:

- `sidebar.workspaces` is a `single` slot occupied by the official WorkspaceBrowser;
- its `useWorkspaces` and `useSessions` values are root standard hooks owned by the official renderer;
- child slots only add row actions/decorations and cannot add Workspace groups or replace those hooks;
- supplying another root `workspaces` hook is rejected as a duplicate root standard hook;
- the published `ui-workspace/client` artifact exports only its loader entry, not the private WorkspaceBrowser or row components.

## Proposal

Add a first-class source registry to the official `ui-workspace` package, then register the remote source from `dsh-plugin-remote-ssh`.

The core extension owns:

- source registration and HMR disposal;
- merging local and remote workspace/session projections;
- reuse of the existing WorkspaceBrowser tree, SessionNodeItem, ProjectRowItem, row layout, theme, and locale;
- source-aware capability gating for local-only mutations;
- source-owned session opening, which can later connect to the official conversation/session adapter.

The plugin owns:

- SSH tunnel and authentication;
- remote `session/list` and subsequent session protocol calls;
- namespaced remote IDs;
- projection of remote `cwd` groups to WorkspaceView-like records;
- source-owned open/detail/prompt capabilities.

Until the core source registry is available in the running DSH build, the plugin keeps the current read-only panel as a fallback. It must not shadow `sidebar.workspaces` or provide a duplicate `workspaces` root hook.

## Alternatives considered

- **Register remote rows through existing child slots**: rejected because those slots receive only one already-rendered local Session row identity; they cannot create Workspace groups or Session rows.
- **Replace `sidebar.workspaces` from the plugin**: rejected because it shadows the shipped browser, duplicates all official behavior, and creates activation-order risk.
- **Provide another root `workspaces` hook**: rejected because the renderer enforces globally unique root standard hooks and throws on duplicate `workspaces`.
- **Import private official components from the plugin**: rejected because the published client entry does not export them and private bundle internals are not a stable plugin API.
- **Keep extending the custom panel**: rejected as the final architecture because it permanently duplicates official tree, row, and conversation behavior.

## Acceptance criteria

- `ui-workspace` exposes a clean Source registry allowing non-local workspace sources to register safely.
- `dsh-plugin-remote-ssh` projects remote sessions and cwd groups into compliant `RemoteSourceSnapshot` models with unambiguous namespaced IDs.
- Remote workspaces render seamlessly within the official workspace navigation tree alongside local workspaces.
- Existing local operations (rename, archive, drag-and-drop) remain fully functional and fail-safe when encountering remote items.

## Risks

- Core runtime integration mismatch if desktop packaging uses pre-bundled immutable `.asar`.
- Cross-boundary ID collisions if remote IDs are not strictly namespaced.
