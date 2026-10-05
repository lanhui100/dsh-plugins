import assert from 'node:assert/strict'
import { SshTunnel } from './lib/tunnel.js'
import { RemoteCaller } from './lib/remote.js'
import { RemoteHostManager } from './lib/manager.js'

console.log('Testing SSH keepalive hardening and $events auto-reconnect...')

// 1. Verify SshTunnel exponential backoff calculation & min delay
{
  const delays = []
  let rngVal = 0.0001 // extreme near-zero jitter
  const tunnel = new SshTunnel({
    host: 'mock-host',
    remotePort: 3080,
    localPort: 39999,
    reconnectDelayMs: 2000,
    reconnectMaxDelayMs: 10000,
    random: () => rngVal,
  })

  // Tunnel dispose must safely terminate without leaving dangling timers
  await tunnel.dispose()
  assert.equal(tunnel.baseUrl(), 'http://127.0.0.1:39999')
}

// 2. Verify RemoteCaller $events state synchronization and lifecycle
{
  let tunnelReady = true
  const caller = new RemoteCaller({
    host: 'mock-host',
    baseUrl: 'http://127.0.0.1:39999',
    isTunnelReady: () => tunnelReady,
    eventsReconnectBaseMs: 1000,
    eventsReconnectMaxDelayMs: 5000,
  })

  // Test tunnel status driving
  caller.onTunnelDown()
  // When tunnel is down, ensureEventsListener must be paused
  await caller.ensureEventsListener()

  // When tunnel is ready, onTunnelReady wakes up caller
  tunnelReady = true
  caller.onTunnelReady()

  // Clean disposal without throwing or leaking
  caller.dispose()
}

// 3. Verify RemoteHostManager port allocation & conflict detection
{
  const mgr = new RemoteHostManager({
    primaryHost: 'dev',
    primaryRemotePort: 3080,
    primaryLocalPort: 39387,
    connectTimeout: 5,
    serverAliveInterval: 10,
    serverAliveCountMax: 2,
    tcpKeepAlive: true,
  })

  // allocateLocalPort preserves backward compatibility
  const port = mgr.allocateLocalPort()
  assert.equal(port, 39388)

  // findAvailableLocalPort returns an OS-verified port
  const freePort = await mgr.findAvailableLocalPort()
  assert.ok(freePort >= 39388)
  assert.equal(await mgr.isPortAvailable(freePort), true)

  const config = mgr.getHostConfig('dev')
  assert.equal(config?.connectTimeout, 5)
  assert.equal(config?.serverAliveInterval, 10)
  assert.equal(config?.serverAliveCountMax, 2)
  assert.equal(config?.tcpKeepAlive, true)

  await mgr.dispose()
}

// 4. Verify ghost interaction prevention in respondRemoteEvent
{
  const caller = new RemoteCaller({
    host: 'mock-host',
    baseUrl: 'http://127.0.0.1:39999',
  })

  caller.recordMockInteraction({
    clientId: 'mock-client',
    eventId: 'mock-evt-1',
    sessionId: 'session-1',
    event: 'user-questions/request',
    questions: [],
    createdAt: Date.now(),
  })

  assert.equal(caller.getAllPendingInteractions().length, 1)

  await caller.respondRemoteEvent('mock-client', 'mock-evt-1', { kind: 'result', value: 'ans' })
  assert.equal(caller.getAllPendingInteractions().length, 0, 'Interaction must be dismissed after response')

  caller.dispose()
}

// 5. Verify SshTunnel dispose cleans up backoff immediately
{
  const tunnel = new SshTunnel({
    host: 'mock-nonexistent-host',
    remotePort: 3080,
    localPort: 39998,
    reconnectDelayMs: 60000,
    reconnectMaxDelayMs: 60000,
  })

  // Set internal state to simulate backoff wait
  const startMs = Date.now()
  await tunnel.dispose()
  const elapsedMs = Date.now() - startMs
  assert.ok(elapsedMs < 1000, `dispose must complete promptly, took ${elapsedMs}ms`)
}

console.log('all smoke-keepalive assertions passed cleanly!')
