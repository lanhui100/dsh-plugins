/** Human command `/remote-ssh`: list remote sessions without any UI. */

import type { Context } from '@deepseek-ai/cordis'
import type { RemoteCaller } from './remote.ts'
import { listRemoteSessions } from './sessions.ts'

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
 * Register `/remote-ssh` on the host command registry.
 * @param ctx - plugin context carrying the command registry.
 * @param getCaller - resolve the tunnel caller (undefined while the tunnel is down).
 */
export function registerRemoteSshCommand(
  ctx: Context,
  getCaller: () => RemoteCaller | undefined,
): void {
  ctx.effect(() => ctx.commands.register({
    name: 'remote-ssh',
    description: 'List sessions on the remote DSH over the SSH tunnel',
    handler: async (invocation) => {
      if (invocation.signal.aborted) return { kind: 'error', text: 'Remote-SSH listing cancelled.' }
      const caller = getCaller()
      if (caller === undefined) return { kind: 'error', text: 'Remote tunnel is not ready yet.' }
      try {
        const items = await listRemoteSessions(caller)
        if (items.length === 0) return { kind: 'success', text: 'No remote sessions.' }
        const lines = items.slice(0, 30).map((item) =>
          `- ${item.sessionId} [${item.running ? 'running' : 'idle'}] ${item.title ?? '(untitled)'} (${item.cwd})`)
        const more = items.length > 30 ? `\n… and ${String(items.length - 30)} more` : ''
        return { kind: 'success', text: `Remote sessions (${String(items.length)}):\n${lines.join('\n')}${more}` }
      } catch (error) {
        return { kind: 'error', text: `Remote listing failed: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }))
}
