/**
 * Multi-host remote manager: manages SSH tunnels, callers, port allocations,
 * and session routing across multiple remote DSH instances.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { createServer } from 'node:net'
import { SshTunnel, type TunnelOptions } from './tunnel.ts'
import { RemoteCaller, type RemoteOptions } from './remote.ts'
import { REMOTE_SOURCE_KIND } from './source.ts'
import { RemoteLauncher } from './remote-launcher.ts'

export interface HostConfigItem {
  readonly host: string
  readonly remotePort: number
  readonly localPort: number
  readonly reconnectDelayMs?: number
  readonly reconnectMaxDelayMs?: number
  readonly serverAliveInterval?: number
  readonly serverAliveCountMax?: number
  readonly connectTimeout?: number
  readonly tcpKeepAlive?: boolean
}

export interface RemoteHostManagerOptions {
  /** Optional host alias registered at startup. Omit to start with no hosts (all hosts are added dynamically). */
  readonly primaryHost?: string
  readonly primaryRemotePort: number
  readonly primaryLocalPort: number
  readonly reconnectDelayMs?: number
  readonly reconnectMaxDelayMs?: number
  readonly serverAliveInterval?: number
  readonly serverAliveCountMax?: number
  readonly connectTimeout?: number
  readonly tcpKeepAlive?: boolean
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
  /** True when this session auto-launched `dsh web` on the remote host. */
  autoStarted?: boolean
  /** Remote harness folder used for the auto-launch, when known. */
  harnessPath?: string
  /** Cached remote user home directory absolute path. */
  homeDirectory?: string
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
  /** In-flight startHost promises per host, so concurrent starts merge into one tunnel. */
  private readonly startPromises = new Map<string, Promise<RemoteCaller>>()
  private readonly loggerWarn: (msg: string) => void
  private readonly loggerInfo: (msg: string) => void
  private readonly options: RemoteHostManagerOptions

  constructor(options: RemoteHostManagerOptions) {
    this.options = options
    this.storagePath = options.storagePath || resolveDefaultHostsStoragePath()
    this.launcher = options.launcher ?? new RemoteLauncher()
    this.loggerWarn = options.onLoggerWarning || console.warn
    this.loggerInfo = options.onLoggerInfo || console.info

    // 1. Register the primary host from plugin configuration, when one is given.
    //    With no configured host, the manager starts empty: hosts are added
    //    dynamically through POST /remote-ssh/add-host and restored from disk.
    if (options.primaryHost && options.primaryHost.trim() !== '') {
      this.entries.set(options.primaryHost, {
        config: {
          host: options.primaryHost,
          remotePort: options.primaryRemotePort,
          localPort: options.primaryLocalPort,
          reconnectDelayMs: options.reconnectDelayMs,
          reconnectMaxDelayMs: options.reconnectMaxDelayMs,
          serverAliveInterval: options.serverAliveInterval,
          serverAliveCountMax: options.serverAliveCountMax,
          connectTimeout: options.connectTimeout,
          tcpKeepAlive: options.tcpKeepAlive,
        },
        isReady: false,
        isStarting: false,
      })
    }

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

  /** List remote user's home directories for workspace selection. */
  async listHomeDirectories(host: string) {
    const entry = this.entries.get(host)
    if (!entry) throw new Error(`Host "${host}" is not registered in RemoteHostManager.`)
    return this.launcher.listHomeDirectories(host)
  }

  /** Create one remote user's home directory for a workspace and register it into remote DSH. */
  async createHomeDirectory(host: string, name: string) {
    const entry = this.entries.get(host)
    if (!entry) throw new Error(`Host "${host}" is not registered in RemoteHostManager.`)
    const dir = await this.launcher.createHomeDirectory(host, name)
    let workspace: { workspaceId: string; path: string; title: string } | undefined
    // Register the created directory into remote DSH via workspace/create
    if (entry.caller) {
      try {
        workspace = await entry.caller.createWorkspace(dir.path)
      } catch (err) {
        console.warn(`remote-ssh: [${host}] createWorkspace failed for "${dir.path}":`, err)
      }
    }
    return { ...dir, workspace }
  }

  /** Register an existing remote directory as a workspace in remote DSH. */
  async registerWorkspace(host: string, path: string) {
    const entry = this.entries.get(host)
    if (!entry) throw new Error(`Host "${host}" is not registered in RemoteHostManager.`)
    if (entry.caller) {
      return entry.caller.createWorkspace(path)
    }
    throw new Error(`Host "${host}" caller is not available.`)
  }

  /** Resolve a remote host's user home directory absolute path (cached in memory). */
  async getHomeDirectory(host: string): Promise<string> {
    const entry = this.entries.get(host)
    if (!entry) throw new Error(`Host "${host}" is not registered in RemoteHostManager.`)
    if (entry.homeDirectory) {
      return entry.homeDirectory
    }
    const resolved = await this.launcher.homeDirectory(host)
    if (resolved) {
      entry.homeDirectory = resolved
    }
    return resolved
  }


  /** Check if a local port is currently available by attempting to bind to it. */
  async isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = createServer()
      server.once('error', () => {
        resolve(false)
      })
      server.once('listening', () => {
        server.close(() => {
          resolve(true)
        })
      })
      server.listen(port, '127.0.0.1')
    })
  }

  /**
   * Allocate next local port (synchronous calculation based on registered entries).
   * Preserves backward compatibility with existing tests and callers.
   */
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
   * Find next free local port by scanning from allocateLocalPort()
   * and validating availability against the operating system.
   */
  async findAvailableLocalPort(): Promise<number> {
    let candidate = this.allocateLocalPort()
    for (let attempts = 0; attempts < 50; attempts++) {
      const free = await this.isPortAvailable(candidate)
      if (free) return candidate
      candidate += 1
    }
    return candidate
  }

  /**
   * Register a host in the in-memory map (optionally persist to disk).
   * Useful for sync configuration and testing. `addHost` passes
   * `{ persist: false }` and only persists after a successful start, so a
   * failed first connect never leaves an unrecoverable tombstone entry.
   */
  registerConfiguredHost(config: HostConfigItem, options?: { persist?: boolean }): ActiveHostEntry {
    let entry = this.entries.get(config.host)
    if (!entry) {
      entry = {
        config,
        isReady: false,
        isStarting: false,
      }
      this.entries.set(config.host, entry)
      if (options?.persist !== false) {
        this.savePersistedHosts()
      }
    }
    return entry
  }

  /**
   * Start tunnel and caller for a given entry.
   * Concurrent callers for the same host share one in-flight start promise, so
   * `startAll()` at boot and an immediate user re-add cannot race two tunnels
   * onto the same local port or clobber each other's entry.caller.
   */
  async startHost(host: string): Promise<RemoteCaller> {
    const entry = this.entries.get(host)
    if (!entry) {
      throw new Error(`Host "${host}" is not registered in RemoteHostManager.`)
    }
    if (entry.isReady && entry.caller) {
      return entry.caller
    }
    const inFlight = this.startPromises.get(host)
    if (inFlight) return inFlight
    const promise = this.doStartHost(entry).finally(() => {
      this.startPromises.delete(host)
    })
    this.startPromises.set(host, promise)
    return promise
  }

  private async doStartHost(entry: ActiveHostEntry): Promise<RemoteCaller> {
    const { config } = entry

    // If an existing tunnel is already running or reconnecting in background,
    // dispose it before spawning a fresh one to avoid port collision.
    if (entry.tunnel) {
      await entry.tunnel.dispose().catch(() => {})
      entry.tunnel = undefined
    }

    // The remote DSH process is a prerequisite, not something this plugin owns.
    // Probe it before opening a tunnel and fail closed when it is unavailable.
    try {
      this.loggerInfo(`remote-ssh: [${config.host}] verifying remote dsh service status...`)
      const status = await this.launcher.checkStatus(config.host, config.remotePort)
      if (status !== 'alive') {
        throw new Error(`远端主机 "${config.host}" 的 dsh 服务未启动（端口 ${String(config.remotePort)} 无可用服务），已禁止连接。请先在远端启动 dsh web 后重试。`)
      }
      entry.autoStarted = false
      entry.harnessPath = undefined
    } catch (probeErr) {
      entry.autoStarted = false
      entry.harnessPath = undefined
      throw probeErr instanceof Error ? probeErr : new Error(String(probeErr))
    }

    // Verify port availability
    const portFree = await this.isPortAvailable(config.localPort)
    if (!portFree) {
      throw new Error(`本地端口 127.0.0.1:${String(config.localPort)} 已被其它进程占用，无法为主机 "${config.host}" 建立 SSH 隧道。`)
    }

    let callerRef: RemoteCaller | undefined

    const tunnel = new SshTunnel({
      host: config.host,
      remotePort: config.remotePort,
      localPort: config.localPort,
      reconnectDelayMs: config.reconnectDelayMs,
      reconnectMaxDelayMs: config.reconnectMaxDelayMs,
      serverAliveInterval: config.serverAliveInterval,
      serverAliveCountMax: config.serverAliveCountMax,
      connectTimeout: config.connectTimeout,
      tcpKeepAlive: config.tcpKeepAlive,
      onReady: () => {
        entry.isReady = true
        callerRef?.onTunnelReady()
      },
      onDown: () => {
        entry.isReady = false
        callerRef?.onTunnelDown()
      },
    })
    const caller = new RemoteCaller({
      host: config.host,
      baseUrl: tunnel.baseUrl(),
      isTunnelReady: () => entry.isReady,
      eventsReconnectBaseMs: 2_000,
      eventsReconnectMaxDelayMs: 30_000,
    })
    callerRef = caller

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
  async addHost(
    hostName: string,
    remotePort = 3080,
  ): Promise<{ host: string; caller: RemoteCaller; localPort: number; autoStarted?: boolean; harnessPath?: string }> {
    const trimmed = hostName.trim()
    if (!trimmed) throw new Error('Host name cannot be empty.')

    if (this.entries.has(trimmed)) {
      const existing = this.entries.get(trimmed)!
      if (existing.isReady && existing.caller) {
        // Already connected: this action did not start anything on the remote.
        return {
          host: trimmed,
          caller: existing.caller,
          localPort: existing.config.localPort,
          autoStarted: false,
          harnessPath: undefined,
        }
      }
      const caller = await this.startHost(trimmed)
      return {
        host: trimmed,
        caller,
        localPort: existing.config.localPort,
        autoStarted: existing.autoStarted,
        harnessPath: existing.harnessPath,
      }
    }

    const localPort = await this.findAvailableLocalPort()
    const config: HostConfigItem = {
      host: trimmed,
      remotePort,
      localPort,
      reconnectDelayMs: this.options.reconnectDelayMs,
      reconnectMaxDelayMs: this.options.reconnectMaxDelayMs,
      serverAliveInterval: this.options.serverAliveInterval,
      serverAliveCountMax: this.options.serverAliveCountMax,
      connectTimeout: this.options.connectTimeout,
      tcpKeepAlive: this.options.tcpKeepAlive,
    }

    // Register in memory first without persisting: only a successful connect
    // earns a disk entry. A failed first connect is removed below so the host
    // stays available for retry instead of becoming a UI-unreachable tombstone.
    this.registerConfiguredHost(config, { persist: false })
    try {
      const caller = await this.startHost(trimmed)
      this.savePersistedHosts()
      const entry = this.entries.get(trimmed)!
      return {
        host: trimmed,
        caller,
        localPort,
        autoStarted: entry.autoStarted,
        harnessPath: entry.harnessPath,
      }
    } catch (err) {
      this.entries.delete(trimmed)
      throw err
    }
  }

  /**
   * Disconnect and fully remove a host: disposes its tunnel/caller, drops the
   * in-memory entry and persists the registry, so the host returns to the
   * "available" list for reconnection. A config-provided (primary) host is
   * re-registered from plugin config on the next startup.
   * @throws when the host is unknown or a start is still in flight for it.
   */
  removeHost(hostName: string): void {
    const trimmed = hostName.trim()
    const entry = this.entries.get(trimmed)
    if (!entry) {
      throw new Error(`Host "${trimmed}" is not registered in RemoteHostManager.`)
    }
    if (this.startPromises.has(trimmed)) {
      throw new Error(`Host "${trimmed}" is still connecting; retry once the connection settles.`)
    }
    entry.isReady = false
    entry.isStarting = false
    try {
      entry.caller?.dispose()
    } catch {}
    if (entry.tunnel) {
      void entry.tunnel.dispose().catch(() => {})
    }
    this.entries.delete(trimmed)
    this.savePersistedHosts()
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
