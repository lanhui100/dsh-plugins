/** Command check: /remote-ssh handler degrades gracefully without a tunnel. */

import { Context } from '@deepseek-ai/cordis'
import { registerRemoteSshCommand } from './lib/index.js'

const registrations = []
const ctx = new Context()
ctx.commands = { register: (definition) => { registrations.push(definition); return () => {} } }
registerRemoteSshCommand(ctx, () => undefined)
const handler = registrations[0].handler
const value = await handler({ rawInput: '', signal: AbortSignal.timeout(5000) })
console.log(`command registered: /${registrations[0].name}, no-tunnel -> kind=${value.kind} text=${value.text}`)
