/**
 * Browser half of dsh-plugin-remote-ssh, shipped in the DSH client
 * closure-factory format: `window.__ModuleLoader__.load({ id, factory })`.
 *
 * Integration model (reuses the official workspace and conversation UI):
 *
 * 1. No custom panel, sidebar, or message stream is rendered: this half
 *    contributes zero slots. The official WorkspaceBrowser already renders
 *    whatever `ctx.workspaces` and `ctx.sessions` publish, and the official
 *    conversation assembles whatever `ctx.remote.session` streams.
 * 2. `reconcileRemoteSource` upserts the remote workspace groups and session
 *    summaries into `ctx.workspaces.list` / `ctx.sessions`, so the remote
 *    workspaces and sessions appear as first-class entries inside the official
 *    sidebar workspace tree (official folders, collapse/expand, session rows,
 *    status dots, menus).
 * 3. `installSessionProxy` wraps `ctx.remote.session` so `page`, `follow`,
 *    `projections`, etc. for a known remote session id are answered from the
 *    remote DSH raw wire data served by this plugin's Host route; local
 *    sessions pass through unchanged. Selecting a remote session in the
 *    official sidebar therefore opens the official conversation panel, which
 *    assembles the real remote history through the official node pipeline.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-remote-ssh',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const SESSIONS_ROUTE = '/remote-ssh/sessions'
    const SESSION_RAW_ROUTE = '/remote-ssh/session-raw'
    /** Refresh the remote workspace/session projection this often (ms). */
    const POLL_INTERVAL_MS = 60_000

    /** Known remote session ids, the proxy decision set. */
    const remoteSessionIds = new Set()
    /** Currently injected synthetic remote workspace ids, for diffing and teardown. */
    let injectedWorkspaceIds = new Set()

    /** Resolve a session id from an official `ctx.remote.session.*` request argument list. */
    function sessionIdOfRequest(args) {
      const req = args && args[0]
      if (!req || typeof req !== 'object') return undefined
      const address = req.address
      if (address && typeof address === 'object') {
        if (address.kind === 'session' && address.sessionId) return address.sessionId
        const id = address.sessionId || address.childSessionId
        if (id) return id
      }
      return req.sessionId || undefined
    }

    function removeRemoteSource(ctx) {
      try {
        const sessions = ctx.sessions
        if (sessions && typeof sessions.handleSessionRemoved === 'function') {
          for (const id of remoteSessionIds) sessions.handleSessionRemoved(id)
        }
        const workspaces = ctx.workspaces && ctx.workspaces.list
        if (workspaces && typeof workspaces.removeView === 'function') {
          for (const wid of injectedWorkspaceIds) workspaces.removeView(wid)
        }
      } catch {
        // Teardown must not throw into the loader.
      }
      remoteSessionIds.clear()
      injectedWorkspaceIds = new Set()
    }

    /** Pull the remote snapshot and publish it into the official client models. */
    async function reconcileRemoteSource(ctx) {
      let response
      try {
        response = await fetch(SESSIONS_ROUTE, { headers: { accept: 'application/json' } })
      } catch {
        return
      }
      if (!response.ok) return
      const body = await response.json().catch(() => null)
      if (!body || !Array.isArray(body.workspaces)) return

      const sessions = ctx.sessions
      const workspaces = ctx.workspaces && ctx.workspaces.list

      const nextSessionIds = new Set()
      const workspaceByCwd = new Map()
      for (const ws of body.workspaces) {
        if (!ws || typeof ws.cwd !== 'string') continue
        const sessionIds = (ws.sessions || []).map((s) => String(s.sessionId))
        for (const id of sessionIds) nextSessionIds.add(id)
        workspaceByCwd.set(ws.cwd, { name: ws.name, sessionIds })
      }

      // Sessions: drop remote rows absent from this snapshot, then upsert the rest.
      if (sessions && typeof sessions.handleSessionRemoved === 'function') {
        for (const id of remoteSessionIds) {
          if (!nextSessionIds.has(id)) sessions.handleSessionRemoved(id)
        }
      }
      if (sessions && typeof sessions.handleSessionAdded === 'function') {
        for (const ws of body.workspaces) {
          for (const s of ws.sessions || []) {
            const id = String(s.sessionId)
            sessions.handleSessionAdded({
              id,
              title: typeof s.title === 'string' ? s.title : undefined,
              displayTitle: typeof s.title === 'string' && s.title !== '' ? s.title : id,
              cwd: typeof s.cwd === 'string' ? s.cwd : undefined,
              running: Boolean(s.running),
              blank: Boolean(s.blank),
              updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : Date.now(),
              retainedBy: {},
            })
          }
        }
      }

      // Workspaces: remove vanished synthetic groups, then (re)upsert current ones.
      if (workspaces && typeof workspaces.removeView === 'function') {
        for (const wid of injectedWorkspaceIds) {
          if (!workspaceByCwd.has(wid)) workspaces.removeView(wid)
        }
      }
      const nextWorkspaceIds = new Set()
      if (workspaces && typeof workspaces.upsertView === 'function') {
        for (const [cwd, info] of workspaceByCwd) {
          const workspaceId = `remote:${cwd}`
          nextWorkspaceIds.add(workspaceId)
          workspaces.upsertView({
            workspaceId,
            path: cwd,
            title: `远程 ${info.name}`,
            sessionIds: info.sessionIds,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          })
        }
      }

      remoteSessionIds.clear()
      for (const id of nextSessionIds) remoteSessionIds.add(id)
      injectedWorkspaceIds = nextWorkspaceIds
    }

    /** Wrap `ctx.remote.session` so remote ids are served from the tunnel, locals unchanged. */
    function installSessionProxy(ctx) {
      const ns = ctx.remote && ctx.remote.session
      if (!ns) return () => {}
      const methods = ['page', 'follow', 'projections', 'prompt', 'cancel', 'rename', 'attachment']
      const saved = new Map()
      for (const method of methods) {
        const desc = Object.getOwnPropertyDescriptor(ns, method)
        if (desc) saved.set(method, desc)
      }
      const originalCall = (method, args) => {
        const desc = saved.get(method)
        return desc ? desc.get.call(ns)(...args) : undefined
      }
      const isRemote = (id) => id !== undefined && remoteSessionIds.has(id)

      async function remoteFetchRaw(id, signal) {
        const res = await fetch(`${SESSION_RAW_ROUTE}?id=${encodeURIComponent(id)}`, {
          headers: { accept: 'application/json' },
          signal,
        })
        if (!res.ok) {
          const errBody = await res.json().catch(() => null)
          throw new Error((errBody && errBody.message) || `HTTP ${res.status}`)
        }
        return res.json()
      }

      const wrap = {
        page: (...args) => {
          const id = sessionIdOfRequest(args)
          if (!isRemote(id)) return originalCall('page', args)
          return remoteFetchRaw(id, args[1])
            .then((raw) => ({ ok: true, value: { records: raw.records || [], hasMore: !!raw.hasMore } }))
            .catch((error) => ({ ok: false, error }))
        },
        projections: (...args) => {
          const id = sessionIdOfRequest(args)
          if (!isRemote(id)) return originalCall('projections', args)
          return remoteFetchRaw(id, args[1])
            .then((raw) => ({ ok: true, value: { asOfSeq: raw.asOfSeq || 0, values: raw.projections || {} } }))
            .catch((error) => ({ ok: false, error }))
        },
        follow: async function* (...args) {
          const id = sessionIdOfRequest(args)
          if (!isRemote(id)) {
            yield* originalCall('follow', args)
            return
          }
          const raw = await remoteFetchRaw(id, args[1])
          // One static snapshot opens the official journal; the stream then
          // stays parked until the caller cancels. Live deltas come in a
          // later milestone that relays the remote follow stream itself.
          yield {
            type: 'snapshot',
            header: raw.header || { version: 0, id, createdAt: Date.now(), isSeeded: false },
            cursor: raw.asOfSeq || 0,
            records: raw.records || [],
            hasMore: false,
            projections: { asOfSeq: raw.asOfSeq || 0, values: raw.projections || {} },
            assistantStream: { revision: 0 },
          }
          await new Promise((resolve) => {
            const signal = args[1]
            if (!signal || signal.aborted) resolve()
            else signal.addEventListener('abort', resolve, { once: true })
          })
        },
        prompt: (...args) => {
          const id = sessionIdOfRequest(args)
          if (!isRemote(id)) return originalCall('prompt', args)
          return Promise.resolve({ ok: false, error: new Error('remote-ssh: 远端会话续写尚未接通（当前只读里程碑）') })
        },
        cancel: (...args) => {
          const id = sessionIdOfRequest(args)
          if (!isRemote(id)) return originalCall('cancel', args)
          return Promise.resolve({ ok: false, error: new Error('remote-ssh: 远端会话停止尚未接通（当前只读里程碑）') })
        },
        rename: (...args) => {
          const id = sessionIdOfRequest(args)
          if (!isRemote(id)) return originalCall('rename', args)
          return Promise.resolve({ ok: false, error: new Error('remote-ssh: 远端会话重命名尚未接通（当前只读里程碑）') })
        },
        attachment: (...args) => {
          const id = sessionIdOfRequest(args)
          if (!isRemote(id)) return originalCall('attachment', args)
          return Promise.resolve({ ok: false, error: new Error('remote-ssh: 远端会话图片读取尚未接通') })
        },
      }

      for (const method of Object.keys(wrap)) {
        if (!saved.has(method)) continue
        Object.defineProperty(ns, method, {
          configurable: true,
          enumerable: true,
          get: () => wrap[method],
        })
      }
      return () => {
        for (const [method, desc] of saved) Object.defineProperty(ns, method, desc)
      }
    }

    /**
     * Activate the integration: publish remote workspaces/sessions into the
     * official models and wrap the session namespace for remote interception.
     * @param ctx - client plugin context with the injected service edges.
     */
    function apply(ctx) {
      const restoreProxy = installSessionProxy(ctx)
      const timer = setInterval(() => { void reconcileRemoteSource(ctx) }, POLL_INTERVAL_MS)
      void reconcileRemoteSource(ctx)
      ctx.effect(() => () => {
        clearInterval(timer)
        restoreProxy()
        removeRemoteSource(ctx)
      })
    }

    exports.apply = apply
    exports.inject = ['workspaces', 'sessions', 'remote']
    return module.exports
  },
})