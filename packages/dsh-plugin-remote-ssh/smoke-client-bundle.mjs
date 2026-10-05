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
globalThis.fetch = async (url, opts) => {
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
  if (urlStr.includes('/remote-ssh/attachment')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        value: { attachment: { attachmentId: 'att-1', mediaType: 'image/png' }, data: 'QUJD' },
      }),
    }
  }
  if (urlStr.includes('/remote-ssh/file-upload')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        value: { receiptId: 'rcpt-1', file: { attachmentId: 'att-f1', name: 'notes.txt', bytes: 3 } },
      }),
    }
  }
  if (urlStr.includes('/remote-ssh/commands-list')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, value: [{ name: 'remote-cmd', description: 'A remote command' }] }),
    }
  }
  if (urlStr.includes('/remote-ssh/commands-execute')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, value: { result: { kind: 'success', text: 'done' } } }),
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
    // Reuse path (official UI passes an existing blank sessionId): the remote
    // adopts the blank and returns its id; a fresh create returns a new id.
    let body = {}
    try {
      body = opts && typeof opts.body === 'string' ? JSON.parse(opts.body) : {}
    } catch {
      body = {}
    }
    const sessionId = typeof body.sessionId === 'string' && body.sessionId !== '' ? 'session-demo-1' : 'session-remote-new-1'
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, value: { sessionId, agentPreset: 'standard' } }),
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
  if (urlStr.includes('/remote-ssh/session-select-model')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        value: {
          selected: {
            provider: 'anthropic',
            model: 'claude-3-7-sonnet',
            reasoningEffort: 'high',
          },
        },
      }),
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

class RemoteCommandsService extends Service {
  constructor(ctx) {
    super(ctx, 'remote.commands')
    for (const method of ['list', 'execute']) {
      Object.defineProperty(this, method, {
        configurable: true,
        enumerable: true,
        get: () => (...args) => Promise.resolve({
          ok: true,
          value: method === 'list'
            ? [{ name: 'local-help', description: 'Local help' }]
            : { result: { kind: 'success', text: 'local' } },
        }),
      })
    }
  }
}

class RemoteService extends Service {
  static [Service.tracker] = { associate: 'remote' }
  constructor(ctx) {
    super(ctx, 'remote')
    this.fileUploads = {
      upload: (...args) => ({ ok: true, value: { method: 'upload', args } }),
    }
    this.commands = ctx.get('remote.commands')
  }
}

class FileUploadService extends Service {
  constructor(ctx) {
    super(ctx, 'fileUpload')
  }
  upload(...args) {
    return Promise.resolve({ ok: true, value: { method: 'upload', args } })
  }
}

class CommandUiService extends Service {
  constructor(ctx) {
    super(ctx, 'commandUi')
    this.live = {
      contributions: new Map([
        ['file', {
          name: 'file',
          available: (session) => session.sessionId === 'session-local-accepted',
          ui: { run: (session) => { this.lastRun = session.sessionId } },
        }],
      ]),
    }
  }
}

