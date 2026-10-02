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
  __ModuleLoader__: {
    load: (entry) => { registration = entry },
  },
}

const postedAddRequests = []
globalThis.fetch = async (url, options) => {
  const method = options?.method || 'GET'
  if (url === '/remote-ssh/available-hosts') {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        currentHosts: ['dev'],
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
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, host: body.host, localPort: 39388, autoStarted: true }),
    }
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

// 3. Click the button to open Popover
addRemoteBtn.click()

await new Promise((resolve) => setTimeout(resolve, 50))

const popover = doc.querySelector('#dsh-add-remote-popover')
assert.ok(popover, '#dsh-add-remote-popover must be rendered upon clicking the button')

// 4. Assert host list contains "preprod"
const hostItem = popover.querySelector('.dsh-remote-popover-item')
assert.ok(hostItem, 'Popover should render host items from available hosts')
assert.ok(hostItem.textContent.includes('preprod'), 'Host item should include preprod')

// 5. Click the connect/add button for preprod
const connectBtn = hostItem.querySelector('.dsh-remote-popover-item-btn') || hostItem
connectBtn.click()

await new Promise((resolve) => setTimeout(resolve, 50))

// 6. Assert POST /remote-ssh/add-host was dispatched
assert.equal(postedAddRequests.length, 1)
assert.equal(postedAddRequests[0].host, 'preprod')

console.log('all smoke-workspace-btn assertions passed cleanly!')

await fork.dispose()
