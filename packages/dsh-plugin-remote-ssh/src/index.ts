/** Host half of dsh-plugin-remote-ssh: SSH tunnel lifecycle and the /remote-ssh command. */

import type { Context } from '@deepseek-ai/cordis'
import { SshTunnel } from './tunnel.ts'
import { RemoteCaller } from './remote.ts'
import { registerRemoteSshCommand } from './command.ts'
import type { Config } from './config.ts'

export { Config } from './config.ts'
export { SshTunnel } from './tunnel.ts'
export { RemoteCaller, RemoteAuthError, readLaunchToken } from './remote.ts'
export { listRemoteSessions, type RemoteSessionItem } from './sessions.ts'
export { registerRemoteSshCommand } from './command.ts'

/**
 * Services this entry needs before `apply` runs.
 * Cordis resolves `inject` before activation, so `ctx.commands` is a real
 * service here. Without this declaration the accessor throws, the entry never
 * activates, and on the desktop that also costs the user's patch layer.
 */
export const inject = ['commands']

/**
 * Activate the Host half: hold the SSH tunnel for the configured remote and
 * register `/remote-ssh`. Both are self-contained — no Typert Remote — so the
 * entry cannot fail on a cross-instance cordis/typert mismatch.
 * @param ctx - plugin context this entry is mounted in.
 * @param config - validated plugin configuration (SSH target and remote port).
 */
export function apply(ctx: Context, config: Config): void {
  const tunnel = new SshTunnel({ host: config.host, remotePort: config.remotePort, localPort: config.localPort })
  const caller = new RemoteCaller({ host: config.host, baseUrl: tunnel.baseUrl() })
  let callerReady: RemoteCaller | undefined

  registerRemoteSshCommand(ctx, () => callerReady)

  ctx.effect(() => {
    let stopped = false
    void (async () => {
      try {
        await tunnel.start()
        if (stopped) return
        callerReady = caller
        // Warm the session cookie now so the first /remote-ssh skips the slow
        // SSH + token round-trip; a failure only leaves the jar empty (the
        // next invoke re-exchanges) and never fails the entry.
        void caller.warmup().catch((error: unknown) => {
          ctx.logger?.warn?.(`remote-ssh: cookie warmup failed: ${error instanceof Error ? error.message : String(error)}`)
        })
        ctx.logger?.info?.(`remote-ssh: tunnel ready (${config.host} -> ${tunnel.baseUrl()})`)
      } catch (error) {
        ctx.logger?.warn?.(`remote-ssh: tunnel failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
    return () => {
      stopped = true
      void tunnel.dispose()
    }
  })
}
