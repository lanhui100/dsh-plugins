/** Read-only and mutable HTTP routes feeding the browser panel from one or more remote DSH instances. */

import type { Context } from '@deepseek-ai/cordis'
import type { RemoteCaller } from './remote.ts'
import { groupSessionsByWorkspace, listRemoteSessions, type RemoteSessionItem } from './sessions.ts'
import { projectRemoteSourceSnapshot, namespaceRemoteId, namespaceRemoteWorkspaceId, REMOTE_SOURCE_KIND } from './source.ts'
import { getRemoteSessionDetail } from './session-detail.ts'
import { RemoteHostManager } from './manager.ts'
import { getAvailableSshHosts, parseSshConfig } from './ssh-config.ts'

/** Absolute pathname the browser panel fetches for all workspaces and sessions. */
export const SESSIONS_ROUTE = '/remote-ssh/sessions'

/** Absolute pathname the browser panel fetches for a single session's details and messages. */
export const SESSION_DETAIL_ROUTE = '/remote-ssh/session'

/**
 * Absolute pathname serving the raw wire projection and event records of one
 * remote session, exactly as the remote `session/projections` + `session/page`
 * RPCs return them, so the official SessionEventStream / ConversationNodeAssembler
 * can consume the history natively.
 */
export const SESSION_RAW_ROUTE = '/remote-ssh/session-raw'

/** Absolute pathname for prompting an active remote session or subagent. */
export const SESSION_PROMPT_ROUTE = '/remote-ssh/prompt'

/** Absolute pathname for canceling/interrupting an active remote session or subagent. */
export const SESSION_CANCEL_ROUTE = '/remote-ssh/cancel'

/** Absolute pathname for streaming remote session follow frames via SSE. */
export const SESSION_FOLLOW_ROUTE = '/remote-ssh/session-follow'

/** Absolute pathname for creating a new session in a remote workspace. */
export const SESSION_CREATE_ROUTE = '/remote-ssh/create'

/** Absolute pathname for querying pending user-questions/interactions of a remote session. */
export const SESSION_PENDING_INTERACTION_ROUTE = '/remote-ssh/pending-interaction'

/** Absolute pathname for responding to a pending user-question/interaction. */
export const SESSION_INTERACTION_RESPOND_ROUTE = '/remote-ssh/interaction-respond'

/** Absolute pathname for archiving a remote session. */
export const SESSION_ARCHIVE_ROUTE = '/remote-ssh/session-archive'

/** Absolute pathname for unarchiving a remote session. */
export const SESSION_UNARCHIVE_ROUTE = '/remote-ssh/session-unarchive'

/** Absolute pathname for pinning a remote session. */
export const SESSION_PIN_ROUTE = '/remote-ssh/session-pin'

/** Absolute pathname for unpinning a remote session. */
export const SESSION_UNPIN_ROUTE = '/remote-ssh/session-unpin'

/** Absolute pathname for renaming a remote session. */
export const SESSION_RENAME_ROUTE = '/remote-ssh/session-rename'

/** Absolute pathname for selecting model of a remote session. */
export const SESSION_SELECT_MODEL_ROUTE = '/remote-ssh/session-select-model'

/** Absolute pathname for reading a remote session image attachment. */
export const SESSION_ATTACHMENT_ROUTE = '/remote-ssh/attachment'

/** Absolute pathname for uploading a file into a remote session for prompt staging. */
export const SESSION_FILE_UPLOAD_ROUTE = '/remote-ssh/file-upload'

/** Absolute pathname for querying unadded key-configured SSH hosts from ~/.ssh/config. */
export const AVAILABLE_HOSTS_ROUTE = '/remote-ssh/available-hosts'

/** Absolute pathname for dynamically adding a new remote SSH host. */
export const ADD_HOST_ROUTE = '/remote-ssh/add-host'

/** Absolute pathname for disconnecting and removing a remote SSH host. */
export const REMOVE_HOST_ROUTE = '/remote-ssh/remove-host'


/** Absolute pathname for listing remote user's home directories. */
export const REMOTE_WORKSPACES_ROUTE = '/remote-ssh/workspaces'

/** Absolute pathname for creating a remote user's home directory workspace. */
export const ADD_WORKSPACE_ROUTE = '/remote-ssh/add-workspace'

/** Absolute pathname for deleting a remote workspace. */
export const WORKSPACE_DELETE_ROUTE = '/remote-ssh/workspace-delete'


export interface WebServerLike {
  register(route: {
    readonly kind: 'exact' | 'prefix'
    readonly path: string
    readonly handler: (req: unknown, res: HttpResponseLike) => void | Promise<void>
  }): () => void
}

/** The response fields this route writes. */
export interface HttpResponseLike {
  writeHead(status: number, headers: Record<string, string>): void
  end(body?: string): void
  write?(chunk: string): boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: WebServerLike
  }
}

function sendJson(res: HttpResponseLike, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function namespaceSessionMutationResult(
  host: string,
  value: unknown,
  field: 'archivedSessionIds' | 'pinnedSessionIds',
): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  const ids = record[field]
  if (!Array.isArray(ids)) return value
  return {
    ...record,
    [field]: ids.map((id) => namespaceRemoteId(host, String(id))),
  }
}

async function readJsonBody(req: unknown): Promise<Record<string, unknown>> {
  const incoming = req as { on?: (event: string, cb: (...args: unknown[]) => void) => void }
  if (typeof incoming?.on !== 'function') return {}
  const chunks: Buffer[] = []
  await new Promise<void>((resolve, reject) => {
    incoming.on!('data', (chunk: unknown) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer))
    })
    incoming.on!('end', () => resolve())
    incoming.on!('error', reject)
  })
  const text = Buffer.concat(chunks).toString('utf8').trim()
  return text.length > 0 ? JSON.parse(text) : {}
}

/**
 * Register all remote HTTP routes against the host Cordis webServer.
 * Supports either a RemoteHostManager (multi-host) or a legacy single-caller getter.
 */
