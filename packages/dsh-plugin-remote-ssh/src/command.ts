/** Human command `/remote-ssh`: list remote sessions and dynamically add remote hosts. */

import type { Context } from '@deepseek-ai/cordis'
import type { RemoteCaller } from './remote.ts'
import { listRemoteSessions } from './sessions.ts'
import { RemoteHostManager } from './manager.ts'
import { getAvailableSshHosts, type SshHostInfo } from './ssh-config.ts'

/** Minimal command shapes (structural subset of the host command registry). */
interface CommandInvocationLike {
  readonly rawInput: string
  readonly signal: AbortSignal
}

interface CommandResultLike {
  readonly kind: 'success' | 'error'
  readonly text: string
}

export interface CommandRegistryLike {
  register(definition: {
    readonly name: string
    readonly description: string
    readonly handler: (invocation: CommandInvocationLike) => Promise<CommandResultLike> | CommandResultLike
  }): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    commands: CommandRegistryLike
  }
}

/**
 * Format a list of available candidate hosts nicely for terminal display.
 */
function formatAvailableHosts(hosts: readonly SshHostInfo[]): string {
  if (hosts.length === 0) {
    return '本地 ~/.ssh/config 中未找到已配置密钥的未添加主机。'
  }
  const lines = hosts.map((h, i) => {
    const details = [
      h.hostName ? `${h.hostName}:${String(h.port || 22)}` : undefined,
      h.user ? `user: ${h.user}` : undefined,
    ].filter(Boolean).join(', ')
    return `  ${i + 1}. ${h.host}${details ? ` (${details})` : ''} -> 输入 /remote-ssh add ${h.host}`
  })
  return `本地 ~/.ssh/config 中检测到以下已配置密钥的主机：\n${lines.join('\n')}\n\n使用方式: /remote-ssh add <主机名>`
}

/**
 * Register `/remote-ssh` on the host command registry.
 * @param ctx - plugin context carrying the command registry.
 * @param managerOrGetCaller - RemoteHostManager instance or legacy single-caller getter.
 * @param sshConfigPath - optional override path to .ssh/config for testing.
 */
export function registerRemoteSshCommand(
  ctx: Context,
  managerOrGetCaller: RemoteHostManager | (() => RemoteCaller | undefined),
  sshConfigPath?: string,
): void {
  const isManager = managerOrGetCaller instanceof RemoteHostManager

  ctx.effect(() => ctx.commands.register({
    name: 'remote-ssh',
    description: '查看远程 DSH 会话（添加主机请前往客户端设置页面）',
    handler: async (invocation) => {
      if (invocation.signal.aborted) return { kind: 'error', text: '操作已取消。' }

      const raw = invocation.rawInput.trim()
      if (raw.length > 0) {
        return {
          kind: 'error',
          text: '添加远程主机已移至客户端『设置』面板的『远程主机聚合』页面，请通过下拉列表选择并添加主机，不再支持通过命令行添加。',
        }
      }

      // Default: list sessions across ready hosts
      if (isManager) {
        const manager = managerOrGetCaller as RemoteHostManager
        const readyCallers = manager.getReadyCallers()
        const allHosts = manager.getHostNames()

        if (readyCallers.length === 0) {
          return {
            kind: 'error',
            text: `远程隧道尚在建立中 (已配置主机: ${allHosts.join(', ')})。请稍后重试，或前往客户端『设置』页面添加新主机。`,
          }
        }

        const sections: string[] = []
        for (const { host, caller } of readyCallers) {
          try {
            const items = await listRemoteSessions(caller, invocation.signal)
            if (items.length === 0) {
              sections.push(`[${host}] 暂无会话`)
            } else {
              const lines = items.slice(0, 15).map((item) =>
                `  - ${item.sessionId} [${item.running ? 'running' : 'idle'}] ${item.title ?? '(无标题)'} (${item.cwd})`
              )
              const more = items.length > 15 ? `\n  … 以及另外 ${String(items.length - 15)} 个会话` : ''
              sections.push(`[${host}] 远程会话 (${String(items.length)} 个):\n${lines.join('\n')}${more}`)
            }
          } catch (err) {
            sections.push(`[${host}] 会话列表获取失败: ${err instanceof Error ? err.message : String(err)}`)
          }
        }

        const footNote = `\n提示: 添加远程主机请前往客户端『设置 -> 远程主机聚合』页面，通过下拉选择本机 ~/.ssh/config 中已配置密钥的主机。`
        return { kind: 'success', text: `${sections.join('\n\n')}${footNote}` }
      }

      // Legacy single-caller fallback
      const caller = (managerOrGetCaller as () => RemoteCaller | undefined)()
      if (caller === undefined) return { kind: 'error', text: 'Remote tunnel is not ready yet.' }
      try {
        const items = await listRemoteSessions(caller, invocation.signal)
        if (items.length === 0) return { kind: 'success', text: 'No remote sessions.' }
        const lines = items.slice(0, 30).map((item) =>
          `- ${item.sessionId} [${item.running ? 'running' : 'idle'}] ${item.title ?? '(untitled)'} (${item.cwd})`)
        const more = items.length > 30 ? `\n… and ${String(items.length - 30)} more` : ''
        return { kind: 'success', text: `Remote sessions (${String(items.length)}):\n${lines.join('\n')}${more}` }
      } catch (error) {
        if (invocation.signal.aborted) return { kind: 'error', text: 'Remote-SSH listing cancelled.' }
        return { kind: 'error', text: `Remote listing failed: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }))
}
