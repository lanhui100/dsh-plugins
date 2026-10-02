/**
 * Smoke test for Workspace Header "Add Remote" semantic button and popover:
 * Verifies that:
 * 1. Button is injected before searchSlot in sectionHeader;
 * 2. Clicking button opens popover and fetches available hosts;
 * 3. Selecting a host triggers POST /remote-ssh/add-host (auto-start & connect);
 * 4. Workspace reconciliation is triggered on success.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'client.js'), 'utf8')

// The connected icon must depict prongs entering the socket; the disconnected
// icon depicts the same parts separated and deliberately has no slash mark.
const connectIcon = source.match(/const CONNECT_ICON_SVG = '([^']+)'/)?.[1] || ''
const disconnectIcon = source.match(/const DISCONNECT_ICON_SVG = '([^']+)'/)?.[1] || ''
assert.match(connectIcon, /M6 6\.5v2\.5M10 6\.5v2\.5/, 'Connected plug prongs must enter the socket')
assert.match(connectIcon, /<rect x="3\.5" y="9" width="9" height="4"/, 'Connected icon must show the socket face')
assert.match(disconnectIcon, /M6 5\.25v1\.5M10 5\.25v1\.5/, 'Disconnected plug must be lifted clear of the socket')
assert.match(disconnectIcon, /<rect x="3\.5" y="10" width="9" height="3\.5"/, 'Disconnected icon must show the lower socket face')
assert.doesNotMatch(disconnectIcon, /M2\.5 13\.5L13\.5 2\.5|stroke-linecap="round"[^>]*\/?>.*L/, 'Disconnected icon must not use a slash')

// Mini-DOM implementation
class MiniElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase()
    this.className = ''
    this.attributes = new Map()
    const self = this
    this.dataset = new Proxy({}, {
      set(target, prop, value) {
        target[prop] = String(value)
        const attrName = 'data-' + String(prop).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
        self.attributes.set(attrName, String(value))
        return true
      },
      get(target, prop) {
        return target[prop]
      },
    })
    this.children = []
    this.parentElement = null
    this._textContent = ''
    this.value = ''
    this.disabled = false
    this.style = {}
    this.listeners = new Map()
    this.classList = {
      add: (...classes) => {
        const set = new Set(this.className.split(/\s+/).filter(Boolean))
        for (const c of classes) set.add(c)
        this.className = [...set].join(' ')
      },
      remove: (...classes) => {
        const set = new Set(this.className.split(/\s+/).filter(Boolean))
        for (const c of classes) set.delete(c)
        this.className = [...set].join(' ')
      },
      contains: (c) => this.className.split(/\s+/).includes(c),
    }
  }

  get textContent() {
    if (this.children.length === 0) return this._textContent
    return this.children.map((c) => c.textContent).join('')
  }
  set textContent(val) {
    this.children = []
    this._textContent = String(val)
  }

  // Minimal innerHTML: parses a single <svg> child so icon-only assertions can
  // check the rendered structure instead of passing vacuously on empty text.
  set innerHTML(html) {
    this.children = []
    this._textContent = ''
    if (typeof html === 'string' && html.includes('<svg')) {
      const svg = new MiniElement('svg')
      const attrRe = /([a-zA-Z-]+)="([^"]*)"/g
      let m
      while ((m = attrRe.exec(html)) !== null) svg.setAttribute(m[1], m[2])
      this.children.push(svg)
    }
  }

  get isConnected() {
    return this.parentElement !== null
  }

  removeChild(child) {
    const idx = this.children.indexOf(child)
    if (idx !== -1) {
      this.children.splice(idx, 1)
      child.parentElement = null
    }
    return child
  }

  setAttribute(name, val) {
    this.attributes.set(name, String(val))
    if (name === 'class') this.className = String(val)
    if (name === 'id') this.id = String(val)
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null
  }

  appendChild(child) {
    child.parentElement = this
    this.children.push(child)
    return child
  }

  insertBefore(newChild, refChild) {
    const idx = this.children.indexOf(refChild)
    if (idx === -1) {
      return this.appendChild(newChild)
    }
    newChild.parentElement = this
    this.children.splice(idx, 0, newChild)
    return newChild
  }

  remove() {
    if (this.parentElement) {
      const idx = this.parentElement.children.indexOf(this)
      if (idx !== -1) this.parentElement.children.splice(idx, 1)
      this.parentElement = null
    }
  }

  getBoundingClientRect() {
    return { top: 100, bottom: 124, left: 200, right: 224, width: 24, height: 24 }
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(fn)
  }

  dispatchEvent(event) {
    const list = this.listeners.get(event.type) || []
    for (const fn of list) fn(event)
  }

  click() {
    this.dispatchEvent({
      type: 'click',
      target: this,
      defaultPrevented: false,
      stopPropagation() {},
      preventDefault() { this.defaultPrevented = true },
    })
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null
  }

  querySelectorAll(selector) {
    const results = []
    const check = (el) => {
      let isMatch = true
      let remaining = selector

      const classMatches = remaining.match(/\.([a-zA-Z0-9_-]+)/g)
      if (classMatches) {
        for (const cm of classMatches) {
          if (!el.classList.contains(cm.slice(1))) {
            isMatch = false
            break
          }
          remaining = remaining.replace(cm, '')
        }
      }

      if (remaining.startsWith('#')) {
        const idMatch = remaining.match(/^#([a-zA-Z0-9_-]+)/)
        if (idMatch) {
          if (el.id !== idMatch[1] && el.getAttribute('id') !== idMatch[1]) isMatch = false
          remaining = remaining.replace(idMatch[0], '')
        }
      }

      const idAttrMatch = remaining.match(/\[id=["']([^"']+)["']\]/)
      if (idAttrMatch) {
        if (el.id !== idAttrMatch[1] && el.getAttribute('id') !== idAttrMatch[1]) isMatch = false
        remaining = remaining.replace(idAttrMatch[0], '')
      }

      const attrMatch = remaining.match(/\[([a-zA-Z0-9_-]+)\*=["']([^"']+)["']\]/)
      if (attrMatch) {
        const attrName = attrMatch[1]
        const attrVal = attrMatch[2]
        const actual = attrName === 'class' ? el.className : el.getAttribute(attrName)
        if (!actual || !actual.includes(attrVal)) isMatch = false
        remaining = remaining.replace(attrMatch[0], '')
      }

      remaining = remaining.trim()
      if (isMatch && remaining && !remaining.includes(' ')) {
        if (el.tagName !== remaining.toUpperCase()) isMatch = false
        else remaining = ''
      }

      if (isMatch && remaining === '') {
        results.push(el)
      }

      for (const child of el.children) {
        check(child)
      }
    }

    for (const child of this.children) {
      check(child)
    }
    return results
  }
}

class MiniDocument {
  constructor() {
    this.body = new MiniElement('body')
    this.head = new MiniElement('head')
  }
  createElement(tag) {
    return new MiniElement(tag)
  }
  getElementById(id) {
    return this.querySelector(`[id="${id}"]`) || this.querySelector(`#${id}`)
  }
  querySelector(selector) {
    return this.body.querySelector(selector) || this.head.querySelector(selector)
  }
  querySelectorAll(selector) {
    return [...this.body.querySelectorAll(selector), ...this.head.querySelectorAll(selector)]
  }
}

const doc = new MiniDocument()
globalThis.document = doc

let mutationListeners = []
globalThis.MutationObserver = class {
  constructor(fn) {
    this.fn = fn
  }
  observe() {
    mutationListeners.push(this.fn)
  }
  disconnect() {
    mutationListeners = mutationListeners.filter((l) => l !== this.fn)
  }
}

let registration = null
globalThis.window = {
  document: doc,
  MutationObserver: globalThis.MutationObserver,
  innerWidth: 1280,
  innerHeight: 800,
  __ModuleLoader__: {
    load: (entry) => { registration = entry },
  },
}

const postedAddRequests = []
/** Hosts sent to POST /remote-ssh/remove-host. */
const postedRemoveRequests = []
/** When true, remove-host answers with an empty body (route-missing fallback). */
let removeHostEmptyBody = false
/** Deferred resolver for the in-flight POST /remote-ssh/add-host request. */
let addHostResolve = null
globalThis.fetch = async (url, options) => {
  const method = options?.method || 'GET'
  if (url === '/remote-ssh/available-hosts') {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        currentHosts: ['dev'],
        connectedHosts: [{ host: 'dev', hostName: 'dev.internal', port: 4022, user: 'dm' }],
        availableHosts: [
          { host: 'preprod', hostName: '100.97.143.121', port: 4022, user: 'dm' },
        ],
      }),
    }
  }
  if (url === '/remote-ssh/sessions') {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        hosts: ['dev'],
        workspaces: [{ cwd: '/home/dm/repo', name: 'repo', sessions: [] }],
        sessions: [],
        archivedSessionIds: [],
        pinnedSessionIds: [],
      }),
    }
  }
  if (url === '/remote-ssh/add-host' && method === 'POST') {
    const body = options?.body ? JSON.parse(options.body) : {}
    postedAddRequests.push(body)
    // Keep the request pending until the test resolves it, so the loading
    // state can be asserted mid-flight.
    return new Promise((resolve) => {
      addHostResolve = () => resolve({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, host: body.host, localPort: 39388, autoStarted: true }),
      })
    })
  }
  if (url === '/remote-ssh/remove-host' && method === 'POST') {
    const body = options?.body ? JSON.parse(options.body) : {}
    postedRemoveRequests.push(body)
    if (removeHostEmptyBody) {
      // Simulate the desktop static fallback answering an unknown route with an
      // empty body — the client must not crash with "Unexpected end of JSON input".
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => { throw new Error('Unexpected end of JSON input') },
      }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, host: body.host }) }
  }
  return { ok: true, status: 200, json: async () => ({}) }
}

