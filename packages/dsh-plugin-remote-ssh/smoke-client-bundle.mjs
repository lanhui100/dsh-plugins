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
        homes: [{ host: 'dev', home: '/tmp' }],
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
  if (urlStr.includes('/remote-ssh/prompt')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, value: { accepted: true } }),
    }
  }
  if (urlStr.includes('/remote-ssh/cancel')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, value: { accepted: true } }),
    }
  }
  if (urlStr.includes('/remote-ssh/create')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, value: { sessionId: 'session-remote-new-1', agentPreset: 'standard' } }),
    }
  }
  if (urlStr.includes('/remote-ssh/pending-interaction')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        value: {
          sessionId: 'session-demo-1',
          pending: {
            eventId: 'evt-client-smoke-1',
            sessionId: 'session-demo-1',
            questions: [
              {
                id: 'q1',
                question: 'Choose framework',
                options: [{ label: 'React (recommended)' }, { label: 'Vue' }],
                multiSelect: false,
              },
            ],
          },
        },
      }),
    }
  }
  if (urlStr.includes('/remote-ssh/interaction-respond')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, value: { accepted: true } }),
    }
  }
  if (urlStr.includes('/remote-ssh/session-archive')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, value: { archivedSessionIds: ['session-demo-1', 'session-demo-2'] } }),
    }
  }
  if (urlStr.includes('/remote-ssh/session-unarchive')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, value: { archivedSessionIds: ['session-demo-2'] } }),
    }
  }
  if (urlStr.includes('/remote-ssh/session-pin')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, value: { pinnedSessionIds: ['session-demo-1'] } }),
    }
  }
  if (urlStr.includes('/remote-ssh/session-unpin')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, value: { pinnedSessionIds: [] } }),
    }
  }
  if (urlStr.includes('/remote-ssh/session-rename')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, value: { title: 'Renamed Title', seq: 5 } }),
    }
  }
  if (urlStr.includes('/remote-ssh/session-follow')) {
    const sseFrames = [
      JSON.stringify({ type: 'snapshot', cursor: 42, records: [{ seq: 1 }] }),
      JSON.stringify({ type: 'event', event: { type: 'turn/start', seq: 2, time: 1700000000002 } }),
      JSON.stringify({ type: 'assistant-stream', frame: { revision: 1 } }),
      JSON.stringify({
        type: 'interaction/request',
        eventId: 'evt-client-smoke-1',
        sessionId: 'session-demo-1',
        questions: [
          {
            id: 'q1',
            question: 'Choose framework',
            options: [{ label: 'React (recommended)' }, { label: 'Vue' }],
            multiSelect: false,
          },
        ],
      }),
      JSON.stringify({ type: 'event', event: { type: 'turn/end', seq: 3, time: 1700000000003 } }),
      JSON.stringify({
        type: 'interaction/cancel',
        eventId: 'evt-client-smoke-1',
        sessionId: 'session-demo-1',
      }),
    ]
    const sseText = sseFrames.map((f) => `data: ${f}\n\n`).join('')
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseText))
        controller.close()
      },
    })
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'text/event-stream' },
      body: stream,
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
  Array.isArray(clientExports.inject) &&
    clientExports.inject.includes('remote.session') &&
    clientExports.inject.includes('remote.workspace'),
  'clientExports.inject must declare "remote.session" and "remote.workspace" so Cordis context proxy permits access',
)

// Build a real Cordis Context environment to guarantee no missing-inject runtime failures.
const upserted = []
const removedWorkspaces = []
const addedSessions = []
const removedSessions = []
const sessionStatusUpdates = []
const sessionActivityUpdates = []
const registeredInteractions = []
const unregisteredInteractions = []

class UiSessionService extends Service {
  constructor(ctx) {
    super(ctx, 'uiSession')
  }
  registerPendingInteraction(fn) {
    return (pending, handler) => {
      registeredInteractions.push(pending)
      return () => {
        unregisteredInteractions.push(pending)
      }
    }
  }
}

class RemoteService extends Service {
  static [Service.tracker] = { associate: 'remote' }
  constructor(ctx) {
    super(ctx, 'remote')
  }
}

