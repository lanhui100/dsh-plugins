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

const requestedUrls = []
globalThis.fetch = async (url) => {
  const urlStr = String(url)
  requestedUrls.push(urlStr)
  if (urlStr.includes('/remote-ssh/sessions')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        host: 'dev',
        total: 2,
        archivedSessionIds: ['session-demo-1'],
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
        sessions: [
          {
            sessionId: 'session-demo-1',
            title: 'Demo remote session',
            running: false,
            blank: false,
            cwd: '/tmp/demo',
            updatedAt: 1_700_000_000_000,
            projections: {
              kind: 'cached',
              asOfSeq: 10,
              values: {
                title: 'Demo remote session',
                subagentCatalog: [{ id: 'subagent-child-1', label: 'Auditor Child', mode: 'continuable' }],
                agentTeam: { members: [{ id: 'session-demo-1', role: 'lead' }, { id: 'subagent-child-1', role: 'teammate' }] },
              },
            },
          },
          {
            sessionId: 'subagent-child-1',
            title: 'Auditor Child',
            running: true,
            blank: false,
            cwd: '/tmp/demo',
            updatedAt: 1_700_000_000_001,
            origin: 'subagent',
            parentSessionId: 'session-demo-1',
          },
        ],
      }),
    }
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({
      sessionId: urlStr.includes('subagent-child-1') ? 'subagent-child-1' : 'session-demo-1',
      asOfSeq: 1,
      header: {
        version: 0,
        id: urlStr.includes('subagent-child-1') ? 'subagent-child-1' : 'session-demo-1',
        createdAt: Date.now(),
        isSeeded: false,
      },
      projections: {},
      records: [{ seq: 1, type: 'message' }],
      hasMore: false,
    }),
  }
}

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
      items: [],
      archivedSessionIds: [],
      removedIds: new Set(),
      replaceBaseline(baseline) {
        this.items = [...(baseline.items || [])]
        this.archivedSessionIds = [...(baseline.archivedSessionIds || [])]
      },
      replaceArchived(ids) {
        this.archivedSessionIds = [...ids]
      },
      installArchived(ids) {
        this.archivedSessionIds = [...ids]
      },
      upsertView: (view) => {
        if (this.list.removedIds.has(view.workspaceId)) return
        upserted.push(view)
        const idx = this.list.items.findIndex((item) => item.workspaceId === view.workspaceId)
        if (idx === -1) this.list.items.unshift(view)
        else this.list.items[idx] = view
      },
      removeView: (id) => {
        this.list.removedIds.add(id)
        removedWorkspaces.push(id)
        this.list.items = this.list.items.filter((item) => item.workspaceId !== id)
      },
    }
  }
}

class SessionsService extends Service {
  constructor(ctx) {
    super(ctx, 'sessions')
  }
  handleSessionAdded(summary) {
    assert.ok(summary.sessionId, 'Session summary must contain sessionId field')
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

// Workspace session list contract test: subagent sessions must NOT be in workspace view sessionIds!
assert.deepEqual(
  upserted[0]?.sessionIds,
  ['session-demo-1'],
  'Workspace view sessionIds must only contain root sessions, never subagents',
)

// Session registry contract test: subagent sessions must be added with origin and parentId
const subSession = addedSessions.find((s) => s.id === 'subagent-child-1')
assert.ok(subSession, 'Subagent session must be added into sessions registry for header views')
assert.equal(subSession.origin, 'subagent', 'Subagent session must have origin="subagent"')
assert.equal(subSession.parentId, 'session-demo-1', 'Subagent session must have parentId matching its parent')

// Parent session projections test: subagentCatalog and agentTeam must be preserved
const rootSession = addedSessions.find((s) => s.id === 'session-demo-1')
assert.ok(rootSession?.projections?.values?.subagentCatalog, 'Parent session must pass subagentCatalog projection')
assert.ok(rootSession?.projections?.values?.agentTeam, 'Parent session must pass agentTeam projection')

// Title format contract test: must be "<host> : <name>" without "远程".
assert.equal(
  upserted[0]?.title,
  'dev : demo',
  'Remote workspace title must strictly match "<host> : <name>" format without "远程"',
)

// Archived session contract test: remote archived session must be merged into official archivedSessionIds.
const wsList = root.get('workspaces').list
assert.ok(wsList.items.some((item) => item.workspaceId === 'remote:/tmp/demo'), 'Remote workspace must be in model items initially')
assert.ok(
  wsList.archivedSessionIds.includes('session-demo-1'),
  'Remote archived session must be registered into wsList.archivedSessionIds',
)

// Contract test: official baseline stream arrives after web boot.
// It must NOT wipe out remote workspaces, and remote archived sessions must survive and merge with local archived.
wsList.replaceBaseline({
  items: [{ workspaceId: 'local-workspace-1', path: '/local/1', title: 'Local 1' }],
  archivedSessionIds: ['local-archived-1'],
})
assert.ok(
  wsList.items.some((item) => item.workspaceId === 'remote:/tmp/demo'),
  'Remote workspace must survive or re-upsert after official replaceBaseline()',
)
assert.ok(
  wsList.archivedSessionIds.includes('session-demo-1') && wsList.archivedSessionIds.includes('local-archived-1'),
  'Remote archived session must survive replaceBaseline() and coexist with local archived sessions',
)

// Contract test: official replaceArchived mutation must not drop remote archived sessions.
wsList.replaceArchived(['local-archived-2'])
assert.ok(
  wsList.archivedSessionIds.includes('session-demo-1') && wsList.archivedSessionIds.includes('local-archived-2'),
  'Remote archived session must survive replaceArchived() and coexist with updated local archived sessions',
)

// Remote branch: page for the known remote id is answered from the raw route.
const remotePage = await pluginCtx.remote.session.page(
  { address: { kind: 'session', sessionId: 'session-demo-1' }, throughSeq: 1 },
  null,
)
console.log(`remote page ok=${remotePage.ok} records=${remotePage.value?.records?.length}`)

// Subagent remote branch: page for subagent address passes parentId query param!
const subagentPage = await pluginCtx.remote.session.page(
  { address: { kind: 'subagent', parentSessionId: 'session-demo-1', childSessionId: 'subagent-child-1', mode: 'unknown' }, throughSeq: 1 },
  null,
)
assert.ok(subagentPage.ok, 'Subagent page request must succeed via remote proxy')
assert.ok(
  requestedUrls.some((u) => u.includes('id=subagent-child-1') && u.includes('parentId=session-demo-1')),
  'Subagent page request must pass parentId to raw route',
)

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