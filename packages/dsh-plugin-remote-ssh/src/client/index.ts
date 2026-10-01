/**
 * Client half of dsh-plugin-remote-ssh — typed source of truth.
 *
 * The artifact the browser actually loads is the hand-maintained
 * `client.js` at the package root (DSH closure-factory format); this module
 * mirrors that contract for type checking and documentation. Change both
 * together, then run `smoke-client-bundle.mjs`.
 *
 * Integration model: contributes zero slots. The official WorkspaceBrowser
 * renders whatever `ctx.workspaces` / `ctx.sessions` publish, and the official
 * conversation assembles whatever `ctx.remote.session` streams. This half
 * publishes the remote snapshot into the official models and wraps the
 * session namespace so known remote ids are served from the tunnel.
 */

import type { Context } from '@deepseek-ai/cordis'

/** Host route serving the merged workspace/session snapshot, same origin as the page. */
export const SESSIONS_ROUTE = '/remote-ssh/sessions'

/** Host route serving one remote session's raw wire projections and event records. */
export const SESSION_RAW_ROUTE = '/remote-ssh/session-raw'

/** Remote workspace/session projection poll interval. */
export const POLL_INTERVAL_MS = 60_000

/** One remote session row as served by `SESSIONS_ROUTE`. */
export interface RemoteSessionRow {
  readonly sessionId: string
  readonly title?: string
  readonly running: boolean
  readonly blank: boolean
  readonly cwd: string
  readonly updatedAt: number
}

/** One remote workspace group as served by `SESSIONS_ROUTE`. */
export interface RemoteWorkspaceRow {
  readonly cwd: string
  readonly name: string
  readonly sessions: readonly RemoteSessionRow[]
}

/** The narrow official client-model surface this plugin drives. */
export interface RemoteSshClientModels {
  workspaces: {
    list: {
      upsertView(view: {
        readonly workspaceId: string
        readonly path: string
        readonly title: string
        readonly sessionIds: readonly string[]
        readonly createdAt: string
        readonly updatedAt: string
      }): void
      removeView(workspaceId: string): void
    }
  }
  sessions: {
    handleSessionAdded(summary: {
      readonly id: string
      readonly title?: string
      readonly displayTitle: string
      readonly cwd?: string
      readonly running: boolean
      readonly blank: boolean
      readonly updatedAt: number
      readonly retainedBy: Record<string, never>
    }): void
    handleSessionRemoved(sessionId: string): void
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    workspaces: RemoteSshClientModels['workspaces']
    sessions: RemoteSshClientModels['sessions']
    remote: { session: Record<string, unknown> }
    'remote.session': Record<string, unknown>
  }
}

/**
 * Services the client entry needs before `apply` runs: the official
 * Workspace and Session client models plus the Remote session namespace this
 * half wraps.
 */
export const inject = ['workspaces', 'sessions', 'remote', 'remote.session']

/**
 * Activate the integration: publish the remote snapshot into the official
 * models and wrap `ctx.remote.session` for remote interception.
 * @param ctx - client plugin context with the injected service edges.
 */
export function apply(ctx: Context): void {
  const restoreProxy = installSessionProxy(ctx)
  const timer = setInterval(() => { void reconcileRemoteSource(ctx) }, POLL_INTERVAL_MS)
  void reconcileRemoteSource(ctx)
  ctx.effect(() => () => {
    clearInterval(timer)
    restoreProxy()
    removeRemoteSource(ctx)
  })
}

/**
 * Sync the remote snapshot into the official workspace/session client models.
 * @param ctx - client plugin context.
 */
export function reconcileRemoteSource(ctx: Context): Promise<void> {
  void ctx
  return Promise.resolve()
}

/**
 * Wrap the `session` remote namespace methods; remote ids are served through
 * this plugin's Host route, local sessions pass through.
 * @param ctx - client plugin context.
 * @returns disposer restoring the original method getters.
 */
export function installSessionProxy(ctx: Context): () => void {
  void ctx
  return () => {}
}

/**
 * Remove the injected remote workspace/session rows from the official models.
 * @param ctx - client plugin context.
 */
export function removeRemoteSource(ctx: Context): void {
  void ctx
}