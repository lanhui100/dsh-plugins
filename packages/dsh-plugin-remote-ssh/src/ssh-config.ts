/**
 * OpenSSH client configuration (~/.ssh/config) parser and discovery helper.
 * Filters host entries that have explicit IdentityFile (key-based auth) configured,
 * enabling safe discovery of remote hosts ready for passwordless SSH tunnels.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface SshHostInfo {
  /** The Host alias configured in ~/.ssh/config (e.g. "dev", "preprod"). */
  host: string
  /** The destination HostName (domain or IP), if configured. */
  hostName?: string
  /** Destination port, defaults to 22 if not specified. */
  port?: number
  /** SSH login username, if configured. */
  user?: string
  /** Resolved path to the private key (IdentityFile). */
  identityFile?: string
}

export interface GetAvailableHostsOptions {
  /** Override path to ssh config for testing or custom environments. */
  sshConfigPath?: string
  /** Currently added/active host aliases to be excluded. */
  currentHosts?: readonly string[]
}

/** Resolve the standard path to user's OpenSSH config file. */
export function resolveDefaultSshConfigPath(): string {
  const home = process.env.USERPROFILE || process.env.HOME || homedir()
  return join(home, '.ssh', 'config')
}

/**
 * Parse an OpenSSH configuration file and extract all non-wildcard host blocks
 * that have an explicit IdentityFile specified (ready for key-based authentication).
 */
export function parseSshConfig(filePath?: string): SshHostInfo[] {
  const targetPath = filePath || resolveDefaultSshConfigPath()
  if (!existsSync(targetPath)) {
    return []
  }

  let content = ''
  try {
    content = readFileSync(targetPath, 'utf8')
  } catch {
    return []
  }

  const lines = content.split(/\r?\n/)
  const results: SshHostInfo[] = []

  interface ParsingHostBlock {
    aliases: string[]
    hostName?: string
    port?: number
    user?: string
    identityFile?: string
  }

  let currentBlock: ParsingHostBlock | null = null

  function flushBlock() {
    if (!currentBlock) return
    // Only accept blocks that have an explicit IdentityFile configured
    if (currentBlock.identityFile && currentBlock.identityFile.trim() !== '') {
      for (const alias of currentBlock.aliases) {
        // Exclude wildcard patterns
        if (alias.includes('*') || alias.includes('?')) {
          continue
        }
        results.push({
          host: alias,
          hostName: currentBlock.hostName,
          port: currentBlock.port,
          user: currentBlock.user,
          identityFile: currentBlock.identityFile,
        })
      }
    }
    currentBlock = null
  }

  for (let rawLine of lines) {
    // Strip inline comments if preceded by whitespace
    const commentIdx = rawLine.indexOf('#')
    let line = commentIdx !== -1 ? rawLine.slice(0, commentIdx) : rawLine
    line = line.trim()
    if (!line) continue

    // OpenSSH supports space or '=' as delimiter
    const parts = line.split(/[=\s]+/).filter(Boolean)
    if (parts.length < 2) continue

    const keyword = parts[0].toLowerCase()
    const value = parts.slice(1).join(' ').trim().replace(/^["']|["']$/g, '')

    if (keyword === 'host') {
      flushBlock()
      const aliases = parts.slice(1).map((s) => s.replace(/^["']|["']$/g, '').trim()).filter(Boolean)
      currentBlock = { aliases }
    } else if (currentBlock) {
      if (keyword === 'hostname') {
        currentBlock.hostName = value
      } else if (keyword === 'port') {
        const p = parseInt(value, 10)
        if (!isNaN(p) && p > 0) {
          currentBlock.port = p
        }
      } else if (keyword === 'user') {
        currentBlock.user = value
      } else if (keyword === 'identityfile') {
        // Keep the first identity file if multiple are declared
        if (!currentBlock.identityFile) {
          currentBlock.identityFile = value
        }
      }
    }
  }

  flushBlock()
  return results
}

/**
 * Query available SSH hosts from local SSH config, filtering out hosts that
 * have already been added to the plugin.
 */
export function getAvailableSshHosts(options?: GetAvailableHostsOptions): SshHostInfo[] {
  const allHosts = parseSshConfig(options?.sshConfigPath)
  const existingSet = new Set((options?.currentHosts || []).map((h) => h.toLowerCase().trim()))

  return allHosts.filter((item) => !existingSet.has(item.host.toLowerCase().trim()))
}
