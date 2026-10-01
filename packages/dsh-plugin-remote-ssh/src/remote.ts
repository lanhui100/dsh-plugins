/** Remote DSH caller through the SSH tunnel: token exchange, cookies, RPC envelopes. */

import { execFile } from 'node:child_process'

export interface RemoteOptions {
  /** OpenSSH host alias used for reading the remote launch token. */
  host: string
  /** Tunnel-local base URL, e.g. `http://127.0.0.1:39387`. */
  baseUrl: string
  /** Remote path of the dsh web log carrying the `?token=` URL. */
  logPath?: string
  /** Deadline for one RPC/token-exchange attempt (ms). Defaults to 30 s. */
  requestTimeoutMs?: number
}

const DEFAULT_LOG_PATH = '/tmp/dsh-web.log'
const TOKEN_PATTERN = /\?token=([A-Za-z0-9_-]+)/

interface RpcEnvelope {
  readonly type: string
  readonly rpcId: string
  readonly result?: { readonly ok: boolean; readonly value?: unknown; readonly error?: { readonly code: string; readonly message: string } }
}

function runSsh(host: string, remoteScript: string): Promise<string> {
  // Single-arg form: ssh joins the trailing args into one remote command
  // string that the far-side shell parses (pipes included). Splitting into
  // ['sh', '-c', script] breaks this: the pipe would bind outside -c.
  // -n redirects stdin from /dev/null, preventing Windows OpenSSH from blocking.
  return new Promise((resolve, reject) => {
    execFile('ssh', ['-n', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, remoteScript], {
      maxBuffer: 64 * 1024, timeout: 20_000,
    }, (error, stdout) => {
      if (error !== null) reject(error)
      else resolve(stdout)
    })
  })
}

/**
 * Read the remote launch token from the dsh web startup log over SSH.
 * The token is process-scoped and rotates on every remote restart.
 */
export async function readLaunchToken(host: string, logPath: string = DEFAULT_LOG_PATH): Promise<string> {
  const script = `grep -o "?token=[A-Za-z0-9_-]*" ${logPath} | head -1`
  const output = await runSsh(host, script)
  const match = TOKEN_PATTERN.exec(output.trim())
  if (match?.[1] === undefined) {
    throw new Error('remote-ssh: no launch token found in remote dsh web log')
  }
  return match[1]
}

/** Minimal cookie jar: one tunnel authority, session cookies only. */
class CookieJar {
  private cookies = new Map<string, string>()

  store(setCookie: string[] | undefined): void {
    if (setCookie === undefined) return
    for (const header of setCookie) {
      const pair = header.split(';', 1)[0]
      if (pair === undefined) continue
      const at = pair.indexOf('=')
      if (at === -1) continue
      this.cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim())
    }
  }

  header(): string | undefined {
    if (this.cookies.size === 0) return undefined
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  clear(): void {
    this.cookies.clear()
  }
}

/**
 * Authenticated caller for one remote DSH over the tunnel.
 * Exchanges the launch token for a cookie on demand and re-exchanges on 401
 * (the remote token rotates whenever its service restarts).
 */
export class RemoteCaller {
  private readonly jar = new CookieJar()
  private exchanging: Promise<void> | undefined

  constructor(private readonly options: RemoteOptions) {}

  private timeoutSignal(signal?: AbortSignal): AbortSignal {
    const deadline = AbortSignal.timeout(this.options.requestTimeoutMs ?? 30_000)
    return signal === undefined ? deadline : AbortSignal.any([signal, deadline])
  }

  /**
   * Warm the session cookie ahead of any command: read the launch token and
   * exchange it now, so the first user invocation skips the (slow) SSH +
   * token round-trip. Idempotent; a failure only leaves the jar empty and the
   * next invoke retries the exchange.
   */
  async warmup(): Promise<void> {
    try {
      await this.ensureCookie()
    } catch (error) {
      this.jar.clear()
      throw error
    }
  }

  /**
   * Invoke one remote RPC endpoint, e.g. `session/list` with `{ _request: {} }`.
   * @param endpoint - canonical `<namespace>/<method>` endpoint.
   * @param args - plain-object args payload (exactly one `args` field on the wire).
   * @param signal - optional caller cancellation (aborts fetch).
   * @returns the endpoint's success value, or throws its gateway error.
   */
  async invoke<T>(endpoint: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    try {
      return await this.callOnce<T>(endpoint, args, signal)
    } catch (error) {
      if (error instanceof RemoteAuthError) {
        this.jar.clear()
        await this.ensureCookie()
        return await this.callOnce<T>(endpoint, args, signal)
      }
      throw error
    }
  }