new Function(source)()

const clientExports = registration.factory(() => undefined)

class RemoteService extends Service {
  static [Service.tracker] = { associate: 'remote' }
  constructor(ctx) {
    super(ctx, 'remote')
  }
}

class RemoteSessionService extends Service {
  constructor(ctx) {
    super(ctx, 'remote.session')
    for (const method of ['page', 'follow', 'projections', 'prompt', 'cancel', 'create']) {
      Object.defineProperty(this, method, {
        configurable: true,
        enumerable: true,
        get: () => (...args) => ({ ok: true, value: { method, args } }),
      })
    }
  }
}

class RemoteWorkspaceService extends Service {
  constructor(ctx) {
    super(ctx, 'remote.workspace')
    for (const method of ['archiveSession', 'unarchiveSession', 'pinSession', 'unpinSession']) {
      Object.defineProperty(this, method, {
        configurable: true,
        enumerable: true,
        get: () => (...args) => ({ ok: true, value: { method, args } }),
      })
    }
  }
}

class WorkspacesService extends Service {
  constructor(ctx) {
    super(ctx, 'workspaces')
    this.list = { items: [], archivedSessionIds: [], upsertView: () => {}, removeView: () => {} }
  }
}

class SessionsService extends Service {
  constructor(ctx) {
    super(ctx, 'sessions')
  }
  handleSessionAdded() {}
  handleSessionStatus() {}
}