class RemoteSessionService extends Service {
  constructor(ctx) {
    super(ctx, 'remote.session')
    for (const method of ['page', 'follow', 'projections', 'prompt', 'cancel', 'rename', 'attachment', 'create']) {
      Object.defineProperty(this, method, {
        configurable: true,
        enumerable: true,
        get: () => (...args) => ({ ok: true, value: { method, args } }),
      })
    }
  }
}

class RemoteWorkspaceService extends Service {
  constructor(ctx) {
    super(ctx, 'remote.workspace')
    for (const method of ['archiveSession', 'unarchiveSession', 'pinSession', 'unpinSession']) {
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
      pinnedSessionIds: [],
      removedIds: new Set(),
      replaceBaseline(baseline) {
        this.items = [...(baseline.items || [])]
        this.archivedSessionIds = [...(baseline.archivedSessionIds || [])]
        this.pinnedSessionIds = [...(baseline.pinnedSessionIds || [])]
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
  handleSessionStatus(sessionId, running) {
    sessionStatusUpdates.push({ sessionId, running })
  }
  handleSessionActivity(sessionId, updatedAt) {
    sessionActivityUpdates.push({ sessionId, updatedAt })
  }
}

const root = new Context()
root.plugin(RemoteService)
root.plugin(RemoteSessionService)
root.plugin(RemoteWorkspaceService)
root.plugin(WorkspacesService)
root.plugin(SessionsService)
root.plugin(UiSessionService)

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
  upserted.find((v) => v.workspaceId === 'remote:/tmp/demo')?.sessionIds,
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

// Remote host-root folder contract: the host mounts as a first-level folder
// (server icon + truncated host name) whose path is the remote home, so the
// official workspace-tree grouping nests every workspace beneath it.
const hostRootView = upserted.find((v) => v.workspaceId === 'remote:dev:hostroot')
assert.ok(hostRootView, 'Remote host-root workspace must be upserted (workspaceId "remote:dev:hostroot")')
assert.equal(hostRootView.path, '/tmp', 'Host-root path must be the remote home directory')
assert.equal(hostRootView.title, 'dev', 'Host-root title must be the (truncated) host alias, not "<host> : <name>"')
assert.deepEqual(hostRootView.sessionIds, [], 'Host-root folder must carry no direct sessions')

const workspaceView = upserted.find((v) => v.workspaceId === 'remote:/tmp/demo')
// Title format contract test: workspace folder must be the plain directory name,
// with the host identity living on its own first-level host-root folder.
assert.equal(
  workspaceView?.title,
  'demo',
  'Remote workspace title must strictly match the workspace folder name without any host prefix',
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

// Remote branch: prompt forwards to /remote-ssh/prompt
const promptRes = await pluginCtx.remote.session.prompt({
  sessionId: 'session-demo-1',
  content: [{ type: 'text', text: 'Hello remote AI' }],
})
assert.ok(promptRes.ok, 'Remote prompt request must succeed')
assert.equal(promptRes.value?.accepted, true, 'Remote prompt must return accepted: true')
assert.ok(requestedUrls.some((u) => u.includes('/remote-ssh/prompt')), 'Prompt must hit /remote-ssh/prompt')
assert.ok(
  sessionStatusUpdates.some((u) => u.sessionId === 'session-demo-1' && u.running === true),
  'Prompt must trigger handleSessionStatus(sessionId, true) to enter running/thinking state immediately',
)

// Subagent remote branch: prompt carries parentId
const subagentPromptRes = await pluginCtx.remote.session.prompt({
  sessionId: 'subagent-child-1',
  parentSessionId: 'session-demo-1',
  content: [{ type: 'text', text: 'Audit code' }],
})
assert.ok(subagentPromptRes.ok, 'Subagent prompt request must succeed')
assert.ok(
  sessionStatusUpdates.some((u) => u.sessionId === 'subagent-child-1' && u.running === true),
  'Subagent prompt must trigger handleSessionStatus(childSessionId, true)',
)

// Remote branch: cancel forwards to /remote-ssh/cancel
const cancelRes = await pluginCtx.remote.session.cancel({ sessionId: 'session-demo-1' })
assert.ok(cancelRes.ok, 'Remote cancel request must succeed')
assert.equal(cancelRes.value?.accepted, true, 'Remote cancel must return accepted: true')
assert.ok(requestedUrls.some((u) => u.includes('/remote-ssh/cancel')), 'Cancel must hit /remote-ssh/cancel')
assert.ok(
  sessionStatusUpdates.some((u) => u.sessionId === 'session-demo-1' && u.running === false),
  'Cancel must trigger handleSessionStatus(sessionId, false) to exit running state immediately',
)

// Local branch: prompt and cancel pass through to original getter
const localPrompt = await pluginCtx.remote.session.prompt({ sessionId: 'session-local-x' })
assert.equal(localPrompt.value?.method, 'prompt', 'Local prompt must pass through')
const localCancel = await pluginCtx.remote.session.cancel({ sessionId: 'session-local-x' })
assert.equal(localCancel.value?.method, 'cancel', 'Local cancel must pass through')

// Remote branch: create forwards to /remote-ssh/create and registers new sessionId
const createRes = await pluginCtx.remote.session.create({ workspaceId: 'remote:/tmp/demo' })
assert.ok(createRes.ok, 'Remote create request must succeed')
assert.equal(createRes.value?.sessionId, 'session-remote-new-1', 'Remote create must return sessionId')
assert.ok(requestedUrls.some((u) => u.includes('/remote-ssh/create')), 'Create must hit /remote-ssh/create')

// Newly created session is immediately recognized as remote
const newSessionPage = await pluginCtx.remote.session.page({ sessionId: 'session-remote-new-1' }, null)
assert.ok(newSessionPage.ok, 'Newly created remote session must route to remote page')

// Local branch: create passes through to original getter
const localCreate = await pluginCtx.remote.session.create({ workspaceId: 'local-workspace-1' })
assert.equal(localCreate.value?.method, 'create', 'Local create must pass through')

// Clear status updates to isolate follow assertions
sessionStatusUpdates.length = 0
sessionActivityUpdates.length = 0

// Follow remote branch yields streamed frames (snapshot, then delta notification).
const iterator = pluginCtx.remote.session.follow({ address: { kind: 'session', sessionId: 'session-demo-1' } }, null)
const first = await iterator.next()
console.log(`remote follow first frame type=${first.value?.type} cursor=${first.value?.cursor}`)
assert.equal(first.value?.type, 'snapshot', 'First frame must be snapshot')

// Consume all frames from iterator
const remainingFrames = []
while (true) {
  const nextItem = await iterator.next()
  if (nextItem.done) break
  remainingFrames.push(nextItem.value)
}
console.log(`received ${remainingFrames.length} remaining stream frames`)

// Follow stream assertions:
// 1. turn/start or assistant-stream sets running=true
assert.ok(
  sessionStatusUpdates.some((u) => u.sessionId === 'session-demo-1' && u.running === true),
  'Follow stream must trigger handleSessionStatus(id, true) on turn/start or stream frames',
)
// 2. turn/end or stream completion sets running=false
assert.ok(
  sessionStatusUpdates.some((u) => u.sessionId === 'session-demo-1' && u.running === false),
  'Follow stream must trigger handleSessionStatus(id, false) on turn/end or stream completion',
)
// 3. Activity updates are pushed on timestamped events
assert.ok(
  sessionActivityUpdates.some((u) => u.sessionId === 'session-demo-1' && u.updatedAt === 1700000000003),
  'Follow stream must trigger handleSessionActivity(id, time) on turn/end',
)

// 4. Pending interaction registration & cancellation via uiSession
assert.ok(
  registeredInteractions.some(
    (it) => it.key === 'evt-client-smoke-1' && it.kind === 'question' && it.sessionId === 'session-demo-1',
  ),
  'Follow stream interaction/request must call uiSession.registerPendingInteraction',
)
assert.ok(
  unregisteredInteractions.some(
    (it) => it.key === 'evt-client-smoke-1' && it.kind === 'question' && it.sessionId === 'session-demo-1',
  ),
  'Follow stream interaction/cancel must unregister pending interaction',
)

// Session actions: rename
// Remote branch: rename forwards to /remote-ssh/session-rename
const renameRes = await pluginCtx.remote.session.rename({ sessionId: 'session-demo-1', title: 'Renamed Title' })
assert.ok(renameRes.ok, 'Remote rename request must succeed')
assert.equal(renameRes.value?.title, 'Renamed Title', 'Remote rename must return new title')
assert.ok(requestedUrls.some((u) => u.includes('/remote-ssh/session-rename')), 'Rename must hit /remote-ssh/session-rename')

// Local branch: rename passes through
const localRename = await pluginCtx.remote.session.rename({ sessionId: 'session-local-x', title: 'Local Title' })
assert.equal(localRename.value?.method, 'rename', 'Local rename must pass through')

// Workspace actions: archiveSession & unarchiveSession
// Remote branch: archiveSession forwards to /remote-ssh/session-archive and updates wsList
const archiveRes = await pluginCtx.remote.workspace.archiveSession({ sessionId: 'session-demo-1' })
assert.ok(archiveRes.ok, 'Remote archive request must succeed')
assert.ok(archiveRes.value?.archivedSessionIds?.includes('session-demo-1'), 'Remote archive must return merged archivedSessionIds')
assert.ok(requestedUrls.some((u) => u.includes('/remote-ssh/session-archive')), 'Archive must hit /remote-ssh/session-archive')
assert.ok(wsList.archivedSessionIds.includes('session-demo-1'), 'Merged archivedSessionIds must be synced to wsList')

// Remote branch: unarchiveSession forwards to /remote-ssh/session-unarchive and updates wsList
const unarchiveRes = await pluginCtx.remote.workspace.unarchiveSession({ sessionId: 'session-demo-1' })
assert.ok(unarchiveRes.ok, 'Remote unarchive request must succeed')
assert.ok(!unarchiveRes.value?.archivedSessionIds?.includes('session-demo-1'), 'Remote unarchive must remove session-demo-1')
assert.ok(requestedUrls.some((u) => u.includes('/remote-ssh/session-unarchive')), 'Unarchive must hit /remote-ssh/session-unarchive')
assert.ok(!wsList.archivedSessionIds.includes('session-demo-1'), 'Unarchived session must be removed from wsList')

// Local branch: workspace archive/unarchive passes through
const localArchive = await pluginCtx.remote.workspace.archiveSession({ sessionId: 'session-local-x' })
assert.equal(localArchive.value?.method, 'archiveSession', 'Local archive must pass through')
const localUnarchive = await pluginCtx.remote.workspace.unarchiveSession({ sessionId: 'session-local-x' })
assert.equal(localUnarchive.value?.method, 'unarchiveSession', 'Local unarchive must pass through')

// Workspace actions: pinSession & unpinSession
// Remote branch: pinSession forwards to /remote-ssh/session-pin
const pinRes = await pluginCtx.remote.workspace.pinSession({ sessionId: 'session-demo-1' })
assert.ok(pinRes.ok, 'Remote pin request must succeed')
assert.ok(pinRes.value?.pinnedSessionIds?.includes('session-demo-1'), 'Remote pin must return merged pinnedSessionIds')
assert.ok(requestedUrls.some((u) => u.includes('/remote-ssh/session-pin')), 'Pin must hit /remote-ssh/session-pin')

// Remote branch: unpinSession forwards to /remote-ssh/session-unpin
const unpinRes = await pluginCtx.remote.workspace.unpinSession({ sessionId: 'session-demo-1' })
assert.ok(unpinRes.ok, 'Remote unpin request must succeed')
assert.ok(!unpinRes.value?.pinnedSessionIds?.includes('session-demo-1'), 'Remote unpin must remove session-demo-1')
assert.ok(requestedUrls.some((u) => u.includes('/remote-ssh/session-unpin')), 'Unpin must hit /remote-ssh/session-unpin')

// Local branch: workspace pin/unpin passes through
const localPin = await pluginCtx.remote.workspace.pinSession({ sessionId: 'session-local-x' })
assert.equal(localPin.value?.method, 'pinSession', 'Local pin must pass through')
const localUnpin = await pluginCtx.remote.workspace.unpinSession({ sessionId: 'session-local-x' })
assert.equal(localUnpin.value?.method, 'unpinSession', 'Local unpin must pass through')

// Teardown: restore getters and remove injected remote rows.
await fork.dispose()
const restoredPage = await root.get('remote.session').page({ sessionId: 'session-local-x' }, null)
const restoredWsArchive = await root.get('remote.workspace').archiveSession({ sessionId: 'session-local-x' })
assert.equal(restoredWsArchive.value?.method, 'archiveSession', 'Teardown must restore remote.workspace.archiveSession')
console.log(`teardown page passthrough method=${restoredPage.value?.method}`)
console.log(`teardown removed sessions: ${removedSessions.length} workspaces: ${removedWorkspaces.length}`)