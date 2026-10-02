/** Read-only and mutable HTTP routes feeding the browser panel from one or more remote DSH instances. */

import type { Context } from '@deepseek-ai/cordis'
import type { RemoteCaller } from './remote.ts'
import { groupSessionsByWorkspace, listRemoteSessions } from './sessions.ts'
import { projectRemoteSourceSnapshot, namespaceRemoteId, namespaceRemoteWorkspaceId, REMOTE_SOURCE_KIND } from './source.ts'
import { getRemoteSessionDetail } from './session-detail.ts'
import { RemoteHostManager } from './manager.ts'
import { getAvailableSshHosts } from './ssh-config.ts'

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

/** Absolute pathname for querying unadded key-configured SSH hosts from ~/.ssh/config. */
export const AVAILABLE_HOSTS_ROUTE = '/remote-ssh/available-hosts'

/** Absolute pathname for dynamically adding a new remote SSH host. */
export const ADD_HOST_ROUTE = '/remote-ssh/add-host'


/** The slice of the host web server this module registers against. */
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
    return {
      host: hostLabel || 'remote',
      originalSessionId: rawSessionId,
      caller,
    }
  }

  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: SESSIONS_ROUTE,
      handler: async (_req, res) => {
        if (isManager) {
          const manager = managerOrGetCaller as RemoteHostManager
          const readyCallers = manager.getReadyCallers()
          if (readyCallers.length === 0) {
            sendJson(res, 503, { error: 'tunnel-not-ready', hosts: manager.getHostNames() })
            return
          }

          try {
            const hostSnapshots = await Promise.all(readyCallers.map(async ({ host, caller }) => {
              const [items, baseline] = await Promise.all([
                listRemoteSessions(caller),
                caller.fetchWorkspaceBaseline().catch((err) => {
                  console.warn(`remote-ssh: [${host}] baseline fetch failed:`, err)
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

              for (const it of items) {
                if (it.origin === 'subagent' && it.parentSessionId) {
                  subagentParents.set(namespaceRemoteId(host, it.sessionId), namespaceRemoteId(host, it.parentSessionId))
                  subagentParents.set(it.sessionId, it.parentSessionId)
                }
              }

              const namespacedWorkspaces = rawWorkspaces.map((ws) => ({
                ...ws,
                workspaceId: namespaceRemoteWorkspaceId(host, ws.cwd),
                name: readyCallers.length > 1 ? `[${host}] ${ws.name}` : ws.name,
                sessions: ws.sessions.map((s) => {
                  const pending = caller.getPendingInteractionsForSession(s.sessionId)
                  return {
                    ...s,
                    sessionId: namespaceRemoteId(host, s.sessionId),
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
                  pendingInteraction: pending.length > 0
                    ? (pending[0]?.event === 'user-questions/request' ? 'question' : true)
                    : false,
                }
              })

              const archivedSessionIds = (baseline?.archivedSessionIds ?? []).map((id) => namespaceRemoteId(host, id))
              const pinnedSessionIds = (baseline?.pinnedSessionIds ?? []).map((id) => namespaceRemoteId(host, id))

              return {
                host,
                workspaces: namespacedWorkspaces,
                sessions: validSessions,
                archivedSessionIds,
                pinnedSessionIds,
              }
            }))

            const aggregatedWorkspaces = hostSnapshots.flatMap((s) => s.workspaces)
            const aggregatedSessions = hostSnapshots.flatMap((s) => s.sessions)
            const aggregatedArchived = hostSnapshots.flatMap((s) => s.archivedSessionIds)
            const aggregatedPinned = hostSnapshots.flatMap((s) => s.pinnedSessionIds)

            sendJson(res, 200, {
              hosts: readyCallers.map((c) => c.host),
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
          const rawWorkspaces = groupSessionsByWorkspace(items, 50, validMap)
          const archivedSessionIds = baseline?.archivedSessionIds ?? []
          const pinnedSessionIds = baseline?.pinnedSessionIds ?? []
          const source = projectRemoteSourceSnapshot(hostLabel || 'remote', items)

          const validSessions = (validMap !== undefined
            ? items.filter((it) => validMap.has(it.cwd))
            : items
          ).map((it) => {
            const pending = caller.getPendingInteractionsForSession(it.sessionId)
            return pending.length > 0
              ? { ...it, pendingInteraction: pending[0]?.event === 'user-questions/request' ? 'question' : true }
              : it
          })

          const workspaces = rawWorkspaces.map((ws) => ({
            ...ws,
            sessions: ws.sessions.map((it) => {
              const pending = caller.getPendingInteractionsForSession(it.sessionId)
              return pending.length > 0
                ? { ...it, pendingInteraction: pending[0]?.event === 'user-questions/request' ? 'question' : true }
                : it
            }),
          }))

          for (const it of items) {
            if (it.origin === 'subagent' && it.parentSessionId) {
              subagentParents.set(it.sessionId, it.parentSessionId)
            }
          }

          sendJson(res, 200, {
            host: hostLabel || 'remote',
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
        sendJson(res, 200, { currentHosts, availableHosts })
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
          sendJson(res, 200, { ok: true, host: result.host, localPort: result.localPort })
        } catch (err) {
          sendJson(res, 500, {
            error: 'add-failed',
            message: err instanceof Error ? err.message : String(err),
          })
        }
      },
    }), 'remote-ssh: add host route')

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
            projections: (proj?.values as Record<string, unknown> | undefined) ?? {},
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
          const parentSessionId = body.parentSessionId
            ? resolveTarget(String(body.parentSessionId)).originalSessionId
            : subagentParents.get(rawSessionId) || subagentParents.get(sessionId)

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
          const parentSessionId = body.parentSessionId
            ? resolveTarget(String(body.parentSessionId)).originalSessionId
            : subagentParents.get(rawSessionId) || subagentParents.get(sessionId)

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
        const parentId = url.searchParams.get('parentId')
          ? resolveTarget(url.searchParams.get('parentId')!).originalSessionId
          : subagentParents.get(rawSessionId) || subagentParents.get(sessionId)

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

          const stream = caller.followSession({ address, assistantStream: true }, abortController.signal)

          for await (const frame of stream) {
            if (abortController.signal.aborted) break
            const payload = `data: ${JSON.stringify(frame)}\n\n`
            if (typeof res.write === 'function') {
              res.write(payload)
            }
          }
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

          const request = targetWsId !== undefined
            ? { workspaceId: targetWsId, ...(body.sessionId ? { sessionId: String(body.sessionId) } : {}) }
            : { cwd: targetCwd ?? '', ...(body.sessionId ? { sessionId: String(body.sessionId) } : {}) }

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
  })
}
