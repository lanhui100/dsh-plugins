/** Timing check: the /remote-ssh handler over the already-listening tunnel (39387). */

import { RemoteCaller, listRemoteSessions } from './lib/index.js'

const caller = new RemoteCaller({ host: 'dev', baseUrl: 'http://127.0.0.1:39387', requestTimeoutMs: 30_000 })

console.log('warmup start...')
const t0 = Date.now()
try {
  await caller.warmup()
  console.log(`warmup done in ${Date.now() - t0} ms`)
} catch (error) {
  console.log(`warmup FAILED: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const t1 = Date.now()
const items = await listRemoteSessions(caller, AbortSignal.timeout(30_000))
console.log(`listRemoteSessions in ${Date.now() - t1} ms -> ${items.length} sessions`)
console.log(`sample: ${items[0]?.sessionId} ${items[0]?.title ?? ''} (${items[0]?.cwd})`)
caller.dispose()

