/**
 * Smoke test for RemoteLauncher:
 * Verifies probe of remote dsh service status, locating deepseek-harness,
 * auto-starting dsh web if dead, and returning success or descriptive errors.
 */

import assert from 'node:assert/strict'
import { RemoteLauncher } from './lib/remote-launcher.js'

console.log('Testing RemoteLauncher probe and auto-start logic...')

// Test 1: Service is already alive
{
  const commandsRun = []
  const launcher = new RemoteLauncher({
    runner: async (host, script) => {
      commandsRun.push({ host, script })
      if (script.includes('ALIVE')) {
        return 'ALIVE\n'
      }
      return ''
    },
  })

  const status = await launcher.checkStatus('dev-host', 3080)
  assert.equal(status, 'alive', 'Should report alive when remote responds ALIVE')
  
  const result = await launcher.ensureService('dev-host', 3080)
  assert.equal(result.alreadyRunning, true)
  assert.equal(result.started, false)
  console.log('Test 1 (already alive) passed.')
}

// Test 2: Service is dead, locates deepseek-harness and auto-starts
{
  let serviceStarted = false
  const commandsRun = []
  const launcher = new RemoteLauncher({
    runner: async (host, script) => {
      commandsRun.push(script)
      if (script.includes('ALIVE')) {
        return serviceStarted ? 'ALIVE\n' : 'DEAD\n'
      }
      if (script.includes('nohup')) {
        serviceStarted = true
        return 'READY\n'
      }
      if (script.includes('NOT_FOUND') || script.includes('FIND_DIR')) {
        return '/home/ubuntu/deepseek-harness\n'
      }
      return ''
    },
  })

  const status = await launcher.checkStatus('preprod-host', 3080)
  assert.equal(status, 'dead', 'Should report dead before starting')

  const result = await launcher.ensureService('preprod-host', 3080)
  assert.equal(result.alreadyRunning, false)
  assert.equal(result.started, true)
  assert.equal(result.harnessPath, '/home/ubuntu/deepseek-harness')
  console.log('Test 2 (dead -> locate harness -> start) passed.')
}

// Test 3: Service is dead, and deepseek-harness cannot be found
{
  const launcher = new RemoteLauncher({
    runner: async (host, script) => {
      if (script.includes('ALIVE')) return 'DEAD\n'
      if (script.includes('NOT_FOUND') || script.includes('FIND_DIR')) return 'NOT_FOUND\n'
      return ''
    },
  })

  await assert.rejects(
    launcher.ensureService('unknown-host', 3080),
    /未在远端主机.*找到 deepseek-harness 文件夹/i,
    'Should throw clear error when deepseek-harness folder cannot be found',
  )
  console.log('Test 3 (dead -> harness not found error) passed.')
}

console.log('all smoke-launcher assertions passed cleanly!')
