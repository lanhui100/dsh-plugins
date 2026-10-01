/**
 * Client-bundle contract smoke: the shipped client.js registers, applies, and
 * installs its official-model integration — without a browser.
 *
 * Stubs: `fetch` answers a canned remote snapshot; `ctx` carries the official
 * workspace/session models and a session namespace with configurable getters;
 * React is no longer used by this half.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'client.js'), 'utf8')

let registration
globalThis.window = {
  __ModuleLoader__: {
    load: (value) => { registration = value },
  },
}

globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    host: 'dev',
    total: 1,
    workspaces: [{
      cwd: '/tmp/demo',
      name: 'demo',
      sessions: [{
        sessionId: 'session-demo-1',
        title: 'Demo remote session',
        running: false,
        blank: false,
        cwd: '/tmp/demo',
        updatedAt: 1_700_000_000_000,
      }],
    }],
  }),
})

// A browser evaluates the script purely to register the factory.
new Function(source)()

const clientExports = registration.factory((specifier) => {
  if (specifier === 'react') return undefined
  throw new Error(`unexpected external request: ${specifier}`)
})

console.log(`registration id: ${registration.id}`)
console.log(`exports.apply: ${typeof clientExports.apply}`)
console.log(`exports.inject: ${JSON.stringify(clientExports.inject)}`)

// Build the stub session namespace with configurable method getters, the way
// the official RemoteNamespaceService exposes them.
const upserted = []
const removedWorkspaces = []
const addedSessions = []
const removedSessions = []
const effectDisposers = []

const sessionNs = {}
for (const method of ['page', 'follow', 'projections', 'prompt', 'cancel', 'rename', 'attachment']) {
  Object.defineProperty(sessionNs, method, {
    configurable: true,
    enumerable: true,
    get: () => (...args) => ({ ok: true, value: { method, args } }),
  })
}

const ctx = {
  workspaces: {
    list: {
      upsertView: (view) => upserted.push(view),
      removeView: (id) => removedWorkspaces.push(id),
    },
  },
  sessions: {
    handleSessionAdded: (summary) => addedSessions.push(summary),
    handleSessionRemoved: (id) => removedSessions.push(id),
  },
  remote: { session: sessionNs },
  effect: (fn) => { effectDisposers.push(fn()); return () => {} },
}

clientExports.apply(ctx)

// Let the initial reconcile settle.
await new Promise((resolve) => setTimeout(resolve, 20))

console.log(`upserted workspaces: ${upserted.length} (${upserted[0]?.title})`)
console.log(`added sessions: ${addedSessions.length} (${addedSessions[0]?.id})`)

// Remote branch: page for the known remote id is answered from the raw route.
const remotePage = await ctx.remote.session.page(
  { address: { kind: 'session', sessionId: 'session-demo-1' }, throughSeq: 1 },
  null,
)
console.log(`remote page ok=${remotePage.ok} records=${remotePage.value?.records?.length}`)

// Local branch: an unknown id passes through to the original getter.
const localPage = await ctx.remote.session.page({ sessionId: 'session-local-x' }, null)
console.log(`local page passthrough method=${localPage.value?.method}`)

// Follow remote branch yields a static snapshot.
const iterator = ctx.remote.session.follow({ address: { kind: 'session', sessionId: 'session-demo-1' } }, null)
const first = await iterator.next()
console.log(`remote follow first frame type=${first.value?.type} cursor=${first.value?.cursor}`)

// Teardown: restore getters and remove injected remote rows.
const dispose = effectDisposers[0]
dispose()
const restoredPage = await ctx.remote.session.page({ sessionId: 'session-local-x' }, null)
console.log(`teardown page passthrough method=${restoredPage.value?.method}`)
console.log(`teardown removed sessions: ${removedSessions.length} workspaces: ${removedWorkspaces.length}`)