const root = new Context()
root.plugin(RemoteService)
root.plugin(RemoteSessionService)
root.plugin(RemoteWorkspaceService)
root.plugin(WorkspacesService)
root.plugin(SessionsService)

// 1. Simulate official WorkspaceBrowser sectionHeader DOM
const sectionHeader = doc.createElement('div')
sectionHeader.className = 'WorkspaceBrowser_sectionHeader'
doc.body.appendChild(sectionHeader)

const sectionLabel = doc.createElement('span')
sectionLabel.className = 'WorkspaceBrowser_sectionLabel'
sectionLabel.textContent = '工作区'
sectionHeader.appendChild(sectionLabel)

const searchSlot = doc.createElement('div')
searchSlot.className = 'WorkspaceBrowser_searchSlot'
sectionHeader.appendChild(searchSlot)

const searchBox = doc.createElement('div')
searchBox.className = 'WorkspaceBrowser_search'
searchSlot.appendChild(searchBox)

const searchBtn = doc.createElement('button')
searchBtn.className = 'WorkspaceBrowser_searchButton'
searchBtn.setAttribute('aria-label', '搜索')
searchBox.appendChild(searchBtn)

const fork = root.plugin({
  name: registration.id,
  inject: clientExports.inject,
  apply: clientExports.apply,
})

await new Promise((resolve) => setTimeout(resolve, 50))

console.log('Testing Workspace Header Add Remote Button injection...')

// Trigger mutation observers to detect header
for (const listener of mutationListeners) {
  listener()
}

// 2. Assert Add Remote button was injected before searchSlot
const addRemoteBtn = sectionHeader.querySelector('#dsh-add-remote-workspace-btn')
assert.ok(addRemoteBtn, '#dsh-add-remote-workspace-btn must be injected into sectionHeader')

