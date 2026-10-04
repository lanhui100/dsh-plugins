/**
 * Live selectModel smoke: proves the remote session/selectModel RPC reaches the
 * remote DSH for a real tunneled session instead of a local session/not-found.
 *
 * Zero side effects: picks the session's current (or the catalog default)
 * selection and re-selects the SAME provider/model, so no model actually changes.
 * Requires a live tunnel (REMOTE_SSH_BASE_URL default http://127.0.0.1:39387).
 */

import { RemoteCaller } from './lib/index.js'

const baseUrl = process.env.REMOTE_SSH_BASE_URL ?? 'http://127.0.0.1:39387'
const host = process.env.REMOTE_SSH_HOST ?? 'dev'
const caller = new RemoteCaller({ host, baseUrl, requestTimeoutMs: 30_000 })

try {
  await caller.warmup()
  console.log(`warmup ok for host=${host} baseUrl=${baseUrl}`)

  const list = await caller.invoke('session/list', { _request: {} })
  const items = Array.isArray(list?.items) ? list.items : []
  const ordinary = items.filter(
    (item) => item?.origin !== 'subagent' && !item?.parentSessionId,
  )
  if (ordinary.length === 0) throw new Error('no remote session available for verification')
  console.log(`remote sessions available: ${ordinary.length} (first: ${String(ordinary[0].sessionId).slice(0, 12)}…)`)

  // Read the first session's current model selection (no side effect) to learn
  // a valid provider/model for the re-selection verification.
  const first = ordinary[0]
  const firstProj = await caller.invoke('session/projections', { request: { sessionId: String(first.sessionId) } })
  const firstValues = (firstProj?.values ?? {})
  const firstSelection = firstValues.modelSelection?.next ?? firstValues.modelSelection?.lastUsed
  let selection = firstSelection
  if (!selection) {
    const catalog = await caller.invoke('session/modelCatalog', {})
    selection = catalog?.default
    console.log(`no durable selection on first session; using catalog default ${selection?.provider}/${selection?.model}`)
  }
  if (!selection?.provider || !selection?.model) {
    throw new Error('could not resolve a provider/model to verify against')
  }
  console.log(`verifying selectModel with SAME selection: ${selection.provider}/${selection.model}${selection.reasoningEffort ? ` (${selection.reasoningEffort})` : ''}`)

  // Walk sessions until one accepts the (same-value) selection. A
  // session/writer-held means the RPC correctly reached the REMOTE DSH but that
  // session is busy on the far side — the official UI surfaces it as
  // "session in use". The bug we are proving absent is a LOCAL
  // session/not-found (the pre-fix behavior).
  let succeeded = false
  let writerHeldSeen = 0
  for (const item of ordinary.slice(0, 20)) {
    const sessionId = String(item.sessionId)
    try {
      const result = await caller.invoke('session/selectModel', {
        request: {
          sessionId,
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
        },
      })
      const selected = result?.selected
      if (!selected || selected.provider !== selection.provider || selected.model !== selection.model) {
        throw new Error(`selectModel returned unexpected value: ${JSON.stringify(result)}`)
      }
      console.log(`selectModel ok on ${sessionId.slice(0, 12)}… -> selected ${selected.provider}/${selected.model}`)
      succeeded = true
      break
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('session/writer-held')) {
        writerHeldSeen += 1
        console.log(`  ${sessionId.slice(0, 12)}… writer-held on remote (session busy) — skipping`)
        continue
      }
      throw error
    }
  }
  if (!succeeded) {
    if (writerHeldSeen > 0) {
      console.error(
        `all sampled remote sessions were writer-held (${writerHeldSeen}); the RPC DID reach the remote DSH ` +
        '(no session/not-found), but none accepted a same-value re-selection right now.',
      )
      process.exitCode = 1
    } else {
      throw new Error('no remote session accepted the selectModel RPC')
    }
  } else {
    console.log('all smoke-select-model-live assertions passed cleanly (no session/not-found)')
  }
} catch (error) {
  console.error(`selectModel verification failed: ${error instanceof Error ? error.message : String(error)}`)
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('session/not-found')) {
    console.error('BUG REPRODUCED: remote session/selectModel resolved to a LOCAL session/not-found')
  }
  process.exitCode = 1
} finally {
  caller.dispose?.()
}
