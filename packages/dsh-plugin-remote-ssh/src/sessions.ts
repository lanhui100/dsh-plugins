/** Remote session listing through the tunnel caller. */

import type { RemoteCaller } from './remote.ts'

export interface RemoteSessionItem {
  readonly sessionId: string
  readonly updatedAt: number
  readonly running: boolean
  readonly blank: boolean
  readonly cwd: string
  readonly title?: string
  readonly origin?: string
  readonly parentSessionId?: string
  readonly projections?: {
    readonly kind?: string
    readonly asOfSeq?: number
    readonly values?: Record<string, unknown>
  }
}

interface SessionListValue {
  readonly items: readonly (RemoteSessionItem & {
    readonly projections?: {
      readonly kind?: string
      readonly asOfSeq?: number
      readonly values?: Record<string, unknown>
    }
  })[]
}

/**
 * List visible sessions on the remote DSH without resuming any Agent.
 * @param caller - authenticated tunnel caller.
 * @param signal - optional cancellation passed through to the RPC fetch.
 * @returns remote session summaries ordered by activity.
 */
export async function listRemoteSessions(
  caller: RemoteCaller,
  signal?: AbortSignal,
): Promise<readonly RemoteSessionItem[]> {
  const value = await caller.invoke<SessionListValue>('session/list', { _request: {} }, signal)
  const items = value?.items
  if (!Array.isArray(items)) {
    throw new Error('remote-ssh: remote session/list returned no items array')
  }
  return items.map((item) => {
    const rawProj = item.projections
    let prunedProj: { readonly kind?: string; readonly asOfSeq?: number; readonly values?: Record<string, unknown> } | undefined
    if (rawProj && typeof rawProj === 'object' && rawProj.values && typeof rawProj.values === 'object') {
      const v: Record<string, unknown> = {}
      if (rawProj.values.title !== undefined) v.title = rawProj.values.title
      if (rawProj.values.subagentCatalog !== undefined) v.subagentCatalog = rawProj.values.subagentCatalog
      if (rawProj.values.agentTeam !== undefined) v.agentTeam = rawProj.values.agentTeam
      if (rawProj.values.subagent !== undefined) v.subagent = rawProj.values.subagent
      if (rawProj.values.modelSelection !== undefined) v.modelSelection = rawProj.values.modelSelection
      prunedProj = {
        kind: typeof rawProj.kind === 'string' ? rawProj.kind : 'cached',
        asOfSeq: typeof rawProj.asOfSeq === 'number' ? rawProj.asOfSeq : undefined,
        values: v,
      }
    }
    const rawTitle = typeof item.title === 'string'
      ? item.title
      : typeof rawProj?.values?.title === 'string'
        ? rawProj.values.title
        : undefined
    return {
      sessionId: String(item.sessionId),
      updatedAt: Number(item.updatedAt),
      running: Boolean(item.running),
      blank: Boolean(item.blank),
      cwd: String(item.cwd),
      title: rawTitle,
      origin: typeof item.origin === 'string' ? item.origin : undefined,
      parentSessionId: typeof item.parentSessionId === 'string' ? item.parentSessionId : undefined,
      projections: prunedProj,
    }
  })
}

/** One remote working directory with the sessions that ran in it. */
export interface RemoteWorkspaceGroup {
  /** Absolute remote directory shared by this group's sessions. */
  readonly cwd: string
  /** Display name: authoritative title or directory's final path segment. */
  readonly name: string
  /** Remote authoritative workspace ID if known from baseline. */
  readonly workspaceId?: string
  /** Authoritative namespaced session IDs belonging to this workspace. */
  readonly sessionIds?: readonly string[]
  /** Sessions in this directory, most recently active first. */
  readonly sessions: readonly RemoteSessionItem[]
  /** Total sessions in this directory before any display cap. */
  readonly total: number
}

/** Final path segment of a POSIX or Windows path; `/` and `C:\` fall back to the raw value. */
function directoryName(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return at === -1 || at === trimmed.length - 1 ? trimmed : trimmed.slice(at + 1)
}

/**
 * Group remote sessions into "remote workspaces" by working directory.
 *
 * If `validWorkspaces` is provided, groups outside the authoritative baseline
 * (e.g. deleted or transient workspaces) are excluded.
 *
 * @param items - sessions as returned by {@link listRemoteSessions}.
 * @param limitPerGroup - maximum sessions carried per group (0 or less keeps all).
 * @param validWorkspaces - optional map of authoritative paths to metadata.
 * @returns groups ordered by session count, then by name.
 */
export function groupSessionsByWorkspace(
  items: readonly RemoteSessionItem[],
  limitPerGroup = 50,
  validWorkspaces?: ReadonlyMap<string, { readonly workspaceId: string; readonly title?: string }>,
): readonly RemoteWorkspaceGroup[] {
  const groups = new Map<string, RemoteSessionItem[]>()
  if (validWorkspaces !== undefined) {
    for (const cwd of validWorkspaces.keys()) {
      groups.set(cwd, [])
    }
  }

  for (const item of items) {
    if (validWorkspaces !== undefined && !validWorkspaces.has(item.cwd)) {
      continue
    }
    // Subagents must never be grouped under workspace folders directly.
    if (item.origin === 'subagent') {
      continue
    }
    const bucket = groups.get(item.cwd)
    if (bucket === undefined) groups.set(item.cwd, [item])
    else bucket.push(item)
  }

  return [...groups]
    .map(([cwd, sessions]) => {
      const ordered = [...sessions].sort((left, right) => right.updatedAt - left.updatedAt)
      const meta = validWorkspaces?.get(cwd)
      const customTitle = meta?.title?.trim()
      return {
        cwd,
        name: customTitle && customTitle.length > 0 ? customTitle : directoryName(cwd),
        workspaceId: meta?.workspaceId,
        total: ordered.length,
        sessions: limitPerGroup > 0 ? ordered.slice(0, limitPerGroup) : ordered,
      }
    })
    .sort((left, right) => right.total - left.total || left.name.localeCompare(right.name))
}
