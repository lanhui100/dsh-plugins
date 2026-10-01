import test from 'node:test'
import assert from 'node:assert/strict'
import {
  namespaceRemoteId,
  namespaceRemoteWorkspaceId,
  projectRemoteSourceSnapshot,
} from './src/source.ts'

test('namespaceRemoteId generates unique and unambiguous identities', () => {
  const id1 = namespaceRemoteId('dev', 'session-123')
  const id2 = namespaceRemoteId('dev', 'session/456')
  const id3 = namespaceRemoteId('prod', 'session-123')
  assert.equal(id1, 'remote:dev:session-123')
  assert.equal(id2, 'remote:dev:session%2F456')
  assert.equal(id3, 'remote:prod:session-123')
  assert.notEqual(id1, id3)
})

test('namespaceRemoteWorkspaceId namespaces synthetic workspace paths', () => {
  const wsId = namespaceRemoteWorkspaceId('dev', '/home/dm/ponyllm')
  assert.equal(wsId, 'remote:dev:workspace%3A%2Fhome%2Fdm%2Fponyllm')
})

test('projectRemoteSourceSnapshot correctly groups and projects remote sessions', () => {
  const items = [
    {
      sessionId: 's1',
      updatedAt: 1000,
      running: true,
      blank: false,
      cwd: '/workspace/a',
      title: 'Session 1',
    },
    {
      sessionId: 's2',
      updatedAt: 2000,
      running: false,
      blank: false,
      cwd: '/workspace/a',
      title: 'Session 2',
    },
    {
      sessionId: 's3',
      updatedAt: 1500,
      running: false,
      blank: false,
      cwd: '/workspace/b',
      title: 'Session 3',
    },
  ]

  const snapshot = projectRemoteSourceSnapshot('dev', items)
  assert.equal(snapshot.sourceId, 'dev')
  assert.equal(snapshot.status, 'ready')
  assert.equal(snapshot.total, 3)
  assert.equal(snapshot.workspaces.length, 2)

  // Workspace A has 2 sessions, so it leads
  const wsA = snapshot.workspaces[0]
  assert.equal(wsA.cwd, '/workspace/a')
  assert.equal(wsA.title, 'a')
  assert.deepEqual(wsA.sessionIds, [
    namespaceRemoteId('dev', 's2'),
    namespaceRemoteId('dev', 's1'),
  ])

  // Workspace B has 1 session
  const wsB = snapshot.workspaces[1]
  assert.equal(wsB.cwd, '/workspace/b')
  assert.equal(wsB.title, 'b')
  assert.deepEqual(wsB.sessionIds, [namespaceRemoteId('dev', 's3')])

  // Sessions list check
  assert.equal(snapshot.sessions.length, 3)
  assert.equal(snapshot.sessions[0].id, namespaceRemoteId('dev', 's1'))
  assert.equal(snapshot.sessions[0].remoteSessionId, 's1')
})
