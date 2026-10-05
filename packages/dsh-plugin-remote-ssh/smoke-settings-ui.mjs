/**
 * Smoke test for Settings UI dropdown host addition:
 * Verifies that when settings panel opens in DOM, Remote SSH card is injected,
 * unadded hosts are fetched and populated into <select>, and clicking Add dispatches POST /remote-ssh/add-host.
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

  get innerHTML() {
    return this.textContent
  }
  set innerHTML(html) {
    this.children = []
    this._textContent = String(html)
    // Simple parser for select, option, button, and classes
    const tagMatches = html.matchAll(/<([a-zA-Z0-9]+)([^>]*)>(.*?)<\/\1>|<([a-zA-Z0-9]+)([^>]*)\/?>/gs)
    for (const match of tagMatches) {
      const tagName = match[1] || match[4]
      const rawAttrs = match[2] || match[5] || ''
      const inner = match[3] || ''
      const child = new MiniElement(tagName)
      
      const classMatch = rawAttrs.match(/class=["']([^"']+)["']/)
      if (classMatch) child.className = classMatch[1]
      
      const idMatch = rawAttrs.match(/id=["']([^"']+)["']/)
      if (idMatch) child.id = idMatch[1]

      const valMatch = rawAttrs.match(/value=["']([^"']+)["']/)
      if (valMatch) child.value = valMatch[1]

      if (rawAttrs.includes('disabled')) child.disabled = true

      child.textContent = inner
      this.appendChild(child)
    }
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

  remove() {
    if (this.parentElement) {
      const idx = this.parentElement.children.indexOf(this)
      if (idx !== -1) this.parentElement.children.splice(idx, 1)
      this.parentElement = null
    }
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
    this.dispatchEvent({ type: 'click', target: this, defaultPrevented: false })
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

const postedRequests = []
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
          { host: 'pro', hostName: 'proserver.internal', port: 1022, user: 'dm' },
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
    postedRequests.push(body)
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, host: body.host, localPort: 39388 }),
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

class FileUploadService extends Service {
  constructor(ctx) {
    super(ctx, 'fileUpload')
  }
  upload(...args) {
    return Promise.resolve({ ok: true, value: { method: 'upload', args } })
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
root.plugin(FileUploadService)

const fork = root.plugin({
  name: registration.id,
  inject: clientExports.inject,
  apply: clientExports.apply,
})

// Settle initial plugin activation & MutationObserver registration
await new Promise((resolve) => setTimeout(resolve, 100))

console.log('Testing Settings panel mounting and card injection...')

// 1. Simulate opening settings modal by appending settings panel to DOM
const settingsOverlay = doc.createElement('div')
settingsOverlay.className = 'VOzbGW_overlay'
doc.body.appendChild(settingsOverlay)

const settingsPanel = doc.createElement('div')
settingsPanel.className = 'VOzbGW_panel'
settingsOverlay.appendChild(settingsPanel)

const settingsOptions = doc.createElement('div')
settingsOptions.className = 'VOzbGW_options'
settingsPanel.appendChild(settingsOptions)

// Trigger mutation observers
for (const listener of mutationListeners) {
  listener()
}

// Await async fetch of available hosts
await new Promise((resolve) => setTimeout(resolve, 50))

// 2. Assert Remote SSH Settings Card was injected
const card = settingsOptions.querySelector('#dsh-remote-settings-card')
assert.ok(card, 'Remote SSH Settings Card must be injected into settings options container')

// 3. Assert Dropdown is populated with available unadded hosts
const select = card.querySelector('.dsh-remote-host-select')
assert.ok(select, 'Host select dropdown must exist in settings card')
assert.ok(select.children.length >= 2, 'Dropdown should contain preprod and pro options')

// 4. Assert Add button exists
const addBtn = card.querySelector('.dsh-remote-btn-add-host')
assert.ok(addBtn, 'Add host button must exist')

// 5. Select "preprod" and click Add
select.value = 'preprod'
addBtn.click()

await new Promise((resolve) => setTimeout(resolve, 50))

// 6. Assert POST request was dispatched with target host
assert.equal(postedRequests.length, 1, 'POST /remote-ssh/add-host must be called')
assert.equal(postedRequests[0].host, 'preprod')

console.log('all smoke-settings-ui assertions passed cleanly!')

await fork.dispose()
