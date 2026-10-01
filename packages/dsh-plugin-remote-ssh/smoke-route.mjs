/**
 * Route smoke: the panel's data route answers with the remote workspace tree.
 *
 * Runs against the already-listening tunnel (default 39387) and drives the
 * registered handler with a minimal response double, so the whole host-side
 * panel path is exercised without the desktop.
 */

import { RemoteCaller, registerRemoteSshRoute, SESSIONS_ROUTE } from './lib/index.js'

const baseUrl = process.env.REMOTE_SSH_BASE_URL ?? 'http://127.0.0.1:39387'
const caller = new RemoteCaller({ host: process.env.REMOTE_SSH_HOST ?? 'dev', baseUrl, requestTimeoutMs: 30_000 })

let route
const ctx = {
  inject: (deps, callback) => {
    if (!deps.includes('webServer')) throw new Error(`unexpected inject deps: ${deps.join(',')}`)
    callback({
      webServer: { register: (value) => { route = value; return () => {} } },
      effect: (fn) => { fn(); return () => {} },
    })
  },
}

registerRemoteSshRoute(ctx, () => caller, 'dev')
console.log(`route: ${route?.kind} ${route?.path} (expected ${SESSIONS_ROUTE})`)

const captured = { status: 0, body: '' }
const res = {
  writeHead(status) { captured.status = status },
  end(body) { captured.body = body ?? '' },
}

const started = Date.now()
await route.handler({}, res)
console.log(`status: ${captured.status} in ${Date.now() - started} ms`)

const parsed = JSON.parse(captured.body)
console.log(`host: ${parsed.host} total: ${parsed.total} workspaces: ${parsed.workspaces.length}`)
for (const group of parsed.workspaces.slice(0, 5)) {
  console.log(`  - ${group.name} (${group.cwd}) total=${group.total} carried=${group.sessions.length}`)
}
const first = parsed.workspaces[0]?.sessions[0]
console.log(`  sample session: ${first?.sessionId} [${first?.running ? 'running' : 'idle'}] ${first?.title ?? ''}`)