export function registerRemoteSshRoute(
  ctx: Context,
  managerOrGetCaller: RemoteHostManager | (() => RemoteCaller | undefined),
  hostLabel?: string,
  sshConfigPath?: string,
): void {
  const isManager = managerOrGetCaller instanceof RemoteHostManager
  const subagentParents = new Map<string, string>()
  const pathToRemoteWorkspaceId = new Map<string, string>()

  function resolveTarget(rawSessionId: string): { host: string; originalSessionId: string; caller?: RemoteCaller } {
    if (isManager) {
      const res = (managerOrGetCaller as RemoteHostManager).resolveSessionTarget(rawSessionId)
      if (res) return res
    }
    const caller = typeof managerOrGetCaller === 'function' ? managerOrGetCaller() : undefined
    // Legacy single-caller fallback mirrors the manager's namespace decoding so a
    // `remote:<host>:<encodedId>` session id still resolves to the remote id.
    let originalSessionId = rawSessionId
    if (rawSessionId.startsWith(`${REMOTE_SOURCE_KIND}:`)) {
      const parts = rawSessionId.split(':')
      if (parts.length >= 3) {
        originalSessionId = parts.slice(2).map(decodeURIComponent).join(':')
      }
    }
    return {
      host: hostLabel || 'remote',
      originalSessionId,
      caller,
    }
  }

  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: REMOTE_WORKSPACES_ROUTE,
      handler: async (_req, res) => {
        if (!isManager) {
          sendJson(res, 400, { error: 'not-supported', message: 'Multi-host manager is not active in this runtime.' })
          return
        }
        try {
          const manager = managerOrGetCaller as RemoteHostManager
          const rows: Array<{ host: string; name: string; path: string }> = []
          for (const host of manager.getHostNames()) {
            if (!manager.getCallerForHost(host)) continue
            const dirs = await manager.listHomeDirectories(host)
            for (const dir of dirs) rows.push({ host, name: dir.name, path: dir.path })
          }
          sendJson(res, 200, { workspaces: rows })
        } catch (error) {
          sendJson(res, 502, { error: 'remote-unavailable', message: error instanceof Error ? error.message : String(error) })
        }
      },
    }), 'remote-ssh: workspaces route')

    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: '/remote-ssh/register-workspace',
      handler: async (req, res) => {
        if (!isManager) {
          sendJson(res, 400, { error: 'not-supported', message: 'Multi-host manager is not active in this runtime.' })
          return
        }
        try {
          const body = await readJsonBody(req)
          const host = typeof body.host === 'string' ? body.host.trim() : ''
          let targetPath = typeof body.path === 'string' ? body.path.trim() : ''
          if (!host || !targetPath) {
            sendJson(res, 400, { error: 'missing-fields', message: 'Fields "host" and "path" are required.' })
            return
          }
          const manager = managerOrGetCaller as RemoteHostManager
          const caller = manager.getCallerForHost(host)
          if (!caller) {
            sendJson(res, 503, { error: 'tunnel-not-ready', message: `Host "${host}" is not ready.` })
            return
          }

          // Clean and normalize path: trim and remove trailing slashes
          targetPath = targetPath.replace(/[/\\]+$/, '')

          // Expand ~ or resolve relative paths to absolute remote home path
          if (targetPath.startsWith('~')) {
            const home = await manager.getHomeDirectory(host).catch(() => '')
            if (home) {
              const cleanHome = home.replace(/[/\\]+$/, '')
              targetPath = targetPath === '~' ? cleanHome : `${cleanHome}/${targetPath.replace(/^~[/\\]+/, '')}`
            }
          }

          // Register workspace in remote DSH
          const wsRes = await caller.createWorkspace(targetPath)
          // Also create an initial session in this workspace so it immediately has sessions
          await caller.invoke('session/create', { request: { workspaceId: wsRes.workspaceId } }).catch((err) => {
            console.warn(`remote-ssh: [${host}] initial session creation failed for workspace ${wsRes.workspaceId}:`, err)
          })
          sendJson(res, 200, { ok: true, host, path: targetPath, workspace: wsRes })
        } catch (error) {
          sendJson(res, 400, { error: 'register-failed', message: error instanceof Error ? error.message : String(error) })
        }
      },
    }), 'remote-ssh: register workspace route')

    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: ADD_WORKSPACE_ROUTE,
      handler: async (req, res) => {
        if (!isManager) {
          sendJson(res, 400, { error: 'not-supported', message: 'Multi-host manager is not active in this runtime.' })
          return
        }
        try {
          const body = await readJsonBody(req)
          const host = typeof body.host === 'string' ? body.host.trim() : ''
          const name = typeof body.name === 'string' ? body.name.trim() : ''
          if (!host || !name) {
            sendJson(res, 400, { error: 'missing-fields', message: 'Fields "host" and "name" are required.' })
            return
          }
          const manager = managerOrGetCaller as RemoteHostManager
          if (!manager.getHostNames().some((item) => item.toLowerCase() === host.toLowerCase())) {
            sendJson(res, 400, { error: 'invalid-host', message: `Host "${host}" is not registered.` })
            return
          }
          const result = await manager.createHomeDirectory(host, name)
          // Also create an initial session in this new workspace so it immediately surfaces
          const caller = manager.getCallerForHost(host)
          if (caller) {
            const createReq = result.workspace?.workspaceId
              ? { workspaceId: result.workspace.workspaceId }
              : { cwd: result.path }
            await caller.invoke('session/create', { request: createReq }).catch((err) => {
              console.warn(`remote-ssh: [${host}] initial session creation failed:`, err)
            })
          }
          sendJson(res, 200, { ok: true, host, name: result.name, path: result.path, workspace: result.workspace })
        } catch (error) {
          sendJson(res, 400, { error: 'create-failed', message: error instanceof Error ? error.message : String(error) })
        }
      },
    }), 'remote-ssh: add workspace route')

    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: WORKSPACE_DELETE_ROUTE,
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          const rawWorkspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : ''
          if (!rawWorkspaceId) {
            sendJson(res, 400, { error: 'missing-fields', message: 'Field "workspaceId" is required.' })
            return
          }

          let host = hostLabel || 'remote'
          let targetCwd: string | undefined
          let targetWsId: string | undefined

          if (rawWorkspaceId.startsWith(`${REMOTE_SOURCE_KIND}:`)) {
            const parts = rawWorkspaceId.split(':')
            if (parts.length >= 3) {
              host = decodeURIComponent(parts[1])
              const rest = parts.slice(2).map(decodeURIComponent).join(':')
              if (rest.startsWith('workspace:')) {
                targetCwd = rest.slice('workspace:'.length)
              } else {
                targetWsId = rest
              }
            }
          } else if (rawWorkspaceId.startsWith('workspace:')) {
            targetCwd = rawWorkspaceId.slice('workspace:'.length)
          } else {
            targetWsId = rawWorkspaceId
          }

          const caller = isManager
            ? (managerOrGetCaller as RemoteHostManager).getCallerForHost(host)
            : (typeof managerOrGetCaller === 'function' ? managerOrGetCaller() : undefined)

          if (!caller) {
            sendJson(res, 503, { error: 'tunnel-not-ready', message: `Host "${host}" is not ready.` })
            return
          }

          // If targetWsId was not a UUID, or we only have targetCwd, resolve actual remote UUID
          let resolvedWsId = targetWsId
          if (!resolvedWsId && targetCwd) {
            resolvedWsId = pathToRemoteWorkspaceId.get(`${host}:${targetCwd}`) || pathToRemoteWorkspaceId.get(targetCwd)
            if (!resolvedWsId) {
              const baseline = await caller.fetchWorkspaceBaseline().catch(() => undefined)
              if (baseline) {
                const found = baseline.items.find((it) => it.path === targetCwd)
                if (found) resolvedWsId = found.workspaceId
              }
            }
          }

          if (!resolvedWsId) {
            sendJson(res, 404, { error: 'workspace/not-found', message: `Workspace "${rawWorkspaceId}" not found on host "${host}".` })
            return
          }

          await caller.deleteWorkspace(resolvedWsId)
          sendJson(res, 200, { ok: true, value: { deleted: true } })
        } catch (error) {
          sendJson(res, 400, { error: 'delete-failed', message: error instanceof Error ? error.message : String(error) })
        }
      },
    }), 'remote-ssh: workspace delete route')
    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: SESSIONS_ROUTE,
      handler: async (_req, res) => {
        if (isManager) {
          const manager = managerOrGetCaller as RemoteHostManager
          if (manager.getHostNames().length === 0) {
            sendJson(res, 200, {
              hosts: [],
              homes: [],
              total: 0,
              workspaces: [],
              sessions: [],
              archivedSessionIds: [],
              pinnedSessionIds: [],
            })
            return
          }
          const readyCallers = manager.getReadyCallers()
          if (readyCallers.length === 0) {
            sendJson(res, 503, { error: 'tunnel-not-ready', hosts: manager.getHostNames() })
            return
          }

          try {
            const hostSnapshots = await Promise.all(readyCallers.map(async ({ host, caller }) => {
              try {
                const [items, baseline, home] = await Promise.all([
                  listRemoteSessions(caller).catch((err) => {
                    console.warn(`remote-ssh: [${host}] listRemoteSessions failed:`, err)
                    return []
                  }),
                  caller.fetchWorkspaceBaseline().catch((err) => {
                    console.warn(`remote-ssh: [${host}] baseline fetch failed:`, err)
                    return undefined
                  }),
                  manager.getHomeDirectory(host).catch((err: unknown) => {
                    console.warn(`remote-ssh: [${host}] home directory resolve failed:`, err)
                    return undefined
                  }),
                ])

                if (baseline !== undefined) {
                  for (const it of baseline.items) {
                    pathToRemoteWorkspaceId.set(`${host}:${it.path}`, it.workspaceId)
                  }
                }

                const validMap = baseline !== undefined
                  ? new Map(baseline.items.map((it) => [it.path, { workspaceId: it.workspaceId, title: it.title }]))
                  : undefined

                void caller.ensureEventsListener().catch(() => {})
                const rawWorkspaces = groupSessionsByWorkspace(items, 50, validMap)
                const workspaceGroups = rawWorkspaces.length > 0
                  ? rawWorkspaces
                  : [{ cwd: home !== undefined ? `${home}/unknown-workspace` : '~', name: '未知工作区', sessions: [], total: 0 }]

              for (const it of items) {
                if (it.origin === 'subagent' && it.parentSessionId) {
                  const nsChild = namespaceRemoteId(host, it.sessionId)
                  const nsParent = namespaceRemoteId(host, it.parentSessionId)
                  subagentParents.set(nsChild, nsParent)
                  subagentParents.set(it.sessionId, it.parentSessionId)
                  subagentParents.set(nsChild, it.parentSessionId)
                  subagentParents.set(it.sessionId, nsParent)
                }
              }

              function namespaceCatalogAndTeam(proj: RemoteSessionItem['projections'], h: string): RemoteSessionItem['projections'] {
                if (!proj?.values) return proj
                const vals = { ...proj.values }
                if (Array.isArray(vals.subagentCatalog)) {
                  vals.subagentCatalog = vals.subagentCatalog.map((item: Record<string, unknown>) => {
                    if (item && typeof item.id === 'string' && !item.id.startsWith('remote:')) {
                      return { ...item, id: namespaceRemoteId(h, item.id) }
                    }
                    return item
                  })
                }
                if (vals.agentTeam && typeof vals.agentTeam === 'object') {
                  const team = { ...(vals.agentTeam as Record<string, unknown>) }
                  if (Array.isArray(team.members)) {
                    team.members = team.members.map((m: Record<string, unknown>) => {
                      if (m && typeof m.id === 'string' && !m.id.startsWith('remote:')) {
                        return { ...m, id: namespaceRemoteId(h, m.id) }
                      }
                      return m
                    })
                  }
                  vals.agentTeam = team
                }
                return { ...proj, values: vals }
              }

              const namespacedWorkspaces = workspaceGroups.map((ws) => ({
                ...ws,
                workspaceId: namespaceRemoteWorkspaceId(host, ws.cwd),
                name: readyCallers.length > 1 ? `[${host}] ${ws.name}` : ws.name,
                sessions: ws.sessions.map((s) => {
                  const pending = caller.getPendingInteractionsForSession(s.sessionId)
                  return {
                    ...s,
                    sessionId: namespaceRemoteId(host, s.sessionId),
                    parentSessionId: s.parentSessionId ? namespaceRemoteId(host, s.parentSessionId) : undefined,
                    projections: namespaceCatalogAndTeam(s.projections, host),
                    pendingInteraction: pending.length > 0
                      ? (pending[0]?.event === 'user-questions/request' ? 'question' : true)
                      : false,
                  }
                }),
              }))

              const validSessions = (validMap !== undefined
                ? items.filter((it) => validMap.has(it.cwd))
                : items
              ).map((it) => {
                const pending = caller.getPendingInteractionsForSession(it.sessionId)
                return {
                  ...it,
                  sessionId: namespaceRemoteId(host, it.sessionId),
                  parentSessionId: it.parentSessionId ? namespaceRemoteId(host, it.parentSessionId) : undefined,
                  projections: namespaceCatalogAndTeam(it.projections, host),
                  pendingInteraction: pending.length > 0
                    ? (pending[0]?.event === 'user-questions/request' ? 'question' : true)
                    : false,
                }
              })

              const archivedSessionIds = (baseline?.archivedSessionIds ?? []).map((id) => namespaceRemoteId(host, id))
              const pinnedSessionIds = (baseline?.pinnedSessionIds ?? []).map((id) => namespaceRemoteId(host, id))

              return {
                host,
                home,
                workspaces: namespacedWorkspaces,
                sessions: validSessions,
                archivedSessionIds,
                pinnedSessionIds,
              }
            } catch (hostErr) {
              console.warn(`remote-ssh: [${host}] host snapshot aggregation failed:`, hostErr)
              return {
                host,
                home: undefined,
                workspaces: [],
                sessions: [],
                archivedSessionIds: [],
                pinnedSessionIds: [],
              }
            }
          }))

            const aggregatedWorkspaces = hostSnapshots.flatMap((s) => s.workspaces)
            const aggregatedSessions = hostSnapshots.flatMap((s) => s.sessions)
            const aggregatedArchived = hostSnapshots.flatMap((s) => s.archivedSessionIds)
            const aggregatedPinned = hostSnapshots.flatMap((s) => s.pinnedSessionIds)

            sendJson(res, 200, {
              hosts: readyCallers.map((c) => c.host),
              homes: hostSnapshots.map((s) => ({ host: s.host, home: s.home })),
              total: aggregatedSessions.length,
              workspaces: aggregatedWorkspaces,
              sessions: aggregatedSessions,
              archivedSessionIds: aggregatedArchived,
              pinnedSessionIds: aggregatedPinned,
            })
          } catch (error) {
            sendJson(res, 502, {
              error: 'remote-unavailable',
              message: error instanceof Error ? error.message : String(error),
            })
          }
          return
        }

        // Single-caller fallback
        const caller = typeof managerOrGetCaller === 'function' ? managerOrGetCaller() : undefined
        if (caller === undefined) {
          sendJson(res, 503, { error: 'tunnel-not-ready' })
          return
        }
        try {
          const [items, baseline] = await Promise.all([
            listRemoteSessions(caller),
            caller.fetchWorkspaceBaseline().catch((err) => {
              console.warn('remote-ssh: failed to fetch workspace baseline, falling back to all sessions:', err)
              return undefined
            }),
          ])
          if (baseline !== undefined) {
            for (const it of baseline.items) {
              pathToRemoteWorkspaceId.set(it.path, it.workspaceId)
            }
          }
          const validMap = baseline !== undefined
            ? new Map(baseline.items.map((it) => [it.path, { workspaceId: it.workspaceId, title: it.title }]))
            : undefined
          void caller.ensureEventsListener().catch(() => {})
          // Resolve the remote user's home directory for the host-root folder.
          let home: string | undefined
          if (isManager) {
            home = await (managerOrGetCaller as RemoteHostManager).getHomeDirectory(hostLabel || 'remote').catch(() => undefined)
          }
          const rawWorkspaces = groupSessionsByWorkspace(items, 50, validMap)
          const workspaceGroups = rawWorkspaces.length > 0
            ? rawWorkspaces
            : [{ cwd: home !== undefined ? `${home}/unknown-workspace` : '~', name: '未知工作区', sessions: [], total: 0 }]
          const archivedSessionIds = baseline?.archivedSessionIds ?? []
          const pinnedSessionIds = baseline?.pinnedSessionIds ?? []
          const source = projectRemoteSourceSnapshot(hostLabel || 'remote', items)

          const host = hostLabel || 'remote'
          function namespaceCatalogAndTeam(proj: RemoteSessionItem['projections'], h: string): RemoteSessionItem['projections'] {
            if (!proj?.values) return proj
            const vals = { ...proj.values }
            if (Array.isArray(vals.subagentCatalog)) {
              vals.subagentCatalog = vals.subagentCatalog.map((item: Record<string, unknown>) => {
                if (item && typeof item.id === 'string' && !item.id.startsWith('remote:')) {
                  return { ...item, id: namespaceRemoteId(h, item.id) }
                }
                return item
              })
            }
            if (vals.agentTeam && typeof vals.agentTeam === 'object') {
              const team = { ...(vals.agentTeam as Record<string, unknown>) }
              if (Array.isArray(team.members)) {
                team.members = team.members.map((m: Record<string, unknown>) => {
                  if (m && typeof m.id === 'string' && !m.id.startsWith('remote:')) {
                    return { ...m, id: namespaceRemoteId(h, m.id) }
                  }
                  return m
                })
              }
              vals.agentTeam = team
            }
            return { ...proj, values: vals }
          }

          const validSessions = (validMap !== undefined
            ? items.filter((it) => validMap.has(it.cwd))
            : items
          ).map((it) => {
            const pending = caller.getPendingInteractionsForSession(it.sessionId)
            return {
              ...it,
              sessionId: namespaceRemoteId(host, it.sessionId),
              parentSessionId: it.parentSessionId ? namespaceRemoteId(host, it.parentSessionId) : undefined,
              projections: namespaceCatalogAndTeam(it.projections, host),
              pendingInteraction: pending.length > 0
                ? (pending[0]?.event === 'user-questions/request' ? 'question' : true)
                : false,
            }
          })

          const workspaces = workspaceGroups.map((ws) => ({
            ...ws,
            sessions: ws.sessions.map((it) => {
              const pending = caller.getPendingInteractionsForSession(it.sessionId)
              return {
                ...it,
                sessionId: namespaceRemoteId(host, it.sessionId),
                parentSessionId: it.parentSessionId ? namespaceRemoteId(host, it.parentSessionId) : undefined,
                projections: namespaceCatalogAndTeam(it.projections, host),
                pendingInteraction: pending.length > 0
                  ? (pending[0]?.event === 'user-questions/request' ? 'question' : true)
                  : false,
              }
            }),
          }))

          for (const it of items) {
            if (it.origin === 'subagent' && it.parentSessionId) {
              const host = hostLabel || 'remote'
              const nsChild = namespaceRemoteId(host, it.sessionId)
              const nsParent = namespaceRemoteId(host, it.parentSessionId)
              subagentParents.set(nsChild, nsParent)
              subagentParents.set(it.sessionId, it.parentSessionId)
              subagentParents.set(nsChild, it.parentSessionId)
              subagentParents.set(it.sessionId, nsParent)
            }
          }

          sendJson(res, 200, {
            host: hostLabel || 'remote',
            home,
            total: items.length,
            workspaces,
            sessions: validSessions,
            archivedSessionIds,
            pinnedSessionIds,
            source,
          })
        } catch (error) {
          sendJson(res, 502, {
            error: 'remote-unavailable',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      },
    }), 'remote-ssh: sessions route')

    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: AVAILABLE_HOSTS_ROUTE,
      handler: async (_req, res) => {
        const currentHosts = isManager
          ? (managerOrGetCaller as RemoteHostManager).getHostNames()
          : (hostLabel ? [hostLabel] : [])
        const availableHosts = getAvailableSshHosts({ sshConfigPath, currentHosts })
        const currentSet = new Set(currentHosts.map((h) => h.toLowerCase().trim()))
        const connectedHosts = currentHosts.map((name) => {
          const detail = parseSshConfig(sshConfigPath).find(
            (h) => h.host.toLowerCase().trim() === name.toLowerCase().trim(),
          )
          return detail ?? { host: name }
        })
        sendJson(res, 200, { currentHosts, connectedHosts, availableHosts })
      },
    }), 'remote-ssh: available hosts route')

    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: ADD_HOST_ROUTE,
      handler: async (req, res) => {
        if (!isManager) {
          sendJson(res, 400, { error: 'not-supported', message: 'Multi-host manager is not active in this runtime.' })
          return
        }
        const manager = managerOrGetCaller as RemoteHostManager
        try {
          const body = await readJsonBody(req)
          const host = typeof body.host === 'string' ? body.host.trim() : ''
          const remotePort = typeof body.remotePort === 'number' ? body.remotePort : 3080

          if (!host) {
            sendJson(res, 400, { error: 'missing-host', message: 'Field "host" is required.' })
            return
          }

          const available = getAvailableSshHosts({ sshConfigPath, currentHosts: manager.getHostNames() })
          const matched = available.find((h) => h.host.toLowerCase() === host.toLowerCase())
          if (!matched) {
            sendJson(res, 400, {
              error: 'invalid-host',
              message: `Host "${host}" is not found in ~/.ssh/config with IdentityFile configured, or is already added.`,
            })
            return
          }

          const result = await manager.addHost(matched.host, remotePort)
          sendJson(res, 200, {
            ok: true,
            host: result.host,
            localPort: result.localPort,
            autoStarted: Boolean(result.autoStarted),
            ...(result.harnessPath !== undefined ? { harnessPath: result.harnessPath } : {}),
          })
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          sendJson(res, 500, {
            error: 'add-failed',
            message: errMsg || 'Failed to add remote host',
          })
        }
      },
    }), 'remote-ssh: add host route')

    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: REMOVE_HOST_ROUTE,
      handler: async (req, res) => {
        if (!isManager) {
          sendJson(res, 400, { error: 'not-supported', message: 'Multi-host manager is not active in this runtime.' })
          return
        }
        const manager = managerOrGetCaller as RemoteHostManager
        try {
          const body = await readJsonBody(req)
          const host = typeof body.host === 'string' ? body.host.trim() : ''
          if (!host) {
            sendJson(res, 400, { error: 'missing-host', message: 'Field "host" is required.' })
            return
          }
          if (!manager.getHostNames().some((h) => h.toLowerCase() === host.toLowerCase())) {
            sendJson(res, 400, { error: 'invalid-host', message: `Host "${host}" is not registered.` })
            return
          }
          manager.removeHost(host)
          sendJson(res, 200, { ok: true, host })
        } catch (err) {
          sendJson(res, 500, {
            error: 'remove-failed',
            message: err instanceof Error ? err.message : String(err),
          })
        }
      },
    }), 'remote-ssh: remove host route')

    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: SESSION_DETAIL_ROUTE,
      handler: async (req, res) => {
        const urlStr = typeof (req as { url?: string }).url === 'string'
          ? (req as { url: string }).url
          : '/'
        const rawSessionId = new URL(urlStr, 'http://127.0.0.1').searchParams.get('id')
        if (rawSessionId === null || rawSessionId.trim() === '') {
          sendJson(res, 400, { error: 'missing-id', message: 'Query parameter "id" is required' })
          return
        }
        const target = resolveTarget(rawSessionId)
        if (target.caller === undefined) {
          sendJson(res, 503, { error: 'tunnel-not-ready' })
          return
        }
        try {
          const detail = await getRemoteSessionDetail(target.caller, target.originalSessionId)
          sendJson(res, 200, detail)
        } catch (error) {
          sendJson(res, 502, {
            error: 'remote-unavailable',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      },
    }), 'remote-ssh: session detail route')

    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: SESSION_RAW_ROUTE,
      handler: async (req, res) => {
        const urlStr = typeof (req as { url?: string }).url === 'string'
          ? (req as { url: string }).url
          : '/'
        const url = new URL(urlStr, 'http://127.0.0.1')
        const rawSessionId = url.searchParams.get('id')
        const queryParentId = url.searchParams.get('parentId')
        if (rawSessionId === null || rawSessionId.trim() === '') {
          sendJson(res, 400, { error: 'missing-id', message: 'Query parameter "id" is required' })
          return
        }

        const target = resolveTarget(rawSessionId)
        if (target.caller === undefined) {
          sendJson(res, 503, { error: 'tunnel-not-ready' })
          return
        }

        const caller = target.caller
        const sessionId = target.originalSessionId

        let resolvedParentId = (queryParentId && queryParentId.trim() !== '')
          ? (resolveTarget(queryParentId.trim()).originalSessionId)
          : subagentParents.get(rawSessionId) || subagentParents.get(sessionId)

        if (resolvedParentId) {
          resolvedParentId = resolveTarget(resolvedParentId).originalSessionId
        }

        try {
          const proj = await caller.invoke<{ asOfSeq?: number; values?: unknown }>(
            'session/projections',
            { request: { sessionId } },
          )
          const asOfSeq = typeof proj?.asOfSeq === 'number' ? proj.asOfSeq : 0
          let page: { records?: readonly unknown[]; hasMore?: boolean } | undefined

          if (asOfSeq > 0) {
            const makeAddress = (pId?: string) => (pId !== undefined
              ? { kind: 'subagent', parentSessionId: pId, childSessionId: sessionId, mode: 'unknown' }
              : { kind: 'session', sessionId })

            try {
              page = await caller.invoke<{ records?: readonly unknown[]; hasMore?: boolean }>(
                'session/page',
                { request: { address: makeAddress(resolvedParentId), throughSeq: asOfSeq, maxMessages: 200 } },
              )
            } catch (pageErr) {
              const msg = String(pageErr)
              if (resolvedParentId === undefined && msg.includes('subagent Sessions require their durable parent address')) {
                const subVal = (proj?.values as Record<string, unknown> | undefined)?.subagent as
                  { parentSessionId?: string } | undefined
                const fallbackParent = subVal?.parentSessionId
                if (fallbackParent) {
                  resolvedParentId = fallbackParent
                  subagentParents.set(rawSessionId, fallbackParent)
                  subagentParents.set(sessionId, fallbackParent)
                  page = await caller.invoke<{ records?: readonly unknown[]; hasMore?: boolean }>(
                    'session/page',
                    { request: { address: makeAddress(fallbackParent), throughSeq: asOfSeq, maxMessages: 200 } },
                  )
                } else {
                  throw pageErr
                }
              } else {
                throw pageErr
              }
            }
          }

          const host = target.host || hostLabel || 'remote'
          const rawProjections = (proj?.values as Record<string, unknown> | undefined) ?? {}
          const namespacedProjections = { ...rawProjections }
          if (Array.isArray(namespacedProjections.subagentCatalog)) {
            namespacedProjections.subagentCatalog = namespacedProjections.subagentCatalog.map((item: Record<string, unknown>) => {
              if (item && typeof item.id === 'string' && !item.id.startsWith('remote:')) {
                return { ...item, id: namespaceRemoteId(host, item.id) }
              }
              return item
            })
          }
          if (namespacedProjections.agentTeam && typeof namespacedProjections.agentTeam === 'object') {
            const team = { ...(namespacedProjections.agentTeam as Record<string, unknown>) }
            if (Array.isArray(team.members)) {
              team.members = team.members.map((m: Record<string, unknown>) => {
                if (m && typeof m.id === 'string' && !m.id.startsWith('remote:')) {
                  return { ...m, id: namespaceRemoteId(host, m.id) }
                }
                return m
              })
            }
            namespacedProjections.agentTeam = team
          }

          sendJson(res, 200, {
            sessionId: rawSessionId,
            asOfSeq,
            header: {
              version: 0,
              id: rawSessionId,
              createdAt: Date.now(),
              isSeeded: false,
              ...(resolvedParentId !== undefined ? { origin: 'subagent', parentSession: resolvedParentId } : {}),
            },
            projections: namespacedProjections,
            records: page?.records ?? [],
            hasMore: page?.hasMore === true,
          })
        } catch (error) {
          sendJson(res, 502, {
            error: 'remote-unavailable',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      },
    }), 'remote-ssh: session raw route')

    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: SESSION_PROMPT_ROUTE,
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          const rawSessionId = String(body.sessionId ?? '')
          const target = resolveTarget(rawSessionId)
          if (target.caller === undefined) {
            sendJson(res, 503, { ok: false, error: { message: 'tunnel-not-ready' } })
            return
          }
          const caller = target.caller
          const sessionId = target.originalSessionId
          let parentSessionId = body.parentSessionId
            ? resolveTarget(String(body.parentSessionId)).originalSessionId
            : subagentParents.get(rawSessionId) || subagentParents.get(sessionId)

          if (parentSessionId) {
            parentSessionId = resolveTarget(parentSessionId).originalSessionId
          }

          const requestId = String(body.requestId || `req-${Date.now().toString(36)}`)
          const mode = body.mode === 'steer' ? 'steer' : 'queue'
          const content = body.content
          const clientTimeZone = typeof body.clientTimeZone === 'string' ? body.clientTimeZone : undefined

          let result: unknown
          if (parentSessionId !== undefined) {
            result = await caller.invoke('subagents/prompt', {
              request: {
                requestId,
                parentSessionId,
                childSessionId: sessionId,
                mode: 'continuable',
                delivery: mode,
                content,
                ...(clientTimeZone ? { clientTimeZone } : {}),
              },
            })
          } else {
            result = await caller.invoke('session/prompt', {
              request: {
                requestId,
                sessionId,
                mode,
                content,
                ...(clientTimeZone ? { clientTimeZone } : {}),
              },
            })
          }
          sendJson(res, 200, { ok: true, value: result })
        } catch (error) {
          sendJson(res, 200, {
            ok: false,
            error: { message: error instanceof Error ? error.message : String(error) },
          })
        }
      },
    }), 'remote-ssh: session prompt route')

    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: SESSION_CANCEL_ROUTE,
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          const rawSessionId = String(body.sessionId ?? '')
          const target = resolveTarget(rawSessionId)
          if (target.caller === undefined) {
            sendJson(res, 503, { ok: false, error: { message: 'tunnel-not-ready' } })
            return
          }
          const caller = target.caller
          const sessionId = target.originalSessionId
          let parentSessionId = body.parentSessionId
            ? resolveTarget(String(body.parentSessionId)).originalSessionId
            : subagentParents.get(rawSessionId) || subagentParents.get(sessionId)

          if (parentSessionId) {
            parentSessionId = resolveTarget(parentSessionId).originalSessionId
          }

          let result: unknown
          if (parentSessionId !== undefined) {
            result = await caller.invoke('subagents/cancel', {
              request: {
                parentSessionId,
                childSessionId: sessionId,
              },
            })
          } else {
            result = await caller.invoke('session/cancel', {
              request: { sessionId },
            })
          }
          sendJson(res, 200, { ok: true, value: result })
        } catch (error) {
          sendJson(res, 200, {
            ok: false,
            error: { message: error instanceof Error ? error.message : String(error) },
          })
        }
      },
    }), 'remote-ssh: session cancel route')

    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: SESSION_FOLLOW_ROUTE,
      handler: async (req, res) => {
        const urlStr = typeof (req as { url?: string }).url === 'string'
          ? (req as { url: string }).url
          : '/'
        const url = new URL(urlStr, 'http://127.0.0.1')
        const rawSessionId = url.searchParams.get('id')
        if (rawSessionId === null || rawSessionId.trim() === '') {
          sendJson(res, 400, { error: 'missing-id', message: 'Query parameter "id" is required' })
          return
        }

        const target = resolveTarget(rawSessionId)
        if (target.caller === undefined) {
          sendJson(res, 503, { error: 'tunnel-not-ready' })
          return
        }

        const caller = target.caller
        const sessionId = target.originalSessionId
        let parentId = url.searchParams.get('parentId')
          ? resolveTarget(url.searchParams.get('parentId')!).originalSessionId
          : subagentParents.get(rawSessionId) || subagentParents.get(sessionId)

        if (parentId) {
          parentId = resolveTarget(parentId).originalSessionId
        }

        const fromSeqStr = url.searchParams.get('fromSeq')
        const fromSeq = fromSeqStr ? parseInt(fromSeqStr, 10) : undefined

        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        })

        const abortController = new AbortController()
        const incomingReq = req as { on?: (event: string, cb: () => void) => void }
        if (typeof incomingReq?.on === 'function') {
          incomingReq.on('close', () => {
            abortController.abort()
          })
        }

        const address = parentId !== undefined
          ? { kind: 'subagent' as const, parentSessionId: parentId, childSessionId: sessionId, mode: 'unknown' as const }
          : { kind: 'session' as const, sessionId }

        try {
          // Push existing pending interactions for this session immediately
          const existingPending = caller.getPendingInteractionsForSession(sessionId)
          for (const p of existingPending) {
            const frame = {
              type: 'interaction/request',
              eventId: p.eventId,
              sessionId: rawSessionId,
              questions: p.questions,
            }
            if (typeof res.write === 'function') {
              res.write(`data: ${JSON.stringify(frame)}\n\n`)
            }
          }

          const unlisten = caller.onInteraction((p, action) => {
            if (p.sessionId !== sessionId) return
            if (action === 'request') {
              const frame = {
                type: 'interaction/request',
                eventId: p.eventId,
                sessionId: rawSessionId,
                questions: p.questions,
              }
              if (typeof res.write === 'function') {
                res.write(`data: ${JSON.stringify(frame)}\n\n`)
              }
            } else if (action === 'cancel') {
              const frame = {
                type: 'interaction/cancel',
                eventId: p.eventId,
                sessionId: rawSessionId,
              }
              if (typeof res.write === 'function') {
                res.write(`data: ${JSON.stringify(frame)}\n\n`)
              }
            }
          })
          abortController.signal.addEventListener('abort', () => unlisten(), { once: true })

          let lastActivityTime = Date.now()
          const heartbeatTimer = setInterval(() => {
            if (abortController.signal.aborted) {
              clearInterval(heartbeatTimer)
              return
            }
            if (Date.now() - lastActivityTime >= 30_000) {
              clearInterval(heartbeatTimer)
              abortController.abort()
              try { res.end() } catch {}
              return
            }
            try {
              if (typeof res.write === 'function') {
                res.write(': heartbeat\n\n')
              }
            } catch {
              clearInterval(heartbeatTimer)
            }
          }, 15_000)
          abortController.signal.addEventListener('abort', () => clearInterval(heartbeatTimer), { once: true })

          const stream = caller.followSession({ address, assistantStream: true }, abortController.signal)

          for await (const frame of stream) {
            if (abortController.signal.aborted) break
            lastActivityTime = Date.now()
            const payload = `data: ${JSON.stringify(frame)}\n\n`
            if (typeof res.write === 'function') {
              res.write(payload)
            }
          }
          clearInterval(heartbeatTimer)
        } catch (err) {
          if (!abortController.signal.aborted) {
            const errorPayload = `data: ${JSON.stringify({ type: 'error', error: String(err) })}\n\n`
            if (typeof res.write === 'function') {
              res.write(errorPayload)
            }
          }
        } finally {
          res.end()
        }
      },
    }), 'remote-ssh: session follow route')

    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: SESSION_CREATE_ROUTE,
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          const rawWorkspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : undefined
          const rawCwd = typeof body.cwd === 'string' ? body.cwd.trim() : undefined

          // Host-root folders are navigation containers, not real workspaces: creating a
          // session directly on them is a UI misuse, so reject it with a clear message
          // instead of forwarding a bogus workspaceId to the remote.
          if (rawWorkspaceId !== undefined && rawWorkspaceId.endsWith(':hostroot')) {
            sendJson(res, 200, {
              ok: false,
              error: { message: '主机根目录不是一个工作区，请展开主机后选择具体工作区新建会话。' },
            })
            return
          }

          let host = hostLabel || 'remote'
          let targetCwd = rawCwd && rawCwd.length > 0 ? rawCwd : undefined
          let targetWsId: string | undefined

          if (rawWorkspaceId && rawWorkspaceId.startsWith(`${REMOTE_SOURCE_KIND}:`)) {
            const parts = rawWorkspaceId.split(':')
            if (parts.length >= 3) {
              host = decodeURIComponent(parts[1])
              const rest = parts.slice(2).map(decodeURIComponent).join(':')
              if (rest.startsWith('workspace:')) {
                targetCwd = rest.slice('workspace:'.length)
              } else {
                targetWsId = rest
              }
            } else if (parts.length === 2) {
              const rest = decodeURIComponent(parts[1])
              if (rest.startsWith('/')) {
                targetCwd = rest
              } else {
                targetWsId = rest
              }
            }
          } else if (rawWorkspaceId) {
            if (rawWorkspaceId.startsWith('workspace:')) {
              targetCwd = rawWorkspaceId.slice('workspace:'.length)
            } else if (rawWorkspaceId.startsWith('/')) {
              targetCwd = rawWorkspaceId
            } else {
              targetWsId = rawWorkspaceId
            }
          }

          let caller: RemoteCaller | undefined
          if (isManager) {
            caller = (managerOrGetCaller as RemoteHostManager).getCallerForHost(host)
            if (!caller) {
              const ready = (managerOrGetCaller as RemoteHostManager).getReadyCallers()
              caller = ready[0]?.caller
              host = ready[0]?.host || host
            }
          } else {
            caller = typeof managerOrGetCaller === 'function' ? managerOrGetCaller() : undefined
          }

          if (caller === undefined) {
            sendJson(res, 503, { ok: false, error: { message: 'tunnel-not-ready' } })
            return
          }

          // If we have targetCwd but no targetWsId, look up in pathToRemoteWorkspaceId cache or query baseline
          if (!targetWsId && targetCwd) {
            targetWsId = pathToRemoteWorkspaceId.get(`${host}:${targetCwd}`) || pathToRemoteWorkspaceId.get(targetCwd)
            if (!targetWsId) {
              const baseline = await caller.fetchWorkspaceBaseline().catch(() => undefined)
              if (baseline !== undefined) {
                for (const it of baseline.items) {
                  pathToRemoteWorkspaceId.set(`${host}:${it.path}`, it.workspaceId)
                  pathToRemoteWorkspaceId.set(it.path, it.workspaceId)
                }
                targetWsId = pathToRemoteWorkspaceId.get(`${host}:${targetCwd}`) || pathToRemoteWorkspaceId.get(targetCwd)
              }
            }
          }

          // The official UI reuses an existing blank session by passing its id
          // (see uiWorkspace.reuseOrCreateBlank). For remote rows that id is the
          // namespaced form (`remote:<host>:<encodedId>`); forwarding it verbatim
          // makes the remote create a NEW session bearing the namespaced string as
          // its real id, duplicating the blank original on every click. Resolve it
          // back to the remote's own id (same decode `resolveTarget` applies to
          // page/prompt/cancel/rename) so reuse genuinely adopts the blank session.
          const rawSessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : undefined
          const forwardedSessionId = rawSessionId !== undefined && rawSessionId !== ''
            ? resolveTarget(rawSessionId).originalSessionId
            : undefined
          const sessionIdField = forwardedSessionId === undefined ? {} : { sessionId: forwardedSessionId }
          const request = targetWsId !== undefined
            ? { workspaceId: targetWsId, ...sessionIdField }
            : { cwd: targetCwd ?? '', ...sessionIdField }

          const result = await caller.invoke<{ sessionId: string; agentPreset?: string }>(
            'session/create',
            { request },
          )

          const namespacedSessionId = namespaceRemoteId(host, result.sessionId)
          sendJson(res, 200, {
            ok: true,
            value: {
              ...result,
              sessionId: namespacedSessionId,
              rawSessionId: result.sessionId,
              host,
            },
          })
        } catch (error) {
          sendJson(res, 200, {
            ok: false,
            error: { message: error instanceof Error ? error.message : String(error) },
          })
        }
      },
    }), 'remote-ssh: session create route')

    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: SESSION_PENDING_INTERACTION_ROUTE,
      handler: async (req, res) => {
        const urlStr = typeof (req as { url?: string }).url === 'string'
          ? (req as { url: string }).url
          : '/'
        const url = new URL(urlStr, 'http://127.0.0.1')
        const rawSessionId = url.searchParams.get('id') || url.searchParams.get('sessionId')
        if (rawSessionId === null || rawSessionId.trim() === '') {
          sendJson(res, 400, { error: 'missing-id', message: 'Query parameter "id" or "sessionId" is required' })
          return
        }
        const target = resolveTarget(rawSessionId)
        if (target.caller === undefined) {
          sendJson(res, 503, { error: 'tunnel-not-ready' })
          return
        }

        try {
          const list = target.caller.getPendingInteractionsForSession(target.originalSessionId)
          sendJson(res, 200, { ok: true, value: { pending: list[0] ?? null, all: list } })
        } catch (error) {
          sendJson(res, 502, {
            error: 'remote-unavailable',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      },
    }), 'remote-ssh: pending interaction route')

    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: SESSION_INTERACTION_RESPOND_ROUTE,
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          const rawSessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
          const target = resolveTarget(rawSessionId)
          if (target.caller === undefined) {
            sendJson(res, 503, { ok: false, error: { message: 'tunnel-not-ready' } })
            return
          }
          const caller = target.caller
          const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : undefined
          const eventId = typeof body.eventId === 'string' ? body.eventId.trim() : undefined
          const outcome = body.outcome as
            | { kind: 'result'; value?: unknown }
            | { kind: 'rejected'; error: { name: string; message: string; code?: string } }
            | { kind: 'next' }

          if (!eventId) {
            sendJson(res, 400, { ok: false, error: { message: 'Field "eventId" is required' } })
            return
          }
          if (!outcome || typeof outcome !== 'object' || !('kind' in outcome)) {
            sendJson(res, 400, { ok: false, error: { message: 'Field "outcome" with "kind" is required' } })
            return
          }

          const result = await caller.respondRemoteEvent(clientId ?? '', eventId, outcome)
          sendJson(res, 200, { ok: true, value: result ?? { accepted: true } })
        } catch (error) {
          sendJson(res, 200, {
            ok: false,
            error: { message: error instanceof Error ? error.message : String(error) },
          })
        }
      },
    }), 'remote-ssh: interaction respond route')

    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: SESSION_ARCHIVE_ROUTE,
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          const rawSessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : undefined
          const stopActivity = Boolean(body.stopActivity)
          if (!rawSessionId) {
            sendJson(res, 400, { ok: false, error: { message: 'Field "sessionId" is required' } })
            return
          }
          const target = resolveTarget(rawSessionId)
          if (target.caller === undefined) {
            sendJson(res, 503, { ok: false, error: { message: 'tunnel-not-ready' } })
            return
          }
          const result = await target.caller.archiveRemoteSession(target.originalSessionId, { stopActivity })
          sendJson(res, 200, {
            ok: true,
            value: isManager
              ? namespaceSessionMutationResult(target.host, result, 'archivedSessionIds')
              : result,
          })
        } catch (error) {
          sendJson(res, 200, {
            ok: false,
            error: { message: error instanceof Error ? error.message : String(error) },
          })
        }
      },
    }), 'remote-ssh: session archive route')

    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: SESSION_UNARCHIVE_ROUTE,
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          const rawSessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : undefined
          if (!rawSessionId) {
            sendJson(res, 400, { ok: false, error: { message: 'Field "sessionId" is required' } })
            return
          }
          const target = resolveTarget(rawSessionId)
          if (target.caller === undefined) {
            sendJson(res, 503, { ok: false, error: { message: 'tunnel-not-ready' } })
            return
          }
          const result = await target.caller.unarchiveRemoteSession(target.originalSessionId)
          sendJson(res, 200, {
            ok: true,
            value: isManager
              ? namespaceSessionMutationResult(target.host, result, 'archivedSessionIds')
              : result,
          })
        } catch (error) {
          sendJson(res, 200, {
            ok: false,
            error: { message: error instanceof Error ? error.message : String(error) },
          })
        }
      },
    }), 'remote-ssh: session unarchive route')

    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: SESSION_PIN_ROUTE,
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          const rawSessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : undefined
          if (!rawSessionId) {
            sendJson(res, 400, { ok: false, error: { message: 'Field "sessionId" is required' } })
            return
          }
          const target = resolveTarget(rawSessionId)
          if (target.caller === undefined) {
            sendJson(res, 503, { ok: false, error: { message: 'tunnel-not-ready' } })
            return
          }
          const result = await target.caller.pinRemoteSession(target.originalSessionId)
          sendJson(res, 200, {
            ok: true,
            value: isManager
              ? namespaceSessionMutationResult(target.host, result, 'pinnedSessionIds')
              : result,
          })
        } catch (error) {
          sendJson(res, 200, {
            ok: false,
            error: { message: error instanceof Error ? error.message : String(error) },
          })
        }
      },
    }), 'remote-ssh: session pin route')

    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: SESSION_UNPIN_ROUTE,
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          const rawSessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : undefined
          if (!rawSessionId) {
            sendJson(res, 400, { ok: false, error: { message: 'Field "sessionId" is required' } })
            return
          }
          const target = resolveTarget(rawSessionId)
          if (target.caller === undefined) {
            sendJson(res, 503, { ok: false, error: { message: 'tunnel-not-ready' } })
            return
          }
          const result = await target.caller.unpinRemoteSession(target.originalSessionId)
          sendJson(res, 200, {
            ok: true,
            value: isManager
              ? namespaceSessionMutationResult(target.host, result, 'pinnedSessionIds')
              : result,
          })
        } catch (error) {
          sendJson(res, 200, {
            ok: false,
            error: { message: error instanceof Error ? error.message : String(error) },
          })
        }
      },
    }), 'remote-ssh: session unpin route')

    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: SESSION_RENAME_ROUTE,
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          const rawSessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : undefined
          const title = typeof body.title === 'string' ? body.title : undefined
          if (!rawSessionId || title === undefined) {
            sendJson(res, 400, { ok: false, error: { message: 'Fields "sessionId" and "title" are required' } })
            return
          }
          const target = resolveTarget(rawSessionId)
          if (target.caller === undefined) {
            sendJson(res, 503, { ok: false, error: { message: 'tunnel-not-ready' } })
            return
          }
          const result = await target.caller.renameRemoteSession(target.originalSessionId, title)
          sendJson(res, 200, { ok: true, value: result })
        } catch (error) {
          sendJson(res, 200, {
            ok: false,
            error: { message: error instanceof Error ? error.message : String(error) },
          })
        }
      },
    }), 'remote-ssh: session rename route')

    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: SESSION_SELECT_MODEL_ROUTE,
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          const rawSessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : undefined
          const provider = typeof body.provider === 'string' ? body.provider.trim() : undefined
          const model = typeof body.model === 'string' ? body.model.trim() : undefined
          const reasoningEffort = typeof body.reasoningEffort === 'string' ? body.reasoningEffort.trim() : undefined
          if (!rawSessionId || !provider || !model) {
            sendJson(res, 400, { ok: false, error: { message: 'Fields "sessionId", "provider", and "model" are required' } })
            return
          }
          const target = resolveTarget(rawSessionId)
          if (target.caller === undefined) {
            sendJson(res, 503, { ok: false, error: { message: 'tunnel-not-ready' } })
            return
          }
          const result = await target.caller.selectRemoteSessionModel(
            target.originalSessionId,
            provider,
            model,
            reasoningEffort,
          )
          sendJson(res, 200, { ok: true, value: result })
        } catch (error) {
          sendJson(res, 200, {
            ok: false,
            error: { message: error instanceof Error ? error.message : String(error) },
          })
        }
      },
    }), 'remote-ssh: session select-model route')

    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: SESSION_ATTACHMENT_ROUTE,
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          const rawSessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : undefined
          const attachmentId = typeof body.attachmentId === 'string' ? body.attachmentId.trim() : undefined
          if (!rawSessionId || !attachmentId) {
            sendJson(res, 400, { ok: false, error: { message: 'Fields "sessionId" and "attachmentId" are required' } })
            return
          }
          const target = resolveTarget(rawSessionId)
          if (target.caller === undefined) {
            sendJson(res, 503, { ok: false, error: { message: 'tunnel-not-ready' } })
            return
          }
          const result = await target.caller.readRemoteAttachment(target.originalSessionId, attachmentId)
          sendJson(res, 200, { ok: true, value: result })
        } catch (error) {
          sendJson(res, 200, {
            ok: false,
            error: { message: error instanceof Error ? error.message : String(error) },
          })
        }
      },
    }), 'remote-ssh: session attachment route')

    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: SESSION_FILE_UPLOAD_ROUTE,
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          const rawSessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : undefined
          const data = typeof body.data === 'string' ? body.data : undefined
          const name = typeof body.name === 'string' && body.name !== '' ? body.name : undefined
          if (!rawSessionId || data === undefined) {
            sendJson(res, 400, { ok: false, error: { message: 'Fields "sessionId" and "data" are required' } })
            return
          }
          const target = resolveTarget(rawSessionId)
          if (target.caller === undefined) {
            sendJson(res, 503, { ok: false, error: { message: 'tunnel-not-ready' } })
            return
          }
          const result = await target.caller.uploadRemoteFile(target.originalSessionId, {
            data,
            ...(name !== undefined ? { name } : {}),
          })
          sendJson(res, 200, { ok: true, value: result })
        } catch (error) {
          sendJson(res, 200, {
            ok: false,
            error: { message: error instanceof Error ? error.message : String(error) },
          })
        }
      },
    }), 'remote-ssh: session file-upload route')
  })
}
