/**
 * Multi-host remote manager: manages SSH tunnels, callers, port allocations,
 * and session routing across multiple remote DSH instances.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { SshTunnel } from './tunnel.ts'
import { RemoteCaller } from './remote.ts'
import { REMOTE_SOURCE_KIND } from './source.ts'
import { RemoteLauncher } from './remote-launcher.ts'

export interface HostConfigItem {
  readonly host: string
  readonly remotePort: number
  readonly localPort: number
}

export interface RemoteHostManagerOptions {
  readonly primaryHost: string
  readonly primaryRemotePort: number
  readonly primaryLocalPort: number
  readonly storagePath?: string
  readonly launcher?: RemoteLauncher
  readonly onLoggerWarning?: (msg: string) => void
  readonly onLoggerInfo?: (msg: string) => void
}

export interface SessionTargetResolution {
  readonly host: string
  readonly originalSessionId: string
  readonly caller?: RemoteCaller
}

export interface ActiveHostEntry {
  readonly config: HostConfigItem
  tunnel?: SshTunnel
  caller?: RemoteCaller
  isReady: boolean
  isStarting: boolean
}

/** Resolve standard storage file path for dynamic host additions ($DSH_HOME/remote-ssh-hosts.json). */
export function resolveDefaultHostsStoragePath(): string {
  const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || homedir(), '.dsh')
  return join(dshHome, 'remote-ssh-hosts.json')
}

export class RemoteHostManager {
  private readonly storagePath: string
  private readonly launcher: RemoteLauncher
  private readonly entries = new Map<string, ActiveHostEntry>()
  private readonly loggerWarn: (msg: string) => void
  private readonly loggerInfo: (msg: string) => void

  constructor(options: RemoteHostManagerOptions) {
    this.storagePath = options.storagePath || resolveDefaultHostsStoragePath()
    this.launcher = options.launcher ?? new RemoteLauncher()
    this.loggerWarn = options.onLoggerWarning || console.warn
    this.loggerInfo = options.onLoggerInfo || console.info

    // 1. Register the primary host from plugin configuration
    this.entries.set(options.primaryHost, {
      config: {
        host: options.primaryHost,
        remotePort: options.primaryRemotePort,
        localPort: options.primaryLocalPort,
      },
      isReady: false,
      isStarting: false,
    })

    // 2. Load any extra dynamically added hosts from local persistent storage
    this.loadPersistedHosts()
  }

  /** Read-only list of all managed host aliases. */
  getHostNames(): string[] {
    return Array.from(this.entries.keys())
  }

  /** Get config for a specific host. */
  getHostConfig(host: string): HostConfigItem | undefined {
    return this.entries.get(host)?.config
  }

  /** Return all active host entries. */
  getAllEntries(): ReadonlyArray<ActiveHostEntry> {
    return Array.from(this.entries.values())
  }

  /** Return all callers that have successfully connected. */
  getReadyCallers(): Array<{ host: string; caller: RemoteCaller }> {
    const list: Array<{ host: string; caller: RemoteCaller }> = []
    for (const [host, entry] of this.entries.entries()) {
      if (entry.isReady && entry.caller) {
        list.push({ host, caller: entry.caller })
      }
    }
    return list
  }

  /** Find caller for a specific host. */
  getCallerForHost(host: string): RemoteCaller | undefined {
    const entry = this.entries.get(host)
    return entry?.isReady ? entry.caller : undefined
  }

  /**
   * Resolve a sessionId into target host, originalSessionId, and active caller.
   * Format: `remote:<encodedHost>:<encodedSessionId>`
   * Falls back to single host if no namespace is present.
   */
  resolveSessionTarget(sessionId: string): SessionTargetResolution | undefined {
    if (!sessionId || typeof sessionId !== 'string') return undefined

    if (sessionId.startsWith(`${REMOTE_SOURCE_KIND}:`)) {
      const parts = sessionId.split(':')
      if (parts.length >= 3) {
        const host = decodeURIComponent(parts[1])
        const originalSessionId = parts.slice(2).map(decodeURIComponent).join(':')
        const caller = this.getCallerForHost(host)
        return { host, originalSessionId, caller }
      }
    }

    // Fallback: if only one host is managed, route bare session ID to that host
    if (this.entries.size === 1) {
      const [singleHost, entry] = Array.from(this.entries.entries())[0]
      return {
        host: singleHost,
        originalSessionId: sessionId,
        caller: entry.isReady ? entry.caller : undefined,
      }
    }

    // When multiple hosts exist, check if any caller has this session
    for (const [host, entry] of this.entries.entries()) {
      if (entry.isReady && entry.caller) {
        return { host, originalSessionId: sessionId, caller: entry.caller }
      }
    }

    return undefined
  }

  /** Allocate the next unused local port (starts from highest localPort + 1). */
  allocateLocalPort(): number {
    let maxPort = 39386
    for (const entry of this.entries.values()) {
      if (entry.config.localPort > maxPort) {
        maxPort = entry.config.localPort
      }
    }
    return maxPort + 1
  }

  /**
   * Register a host in the in-memory map and persist to disk (does not start tunnel yet).
   * Useful for sync configuration and testing.
   */
  registerConfiguredHost(config: HostConfigItem): ActiveHostEntry {
    let entry = this.entries.get(config.host)
    if (!entry) {
      entry = {
        config,
        isReady: false,
        isStarting: false,
      }
      this.entries.set(config.host, entry)
      this.savePersistedHosts()
    }
    return entry
  }

