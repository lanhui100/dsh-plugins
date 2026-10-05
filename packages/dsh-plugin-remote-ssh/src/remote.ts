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
  /** Gate: only (re)open the $events socket while the tunnel is alive. */
  isTunnelReady?: () => boolean
  /** Base delay for $events reconnect backoff (ms). Defaults to 2000. */
  eventsReconnectBaseMs?: number
  /** Cap for $events reconnect delay (ms). Defaults to 30000. */
  eventsReconnectMaxDelayMs?: number
  /** Injectable RNG for deterministic reconnect jitter in tests. */
  random?: () => number
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
  private eventsSocket?: WebSocket
  private currentClientId?: string
  private readonly pendingInteractions = new Map<string, RemotePendingInteraction>()
  private readonly interactionListeners = new Set<(interaction: RemotePendingInteraction, action: 'request' | 'cancel') => void>()
  private eventsDisposed = false
  private eventsFailures = 0
  private eventsReconnectTimer?: ReturnType<typeof setTimeout>
  private tunnelPaused = false

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
      void this.ensureEventsListener().catch((err) => {
        console.warn('remote-ssh: events listener warmup notice:', err)
      })
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
      expiresAt: Date.now() + 45_000,
    }
    return baseline
  }

  /**
   * Create or adopt one remote workspace directory under the remote user's home.
   * Invokes the official workspace controller's `workspace/create` over the remote carrier.
   */
  async createWorkspace(path: string): Promise<{ workspaceId: string; path: string; title: string }> {
    const res = await this.invoke<{ workspace?: { workspaceId: string; path: string; title: string } }>(
      'workspace/create',
      { request: { path } },
    )
    if (res && res.workspace) {
      if (this.cachedBaseline) {
        this.cachedBaseline = undefined
      }
      return res.workspace
    }
    throw new Error('remote-ssh: workspace/create returned without workspace entity')
  }

  /** Invalidate cached workspace baseline so subsequent queries fetch fresh data. */
  clearBaselineCache(): void {
    this.cachedBaseline = undefined
  }

  /**
   * Delete one remote workspace from the authoritative remote DSH registry.
   */
  async deleteWorkspace(workspaceId: string): Promise<boolean> {
    const res = await this.invoke<{ deleted?: boolean }>(
      'workspace/delete',
      { request: { workspaceId } },
    )
    this.clearBaselineCache()
    return Boolean(res?.deleted)
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
    if (signal?.aborted) onAbort()

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

  /**
   * Ensure that the long-lived subscription to the remote `$events` stream is open.
   * Discovers and maintains `currentClientId`, and captures incoming `waterfall` events
   * like `user-questions/request` and `cancel`.
   */
  /**
   * Called when underlying SSH tunnel becomes ready.
   * Immediately resets $events backoff and triggers reconnect.
   */
  onTunnelReady(): void {
    this.tunnelPaused = false
    this.eventsFailures = 0
    if (this.eventsReconnectTimer !== undefined) {
      clearTimeout(this.eventsReconnectTimer)
      this.eventsReconnectTimer = undefined
    }
    if (!this.eventsDisposed) {
      void this.ensureEventsListener().catch(() => {})
    }
  }

  /**
   * Called when underlying SSH tunnel goes down.
   * Pauses $events reconnect loop to avoid wasteful probe storm.
   */
  onTunnelDown(): void {
    this.tunnelPaused = true
    this.eventsConnecting = undefined
    if (this.eventsReconnectTimer !== undefined) {
      clearTimeout(this.eventsReconnectTimer)
      this.eventsReconnectTimer = undefined
    }
    if (this.eventsSocket) {
      try { this.eventsSocket.close() } catch {}
      this.eventsSocket = undefined
    }
    // Clear cookie cache so next connect re-exchanges token in case remote restarted
    this.jar.clear()
  }

  private eventsConnecting?: Promise<void>

  async ensureEventsListener(): Promise<void> {
    if (this.eventsDisposed) return
    if (this.tunnelPaused) return
    if (this.options.isTunnelReady && !this.options.isTunnelReady()) return

    if (this.eventsConnecting) {
      return this.eventsConnecting
    }

    this.eventsConnecting = this.doEnsureEventsListener().finally(() => {
      this.eventsConnecting = undefined
    })
    return this.eventsConnecting
  }

  private async doEnsureEventsListener(): Promise<void> {
    if (this.eventsDisposed || this.tunnelPaused) return
    if (this.options.isTunnelReady && !this.options.isTunnelReady()) return

    const WS = (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket
    if (typeof WS !== 'function') return
    if (this.eventsSocket && (this.eventsSocket.readyState === 0 || this.eventsSocket.readyState === 1)) {
      return
    }

    try {
      await this.ensureCookie()
    } catch {
      this.scheduleEventsReconnect()
      return
    }
    if (this.eventsDisposed || this.tunnelPaused) return

    const cookie = this.jar.header()
    const wsUrl = `${this.options.baseUrl.replace(/^http/, 'ws')}/api/remote.mux`

    const streamId = `events-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(16)}`
    let socket: WebSocket
    try {
      socket = new WS(wsUrl, {
        headers: cookie !== undefined ? { cookie } : {},
      } as unknown as string[])
    } catch {
      this.scheduleEventsReconnect()
      return
    }
    this.eventsSocket = socket

    socket.onopen = () => {
      this.eventsFailures = 0
      try {
        socket.send(JSON.stringify({
          type: 'open',
          streamId,
          endpoint: '$events',
          payload: { args: {} },
        }))
      } catch (err) {
        console.warn('remote-ssh: failed to send open for $events stream:', err)
      }
    }

    socket.onmessage = (event) => {
      try {
        const raw = typeof event.data === 'string' ? event.data : event.data?.toString()
        if (!raw) return
        const msg = JSON.parse(raw) as {
          type?: string
          streamId?: string
          value?: any
        }
        if (msg.streamId !== streamId) return
        if (msg.type === 'item') {
          const val = msg.value
          if (val?.type === 'ready') {
            this.currentClientId = val.clientId
            // Re-bind existing non-mock pending interactions with the new clientId
            for (const [eventId, item] of this.pendingInteractions.entries()) {
              if (!item.clientId.startsWith('mock-')) {
                this.pendingInteractions.set(eventId, { ...item, clientId: val.clientId })
              }
            }
          } else if (val?.type === 'waterfall' && val.event === 'user-questions/request') {
            const rawReq = val.request || {}
            const questions: RemoteInteractionQuestionItem[] = Array.isArray(rawReq.questions)
              ? rawReq.questions
              : []
            const pending: RemotePendingInteraction = {
              clientId: this.currentClientId ?? '',
              eventId: String(val.eventId),
              sessionId: String(val.agentId),
              event: String(val.event),
              questions,
              rawRequest: rawReq,
              createdAt: Date.now(),
            }
            this.pendingInteractions.set(pending.eventId, pending)
            for (const listener of this.interactionListeners) {
              try { listener(pending, 'request') } catch {}
            }
          } else if (val?.type === 'cancel') {
            const eventId = String(val.eventId)
            const pending = this.pendingInteractions.get(eventId)
            if (pending) {
              this.pendingInteractions.delete(eventId)
              for (const listener of this.interactionListeners) {
                try { listener(pending, 'cancel') } catch {}
              }
            }
          }
        }
      } catch (err) {
        console.warn('remote-ssh: $events parse error:', err)
      }
    }

    socket.onclose = () => {
      if (this.eventsSocket === socket) {
        this.eventsSocket = undefined
      }
      this.scheduleEventsReconnect()
    }

    socket.onerror = () => {
      try { socket.close() } catch {}
    }
  }

  private scheduleEventsReconnect(): void {
    if (this.eventsDisposed || this.tunnelPaused) return
    if (this.options.isTunnelReady && !this.options.isTunnelReady()) return
    if (this.eventsReconnectTimer !== undefined) return

    this.eventsFailures += 1
    const base = (this.options.eventsReconnectBaseMs ?? 2_000) * Math.pow(2, this.eventsFailures - 1)
    const cap = this.options.eventsReconnectMaxDelayMs ?? 30_000
    const minDelay = 1_000
    const jitter = this.options.random ?? Math.random
    const delay = Math.min(cap, Math.max(minDelay, Math.floor(jitter() * base)))

    this.eventsReconnectTimer = setTimeout(() => {
      this.eventsReconnectTimer = undefined
      void this.ensureEventsListener().catch(() => {})
    }, delay)
  }

  getPendingInteractionsForSession(sessionId: string): RemotePendingInteraction[] {
    const list: RemotePendingInteraction[] = []
    for (const item of this.pendingInteractions.values()) {
      if (item.sessionId === sessionId) list.push(item)
    }
    return list
  }

  getPendingInteraction(eventId: string): RemotePendingInteraction | undefined {
    return this.pendingInteractions.get(eventId)
  }

  getAllPendingInteractions(): RemotePendingInteraction[] {
    return [...this.pendingInteractions.values()]
  }

  onInteraction(listener: (interaction: RemotePendingInteraction, action: 'request' | 'cancel') => void): () => void {
    this.interactionListeners.add(listener)
    return () => { this.interactionListeners.delete(listener) }
  }

  recordMockInteraction(interaction: RemotePendingInteraction): void {
    this.pendingInteractions.set(interaction.eventId, interaction)
    for (const listener of this.interactionListeners) {
      try { listener(interaction, 'request') } catch {}
    }
  }

  removeMockInteraction(eventId: string): void {
    const pending = this.pendingInteractions.get(eventId)
    if (pending) {
      this.pendingInteractions.delete(eventId)
      for (const listener of this.interactionListeners) {
        try { listener(pending, 'cancel') } catch {}
      }
    }
  }

  async respondRemoteEvent(
    clientId: string,
    eventId: string,
    outcome:
      | { kind: 'result'; value?: unknown }
      | { kind: 'rejected'; error: { name: string; message: string; code?: string } }
      | { kind: 'next' },
  ): Promise<unknown> {
    const effectiveClientId = clientId || this.pendingInteractions.get(eventId)?.clientId || this.currentClientId || ''
    let result: unknown = { accepted: true }
    try {
      if (!effectiveClientId.startsWith('mock-')) {
        result = await this.invoke<unknown>('$events/result', {
          clientId: effectiveClientId,
          eventId,
          outcome,
        })
      }
      return result
    } finally {
      // Regardless of success or failure (e.g. 400 not-found when stale),
      // dismiss the pending interaction so it does not become a ghost card.
      const pending = this.pendingInteractions.get(eventId)
      if (pending) {
        this.pendingInteractions.delete(eventId)
        for (const listener of this.interactionListeners) {
          try { listener(pending, 'cancel') } catch {}
        }
      }
    }
  }

  dispose(): void {
    this.eventsDisposed = true
    if (this.eventsReconnectTimer !== undefined) {
      clearTimeout(this.eventsReconnectTimer)
      this.eventsReconnectTimer = undefined
    }
    if (this.eventsSocket) {
      try { this.eventsSocket.close() } catch {}
      this.eventsSocket = undefined
    }
    this.pendingInteractions.clear()
    this.interactionListeners.clear()
  }

  async archiveRemoteSession(
    sessionId: string,
    options: { readonly stopActivity?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<{ readonly archivedSessionIds: readonly string[] }> {
    const result = await this.invoke<{ readonly archivedSessionIds: readonly string[] }>(
      'workspace/archiveSession',
      {
        request: {
          sessionId,
          ...(options.stopActivity === true ? { stopActivity: true } : {}),
        },
      },
      signal,
    )
    if (this.cachedBaseline) {
      this.cachedBaseline = undefined
    }
    return result
  }

  async unarchiveRemoteSession(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<{ readonly archivedSessionIds: readonly string[] }> {
    const result = await this.invoke<{ readonly archivedSessionIds: readonly string[] }>(
      'workspace/unarchiveSession',
      { request: { sessionId } },
      signal,
    )
    if (this.cachedBaseline) {
      this.cachedBaseline = undefined
    }
    return result
  }

  async pinRemoteSession(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<{ readonly pinnedSessionIds: readonly string[] }> {
    const result = await this.invoke<{ readonly pinnedSessionIds: readonly string[] }>(
      'workspace/pinSession',
      { request: { sessionId } },
      signal,
    )
    if (this.cachedBaseline) {
      this.cachedBaseline = undefined
    }
    return result
  }

  async unpinRemoteSession(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<{ readonly pinnedSessionIds: readonly string[] }> {
    const result = await this.invoke<{ readonly pinnedSessionIds: readonly string[] }>(
      'workspace/unpinSession',
      { request: { sessionId } },
      signal,
    )
    if (this.cachedBaseline) {
      this.cachedBaseline = undefined
    }
    return result
  }

  async renameRemoteSession(
    sessionId: string,
    title: string,
    signal?: AbortSignal,
  ): Promise<{ readonly title: string; readonly seq: number }> {
    return await this.invoke<{ readonly title: string; readonly seq: number }>(
      'session/rename',
      { request: { sessionId, title } },
      signal,
    )
  }

  async selectRemoteSessionModel(
    sessionId: string,
    provider: string,
    model: string,
    reasoningEffort?: string,
    signal?: AbortSignal,
  ): Promise<{ readonly selected: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string } }> {
    return await this.invoke<{ readonly selected: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string } }>(
      'session/selectModel',
      {
        request: {
          sessionId,
          provider,
          model,
          ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
        },
      },
      signal,
    )
  }

  /**
   * Read one durable image attachment referenced by a remote session.
   * @param sessionId - remote session identity.
   * @param attachmentId - opaque attachment id found in the session log.
   * @param signal - optional caller cancellation.
   */
  async readRemoteAttachment(
    sessionId: string,
    attachmentId: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly attachment: { readonly attachmentId: string; readonly mediaType: string; readonly name?: string }
    readonly data: string
  }> {
    return await this.invoke<{
      readonly attachment: { readonly attachmentId: string; readonly mediaType: string; readonly name?: string }
      readonly data: string
    }>('session/attachment', { request: { sessionId, attachmentId } }, signal)
  }

  /**
   * Upload one base64-encoded file into a remote session for prompt staging.
   * @param sessionId - remote session identity (Agent scope on the wire).
   * @param request - canonical base64 payload and optional display name.
   * @param signal - optional caller cancellation.
   */
  async uploadRemoteFile(
    sessionId: string,
    request: { readonly data: string; readonly name?: string },
    signal?: AbortSignal,
  ): Promise<{
    readonly receiptId: string
    readonly file: { readonly attachmentId: string; readonly name: string; readonly bytes: number }
  }> {
    return await this.invoke<{
      readonly receiptId: string
      readonly file: { readonly attachmentId: string; readonly name: string; readonly bytes: number }
    }>('fileUploads/upload', { agentId: sessionId, request }, signal)
  }

  /**
   * List available commands for an agent session from the remote host.
   * @param sessionId - remote session identity.
   * @param signal - optional caller cancellation.
   */
  async listRemoteCommands(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<readonly unknown[]> {
    return await this.invoke<readonly unknown[]>('commands/list', { agentId: sessionId }, signal)
  }

  /**
   * Execute one slash-command in a remote session.
   * @param sessionId - remote session identity.
   * @param line - full command invocation line.
   * @param submittedAttachments - optional attachments supplied with the command.
   * @param signal - optional caller cancellation.
   */
  async executeRemoteCommand(
    sessionId: string,
    line: string,
    submittedAttachments: readonly unknown[] = [],
    signal?: AbortSignal,
  ): Promise<unknown> {
    return await this.invoke<unknown>(
      'commands/execute',
      { agentId: sessionId, line, submittedAttachments },
      signal,
    )
  }

  /**
   * Stat a workspace file via remote DSH `workspaceFiles/stat`.
   */
  async statRemoteWorkspaceFile(
    sessionId: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<{ absolutePath: string; version: string; bytes?: number }> {
    return await this.invoke<{ absolutePath: string; version: string; bytes?: number }>(
      'workspaceFiles/stat',
      { workspaceFileScopeId: sessionId, path },
      signal,
    )
  }

  /**
   * Read lines from a text workspace file via remote DSH `workspaceFiles/read`.
   */
  async readRemoteWorkspaceFile(
    sessionId: string,
    path: string,
    range?: { offset?: number; limit?: number },
    signal?: AbortSignal,
  ): Promise<{
    absolutePath: string
    version: string
    bytes?: number
    offset: number
    text: string
    lines: number
    eof: boolean
  }> {
    return await this.invoke<{
      absolutePath: string
      version: string
      bytes?: number
      offset: number
      text: string
      lines: number
      eof: boolean
    }>(
      'workspaceFiles/read',
      { workspaceFileScopeId: sessionId, path, range: range ?? {} },
      signal,
    )
  }

  /**
   * List directory children in a remote workspace via `workspaceFiles/list`.
   */
  async listRemoteWorkspaceDirectory(
    sessionId: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<{
    path: string
    entries: readonly { name: string; type: 'file' | 'directory' | 'other'; size?: number }[]
    truncated: boolean
  }> {
    return await this.invoke<{
      path: string
      entries: readonly { name: string; type: 'file' | 'directory' | 'other'; size?: number }[]
      truncated: boolean
    }>(
      'workspaceFiles/list',
      { workspaceFileScopeId: sessionId, path: path || '.' },
      signal,
    )
  }

  /**
   * Read raw bytes (or range) from a remote workspace file via `workspaceFiles/readBytes`.
   * Unpacks multipart response if binary attachment is returned.
   */
  async readRemoteWorkspaceFileBytes(
    sessionId: string,
    path: string,
    options?: { range?: { offset?: number; length?: number }; baseFile?: string },
    signal?: AbortSignal,
  ): Promise<{
    absolutePath: string
    version: string
    bytes?: number
    offset: number
    data: Uint8Array
    eof: boolean
  }> {
    await this.ensureCookie()
    const rpcId = `remote-rb-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(16)}`
    const cookie = this.jar.header()
    const response = await fetch(`${this.options.baseUrl}/api/workspaceFiles/readBytes`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: JSON.stringify({
        type: 'client-request',
        rpcId,
        method: 'workspaceFiles/readBytes',
        payload: { args: { workspaceFileScopeId: sessionId, path, options: options ?? {} } },
      }),
      signal: this.timeoutSignal(signal),
    })

    if (response.status === 401) {
      this.jar.clear()
      await this.ensureCookie()
      return await this.readRemoteWorkspaceFileBytes(sessionId, path, options, signal)
    }

    if (!response.ok) {
      throw new Error(`remote-ssh: transport failure for workspaceFiles/readBytes: HTTP ${String(response.status)}`)
    }

    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('multipart/form-data')) {
      const formData = await response.formData()
      const metadataStr = formData.get('metadata')
      if (typeof metadataStr !== 'string') {
        throw new Error('remote-ssh: readBytes multipart missing metadata part')
      }
      const envelope = JSON.parse(metadataStr) as {
        result?: {
          ok: boolean
          value?: {
            absolutePath: string
            version: string
            bytes?: number
            offset: number
            data?: unknown
            eof: boolean
          }
          error?: { code: string; message: string }
        }
        attachments?: readonly { path: readonly string[]; part: string }[]
      }
      if (!envelope.result?.ok || !envelope.result.value) {
        throw new Error(`remote-ssh: readBytes failed: ${envelope.result?.error?.message ?? 'unknown'}`)
      }
      const val = envelope.result.value
      let bytes = new Uint8Array(0)
      const partKey = envelope.attachments?.[0]?.part ?? 'bytes-0'
      const blob = formData.get(partKey)
      if (blob && typeof blob === 'object' && 'arrayBuffer' in blob) {
        const ab = await (blob as Blob).arrayBuffer()
        bytes = new Uint8Array(ab)
      }
      return {
        absolutePath: val.absolutePath,
        version: val.version,
        bytes: val.bytes,
        offset: val.offset,
        data: bytes,
        eof: val.eof,
      }
    }

    const envelope = (await response.json()) as RpcEnvelope
    if (!envelope.result?.ok || !envelope.result.value) {
      throw new Error(`remote-ssh: readBytes failed: ${envelope.result?.error?.message ?? 'unknown'}`)
    }
    const val = envelope.result.value as {
      absolutePath: string
      version: string
      bytes?: number
      offset: number
      data?: Uint8Array | Record<string, number>
      eof: boolean
    }
    let dataBytes: Uint8Array
    if (val.data instanceof Uint8Array) {
      dataBytes = val.data
    } else if (val.data && typeof val.data === 'object') {
      const keys = Object.keys(val.data)
      const arr = new Uint8Array(keys.length)
      for (let i = 0; i < keys.length; i++) {
        arr[i] = (val.data as Record<string, number>)[i]
      }
      dataBytes = arr
    } else {
      dataBytes = new Uint8Array(0)
    }
    return {
      absolutePath: val.absolutePath,
      version: val.version,
      bytes: val.bytes,
      offset: val.offset,
      data: dataBytes,
      eof: val.eof,
    }
  }
}

export interface RemoteInteractionQuestionOption {
  readonly label: string
  readonly description?: string
}

export interface RemoteInteractionQuestionItem {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly header?: string
  readonly options?: readonly RemoteInteractionQuestionOption[]
  readonly multiSelect?: boolean
  readonly intent?: { readonly kind: string; readonly approve?: string; readonly callId?: string }
}

export interface RemotePendingInteraction {
  readonly clientId: string
  readonly eventId: string
  readonly sessionId: string
  readonly event: string
  readonly questions: readonly RemoteInteractionQuestionItem[]
  readonly rawRequest?: Record<string, unknown>
  readonly createdAt: number
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
