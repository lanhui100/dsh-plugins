/**
 * Performance-regression smoke for the client bundle's hot-path throttling:
 *
 * 1. Poll dirty-check: an unchanged remote snapshot must NOT fan out again
 *    into the official models (no duplicate upsertView / handleSessionAdded),
 *    while a changed snapshot must still fan out with the new state.
 * 2. MutationObserver coalescing: N DOM mutations within one animation frame
 *    schedule exactly ONE decoration pass (requestAnimationFrame), and the
 *    merged pass still renders the workspace add-remote button.
 *
 * These two behaviours ARE the fix for "long-lived page becomes janky": before
 * them, every body mutation ran four full document scans per mutation and
 * every 60s poll re-upserted the whole remote tree even when idle.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'client.js'), 'utf8')

let registration
globalThis.window = {
  __ModuleLoader__: { load: (value) => { registration = value } },
}

// ---------------------------------------------------------------------------
// Minimal DOM doubles (mirror smoke-workspace-btn.mjs) + controllable hooks
// ---------------------------------------------------------------------------
class MiniElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.parentElement = null
    this.attributes = new Map()
    this.listeners = new Map()
    this._textContent = ''
    this.id = ''
    this.className = ''
    this.style = {}
    this.disabled = false
    this.classList = {
      add: (...cs) => {
        const set = new Set(this.className.split(/\s+/).filter(Boolean))
        for (const c of cs) set.add(c)
        this.className = [...set].join(' ')
      },
      remove: (...cs) => {
        const set = new Set(this.className.split(/\s+/).filter(Boolean))
        for (const c of cs) set.delete(c)
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
  set innerHTML(_) {
    this.children = []
    this._textContent = ''
  }
  get isConnected() {
    return this.parentElement !== null
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
    if (idx === -1) return this.appendChild(newChild)
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
  removeChild(child) {
    const idx = this.children.indexOf(child)
    if (idx !== -1) {
      this.children.splice(idx, 1)
      child.parentElement = null
    }
    return child
  }
  getBoundingClientRect() {
    return { top: 100, bottom: 124, left: 200, right: 224, width: 24, height: 24 }
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(fn)
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type) || []
    const idx = list.indexOf(fn)
    if (idx !== -1) list.splice(idx, 1)
  }
  dispatchEvent(event) {
    const list = this.listeners.get(event.type) || []
    for (const fn of list) fn(event)
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
          if (!el.classList.contains(cm.slice(1))) { isMatch = false; break }
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
      if (isMatch && remaining === '') results.push(el)
      for (const child of el.children) check(child)
    }
    for (const child of this.children) check(child)
    return results
  }
}

const head = new MiniElement('head')
const body = new MiniElement('body')
// The official sidebar panel list the add-remote button anchors into.
const panelList = new MiniElement('nav')
panelList.setAttribute('class', 'panelList')
body.appendChild(panelList)
const doc = {
  head,
  body,
  createElement: (tag) => new MiniElement(tag),
  getElementById: (id) => doc.querySelector(`[id="${id}"]`),
  querySelector: (sel) => doc.body.querySelector(sel) || doc.head.querySelector(sel) || null,
  querySelectorAll: (sel) => [...doc.body.querySelectorAll(sel), ...doc.head.querySelectorAll(sel)],
}
globalThis.document = doc

// Controllable MutationObserver: records the callback, tests fire it manually.
let observerCallback = null
globalThis.MutationObserver = class {
  constructor(cb) { observerCallback = cb }
  observe() {}
  disconnect() {}
}

// Controllable requestAnimationFrame: queues frames instead of running them,
// so the test can prove N mutations produce exactly ONE scheduled pass.
const rafQueue = []
globalThis.requestAnimationFrame = (cb) => {
  rafQueue.push(cb)
  return rafQueue.length
}

// Controllable setInterval/reconcile trigger.
const intervalFns = []
const realSetInterval = globalThis.setInterval
globalThis.setInterval = (fn, ms) => {
  intervalFns.push(fn)
  return intervalFns.length
}
globalThis.clearInterval = () => {}

// ---------------------------------------------------------------------------
// Host route fixture (same body shape as the real /remote-ssh/sessions)
// ---------------------------------------------------------------------------
let remoteSnapshot = {
  host: 'dev',
  archivedSessionIds: ['remote:dev:old'],
  pinnedSessionIds: [],
  workspaces: [
    {
      workspaceId: 'remote:dev:ws',
      cwd: '/home/dev',
      name: 'dev-repo',
      sessions: [{ sessionId: 'remote:dev:s1', running: false, updatedAt: 1 }],
    },
  ],
  sessions: [{ sessionId: 'remote:dev:s1', running: false, cwd: '/home/dev', updatedAt: 1 }],
}
let sessionsFetchCount = 0
globalThis.fetch = async (url) => {
  const urlStr = String(url)
  if (urlStr.includes('/remote-ssh/sessions')) {
    sessionsFetchCount += 1
    return { ok: true, status: 200, json: async () => ({ ...remoteSnapshot }) }
  }
  if (urlStr.includes('/remote-ssh/session-follow')) {
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"snapshot","cursor":1,"records":[]}\n\n'))
        controller.close()
      },
    })
    return { ok: true, status: 200, headers: { get: () => 'text/event-stream' }, body: stream }
  }
  return { ok: true, status: 200, json: async () => ({}) }
}

// The browser evaluates the script purely to register the factory.
new Function(source)()

const clientExports = registration.factory((specifier) => {
  if (specifier === 'react') return undefined
  throw new Error(`unexpected external request: ${specifier}`)
})

class RemoteCommandsService extends Service {
  constructor(ctx) {
    super(ctx, 'remote.commands')
    this.list = (...args) => Promise.resolve({ ok: true, value: [] })
    this.execute = (...args) => Promise.resolve({ ok: true, value: { result: { kind: 'success' } } })
  }
}

class RemoteService extends Service {
  static [Service.tracker] = { associate: 'remote' }
  constructor(ctx) { super(ctx, 'remote') }
}
class FileUploadService extends Service {
  constructor(ctx) { super(ctx, 'fileUpload') }
  upload(...args) { return Promise.resolve({ ok: true, value: { method: 'upload', args } }) }
}
class RemoteSessionService extends Service {
  constructor(ctx) {
    super(ctx, 'remote.session')
    for (const m of ['page', 'follow', 'projections', 'prompt', 'cancel', 'rename', 'selectModel', 'attachment', 'create']) {
      Object.defineProperty(this, m, { configurable: true, enumerable: true, get: () => (...a) => ({ ok: true, value: {} }) })
    }
  }
}
class RemoteWorkspaceService extends Service {
  constructor(ctx) {
    super(ctx, 'remote.workspace')
    for (const m of ['archiveSession', 'unarchiveSession', 'pinSession', 'unpinSession']) {
      Object.defineProperty(this, m, { configurable: true, enumerable: true, get: () => (...a) => ({ ok: true, value: {} }) })
    }
  }
}

const upserted = []
const addedSessions = []
class WorkspacesService extends Service {
  constructor(ctx) {
    super(ctx, 'workspaces')
    this.list = {
      items: [],
      archivedSessionIds: [],
      pinnedSessionIds: [],
      removedIds: new Set(),
      upsertView: (view) => {
        if (this.list.removedIds.has(view.workspaceId)) return
        upserted.push(view)
        const idx = this.list.items.findIndex((item) => item.workspaceId === view.workspaceId)
        if (idx === -1) this.list.items.unshift(view)
        else this.list.items[idx] = view
      },
      removeView: (id) => {
        this.list.removedIds.add(id)
        this.list.items = this.list.items.filter((item) => item.workspaceId !== id)
      },
      replaceBaseline(baseline) {
        this.list.items = [...(baseline.items || [])]
        this.list.archivedSessionIds = [...(baseline.archivedSessionIds || [])]
        this.list.pinnedSessionIds = [...(baseline.pinnedSessionIds || [])]
      },
    }
  }
}
class SessionsService extends Service {
  constructor(ctx) { super(ctx, 'sessions') }
  handleSessionAdded(summary) { addedSessions.push(summary) }
  handleSessionRemoved() {}
  handleSessionStatus() {}
}

const root = new Context()
root.plugin(RemoteCommandsService)
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
if (fork.state === 3 || fork._error) throw (fork._error || new Error('plugin failed to activate'))

// Settle the initial reconcile and initial decoration pass.
await new Promise((resolve) => setTimeout(resolve, 20))

const wsList = root.get('workspaces').list

// --- 1. Initial activation fans out exactly once ---------------------------
// The fixture has one remote workspace plus its host-root folder -> 2 views.
assert.equal(upserted.length, 2, 'Initial reconcile must upsert host-root + workspace exactly once')
assert.equal(addedSessions.length, 1, 'Initial reconcile must add the remote session once')
assert.ok(wsList.archivedSessionIds.includes('remote:dev:old'), 'Initial archived sync must land')

// --- 2. Poll dirty-check: unchanged snapshot must NOT fan out again --------
const upsertedBefore = upserted.length
const addedBefore = addedSessions.length
const fetchBefore = sessionsFetchCount
assert.equal(intervalFns.length, 1, 'apply must register the 60s poll timer')
// Manually run the poll with identical data.
await intervalFns[0]()
await new Promise((resolve) => setTimeout(resolve, 5))
assert.ok(sessionsFetchCount > fetchBefore, 'Poll must still fetch the snapshot')
assert.equal(upserted.length, upsertedBefore, 'Unchanged snapshot must NOT re-upsert workspaces')
assert.equal(addedSessions.length, addedBefore, 'Unchanged snapshot must NOT re-add sessions')

// --- 3. Poll dirty-check: changed snapshot MUST fan out with new state -----
remoteSnapshot.sessions[0].running = true
remoteSnapshot.workspaces[0].sessions[0].running = true
await intervalFns[0]()
await new Promise((resolve) => setTimeout(resolve, 5))
assert.ok(upserted.length > upsertedBefore, 'Changed snapshot must re-upsert the workspace')
assert.ok(addedSessions.length > addedBefore, 'Changed snapshot must re-add the session')
assert.equal(addedSessions[addedSessions.length - 1].running, true, 'Re-fanned session must carry the new running state')

// --- 4. rAF coalescing: N mutations -> ONE scheduled decoration pass -------
const scheduledBefore = rafQueue.length
assert.ok(typeof observerCallback === 'function', 'installTitleDecorator must register a MutationObserver')
// Simulate a burst of body mutations inside one frame (streaming turn).
for (let i = 0; i < 8; i++) observerCallback([{ target: body, type: 'childList' }])
assert.equal(rafQueue.length, scheduledBefore + 1, '8 mutations in one frame must schedule exactly ONE decoration pass')
// The merged pass must run and render the add-remote button.
rafQueue.pop()()
assert.ok(
  doc.querySelector('#dsh-add-remote-workspace-btn'),
  'Merged decoration pass must still render the add-remote workspace button',
)
assert.equal(rafQueue.length, 0, 'Executing the merged pass must clear the frame queue')

// A second burst in a later frame schedules a second (merged) pass.
for (let i = 0; i < 3; i++) observerCallback([{ target: body, type: 'childList' }])
assert.equal(rafQueue.length, 1, 'A later frame burst must schedule exactly one more pass')

await fork.dispose()
assert.ok(!doc.querySelector('#dsh-add-remote-workspace-btn'), 'Teardown must remove the injected button')
assert.equal(rafQueue.length, 1, 'Teardown must not schedule further decoration passes')

console.log('all smoke-performance assertions passed cleanly!')