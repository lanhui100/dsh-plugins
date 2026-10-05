/**
 * Smoke test for ask_user_question UI question card:
 * Verifies DOM card rendering, recommendation badge, option toggle, custom input,
 * and response submission/cancellation lifecycle under a mock browser DOM.
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
    this.checked = false
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
      toggle: (c, force) => {
        const set = new Set(this.className.split(/\s+/).filter(Boolean))
        const has = set.has(c)
        const shouldHave = force !== undefined ? Boolean(force) : !has
        if (shouldHave) set.add(c)
        else set.delete(c)
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
    if (name.startsWith('data-')) {
      const camel = name.slice(5).replace(/-([a-z])/g, (_, g) => g.toUpperCase())
      this.dataset[camel] = String(val)
    }
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

  closest(selector) {
    let cur = this
    while (cur) {
      if (cur.matches && cur.matches(selector)) return cur
      cur = cur.parentElement
    }
    return null
  }

  matches(selector) {
    if (!selector) return false
    if (selector.startsWith('.')) {
      return this.classList.contains(selector.slice(1))
    }
    if (selector.startsWith('[')) {
      const match = selector.match(/^\[([a-zA-Z0-9_-]+)(?:=("[^"]*"|'[^']*'|[^\]]+))?\]$/)
      if (match) {
        const attr = match[1]
        let expected = match[2]
        if (expected && (expected.startsWith('"') || expected.startsWith("'"))) {
          expected = expected.slice(1, -1)
        }
        const actual = this.getAttribute(attr)
        return expected !== undefined ? actual === expected : actual !== null
      }
    }
    return false
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

      const attrMatches = remaining.match(/\[([a-zA-Z0-9_-]+)(?:=("[^"]*"|'[^']*'|[^\]]+))?\]/g)
      if (isMatch && attrMatches) {
        for (const am of attrMatches) {
          const m = am.match(/\[([a-zA-Z0-9_-]+)(?:=("[^"]*"|'[^']*'|[^\]]+))?\]/)
          if (m) {
            const attr = m[1]
            let exp = m[2]
            if (exp && (exp.startsWith('"') || exp.startsWith("'"))) exp = exp.slice(1, -1)
            const actual = el.getAttribute(attr)
            if (exp !== undefined ? actual !== exp : actual === null) {
              isMatch = false
              break
            }
          }
          remaining = remaining.replace(am, '')
        }
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

  get innerHTML() {
    return this._textContent
  }

  set innerHTML(html) {
    this.children = []
    this._textContent = ''
    parseHtmlToTree(html, this)
  }
}

function parseHtmlToTree(html, root) {
  const tagRegex = /<\/?([a-zA-Z0-9_-]+)([^>]*?)(\/?)>|([^<]+)/g
  let match
  let current = root

  while ((match = tagRegex.exec(html)) !== null) {
    const [full, tagName, attrsStr, selfClosing, text] = match
    if (text) {
      const trimmed = text.trim()
      if (trimmed) {
        const textNode = new MiniElement('#text')
        textNode._textContent = trimmed
        current.appendChild(textNode)
      }
      continue
    }

    if (full.startsWith('</')) {
      if (current.parentElement) {
        current = current.parentElement
      }
      continue
    }

    const elem = new MiniElement(tagName)
    if (attrsStr) {
      const attrRegex = /([a-zA-Z0-9_-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^>\s]+)))?/g
      let attrMatch
      while ((attrMatch = attrRegex.exec(attrsStr)) !== null) {
        const name = attrMatch[1]
        const val = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? ''
        elem.setAttribute(name, val)
      }
    }

    current.appendChild(elem)
    const isSelfClosing = selfClosing === '/' || ['input', 'img', 'br', 'hr'].includes(tagName.toLowerCase())
    if (!isSelfClosing) {
      current = elem
    }
  }
}

class MiniMutationObserver {
  constructor(callback) {
    this.callback = callback
  }
  observe() {}
  disconnect() {}
}

const doc = {
  head: new MiniElement('head'),
  body: new MiniElement('body'),
  createElement(tag) {
    return new MiniElement(tag)
  },
  getElementById(id) {
    return this.querySelector(`[id="${id}"]`)
  },
  querySelector(sel) {
    return this.body.querySelector(sel) || this.head.querySelector(sel)
  },
  querySelectorAll(sel) {
    return [...this.body.querySelectorAll(sel), ...this.head.querySelectorAll(sel)]
  },
}

globalThis.document = doc
globalThis.MutationObserver = MiniMutationObserver

// Setup conversation session & composer DOM seat
const sessionContainer = doc.createElement('div')
sessionContainer.setAttribute('data-conversation-content', 'true')
sessionContainer.setAttribute('data-conversation-session', 'session-demo-1')
doc.body.appendChild(sessionContainer)

const composerSeat = doc.createElement('div')
composerSeat.setAttribute('data-conversation-region', 'composer')
sessionContainer.appendChild(composerSeat)

const defaultEditor = doc.createElement('div')
defaultEditor.className = 'native-editor'
defaultEditor.textContent = 'Native Composer Input'
composerSeat.appendChild(defaultEditor)

let registration
globalThis.window = {
  document: doc,
  MutationObserver: MiniMutationObserver,
  __ModuleLoader__: {
    load: (value) => { registration = value },
  },
}

const submittedPayloads = []
globalThis.fetch = async (url, options) => {
  const urlStr = String(url)
  if (urlStr.includes('/remote-ssh/sessions')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        host: 'dev',
        total: 2,
        workspaces: [{
          cwd: '/tmp/demo',
          name: 'demo',
          sessions: [{ sessionId: 'session-demo-1' }, { sessionId: 'session-demo-2' }],
        }],
        sessions: [
          { sessionId: 'session-demo-1', cwd: '/tmp/demo' },
          { sessionId: 'session-demo-2', cwd: '/tmp/demo' },
        ],
      }),
    }
  }
  if (urlStr.includes('/remote-ssh/interaction-respond')) {
    const body = options?.body ? JSON.parse(options.body) : null
    submittedPayloads.push(body)
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, value: { accepted: true } }),
    }
  }
  if (urlStr.includes('/remote-ssh/session-follow')) {
    const isSession2 = urlStr.includes('session-demo-2')
    const sseFrames = isSession2
      ? [
          JSON.stringify({ type: 'snapshot', cursor: 1, records: [] }),
          JSON.stringify({
            type: 'interaction/request',
            eventId: 'evt-test-cancel-2',
            sessionId: 'session-demo-2',
            questions: [
              {
                id: 'q2',
                question: 'Confirm deployment?',
                options: [{ label: 'Yes' }, { label: 'No' }],
              },
            ],
          }),
        ]
      : [
          JSON.stringify({ type: 'snapshot', cursor: 1, records: [] }),
          JSON.stringify({
            type: 'interaction/request',
            eventId: 'evt-test-question-1',
            sessionId: 'session-demo-1',
            questions: [
              {
                id: 'q1',
                question: 'Which build tool do you prefer?',
                detail: 'Used for frontend assets bundler',
                options: [
                  { label: 'Vite (recommended)', description: 'Fast ESM bundler' },
                  { label: 'Webpack', description: 'Classic bundler' },
                ],
                multiSelect: false,
              },
            ],
          }),
        ]
    const sseText = sseFrames.map((f) => `data: ${f}\n\n`).join('')
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseText))
        controller.close()
      },
    })
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'text/event-stream' },
      body: stream,
    }
  }
  return { ok: true, status: 200, json: async () => ({}) }
}

new Function(source)()

const clientExports = registration.factory(() => undefined)

class RemoteWorkspaceFilesService extends Service {
  constructor(ctx) {
    super(ctx, 'remote.workspaceFiles')
    this.stat = (...args) => Promise.resolve({ ok: true, value: {} })
    this.read = (...args) => Promise.resolve({ ok: true, value: {} })
    this.readBytes = (...args) => Promise.resolve({ ok: true, value: {} })
    this.list = (...args) => Promise.resolve({ ok: true, value: {} })
  }
}

class RemoteCommandsService extends Service {
  constructor(ctx) {
    super(ctx, 'remote.commands')
    this.list = (...args) => Promise.resolve({ ok: true, value: [] })
    this.execute = (...args) => Promise.resolve({ ok: true, value: { result: { kind: 'success' } } })
  }
}

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
root.plugin(RemoteWorkspaceFilesService)
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

// Settle initial snapshot
await new Promise((resolve) => setTimeout(resolve, 30))

// Start follow to receive interaction/request
const iter = fork.context.remote.session.follow({ sessionId: 'session-demo-1' })
await iter.next() // snapshot
await iter.next() // interaction/request

// 1. Verify that composer element is hidden and card is injected with official frame layout
assert.ok(defaultEditor.classList.contains('dsh-hide-for-question'), 'Existing composer must be hidden')

const frame = composerSeat.querySelector('.dsh-remote-question-frame')
assert.ok(frame, 'Question outer frame must be rendered')
const card = composerSeat.querySelector('.dsh-remote-question-card')
assert.ok(card, 'Question card must be rendered into composer seat')
assert.equal(card.dataset.eventId, 'evt-test-question-1')
assert.equal(card.dataset.sessionId, 'session-demo-1')

// Official visual structure contract asserts
const header = card.querySelector('.dsh-rq-header')
assert.ok(header, 'Header must exist')
const title = card.querySelector('.dsh-rq-title')
assert.equal(title?.textContent, 'Which build tool do you prefer?', 'Question title must render verbatim')
const closeBtn = header.querySelector('.dsh-rq-icon-button')
assert.ok(closeBtn, 'Close button with official icon button class must exist in header')

// 2. Verify questions content and recommendation badge
const options = card.querySelectorAll('.dsh-rq-option')
assert.equal(options.length, 2, 'Must render two options')

const numberBadge = options[0].querySelector('.dsh-rq-number')
assert.equal(numberBadge?.textContent, '1', 'Option must have official numeric indicator 1')

const recTag = options[0].querySelector('.dsh-rq-rec-tag')
assert.ok(recTag, 'First option must have recommendation badge')
assert.equal(recTag.textContent, '推荐')

// 3. User selects first option
options[0].click()
assert.ok(options[0].classList.contains('dsh-rq-selected'), 'First option must be selected')

// 4. User inputs custom text
const customText = card.querySelector('.dsh-rq-custom-text')
assert.ok(customText, 'Custom textarea must exist')
customText.value = 'Please configure TypeScript 5.9'
customText.dispatchEvent({ type: 'input', target: customText })

// 5. User clicks submit button
const submitBtn = card.querySelector('.dsh-rq-btn-submit')
assert.ok(submitBtn, 'Submit button must exist')
submitBtn.click()

// Await async fetch submit
await new Promise((resolve) => setTimeout(resolve, 30))

// 6. Assert submission payload
assert.equal(submittedPayloads.length, 1, 'One submission payload must be sent')
const payload = submittedPayloads[0]
assert.equal(payload.sessionId, 'session-demo-1')
assert.equal(payload.eventId, 'evt-test-question-1')
assert.equal(payload.outcome?.kind, 'result')
assert.deepEqual(payload.outcome?.value?.answers, [
  {
    id: 'q1',
    selected: [],
    custom: 'Please configure TypeScript 5.9',
  },
])

// 7. Verify question card is removed and native composer unhidden
const remainingCard = composerSeat.querySelector('.dsh-remote-question-card')
assert.equal(remainingCard, null, 'Question card must be removed after successful submit')
assert.equal(defaultEditor.classList.contains('dsh-hide-for-question'), false, 'Native composer must be unhidden')

// 8. Test cancellation / skip flow
sessionContainer.remove()

const sessionContainer2 = doc.createElement('div')
sessionContainer2.setAttribute('data-conversation-content', 'true')
sessionContainer2.setAttribute('data-conversation-session', 'session-demo-2')
doc.body.appendChild(sessionContainer2)

const composerSeat2 = doc.createElement('div')
composerSeat2.setAttribute('data-conversation-region', 'composer')
sessionContainer2.appendChild(composerSeat2)

const defaultEditor2 = doc.createElement('div')
defaultEditor2.className = 'native-editor-2'
composerSeat2.appendChild(defaultEditor2)

const iter2 = fork.context.remote.session.follow({ sessionId: 'session-demo-2' })
await iter2.next() // snapshot
await iter2.next() // interaction/request

assert.ok(defaultEditor2.classList.contains('dsh-hide-for-question'), 'Editor 2 must be hidden')
const card2 = composerSeat2.querySelector('.dsh-remote-question-card')
assert.ok(card2, 'Card 2 must be rendered')
assert.equal(card2.dataset.eventId, 'evt-test-cancel-2')

const cancelBtn2 = card2.querySelector('.dsh-rq-btn-cancel')
assert.ok(cancelBtn2, 'Cancel button must exist on card 2')
cancelBtn2.click()

await new Promise((resolve) => setTimeout(resolve, 30))

assert.equal(submittedPayloads.length, 2, 'Two payloads must be submitted')
const cancelPayload = submittedPayloads[1]
assert.equal(cancelPayload.sessionId, 'session-demo-2')
assert.equal(cancelPayload.eventId, 'evt-test-cancel-2')
assert.equal(cancelPayload.outcome?.kind, 'rejected')
assert.equal(cancelPayload.outcome?.error?.code, 'ASK_CANCELLED')

const remainingCard2 = composerSeat2.querySelector('.dsh-remote-question-card')
assert.equal(remainingCard2, null, 'Card 2 must be removed after cancellation')
assert.equal(defaultEditor2.classList.contains('dsh-hide-for-question'), false, 'Editor 2 must be unhidden')

console.log('all smoke-question-card DOM assertions passed cleanly!')

await fork.dispose()
