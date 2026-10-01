/** Remote workspace source projection shared by the Host route and future official UI adapter. */

import type { RemoteCaller } from './remote.ts'
import { groupSessionsByWorkspace, listRemoteSessions, type RemoteSessionItem } from './sessions.ts'

/** A stable namespace for one remote source. */
export const REMOTE_SOURCE_KIND = 'remote' as const

/** Session identity presented to a merged local/remote client catalog. */
export interface RemoteSourceSession {
  /** Namespaced ID safe to place beside local Session IDs. */
  readonly id: string
  /** Original identity on the remote DSH. */
  readonly remoteSessionId: string
  readonly title?: string
  readonly updatedAt: number
  readonly running: boolean
  readonly blank: boolean
  readonly cwd: string
}

/** Workspace identity presented to a merged local/remote client catalog. */
export interface RemoteSourceWorkspace {
  /** Namespaced ID safe to place beside local Workspace IDs. */
  readonly id: string
  /** Original remote working directory, used as the stable grouping key. */
  readonly cwd: string
  /** Directory basename used by the official Workspace row. */
  readonly title: string
  readonly sessionIds: readonly string[]
}

/** One immutable snapshot a future official Workspace source adapter can consume. */
export interface RemoteSourceSnapshot {
  readonly sourceId: string
  readonly label: string
  readonly status: 'loading' | 'ready' | 'error'
  readonly total: number
  readonly workspaces: readonly RemoteSourceWorkspace[]
  readonly sessions: readonly RemoteSourceSession[]
  readonly error?: string
}

/** Read-only source contract for the official Workspace UI extension. */
export interface RemoteWorkspaceSource {
  readonly id: string
  readonly label: string
  getSnapshot(): RemoteSourceSnapshot
  subscribe(listener: () => void): () => void
  refresh(signal?: AbortSignal): Promise<RemoteSourceSnapshot>
}

/**
 * Namespace an opaque remote identity without changing the original value.
 * `encodeURIComponent` keeps host and remote ids unambiguous in merged maps.
 */
export function namespaceRemoteId(host: string, remoteId: string): string {
  return `${REMOTE_SOURCE_KIND}:${encodeURIComponent(host)}:${encodeURIComponent(remoteId)}`
}

/** Stable synthetic Workspace ID for a remote working directory. */
export function namespaceRemoteWorkspaceId(host: string, cwd: string): string {
  return namespaceRemoteId(host, `workspace:${cwd}`)
}

/**
 * Project the existing remote session-list response into a source snapshot.
 * @param host - SSH alias that owns the source.
 * @param items - remote sessions returned by `session/list`.
 * @returns namespaced sessions and cwd-backed synthetic workspaces.
 */
export function projectRemoteSourceSnapshot(
  host: string,
  items: readonly RemoteSessionItem[],
): RemoteSourceSnapshot {
  const groups = groupSessionsByWorkspace(items, 0)
  const sessions = items.map((item) => ({
    id: namespaceRemoteId(host, item.sessionId),
    remoteSessionId: item.sessionId,
    title: item.title,
    updatedAt: item.updatedAt,
    running: item.running,
    blank: item.blank,
    cwd: item.cwd,
  }))
  const byRemoteId = new Map(sessions.map(session => [session.remoteSessionId, session.id]))
  return {
    sourceId: host,
    label: `远程工作区: ${host}`,
    status: 'ready',
    total: sessions.length,
    workspaces: groups.map((group) => ({
      id: namespaceRemoteWorkspaceId(host, group.cwd),
      cwd: group.cwd,
      title: group.name,
      sessionIds: group.sessions.flatMap(session => {
        const id = byRemoteId.get(session.sessionId)
        return id === undefined ? [] : [id]
      }),
    })),
    sessions,
  }
}

/** Mutable Host-side source adapter with stable snapshot and subscription identity. */
export class RemoteWorkspaceSourceAdapter implements RemoteWorkspaceSource {
  readonly id: string
  readonly label: string
  private readonly host: string
  private readonly caller: RemoteCaller
  private snapshot: RemoteSourceSnapshot
  private readonly listeners = new Set<() => void>()

  constructor(
    host: string,
    caller: RemoteCaller,
  ) {
    this.host = host
    this.caller = caller
    this.id = host
    this.label = `远程工作区: ${host}`
    this.snapshot = {
      sourceId: host,
      label: this.label,
      status: 'loading',
      total: 0,
      workspaces: [],
      sessions: [],
    }
  }

  getSnapshot(): RemoteSourceSnapshot {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async refresh(signal?: AbortSignal): Promise<RemoteSourceSnapshot> {
    this.snapshot = { ...this.snapshot, status: 'loading', error: undefined }
    this.notify()
    try {
      const items = await listRemoteSessions(this.caller, signal)
      this.snapshot = projectRemoteSourceSnapshot(this.host, items)
    } catch (error) {
      this.snapshot = {
        ...this.snapshot,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      }
    }
    this.notify()
    return this.snapshot
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }
}