class RemoteSessionService extends Service {
  constructor(ctx) {
    super(ctx, 'remote.session')
    for (const method of ['page', 'follow', 'projections', 'prompt', 'cancel', 'rename', 'selectModel', 'attachment', 'create']) {
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

class RemoteWorkspaceFilesService extends Service {
  constructor(ctx) {
    super(ctx, 'remote.workspaceFiles')
    for (const method of ['stat', 'read', 'readBytes', 'list']) {
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
root.plugin(RemoteCommandsService)
root.plugin(RemoteService)
root.plugin(RemoteSessionService)
root.plugin(RemoteWorkspaceService)
root.plugin(RemoteWorkspaceFilesService)
root.plugin(WorkspacesService)
root.plugin(SessionsService)
root.plugin(UiSessionService)
root.plugin(FileUploadService)
root.plugin(CommandUiService)

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

// Reuse path: the official UI reuses a blank remote session by passing its id.
// The remote adopts the EXISTING blank (returning the same id); the workspace
// view must NOT prepend a duplicate row (the reuse-adopt would otherwise show
// a copy of the original session in the tree).
const wsBeforeReuse = upserted.filter((v) => v.workspaceId === 'remote:/tmp/demo').at(-1)
assert.ok(
  (wsBeforeReuse?.sessionIds || []).includes('session-demo-1'),
  'Workspace must already list the blank session before reuse create',
)
const reuseCreate = await pluginCtx.remote.session.create({
  workspaceId: 'remote:/tmp/demo',
  sessionId: 'session-demo-1',
})
assert.ok(reuseCreate.ok, 'Reuse create must succeed')
assert.equal(reuseCreate.value?.sessionId, 'session-demo-1', 'Reuse create must return the adopted blank id')
const wsAfterReuse = upserted.filter((v) => v.workspaceId === 'remote:/tmp/demo').at(-1)
const occurrences = (wsAfterReuse?.sessionIds || []).filter((id) => id === 'session-demo-1').length
assert.equal(occurrences, 1, 'Workspace sessionIds must not duplicate a reused blank session id')
// The fresh create earlier added session-remote-new-1; reuse must not add a third row.
assert.equal((wsAfterReuse?.sessionIds || []).length, 2, 'Reuse create must not grow the workspace session list')

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

// Session actions: selectModel
// Remote branch: selectModel forwards to /remote-ssh/session-select-model
const selectModelRes = await pluginCtx.remote.session.selectModel({
  sessionId: 'session-demo-1',
  provider: 'anthropic',
  model: 'claude-3-7-sonnet',
  reasoningEffort: 'high',
})
assert.ok(selectModelRes.ok, 'Remote selectModel request must succeed')
assert.equal(selectModelRes.value?.selected?.provider, 'anthropic', 'Remote selectModel must return provider')
assert.equal(selectModelRes.value?.selected?.model, 'claude-3-7-sonnet', 'Remote selectModel must return model')
assert.ok(requestedUrls.some((u) => u.includes('/remote-ssh/session-select-model')), 'selectModel must hit /remote-ssh/session-select-model')

// Local branch: selectModel passes through
const localSelectModel = await pluginCtx.remote.session.selectModel({
  sessionId: 'session-local-x',
  provider: 'deepseek',
  model: 'deepseek-chat',
})
assert.equal(localSelectModel.value?.method, 'selectModel', 'Local selectModel must pass through')

// Session actions: attachment read forwards to /remote-ssh/attachment
const attachmentRes = await pluginCtx.remote.session.attachment({ sessionId: 'session-demo-1', attachmentId: 'att-1' })
assert.ok(attachmentRes.ok, 'Remote attachment read must succeed')
assert.equal(attachmentRes.value?.attachment?.attachmentId, 'att-1', 'Remote attachment must return durable ref')
assert.ok(requestedUrls.some((u) => u.includes('/remote-ssh/attachment')), 'Attachment must hit /remote-ssh/attachment')

// File upload forwards to /remote-ssh/file-upload
const uploadRes = await pluginCtx.fileUpload.upload('session-demo-1', new Uint8Array([1, 2, 3]), 'notes.txt')
assert.ok(uploadRes.ok, 'Remote file upload must succeed')
assert.equal(uploadRes.value?.receiptId, 'rcpt-1', 'Remote upload must return receiptId')
assert.ok(requestedUrls.some((u) => u.includes('/remote-ssh/file-upload')), 'Upload must hit /remote-ssh/file-upload')

// Local branch: attachment and upload pass through
const localAttachment = await pluginCtx.remote.session.attachment({ sessionId: 'session-local-x', attachmentId: 'att-x' })
assert.equal(localAttachment.value?.method, 'attachment', 'Local attachment must pass through')
const localUpload = await pluginCtx.fileUpload.upload('session-local-x', new Uint8Array([1]), 'a.txt')
assert.equal(localUpload.value?.method, 'upload', 'Local file upload must pass through')

// Direct ctx.remote.fileUploads.upload wraps the same tunnel route
const remoteNsUpload = await pluginCtx.remote.fileUploads.upload('session-demo-1', { data: 'QUJD', name: 'a.txt' })
assert.ok(remoteNsUpload.ok, 'Direct remote.fileUploads upload must succeed')
assert.equal(remoteNsUpload.value?.receiptId, 'rcpt-1', 'Remote fileUploads upload must return receiptId')
const localRemoteNsUpload = await pluginCtx.remote.fileUploads.upload('session-local-x', { data: 'QUJD' })
assert.equal(localRemoteNsUpload.value?.method, 'upload', 'Local remote.fileUploads upload must pass through')

// Remote branch: commands list and execute forward to tunnel routes
const remoteCmds = await pluginCtx.remote.commands.list('session-demo-1')
assert.ok(remoteCmds.ok, 'Remote commands list must succeed')
assert.equal(remoteCmds.value?.[0]?.name, 'remote-cmd', 'Remote commands list must return remote commands')
assert.ok(requestedUrls.some((u) => u.includes('/remote-ssh/commands-list')), 'Commands list must hit /remote-ssh/commands-list')

const remoteExec = await pluginCtx.remote.commands.execute('session-demo-1', '/remote-cmd')
assert.ok(remoteExec.ok, 'Remote commands execute must succeed')
assert.equal(remoteExec.value?.result?.text, 'done', 'Remote commands execute must return result')
assert.ok(requestedUrls.some((u) => u.includes('/remote-ssh/commands-execute')), 'Commands execute must hit /remote-ssh/commands-execute')

// Local branch: commands list and execute pass through
const localCmds = await pluginCtx.remote.commands.list('session-local-x')
assert.equal(localCmds.value?.[0]?.name, 'local-help', 'Local commands list must pass through')
const localExec = await pluginCtx.remote.commands.execute('session-local-x', '/local-help')
assert.equal(localExec.value?.result?.text, 'local', 'Local commands execute must pass through')

// Remote attachment command interceptor:
// Ensures '+' command menu's "file" command is always available on remote sessions
const commandUi = root.get('commandUi')
const fileCmd = commandUi.live.contributions.get('file')
assert.ok(fileCmd, 'commandUi must register "file" contribution')
assert.equal(fileCmd.available({ sessionId: 'session-demo-1' }), true, '"file" command must be available on remote sessions')
assert.equal(fileCmd.available({ sessionId: 'session-local-x' }), false, '"file" command must preserve local policy for local sessions')
assert.equal(fileCmd.available({ sessionId: 'session-local-accepted' }), true, '"file" command must preserve true for accepted local sessions')

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