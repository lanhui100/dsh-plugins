/** Host Remote exposing remote-session reads to the Client half (optional Typert mount). */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteCaller } from './remote.ts'
import { listRemoteSessions, type RemoteSessionItem } from './sessions.ts'

export interface RemoteSessionListValue {
  readonly items: readonly RemoteSessionItem[]
  readonly error?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    remoteSsh?: RemoteSshService
  }
}

/**
 * Host Remote through which the Client half reads remote sessions.
 * The tunnel caller is injected after construction (tunnel readiness is
 * asynchronous while service construction is synchronous).
 */
export class RemoteSshService extends TypertRemoteService {
  private caller: RemoteCaller | undefined

  constructor(ctx: Context) {
    super(ctx, 'remoteSsh')
  }

  /** Attach the authenticated tunnel caller once the tunnel is ready. */
  setCaller(caller: RemoteCaller): void {
    this.caller = caller
  }

  /**
   * List visible sessions on the remote DSH without resuming any Agent.
   * @returns remote session summaries, or an error value when the tunnel or remote is down.
   */
  @Remote('listSessions')
  async listSessions(): Promise<RemoteSessionListValue> {
    const caller = this.caller
    if (caller === undefined) {
      return { items: [], error: 'tunnel-not-ready' }
    }
    try {
      return { items: await listRemoteSessions(caller) }
    } catch (error) {
      return { items: [], error: error instanceof Error ? error.message : String(error) }
    }
  }
}

/**
 * Best-effort Typert Remote mount. The plugin's core value (the `/remote-ssh`
 * command and the SSH tunnel) does not depend on this mount: a cross-instance
 * cordis/typert mismatch (plugin-local copy vs host runtime copy) must degrade
 * to a warning instead of breaking apply. Returns the mounted service when
 * available, `undefined` when Typert/Cordis cannot share their instances.
 * @param ctx - plugin context owning the mount.
 */
export function tryMountRemoteSshService(ctx: Context): RemoteSshService | undefined {
  try {
    ctx.plugin(RemoteSshService)
    const service = (ctx as { get?: (name: string) => unknown }).get?.('remoteSsh') as
      | RemoteSshService
      | undefined
    return service
  } catch (error) {
    ctx.logger?.warn?.(
      `remote-ssh: Typert Remote mount skipped (cross-instance cordis/typert): ${error instanceof Error ? error.message : String(error)}`,
    )
    return undefined
  }
}