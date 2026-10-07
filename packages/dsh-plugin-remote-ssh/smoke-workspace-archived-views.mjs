/**
 * Frozen black-box acceptance tests for the workspace archived-view contract.
 *
 * Authority: docs/dev-team/specs/workspace-archived-view-contract.md (frozen
 * before the Executor started). This file is RED-phase: against the current
 * implementation it must fail with an AssertionError whose message names the
 * violated clause (C1 / C2 / C3) — never with a load, stub or syntax failure.
 *
 * What is driven, black-box:
 * - Phase 1 (C1) — the real `/remote-ssh/sessions` HTTP handler registered by
 *   src/route.ts, through a fake webServer gateway and fake RemoteCallers
 *   (same harness shape as smoke-multi-host.mjs). Asserts the observable
 *   response payload only.
 * - Phases 2-5 (C2 / C3) — the real client.js evaluated and activated on a
 *   Cordis Context against a stub official WorkspaceModel / SessionsModel
 *   (same harness shape as smoke-archive-multi.mjs). Asserts only what the
 *   plugin publishes into the official models.
 *
 * The official grouping rule (workspace.sessionIds ∩ list.byId, then
 * sessionVisible, then "drop empty groups under archivedFilter === 'only'") is
 * restated below as an oracle so the official model can be evaluated headlessly.
 * It is copied from the frozen contract's "官方契约" section, not from the plugin.
 */

