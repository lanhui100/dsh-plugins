/** Host half of dsh-plugin-remote-ssh: SSH tunnel lifecycle and the /remote-ssh command. */

import type { Context } from '@deepseek-ai/cordis'
import { SshTunnel } from './tunnel.ts'
import { RemoteCaller } from './remote.ts'
import { registerRemoteSshCommand } from './command.ts'
import { registerRemoteSshRoute } from './route.ts'
import { RemoteHostManager } from './manager.ts'
import type { Config } from './config.ts'

export { Config } from './config.ts'
export { SshTunnel } from './tunnel.ts'
export {
  RemoteCaller,
  RemoteAuthError,
  readLaunchToken,
  type RemoteInteractionQuestionOption,
  type RemoteInteractionQuestionItem,
  type RemotePendingInteraction,
} from './remote.ts'
export { listRemoteSessions, groupSessionsByWorkspace, type RemoteSessionItem, type RemoteWorkspaceGroup } from './sessions.ts'
export { registerRemoteSshCommand } from './command.ts'
export {
  resolveDefaultSshConfigPath,
  parseSshConfig,
  getAvailableSshHosts,
  type SshHostInfo,
  type GetAvailableHostsOptions,
} from './ssh-config.ts'
export { RemoteHostManager, type HostConfigItem } from './manager.ts'
export { RemoteLauncher, type RemoteLauncherOptions, type EnsureServiceResult } from './remote-launcher.ts'
export { getRemoteSessionDetail, type RemoteMessageItem, type RemoteSessionDetail } from './session-detail.ts'
export {
  registerRemoteSshRoute,
  SESSIONS_ROUTE,
  SESSION_DETAIL_ROUTE,
  SESSION_RAW_ROUTE,
  SESSION_PROMPT_ROUTE,
  SESSION_CANCEL_ROUTE,
  SESSION_FOLLOW_ROUTE,
  SESSION_CREATE_ROUTE,
  SESSION_PENDING_INTERACTION_ROUTE,
  SESSION_INTERACTION_RESPOND_ROUTE,
  SESSION_ARCHIVE_ROUTE,
  SESSION_UNARCHIVE_ROUTE,
  SESSION_PIN_ROUTE,
  SESSION_UNPIN_ROUTE,
  SESSION_RENAME_ROUTE,
  SESSION_SELECT_MODEL_ROUTE,
  SESSION_ATTACHMENT_ROUTE,
  SESSION_FILE_UPLOAD_ROUTE,
  AVAILABLE_HOSTS_ROUTE,
  ADD_HOST_ROUTE,
  REMOVE_HOST_ROUTE,
} from './route.ts'
export {
  REMOTE_SOURCE_KIND,
  namespaceRemoteId,
  namespaceRemoteWorkspaceId,
  projectRemoteSourceSnapshot,
  RemoteWorkspaceSourceAdapter,
  type RemoteSourceSession,
  type RemoteSourceSnapshot,
  type RemoteSourceWorkspace,
  type RemoteWorkspaceSource,
} from './source.ts'

/**
 * Services this entry needs before `apply` runs.
 * Cordis resolves `inject` before activation, so `ctx.commands` is a real
 * service here. Without this declaration the accessor throws, the entry never
 * activates, and on the desktop that also costs the user's patch layer.
 */
export const inject = ['commands']

/**
 * Activate the Host half: manage SSH tunnels for configured remote hosts,
 * dynamic discovery of unadded hosts from ~/.ssh/config, and register `/remote-ssh`.
 * @param ctx - plugin context this entry is mounted in.
 * @param config - validated plugin configuration (SSH target and remote port).
 */
export function apply(ctx: Context, config: Config): void {
  const manager = new RemoteHostManager({
    primaryHost: config.host,
    primaryRemotePort: config.remotePort,
    primaryLocalPort: config.localPort,
    onLoggerWarning: (msg) => ctx.logger?.warn?.(msg),
    onLoggerInfo: (msg) => ctx.logger?.info?.(msg),
  })

  registerRemoteSshCommand(ctx, manager)
  registerRemoteSshRoute(ctx, manager, config.host)

  ctx.effect(() => {
    void manager.startAll().catch((error: unknown) => {
      ctx.logger?.warn?.(`remote-ssh: startup error: ${error instanceof Error ? error.message : String(error)}`)
    })
    return () => {
      void manager.dispose()
    }
  })
}
