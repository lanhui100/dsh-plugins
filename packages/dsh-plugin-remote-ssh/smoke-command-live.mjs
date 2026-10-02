/** Command check: /remote-ssh handler lists real remote sessions through a fresh tunnel. */

import { Context } from '@deepseek-ai/cordis'
import { SshTunnel, RemoteCaller, registerRemoteSshCommand } from './lib/index.js'

const host = process.env.REMOTE_SSH_HOST ?? 'dev'
const remotePort = Number(process.env.REMOTE_SSH_REMOTE_PORT ?? '3080')
const localPort = Number(process.env.REMOTE_SSH_LOCAL_PORT ?? '39393')

const tunnel = new SshTunnel({ host, remotePort, localPort })
const registrations = []
const ctx = new Context()
ctx.commands = { register: (definition) => { registrations.push(definition); return () => {} } }
let activeCaller
registerRemoteSshCommand(ctx, () => {
  activeCaller = new RemoteCaller({ host, baseUrl: tunnel.baseUrl() })
  return activeCaller
})
try {
  await tunnel.start()
  const handler = registrations[0].handler
  const value = await handler({ rawInput: '', signal: AbortSignal.timeout(120000) })
  console.log(`kind=${value.kind}`)
  console.log(String(value.text).split('\n').slice(0, 6).join('\n'))
} finally {
  activeCaller?.dispose()
  await tunnel.dispose()
}
