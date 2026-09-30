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
  /** Delay between reconnect attempts after a loss (ms). */
  reconnectDelayMs?: number
}

const DEFAULT_RECONNECT_DELAY_MS = 5_000
const READY_TIMEOUT_MS = 90_000
const READY_POLL_MS = 1_000

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

  constructor(private readonly options: TunnelOptions) {}

  private readyResolve: (() => void) | undefined
  private readyReject: ((error: Error) => void) | undefined

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
      const delay = (this.options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS) * this.failures
      await new Promise((resolve) => { setTimeout(resolve, Math.min(delay, 60_000)) })
    }
  }

  private spawnOnce(): Promise<void> {
    const { host, remotePort, localPort } = this.options
    return new Promise((resolve, reject) => {
      const child = spawn('ssh', [
        '-N',
        '-T',
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'BatchMode=yes',
        '-o', 'ServerAliveInterval=15',
        '-o', 'ServerAliveCountMax=3',
        '-L', `${String(localPort)}:127.0.0.1:${String(remotePort)}`,
        host,
      ], { stdio: ['ignore', 'ignore', 'pipe'] })
      this.child = child
      child.stderr?.resume()
      child.once('error', (error) => {
        if (this.child === child) this.child = undefined
        reject(error)
      })
      void waitForPort(localPort, READY_TIMEOUT_MS).then(resolve, reject)
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