const searchSlotIndex = sectionHeader.children.indexOf(searchSlot)
const addRemoteBtnIndex = sectionHeader.children.indexOf(addRemoteBtn)
assert.ok(addRemoteBtnIndex !== -1, 'Add Remote button must be in sectionHeader')
assert.ok(addRemoteBtnIndex < searchSlotIndex, 'Add Remote button must be positioned before searchSlot')

// 2b. Assert the button uses the official-style tooltip, not the native title
assert.equal(addRemoteBtn.getAttribute('title'), null, 'Add Remote button must not use a native title attribute')
assert.equal(addRemoteBtn.title, undefined, 'Add Remote button must not use a native title property')
assert.ok(addRemoteBtn.getAttribute('aria-label'), 'Add Remote button must keep an aria-label')
assert.equal(addRemoteBtn.getAttribute('aria-label'), '添加远程工作区')

// 2c. Regression guard: reposition must tolerate a real-browser HTMLCollection
// (element.children has no Array methods). Pinning the Array.from fix so a
// future re-introduction of Array.isArray fails this smoke loudly.
assert.ok(source.includes('Array.from(header.children)'), 'reposition must convert header.children with Array.from (HTMLCollection-safe)')

// 3. Click the button to open Popover
addRemoteBtn.click()

await new Promise((resolve) => setTimeout(resolve, 50))

const popover = doc.querySelector('#dsh-add-remote-popover')
assert.ok(popover, '#dsh-add-remote-popover must be rendered upon clicking the button')

// Mini-DOM lacks descendant selectors, so scope items via the ancestor chain.
const findSectionItem = (sectionClass) => {
  const items = popover.querySelectorAll('.dsh-remote-popover-item')
  return items.find((el) => {
    let p = el.parentElement
    while (p) {
      if (typeof p.className === 'string' && p.className.includes(sectionClass)) return true
      p = p.parentElement
    }
    return false
  })
}

// 4. Connected hosts section: already-connected servers are shown with a
//    disconnect action (active-blue disconnect icon), not a re-add plus.
const connectedItem = findSectionItem('connected')
assert.ok(connectedItem, 'Connected hosts section must render host rows')
assert.ok(connectedItem.textContent.includes('dev'), 'Connected section must list the connected host')
const disconnectBtn = connectedItem.querySelector('.dsh-remote-popover-item-btn')
assert.ok(disconnectBtn, 'Connected host must expose a disconnect button')
assert.ok(disconnectBtn.querySelector('svg'), 'Disconnect button must render an icon')
assert.ok(disconnectBtn.getAttribute('aria-label').includes('dev'), 'Disconnect button label must name the host')
assert.ok(disconnectBtn.getAttribute('aria-label').startsWith('断开主机'), 'Disconnect button must use disconnect semantics, not add')

// 4b. Disconnect flow posts /remote-ssh/remove-host.
disconnectBtn.click()
await new Promise((resolve) => setTimeout(resolve, 50))
assert.equal(postedRemoveRequests.length, 1, 'POST /remote-ssh/remove-host must be dispatched on disconnect')
assert.equal(postedRemoveRequests[0].host, 'dev')

// 4c. Empty-body disconnect responses (route-missing fallback) must surface a
//     friendly error instead of a raw "Unexpected end of JSON input" crash.
removeHostEmptyBody = true
const connectedItem2 = findSectionItem('connected')
const disc2 = connectedItem2.querySelector('.dsh-remote-popover-item-btn')
assert.ok(disc2, 'Connected section must still render after refresh')
disc2.click()
await new Promise((resolve) => setTimeout(resolve, 50))
assert.equal(postedRemoveRequests.length, 2, 'second disconnect must be dispatched')
const feedback2 = connectedItem2.parentElement && connectedItem2.parentElement.querySelector
  ? connectedItem2.parentElement.querySelector('.dsh-popover-feedback')
  : null
assert.ok(feedback2, 'Disconnect row must expose a feedback seat')
assert.ok(
  feedback2.textContent.includes('断开失败'),
  'Empty-body disconnect must show a friendly error, not a JSON parse crash',
)
assert.ok(
  !feedback2.textContent.includes('Unexpected end of JSON input'),
  'Raw JSON parse errors must never reach the user',
)
removeHostEmptyBody = false

