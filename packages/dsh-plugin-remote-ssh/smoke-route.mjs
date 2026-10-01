/**
 * Route smoke: the panel's data routes answer with the remote workspace tree and session detail.
 *
 * Runs against the already-listening tunnel (default 39387) and drives the
 * registered handlers with minimal response doubles.
 */

import { RemoteCaller, registerRemoteSshRoute, SESSIONS_ROUTE, SESSION_DETAIL_ROUTE } from './lib/index.js'

const baseUrl = process.env.REMOTE_SSH_BASE_URL ?? 'http://127.0.0.1:39387'
const caller = new RemoteCaller({ host: process.env.REMOTE_SSH_HOST ?? 'dev', baseUrl, requestTimeoutMs: 30_000 })

const routes = new Map()
const ctx = {
  inject: (deps, callback) => {
    if (!deps.includes('webServer')) throw new Error(`unexpected inject deps: ${deps.join(',')}`)
    callback({
      webServer: {
        register: (value) => {
          routes.set(value.path, value)
          return () => {}
        },
      },
      effect: (fn) => { fn(); return () => {} },
    })
  },
}

registerRemoteSshRoute(ctx, () => caller, 'dev')
console.log(`registered routes: ${[...routes.keys()].join(', ')}`)

// 1. Test sessions tree route
const sessionsRoute = routes.get(SESSIONS_ROUTE)
if (!sessionsRoute) throw new Error(`missing route: ${SESSIONS_ROUTE}`)

let captured = { status: 0, body: '' }
let res = {
  writeHead(status) { captured.status = status },
  end(body) { captured.body = body ?? '' },
}

let started = Date.now()
await sessionsRoute.handler({}, res)
console.log(`sessions status: ${captured.status} in ${Date.now() - started} ms`)

const parsed = JSON.parse(captured.body)
console.log(`host: ${parsed.host} total: ${parsed.total} workspaces: ${parsed.workspaces.length}`)
const sampleSession = parsed.workspaces[0]?.sessions[0]
console.log(`  sample session: ${sampleSession?.sessionId} [${sampleSession?.running ? 'running' : 'idle'}] ${sampleSession?.title ?? ''}`)

// 2. Test session detail route
const detailRoute = routes.get(SESSION_DETAIL_ROUTE)
if (!detailRoute) throw new Error(`missing route: ${SESSION_DETAIL_ROUTE}`)

if (sampleSession?.sessionId) {
  captured = { status: 0, body: '' }
  started = Date.now()
  await detailRoute.handler({ url: `${SESSION_DETAIL_ROUTE}?id=${sampleSession.sessionId}` }, res)
  console.log(`session detail status: ${captured.status} in ${Date.now() - started} ms`)
  const detail = JSON.parse(captured.body)
  console.log(`  detail title: "${detail.title}" messages: ${detail.messages?.length ?? 0}`)
}
