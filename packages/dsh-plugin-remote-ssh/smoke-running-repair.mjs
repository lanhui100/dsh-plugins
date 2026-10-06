/**
 * Regression smoke for the "running session shows a completed green dot" bug.
 *
 * Reproduces the drift chain:
 *   1. A follow-stream transport close mid-turn (no turn/end seen) used to
 *      unconditionally reset the session to idle in `finally`, which the
 *      official UiSession paints as "completed".
 *   2. Because the remote snapshot still reports running=true, the poll
 *      fingerprint never changed and the drift was never repaired.
 *
 * This smoke asserts the two fixes:
 *   - follow teardown without turn/end or consumer abort must NOT emit
 *     handleSessionStatus(id, false);
 *   - an unchanged-fingerprint poll MUST repair a diverged local running bit
 *     by reasserting the authoritative remote state.
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

// Controllable poll: apply() registers one 60s interval; tests invoke it manually.
const intervalFns = []
const realSetInterval = globalThis.setInterval
globalThis.setInterval = (fn, ms) => {
  intervalFns.push(fn)
  return intervalFns.length
}
globalThis.clearInterval = () => {}

let remoteSnapshot = {
  host: 'dev',
  homes: [{ host: 'dev', home: '/tmp' }],
  archivedSessionIds: [],
  pinnedSessionIds: [],
  workspaces: [
    {
      workspaceId: 'remote:dev:ws',
      cwd: '/home/dev',
      name: 'dev-repo',
      sessions: [{ sessionId: 'remote:dev:s1', running: true, updatedAt: 100 }],
    },
  ],
  sessions: [{ sessionId: 'remote:dev:s1', running: true, cwd: '/home/dev', updatedAt: 100 }],
}

globalThis.fetch = async (url) => {
  const urlStr = String(url)
  if (urlStr.includes('/remote-ssh/sessions')) {
    return { ok: true, status: 200, json: async () => ({ ...remoteSnapshot }) }
  }
  if (urlStr.includes('/remote-ssh/session-follow')) {
    // A mid-turn transport close: only the opening snapshot frame arrives, no
    // turn/start or turn/end. Previously this teardown reset the session to idle.
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"snapshot","cursor":1,"records":[]}\n\n'))
        controller.close()
      },
    })
    return { ok: true, status: 200, headers: { get: () => 'text/event-stream' }, body: stream }
  }
  return { ok: true, status: 200, json: async () => ({}) }
}

// A browser evaluates the script purely to register the factory.
new Function(source)()

const clientExports = registration.factory((specifier) => {
  if (specifier === 'react') return undefined
  throw new Error(`unexpected external request: ${specifier}`)
})

const statusUpdates = []
let byIdRunning = {}

class SessionsService extends Service {
  constructor(ctx) {
    super(ctx, 'sessions')
    // Minimal live list store mirroring the official ClientSessions surface.
    this.list = {
      getSnapshot: () => ({ byId: byIdRunning, phase: 'ready' }),
    }
  }
  handleSessionAdded() {}
  handleSessionRemoved() {}
  handleSessionStatus(sessionId, running) {
    statusUpdates.push({ sessionId, running })
    // Mirror what the official manager does: the list row follows the status.
    byIdRunning = { ...byIdRunning, [sessionId]: { running } }
  }
  handleSessionActivity() {}
}

class WorkspacesService extends Service {
  constructor(ctx) {
    super(ctx, 'workspaces')
    this.list = {
      items: [],
      archivedSessionIds: [],
      pinnedSessionIds: [],
      removedIds: new Set(),
      upsertView: (view) => {
        const idx = this.list.items.findIndex((item) => item.workspaceId === view.workspaceId)
        if (idx === -1) this.list.items.unshift(view)
        else this.list.items[idx] = view
      },
      removeView: (id) => {
        this.list.removedIds.add(id)
        this.list.items = this.list.items.filter((item) => item.workspaceId !== id)
      },
      replaceBaseline() {},
      replaceArchived() {},
      installArchived() {},
    }
  }
}

class RemoteService extends Service {
  static [Service.tracker] = { associate: 'remote' }
  constructor(ctx) { super(ctx, 'remote') }
}
class RemoteSessionService extends Service {
  constructor(ctx) {
    super(ctx, 'remote.session')
    for (const m of ['page', 'follow', 'projections', 'prompt', 'cancel', 'rename', 'selectModel', 'attachment', 'create']) {
      Object.defineProperty(this, m, { configurable: true, enumerable: true, get: () => (...a) => ({ ok: true, value: {} }) })
    }
  }
}
class RemoteWorkspaceService extends Service {
  constructor(ctx) {
    super(ctx, 'remote.workspace')
    for (const m of ['archiveSession', 'unarchiveSession', 'pinSession', 'unpinSession']) {
      Object.defineProperty(this, m, { configurable: true, enumerable: true, get: () => (...a) => ({ ok: true, value: {} }) })
    }
  }
}
class RemoteCommandsService extends Service {
  constructor(ctx) { super(ctx, 'remote.commands') }
}
class RemoteWorkspaceFilesService extends Service {
  constructor(ctx) { super(ctx, 'remote.workspaceFiles') }
}
class FileUploadService extends Service {
  constructor(ctx) { super(ctx, 'fileUpload') }
}

const root = new Context()
root.plugin(RemoteCommandsService)
root.plugin(RemoteWorkspaceFilesService)
root.plugin(RemoteService)
root.plugin(RemoteSessionService)
root.plugin(RemoteWorkspaceService)
root.plugin(WorkspacesService)
root.plugin(SessionsService)
root.plugin(FileUploadService)

const fork = root.plugin({
  name: registration.id,
  inject: clientExports.inject,
  apply: clientExports.apply,
})
if (fork.state === 3 || fork._error) throw (fork._error || new Error('plugin failed to activate'))

const pluginCtx = fork.context

// Settle the initial reconcile: the running session must be asserted running.
await new Promise((resolve) => setTimeout(resolve, 20))
assert.ok(
  statusUpdates.some((u) => u.sessionId === 'remote:dev:s1' && u.running === true),
  'Initial reconcile must assert the running session as running=true',
)
assert.equal(intervalFns.length, 1, 'apply must register the 60s poll timer')

// --- Fix A: mid-turn follow teardown must NOT reset the session to idle ---
const beforeFollow = statusUpdates.length
const iterator = pluginCtx.remote.session.follow(
  { address: { kind: 'session', sessionId: 'remote:dev:s1' } },
  null,
)
while (true) {
  const nextItem = await iterator.next()
  if (nextItem.done) break
}
assert.equal(
  statusUpdates.length,
  beforeFollow,
  'Follow teardown without turn/end or consumer abort must not emit handleSessionStatus(false)',
)
assert.equal(byIdRunning['remote:dev:s1']?.running, true, 'Session must stay running after mid-turn teardown')

// --- Fix B: unchanged-fingerprint poll repairs a diverged local running bit ---
// Simulate drift already present (e.g. a legacy false reset or another path):
// the official list store believes idle while the remote reports running.
byIdRunning = { ...byIdRunning, 'remote:dev:s1': { running: false } }
const beforeRepair = statusUpdates.length
await intervalFns[0]()
await new Promise((resolve) => setTimeout(resolve, 5))
assert.ok(
  statusUpdates.length > beforeRepair &&
    statusUpdates[statusUpdates.length - 1].sessionId === 'remote:dev:s1' &&
    statusUpdates[statusUpdates.length - 1].running === true,
  'Unchanged-fingerprint poll must reassert running=true when the local store diverged',
)

// --- Fix C: unchanged-fingerprint poll repairs the reverse drift too ---
// Remote session actually idle, but the local store (e.g. prompt residue)
// believes running. First let the fingerprint settle on running=false.
remoteSnapshot.sessions[0].running = false
remoteSnapshot.workspaces[0].sessions[0].running = false
await intervalFns[0]()
await new Promise((resolve) => setTimeout(resolve, 5))
assert.equal(byIdRunning['remote:dev:s1']?.running, false, 'Reconcile must settle the session to idle')
// Now forge the opposite drift and repoll with an unchanged snapshot.
byIdRunning = { ...byIdRunning, 'remote:dev:s1': { running: true } }
const beforeReverse = statusUpdates.length
await intervalFns[0]()
await new Promise((resolve) => setTimeout(resolve, 5))
assert.ok(
  statusUpdates.length > beforeReverse &&
    statusUpdates[statusUpdates.length - 1].sessionId === 'remote:dev:s1' &&
    statusUpdates[statusUpdates.length - 1].running === false,
  'Unchanged-fingerprint poll must reassert running=false when the local store diverged',
)

// --- No-op when aligned: an identical poll must not spam handleSessionStatus ---
const beforeNoop = statusUpdates.length
await intervalFns[0]()
await new Promise((resolve) => setTimeout(resolve, 5))
assert.equal(
  statusUpdates.length,
  beforeNoop,
  'Aligned unchanged poll must not emit redundant handleSessionStatus calls',
)

await fork.dispose()
console.log('all smoke-running-repair assertions passed cleanly!')
