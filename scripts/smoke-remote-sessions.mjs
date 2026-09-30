/** Smoke: open a fresh tunnel and list remote sessions (acceptance criterion). */

import { SshTunnel } from '../packages/dsh-plugin-remote-ssh/lib/tunnel.js'
import { RemoteCaller } from '../packages/dsh-plugin-remote-ssh/lib/remote.js'
import { listRemoteSessions } from '../packages/dsh-plugin-remote-ssh/lib/sessions.js'

const host = process.env.REMOTE_SSH_HOST ?? 'dev'
const remotePort = Number(process.env.REMOTE_SSH_REMOTE_PORT ?? '3080')
const localPort = Number(process.env.REMOTE_SSH_LOCAL_PORT ?? '39390')

const tunnel = new SshTunnel({ host, remotePort, localPort })
try {
  await tunnel.start()
  console.log(`tunnel ready: ${tunnel.baseUrl()}`)
  const caller = new RemoteCaller({ host, baseUrl: tunnel.baseUrl() })
  const items = await listRemoteSessions(caller)
  console.log(`remote sessions: ${String(items.length)}`)
  for (const item of items.slice(0, 10)) {
    console.log(`- ${item.sessionId} cwd=${item.cwd} running=${String(item.running)} title=${item.title ?? '(untitled)'}`)
  }
} finally {
  await tunnel.dispose()
}
