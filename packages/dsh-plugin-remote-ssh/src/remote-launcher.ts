/**
 * Remote DSH service detection and lifecycle launcher over SSH.
 * Probes whether `dsh web` is running on the target remote host,
 * automatically locates the `deepseek-harness` folder if dead,
 * and launches `dsh web` in the background with readiness verification.
 */

import { execFile } from 'node:child_process'

export type SshCommandRunner = (host: string, remoteScript: string) => Promise<string>

export interface RemoteLauncherOptions {
  /** Custom runner for executing remote commands over SSH, useful for testing. */
  runner?: SshCommandRunner
}

export interface EnsureServiceResult {
  readonly alreadyRunning: boolean
  readonly started: boolean
  readonly harnessPath?: string
}

export interface RemoteHomeDirectory {
  readonly name: string
  readonly path: string
}

function defaultSshRunner(host: string, remoteScript: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('ssh', ['-n', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, remoteScript], {
      maxBuffer: 64 * 1024,
      timeout: 30_000,
    }, (error, stdout) => {
      if (error !== null) reject(error)
      else resolve(stdout)
    })
  })
}

export class RemoteLauncher {
  private readonly runner: SshCommandRunner

  constructor(options: RemoteLauncherOptions = {}) {
    this.runner = options.runner ?? defaultSshRunner
  }

  /**
   * Check if DSH web service is actively running on the remote host and port.
   */
  async checkStatus(host: string, port = 3080): Promise<'alive' | 'dead'> {
    const probeScript = `
if ss -tuln "sport = :${port}" 2>/dev/null | grep -q "${port}" || \
   netstat -tuln 2>/dev/null | grep -q ":${port} " || \
   lsof -i :${port} -sTCP:LISTEN 2>/dev/null | grep -q ":${port}" || \
   curl -s -m 2 "http://127.0.0.1:${port}/" >/dev/null 2>&1; then
  echo "ALIVE"
else
  echo "DEAD"
fi
`.trim()

    try {
      const output = await this.runner(host, probeScript)
      return output.includes('ALIVE') ? 'alive' : 'dead'
    } catch {
      return 'dead'
    }
  }

  /** List immediate directories under the remote user's home directory. */
  async listHomeDirectories(host: string): Promise<RemoteHomeDirectory[]> {
    const output = await this.runner(host, `printf 'HOME=%s\\n' "$HOME"; find "$HOME" -mindepth 1 -maxdepth 1 -type d -printf '%f\\n' 2>/dev/null | sort`)
    const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    const home = lines.find((line) => line.startsWith('HOME='))?.slice(5) ?? '~'
    return lines.filter((name) => /^[A-Za-z0-9._-]+$/.test(name)).map((name) => ({
      name,
      path: `${home}/${name}`,
    }))
  }

  /** Resolve the remote user's home directory absolute path. */
  async homeDirectory(host: string): Promise<string> {
    const output = await this.runner(host, `printf '%s' "$HOME"`)
    const home = output.trim()
    if (!home) {
      throw new Error(`远端主机 "${host}" 无法解析 $HOME 目录。`)
    }
    return home
  }

  /** Create one immediate child directory under the remote user's home. */
  async createHomeDirectory(host: string, name: string): Promise<RemoteHomeDirectory> {
    const trimmed = name.trim()
    if (!/^[A-Za-z0-9._-]+$/.test(trimmed) || trimmed === '.' || trimmed === '..') {
      throw new Error('工作区名称只允许字母、数字、点、下划线和短横线。')
    }
    const output = await this.runner(host, `mkdir -p -- "$HOME/${trimmed}" && test -d "$HOME/${trimmed}" && printf READY`)
    if (!output.includes('READY')) throw new Error(`远端主机无法在 ~/ 下创建工作区 "${trimmed}"，请检查目录权限。`)
    return { name: trimmed, path: `$HOME/${trimmed}` }
  }


