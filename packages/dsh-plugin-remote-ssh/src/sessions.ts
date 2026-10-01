/** Remote session listing through the tunnel caller. */

import type { RemoteCaller } from './remote.ts'

export interface RemoteSessionItem {
  readonly sessionId: string
  readonly updatedAt: number
  readonly running: boolean
  readonly blank: boolean
  readonly cwd: string
  readonly title?: string
}

interface SessionListValue {
  readonly items: readonly RemoteSessionItem[]
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
  return items.map((item) => ({
    sessionId: String(item.sessionId),
    updatedAt: Number(item.updatedAt),
    running: Boolean(item.running),
    blank: Boolean(item.blank),
    cwd: String(item.cwd),
    title: typeof item.title === 'string'
      ? item.title
      : typeof (item as { projections?: { values?: { title?: unknown } } }).projections?.values?.title === 'string'
        ? (item as { projections: { values: { title: string } } }).projections.values.title
        : undefined,
  }))
}

/** One remote working directory with the sessions that ran in it. */
export interface RemoteWorkspaceGroup {
  /** Absolute remote directory shared by this group's sessions. */
  readonly cwd: string
  /** Display name: authoritative title or directory's final path segment. */
  readonly name: string
  /** Remote authoritative workspace ID if known from baseline. */
  readonly workspaceId?: string
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
