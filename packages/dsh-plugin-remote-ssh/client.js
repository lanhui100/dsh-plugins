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
    const SESSION_PROMPT_ROUTE = '/remote-ssh/prompt'
    const SESSION_CANCEL_ROUTE = '/remote-ssh/cancel'
    const SESSION_FOLLOW_ROUTE = '/remote-ssh/session-follow'
    const SESSION_CREATE_ROUTE = '/remote-ssh/create'
    /** Refresh the remote workspace/session projection this often (ms). */
    const POLL_INTERVAL_MS = 60_000

    /** Known remote session ids, the proxy decision set. */
    const remoteSessionIds = new Set()
    /** Known remote archived session ids from authoritative remote baseline. */
    let remoteArchivedSessionIds = new Set()
    /** Currently injected synthetic remote workspace ids, for diffing and teardown. */
    let injectedWorkspaceIds = new Set()
    /** Map of child subagent session id -> parent session id. */
    const sessionParents = new Map()

    /** Resolve target session id and parent id from an official `ctx.remote.session.*` request argument list. */
    function sessionTargetOfRequest(args) {
      const req = args && args[0]
      if (typeof req === 'string') {
        const id = req
        const parentId = typeof args[1] === 'string' ? args[1] : sessionParents.get(id)
        return { id, parentId }
      }
      if (!req || typeof req !== 'object') return { id: undefined, parentId: undefined }
      const address = req.address
      if (address && typeof address === 'object') {
        if (address.kind === 'session' && address.sessionId) return { id: address.sessionId, parentId: undefined }
        if (address.childSessionId) return { id: address.childSessionId, parentId: address.parentSessionId }
        if (address.sessionId) return { id: address.sessionId, parentId: undefined }
      }
      const id = req.sessionId || req.childSessionId || undefined
      const parentId = req.parentSessionId || (id !== undefined ? sessionParents.get(id) : undefined)
      return { id, parentId }
    }

    /** Truncate long host aliases so titles remain clean in narrow sidebars. */
    function formatHostLabel(host, maxLen = 14) {
      if (!host || typeof host !== 'string') return 'remote'
      const trimmed = host.trim()
      if (trimmed.length <= maxLen) return trimmed
      return trimmed.slice(0, maxLen - 1) + '…'
    }

    /** HTML escape helper for DOM title injection. */
    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
    }

    /** Cached synthetic remote workspace views to survive baseline resets. */
    let cachedWorkspaceViews = []

    function reapplyRemoteWorkspaces(ctx) {
      const workspaces = ctx.workspaces && ctx.workspaces.list
      if (!workspaces || typeof workspaces.upsertView !== 'function') return
      if (workspaces.removedIds && typeof workspaces.removedIds.delete === 'function') {
        for (const view of cachedWorkspaceViews) {
          workspaces.removedIds.delete(view.workspaceId)
        }
      }
      for (const view of cachedWorkspaceViews) {
        workspaces.upsertView(view)
      }
    }

    /** Merge remote archived session IDs into the official WorkspaceModel. */
    function syncArchivedSessions(ctx) {
      const workspaces = ctx.workspaces && ctx.workspaces.list
      if (!workspaces) return
      const current = workspaces.archivedSessionIds || []
      const localArchived = current.filter((id) => !remoteSessionIds.has(id))
      const merged = [...new Set([...localArchived, ...remoteArchivedSessionIds])]
      if (typeof workspaces.installArchived === 'function') {
        workspaces.installArchived(merged)
      } else if (typeof workspaces.replaceArchived === 'function') {
        workspaces.replaceArchived(merged)
      } else {
        workspaces.archivedSessionIds = merged
        if (typeof workspaces.invalidate === 'function') workspaces.invalidate()
      }
    }

    /** Intercept replaceBaseline and replaceArchived so remote workspaces and archived sessions persist. */
    function installWorkspaceGuardian(ctx) {
      const workspaces = ctx.workspaces && ctx.workspaces.list
      if (!workspaces) return () => {}
      const originalReplaceBaseline = workspaces.replaceBaseline
      const originalReplaceArchived = workspaces.replaceArchived

      if (typeof originalReplaceBaseline === 'function') {
        workspaces.replaceBaseline = function (baseline) {
          const result = originalReplaceBaseline.call(this, baseline)
          try {
            reapplyRemoteWorkspaces(ctx)
            syncArchivedSessions(ctx)
          } catch {
            // Persistence hook must not crash baseline processing.
          }
          return result
        }
      }

      if (typeof originalReplaceArchived === 'function') {
        workspaces.replaceArchived = function (archivedSessionIds) {
          const result = originalReplaceArchived.call(this, archivedSessionIds)
          try {
            syncArchivedSessions(ctx)
          } catch {
            // Persistence hook must not crash archive updates.
          }
          return result
        }
      }

      return () => {
        if (originalReplaceBaseline) workspaces.replaceBaseline = originalReplaceBaseline
        if (originalReplaceArchived) workspaces.replaceArchived = originalReplaceArchived
      }
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
        // Remove remote archived session IDs from official registry
        if (workspaces && workspaces.archivedSessionIds) {
          const current = workspaces.archivedSessionIds
          const restored = current.filter((id) => !remoteArchivedSessionIds.has(id))
          if (typeof workspaces.installArchived === 'function') workspaces.installArchived(restored)
          else workspaces.archivedSessionIds = restored
        }
      } catch {
        // Teardown must not throw into the loader.
      }
      cachedWorkspaceViews = []
      remoteSessionIds.clear()
      remoteArchivedSessionIds.clear()
      injectedWorkspaceIds = new Set()
      sessionParents.clear()
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
      const nextWorkspaceViews = new Map()
      const nextSessions = []
      const displayHost = formatHostLabel(body.host)

      // Store remote archived sessions
      remoteArchivedSessionIds = new Set(
        Array.isArray(body.archivedSessionIds) ? body.archivedSessionIds.map(String) : []
      )

      const allSessions = Array.isArray(body.sessions) ? body.sessions : []
      sessionParents.clear()
      for (const s of allSessions) {
        if (s && s.sessionId && s.parentSessionId) {
          sessionParents.set(String(s.sessionId), String(s.parentSessionId))
        }
      }

      for (const ws of body.workspaces) {
        if (!ws || typeof ws.cwd !== 'string') continue
        // Root workspace view only lists direct sessions (subagents excluded)
        const sessionIds = (ws.sessions || []).map((s) => String(s.sessionId))
        const workspaceId = `remote:${ws.cwd}`
        // Format: <远程主机名> : <工作区文件夹名称> (no "远程" word)
        const title = `${displayHost} : ${ws.name}`
        nextWorkspaceViews.set(workspaceId, {
          workspaceId,
          path: ws.cwd,
          title,
          sessionIds,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
      }

      // Populate full session list into ctx.sessions (including subagents and projections)
      const sourceSessions = allSessions.length > 0
        ? allSessions
        : (body.workspaces || []).flatMap((ws) => ws.sessions || [])

      for (const s of sourceSessions) {
        if (!s || !s.sessionId) continue
        const id = String(s.sessionId)
        nextSessionIds.add(id)
        nextSessions.push({
          id,
          sessionId: id,
          title: typeof s.title === 'string' ? s.title : undefined,
          displayTitle: typeof s.title === 'string' && s.title !== '' ? s.title : id,
          cwd: typeof s.cwd === 'string' ? s.cwd : undefined,
          running: Boolean(s.running),
          blank: Boolean(s.blank),
          updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : Date.now(),
          origin: typeof s.origin === 'string' ? s.origin : undefined,
          parentSessionId: typeof s.parentSessionId === 'string' ? s.parentSessionId : undefined,
          parentId: typeof s.parentSessionId === 'string' ? s.parentSessionId : undefined,
          projections: s.projections,
          retainedBy: {},
        })
      }

      cachedWorkspaceViews = [...nextWorkspaceViews.values()]

      // Sessions: drop remote rows absent from this snapshot, then upsert the rest.
      if (sessions && typeof sessions.handleSessionRemoved === 'function') {
        for (const id of remoteSessionIds) {
          if (!nextSessionIds.has(id)) sessions.handleSessionRemoved(id)
        }
      }
      if (sessions && typeof sessions.handleSessionAdded === 'function') {
        for (const s of nextSessions) {
          sessions.handleSessionAdded(s)
        }
      }

      // Workspaces: remove vanished synthetic groups, then (re)upsert current ones.
      if (workspaces && typeof workspaces.removeView === 'function') {
        for (const wid of injectedWorkspaceIds) {
          if (!nextWorkspaceViews.has(wid)) workspaces.removeView(wid)
        }
      }
      if (workspaces && typeof workspaces.upsertView === 'function') {
        if (workspaces.removedIds && typeof workspaces.removedIds.delete === 'function') {
          for (const wid of nextWorkspaceViews.keys()) {
            workspaces.removedIds.delete(wid)
          }
        }
        for (const view of cachedWorkspaceViews) {
          workspaces.upsertView(view)
        }
      }

      remoteSessionIds.clear()
      for (const id of nextSessionIds) remoteSessionIds.add(id)
      injectedWorkspaceIds = new Set(nextWorkspaceViews.keys())

      // Synchronize archived sessions into official workspace list
      syncArchivedSessions(ctx)
    }

    /** Wrap `ctx.remote.session` so remote ids are served from the tunnel, locals unchanged. */
    function installSessionProxy(ctx) {
      const ns = ctx.remote && ctx.remote.session
      if (!ns) return () => {}
      const methods = ['page', 'follow', 'projections', 'prompt', 'cancel', 'rename', 'attachment', 'create']
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

      async function remoteFetchRaw(id, signal, parentId) {
        const resolvedParent = parentId || sessionParents.get(id)
        const parentQuery = resolvedParent ? `&parentId=${encodeURIComponent(resolvedParent)}` : ''
        const res = await fetch(`${SESSION_RAW_ROUTE}?id=${encodeURIComponent(id)}${parentQuery}`, {
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
          const { id, parentId } = sessionTargetOfRequest(args)
          if (!isRemote(id)) return originalCall('page', args)
          return remoteFetchRaw(id, args[1], parentId)
            .then((raw) => ({ ok: true, value: { records: raw.records || [], hasMore: !!raw.hasMore } }))
            .catch((error) => ({ ok: false, error }))
        },
        projections: (...args) => {
          const { id, parentId } = sessionTargetOfRequest(args)
          if (!isRemote(id)) return originalCall('projections', args)
          return remoteFetchRaw(id, args[1], parentId)
            .then((raw) => ({ ok: true, value: { asOfSeq: raw.asOfSeq || 0, values: raw.projections || {} } }))
            .catch((error) => ({ ok: false, error }))
        },
        follow: async function* (...args) {
          const { id, parentId } = sessionTargetOfRequest(args)
          if (!isRemote(id)) {
            yield* originalCall('follow', args)
            return
          }
          const signal = args[1]
          const resolvedParent = parentId || sessionParents.get(id)
          const parentQuery = resolvedParent ? `&parentId=${encodeURIComponent(resolvedParent)}` : ''
          const followUrl = `${SESSION_FOLLOW_ROUTE}?id=${encodeURIComponent(id)}${parentQuery}`

          let streamed = false
          try {
            const res = await fetch(followUrl, {
              headers: { accept: 'text/event-stream' },
              signal,
            })
            if (res.ok && res.body && typeof res.body.getReader === 'function') {
              const reader = res.body.getReader()
              const decoder = new TextDecoder()
              let buffer = ''
              try {
                while (true) {
                  const { done, value } = await reader.read()
                  if (done) break
                  buffer += typeof value === 'string' ? value : decoder.decode(value, { stream: true })
                  const parts = buffer.split('\n\n')
                  buffer = parts.pop() || ''
                  for (const part of parts) {
                    const trimmed = part.trim()
                    if (!trimmed.startsWith('data:')) continue
                    const jsonText = trimmed.slice(5).trim()
                    if (!jsonText) continue
                    const frame = JSON.parse(jsonText)
                    streamed = true
                    yield frame
                  }
                }
              } finally {
                try { reader.releaseLock?.() } catch {}
              }
            }
          } catch (err) {
            if (signal && signal.aborted) return
          }

          if (!streamed) {
            // Snapshot fallback if streaming failed or environment does not support response.body reader
            const raw = await remoteFetchRaw(id, signal, resolvedParent)
            yield {
              type: 'snapshot',
              header: raw.header || {
                version: 0,
                id,
                createdAt: Date.now(),
                isSeeded: false,
                ...(resolvedParent !== undefined ? { origin: 'subagent', parentSession: resolvedParent } : {}),
              },
              cursor: raw.asOfSeq || 0,
              records: raw.records || [],
              hasMore: false,
              projections: { asOfSeq: raw.asOfSeq || 0, values: raw.projections || {} },
              assistantStream: { revision: 0 },
            }
            await new Promise((resolve) => {
              if (!signal || signal.aborted) resolve()
              else signal.addEventListener('abort', resolve, { once: true })
            })
          }
        },
        prompt: async (...args) => {
          const { id, parentId } = sessionTargetOfRequest(args)
          if (!isRemote(id)) return originalCall('prompt', args)
          const req = (args && typeof args[0] === 'object' && args[0] !== null) ? args[0] : {}
          const signal = args[1]
          try {
            const res = await fetch(SESSION_PROMPT_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify({
                ...req,
                sessionId: id,
                ...(parentId !== undefined ? { parentSessionId: parentId } : {}),
              }),
              signal,
            })
            const data = await res.json().catch(() => null)
            if (data && typeof data === 'object' && 'ok' in data) return data
            if (!res.ok) {
              return { ok: false, error: new Error((data && data.message) || `HTTP ${res.status}`) }
            }
            return { ok: true, value: data ?? { accepted: true } }
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error : new Error(String(error)) }
          }
        },
        cancel: async (...args) => {
          const { id, parentId } = sessionTargetOfRequest(args)
          if (!isRemote(id)) return originalCall('cancel', args)
          const req = (args && typeof args[0] === 'object' && args[0] !== null) ? args[0] : {}
          try {
            const res = await fetch(SESSION_CANCEL_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify({
                ...req,
                sessionId: id,
                ...(parentId !== undefined ? { parentSessionId: parentId } : {}),
              }),
            })
            const data = await res.json().catch(() => null)
            if (data && typeof data === 'object' && 'ok' in data) return data
            if (!res.ok) {
              return { ok: false, error: new Error((data && data.message) || `HTTP ${res.status}`) }
            }
            return { ok: true, value: data ?? { accepted: true } }
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error : new Error(String(error)) }
          }
        },
        rename: (...args) => {
          const { id } = sessionTargetOfRequest(args)
          if (!isRemote(id)) return originalCall('rename', args)
          return Promise.resolve({ ok: false, error: new Error('remote-ssh: 远端会话重命名尚未接通（当前只读里程碑）') })
        },
        attachment: (...args) => {
          const { id } = sessionTargetOfRequest(args)
          if (!isRemote(id)) return originalCall('attachment', args)
          return Promise.resolve({ ok: false, error: new Error('remote-ssh: 远端会话图片读取尚未接通') })
        },
        create: async (...args) => {
          const req = (args && typeof args[0] === 'object' && args[0] !== null) ? args[0] : {}
          const workspaceId = typeof req.workspaceId === 'string' ? req.workspaceId : undefined
          const cwd = typeof req.cwd === 'string' ? req.cwd : undefined

          const isRemoteTarget = (workspaceId && workspaceId.startsWith('remote:')) ||
            (workspaceId && injectedWorkspaceIds.has(workspaceId)) ||
            (cwd && injectedWorkspaceIds.has(`remote:${cwd}`))

          if (!isRemoteTarget) return originalCall('create', args)

          try {
            const res = await fetch(SESSION_CREATE_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify(req),
            })
            const data = await res.json().catch(() => null)
            if (data && typeof data === 'object' && data.ok && data.value && data.value.sessionId) {
              const newSessionId = data.value.sessionId
              remoteSessionIds.add(newSessionId)
              if (workspaceId && ctx.workspaces && ctx.workspaces.list && typeof ctx.workspaces.list.upsertView === 'function') {
                const wsItem = ctx.workspaces.list.items?.find((item) => item.workspaceId === workspaceId)
                if (wsItem) {
                  ctx.workspaces.list.upsertView({
                    ...wsItem,
                    sessionIds: [newSessionId, ...(wsItem.sessionIds || [])],
                  })
                }
              }
              return data
            }
            if (data && typeof data === 'object' && 'ok' in data) return data
            if (!res.ok) {
              return { ok: false, error: new Error((data && data.message) || `HTTP ${res.status}`) }
            }
            return { ok: true, value: data }
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error : new Error(String(error)) }
          }
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

      let restoreSubagents = () => {}
      try {
        const subagentsNs = ctx.remote && ctx.remote.subagents
        if (subagentsNs) {
          const subMethods = ['prompt', 'interruptByParent']
          const savedSub = new Map()
          for (const method of subMethods) {
            const desc = Object.getOwnPropertyDescriptor(subagentsNs, method)
            if (desc) savedSub.set(method, desc)
          }
          const origSubCall = (method, args) => {
            const desc = savedSub.get(method)
            return desc ? desc.get.call(subagentsNs)(...args) : undefined
          }
          const wrapSub = {
            prompt: (...args) => {
              const { id } = sessionTargetOfRequest(args)
              if (!isRemote(id)) return origSubCall('prompt', args)
              return wrap.prompt(...args)
            },
            interruptByParent: (...args) => {
              const childId = args[0]
              const parentId = args[1]
              if (!isRemote(childId)) return origSubCall('interruptByParent', args)
              return wrap.cancel({ sessionId: childId, parentSessionId: parentId })
            },
          }
          for (const method of Object.keys(wrapSub)) {
            if (!savedSub.has(method)) continue
            Object.defineProperty(subagentsNs, method, {
              configurable: true,
              enumerable: true,
              get: () => wrapSub[method],
            })
          }
          restoreSubagents = () => {
            for (const [method, desc] of savedSub) Object.defineProperty(subagentsNs, method, desc)
          }
        }
      } catch (_) {}

      return () => {
        for (const [method, desc] of saved) Object.defineProperty(ns, method, desc)
        restoreSubagents()
      }
    }

    /** Visual enhancer: add remote element badge to workspace folder and bold host title. */
    const STYLE_TAG_ID = 'dsh-plugin-remote-ssh-style'

    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      let tag = document.getElementById(STYLE_TAG_ID)
      if (!tag) {
        tag = document.createElement('style')
        tag.id = STYLE_TAG_ID
        tag.textContent = `
          div[data-row-key^="workspace:remote:"] span[class*="folder"] {
            position: relative !important;
          }
          div[data-row-key^="workspace:remote:"] span[class*="folder"]::after {
            content: '';
            position: absolute;
            bottom: -1px;
            right: -2px;
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background-color: var(--dsw-alias-color-brand-default, #2563eb);
            background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10' fill='white'%3E%3Cpath d='M2 5.5a3 3 0 0 1 6 0H2z'/%3E%3Ccircle cx='5' cy='7.5' r='1'/%3E%3C/svg%3E");
            background-size: 6px 6px;
            background-repeat: no-repeat;
            background-position: center;
            border: 1.5px solid var(--dsw-alias-bg-canvas, #ffffff);
            box-shadow: 0 0 2px rgba(0, 0, 0, 0.25);
            pointer-events: none;
            z-index: 2;
          }
          .dsh-remote-host-prefix {
            font-weight: 700 !important;
            color: var(--dsw-alias-label-primary, inherit);
            margin-right: 2px;
          }
        `
        document.head.appendChild(tag)
      }
      return () => {
        const el = document.getElementById(STYLE_TAG_ID)
        if (el) el.remove()
      }
    }

    function decorateRemoteTitles() {
      if (typeof document === 'undefined') return
      const rows = document.querySelectorAll('div[data-row-key^="workspace:remote:"]')
      for (const row of rows) {
        const titleEl = row.querySelector('span[class*="title"]')
        if (!titleEl || titleEl.dataset.remoteDecorated === 'true') continue
        const text = titleEl.textContent || ''
        const colonIdx = text.indexOf(' : ')
        if (colonIdx !== -1) {
          const host = text.slice(0, colonIdx)
          const rest = text.slice(colonIdx + 3)
          titleEl.dataset.remoteDecorated = 'true'
          titleEl.innerHTML = `<strong class="dsh-remote-host-prefix">${escapeHtml(host)}</strong> : ${escapeHtml(rest)}`
        }
      }
    }

    function installTitleDecorator() {
      if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
      decorateRemoteTitles()
      const observer = new MutationObserver(() => {
        decorateRemoteTitles()
      })
      observer.observe(document.body, { childList: true, subtree: true })
      return () => {
        observer.disconnect()
        const decorated = document.querySelectorAll('span[data-remote-decorated="true"]')
        for (const el of decorated) {
          el.textContent = el.textContent
          delete el.dataset.remoteDecorated
        }
      }
    }

    /**
     * Activate the integration: publish remote workspaces/sessions into the
     * official models and wrap the session namespace for remote interception.
     * @param ctx - client plugin context with the injected service edges.
     */
    function apply(ctx) {
      const restoreProxy = installSessionProxy(ctx)
      const restoreGuardian = installWorkspaceGuardian(ctx)
      const restoreStyles = installStyles()
      const restoreDecorator = installTitleDecorator()
      const timer = setInterval(() => { void reconcileRemoteSource(ctx) }, POLL_INTERVAL_MS)
      void reconcileRemoteSource(ctx)
      ctx.effect(() => () => {
        clearInterval(timer)
        restoreProxy()
        restoreGuardian()
        restoreStyles()
        restoreDecorator()
        removeRemoteSource(ctx)
      })
    }

    exports.apply = apply
    exports.inject = ['workspaces', 'sessions', 'remote', 'remote.session']
    return module.exports
  },
})