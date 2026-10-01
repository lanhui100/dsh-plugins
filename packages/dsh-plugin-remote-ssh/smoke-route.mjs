/**
 * Route smoke: the panel's data routes answer with the remote workspace tree and session detail.
 *
 * Runs against the already-listening tunnel (default 39387) and drives the
 * registered handlers with minimal response doubles.
 */

import {
  RemoteCaller,
  registerRemoteSshRoute,
  SESSIONS_ROUTE,
  SESSION_DETAIL_ROUTE,
  SESSION_RAW_ROUTE,
  SESSION_PROMPT_ROUTE,
  SESSION_CANCEL_ROUTE,
  SESSION_FOLLOW_ROUTE,
} from './lib/index.js'

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

// 3. Test raw wire route (the one the official conversation stream consumes)
const rawRoute = routes.get(SESSION_RAW_ROUTE)
if (!rawRoute) throw new Error(`missing route: ${SESSION_RAW_ROUTE}`)

if (sampleSession?.sessionId) {
  captured = { status: 0, body: '' }
  started = Date.now()
  await rawRoute.handler({ url: `${SESSION_RAW_ROUTE}?id=${sampleSession.sessionId}` }, res)
  console.log(`session raw status: ${captured.status} in ${Date.now() - started} ms`)
  const raw = JSON.parse(captured.body)
  const eventTypes = new Set((raw.records || []).map((r) => r.event?.type))
  console.log(`  asOfSeq: ${raw.asOfSeq} records: ${raw.records?.length ?? 0}`)
  console.log(`  wire event types: ${[...eventTypes].slice(0, 6).join(', ')}${eventTypes.size > 6 ? ', …' : ''}`)
}

// 4. Test prompt route
const promptRoute = routes.get(SESSION_PROMPT_ROUTE)
if (!promptRoute) throw new Error(`missing route: ${SESSION_PROMPT_ROUTE}`)
if (sampleSession?.sessionId) {
  captured = { status: 0, body: '' }
  const mockReq = {
    on(ev, cb) {
      if (ev === 'data') cb(Buffer.from(JSON.stringify({ sessionId: sampleSession.sessionId, content: [] })))
      if (ev === 'end') cb()
    },
  }
  await promptRoute.handler(mockReq, res)
  console.log(`prompt route status: ${captured.status} body: ${captured.body}`)
  const promptJson = JSON.parse(captured.body)
  if (typeof promptJson.ok !== 'boolean') throw new Error('prompt route must return ok boolean')
}

// 5. Test cancel route
const cancelRoute = routes.get(SESSION_CANCEL_ROUTE)
if (!cancelRoute) throw new Error(`missing route: ${SESSION_CANCEL_ROUTE}`)
if (sampleSession?.sessionId) {
  captured = { status: 0, body: '' }
  const mockReq = {
    on(ev, cb) {
      if (ev === 'data') cb(Buffer.from(JSON.stringify({ sessionId: sampleSession.sessionId })))
      if (ev === 'end') cb()
    },
  }
  await cancelRoute.handler(mockReq, res)
  console.log(`cancel route status: ${captured.status} body: ${captured.body}`)
  const cancelJson = JSON.parse(captured.body)
  if (typeof cancelJson.ok !== 'boolean') throw new Error('cancel route must return ok boolean')
}

// 6. Test follow SSE route
const followRoute = routes.get(SESSION_FOLLOW_ROUTE)
if (!followRoute) throw new Error(`missing route: ${SESSION_FOLLOW_ROUTE}`)
if (sampleSession?.sessionId) {
  let sseHeaders = null
  const chunks = []
  let closeCb = null
  const mockFollowRes = {
    writeHead(status, headers) { sseHeaders = headers },
    write(chunk) {
      chunks.push(chunk)
      if (closeCb) closeCb() // Abort after first frame
      return true
    },
    end() {},
  }
  const mockFollowReq = {
    url: `${SESSION_FOLLOW_ROUTE}?id=${sampleSession.sessionId}`,
    on(ev, cb) {
      if (ev === 'close') closeCb = cb
    },
  }
  await followRoute.handler(mockFollowReq, mockFollowRes)
  console.log(`follow sse content-type: ${sseHeaders?.['content-type']} received chunks: ${chunks.length}`)
  if (chunks.length > 0) {
    console.log(`  first sse chunk: ${chunks[0].slice(0, 100)}...`)
  }
}

