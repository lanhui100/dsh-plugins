/** Host half of dsh-plugin-remote-ssh: SSH tunnel lifecycle and remote DSH API proxy. */

import type { Context } from '@deepseek-ai/cordis'
import { SshTunnel } from './tunnel.ts'
import { RemoteCaller } from './remote.ts'
import { mountRemoteSshService } from './service.ts'
import type { Config } from './config.ts'

export { Config } from './config.ts'
export { SshTunnel } from './tunnel.ts'
export { RemoteCaller, RemoteAuthError, readLaunchToken } from './remote.ts'
export { listRemoteSessions, type RemoteSessionItem } from './sessions.ts'
export { RemoteSshService, mountRemoteSshService, type RemoteSessionListValue } from './service.ts'

/**
 * Activate the Host half: hold the SSH tunnel for the configured remote and
 * expose remote workspace/session reads to the Client half.
 * @param ctx - plugin context this entry is mounted in.
 * @param config - validated plugin configuration (SSH target and remote port).
 */
export function apply(ctx: Context, config: Config): void {
  const tunnel = new SshTunnel({ host: config.host, remotePort: config.remotePort, localPort: config.localPort })
  const caller = new RemoteCaller({ host: config.host, baseUrl: tunnel.baseUrl() })
  mountRemoteSshService(ctx)
  ctx.inject(['remoteSsh'], (scoped) => {
    const service = scoped.remoteSsh
    scoped.effect(() => {
      let stopped = false
      void (async () => {
        try {
          await tunnel.start()
          if (stopped) return
          service.setCaller(caller)
          scoped.logger?.info?.(`remote-ssh: tunnel ready (${config.host} -> ${tunnel.baseUrl()})`)
        } catch (error) {
          scoped.logger?.warn?.(`remote-ssh: tunnel failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      })()
      return () => {
        stopped = true
        void tunnel.dispose()
      }
    })
  })
}
