/** SSH tunnel owner: one `ssh -L` child, readiness probe, backoff reconnect. */

import { spawn, type ChildProcess } from 'node:child_process'
import { createConnection } from 'node:net'

export interface TunnelOptions {
  /** OpenSSH host alias (user/key/known-hosts come from ssh config). */
  host: string
  /** Remote DSH web port on the far side of the tunnel. */
  remotePort: number
  /** Local loopback port the tunnel forwards to. */
  localPort: number
  /** Base delay between reconnect attempts after a loss (ms). */
  reconnectDelayMs?: number
  /** Upper bound for the exponential reconnect delay (ms). */
  reconnectMaxDelayMs?: number
  /** SSH ServerAliveInterval seconds (default 15). */
  serverAliveInterval?: number
  /** SSH ServerAliveCountMax (default 3). */
  serverAliveCountMax?: number
  /** SSH ConnectTimeout seconds (default 10). */
  connectTimeout?: number
  /** Pass -o TCPKeepAlive=yes when true. */
  tcpKeepAlive?: boolean
  /** Max stderr lines retained for diagnostics (default 64). */
  stderrMaxLines?: number
  /** Injectable RNG for deterministic backoff jitter in tests. */
  random?: () => number
}

const DEFAULT_RECONNECT_DELAY_MS = 5_000
const DEFAULT_RECONNECT_MAX_DELAY_MS = 60_000
const READY_TIMEOUT_MS = 90_000
const READY_POLL_MS = 1_000
const DEFAULT_STDERR_MAX_LINES = 64

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const done = (ok: boolean): void => {
      socket.destroy()
      resolve(ok)
    }
    socket.once('connect', () => { done(true) })
    socket.once('error', () => { done(false) })
    socket.setTimeout(2_000, () => { done(false) })
  })
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await portOpen(port)) return
    if (Date.now() >= deadline) {
      throw new Error(`remote-ssh: tunnel port 127.0.0.1:${String(port)} never opened`)
    }
    await new Promise((resolve) => { setTimeout(resolve, READY_POLL_MS) })
  }
}

/**
 * Own one SSH local-forward tunnel for the plugin lifetime.
 * Reconnects with backoff when the child dies; `dispose` stops everything.
 */
