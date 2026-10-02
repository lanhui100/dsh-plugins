/**
 * End-to-end smoke test for multi-host remote SSH management, discovery of
 * unadded key-configured hosts from ~/.ssh/config, and /remote-ssh add command.
 */

import assert from 'node:assert/strict'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from './lib/index.js'
import { RemoteHostManager } from './lib/manager.js'
import { registerRemoteSshCommand } from './lib/command.js'
import {
  registerRemoteSshRoute,
  AVAILABLE_HOSTS_ROUTE,
  ADD_HOST_ROUTE,
  SESSIONS_ROUTE,
  SESSION_RAW_ROUTE,
  SESSION_ARCHIVE_ROUTE,
  SESSION_UNARCHIVE_ROUTE,
  SESSION_PIN_ROUTE,
  SESSION_UNPIN_ROUTE,
} from './lib/route.js'

console.log('Testing multi-host discovery, command and routes...')

const tempSshConfig = join(tmpdir(), `ssh-multi-test-${Date.now()}.conf`)
const tempStorage = join(tmpdir(), `hosts-storage-${Date.now()}.json`)

const mockSshConfig = `
Host dev
  HostName devserver.internal.net
  Port 2022
  User dm
  IdentityFile ~/.ssh/id_rsa

Host preprod
  HostName 100.97.143.121
  Port 4022
  User dm
  IdentityFile ~/.ssh/id_rsa

Host password-only
  HostName 1.2.3.4
  Port 22
  User admin
`

writeFileSync(tempSshConfig, mockSshConfig, 'utf8')

