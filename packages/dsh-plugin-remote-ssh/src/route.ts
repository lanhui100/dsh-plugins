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
          const validMap = baseline !== undefined
            ? new Map(baseline.items.map((it) => [it.path, { workspaceId: it.workspaceId, title: it.title }]))
            : undefined
          const workspaces = groupSessionsByWorkspace(items, 50, validMap)
          const archivedSessionIds = baseline?.archivedSessionIds ?? []
          const pinnedSessionIds = baseline?.pinnedSessionIds ?? []
          const source = projectRemoteSourceSnapshot(hostLabel, items)
          sendJson(res, 200, {
            host: hostLabel,
            total: items.length,
            workspaces,
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
        const sessionId = new URL(urlStr, 'http://127.0.0.1').searchParams.get('id')
        if (sessionId === null || sessionId.trim() === '') {
          sendJson(res, 400, { error: 'missing-id', message: 'Query parameter "id" is required' })
          return
        }
        try {
          const proj = await caller.invoke<{ asOfSeq?: number; values?: unknown }>(
            'session/projections',
            { request: { sessionId } },
          )
          const asOfSeq = typeof proj?.asOfSeq === 'number' ? proj.asOfSeq : 0
          const page = asOfSeq > 0
            ? await caller.invoke<{ records?: readonly unknown[]; hasMore?: boolean }>(
              'session/page',
              { request: { address: { kind: 'session', sessionId }, throughSeq: asOfSeq, maxMessages: 200 } },
            )
            : undefined
          sendJson(res, 200, {
            sessionId,
            asOfSeq,
            header: { version: 0, id: sessionId, createdAt: Date.now(), isSeeded: false },
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
  })
}
