/**
 * Host-entry contract smoke: the module exposes what the Loader reads, and
 * `apply` registers `/remote-ssh` plus the panel route against a stub context.
 *
 * The stub `effect` records its callback instead of running it, so no SSH
 * tunnel is spawned — this stays a fast, offline contract check. The live paths
 * are covered by `smoke-command-live.mjs` and `smoke-route.mjs`.
 */

import { apply, inject } from './lib/index.js'

const commands = []
const routes = []
const effects = []
const injected = []
const ctx = {
  commands: {
    register: (definition) => { commands.push(definition); return () => {} },
  },
  inject: (deps, callback) => {
    injected.push(deps.join(','))
    callback({
      webServer: { register: (route) => { routes.push(route); return () => {} } },
      effect: (fn) => { fn(); return () => {} },
    })
  },
  effect: (callback) => { effects.push(callback); return () => {} },
  logger: { info: () => {}, warn: () => {} },
}

console.log(`inject: ${JSON.stringify(inject)}`)
console.log(`apply: ${typeof apply}`)

apply(ctx, { host: 'dev', remotePort: 3080, localPort: 39398 })

console.log(`optional injects requested: ${injected.join(' | ')}`)
console.log(`effect callbacks registered: ${effects.length}`)
console.log(`routes registered: ${routes.map((route) => `${route.kind} ${route.path}`).join(', ') || '(none)'}`)

// Command registration is deferred into an effect callback; run only that one
// so this check never spawns the tunnel (the other effect owns the tunnel).
for (const effect of effects) {
  const before = commands.length
  effect()
  if (commands.length > before) break
}

const command = commands[0]
console.log(`command registered: /${command?.name} handler=${typeof command?.handler}`)

const value = await command.handler({ rawInput: '', signal: AbortSignal.timeout(5000) })
console.log(`no-tunnel result: kind=${value.kind} text=${value.text}`)
