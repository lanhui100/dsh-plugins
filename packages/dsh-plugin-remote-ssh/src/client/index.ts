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

/** Host route for querying pending interactions of a remote session. */
export const SESSION_PENDING_INTERACTION_ROUTE = '/remote-ssh/pending-interaction'

/** Host route for responding to a pending interaction. */
export const SESSION_INTERACTION_RESPOND_ROUTE = '/remote-ssh/interaction-respond'

/** Host route for archiving a remote session. */
export const SESSION_ARCHIVE_ROUTE = '/remote-ssh/session-archive'

/** Host route for unarchiving a remote session. */
export const SESSION_UNARCHIVE_ROUTE = '/remote-ssh/session-unarchive'

/** Host route for pinning a remote session. */
export const SESSION_PIN_ROUTE = '/remote-ssh/session-pin'

/** Host route for unpinning a remote session. */
export const SESSION_UNPIN_ROUTE = '/remote-ssh/session-unpin'

/** Host route for renaming a remote session. */
export const SESSION_RENAME_ROUTE = '/remote-ssh/session-rename'


/** Host route for querying remote workspaces/home directories. */
export const REMOTE_WORKSPACES_ROUTE = '/remote-ssh/workspaces'

/** Host route for creating a remote workspace directory in home directory. */
export const ADD_WORKSPACE_ROUTE = '/remote-ssh/add-workspace'

/** Remote workspace/session projection poll interval. */
export const POLL_INTERVAL_MS = 60_000

export interface AskUserQuestionOption {
  readonly label: string
  readonly description?: string
}

export interface AskUserQuestionItem {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly header?: string
  readonly options?: readonly AskUserQuestionOption[]
  readonly multiSelect?: boolean
  readonly intent?: { readonly kind: string; readonly approve?: string; readonly callId?: string }
}

export interface PendingRemoteInteraction {
  readonly clientId?: string
  readonly eventId: string
  readonly sessionId: string
  readonly event?: string
  readonly questions: readonly AskUserQuestionItem[]
  readonly rawRequest?: Record<string, unknown>
  readonly createdAt?: number
}

export interface AskUserQuestionAnswerItem {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

export interface RemoteInteractionOutcome {
  readonly kind: 'result' | 'rejected' | 'next'
  readonly value?: { readonly answers: readonly AskUserQuestionAnswerItem[] }
  readonly error?: { readonly name: string; readonly message: string; readonly code?: string }
}

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
  readonly pendingInteraction?: string | boolean
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
    handleSessionStatus?(sessionId: string, running: boolean): void
    handleSessionActivity?(sessionId: string, updatedAt: number): void
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    workspaces: RemoteSshClientModels['workspaces']
    sessions: RemoteSshClientModels['sessions']
    remote: { session: Record<string, unknown>; workspace?: Record<string, unknown> }
    'remote.session': Record<string, unknown>
    'remote.workspace': Record<string, unknown>
  }
}

/**
 * Services the client entry needs before `apply` runs: the official
 * Workspace and Session client models plus the Remote session and workspace
 * namespaces this half wraps.
 */
export const inject = ['workspaces', 'sessions', 'remote', 'remote.session', 'remote.workspace']

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
 *
 * Performance contract (mirrors `client.js`): the Host snapshot is fanned out
 * only when the snapshot fingerprint changed — an unchanged poll result is
 * dropped before any model write, so a long-idle client never re-renders the
 * sidebar tree. DOM decorations are additionally coalesced to one pass per
 * animation frame by the title decorator.
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