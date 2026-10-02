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
  SESSION_CREATE_ROUTE,
  SESSION_PENDING_INTERACTION_ROUTE,
  SESSION_INTERACTION_RESPOND_ROUTE,
  SESSION_ARCHIVE_ROUTE,
  SESSION_UNARCHIVE_ROUTE,
  SESSION_PIN_ROUTE,
  SESSION_UNPIN_ROUTE,
  SESSION_RENAME_ROUTE,
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

// 7. Test create session route
const createRoute = routes.get(SESSION_CREATE_ROUTE)
if (!createRoute) throw new Error(`missing route: ${SESSION_CREATE_ROUTE}`)
const sampleWs = parsed.workspaces[0]
if (sampleWs?.cwd) {
  captured = { status: 0, body: '' }
  const mockReq = {
    on(ev, cb) {
      if (ev === 'data') cb(Buffer.from(JSON.stringify({ workspaceId: `remote:${sampleWs.cwd}` })))
      if (ev === 'end') cb()
    },
  }
  await createRoute.handler(mockReq, res)
  console.log(`create route status: ${captured.status} body: ${captured.body}`)
  const createJson = JSON.parse(captured.body)
  if (typeof createJson.ok !== 'boolean') throw new Error('create route must return ok boolean')
  if (createJson.ok && !createJson.value?.sessionId) throw new Error('create route must return sessionId on success')
}

// 8. Test pending-interaction route & interaction response route
const pendingRoute = routes.get(SESSION_PENDING_INTERACTION_ROUTE)
if (!pendingRoute) throw new Error(`missing route: ${SESSION_PENDING_INTERACTION_ROUTE}`)
const respondRoute = routes.get(SESSION_INTERACTION_RESPOND_ROUTE)
if (!respondRoute) throw new Error(`missing route: ${SESSION_INTERACTION_RESPOND_ROUTE}`)

if (sampleSession?.sessionId) {
  // 8a. No interaction initially
  captured = { status: 0, body: '' }
  await pendingRoute.handler({ url: `${SESSION_PENDING_INTERACTION_ROUTE}?sessionId=${sampleSession.sessionId}` }, res)
  console.log(`pending interaction status: ${captured.status} body: ${captured.body}`)
  let pendingJson = JSON.parse(captured.body)
  if (!pendingJson.ok || pendingJson.value?.pending !== null) {
    throw new Error('expected no pending interaction initially')
  }

  // 8b. Record mock interaction on caller
  const mockEventId = `evt-smoke-${Date.now()}`
  caller.recordMockInteraction({
    clientId: 'mock-client-1',
    eventId: mockEventId,
    sessionId: sampleSession.sessionId,
    event: 'user-questions/request',
    questions: [
      {
        id: 'q1',
        question: 'Choose deployment target',
        options: [{ label: 'Cloud' }, { label: 'Local' }],
        multiSelect: false,
      },
    ],
    createdAt: Date.now(),
  })

  // 8c. Query pending interaction again
  captured = { status: 0, body: '' }
  await pendingRoute.handler({ url: `${SESSION_PENDING_INTERACTION_ROUTE}?sessionId=${sampleSession.sessionId}` }, res)
  pendingJson = JSON.parse(captured.body)
  console.log(`pending interaction with mock: ${captured.status} question: "${pendingJson.value?.pending?.questions?.[0]?.question}"`)
  if (!pendingJson.ok || pendingJson.value?.pending?.eventId !== mockEventId) {
    throw new Error('expected pending interaction to match mockEventId')
  }

  // 8d. Follow SSE route should emit interaction/request frame
  let receivedInteractionFrame = false
  let closeFollow2 = null
  const mockFollowRes2 = {
    writeHead() {},
    write(chunk) {
      if (typeof chunk === 'string' && chunk.includes('interaction/request')) {
        receivedInteractionFrame = true
      }
      if (closeFollow2) closeFollow2()
      return true
    },
    end() {},
  }
  const mockFollowReq2 = {
    url: `${SESSION_FOLLOW_ROUTE}?id=${sampleSession.sessionId}`,
    on(ev, cb) { if (ev === 'close') closeFollow2 = cb },
  }
  await followRoute.handler(mockFollowReq2, mockFollowRes2)
  console.log(`follow route emitted interaction/request: ${receivedInteractionFrame}`)
  if (!receivedInteractionFrame) {
    throw new Error('expected follow route to emit interaction/request frame')
  }

  // 8e. Test respond route
  captured = { status: 0, body: '' }
  const mockRespondReq = {
    on(ev, cb) {
      if (ev === 'data') cb(Buffer.from(JSON.stringify({
        sessionId: sampleSession.sessionId,
        eventId: mockEventId,
        outcome: {
          kind: 'result',
          value: { answers: [{ id: 'q1', selected: ['Cloud'] }] },
        },
      })))
      if (ev === 'end') cb()
    },
  }
  await respondRoute.handler(mockRespondReq, res)
  console.log(`respond route status: ${captured.status} body: ${captured.body}`)
  const respondJson = JSON.parse(captured.body)
  if (typeof respondJson.ok !== 'boolean') throw new Error('respond route must return ok boolean')

  // 8f. Query pending interaction again - should be cleared
  captured = { status: 0, body: '' }
  await pendingRoute.handler({ url: `${SESSION_PENDING_INTERACTION_ROUTE}?sessionId=${sampleSession.sessionId}` }, res)
  pendingJson = JSON.parse(captured.body)
  if (!pendingJson.ok || pendingJson.value?.pending !== null) {
    throw new Error('expected pending interaction to be cleared after respond')
  }
  console.log('pending interaction lifecycle verified successfully in smoke-route')
}

