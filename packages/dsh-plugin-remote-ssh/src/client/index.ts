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

/** Host route for sending prompts to remote sessions. */
export const SESSION_PROMPT_ROUTE = '/remote-ssh/prompt'

/** Host route for canceling remote sessions. */
export const SESSION_CANCEL_ROUTE = '/remote-ssh/cancel'

/** Host route for streaming remote session follow frames via SSE. */
export const SESSION_FOLLOW_ROUTE = '/remote-ssh/session-follow'

/** Host route for creating a session in a remote workspace. */
export const SESSION_CREATE_ROUTE = '/remote-ssh/create'

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
  readonly origin?: string
  readonly parentSessionId?: string
  readonly projections?: {
    readonly kind?: string
    readonly asOfSeq?: number
    readonly values?: Record<string, unknown>
  }
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
      items?: readonly unknown[]
      removedIds?: Set<string>
      archivedSessionIds?: readonly string[]
      replaceBaseline?(baseline: unknown): void
      replaceArchived?(archivedSessionIds: readonly string[]): void
      installArchived?(archivedSessionIds: readonly string[]): void
      invalidate?(): void
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
      readonly sessionId: string
      readonly title?: string
      readonly displayTitle: string
      readonly cwd?: string
      readonly running: boolean
      readonly blank: boolean
      readonly updatedAt: number
      readonly origin?: string
      readonly parentId?: string
      readonly parentSessionId?: string
      readonly projections?: {
        readonly kind?: string
        readonly asOfSeq?: number
        readonly values?: Record<string, unknown>
      }
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
  const restoreGuardian = installWorkspaceGuardian(ctx)
  const timer = setInterval(() => { void reconcileRemoteSource(ctx) }, POLL_INTERVAL_MS)
  void reconcileRemoteSource(ctx)
  ctx.effect(() => () => {
    clearInterval(timer)
    restoreProxy()
    restoreGuardian()
    removeRemoteSource(ctx)
  })
}

/**
 * Intercept replaceBaseline on the official model so remote workspaces persist
 * across baseline stream resets.
 * @param ctx - client plugin context.
 * @returns disposer restoring the original method.
 */
export function installWorkspaceGuardian(ctx: Context): () => void {
  void ctx
  return () => {}
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