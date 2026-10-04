/**
 * SelectModel route smoke: the remote session model-selection route validates
 * requests and forwards to the tunnel caller without a live SSH connection.
 *
 * Unlike smoke-route.mjs (live tunnel), this file drives the registered
 * handler with a stub caller, so it runs in CI / sandbox without a remote.
 */

import {
  registerRemoteSshRoute,
  SESSION_SELECT_MODEL_ROUTE,
  SESSION_RENAME_ROUTE,
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

// Stub caller: records invocations, resolves with a canned selection.
const calls = []
const stubCaller = {
  selectRemoteSessionModel: async (sessionId, provider, model, reasoningEffort) => {
    calls.push({ sessionId, provider, model, reasoningEffort })
    return { selected: { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) } }
  },
}

registerRemoteSshRoute(ctx, () => stubCaller, 'dev')

// 1. Route registration
const selectModelRoute = routes.get(SESSION_SELECT_MODEL_ROUTE)
if (!selectModelRoute) throw new Error(`missing route: ${SESSION_SELECT_MODEL_ROUTE}`)
if (!routes.get(SESSION_RENAME_ROUTE)) throw new Error('sanity: rename route must still be registered')
console.log(`selectModel route registered: ${SESSION_SELECT_MODEL_ROUTE}`)

const captured = { status: 0, body: '' }
const res = {
  writeHead(status) { captured.status = status },
  end(body) { captured.body = body ?? '' },
}
const reqFor = (payload) => ({
  on(ev, cb) {
    if (ev === 'data') cb(Buffer.from(JSON.stringify(payload)))
    if (ev === 'end') cb()
  },
})

// 2. Incomplete request → 400 ok:false (validation short-circuits before caller)
captured.status = 0
captured.body = ''
await selectModelRoute.handler(reqFor({ sessionId: 'session-demo-1' }), res)
console.log(`selectModel invalid status: ${captured.status} body: ${captured.body}`)
const invalidJson = JSON.parse(captured.body)
if (captured.status !== 400 || invalidJson.ok !== false) {
  throw new Error('selectModel route must reject incomplete request with 400 ok:false')
}

// 3. Missing provider/model only → 400 as well
captured.status = 0
captured.body = ''
await selectModelRoute.handler(reqFor({ sessionId: 'session-demo-1', provider: 'anthropic' }), res)
if (captured.status !== 400) throw new Error('selectModel route must reject provider-only request with 400')

// 4. Valid request → forwards to caller with original session id and fields
captured.status = 0
captured.body = ''
await selectModelRoute.handler(
  reqFor({ sessionId: 'session-demo-1', provider: 'anthropic', model: 'claude-3-7-sonnet', reasoningEffort: 'high' }),
  res,
)
console.log(`selectModel valid status: ${captured.status} body: ${captured.body}`)
const okJson = JSON.parse(captured.body)
if (captured.status !== 200 || okJson.ok !== true) {
  throw new Error(`selectModel route must return 200 ok:true, got ${captured.status} ${captured.body}`)
}
if (okJson.value?.selected?.provider !== 'anthropic' || okJson.value?.selected?.model !== 'claude-3-7-sonnet') {
  throw new Error('selectModel route must return the selected provider/model')
}
if (calls.length !== 1) throw new Error(`caller must be invoked exactly once, got ${calls.length}`)
const forwarded = calls[0]
if (forwarded.sessionId !== 'session-demo-1') throw new Error('caller must receive the original session id')
if (forwarded.provider !== 'anthropic' || forwarded.model !== 'claude-3-7-sonnet') {
  throw new Error('caller must receive provider and model')
}
if (forwarded.reasoningEffort !== 'high') throw new Error('caller must receive reasoningEffort when supplied')

// 5. Tunnel failure → graceful 200 ok:false (no crash)
const failingCaller = {
  selectRemoteSessionModel: async () => { throw new Error('tunnel-not-ready') },
}
const ctx2 = {
  inject: (deps, callback) => {
    callback({
      webServer: {
        register: (value) => { routes.set(value.path, value); return () => {} },
      },
      effect: (fn) => { fn(); return () => {} },
    })
  },
}
registerRemoteSshRoute(ctx2, () => failingCaller, 'dev')
const failingRoute = routes.get(SESSION_SELECT_MODEL_ROUTE)
captured.status = 0
captured.body = ''
await failingRoute.handler(reqFor({ sessionId: 'session-demo-1', provider: 'anthropic', model: 'claude-3-7-sonnet' }), res)
console.log(`selectModel failure status: ${captured.status} body: ${captured.body}`)
const failJson = JSON.parse(captured.body)
if (captured.status !== 200 || failJson.ok !== false) {
  throw new Error('selectModel route must fail gracefully with 200 ok:false when the tunnel errors')
}

console.log('all smoke-select-model assertions passed cleanly')
