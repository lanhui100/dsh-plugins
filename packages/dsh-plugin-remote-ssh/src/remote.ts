/** Remote DSH caller through the SSH tunnel: token exchange, cookies, RPC envelopes. */

import { execFile } from 'node:child_process'

export interface RemoteOptions {
  /** OpenSSH host alias used for reading the remote launch token. */
  host: string
  /** Tunnel-local base URL, e.g. `http://127.0.0.1:39387`. */
  baseUrl: string
  /** Remote path of the dsh web log carrying the `?token=` URL. */
  logPath?: string
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
  return new Promise((resolve, reject) => {
    execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host, remoteScript], {
      maxBuffer: 64 * 1024, timeout: 60_000,
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

  /**
   * Invoke one remote RPC endpoint, e.g. `session/list` with `{ _request: {} }`.
   * @param endpoint - canonical `<namespace>/<method>` endpoint.
   * @param args - plain-object args payload (exactly one `args` field on the wire).
   * @returns the endpoint's success value, or throws its gateway error.
   */
  async invoke<T>(endpoint: string, args: Record<string, unknown> = {}): Promise<T> {
    try {
      return await this.callOnce<T>(endpoint, args)
    } catch (error) {
      if (error instanceof RemoteAuthError) {
        this.jar.clear()
        await this.ensureCookie()
        return await this.callOnce<T>(endpoint, args)
      }
      throw error
    }
  }

  private async callOnce<T>(endpoint: string, args: Record<string, unknown>): Promise<T> {
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
}

export class RemoteAuthError extends Error {}