  async findHarnessPath(host: string): Promise<string> {
    const findScript = `
for p in \
  "$HOME/deepseek-harness" \
  "$HOME/work/deepseek-harness" \
  "$HOME/workspace/deepseek-harness" \
  "$HOME/code/deepseek-harness" \
  "$HOME/dev/deepseek-harness" \
  "$HOME/src/deepseek-harness" \
  "$HOME/projects/deepseek-harness" \
  "/data/deepseek-harness" \
  "/opt/deepseek-harness"; do
  if [ -d "$p" ] && ([ -f "$p/package.json" ] || [ -d "$p/packages" ] || [ -f "$p/pnpm-workspace.yaml" ]); then
    echo "$p"
    exit 0
  fi
done

FIND_DIR=$(find "$HOME" /data /opt -maxdepth 3 -type d -name "deepseek-harness" 2>/dev/null | head -n 1)
if [ -n "$FIND_DIR" ]; then
  echo "$FIND_DIR"
  exit 0
fi

WHICH_DSH=$(which dsh 2>/dev/null)
if [ -n "$WHICH_DSH" ]; then
  echo "BIN:$WHICH_DSH"
  exit 0
fi

echo "NOT_FOUND"
`.trim()

    const raw = await this.runner(host, findScript)
    const line = raw.trim().split('\n')[0]?.trim()
    if (!line || line === 'NOT_FOUND') {
      throw new Error(`未在远端主机 "${host}" 找到 deepseek-harness 文件夹或可执行的 dsh 二进制，无法自动启动 dsh web。请手动在远端启动该服务后再连接。`)
    }
    return line
  }

  /**
   * Ensure that the DSH web service is running on the remote host.
   * If not running, locates deepseek-harness and auto-launches `dsh web`.
   */
  async ensureService(host: string, port = 3080): Promise<EnsureServiceResult> {
    const status = await this.checkStatus(host, port)
    if (status === 'alive') {
      return { alreadyRunning: true, started: false }
    }

    const harnessTarget = await this.findHarnessPath(host)

    const isBin = harnessTarget.startsWith('BIN:')
    const launchScript = isBin
      ? `
nohup dsh web --port ${port} > /tmp/dsh-web.log 2>&1 &
for i in $(seq 1 15); do
  if ss -tuln "sport = :${port}" 2>/dev/null | grep -q "${port}" || \
     netstat -tuln 2>/dev/null | grep -q ":${port} " || \
     curl -s -m 1 "http://127.0.0.1:${port}/" >/dev/null 2>&1; then
    echo "READY"
    exit 0
  fi
  sleep 1
done
echo "TIMEOUT"
`.trim()
      : `
cd "${harnessTarget}" || exit 1
if [ -f "./bin/dsh" ]; then
  nohup ./bin/dsh web --port ${port} > /tmp/dsh-web.log 2>&1 &
elif which dsh >/dev/null 2>&1; then
  nohup dsh web --port ${port} > /tmp/dsh-web.log 2>&1 &
elif which pnpm >/dev/null 2>&1; then
  nohup pnpm dsh web --port ${port} > /tmp/dsh-web.log 2>&1 &
else
  nohup npm run dsh web --port ${port} > /tmp/dsh-web.log 2>&1 &
fi

for i in $(seq 1 15); do
  if ss -tuln "sport = :${port}" 2>/dev/null | grep -q "${port}" || \
     netstat -tuln 2>/dev/null | grep -q ":${port} " || \
     curl -s -m 1 "http://127.0.0.1:${port}/" >/dev/null 2>&1; then
    echo "READY"
    exit 0
  fi
  sleep 1
done
echo "TIMEOUT"
`.trim()

    const launchOutput = await this.runner(host, launchScript)
    if (!launchOutput.includes('READY')) {
      throw new Error(`在远端主机 "${host}" 启动 dsh web 超时或失败。输出: ${launchOutput.trim()}`)
    }

    return {
      alreadyRunning: false,
      started: true,
      harnessPath: isBin ? undefined : harnessTarget,
    }
  }
}