  private async callOnce<T>(endpoint: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    await this.ensureCookie()
    const rpcId = `remote-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(16)}`
    const cookie = this.jar.header()
    const response = await fetch(`${this.options.baseUrl}/api/${endpoint}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
      signal: this.timeoutSignal(signal),
    })
    if (response.status === 401) {
      throw new RemoteAuthError('remote-ssh: remote rejected the session cookie')
    }
    if (!response.ok) {
      throw new Error(`remote-ssh: transport failure for ${endpoint}: HTTP ${String(response.status)}`)
    }
    const envelope = (await response.json()) as RpcEnvelope
    if (envelope.rpcId !== rpcId) {
      throw new Error(`remote-ssh: rpcId mismatch for ${endpoint}`)
    }
    const result = envelope.result
    if (result === undefined || result.ok !== true) {
      const detail = result?.error
      throw new Error(`remote-ssh: ${endpoint} failed (${detail?.code ?? 'unknown'}): ${detail?.message ?? 'no message'}`)
    }
    return result.value as T
  }

  private ensureCookie(): Promise<void> {
    if (this.jar.header() !== undefined) return Promise.resolve()
    this.exchanging ??= this.exchange().finally(() => { this.exchanging = undefined })
    return this.exchanging
  }

  private async exchange(): Promise<void> {
    const token = await readLaunchToken(this.options.host, this.options.logPath ?? DEFAULT_LOG_PATH)
    const response = await fetch(`${this.options.baseUrl}/?token=${token}`, {
      method: 'GET',
      redirect: 'manual',
      signal: this.timeoutSignal(),
    })
    if (response.status !== 303 && response.status !== 302) {
      throw new RemoteAuthError(`remote-ssh: token exchange rejected (HTTP ${String(response.status)})`)
    }
    const setCookie = response.headers.getSetCookie?.() ?? undefined
    this.jar.store(setCookie)
    if (this.jar.header() === undefined) {
      const single = response.headers.get('set-cookie')
      this.jar.store(single === null ? undefined : [single])
    }
    if (this.jar.header() === undefined) {
      throw new RemoteAuthError('remote-ssh: token exchange set no cookie')
    }
  }

  private cachedBaseline?: { data: RemoteWorkspaceBaseline; expiresAt: number }

  /**
   * Fetch the authoritative workspace baseline (active workspaces, archived sessions, pinned sessions)
   * from the remote DSH via the WebSocket multiplexer. Results are cached for 30 seconds.
   */
  async fetchWorkspaceBaseline(signal?: AbortSignal): Promise<RemoteWorkspaceBaseline> {
    if (this.cachedBaseline !== undefined && Date.now() < this.cachedBaseline.expiresAt) {
      return this.cachedBaseline.data
    }

    await this.ensureCookie()
    const cookie = this.jar.header()
    const wsUrl = `${this.options.baseUrl.replace(/^http/, 'ws')}/api/remote.mux`
    const WS = (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket
    if (typeof WS !== 'function') {
      throw new Error('remote-ssh: WebSocket is not supported in the current Node environment')
    }

    const baseline = await new Promise<RemoteWorkspaceBaseline>((resolve, reject) => {
      const streamId = `wbf-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(16)}`
      const socket = new WS(wsUrl, {
        headers: cookie !== undefined ? { cookie } : {},
      } as unknown as string[])

      let settled = false
      const timeoutId = setTimeout(() => {
        finish(new Error('remote-ssh: timed out waiting for workspace baseline'))
      }, 15_000)

      const onAbort = () => {
        finish(new Error('remote-ssh: workspace baseline request aborted'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      function finish(error?: Error, result?: RemoteWorkspaceBaseline) {
        if (settled) return
        settled = true
        clearTimeout(timeoutId)
        signal?.removeEventListener('abort', onAbort)
        try {
          socket.close()
        } catch {
          // ignore close error
        }
        if (error !== undefined) reject(error)
        else if (result !== undefined) resolve(result)
        else reject(new Error('remote-ssh: unexpected stream settlement without data'))
      }

      socket.onopen = () => {
        try {
          socket.send(JSON.stringify({
            type: 'open',
            streamId,
            endpoint: 'workspace/follow',
            payload: { args: {} },
          }))
        } catch (err) {
          finish(err instanceof Error ? err : new Error(String(err)))
        }
      }

      socket.onmessage = (event) => {
        try {
          const raw = typeof event.data === 'string' ? event.data : event.data?.toString()
          if (!raw) return
          const message = JSON.parse(raw) as {
            type?: string
            streamId?: string
            error?: { message?: string }
            value?: {
              type?: string
              value?: {
                items?: readonly unknown[]
                archivedSessionIds?: readonly unknown[]
                pinnedSessionIds?: readonly unknown[]
              }
            }
          }

          if (message.type === 'error' && message.streamId === streamId) {
            finish(new Error(`remote-ssh: workspace/follow stream error: ${message.error?.message ?? 'unknown'}`))
            return
          }

          if (message.type === 'item' && message.streamId === streamId && message.value?.type === 'baseline') {
            const val = message.value.value
            const items: RemoteWorkspaceBaselineItem[] = Array.isArray(val?.items)
              ? val.items.map((it: any) => ({
                workspaceId: String(it.workspaceId),
                path: String(it.path),
                title: String(it.title ?? ''),
                sessionIds: Array.isArray(it.sessionIds) ? it.sessionIds.map(String) : [],
                createdAt: String(it.createdAt ?? ''),
                updatedAt: String(it.updatedAt ?? ''),
              }))
              : []
            const archivedSessionIds: string[] = Array.isArray(val?.archivedSessionIds)
              ? val.archivedSessionIds.map(String)
              : []
            const pinnedSessionIds: string[] = Array.isArray(val?.pinnedSessionIds)
              ? val.pinnedSessionIds.map(String)
              : []

            finish(undefined, { items, archivedSessionIds, pinnedSessionIds })
          }
        } catch (err) {
          finish(err instanceof Error ? err : new Error(String(err)))
        }
      }

      socket.onerror = (err) => {
        finish(new Error(`remote-ssh: WebSocket error connecting to remote.mux: ${String(err)}`))
      }

      socket.onclose = () => {
        if (!settled) {
          finish(new Error('remote-ssh: WebSocket closed before baseline was received'))
        }
      }
    })

    this.cachedBaseline = {
      data: baseline,
      expiresAt: Date.now() + 30_000,
    }
    return baseline
  }

  /**
   * Relay the remote `session/follow` multiplexed WebSocket stream into an async iterable of wire frames.
   * Emits snapshot, delta events, and assistant stream frames in real time.
   */
  async *followSession(
    request: {
      address: unknown
      assistantStream?: boolean
    },
    signal?: AbortSignal,
  ): AsyncIterable<unknown> {
    await this.ensureCookie()
    const cookie = this.jar.header()
    const wsUrl = `${this.options.baseUrl.replace(/^http/, 'ws')}/api/remote.mux`
    const WS = (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket
    if (typeof WS !== 'function') {
      throw new Error('remote-ssh: WebSocket is not supported in the current Node environment')
    }

    const streamId = `sf-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(16)}`
    const socket = new WS(wsUrl, {
      headers: cookie !== undefined ? { cookie } : {},
    } as unknown as string[])

    const queue: unknown[] = []
    let notify: (() => void) | null = null
    let ended = false
    let failure: Error | null = null

    const push = (item: unknown) => {
      queue.push(item)
      if (notify !== null) {
        const n = notify
        notify = null
        n()
      }
    }

    const terminate = (err: Error | null) => {
      if (ended) return
      ended = true
      failure = err
      if (notify !== null) {
        const n = notify
        notify = null
        n()
      }
      try {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify({ type: 'cancel', streamId }))
        }
      } catch {
        // ignore send error on closing
      }
      try {
        socket.close()
      } catch {
        // ignore close error
      }
    }

    socket.onopen = () => {
      try {
        socket.send(JSON.stringify({
          type: 'open',
          streamId,
          endpoint: 'session/follow',
          payload: { args: { request } },
        }))
      } catch (err) {
        terminate(err instanceof Error ? err : new Error(String(err)))
      }
    }

    socket.onmessage = (event) => {
      try {
        const raw = typeof event.data === 'string' ? event.data : event.data?.toString()
        if (!raw) return
        const msg = JSON.parse(raw) as {
          type?: string
          streamId?: string
          error?: { message?: string }
          value?: unknown
        }
        if (msg.streamId !== streamId) return
        if (msg.type === 'item') {
          push(msg.value)
        } else if (msg.type === 'error') {
          terminate(new Error(msg.error?.message ?? 'Remote follow stream error'))
        } else if (msg.type === 'done') {
          terminate(null)
        }
      } catch (err) {
        terminate(err instanceof Error ? err : new Error(String(err)))
      }
    }

    socket.onerror = (err) => {
      terminate(new Error(`remote-ssh: WebSocket error connecting to remote.mux: ${String(err)}`))
    }

    socket.onclose = () => {
      terminate(null)
    }

    const onAbort = () => terminate(new Error('remote-ssh: follow stream aborted'))
    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()
          continue
        }
        if (ended) {
          if (failure !== null && !(signal?.aborted)) throw failure
          break
        }
        await new Promise<void>((resolve) => { notify = resolve })
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      terminate(null)
    }
  }
}

export interface RemoteWorkspaceBaselineItem {
  readonly workspaceId: string
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
}

export interface RemoteWorkspaceBaseline {
  readonly items: readonly RemoteWorkspaceBaselineItem[]
  readonly archivedSessionIds: readonly string[]
  readonly pinnedSessionIds: readonly string[]
}

export class RemoteAuthError extends Error {}
