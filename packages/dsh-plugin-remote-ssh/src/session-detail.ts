/** Fetch and parse remote session messages and projections for conversation viewing. */

import type { RemoteCaller } from './remote.ts'

export interface RemoteMessageItem {
  readonly id: string
  readonly role: 'user' | 'assistant' | 'system'
  readonly text: string
  readonly time?: number
  readonly toolCalls?: readonly { readonly name: string; readonly args?: string }[]
}

export interface RemoteSessionDetail {
  readonly sessionId: string
  readonly title: string
  readonly asOfSeq: number
  readonly goal?: { readonly objective: string; readonly phase: string }
  readonly stats?: { readonly turns: number; readonly steps: number; readonly llmMs?: number }
  readonly messages: readonly RemoteMessageItem[]
}

interface RawProjections {
  readonly asOfSeq?: number
  readonly values?: {
    readonly title?: string
    readonly goal?: { readonly goal?: { readonly objective?: string; readonly phase?: string } }
    readonly sessionStats?: { readonly turns?: number; readonly steps?: number; readonly llmMs?: number }
  }
}

interface RawPageRecord {
  readonly type: string
  readonly event?: {
    readonly type: string
    readonly seq?: number
    readonly time?: number
    readonly data?: {
      readonly role?: string
      readonly content?: readonly { readonly type: string; readonly text?: string; readonly id?: string; readonly name?: string; readonly arguments?: string }[]
      readonly message?: {
        readonly role?: string
        readonly content?: readonly { readonly type: string; readonly text?: string; readonly id?: string; readonly name?: string; readonly arguments?: string }[]
      }
    }
  }
}

interface RawPage {
  readonly records?: readonly RawPageRecord[]
}

/**
 * Fetch detailed session projections and message history from the remote DSH.
 * @param caller - authenticated tunnel caller.
 * @param sessionId - target remote session identity.
 * @param signal - optional cancellation.
 */
export async function getRemoteSessionDetail(
  caller: RemoteCaller,
  sessionId: string,
  signal?: AbortSignal,
): Promise<RemoteSessionDetail> {
  const proj = await caller.invoke<RawProjections>(
    'session/projections',
    { request: { sessionId } },
    signal,
  )

  const asOfSeq = typeof proj?.asOfSeq === 'number' ? proj.asOfSeq : 0
  const title = proj?.values?.title ?? sessionId
  const rawGoal = proj?.values?.goal?.goal
  const goal = typeof rawGoal?.objective === 'string'
    ? { objective: rawGoal.objective, phase: rawGoal.phase ?? 'active' }
    : undefined
  const rawStats = proj?.values?.sessionStats
  const stats = typeof rawStats?.turns === 'number'
    ? { turns: rawStats.turns, steps: rawStats.steps ?? 0, llmMs: rawStats.llmMs }
    : undefined

  let messages: RemoteMessageItem[] = []
  if (asOfSeq > 0) {
    try {
      const page = await caller.invoke<RawPage>(
        'session/page',
        {
          request: {
            address: { kind: 'session', sessionId },
            throughSeq: asOfSeq,
            maxMessages: 50,
          },
        },
        signal,
      )

      if (Array.isArray(page?.records)) {
        for (const record of page.records) {
          const event = record.event
          if (event === undefined) continue

          if (event.type === 'user/message') {
            const rawContent = event.data?.content
            const textParts: string[] = []
            if (Array.isArray(rawContent)) {
              for (const part of rawContent) {
                if (part.type === 'text' && typeof part.text === 'string') {
                  textParts.push(part.text)
                }
              }
            }
            const text = textParts.join('\n\n').trim()
            if (text.length > 0) {
              messages.push({
                id: `user-${String(event.seq ?? event.time ?? messages.length)}`,
                role: 'user',
                text,
                time: event.time,
              })
            }
          } else if (event.type === 'assistant/message') {
            const msg = event.data?.message
            const rawContent = msg?.content ?? event.data?.content
            const textParts: string[] = []
            const toolCalls: { name: string; args?: string }[] = []

            if (Array.isArray(rawContent)) {
              for (const part of rawContent) {
                if (part.type === 'text' && typeof part.text === 'string') {
                  textParts.push(part.text)
                } else if (part.type === 'tool-call' && typeof part.name === 'string') {
                  toolCalls.push({ name: part.name, args: part.arguments })
                }
              }
            }

            const text = textParts.join('\n\n').trim()
            if (text.length > 0 || toolCalls.length > 0) {
              messages.push({
                id: `assistant-${String(event.seq ?? event.time ?? messages.length)}`,
                role: 'assistant',
                text,
                time: event.time,
                toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
              })
            }
          }
        }
      }
    } catch {
      // If history page fetch fails or session is empty, return whatever projections we have
    }
  }

  return {
    sessionId,
    title,
    asOfSeq,
    goal,
    stats,
    messages,
  }
}
