import assert from 'node:assert/strict'
import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RemoteHostManager } from './lib/manager.js'

console.log('Testing RemoteHostManager...')

const tempStorePath = join(tmpdir(), `dsh-remote-hosts-test-${Date.now()}.json`)

try {
  // 1. Initialize manager with primary host "dev"
  const mgr = new RemoteHostManager({
    primaryHost: 'dev',
    primaryRemotePort: 3080,
    primaryLocalPort: 39387,
    storagePath: tempStorePath,
  })

  assert.deepEqual(mgr.getHostNames(), ['dev'], 'Initially only primary host dev should exist')

  // 2. Test session ID resolution
  const res1 = mgr.resolveSessionTarget('remote:dev:session-abc-123')
  assert.ok(res1, 'Must resolve namespaced session id')
  assert.equal(res1.host, 'dev')
  assert.equal(res1.originalSessionId, 'session-abc-123')

  // Legacy fallback when only 1 host exists
  const resLegacy = mgr.resolveSessionTarget('session-legacy-456')
  assert.ok(resLegacy, 'Must resolve un-namespaced session id with single host')
  assert.equal(resLegacy.host, 'dev')
  assert.equal(resLegacy.originalSessionId, 'session-legacy-456')

  // 3. Test next port allocation
  const nextPort1 = mgr.allocateLocalPort()
  assert.equal(nextPort1, 39388, 'Next port should be 39388')

  // 4. Test registering a new host without starting tunnel (mock mode)
  mgr.registerConfiguredHost({
    host: 'preprod',
    remotePort: 3080,
    localPort: nextPort1,
  })

  assert.deepEqual(mgr.getHostNames().sort(), ['dev', 'preprod'].sort())
  assert.equal(existsSync(tempStorePath), true, 'Store file must be created on host registration')

  // Now resolve session target for preprod
  const res2 = mgr.resolveSessionTarget('remote:preprod:session-xyz-789')
  assert.ok(res2)
  assert.equal(res2.host, 'preprod')
  assert.equal(res2.originalSessionId, 'session-xyz-789')

  // 5. Test reloading manager from persistent storage
  const mgr2 = new RemoteHostManager({
    primaryHost: 'dev',
    primaryRemotePort: 3080,
    primaryLocalPort: 39387,
    storagePath: tempStorePath,
  })

  assert.deepEqual(mgr2.getHostNames().sort(), ['dev', 'preprod'].sort(), 'Restored manager must contain preprod from disk')

  // 6. Manager must start empty when no primary host is configured (dynamic-only
  //    host addition through POST /remote-ssh/add-host). Fresh storage so the
  //    persisted dev/preprod entries above do not leak in.
  const emptyStorePath = join(tmpdir(), `dsh-remote-hosts-empty-${Date.now()}.json`)
  const mgrEmpty = new RemoteHostManager({
    primaryRemotePort: 3080,
    primaryLocalPort: 39387,
    storagePath: emptyStorePath,
  })
  assert.deepEqual(mgrEmpty.getHostNames(), [], 'Manager must start with no hosts when primaryHost is omitted')

  // 7. A blank/whitespace primaryHost must be treated the same as omitted.
  const mgrBlank = new RemoteHostManager({
    primaryHost: '   ',
    primaryRemotePort: 3080,
    primaryLocalPort: 39387,
    storagePath: emptyStorePath,
  })
  assert.deepEqual(mgrBlank.getHostNames(), [], 'Blank primaryHost must not register a host')

  // 8. Dynamic-only startup (no primaryHost) restores previously persisted
  //    hosts from disk — the real restart path for hosts added via the UI.
  const restoreStorePath = join(tmpdir(), `dsh-remote-hosts-restore-${Date.now()}.json`)
  writeFileSync(restoreStorePath, JSON.stringify({ hosts: [{ host: 'persisted-host', remotePort: 3080, localPort: 39389 }] }), 'utf8')
  const mgrRestore = new RemoteHostManager({
    primaryRemotePort: 3080,
    primaryLocalPort: 39387,
    storagePath: restoreStorePath,
  })
  assert.deepEqual(
    mgrRestore.getHostNames(),
    ['persisted-host'],
    'Dynamic-only manager must restore previously persisted hosts from disk',
  )

  try {
    if (existsSync(restoreStorePath)) unlinkSync(restoreStorePath)
  } catch {}

  console.log('all smoke-manager assertions passed cleanly!')
} finally {
  try {
    if (existsSync(tempStorePath)) unlinkSync(tempStorePath)
  } catch {}
}
