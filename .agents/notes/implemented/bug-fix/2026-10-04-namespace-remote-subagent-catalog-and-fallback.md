# Agent Note: Support Subagent Catalog ID Namespacing and Fallback Resolution in Remote SSH Proxy

Status: implemented

## Problem

When viewing a remote session (or remote subagent session) that spawned subagents (via `subagentCatalog` or `agentTeam` projections), the official DSH client UI renders subagent cards using their raw remote session IDs (e.g. `b4a77b5a-...`) without the `remote:<host>:` prefix. When the user clicks one of these subagents:
1. The UI passes the unnamespaced child ID (and its parent ID) to `ctx.remote.session.page(...)` or `ctx.remote.session.follow(...)`.
2. In `dsh-plugin-remote-ssh`, `isRemote(id)` previously only checked `remoteSessionIds.has(id)` and `id.startsWith('remote:')`. Since `remoteSessionIds` only contained namespaced IDs (`remote:<host>:<id>`), `isRemote` returned `false` for raw subagent IDs.
3. As a result, the request fell through to the local host's DSH session service. The local host could not find the remote session in `~/.dsh/sessions`, throwing `SESSION_QUERY_SESSION_NOT_FOUND`, which surfaced to the UI as:
   `历史加载失败：subagent is unavailable（subagent/not-found）`.
4. Furthermore, in `src/route.ts`'s `SESSION_RAW_ROUTE`, if a parent ID was passed in query parameter or subagentParents but not properly resolved when checking address validity, or when child sessions themselves had subagents (nested subagents), the server-side address structure could fail or mismatch.

## Decision

We fix this end-to-end in `dsh-plugin-remote-ssh` by:
1. **Namespacing child IDs in projections**:
   In `src/sessions.ts` (and reflected in `client.js`), when normalizing `subagentCatalog` and `agentTeam` projections for sessions belonging to remote host `<host>`:
   - For `subagentCatalog`: map each item's `id` to `namespaceRemoteId(host, item.id)`.
   - For `agentTeam`: map each member's `id` to `namespaceRemoteId(host, member.id)`.
   This ensures that any UI component referencing subagent IDs directly from projections uses namespaced IDs that match `remoteSessionIds`.

2. **Bidirectional fallback in `sessionParents` and `remoteSessionIds`**:
   In `client.js` and `src/route.ts`:
   - When registering sessions and their parents from the remote snapshot, populate both raw ID and namespaced ID in `remoteSessionIds` and `sessionParents` (`subagentParents`).
   - In `client.js`: update `isRemote(id)` to also check if `id` is present in `sessionParents` or `rawToNamespacedSessionIds` map, or if its `parentId` is remote.
   - In `sessionTargetOfRequest`: strip / resolve `namespaceRemoteId` properly when constructing the remote query URL while maintaining host correlation.

3. **Robust parent address resolution on host route**:
   In `src/route.ts` (`SESSION_RAW_ROUTE` and `SESSION_FOLLOW_ROUTE`):
   - Support both raw and namespaced `id` and `parentId`.
   - Automatically fall back to finding the parent ID in `subagentParents` or inspecting the session's own `subagent` projection if `parentId` is not explicitly supplied by the client.

## Alternatives considered

- *Do not namespace `subagentCatalog` and rely solely on client unnamespaced interception*:
  Rejected because `ctx.sessions` and workspace models already namespace all remote session IDs to avoid collisions with local sessions. If `subagentCatalog` held raw IDs while `ctx.sessions` held namespaced IDs, other components looking up session summaries (`ctx.sessions.byId[id]`) by catalog ID would fail to find titles, status, or avatar metadata.

- *Require remote DSH to namespace its own subagents*:
  Rejected because remote DSH is an independent server and has no knowledge of the SSH tunnel client or other hosts. Namespacing must remain a client/gateway adapter concern.