import assert from 'node:assert/strict'
import { readFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'

import { registerRemoteSshRoute, SESSIONS_ROUTE } from './lib/route.js'
import { RemoteHostManager } from './lib/manager.js'

const here = dirname(fileURLToPath(import.meta.url))

/** Namespaced session id exactly as route.ts/source.ts publish it. */
const ns = (host, id) => `remote:${host}:${encodeURIComponent(id)}`
/** Namespaced synthetic workspace id exactly as route.ts/source.ts publish it. */
const nsWs = (host, cwd) => ns(host, `workspace:${cwd}`)

// ===========================================================================
// Official model oracle — restated from the frozen contract's 官方契约 §1.
// ===========================================================================

/**
 * Official `sessionVisible`: subagents are never shown, only the selected blank
 * session is shown, archived rows follow the archived filter.
 */
function officialSessionVisible(session, current, archived, archivedFilter) {
  if (session.origin === 'subagent') return false
  if (session.blank && session.id !== current) return false
  switch (archivedFilter) {
    case 'default': return !archived.has(session.id)
    case 'show': return true
    case 'only': return archived.has(session.id)
    default: throw new Error(`unknown archivedFilter: ${archivedFilter}`)
  }
}

/**
 * Official `groupByWorkspace`: members resolve from `workspace.sessionIds`
 * against `list.byId`; under `archivedFilter === 'only'` a group with no
 * visible members is dropped entirely.
 */
function officialGroupByWorkspace(list, workspaces, archived, archivedFilter) {
  const current = list.currentSessionId
  const groups = []
  for (const workspace of workspaces) {
    const members = []
    for (const id of workspace.sessionIds || []) {
      const summary = list.byId[id]
      if (summary === undefined) continue
      if (!officialSessionVisible(summary, current, archived, archivedFilter)) continue
      members.push(summary)
    }
    if (archivedFilter === 'only' && members.length === 0) continue
    groups.push({ key: workspace.workspaceId, workspaceId: workspace.workspaceId, members })
  }
  return groups
}

// ===========================================================================
// Phase 1 — C1: /remote-ssh/sessions ships the authoritative member set.
// ===========================================================================

console.log('== Phase 1 (C1): host snapshot must ship workspaces[].sessionIds ==')

/** Fake webServer gateway: collects route handlers by path. */
function makeGateway() {
  const routes = new Map()
  const ctx = {
    inject: (deps, cb) => {
      cb({
        webServer: {
          register: (route) => {
            routes.set(route.path, route.handler)
            return () => {}
          },
        },
        effect: (fn) => { fn(); return () => {} },
      })
    },
    effect: (fn) => { fn(); return () => {} },
    logger: { info: () => {}, warn: () => {} },
  }
  return { routes, ctx }
}

/** Invoke one registered route handler and decode its JSON body. */
async function callRoute(handler) {
  let status = 0
  let body = null
  await handler(
    {},
    {
      writeHead: (code) => { status = code },
      end: (text) => { body = text ? JSON.parse(text) : null },
    },
  )
  return { status, body }
}

/** Fake remote caller: only the RPC surface route.ts actually calls. */
function fakeCaller({ sessions, baseline }) {
  return {
    invoke: async (method) => {
      if (method === 'session/list') return { items: sessions }
      if (method === 'session/projections') return { asOfSeq: 1, values: {} }
      if (method === 'session/page') return { records: [], hasMore: false }
      return {}
    },
    fetchWorkspaceBaseline: async () => {
      if (typeof baseline === 'function') return baseline()
      return baseline
    },
    getPendingInteractionsForSession: () => [],
    ensureEventsListener: async () => {},
    dispose: () => {},
  }
}

// dev baseline: authoritative member order is deliberately NOT the recency
// order, so a grouping-derived member set cannot accidentally satisfy C1.
const DEV_BASELINE = {
  items: [
    { workspaceId: 'ws-dev-app', path: '/srv/app', title: 'app', sessionIds: ['arch-beta', 'arch-alpha'] },
    { workspaceId: 'ws-dev-labs', path: '/srv/labs', title: 'labs', sessionIds: ['live-1'] },
  ],
  archivedSessionIds: ['arch-beta', 'arch-alpha'],
  pinnedSessionIds: ['live-1'],
}

const DEV_SESSIONS = [
  { sessionId: 'arch-alpha', cwd: '/srv/app', title: 'Alpha', running: false, blank: false, updatedAt: 900 },
  { sessionId: 'arch-beta', cwd: '/srv/app', title: 'Beta', running: false, blank: false, updatedAt: 10 },
  { sessionId: 'live-2', cwd: '/srv/app', title: 'Live 2', running: false, blank: false, updatedAt: 40 },
  { sessionId: 'fresh-1', cwd: '/srv/app', title: 'Fresh', running: false, blank: false, updatedAt: 5 },
  { sessionId: 'live-1', cwd: '/srv/labs', title: 'Live 1', running: false, blank: false, updatedAt: 20 },
]

const PREPROD_BASELINE = {
  items: [{ workspaceId: 'ws-pp-site', path: '/var/www', title: 'site', sessionIds: ['pp-arch'] }],
  archivedSessionIds: ['pp-arch'],
  pinnedSessionIds: [],
}

const PREPROD_SESSIONS = [
  { sessionId: 'pp-arch', cwd: '/var/www', title: 'PP Archived', running: false, blank: false, updatedAt: 5 },
]

/** C1 expected order: baseline members first, then this round's new discoveries. */
const DEV_APP_EXPECTED = [ns('dev', 'arch-beta'), ns('dev', 'arch-alpha'), ns('dev', 'live-2'), ns('dev', 'fresh-1')]
const DEV_LABS_EXPECTED = [ns('dev', 'live-1')]
const PREPROD_SITE_EXPECTED = [ns('preprod', 'pp-arch')]

const devCaller = fakeCaller({ sessions: DEV_SESSIONS, baseline: DEV_BASELINE })
const preprodCaller = fakeCaller({ sessions: PREPROD_SESSIONS, baseline: PREPROD_BASELINE })
const offlineCaller = fakeCaller({ sessions: DEV_SESSIONS, baseline: () => { throw new Error('baseline offline') } })

const tempStorage = join(tmpdir(), `ws-archived-views-${Date.now()}.json`)
const tempSshConfig = join(tmpdir(), `ws-archived-views-${Date.now()}.conf`)

try {
  // --- 1a. multi-host aggregation branch -------------------------------------
  const manager = new RemoteHostManager({
    primaryHost: 'dev',
    primaryRemotePort: 3080,
    primaryLocalPort: 39501,
    storagePath: tempStorage,
  })
  const devEntry = manager.getAllEntries().find((e) => e.config.host === 'dev')
  devEntry.isReady = true
  devEntry.caller = devCaller
  devEntry.homeDirectory = '/home/dm'

  manager.registerConfiguredHost({ host: 'preprod', remotePort: 3080, localPort: 39502 })
  const preprodEntry = manager.getAllEntries().find((e) => e.config.host === 'preprod')
  preprodEntry.isReady = true
  preprodEntry.caller = preprodCaller
  preprodEntry.homeDirectory = '/home/pp'

  const multi = makeGateway()
  registerRemoteSshRoute(multi.ctx, manager, 'dev', tempSshConfig)
  const multiHandler = multi.routes.get(SESSIONS_ROUTE)
  assert.ok(multiHandler, `${SESSIONS_ROUTE} must be registered`)

  const multiRes = await callRoute(multiHandler)
  assert.equal(multiRes.status, 200, 'C1: the sessions route must answer 200 for the multi-host branch')
  const multiBody = multiRes.body

  assert.ok(
    multiBody.workspaces.length > 0,
    'C1: the fixture must produce at least one aggregated workspace before member sets are checked',
  )
  for (const ws of multiBody.workspaces) {
    assert.ok(
      Array.isArray(ws.sessionIds),
      `C1: aggregated workspaces[] entry for cwd "${ws.cwd}" must expose a sessionIds array ` +
      '(the authoritative baseline member set), but the snapshot carries none',
    )
  }

  const multiByCwd = new Map(multiBody.workspaces.map((ws) => [ws.cwd, ws]))

  const devApp = multiByCwd.get('/srv/app')
  assert.ok(devApp, 'C1: the /srv/app workspace must be present in the multi-host aggregate')
  assert.deepEqual(
    devApp.sessionIds.slice(0, DEV_BASELINE.items[0].sessionIds.length),
    DEV_BASELINE.items[0].sessionIds.map((id) => ns('dev', id)),
    'C1: baseline items[].sessionIds must lead workspaces[].sessionIds, in baseline order ' +
    '(not in session/list recency order)',
  )
  assert.deepEqual(
    devApp.sessionIds,
    DEV_APP_EXPECTED,
    'C1: workspaces[].sessionIds must be baseline members first, then this round\'s newly ' +
    'discovered ids, deduplicated and namespaced',
  )
  assert.equal(
    new Set(devApp.sessionIds).size,
    devApp.sessionIds.length,
    'C1: workspaces[].sessionIds must be deduplicated (a session must appear once)',
  )
  assert.ok(
    devApp.sessionIds.every((id) => id.startsWith('remote:dev:')),
    'C1: every workspaces[].sessionIds member must be namespaced with namespaceRemoteId(host, id)',
  )

  const devLabs = multiByCwd.get('/srv/labs')
  assert.ok(devLabs, 'C1: the /srv/labs workspace must be present in the multi-host aggregate')
  assert.deepEqual(
    devLabs.sessionIds,
    DEV_LABS_EXPECTED,
    'C1: a session already covered by the baseline must not be duplicated when discovered again',
  )

  const ppSite = multiByCwd.get('/var/www')
  assert.ok(ppSite, 'C1: the preprod /var/www workspace must be present in the multi-host aggregate')
  assert.deepEqual(
    ppSite.sessionIds,
    PREPROD_SITE_EXPECTED,
    'C1: every host in the multi-host aggregate must publish its own namespaced member set',
  )

  // --- 1b. single-caller fallback branch must behave identically ------------
  const single = makeGateway()
  registerRemoteSshRoute(single.ctx, () => devCaller, 'dev', tempSshConfig)
  const singleHandler = single.routes.get(SESSIONS_ROUTE)
  assert.ok(singleHandler, `${SESSIONS_ROUTE} must be registered for the single-caller branch`)

  const singleRes = await callRoute(singleHandler)
  assert.equal(singleRes.status, 200, 'C1: the sessions route must answer 200 for the single-caller branch')
  const singleByCwd = new Map(singleRes.body.workspaces.map((ws) => [ws.cwd, ws]))

  assert.ok(
    Array.isArray(singleByCwd.get('/srv/app')?.sessionIds),
    'C1: the single-caller fallback branch must also expose workspaces[].sessionIds',
  )
  assert.deepEqual(
    singleByCwd.get('/srv/app').sessionIds,
    DEV_APP_EXPECTED,
    'C1: the single-caller fallback branch must produce the same member set as the multi-host branch',
  )
  assert.deepEqual(
    singleByCwd.get('/srv/labs').sessionIds,
    DEV_LABS_EXPECTED,
    'C1: the single-caller fallback branch must agree with the multi-host branch on every workspace',
  )

  // --- 1c. baseline missing must degrade, not throw ------------------------
  const offline = makeGateway()
  registerRemoteSshRoute(offline.ctx, () => offlineCaller, 'dev', tempSshConfig)
  const offlineHandler = offline.routes.get(SESSIONS_ROUTE)
  assert.ok(offlineHandler, `${SESSIONS_ROUTE} must be registered for the baseline-missing case`)

  const offlineRes = await callRoute(offlineHandler)
  assert.equal(
    offlineRes.status,
    200,
    'C1: a missing workspace baseline must degrade to the grouping result, never a 502',
  )
  assert.ok(
    offlineRes.body.workspaces.length > 0,
    'C1: the baseline-missing degradation must still return the grouped workspaces',
  )
  for (const ws of offlineRes.body.workspaces) {
    assert.ok(
      Array.isArray(ws.sessionIds),
      `C1: workspaces[].sessionIds must still be an array when the baseline is missing (cwd "${ws.cwd}")`,
    )
    assert.deepEqual(
      ws.sessionIds,
      (ws.sessions || []).map((s) => String(s.sessionId)),
      'C1: with no baseline the member set must degrade to the existing grouping result, namespaced',
    )
  }
} finally {
  try { unlinkSync(tempStorage) } catch {}
  try { unlinkSync(tempSshConfig) } catch {}
}

console.log('== Phase 1 (C1): host snapshot assertions passed ==')

// ===========================================================================
// Phases 2-5 — C2 / C3: what client.js publishes into the official models.
// ===========================================================================

const clientSource = readFileSync(join(here, 'client.js'), 'utf8')

let registration
globalThis.window = {
  __ModuleLoader__: {
    load: (value) => { registration = value },
  },
}

// The browser evaluates the script purely to register the factory.
new Function(clientSource)()

function buildClientExports() {
  return registration.factory((specifier) => {
    if (specifier === 'react') return undefined
    throw new Error(`unexpected external request: ${specifier}`)
  })
}

class RemoteWorkspaceFilesService extends Service {
  constructor(ctx) {
    super(ctx, 'remote.workspaceFiles')
    this.stat = () => Promise.resolve({ ok: true, value: {} })
    this.read = () => Promise.resolve({ ok: true, value: {} })
    this.readBytes = () => Promise.resolve({ ok: true, value: {} })
    this.list = () => Promise.resolve({ ok: true, value: {} })
  }
}

class RemoteCommandsService extends Service {
  constructor(ctx) {
    super(ctx, 'remote.commands')
    this.list = () => Promise.resolve({ ok: true, value: [] })
    this.execute = () => Promise.resolve({ ok: true, value: { result: { kind: 'success' } } })
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

class UiSessionService extends Service {
  constructor(ctx) {
    super(ctx, 'uiSession')
  }
  registerPendingInteraction() {
    return () => () => {}
  }
}

/**
 * Official WorkspaceModel stub. Official items are seeded verbatim and every
 * plugin write is recorded separately, so "the plugin must not rewrite official
 * items" is observable from both directions.
 */
function makeWorkspacesService(seed, journal) {
  return class WorkspacesService extends Service {
    constructor(ctx) {
      super(ctx, 'workspaces')
      const pristine = seed.officialItems.map((item) => ({ ...item, sessionIds: [...item.sessionIds] }))
      this.list = {
        items: pristine.map((item) => ({ ...item, sessionIds: [...item.sessionIds] })),
        archivedSessionIds: [...seed.officialArchived],
        pinnedSessionIds: [...seed.officialPinned],
        removedIds: new Set(),
        upserts: [],
        pristine,
        replaceBaseline(baseline) {
          this.items = [...(baseline.items || [])]
          this.archivedSessionIds = [...(baseline.archivedSessionIds || [])]
          this.pinnedSessionIds = [...(baseline.pinnedSessionIds || [])]
        },
        replaceArchived(ids) { this.archivedSessionIds = [...ids] },
        installArchived(ids) { this.archivedSessionIds = [...ids] },
        replacePinned(ids) { this.pinnedSessionIds = [...ids] },
        installPinned(ids) { this.pinnedSessionIds = [...ids] },
        upsertView: (view) => {
          journal.upserts.push(view)
          this.list.upserts.push(view)
          if (this.list.removedIds.has(view.workspaceId)) return
          const idx = this.list.items.findIndex((item) => item.workspaceId === view.workspaceId)
          if (idx === -1) this.list.items.unshift({ ...view, sessionIds: [...(view.sessionIds || [])] })
          else this.list.items[idx] = { ...view, sessionIds: [...(view.sessionIds || [])] }
        },
        removeView: (id) => {
          this.list.removedIds.add(id)
          this.list.items = this.list.items.filter((item) => item.workspaceId !== id)
        },
      }
    }
  }
}

/** Official SessionsModel stub: `list.byId` is the only session summary source. */
function makeSessionsService(seed) {
  return class SessionsService extends Service {
    constructor(ctx) {
      super(ctx, 'sessions')
      const byId = {}
      for (const summary of seed.sessions) byId[summary.id] = { ...summary }
      this.byId = byId
      this.list = {
        getSnapshot: () => ({
          ids: Object.keys(byId),
          byId,
          currentSessionId: undefined,
        }),
      }
    }
    handleSessionAdded(summary) { this.byId[summary.id] = { ...summary } }
    handleSessionRemoved(id) { delete this.byId[id] }
    handleSessionStatus(id, running) {
      if (this.byId[id]) this.byId[id] = { ...this.byId[id], running }
    }
    handleSessionActivity(id, updatedAt) {
      if (this.byId[id]) this.byId[id] = { ...this.byId[id], updatedAt }
    }
  }
}

/**
 * Boot one plugin instance against the official stubs and let the first
 * reconcile settle.
 */
async function bootClient(payload, seed) {
  globalThis.fetch = async (url) => {
    const urlStr = String(url)
    if (urlStr.includes('/remote-ssh/sessions')) {
      return { ok: true, status: 200, json: async () => payload }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, value: {} }) }
  }

  const journal = { upserts: [] }
  const root = new Context()
  root.plugin(RemoteWorkspaceFilesService)
  root.plugin(RemoteCommandsService)
  root.plugin(RemoteService)
  root.plugin(RemoteSessionService)
  root.plugin(RemoteWorkspaceService)
  root.plugin(makeWorkspacesService(seed, journal))
  root.plugin(makeSessionsService(seed))
  root.plugin(UiSessionService)
  root.plugin(FileUploadService)

  const clientExports = buildClientExports()
  const fork = root.plugin({
    name: registration.id,
    inject: clientExports.inject,
    apply: clientExports.apply,
  })

  if (fork.state === 3 || fork._error) {
    throw (fork._error || new Error('client plugin failed to activate'))
  }

  // Cordis activates plugin forks asynchronously; let the initial reconcile settle.
  await new Promise((resolve) => setTimeout(resolve, 30))

  const wsList = root.get('workspaces').list
  const sessionsService = root.get('sessions')

  /** Latest view the plugin published per workspaceId. */
  const views = new Map()
  for (const view of journal.upserts) views.set(view.workspaceId, view)

  return {
    root,
    fork,
    wsList,
    views,
    journal,
    byId: sessionsService.byId,
    dispose: () => fork.dispose(),
  }
}

// --- Client fixture --------------------------------------------------------
//
// dev:  archived members are inside the /srv/app authoritative member set, plus
//       one archived session that no remote workspace view collects (the
//       container representative) and one blank archived session (must never
//       become a representative).
// preprod: no archived session at all (container must stay empty).
// local: official archived rows, one of which is a subagent (must never become
//        the local container representative).

const DEV_APP_IDS = [ns('dev', 'arch-beta'), ns('dev', 'arch-alpha'), ns('dev', 'live-2'), ns('dev', 'fresh-1')]
const DEV_CONTAINER_REP = ns('dev', 'arch-loose')
const LOCAL_CONTAINER_REP = 'local-arch-1'

const PRIMARY_SNAPSHOT = {
  hosts: ['dev', 'preprod'],
  homes: [
    { host: 'dev', home: '/home/dm' },
    { host: 'preprod', home: '/home/pp' },
  ],
  total: 8,
  archivedSessionIds: [
    ns('dev', 'arch-beta'),
    ns('dev', 'arch-alpha'),
    ns('dev', 'arch-loose'),
    ns('dev', 'arch-blank'),
  ],
  pinnedSessionIds: [],
  workspaces: [
    {
      workspaceId: nsWs('dev', '/srv/app'),
      cwd: '/srv/app',
      name: '[dev] app',
      // C1 output: the authoritative member set, archived members included.
      sessionIds: DEV_APP_IDS,
      // C2 discrimination: the display list carries only the live rows, so a
      // view built from ws.sessions alone cannot satisfy the contract.
      sessions: [
        { sessionId: ns('dev', 'live-2'), title: 'Live 2', running: false, blank: false, cwd: '/srv/app', updatedAt: 40 },
        { sessionId: ns('dev', 'fresh-1'), title: 'Fresh', running: false, blank: false, cwd: '/srv/app', updatedAt: 5 },
      ],
    },
    {
      workspaceId: nsWs('preprod', '/var/www'),
      cwd: '/var/www',
      name: '[preprod] site',
      sessionIds: [ns('preprod', 'live-9')],
      sessions: [
        { sessionId: ns('preprod', 'live-9'), title: 'PP Live', running: false, blank: false, cwd: '/var/www', updatedAt: 7 },
      ],
    },
  ],
  sessions: [
    { sessionId: ns('dev', 'arch-beta'), title: 'Beta', running: false, blank: false, cwd: '/srv/app', updatedAt: 10 },
    { sessionId: ns('dev', 'arch-alpha'), title: 'Alpha', running: false, blank: false, cwd: '/srv/app', updatedAt: 900 },
    { sessionId: ns('dev', 'live-2'), title: 'Live 2', running: false, blank: false, cwd: '/srv/app', updatedAt: 40 },
    { sessionId: ns('dev', 'fresh-1'), title: 'Fresh', running: false, blank: false, cwd: '/srv/app', updatedAt: 5 },
    { sessionId: ns('dev', 'arch-loose'), title: 'Loose archive', running: false, blank: false, cwd: '/srv/scratch', updatedAt: 700 },
    { sessionId: ns('dev', 'arch-blank'), title: 'Blank archive', running: false, blank: true, cwd: '/srv/scratch', updatedAt: 999 },
    { sessionId: ns('preprod', 'live-9'), title: 'PP Live', running: false, blank: false, cwd: '/var/www', updatedAt: 7 },
  ],
}

const PRIMARY_SEED = {
  officialItems: [
    { workspaceId: 'local-ws-1', path: 'D:/work/local-app', title: 'local-app', sessionIds: [LOCAL_CONTAINER_REP], createdAt: '2026-01-01T00:00:00.000Z' },
  ],
  officialArchived: [LOCAL_CONTAINER_REP, 'local-arch-sub'],
  officialPinned: [],
  sessions: [
    { id: LOCAL_CONTAINER_REP, sessionId: LOCAL_CONTAINER_REP, title: 'Local archived', blank: false, cwd: 'D:/work/local-app', updatedAt: 10 },
    // Recency trap: newest local archived row, but a subagent is never visible.
    { id: 'local-arch-sub', sessionId: 'local-arch-sub', title: 'Local archived subagent', blank: false, origin: 'subagent', cwd: 'D:/work/local-app', updatedAt: 999 },
  ],
}

// --- Phase 2 + 3 + 4 (C2 / C3) ----------------------------------------------

console.log('== Phase 2-4 (C2 / C3): client.js workspace views and container views ==')

const primary = await bootClient(PRIMARY_SNAPSHOT, PRIMARY_SEED)

// --- C2: the remote workspace view carries the authoritative member set -----

const devAppView = primary.views.get(nsWs('dev', '/srv/app'))
assert.ok(
  devAppView,
  'C2: reconcileRemoteSource must publish a view for the remote /srv/app workspace',
)
assert.deepEqual(
  devAppView.sessionIds,
  DEV_APP_IDS,
  'C2: the remote workspace view sessionIds must be ws.sessionIds (the authoritative host member ' +
  'set), not the truncated ws.sessions display list',
)
assert.ok(
  devAppView.sessionIds.includes(ns('dev', 'arch-beta')) && devAppView.sessionIds.includes(ns('dev', 'arch-alpha')),
  'C2: archived remote sessions must become members of their workspace view, so they are visible ' +
  'under archivedFilter "show" instead of never appearing in any view',
)

// The official rule confirms the user-visible consequence of C2.
const primaryArchived = new Set(primary.wsList.archivedSessionIds.map(String))
{
  const showGroups = officialGroupByWorkspace(
    { byId: primary.byId, currentSessionId: undefined },
    [devAppView],
    primaryArchived,
    'show',
  )
  assert.equal(
    showGroups[0]?.members.filter((m) => primaryArchived.has(m.id)).length,
    2,
    'C2: under archivedFilter "show" the /srv/app view must render both archived remote sessions',
  )
}

// --- C3: container views ----------------------------------------------------
const devContainer = primary.views.get('remote:dev:hostroot')
assert.ok(devContainer, 'C3: a remote:dev:hostroot container view must be published for host dev')
assert.ok(
  Array.isArray(devContainer.sessionIds),
  'C3: every *:hostroot container view must carry a sessionIds array',
)
assert.equal(
  devContainer.sessionIds.length,
  1,
  'C3: remote:dev:hostroot must hold exactly one representative archived session, otherwise the ' +
  `official model drops the whole group under archivedFilter "only" (found ${JSON.stringify(devContainer.sessionIds)})`,
)
assert.equal(
  devContainer.sessionIds[0],
  DEV_CONTAINER_REP,
  'C3: the remote container representative must prefer an archived session that no sibling remote ' +
  'workspace view collects (no duplicate row), and must never be a blank or subagent session',
)
{
  const rep = devContainer.sessionIds[0]
  const summary = primary.byId[rep]
  assert.ok(summary, `C3: the container representative "${rep}" must exist in list.byId`)
  assert.notEqual(summary.origin, 'subagent', 'C3: the container representative must not be a subagent')
  assert.notEqual(summary.blank, true, 'C3: the container representative must not be a blank session')
  assert.ok(
    primaryArchived.has(rep),
    'C3: the container representative must be an archived session (visible under archivedFilter "only")',
  )

  const siblingIds = [...primary.views.entries()]
    .filter(([id]) => id.startsWith('remote:dev:workspace:'))
    .flatMap(([, view]) => view.sessionIds || [])
  assert.ok(
    !siblingIds.includes(rep),
    `C3: the remote container representative "${rep}" must be absent from every sibling remote ` +
    'workspace view member set, otherwise the session renders as a duplicate row',
  )
}

const ppContainer = primary.views.get('remote:preprod:hostroot')
assert.ok(ppContainer, 'C3: a remote:preprod:hostroot container view must be published for host preprod')
assert.deepEqual(
  ppContainer.sessionIds,
  [],
  'C3: a container whose scope has no archived session must keep sessionIds empty (the official ' +
  '"only" filter then drops that container, which is the correct behaviour)',
)

const localContainer = primary.views.get('local:hostroot')
assert.ok(localContainer, 'C3: a local:hostroot container view must be published when local workspaces exist')
assert.equal(
  localContainer.sessionIds.length,
  1,
  'C3: local:hostroot must hold exactly one representative archived session, otherwise the local ' +
  'container disappears under archivedFilter "only"',
)
assert.equal(
  localContainer.sessionIds[0],
  LOCAL_CONTAINER_REP,
  'C3: the local container representative must be a non-remote id from the official ' +
  'archivedSessionIds, and must never be a subagent session',
)
{
  const rep = localContainer.sessionIds[0]
  const summary = primary.byId[rep]
  assert.ok(summary, `C3: the local container representative "${rep}" must exist in list.byId`)
  assert.ok(
    !String(rep).startsWith('remote:'),
    'C3: the local container representative must not be a remote session',
  )
  assert.ok(
    primaryArchived.has(rep),
    'C3: the local container representative must come from the official archivedSessionIds',
  )
  assert.notEqual(summary.origin, 'subagent', 'C3: the local container representative must not be a subagent')
  assert.notEqual(summary.blank, true, 'C3: the local container representative must not be a blank session')
}

// The plugin owns its own views and must not rewrite official workspace views.
{
  const officialIds = PRIMARY_SEED.officialItems.map((item) => item.workspaceId)
  for (const id of officialIds) {
    assert.ok(
      !primary.journal.upserts.some((view) => view.workspaceId === id),
      `C3: the plugin must not write the official workspace view "${id}"; official items stay ` +
      'untouched and the duplicate-row exception in the contract applies instead',
    )
  }
  const officialItem = primary.wsList.items.find((item) => item.workspaceId === 'local-ws-1')
  assert.deepEqual(
    officialItem?.sessionIds,
    [LOCAL_CONTAINER_REP],
    'C3: official workspace items[] must keep their own sessionIds; only plugin-owned views change',
  )
}

// End-to-end consequence under the official "only" filter.
{
  const onlyGroups = officialGroupByWorkspace(
    { byId: primary.byId, currentSessionId: undefined },
    primary.wsList.items,
    primaryArchived,
    'only',
  )
  const keys = onlyGroups.map((g) => g.key)
  assert.ok(
    keys.includes('remote:dev:hostroot'),
    'C3: the remote host container must survive the official archivedFilter "only" grouping ' +
    '(a dropped empty group is exactly the reported "折叠菜单消失" bug)',
  )
  assert.ok(
    keys.includes('local:hostroot'),
    'C3: the local host container must survive the official archivedFilter "only" grouping',
  )
  assert.ok(
    keys.includes(nsWs('dev', '/srv/app')),
    'C2/C3: the remote workspace group must survive the official archivedFilter "only" grouping',
  )
  assert.ok(
    !keys.includes('remote:preprod:hostroot'),
    'C3: a container with no archived session in scope is correctly dropped by the official "only" filter',
  )

  const devGroup = onlyGroups.find((g) => g.key === 'remote:dev:hostroot')
  assert.equal(
    devGroup?.members?.length,
    1,
    'C3: the surviving remote container row must show exactly one archived session',
  )

  const seen = new Set()
  let duplicates = 0
  for (const group of onlyGroups) {
    for (const member of group.members) {
      if (seen.has(member.id)) duplicates += 1
      seen.add(member.id)
    }
  }
  assert.ok(
    duplicates <= 1,
    'C3: at most the contract exception for official local items may produce 1 duplicate',
  )
  const seenRemote = new Set()
  let remoteDuplicates = 0
  for (const group of onlyGroups) {
    for (const member of group.members) {
      if (member.id.startsWith('remote:')) {
        if (seenRemote.has(member.id)) remoteDuplicates += 1
        seenRemote.add(member.id)
      }
    }
  }
  assert.equal(
    remoteDuplicates,
    0,
    'C3: no remote session may render twice under archivedFilter "only"; the container representative must ' +
    'not duplicate a row already shown by another view',
  )
}

await primary.dispose()
console.log('== Phase 2-4 (C2 / C3): client view assertions passed ==')

// --- Phase 5 (C2 fallback): ws.sessionIds missing ----------------------------

console.log('== Phase 5 (C2 fallback): ws.sessionIds missing falls back to ws.sessions ==')

const FALLBACK_SNAPSHOT = {
  hosts: ['solo'],
  homes: [{ host: 'solo', home: '/home/solo' }],
  total: 2,
  archivedSessionIds: [ns('solo', 'a-archived')],
  pinnedSessionIds: [],
  workspaces: [
    {
      workspaceId: nsWs('solo', '/srv/only'),
      cwd: '/srv/only',
      name: 'only',
      // No sessionIds field at all: the client must degrade to ws.sessions.
      sessions: [
        { sessionId: ns('solo', 'live-1'), title: 'Live', running: false, blank: false, cwd: '/srv/only', updatedAt: 3 },
        { sessionId: ns('solo', 'live-2'), title: 'Live 2', running: false, blank: false, cwd: '/srv/only', updatedAt: 1 },
      ],
    },
  ],
  sessions: [
    { sessionId: ns('solo', 'a-archived'), title: 'Archived', running: false, blank: false, cwd: '/srv/only', updatedAt: 0 },
    { sessionId: ns('solo', 'live-1'), title: 'Live', running: false, blank: false, cwd: '/srv/only', updatedAt: 3 },
    { sessionId: ns('solo', 'live-2'), title: 'Live 2', running: false, blank: false, cwd: '/srv/only', updatedAt: 1 },
  ],
}

const fallback = await bootClient(FALLBACK_SNAPSHOT, {
  officialItems: [{ workspaceId: 'local-ws-1', path: 'D:/work/local-app', title: 'local-app', sessionIds: [] }],
  officialArchived: [],
  officialPinned: [],
  sessions: [],
})

const fallbackView = fallback.views.get(nsWs('solo', '/srv/only'))
assert.ok(
  fallbackView,
  'C2: reconcileRemoteSource must publish a view for the remote workspace in the fallback payload',
)
assert.deepEqual(
  fallbackView.sessionIds,
  [ns('solo', 'live-1'), ns('solo', 'live-2')],
  'C2: when ws.sessionIds is missing the view sessionIds must fall back to ' +
  'ws.sessions.map(s => String(s.sessionId))',
)

await fallback.dispose()
console.log('== Phase 5 (C2 fallback): fallback assertions passed ==')

console.log('all smoke-workspace-archived-views assertions passed cleanly!')
