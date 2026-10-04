/**
 * Regression smoke: POST /remote-ssh/create must forward the REMOTE session id,
 * not the plugin's namespaced id.
 *
 * The official UI reuses a blank session by passing its namespaced id
 * (`remote:<host>:<encodedId>`). Forwarding that verbatim to the remote
 * session/create made the remote create a brand-new session bearing the
 * namespaced string as its real id — a duplicate of the original blank on every
 * click. This test drives the host route with a fake caller (no tunnel, no
 * mutation) and asserts the forwarded request carries the decoded remote id.
 */

import {
  registerRemoteSshRoute,
  SESSION_CREATE_ROUTE,
} from './lib/index.js'

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

/** Fake remote caller: records session/create requests, never touches the network. */
const requestedCalls = []
const fakeCaller = {
  async invoke(method, payload) {
    requestedCalls.push({ method, payload })
    if (method === 'session/create') {
      return { sessionId: 'session-adopted-1', agentPreset: 'standard' }
    }
    if (method === 'workspace/list' || method === 'session/list') return { items: [] }
    return {}
  },
  async fetchWorkspaceBaseline() {
    return {
      items: [{ workspaceId: 'ws-real', path: '/home/dm/q', title: 'q', sessionIds: [] }],
      archivedSessionIds: [],
      pinnedSessionIds: [],
    }
  },
  getPendingInteractionsForSession() { return [] },
  async ensureEventsListener() { return undefined },
}

registerRemoteSshRoute(ctx, () => fakeCaller, 'dev')

const createRoute = routes.get(SESSION_CREATE_ROUTE)
if (!createRoute) throw new Error(`missing route: ${SESSION_CREATE_ROUTE}`)

function post(body) {
  return new Promise((resolve) => {
    let captured = { status: 0, body: '' }
    const res = {
      writeHead(status) { captured.status = status },
      end(bodyStr) { captured.body = bodyStr ?? '' },
    }
    const mockReq = {
      on(ev, cb) {
        if (ev === 'data') cb(Buffer.from(JSON.stringify(body)))
        if (ev === 'end') cb()
      },
    }
    createRoute.handler(mockReq, res).then(() => resolve(captured))
  })
}

/** Extract the session/create payload of the last invoked RPC. */
function lastCreateRequest() {
  const call = requestedCalls.filter((c) => c.method === 'session/create').at(-1)
  if (!call) throw new Error('session/create was never invoked')
  return call.payload.request
}

const wsId = 'remote:dev:workspace%3A%2Fhome%2Fdm%2Fq'
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }

// 1. Reuse path: namespaced blank id must be decoded to the remote id before forwarding.
requestedCalls.length = 0
{
  const res = await post({ workspaceId: wsId, sessionId: 'remote:dev:session-blank-1' })
  const json = JSON.parse(res.body)
  assert(json.ok === true, 'reuse create must succeed')
  assert(json.value?.sessionId === 'remote:dev:session-adopted-1', 'response sessionId must be namespaced')
  const req = lastCreateRequest()
  assert(req.workspaceId === 'ws-real', 'workspaceId must be resolved to the real remote workspace id')
  assert(req.sessionId === 'session-blank-1', `sessionId must be un-namespaced, got "${req.sessionId}"`)
}

// 2. Double-namespaced id (already-corrupted remote session) decodes one layer.
requestedCalls.length = 0
{
  const res = await post({ workspaceId: wsId, sessionId: 'remote:dev:remote%3Adev%3Asession-blank-1' })
  const json = JSON.parse(res.body)
  assert(json.ok === true, 'double-namespaced create must succeed')
  const req = lastCreateRequest()
  assert(req.sessionId === 'remote:dev:session-blank-1', `double-namespaced id must decode one layer, got "${req.sessionId}"`)
}

// 3. Raw (non-namespaced) id passes through untouched (legacy/edge input).
requestedCalls.length = 0
{
  const res = await post({ workspaceId: wsId, sessionId: 'session-raw-input-9' })
  const json = JSON.parse(res.body)
  assert(json.ok === true, 'raw-id create must succeed')
  const req = lastCreateRequest()
  assert(req.sessionId === 'session-raw-input-9', 'raw sessionId must pass through unchanged')
}

// 4. Fresh create (no sessionId) must not synthesize a sessionId field.
requestedCalls.length = 0
{
  const res = await post({ workspaceId: wsId })
  const json = JSON.parse(res.body)
  assert(json.ok === true, 'fresh create must succeed')
  const req = lastCreateRequest()
  assert(req.sessionId === undefined, 'fresh create must not forward a sessionId')
}

console.log('smoke-create-reuse: all assertions passed (create forwards decoded remote sessionId)')