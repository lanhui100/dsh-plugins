/** Mount check: RemoteSshService mounts on a real Cordis context with tunnel-not-ready fallback. */

import { Context } from '@deepseek-ai/cordis'
import { mountRemoteSshService } from './lib/index.js'

const ctx = new Context()
mountRemoteSshService(ctx)
let settled
ctx.inject(['remoteSsh'], (scoped) => {
  settled = (async () => {
    const value = await scoped.remoteSsh.listSessions()
    console.log(`service mounted: remoteSsh, items=${String(value.items.length)}, error=${value.error ?? 'none'}`)
  })()
})
await settled
