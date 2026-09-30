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
