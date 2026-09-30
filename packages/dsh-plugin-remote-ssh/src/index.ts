/** Host half of dsh-plugin-remote-ssh: SSH tunnel lifecycle and remote DSH API proxy. */

import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.ts'

export { Config } from './config.ts'

/**
 * Activate the Host half: hold the SSH tunnel for the configured remote and
 * expose remote workspace/session reads to the Client half.
 * @param ctx - plugin context this entry is mounted in.
 * @param config - validated plugin configuration (SSH target and remote port).
 */
export function apply(ctx: Context, config: Config): void {
  ctx.logger?.info?.(`remote-ssh: host half mounted (host=${config.host})`)
}