  /**
   * Start tunnel and caller for a given entry.
   */
  async startHost(host: string): Promise<RemoteCaller> {
    const entry = this.entries.get(host)
    if (!entry) {
      throw new Error(`Host "${host}" is not registered in RemoteHostManager.`)
    }
    if (entry.isReady && entry.caller) {
      return entry.caller
    }

    const { config } = entry

    // 1. Ensure remote DSH service is active, auto-launching if needed
    try {
      this.loggerInfo(`remote-ssh: [${config.host}] verifying remote dsh service status...`)
      const launchRes = await this.launcher.ensureService(config.host, config.remotePort)
      if (launchRes.started) {
        this.loggerInfo(`remote-ssh: [${config.host}] dsh web was not running; auto-launched service (${launchRes.harnessPath ? `in ${launchRes.harnessPath}` : 'via PATH'})`)
      }
    } catch (launchErr) {
      this.loggerWarn(`remote-ssh: [${config.host}] remote service auto-start probe noticed: ${launchErr instanceof Error ? launchErr.message : String(launchErr)}`)
      if (launchErr instanceof Error && launchErr.message.includes('未在远端主机')) {
        throw launchErr
      }
    }

    const tunnel = new SshTunnel({
      host: config.host,
      remotePort: config.remotePort,
      localPort: config.localPort,
    })
    const caller = new RemoteCaller({
      host: config.host,
      baseUrl: tunnel.baseUrl(),
    })

    entry.tunnel = tunnel
    entry.caller = caller
    entry.isStarting = true

    try {
      await tunnel.start()
      entry.isReady = true
      entry.isStarting = false

      void caller.warmup().catch((error: unknown) => {
        this.loggerWarn(`remote-ssh: [${config.host}] cookie warmup failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      this.loggerInfo(`remote-ssh: [${config.host}] tunnel ready (${config.host} -> ${tunnel.baseUrl()})`)
      return caller
    } catch (err) {
      entry.isStarting = false
      entry.isReady = false
      throw err
    }
  }

  /**
   * Dynamically add a new remote host, allocate port, start tunnel, and persist.
   */
  async addHost(hostName: string, remotePort = 3080): Promise<{ host: string; caller: RemoteCaller; localPort: number }> {
    const trimmed = hostName.trim()
    if (!trimmed) throw new Error('Host name cannot be empty.')

    if (this.entries.has(trimmed)) {
      const existing = this.entries.get(trimmed)!
      if (existing.isReady && existing.caller) {
        return { host: trimmed, caller: existing.caller, localPort: existing.config.localPort }
      }
      const caller = await this.startHost(trimmed)
      return { host: trimmed, caller, localPort: existing.config.localPort }
    }

    const localPort = this.allocateLocalPort()
    const config: HostConfigItem = {
      host: trimmed,
      remotePort,
      localPort,
    }

    this.registerConfiguredHost(config)
    const caller = await this.startHost(trimmed)
    return { host: trimmed, caller, localPort }
  }

  /** Start all registered hosts in parallel. */
  async startAll(): Promise<void> {
    const promises: Promise<unknown>[] = []
    for (const host of this.entries.keys()) {
      promises.push(this.startHost(host).catch((err) => {
        this.loggerWarn(`remote-ssh: failed to start host "${host}": ${err instanceof Error ? err.message : String(err)}`)
      }))
    }
    await Promise.all(promises)
  }

  /** Dispose all active callers and tunnels. */
  async dispose(): Promise<void> {
    const promises: Promise<unknown>[] = []
    for (const entry of this.entries.values()) {
      entry.isReady = false
      if (entry.caller) {
        try { entry.caller.dispose() } catch {}
      }
      if (entry.tunnel) {
        promises.push(entry.tunnel.dispose().catch(() => {}))
      }
    }
    await Promise.all(promises)
  }

  /** Load persisted hosts from storage file. */
  private loadPersistedHosts(): void {
    if (!existsSync(this.storagePath)) return
    try {
      const content = readFileSync(this.storagePath, 'utf8')
      const parsed = JSON.parse(content)
      if (Array.isArray(parsed?.hosts)) {
        for (const item of parsed.hosts) {
          if (item && typeof item.host === 'string' && typeof item.localPort === 'number') {
            if (!this.entries.has(item.host)) {
              this.entries.set(item.host, {
                config: {
                  host: item.host,
                  remotePort: typeof item.remotePort === 'number' ? item.remotePort : 3080,
                  localPort: item.localPort,
                },
                isReady: false,
                isStarting: false,
              })
            }
          }
        }
      }
    } catch (err) {
      this.loggerWarn(`remote-ssh: failed to load persisted hosts from ${this.storagePath}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Save registered extra hosts to storage file. */
  private savePersistedHosts(): void {
    try {
      const dir = dirname(this.storagePath)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      // Save all hosts except primary if needed, or save all
      const list: HostConfigItem[] = []
      for (const entry of this.entries.values()) {
        list.push(entry.config)
      }
      writeFileSync(this.storagePath, JSON.stringify({ hosts: list }, null, 2), 'utf8')
    } catch (err) {
      this.loggerWarn(`remote-ssh: failed to save persisted hosts to ${this.storagePath}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
