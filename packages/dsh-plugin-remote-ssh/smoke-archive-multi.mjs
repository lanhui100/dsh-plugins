/**
 * Client-bundle archive/pin identity regression (multi-host namespaced IDs).
 *
 * The user-visible bug: after archiving a remote session, previously archived
 * remote sessions reappeared. Root cause: RemoteHostManager snapshots use
 * `remote:<host>:<id>` while mutation responses used to carry raw IDs, so the
 * client merged raw IDs as "local" and stale archived rows survived refreshes.
 *
 * This smoke drives client.js under a real Cordis Context with a namespaced
 * multi-host fixture and asserts:
 * - archive/unarchive round-trips keep the namespaced identity (no raw residue);
 * - mutations on one host never drop another host's archived/pinned state;
 * - local archived/pinned ids survive official baseline resets;
 * - pinned state is actually written to the official workspace model.
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

// Remote DSH persisted state as the fixed Host route reports it: namespaced.
const archived = new Set(['remote:dev:old'])
const pinned = new Set(['remote:dev:old-pinned'])

let archiveRequestBody = null
let unarchiveRequestBody = null
let pinRequestBody = null
let unpinRequestBody = null

globalThis.fetch = async (url) => {
  const urlStr = String(url)
  if (urlStr.includes('/remote-ssh/sessions')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        host: 'dev',
        archivedSessionIds: [...archived],
        pinnedSessionIds: [...pinned],
        workspaces: [
          {
            workspaceId: 'remote:dev:workspace%3A%2Fhome%2Fdev',
            cwd: '/home/dev',
            name: 'dev-repo',
            sessions: [{
              sessionId: 'remote:dev:s1',
              title: 'Dev',
              running: false,
              blank: false,
              cwd: '/home/dev',
              updatedAt: 1,
            }],
          },
          {
            workspaceId: 'remote:preprod:workspace%3A%2Fvar%2Fwww%2Fsite',
            cwd: '/var/www/site',
            name: 'site',
            sessions: [{
              sessionId: 'remote:preprod:s1',
              title: 'Prod',
              running: false,
              blank: false,
              cwd: '/var/www/site',
              updatedAt: 2,
            }],
          },
        ],
        sessions: [
          {
            sessionId: 'remote:dev:s1',
            title: 'Dev',
            running: false,
            blank: false,
            cwd: '/home/dev',
            updatedAt: 1,
          },
          {
            sessionId: 'remote:preprod:s1',
            title: 'Prod',
            running: false,
            blank: false,
            cwd: '/var/www/site',
            updatedAt: 2,
          },
        ],
      }),
    }
  }
  if (urlStr.includes('/remote-ssh/session-archive')) {
    return {
      ok: true,
      status: 200,
      json: async () => {
        const body = JSON.parse(archiveRequestBody || '{}')
        const sid = String(body.sessionId || '')
        if (sid && !archived.has(sid)) archived.add(sid)
        return { ok: true, value: { archivedSessionIds: [...archived] } }
      },
    }
  }
  if (urlStr.includes('/remote-ssh/session-unarchive')) {
    return {
      ok: true,
      status: 200,
      json: async () => {
        const body = JSON.parse(unarchiveRequestBody || '{}')
        archived.delete(String(body.sessionId || ''))
        return { ok: true, value: { archivedSessionIds: [...archived] } }
      },
    }
  }
  if (urlStr.includes('/remote-ssh/session-pin')) {
    return {
      ok: true,
      status: 200,
      json: async () => {
        const body = JSON.parse(pinRequestBody || '{}')
        const sid = String(body.sessionId || '')
        if (sid && !pinned.has(sid)) pinned.add(sid)
        return { ok: true, value: { pinnedSessionIds: [...pinned] } }
      },
    }
  }
  if (urlStr.includes('/remote-ssh/session-unpin')) {
    return {
      ok: true,
      status: 200,
      json: async () => {
        const body = JSON.parse(unpinRequestBody || '{}')
        pinned.delete(String(body.sessionId || ''))
        return { ok: true, value: { pinnedSessionIds: [...pinned] } }
      },
    }
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, value: {} }),
  }
}

// The browser evaluates the script purely to register the factory.
new Function(source)()

const clientExports = registration.factory((specifier) => {
  if (specifier === 'react') return undefined
  throw new Error(`unexpected external request: ${specifier}`)
})

class RemoteWorkspaceFilesService extends Service {
  constructor(ctx) {
    super(ctx, 'remote.workspaceFiles')
    this.stat = (...args) => Promise.resolve({ ok: true, value: {} })
    this.read = (...args) => Promise.resolve({ ok: true, value: {} })
    this.readBytes = (...args) => Promise.resolve({ ok: true, value: {} })
    this.list = (...args) => Promise.resolve({ ok: true, value: {} })
  }
}

class RemoteCommandsService extends Service {
  constructor(ctx) {
    super(ctx, 'remote.commands')
    this.list = (...args) => Promise.resolve({ ok: true, value: [] })
    this.execute = (...args) => Promise.resolve({ ok: true, value: { result: { kind: 'success' } } })
  }
}

class RemoteService extends Service {
  static [Service.tracker] = { associate: 'remote' }
  constructor(ctx) {
    super(ctx, 'remote')
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

const upserted = []
const removedWorkspaces = []

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
      replacePinned(ids) {
        this.pinnedSessionIds = [...ids]
      },
      installPinned(ids) {
        this.pinnedSessionIds = [...ids]
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
  handleSessionAdded(summary) {}
  handleSessionRemoved(id) {}
  handleSessionStatus(sessionId, running) {}
  handleSessionActivity(sessionId, updatedAt) {}
}

class UiSessionService extends Service {
  constructor(ctx) {
    super(ctx, 'uiSession')
  }
  registerPendingInteraction(fn) {
    return () => () => {}
  }
}

const root = new Context()
root.plugin(RemoteWorkspaceFilesService)
root.plugin(RemoteCommandsService)
root.plugin(RemoteService)
root.plugin(RemoteSessionService)
root.plugin(RemoteWorkspaceService)
root.plugin(WorkspacesService)
root.plugin(SessionsService)
root.plugin(UiSessionService)
root.plugin(FileUploadService)

const fork = root.plugin({
  name: registration.id,
  inject: clientExports.inject,
  apply: clientExports.apply,
})

if (fork.state === 3 || fork._error) {
  throw (fork._error || new Error('plugin failed to activate'))
}

const pluginCtx = fork.context

// Cordis activates plugin forks asynchronously; let the initial reconcile settle.
await new Promise((resolve) => setTimeout(resolve, 20))

const wsList = root.get('workspaces').list

// Baseline snapshot: dev host has an archived + pinned session; preprod has none.
assert.ok(
  wsList.archivedSessionIds.includes('remote:dev:old'),
  'Initial snapshot must register remote:dev:old as archived',
)
assert.ok(
  wsList.pinnedSessionIds.includes('remote:dev:old-pinned'),
  'Initial snapshot must register remote:dev:old-pinned as pinned',
)

// Local archived/pinned ids injected by an official baseline update survive.
wsList.replaceBaseline({
  items: [{ workspaceId: 'local-ws', path: '/local/1', title: 'Local 1' }],
  archivedSessionIds: ['local-archived-1'],
  pinnedSessionIds: ['local-pinned-1'],
})
assert.ok(
  wsList.archivedSessionIds.includes('local-archived-1') && wsList.archivedSessionIds.includes('remote:dev:old'),
  'Local archived ids must survive baseline reset next to remote archived ids',
)
assert.ok(
  wsList.pinnedSessionIds.includes('local-pinned-1') && wsList.pinnedSessionIds.includes('remote:dev:old-pinned'),
  'Local pinned ids must survive baseline reset next to remote pinned ids',
)

// Archive a preprod session: route returns the namespaced preprod set.
archiveRequestBody = JSON.stringify({ sessionId: 'remote:preprod:s1' })
const archiveRes = await pluginCtx.remote.workspace.archiveSession({ sessionId: 'remote:preprod:s1' })
assert.ok(archiveRes.ok, 'Remote archive request must succeed')
assert.ok(
  archiveRes.value?.archivedSessionIds?.includes('remote:preprod:s1'),
  'Archive response must carry the namespaced preprod id',
)
assert.ok(
  wsList.archivedSessionIds.includes('remote:preprod:s1'),
  'Archived preprod session must be merged into the official model',
)
assert.ok(
  wsList.archivedSessionIds.includes('remote:dev:old'),
  'Archiving preprod must NOT drop the dev host archived state',
)
assert.ok(
  wsList.archivedSessionIds.includes('local-archived-1'),
  'Archiving must not drop local archived ids',
)
assert.ok(
  !wsList.archivedSessionIds.includes('s1'),
  'Raw session id must never leak into the archived registry',
)

// A later poll snapshot (remote DSH persisted the archive) keeps the state.
await new Promise((resolve) => setTimeout(resolve, 20))
assert.ok(
  wsList.archivedSessionIds.includes('remote:preprod:s1') && wsList.archivedSessionIds.includes('local-archived-1'),
  'Archived state must survive the next snapshot reconcile',
)

// Unarchive the preprod session.
unarchiveRequestBody = JSON.stringify({ sessionId: 'remote:preprod:s1' })
const unarchiveRes = await pluginCtx.remote.workspace.unarchiveSession({ sessionId: 'remote:preprod:s1' })
assert.ok(unarchiveRes.ok, 'Remote unarchive request must succeed')
assert.ok(
  !unarchiveRes.value?.archivedSessionIds?.includes('remote:preprod:s1'),
  'Unarchive response must not carry the preprod id',
)
assert.ok(
  !wsList.archivedSessionIds.includes('remote:preprod:s1'),
  'Unarchived preprod session must leave the official model',
)
assert.ok(
  wsList.archivedSessionIds.includes('remote:dev:old') && wsList.archivedSessionIds.includes('local-archived-1'),
  'Unarchiving preprod must keep dev and local archived ids',
)

// Pin the preprod session: pinned state must actually reach the official model.
pinRequestBody = JSON.stringify({ sessionId: 'remote:preprod:s1' })
const pinRes = await pluginCtx.remote.workspace.pinSession({ sessionId: 'remote:preprod:s1' })
assert.ok(pinRes.ok, 'Remote pin request must succeed')
assert.ok(
  wsList.pinnedSessionIds.includes('remote:preprod:s1'),
  'Pinned preprod session must be written to the official pinned registry',
)
assert.ok(
  wsList.pinnedSessionIds.includes('remote:dev:old-pinned') && wsList.pinnedSessionIds.includes('local-pinned-1'),
  'Pinning preprod must keep dev and local pinned ids',
)

// Unpin the preprod session.
unpinRequestBody = JSON.stringify({ sessionId: 'remote:preprod:s1' })
const unpinRes = await pluginCtx.remote.workspace.unpinSession({ sessionId: 'remote:preprod:s1' })
assert.ok(unpinRes.ok, 'Remote unpin request must succeed')
assert.ok(
  !wsList.pinnedSessionIds.includes('remote:preprod:s1'),
  'Unpinned preprod session must leave the official pinned registry',
)
assert.ok(
  wsList.pinnedSessionIds.includes('remote:dev:old-pinned'),
  'Unpinning preprod must keep the dev host pinned state',
)

// Teardown removes remote state only.
await fork.dispose()
assert.ok(
  !wsList.archivedSessionIds.includes('remote:dev:old') && !wsList.archivedSessionIds.includes('remote:preprod:s1'),
  'Teardown must remove remote archived ids',
)
assert.ok(
  wsList.archivedSessionIds.includes('local-archived-1'),
  'Teardown must keep local archived ids',
)
assert.ok(
  !wsList.pinnedSessionIds.includes('remote:dev:old-pinned') && !wsList.pinnedSessionIds.includes('remote:preprod:s1'),
  'Teardown must remove remote pinned ids',
)
assert.ok(
  wsList.pinnedSessionIds.includes('local-pinned-1'),
  'Teardown must keep local pinned ids',
)

console.log('all smoke-archive-multi assertions passed cleanly!')

// ---------------------------------------------------------------------------
// Phase 2 (P2-1): a workspace model that exposes ONLY replaceArchived /
// replacePinned (no installArchived / installPinned). The guardian's
// replace*-only fallback must not recurse, and remote state must still land in
// the official model.
// ---------------------------------------------------------------------------
class ReplaceOnlyWorkspacesService extends Service {
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
      replacePinned(ids) {
        this.pinnedSessionIds = [...ids]
      },
      upsertView: (view) => {
        if (this.list.removedIds.has(view.workspaceId)) return
        const idx = this.list.items.findIndex((item) => item.workspaceId === view.workspaceId)
        if (idx === -1) this.list.items.unshift(view)
        else this.list.items[idx] = view
      },
      removeView: (id) => {
        this.list.removedIds.add(id)
        this.list.items = this.list.items.filter((item) => item.workspaceId !== id)
      },
    }
  }
}

const root2 = new Context()
root2.plugin(RemoteWorkspaceFilesService)
root2.plugin(RemoteCommandsService)
root2.plugin(RemoteService)
root2.plugin(RemoteSessionService)
root2.plugin(RemoteWorkspaceService)
root2.plugin(ReplaceOnlyWorkspacesService)
root2.plugin(SessionsService)
root2.plugin(UiSessionService)
root2.plugin(FileUploadService)

const fork2 = root2.plugin({
  name: registration.id,
  inject: clientExports.inject,
  apply: clientExports.apply,
})

if (fork2.state === 3 || fork2._error) {
  throw (fork2._error || new Error('replace-only plugin failed to activate'))
}

await new Promise((resolve) => setTimeout(resolve, 20))

const wsList2 = root2.get('workspaces').list

// The replace-only sync path must complete without recursion (no RangeError).
wsList2.replaceArchived(['local-only'])
assert.ok(
  wsList2.archivedSessionIds.includes('local-only') && wsList2.archivedSessionIds.includes('remote:dev:old'),
  'replaceArchived fallback must merge local and remote archived ids without recursion',
)

// A remote mutation must land in the official model through the replace-only path.
archiveRequestBody = JSON.stringify({ sessionId: 'remote:preprod:s1' })
const archiveRes2 = await fork2.context.remote.workspace.archiveSession({ sessionId: 'remote:preprod:s1' })
assert.ok(archiveRes2.ok, 'Replace-only archive request must succeed')
assert.ok(
  wsList2.archivedSessionIds.includes('remote:preprod:s1') && wsList2.archivedSessionIds.includes('local-only'),
  'Replace-only sync must merge the freshly archived preprod session',
)

// Pinned side: replacePinned fallback must also survive a mutation without recursion.
pinRequestBody = JSON.stringify({ sessionId: 'remote:preprod:s1' })
const pinRes2 = await fork2.context.remote.workspace.pinSession({ sessionId: 'remote:preprod:s1' })
assert.ok(pinRes2.ok, 'Replace-only pin request must succeed')
assert.ok(
  wsList2.pinnedSessionIds.includes('remote:preprod:s1') && wsList2.pinnedSessionIds.includes('remote:dev:old-pinned'),
  'Replace-only sync must merge pinned state without recursion',
)

await fork2.dispose()
assert.ok(
  !wsList2.pinnedSessionIds.includes('remote:preprod:s1'),
  'Replace-only teardown must remove remote pinned ids',
)

console.log('all smoke-archive-multi phase-2 (replace-only guard) assertions passed cleanly!')
