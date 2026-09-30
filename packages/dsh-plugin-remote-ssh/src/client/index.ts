/** Client half of dsh-plugin-remote-ssh: sidebar entry for the remote instance. */

import type { Context } from '@deepseek-ai/cordis'

/**
 * Activate the Client half: register the remote-workspace UI seats.
 * @param ctx - client plugin context this entry is mounted in.
 */
export function apply(ctx: Context): void {
  ctx.logger?.info?.('remote-ssh: client half mounted')
}
