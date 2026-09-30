/** Host-apply smoke: apply() works in a minimal Cordis context (commands/effect only). */

import { Context } from '@deepseek-ai/cordis'
import { apply } from './lib/index.js'

const registrations = []
const ctx = new Context()
// Provide a minimal commands service matching the structural shape the plugin uses.
ctx.provide?.('commands', {
  register: (definition) => { registrations.push(definition); return () => {} },
})
apply(ctx, { host: 'dev', remotePort: 3080, localPort: 39398 })
const command = registrations[0]
console.log(`command registered: /${command?.name} (handler=${typeof command?.handler})`)
const value = await command.handler({ rawInput: '', signal: AbortSignal.timeout(5000) })
console.log(`no-tunnel result: kind=${value.kind} text=${value.text}`)
