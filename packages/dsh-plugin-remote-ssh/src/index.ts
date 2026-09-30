/** Host half of dsh-plugin-remote-ssh: SSH tunnel lifecycle and remote DSH API proxy. */

import type { Context } from '@deepseek-ai/cordis'
import { SshTunnel } from './tunnel.ts'
import { RemoteCaller } from './remote.ts'
import { tryMountRemoteSshService } from './service.ts'
import { registerRemoteSshCommand } from './command.ts'
import type { Config } from './config.ts'

export { Config } from './config.ts'
export { SshTunnel } from './tunnel.ts'
export { RemoteCaller, RemoteAuthError, readLaunchToken } from './remote.ts'
export { listRemoteSessions, type RemoteSessionItem } from './sessions.ts'
export { RemoteSshService, tryMountRemoteSshService, type RemoteSessionListValue } from './service.ts'
export { registerRemoteSshCommand } from './command.ts'

/**
 * Activate the Host half: hold the SSH tunnel for the configured remote and
 * register the `/remote-ssh` command. The Typert Remote mount is best-effort.
 * @param ctx - plugin context this entry is mounted in.
 * @param config - validated plugin configuration (SSH target and remote port).
 */
export function apply(ctx: Context, config: Config): void {
  const tunnel = new SshTunnel({ host: config.host, remotePort: config.remotePort, localPort: config.localPort })
  const caller = new RemoteCaller({ host: config.host, baseUrl: tunnel.baseUrl() })
  let callerReady: RemoteCaller | undefined

  // Core path: the command works regardless of Typert/cordis instance sharing.
  registerRemoteSshCommand(ctx, () => callerReady)

  // Optional path: Typert Remote for the Client half. Degrades to a warning.
  const service = tryMountRemoteSshService(ctx)

  ctx.effect(() => {
    let stopped = false
    void (async () => {
      try {
        await tunnel.start()
        if (stopped) return
        callerReady = caller
        service?.setCaller(caller)
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