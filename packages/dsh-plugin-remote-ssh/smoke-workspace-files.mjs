/**
 * Smoke test: verify workspaceFiles proxy on client and host route registration.
 */
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import {
  WORKSPACE_FILE_STAT_ROUTE,
  WORKSPACE_FILE_READ_ROUTE,
  WORKSPACE_FILE_READ_BYTES_ROUTE,
  WORKSPACE_FILE_LIST_ROUTE,
} from './lib/route.js'

assert.ok(WORKSPACE_FILE_STAT_ROUTE)
assert.ok(WORKSPACE_FILE_READ_ROUTE)
assert.ok(WORKSPACE_FILE_READ_BYTES_ROUTE)
assert.ok(WORKSPACE_FILE_LIST_ROUTE)

// Test client proxy wrapping
let interceptedUrl = ''
let interceptedBody = ''
const originalFetch = globalThis.fetch
globalThis.fetch = async (url, options) => {
  interceptedUrl = String(url)
  interceptedBody = String(options?.body ?? '')
  if (url === WORKSPACE_FILE_STAT_ROUTE) {
    return new Response(JSON.stringify({
      ok: true,
      value: { absolutePath: '/home/dm/repo/foo.txt', version: 'v1', bytes: 123 },
    }), { headers: { 'content-type': 'application/json' } })
  }
  if (url === WORKSPACE_FILE_READ_ROUTE) {
    return new Response(JSON.stringify({
      ok: true,
      value: {
        absolutePath: '/home/dm/repo/foo.txt',
        version: 'v1',
        bytes: 123,
        offset: 1,
        text: 'hello world',
        lines: 1,
        eof: true,
      },
    }), { headers: { 'content-type': 'application/json' } })
  }
  if (url === WORKSPACE_FILE_LIST_ROUTE) {
    return new Response(JSON.stringify({
      ok: true,
      value: {
        path: '',
        entries: [{ name: 'foo.txt', type: 'file', size: 123 }],
        truncated: false,
      },
    }), { headers: { 'content-type': 'application/json' } })
  }
  if (url === WORKSPACE_FILE_READ_BYTES_ROUTE) {
    // Send base64 "hello"
    const b64 = Buffer.from('hello').toString('base64')
    return new Response(JSON.stringify({
      ok: true,
      value: {
        absolutePath: '/home/dm/repo/foo.txt',
        version: 'v1',
        bytes: 5,
        offset: 0,
        dataBase64: b64,
        eof: true,
      },
    }), { headers: { 'content-type': 'application/json' } })
  }
  if (url === '/remote-ssh/sessions') {
    return new Response(JSON.stringify({
      workspaces: [
        {
          cwd: '/home/dm/repo',
          name: 'repo',
          sessions: [
            {
              sessionId: 'remote:dev:session-test-1',
              title: 'Test Session',
              running: false,
              blank: false,
              cwd: '/home/dm/repo',
              updatedAt: Date.now(),
            },
          ],
        },
      ],
      homes: [{ host: 'dev', home: '/home/dm' }],
    }), { headers: { 'content-type': 'application/json' } })
  }
  return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } })
}

let clientExports
globalThis.window = {
  __ModuleLoader__: {
    load: ({ id, factory }) => {
      clientExports = factory((name) => {
        if (name === '@deepseek-ai/cordis') return { Context, Service }
        return {}
      })
    },
  },
}
await import('./client.js')

try {
  assert.ok(
    clientExports.inject.includes('remote.workspaceFiles'),
    'client.js must inject "remote.workspaceFiles"',
  )

  const root = new Context()
  root.provide('remote')
  root.provide('remote.session')
  root.provide('remote.workspace')
  root.provide('fileUpload')
  root.provide('remote.commands')
  root.provide('remote.workspaceFiles')
  root.provide('workspaces')
  root.provide('sessions')

  const originalMethods = {
    stat: (...args) => ({ ok: true, value: { local: true, method: 'stat', args } }),
    read: (...args) => ({ ok: true, value: { local: true, method: 'read', args } }),
    readBytes: (...args) => ({ ok: true, value: { local: true, method: 'readBytes', args } }),
    list: (...args) => ({ ok: true, value: { local: true, method: 'list', args } }),
  }
  const wfTarget = { ...originalMethods }
  root.remote = {
    workspaceFiles: wfTarget,
    session: {},
    workspace: {},
    commands: {},
  }
  root['remote.workspaceFiles'] = wfTarget
  root.fileUpload = {}
  root.workspaces = {
    list: {
      items: [],
      removedIds: new Set(),
      upsertView: () => {},
      removeView: () => {},
    },
  }
  root.sessions = {
    handleSessionAdded: () => {},
    handleSessionRemoved: () => {},
  }

  const fork = root.plugin({
    name: 'test-wf',
    inject: clientExports.inject,
    apply: clientExports.apply,
  })

  // Let initial reconcile settle
  await new Promise((resolve) => setTimeout(resolve, 30))

  const wf = root['remote.workspaceFiles']
  assert.ok(wf, 'remote.workspaceFiles service should exist')

  // 1. Remote session stat
  const statRes = await wf.stat('remote:dev:session-test-1', 'foo.txt')
  assert.equal(interceptedUrl, WORKSPACE_FILE_STAT_ROUTE)
  assert.ok(statRes.ok)
  assert.equal(statRes.value.absolutePath, '/home/dm/repo/foo.txt')

  // 2. Remote session read
  const readRes = await wf.read('remote:dev:session-test-1', 'foo.txt', { offset: 1 })
  assert.equal(interceptedUrl, WORKSPACE_FILE_READ_ROUTE)
  assert.ok(readRes.ok)
  assert.equal(readRes.value.text, 'hello world')

  // 3. Remote session readBytes
  const rbRes = await wf.readBytes('remote:dev:session-test-1', 'foo.txt')
  assert.equal(interceptedUrl, WORKSPACE_FILE_READ_BYTES_ROUTE)
  assert.ok(rbRes.ok)
  assert.ok(rbRes.value.data instanceof Uint8Array)
  assert.equal(Buffer.from(rbRes.value.data).toString('utf8'), 'hello')

  // 4. Remote session list
  const listRes = await wf.list('remote:dev:session-test-1', '')
  assert.equal(interceptedUrl, WORKSPACE_FILE_LIST_ROUTE)
  assert.ok(listRes.ok)
  assert.equal(listRes.value.entries[0].name, 'foo.txt')

  // 5. Local session passthrough
  const localRes = await wf.stat('local-session-123', 'bar.txt')
  assert.equal(localRes.value.local, true, 'Local session stat should pass through to local service')

  console.log('workspaceFiles routes and client proxy assertions passed cleanly!')
  fork.dispose()
} finally {
  globalThis.fetch = originalFetch
}