export class SshTunnel {
  private child: ChildProcess | undefined
  private closed = false
  private failures = 0
  private loop: Promise<void> | undefined
  private stderrLines: string[] = []
  private backoffTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly options: TunnelOptions) {}

  private readyResolve: (() => void) | undefined
  private readyReject: ((error: Error) => void) | undefined

  /** Retained stderr tail for diagnostics (most recent lines). */
  getStderr(): string {
    return this.stderrLines.join('\n')
  }

  private recordStderr(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    for (const line of text.split(/\r?\n/)) {
      if (line.length > 0) this.stderrLines.push(line)
    }
    const cap = this.options.stderrMaxLines ?? DEFAULT_STDERR_MAX_LINES
    if (this.stderrLines.length > cap) {
      this.stderrLines.splice(0, this.stderrLines.length - cap)
    }
  }

  /** Start the supervise loop; resolves once the first tunnel is ready. */
  async start(): Promise<void> {
    const ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    this.loop = this.supervise()
    await ready
  }

  /** Local base URL of the tunnel, e.g. `http://127.0.0.1:39387`. */
  baseUrl(): string {
    return `http://127.0.0.1:${String(this.options.localPort)}`
  }

  /** Stop the child and the supervise loop. */
  async dispose(): Promise<void> {
    this.closed = true
    if (this.backoffTimer !== undefined) {
      clearTimeout(this.backoffTimer)
      this.backoffTimer = undefined
    }
    this.child?.kill()
    this.child = undefined
    if (this.loop !== undefined) {
      await this.loop.catch(() => undefined)
      this.loop = undefined
    }
  }

  private async supervise(): Promise<void> {
    let first = true
    while (!this.closed) {
      try {
        await this.spawnOnce()
        this.failures = 0
        if (first) {
          first = false
          this.readyResolve?.()
          this.readyResolve = undefined
          this.readyReject = undefined
        }
        await this.watchChild()
      } catch (error) {
        if (this.closed) return
        if (first) {
          first = false
          const failure = error instanceof Error ? error : new Error(String(error))
          this.readyReject?.(failure)
          this.readyResolve = undefined
          this.readyReject = undefined
          return
        }
        this.failures += 1
      }
      if (this.closed) return
      const base = (this.options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS) * Math.pow(2, this.failures - 1)
      const cap = this.options.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS
      const jitter = this.options.random ?? Math.random
      const delay = Math.min(cap, Math.floor(jitter() * base))
      await new Promise<void>((resolve) => {
        this.backoffTimer = setTimeout(() => {
          this.backoffTimer = undefined
          resolve()
        }, delay)
      })
    }
  }

  private spawnOnce(): Promise<void> {
    const { host, remotePort, localPort } = this.options
    const connectTimeout = this.options.connectTimeout ?? 10
    const aliveInterval = this.options.serverAliveInterval ?? 15
    const aliveCountMax = this.options.serverAliveCountMax ?? 3
    return new Promise((resolve, reject) => {
      const args = [
        '-N',
        '-T',
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'BatchMode=yes',
        '-o', `ConnectTimeout=${String(connectTimeout)}`,
        '-o', `ServerAliveInterval=${String(aliveInterval)}`,
        '-o', `ServerAliveCountMax=${String(aliveCountMax)}`,
        ...(this.options.tcpKeepAlive === true ? ['-o', 'TCPKeepAlive=yes'] : []),
        '-L', `${String(localPort)}:127.0.0.1:${String(remotePort)}`,
        host,
      ]
      const child = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] })
      this.child = child
      this.stderrLines = []
      let settled = false
      const fail = (err: Error) => {
        if (settled) return
        settled = true
        reject(err)
      }
      const done = () => {
        if (settled) return
        settled = true
        resolve()
      }
      child.stderr?.on('data', (chunk) => {
        this.recordStderr(chunk)
        const tail = this.getStderr()
        if (/ExitOnForwardFailure|Address already in use|bind.*failed|cannot listen to port/i.test(tail)) {
          fail(new Error(`remote-ssh: ssh tunnel failed to bind localPort ${String(localPort)}: ${tail.trim().split('\n').pop() ?? 'unknown'}`))
        }
      })
      child.once('error', (error) => {
        if (this.child === child) this.child = undefined
        fail(error)
      })
      child.once('exit', (code) => {
        if (this.child === child) this.child = undefined
        fail(new Error(`remote-ssh: ssh tunnel exited early (code ${String(code ?? 'unknown')})`))
      })
      void waitForPort(localPort, READY_TIMEOUT_MS).then(() => {
        // Ready = child still alive AND stderr has no bind failure AND port is listening.
        if (child.exitCode !== null || child.signalCode !== null) {
          fail(new Error(`remote-ssh: ssh tunnel exited before ready (code ${String(child.exitCode ?? child.signalCode)})`))
          return
        }
        if (/ExitOnForwardFailure|Address already in use|bind.*failed|cannot listen to port/i.test(this.getStderr())) {
          fail(new Error(`remote-ssh: ssh tunnel bind failure on localPort ${String(localPort)}`))
          return
        }
        done()
      }, fail)
    })
  }

  private watchChild(): Promise<void> {
    const child = this.child
    if (child === undefined) return Promise.resolve()
    return new Promise((resolve, reject) => {
      child.once('close', (code) => {
        if (this.child === child) this.child = undefined
        if (this.closed) resolve()
        else reject(new Error(`remote-ssh: ssh tunnel closed (code ${String(code ?? 'unknown')})`))
      })
      child.once('error', (error: Error) => {
        if (this.child === child) this.child = undefined
        if (this.closed) resolve()
        else reject(error)
      })
    })
  }
}
