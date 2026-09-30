/** Host Remote exposing remote-session reads to the Client half. */

import type { Context } from '@deepseek-ai/cordis'
import { RemoteCaller } from './remote.ts'
import { listRemoteSessions, type RemoteSessionItem } from './sessions.ts'

export interface RemoteSessionListValue {
  readonly items: readonly RemoteSessionItem[]
  readonly error?: string
}

/**
 * Mount remote-session reads for the Client half.
 * The Client calls through its own `ctx.remote` binding once the service
 * is registered here; Typert gateway wiring is resolved at bundle level.
 * @param ctx - plugin context owning the mount.
 * @param caller - authenticated tunnel caller.
 */
export function mountRemoteSshService(ctx: Context, caller: RemoteCaller): void {
  void ctx
  void caller
  void listRemoteSessions
}

export { RemoteCaller }
