/**
 * Host-entry contract smoke: the module exposes what the Loader reads, and
 * `apply` registers `/remote-ssh` against a stub context.
 *
 * The stub `effect` records its callback instead of running it, so no SSH
 * tunnel is spawned — this stays a fast, offline contract check. The live path
 * is covered by `smoke-command-live.mjs`.
 */

import { apply, inject } from './lib/index.js'

const registered = []
const effects = []
const ctx = {
  commands: {
    register: (definition) => { registered.push(definition); return () => {} },
  },
  effect: (callback) => { effects.push(callback); return () => {} },
  logger: { info: () => {}, warn: () => {} },
}

console.log(`inject: ${JSON.stringify(inject)}`)
console.log(`apply: ${typeof apply}`)

apply(ctx, { host: 'dev', remotePort: 3080, localPort: 39398 })

console.log(`effects registered: ${effects.length}`)

// The command registration lives inside an effect callback; run only that one
// so this check never spawns the tunnel (the second effect).
for (const effect of effects) {
  const before = registered.length
  effect()
  if (registered.length > before) break
}

const command = registered[0]
console.log(`command registered: /${command?.name} handler=${typeof command?.handler}`)

const value = await command.handler({ rawInput: '', signal: AbortSignal.timeout(5000) })
console.log(`no-tunnel result: kind=${value.kind} text=${value.text}`)
