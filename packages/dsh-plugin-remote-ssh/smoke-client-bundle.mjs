/**
 * Client-bundle contract smoke: the shipped client.js registers, applies, and
 * renders in the DSH loader contract — without a browser.
 *
 * The stub React implements just enough of the hooks surface to call the
 * components once; effects never run, so no network is touched.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'client.js'), 'utf8')

let registration
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
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

const registered = []
const ctx = {
  slots: {
    inject: (name, callback) => {
      if (name !== 'main' && name !== 'sidebar.panellist') throw new Error(`unexpected slot: ${name}`)
      callback()
    },
    register: (declaration, component) => { registered.push({ declaration, component }); return () => {} },
  },
}
clientExports.apply(ctx)

for (const entry of registered) {
  const { declaration } = entry
  console.log(`slot ${declaration.name}: key/id=${declaration.key ?? declaration.id} order=${declaration.order ?? '-'} label=${declaration.label ?? '-'}`)
}

const panelIcon = registered.find((entry) => entry.declaration.name === 'sidebar.panellist')
const panelPage = registered.find((entry) => entry.declaration.name === 'main')

const icon = panelIcon.component({ size: 18, active: true })
console.log(`icon renders: type=${icon.type} width=${icon.props.width} children=${icon.children.length}`)

const page = panelPage.component({})
console.log(`panel renders: type=${page.type} children=${page.children.length}`)