try {
  // 1. Setup mock cordis context
  const commands = []
  const routes = new Map()

  const fakeCtx = {
    commands: {
      register: (def) => {
        commands.push(def)
        return () => {}
      },
    },
    inject: (deps, cb) => {
      cb({
        webServer: {
          register: (r) => {
            routes.set(r.path, r.handler)
            return () => {}
          },
        },
        effect: (fn) => { fn(); return () => {} },
      })
    },
    effect: (fn) => { fn(); return () => {} },
    logger: { info: () => {}, warn: () => {} },
  }

  const manager = new RemoteHostManager({
    primaryHost: 'dev',
    primaryRemotePort: 3080,
    primaryLocalPort: 39387,
    storagePath: tempStorage,
  })

  // Register command and routes with custom sshConfigPath
  registerRemoteSshCommand(fakeCtx, manager, tempSshConfig)
  registerRemoteSshRoute(fakeCtx, manager, 'dev', tempSshConfig)

  const cmd = commands.find((c) => c.name === 'remote-ssh')
  assert.ok(cmd, 'Command /remote-ssh must be registered')

  // 2. Test command redirects user to settings page for host addition
  const redirectedRes = await cmd.handler({
    rawInput: 'add',
    signal: AbortSignal.timeout(5000),
  })
  assert.equal(redirectedRes.kind, 'error')
  assert.ok(redirectedRes.text.includes('添加远程主机已移至客户端『设置』面板'))

  // 4. Test HTTP route: GET /remote-ssh/available-hosts
  const availHandler = routes.get(AVAILABLE_HOSTS_ROUTE)
  assert.ok(availHandler, `${AVAILABLE_HOSTS_ROUTE} must be registered`)

  let availJson = null
  await availHandler({}, {
    writeHead: () => {},
    end: (body) => { availJson = JSON.parse(body) },
  })

  assert.ok(availJson)
  assert.deepEqual(availJson.currentHosts, ['dev'])
  assert.equal(availJson.availableHosts.length, 1)
  assert.equal(availJson.availableHosts[0].host, 'preprod')
  assert.equal(availJson.availableHosts[0].port, 4022)

  // 5. Mock callers for dev and preprod
  const mockDevCaller = {
    invoke: async (method) => {
      if (method === 'session/list') {
        return { items: [{ sessionId: 'sess-dev-1', cwd: '/home/dm/dev-repo', title: 'Dev Session', running: true, updatedAt: 1000 }] }
      }
      if (method === 'session/projections') {
        return { asOfSeq: 1, values: {} }
      }
      if (method === 'session/page') {
        return { records: [{ type: 'user/message', text: 'hello from dev' }], hasMore: false }
      }
      return {}
    },
    fetchWorkspaceBaseline: async () => ({
      items: [{ workspaceId: 'ws-1', path: '/home/dm/dev-repo', title: 'dev-repo', sessionIds: ['sess-dev-1'] }],
      archivedSessionIds: ['archived-dev-1'],
      pinnedSessionIds: ['pinned-dev-1'],
    }),
    getPendingInteractionsForSession: () => [],
    ensureEventsListener: async () => {},
    dispose: () => {},
  }

  const preprodMutationCalls = {
    archive: [],
    unarchive: [],
    pin: [],
    unpin: [],
  }

  const mockPreprodCaller = {
    archiveRemoteSession: async (sessionId) => {
      preprodMutationCalls.archive.push(sessionId)
      return { archivedSessionIds: ['sess-prod-1'] }
    },
    unarchiveRemoteSession: async (sessionId) => {
      preprodMutationCalls.unarchive.push(sessionId)
      return { archivedSessionIds: [] }
    },
    pinRemoteSession: async (sessionId) => {
      preprodMutationCalls.pin.push(sessionId)
      return { pinnedSessionIds: ['sess-prod-1'] }
    },
    unpinRemoteSession: async (sessionId) => {
      preprodMutationCalls.unpin.push(sessionId)
      return { pinnedSessionIds: [] }
    },
    invoke: async (method) => {
      if (method === 'session/list') {
        return { items: [{ sessionId: 'sess-prod-1', cwd: '/var/www/site', title: 'Prod Session', running: false, updatedAt: 2000 }] }
      }
      if (method === 'session/projections') {
        return { asOfSeq: 2, values: {} }
      }
      if (method === 'session/page') {
        return { records: [{ type: 'user/message', text: 'hello from preprod' }], hasMore: false }
      }
      return {}
    },
    fetchWorkspaceBaseline: async () => ({
      items: [{ workspaceId: 'ws-2', path: '/var/www/site', title: 'site', sessionIds: ['sess-prod-1'] }],
      archivedSessionIds: [],
      pinnedSessionIds: [],
    }),
    getPendingInteractionsForSession: () => [],
    ensureEventsListener: async () => {},
    dispose: () => {},
  }

  // Inject ready entries into manager
  const devEntry = manager.getAllEntries().find((e) => e.config.host === 'dev')
  devEntry.isReady = true
  devEntry.caller = mockDevCaller

  manager.registerConfiguredHost({ host: 'preprod', remotePort: 3080, localPort: 39388 })
  const preprodEntry = manager.getAllEntries().find((e) => e.config.host === 'preprod')
  preprodEntry.isReady = true
  preprodEntry.caller = mockPreprodCaller

  // 6. Test GET /remote-ssh/sessions aggregating both dev and preprod
  const sessionsHandler = routes.get(SESSIONS_ROUTE)
  let sessionsJson = null
  await sessionsHandler({}, {
    writeHead: () => {},
    end: (body) => { sessionsJson = JSON.parse(body) },
  })

  assert.ok(sessionsJson)
  assert.deepEqual(sessionsJson.hosts, ['dev', 'preprod'])
  assert.equal(sessionsJson.total, 2)
  console.log('Aggregated workspaces:', sessionsJson.workspaces.map((w) => w.name))
  assert.ok(sessionsJson.workspaces.some((w) => w.name.includes('[dev]')))
  assert.ok(sessionsJson.workspaces.some((w) => w.name.includes('[preprod]')))

  // Verify sessions have namespaced sessionId
  const devSess = sessionsJson.sessions.find((s) => s.title === 'Dev Session')
  assert.ok(devSess)
  assert.equal(devSess.sessionId, 'remote:dev:sess-dev-1')

  const prodSess = sessionsJson.sessions.find((s) => s.title === 'Prod Session')
  assert.ok(prodSess)
  assert.equal(prodSess.sessionId, 'remote:preprod:sess-prod-1')

  // Non-empty baseline archived/pinned ids must be namespaced per host in the aggregate.
  assert.ok(
    sessionsJson.archivedSessionIds.includes('remote:dev:archived-dev-1'),
    'Dev baseline archived id must be namespaced in the aggregate snapshot',
  )
  assert.ok(
    sessionsJson.pinnedSessionIds.includes('remote:dev:pinned-dev-1'),
    'Dev baseline pinned id must be namespaced in the aggregate snapshot',
  )
  assert.ok(
    !sessionsJson.archivedSessionIds.includes('archived-dev-1') &&
      !sessionsJson.pinnedSessionIds.includes('pinned-dev-1'),
    'Raw baseline ids must never leak into the aggregate snapshot',
  )

  // 7. Test SESSION_RAW_ROUTE routing to preprod caller by namespaced id
  const rawHandler = routes.get(SESSION_RAW_ROUTE)
  let rawJson = null
  await rawHandler({ url: '/remote-ssh/session-raw?id=' + encodeURIComponent('remote:preprod:sess-prod-1') }, {
    writeHead: () => {},
    end: (body) => { rawJson = JSON.parse(body) },
  })

  assert.ok(rawJson)
  assert.equal(rawJson.sessionId, 'remote:preprod:sess-prod-1')
  assert.equal(rawJson.asOfSeq, 2)
  assert.equal(rawJson.records[0]?.text, 'hello from preprod')

  async function invokeMutation(routePath, sessionId) {
    const handler = routes.get(routePath)
    assert.ok(handler, `${routePath} must be registered`)
    let json
    await handler({
      on(event, callback) {
        if (event === 'data') callback(Buffer.from(JSON.stringify({ sessionId })))
        if (event === 'end') callback()
      },
    }, {
      writeHead: () => {},
      end: (body) => { json = JSON.parse(body) },
    })
    assert.equal(json?.ok, true, `${routePath} must succeed`)
    return json.value
  }

  const namespacedProdId = 'remote:preprod:sess-prod-1'
  const archivedProd = await invokeMutation(SESSION_ARCHIVE_ROUTE, namespacedProdId)
  assert.deepEqual(archivedProd.archivedSessionIds, [namespacedProdId])
  assert.deepEqual(preprodMutationCalls.archive, ['sess-prod-1'])

  const unarchivedProd = await invokeMutation(SESSION_UNARCHIVE_ROUTE, namespacedProdId)
  assert.deepEqual(unarchivedProd.archivedSessionIds, [])
  assert.deepEqual(preprodMutationCalls.unarchive, ['sess-prod-1'])

  const pinnedProd = await invokeMutation(SESSION_PIN_ROUTE, namespacedProdId)
  assert.deepEqual(pinnedProd.pinnedSessionIds, [namespacedProdId])
  assert.deepEqual(preprodMutationCalls.pin, ['sess-prod-1'])

  const unpinnedProd = await invokeMutation(SESSION_UNPIN_ROUTE, namespacedProdId)
  assert.deepEqual(unpinnedProd.pinnedSessionIds, [])
  assert.deepEqual(preprodMutationCalls.unpin, ['sess-prod-1'])

  console.log('multi-host archive/pin mutation identity assertions passed')


} finally {
  try {
    unlinkSync(tempSshConfig)
    unlinkSync(tempStorage)
  } catch {}
}
