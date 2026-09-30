/** Client-bundle smoke: the shipped client.js registers and applies in the DSH loader contract. */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'client.js'), 'utf8')

let registration
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
}
globalThis.window = {
  __ModuleLoader__: {
    load: (value) => { registration = value },
  },
}

// A browser evaluates the script purely to register the factory.
new Function(source)()

const clientExports = registration.factory((specifier) => {
  if (specifier === 'react') return fakeReact
  throw new Error(`unexpected external request: ${specifier}`)
})

console.log(`registration id: ${registration.id}`)
console.log(`exports.apply: ${typeof clientExports.apply}`)
console.log(`exports.inject: ${JSON.stringify(clientExports.inject)}`)

const injected = []
const registered = []
const ctx = {
  slots: {
    inject: (name, callback) => { injected.push(name); callback() },
    register: (declaration, component) => { registered.push({ declaration, component }); return () => {} },
  },
}
clientExports.apply(ctx)

const entry = registered[0]
console.log(`injected slot: ${injected.join(',')}`)
console.log(`registered: id=${entry?.declaration?.id} name=${entry?.declaration?.name} order=${entry?.declaration?.order}`)
console.log(`render wide: type=${entry.component({ wide: true }).type} children=${entry.component({ wide: true }).children.length}`)
console.log(`render rail: children=${entry.component({ wide: false }).children.length}`)