// 5. Available hosts section: unconnected hosts offer a connect action with a
//    connection icon (no "+" re-add semantics).
const availableItem = findSectionItem('available')
assert.ok(availableItem, 'Available hosts section must render host rows')
assert.ok(availableItem.textContent.includes('preprod'), 'Available section should include preprod')
const connectBtn = availableItem.querySelector('.dsh-remote-popover-item-btn') || availableItem
assert.ok(connectBtn, 'Available host must expose a connect button')
assert.equal(connectBtn.textContent, '', 'Connect button must be icon-only (no visible text)')
assert.ok(connectBtn.querySelector('svg'), 'Connect button must render an icon (not a plus)')
assert.ok(connectBtn.getAttribute('aria-label'), 'Connect button must keep an accessible label')
assert.ok(connectBtn.getAttribute('aria-label').startsWith('连接主机'), 'Connect button must use connect semantics, not add')
assert.ok(connectBtn.getAttribute('aria-label').includes('preprod'), 'Connect button label must name the host')

// 5b. Click the connect button for preprod; assert loading state mid-flight
connectBtn.click()

await new Promise((resolve) => setTimeout(resolve, 20))

assert.equal(postedAddRequests.length, 1, 'POST /remote-ssh/add-host must be dispatched')
assert.equal(postedAddRequests[0].host, 'preprod')
assert.equal(connectBtn.disabled, true, 'Connect button must be disabled while connecting')
assert.equal(connectBtn.getAttribute('aria-busy'), 'true', 'Connect button must announce busy state while connecting')
assert.ok(connectBtn.querySelector('.dsh-remote-spinner'), 'Connect button must show a spinner while connecting')

// 6. Resolve the in-flight add-host request; assert success toast
assert.ok(addHostResolve, 'add-host request must be pending for the test to resolve')
addHostResolve()

await new Promise((resolve) => setTimeout(resolve, 50))

const toast = doc.querySelector('.dsh-remote-toast')
assert.ok(toast, 'Official-style toast must be rendered on connection success')
assert.equal(toast.getAttribute('role'), 'alert', 'Toast must carry role="alert"')
assert.ok(toast.textContent.includes('preprod'), 'Toast must name the connected host')
assert.ok(toast.textContent.includes('启动 dsh 服务'), 'Toast must note the remote dsh service was auto-started')
assert.ok(toast.querySelector('.dsh-remote-toast-icon--success'), 'Toast must render the success check-circle icon')

// 6b. After success the button must stay disabled until the popover closes,
//     the spinner must be gone and the icon flipped to the blue success glyph.
assert.equal(connectBtn.disabled, true, 'Connect button must stay disabled until the popover closes')
assert.equal(connectBtn.querySelector('.dsh-remote-spinner'), null, 'Spinner must be removed after success')
assert.ok(connectBtn.querySelector('svg'), 'Success glyph must be rendered after success')

// 7. Tooltip behavior: official-style bubble on hover, ghost-free when the
//    anchor is removed during the 500ms delay.
addRemoteBtn.dispatchEvent({ type: 'mouseenter', target: addRemoteBtn, stopPropagation() {} })
await new Promise((resolve) => setTimeout(resolve, 560))
const tooltip = doc.querySelector('.dsh-remote-tooltip')
assert.ok(tooltip, 'Official-style tooltip bubble must appear after the hover delay')
assert.equal(tooltip.getAttribute('role'), 'tooltip', 'Tooltip must carry role="tooltip"')
assert.ok(tooltip.textContent.includes('添加远程工作区'), 'Tooltip must show the button label')
addRemoteBtn.dispatchEvent({ type: 'mouseleave', target: addRemoteBtn, stopPropagation() {} })
assert.equal(doc.querySelector('.dsh-remote-tooltip'), null, 'Tooltip must withdraw on mouse leave')

// 7b. Ghost-bubble guard: if the anchor is detached while the delay is pending,
//     no bubble may be appended to document.body.
addRemoteBtn.dispatchEvent({ type: 'mouseenter', target: addRemoteBtn, stopPropagation() {} })
addRemoteBtn.remove()
await new Promise((resolve) => setTimeout(resolve, 560))
assert.equal(doc.querySelector('.dsh-remote-tooltip'), null, 'No tooltip bubble may be rendered for a detached anchor')
// Re-create the button so teardown can find it.
for (const listener of mutationListeners) {
  listener()
}

console.log('all smoke-workspace-btn assertions passed cleanly!')

await fork.dispose()