// 9. Session Operations: Archive, Unarchive, Pin, Unpin, Rename
const archiveRoute = routes.get(SESSION_ARCHIVE_ROUTE)
const unarchiveRoute = routes.get(SESSION_UNARCHIVE_ROUTE)
const pinRoute = routes.get(SESSION_PIN_ROUTE)
const unpinRoute = routes.get(SESSION_UNPIN_ROUTE)
const renameRoute = routes.get(SESSION_RENAME_ROUTE)

if (!archiveRoute || !unarchiveRoute || !pinRoute || !unpinRoute || !renameRoute) {
  throw new Error('missing session operation route registrations')
}

if (sampleSession) {
  // 9a. Test Archive & Unarchive
  captured = { status: 0, body: '' }
  const mockArchiveReq = {
    on(ev, cb) {
      if (ev === 'data') cb(Buffer.from(JSON.stringify({ sessionId: sampleSession.sessionId })))
      if (ev === 'end') cb()
    },
  }
  await archiveRoute.handler(mockArchiveReq, res)
  console.log(`archive route status: ${captured.status} body: ${captured.body}`)
  const archiveJson = JSON.parse(captured.body)
  if (!archiveJson.ok || !Array.isArray(archiveJson.value?.archivedSessionIds)) {
    throw new Error('archive route must return ok and archivedSessionIds array')
  }

  captured = { status: 0, body: '' }
  const mockUnarchiveReq = {
    on(ev, cb) {
      if (ev === 'data') cb(Buffer.from(JSON.stringify({ sessionId: sampleSession.sessionId })))
      if (ev === 'end') cb()
    },
  }
  await unarchiveRoute.handler(mockUnarchiveReq, res)
  console.log(`unarchive route status: ${captured.status} body: ${captured.body}`)
  const unarchiveJson = JSON.parse(captured.body)
  if (!unarchiveJson.ok || !Array.isArray(unarchiveJson.value?.archivedSessionIds)) {
    throw new Error('unarchive route must return ok and archivedSessionIds array')
  }

  // 9b. Test Pin & Unpin
  captured = { status: 0, body: '' }
  const mockPinReq = {
    on(ev, cb) {
      if (ev === 'data') cb(Buffer.from(JSON.stringify({ sessionId: sampleSession.sessionId })))
      if (ev === 'end') cb()
    },
  }
  await pinRoute.handler(mockPinReq, res)
  console.log(`pin route status: ${captured.status} body: ${captured.body}`)
  const pinJson = JSON.parse(captured.body)
  if (!pinJson.ok || !Array.isArray(pinJson.value?.pinnedSessionIds)) {
    throw new Error('pin route must return ok and pinnedSessionIds array')
  }

  captured = { status: 0, body: '' }
  const mockUnpinReq = {
    on(ev, cb) {
      if (ev === 'data') cb(Buffer.from(JSON.stringify({ sessionId: sampleSession.sessionId })))
      if (ev === 'end') cb()
    },
  }
  await unpinRoute.handler(mockUnpinReq, res)
  console.log(`unpin route status: ${captured.status} body: ${captured.body}`)
  const unpinJson = JSON.parse(captured.body)
  if (!unpinJson.ok || !Array.isArray(unpinJson.value?.pinnedSessionIds)) {
    throw new Error('unpin route must return ok and pinnedSessionIds array')
  }

  // 9c. Test Rename
  captured = { status: 0, body: '' }
  const origTitle = sampleSession.title || 'untitled'
  const mockRenameReq = {
    on(ev, cb) {
      if (ev === 'data') cb(Buffer.from(JSON.stringify({ sessionId: sampleSession.sessionId, title: `${origTitle} (test)` })))
      if (ev === 'end') cb()
    },
  }
  await renameRoute.handler(mockRenameReq, res)
  console.log(`rename route status: ${captured.status} body: ${captured.body}`)
  const renameJson = JSON.parse(captured.body)
  if (!renameJson.ok || typeof renameJson.value?.title !== 'string') {
    throw new Error('rename route must return ok and title')
  }

  // Restore original title
  const mockRestoreReq = {
    on(ev, cb) {
      if (ev === 'data') cb(Buffer.from(JSON.stringify({ sessionId: sampleSession.sessionId, title: origTitle })))
      if (ev === 'end') cb()
    },
  }
  await renameRoute.handler(mockRestoreReq, res)
}

caller.dispose()
console.log('all smoke-route assertions passed cleanly')

