import assert from 'node:assert/strict'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseSshConfig, getAvailableSshHosts, resolveDefaultSshConfigPath } from './lib/ssh-config.js'

console.log('Testing parseSshConfig and getAvailableSshHosts...')

// 1. Resolve default path check
const defaultPath = resolveDefaultSshConfigPath()
assert.ok(typeof defaultPath === 'string' && defaultPath.length > 0, 'Default SSH config path must be non-empty')
assert.ok(defaultPath.endsWith(join('.ssh', 'config')), `Path should point to .ssh/config, got: ${defaultPath}`)

// 2. Mock SSH config text
const mockConfigText = `
# Global defaults
ServerAliveInterval 60

Host github.com
  HostName ssh.github.com
  Port 443
  User git
  IdentityFile ~/.ssh/id_ed25519

Host dev
  HostName devserver.internal.net
  Port 2022
  User dm
  IdentityFile ~/.ssh/id_rsa
  ServerAliveInterval 15

# Password-only host without identity file: must be excluded!
Host password-only
  HostName 1.2.3.4
  Port 22
  User admin

Host preprod
  hostname 100.97.143.121
  port 4022
  user dm
  identityfile "C:/mock-home/.ssh/id_rsa"
  LocalForward 9119 localhost:9119

# Wildcard entry: must be excluded!
Host *.internal
  User ubuntu
  IdentityFile ~/.ssh/wildcard.key

Host pro
  HostName proserver.internal.net
  Port 1022
  User dm
  IdentityFile ~/.ssh/id_rsa

Host *
  ServerAliveInterval 30
`

const tempFile = join(tmpdir(), `ssh-config-test-${Date.now()}.conf`)
writeFileSync(tempFile, mockConfigText, 'utf8')

try {
  const hosts = parseSshConfig(tempFile)

  // Assertions on parseSshConfig
  assert.equal(Array.isArray(hosts), true, 'parseSshConfig must return an array')

  const hostNames = hosts.map((h) => h.host)
  console.log('Parsed valid key-configured hosts:', hostNames)

  assert.ok(hostNames.includes('dev'), 'Must include dev')
  assert.ok(hostNames.includes('preprod'), 'Must include preprod')
  assert.ok(hostNames.includes('pro'), 'Must include pro')
  assert.equal(hostNames.includes('github.com'), false, 'Must EXCLUDE github.com from parsed remote hosts')

  assert.equal(hostNames.includes('password-only'), false, 'Must EXCLUDE password-only host without IdentityFile')
  assert.equal(hostNames.includes('*.internal'), false, 'Must EXCLUDE wildcard *.internal')
  assert.equal(hostNames.includes('*'), false, 'Must EXCLUDE wildcard *')

  const devEntry = hosts.find((h) => h.host === 'dev')
  assert.equal(devEntry.hostName, 'devserver.internal.net')
  assert.equal(devEntry.port, 2022)
  assert.equal(devEntry.user, 'dm')
  assert.equal(devEntry.identityFile, '~/.ssh/id_rsa')

  const preprodEntry = hosts.find((h) => h.host === 'preprod')
  assert.equal(preprodEntry.hostName, '100.97.143.121')
  assert.equal(preprodEntry.port, 4022)
  assert.equal(preprodEntry.user, 'dm')
  assert.equal(preprodEntry.identityFile, 'C:/mock-home/.ssh/id_rsa')

  // 3. Test getAvailableSshHosts (filtering already-added hosts and excluded service hosts like github)
  const currentAdded = ['dev']
  const available = getAvailableSshHosts({ sshConfigPath: tempFile, currentHosts: currentAdded })
  const availableNames = available.map((h) => h.host)
  console.log('Available unadded hosts:', availableNames)

  assert.equal(availableNames.includes('dev'), false, 'Must filter out already added host "dev"')
  assert.equal(availableNames.includes('github.com'), false, 'Must filter out github.com from available unadded hosts')
  assert.ok(availableNames.includes('preprod'), 'Must include unadded host "preprod"')
  assert.ok(availableNames.includes('pro'), 'Must include unadded host "pro"')

  console.log('all smoke-ssh-config assertions passed cleanly!')
} finally {
  try {
    unlinkSync(tempFile)
  } catch {}
}
