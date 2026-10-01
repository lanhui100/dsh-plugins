/** Read-only HTTP route feeding the browser panel from the remote DSH. */

import type { Context } from '@deepseek-ai/cordis'
import type { RemoteCaller } from './remote.ts'
import { groupSessionsByWorkspace, listRemoteSessions } from './sessions.ts'
import { projectRemoteSourceSnapshot } from './source.ts'
import { getRemoteSessionDetail } from './session-detail.ts'

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
 * Register the read-only session route the browser panel reads.
 *
 * `webServer` is injected optionally: a composition without a web server keeps
 * the entry active (the command and tunnel still work) and simply serves no
 * panel data. The route answers on the harness's own loopback origin, so the
 * page fetches it same-origin without any token handling in the browser.
 * @param ctx - plugin context owning the route registration.
 * @param getCaller - resolve the tunnel caller (undefined while the tunnel is down).
 * @param hostLabel - configured SSH host alias, reported to the panel as the workspace owner.
 */
export function registerRemoteSshRoute(
  ctx: Context,
  getCaller: () => RemoteCaller | undefined,
  hostLabel: string,
): void {
  const subagentParents = new Map<string, string>()
  const pathToRemoteWorkspaceId = new Map<string, string>()

  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: SESSIONS_ROUTE,
      handler: async (_req, res) => {
        const caller = getCaller()
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
          const workspaces = groupSessionsByWorkspace(items, 50, validMap)
          const archivedSessionIds = baseline?.archivedSessionIds ?? []
          const pinnedSessionIds = baseline?.pinnedSessionIds ?? []
          const source = projectRemoteSourceSnapshot(hostLabel, items)

          const validSessions = validMap !== undefined
            ? items.filter((it) => validMap.has(it.cwd))
            : items

          for (const it of items) {
            if (it.origin === 'subagent' && it.parentSessionId) {
              subagentParents.set(it.sessionId, it.parentSessionId)
            }
          }

          sendJson(res, 200, {
            host: hostLabel,
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
      path: SESSION_DETAIL_ROUTE,
      handler: async (req, res) => {
        const caller = getCaller()
        if (caller === undefined) {
          sendJson(res, 503, { error: 'tunnel-not-ready' })
          return
        }
        const urlStr = typeof (req as { url?: string }).url === 'string'
          ? (req as { url: string }).url
          : '/'
        const sessionId = new URL(urlStr, 'http://127.0.0.1').searchParams.get('id')
        if (sessionId === null || sessionId.trim() === '') {
          sendJson(res, 400, { error: 'missing-id', message: 'Query parameter "id" is required' })
          return
        }
        try {
          const detail = await getRemoteSessionDetail(caller, sessionId)
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
        const caller = getCaller()
        if (caller === undefined) {
          sendJson(res, 503, { error: 'tunnel-not-ready' })
          return
        }
        const urlStr = typeof (req as { url?: string }).url === 'string'
          ? (req as { url: string }).url
          : '/'
        const url = new URL(urlStr, 'http://127.0.0.1')
        const sessionId = url.searchParams.get('id')
        const queryParentId = url.searchParams.get('parentId')
        if (sessionId === null || sessionId.trim() === '') {
          sendJson(res, 400, { error: 'missing-id', message: 'Query parameter "id" is required' })
          return
        }
        let resolvedParentId = (queryParentId && queryParentId.trim() !== '')
          ? queryParentId.trim()
          : subagentParents.get(sessionId)

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
            sessionId,
            asOfSeq,
            header: {
              version: 0,
              id: sessionId,
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
        const caller = getCaller()
        if (caller === undefined) {
          sendJson(res, 503, { ok: false, error: { message: 'tunnel-not-ready' } })
          return
        }
        try {
          const body = await readJsonBody(req)
          const sessionId = String(body.sessionId ?? '')
          const parentSessionId = body.parentSessionId ? String(body.parentSessionId) : subagentParents.get(sessionId)
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
          sendJson(res, 200, { ok: true, value: result ?? { accepted: true } })
        } catch (error) {
          sendJson(res, 200, {
            ok: false,
            error: { message: error instanceof Error ? error.message : String(error) },
          })
        }
      },
    }), 'remote-ssh: prompt route')

    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: SESSION_CANCEL_ROUTE,
      handler: async (req, res) => {
        const caller = getCaller()
        if (caller === undefined) {
          sendJson(res, 503, { ok: false, error: { message: 'tunnel-not-ready' } })
          return
        }
        try {
          const body = await readJsonBody(req)
          const sessionId = String(body.sessionId ?? '')
          const parentSessionId = body.parentSessionId ? String(body.parentSessionId) : subagentParents.get(sessionId)

          let result: unknown
          if (parentSessionId !== undefined) {
            result = await caller.invoke('subagents/interruptByParent', {
              childSessionId: sessionId,
              parentSessionId,
              mode: 'continuable',
            })
          } else {
            result = await caller.invoke('session/cancel', {
              request: { sessionId },
            })
          }
          sendJson(res, 200, { ok: true, value: result ?? { accepted: true } })
        } catch (error) {
          sendJson(res, 200, {
            ok: false,
            error: { message: error instanceof Error ? error.message : String(error) },
          })
        }
      },
    }), 'remote-ssh: cancel route')

    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: SESSION_FOLLOW_ROUTE,
      handler: async (req, res) => {
        const caller = getCaller()
        if (caller === undefined) {
          sendJson(res, 503, { error: 'tunnel-not-ready' })
          return
        }
        const urlStr = typeof (req as { url?: string }).url === 'string'
          ? (req as { url: string }).url
          : '/'
        const url = new URL(urlStr, 'http://127.0.0.1')
        const sessionId = url.searchParams.get('id')
        const queryParentId = url.searchParams.get('parentId')
        if (sessionId === null || sessionId.trim() === '') {
          sendJson(res, 400, { error: 'missing-id', message: 'Query parameter "id" is required' })
          return
        }
        const resolvedParentId = (queryParentId && queryParentId.trim() !== '')
          ? queryParentId.trim()
          : subagentParents.get(sessionId)

        const address = resolvedParentId !== undefined
          ? { kind: 'subagent', parentSessionId: resolvedParentId, childSessionId: sessionId, mode: 'unknown' }
          : { kind: 'session', sessionId }

        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          'connection': 'keep-alive',
        })

        const ac = new AbortController()
        const incoming = req as { on?: (event: string, cb: () => void) => void }
        incoming.on?.('close', () => ac.abort())

        try {
          const stream = caller.followSession({ address, assistantStream: true }, ac.signal)
          for await (const frame of stream) {
            if (typeof res.write === 'function') {
              res.write(`data: ${JSON.stringify(frame)}\n\n`)
            }
          }
        } catch (err) {
          if (!ac.signal.aborted) {
            console.warn('remote-ssh: follow stream relay error:', err)
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
        const caller = getCaller()
        if (caller === undefined) {
          sendJson(res, 503, { ok: false, error: { message: 'tunnel-not-ready' } })
          return
        }
        try {
          const body = await readJsonBody(req)
          let targetCwd = typeof body.cwd === 'string' ? body.cwd : undefined
          let targetWsId = typeof body.workspaceId === 'string' ? body.workspaceId : undefined

          if (targetWsId && targetWsId.startsWith('remote:')) {
            targetCwd = targetWsId.slice('remote:'.length)
            targetWsId = undefined
          }

          let realWsId: string | undefined
          if (targetWsId !== undefined && !targetWsId.startsWith('remote:')) {
            realWsId = targetWsId
          } else if (targetCwd !== undefined) {
            realWsId = pathToRemoteWorkspaceId.get(targetCwd)
            if (realWsId === undefined) {
              const baseline = await caller.fetchWorkspaceBaseline().catch(() => undefined)
              if (baseline !== undefined) {
                for (const it of baseline.items) {
                  pathToRemoteWorkspaceId.set(it.path, it.workspaceId)
                }
                realWsId = pathToRemoteWorkspaceId.get(targetCwd)
              }
            }
          }

          const request = realWsId !== undefined
            ? { workspaceId: realWsId, ...(body.sessionId ? { sessionId: String(body.sessionId) } : {}) }
            : { cwd: targetCwd ?? '', ...(body.sessionId ? { sessionId: String(body.sessionId) } : {}) }

          const result = await caller.invoke<{ sessionId: string; agentPreset?: string }>(
            'session/create',
            { request },
          )
          sendJson(res, 200, { ok: true, value: result })
        } catch (error) {
          sendJson(res, 200, {
            ok: false,
            error: { message: error instanceof Error ? error.message : String(error) },
          })
        }
      },
    }), 'remote-ssh: session create route')
  })
}
