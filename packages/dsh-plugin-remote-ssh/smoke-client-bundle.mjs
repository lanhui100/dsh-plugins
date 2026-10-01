/**
 * Client-bundle contract smoke: the shipped client.js registers, applies, and
 * installs its official-model integration — under a real Cordis Context.
 *
 * Stubs: `fetch` answers a canned remote snapshot; real Cordis services back
 * `workspaces`, `sessions`, `remote`, and `remote.session`.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'

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

// Contract assert: must declare all consumed services, including the namespace associate.
assert.ok(
  Array.isArray(clientExports.inject) && clientExports.inject.includes('remote.session'),
  'clientExports.inject must declare "remote.session" so Cordis context proxy permits ctx.remote.session access',
)

// Build a real Cordis Context environment to guarantee no missing-inject runtime failures.
const upserted = []
const removedWorkspaces = []
const addedSessions = []
const removedSessions = []

class RemoteService extends Service {
  static [Service.tracker] = { associate: 'remote' }
  constructor(ctx) {
    super(ctx, 'remote')
  }
}

class RemoteSessionService extends Service {
  constructor(ctx) {
    super(ctx, 'remote.session')
    for (const method of ['page', 'follow', 'projections', 'prompt', 'cancel', 'rename', 'attachment']) {
      Object.defineProperty(this, method, {
        configurable: true,
        enumerable: true,
        get: () => (...args) => ({ ok: true, value: { method, args } }),
      })
    }
  }
}

class WorkspacesService extends Service {
  constructor(ctx) {
    super(ctx, 'workspaces')
    this.list = {
      upsertView: (view) => upserted.push(view),
      removeView: (id) => removedWorkspaces.push(id),
    }
  }
}

class SessionsService extends Service {
  constructor(ctx) {
    super(ctx, 'sessions')
  }
  handleSessionAdded(summary) {
    addedSessions.push(summary)
  }
  handleSessionRemoved(id) {
    removedSessions.push(id)
  }
}

const root = new Context()
root.plugin(RemoteService)
root.plugin(RemoteSessionService)
root.plugin(WorkspacesService)
root.plugin(SessionsService)

const fork = root.plugin({
  name: registration.id,
  inject: clientExports.inject,
  apply: clientExports.apply,
})

if (fork.state === 3 || fork._error) {
  throw (fork._error || new Error('plugin failed to activate'))
}

const pluginCtx = fork.context

// Let the initial reconcile settle.
await new Promise((resolve) => setTimeout(resolve, 20))

console.log(`upserted workspaces: ${upserted.length} (${upserted[0]?.title})`)
console.log(`added sessions: ${addedSessions.length} (${addedSessions[0]?.id})`)

// Remote branch: page for the known remote id is answered from the raw route.
const remotePage = await pluginCtx.remote.session.page(
  { address: { kind: 'session', sessionId: 'session-demo-1' }, throughSeq: 1 },
  null,
)
console.log(`remote page ok=${remotePage.ok} records=${remotePage.value?.records?.length}`)

// Local branch: an unknown id passes through to the original getter.
const localPage = await pluginCtx.remote.session.page({ sessionId: 'session-local-x' }, null)
console.log(`local page passthrough method=${localPage.value?.method}`)

// Follow remote branch yields a static snapshot.
const iterator = pluginCtx.remote.session.follow({ address: { kind: 'session', sessionId: 'session-demo-1' } }, null)
const first = await iterator.next()
console.log(`remote follow first frame type=${first.value?.type} cursor=${first.value?.cursor}`)

// Teardown: restore getters and remove injected remote rows.
await fork.dispose()
const restoredPage = await root.get('remote.session').page({ sessionId: 'session-local-x' }, null)
console.log(`teardown page passthrough method=${restoredPage.value?.method}`)
console.log(`teardown removed sessions: ${removedSessions.length} workspaces: ${removedWorkspaces.length}`)