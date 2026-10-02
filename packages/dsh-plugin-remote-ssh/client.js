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
    const SESSION_PENDING_INTERACTION_ROUTE = '/remote-ssh/pending-interaction'
    const SESSION_INTERACTION_RESPOND_ROUTE = '/remote-ssh/interaction-respond'
    const SESSION_ARCHIVE_ROUTE = '/remote-ssh/session-archive'
    const SESSION_UNARCHIVE_ROUTE = '/remote-ssh/session-unarchive'
    const SESSION_PIN_ROUTE = '/remote-ssh/session-pin'
    const SESSION_UNPIN_ROUTE = '/remote-ssh/session-unpin'
    const SESSION_RENAME_ROUTE = '/remote-ssh/session-rename'
    const AVAILABLE_HOSTS_ROUTE = '/remote-ssh/available-hosts'
    const ADD_HOST_ROUTE = '/remote-ssh/add-host'
    const REMOVE_HOST_ROUTE = '/remote-ssh/remove-host'
    /** Refresh the remote workspace/session projection this often (ms). */
    const POLL_INTERVAL_MS = 60_000

    /** Official Tooltip hover delay used by the workspace header icons (ms). */
    const TOOLTIP_DELAY_MS = 500
    /** Official Tooltip anchor-to-bubble gap (px). */
    const TOOLTIP_GAP = 8
    /** Official Tooltip viewport edge margin (px). */
    const TOOLTIP_EDGE_MARGIN = 12
    /** Official Toast full-opacity hold before the fade starts (ms). */
    const TOAST_HOLD_MS = 3_000
    /** Official Toast fade duration (ms). */
    const TOAST_FADE_MS = 1_000
    /** Official Toast top offset from the viewport (px). */
    const TOAST_TOP_PX = 40

    /** Known remote session ids, the proxy decision set. */
    const remoteSessionIds = new Set()
    /** Known remote archived session ids from authoritative remote baseline. */
    let remoteArchivedSessionIds = new Set()
    /** Local archived ids are tracked separately so remote ids absent from session/list cannot be resurrected. */
    let localArchivedSessionIds = null
    /** Known remote pinned session ids from authoritative remote baseline. */
    let remotePinnedSessionIds = new Set()
    /** Local pinned ids are tracked separately from remote mutation responses. */
    let localPinnedSessionIds = null
    /** Guard official archive writes triggered by our own synchronization. */
    let syncingArchived = false
    /** Guard official pin writes triggered by our own synchronization. */
    let syncingPinned = false

    function isNamespacedRemoteId(id) {
      return typeof id === 'string' && id.startsWith('remote:')
    }

    function isRemoteStateId(id) {
      return remoteSessionIds.has(id) || isNamespacedRemoteId(id)
    }

    function hostPrefixOf(id) {
      if (!isNamespacedRemoteId(id)) return undefined
      const secondColon = id.indexOf(':', 'remote:'.length)
      return secondColon === -1 ? id : id.slice(0, secondColon + 1)
    }

    function mergeRemoteMutationIds(current, next, sessionId) {
      const prefix = hostPrefixOf(sessionId)
      if (!prefix) return [...new Set(next)]
      const preserved = current.filter((id) => hostPrefixOf(id) !== prefix)
      return [...new Set([...preserved, ...next])]
    }

    /** Merge remote archived session IDs into the official WorkspaceModel. */
    function syncArchivedSessions(ctx) {
      const workspaces = ctx.workspaces && ctx.workspaces.list
      if (!workspaces) return
      const current = Array.isArray(workspaces.archivedSessionIds) ? workspaces.archivedSessionIds.map(String) : []
      if (localArchivedSessionIds === null) {
        localArchivedSessionIds = new Set(current.filter((id) => !isRemoteStateId(id)))
      }
      const merged = [...new Set([...localArchivedSessionIds, ...remoteArchivedSessionIds])]
      syncingArchived = true
      try {
        if (typeof workspaces.installArchived === 'function') {
          workspaces.installArchived(merged)
        } else if (typeof workspaces.replaceArchived === 'function') {
          workspaces.replaceArchived(merged)
        } else {
          workspaces.archivedSessionIds = merged
          if (typeof workspaces.invalidate === 'function') workspaces.invalidate()
        }
      } finally {
        syncingArchived = false
      }
    }

    function syncPinnedSessions(ctx) {
      const workspaces = ctx.workspaces && ctx.workspaces.list
      if (!workspaces) return
      const current = Array.isArray(workspaces.pinnedSessionIds) ? workspaces.pinnedSessionIds.map(String) : []
      if (localPinnedSessionIds === null) {
        localPinnedSessionIds = new Set(current.filter((id) => !isRemoteStateId(id)))
      }
      const merged = [...new Set([...localPinnedSessionIds, ...remotePinnedSessionIds])]
      syncingPinned = true
      try {
        if (typeof workspaces.installPinned === 'function') {
          workspaces.installPinned(merged)
        } else if (typeof workspaces.replacePinned === 'function') {
          workspaces.replacePinned(merged)
        } else {
          workspaces.pinnedSessionIds = merged
          if (typeof workspaces.invalidate === 'function') workspaces.invalidate()
        }
      } finally {
        syncingPinned = false
      }
    }

    function applyRemoteMutationIds(ctx, field, ids, sessionId) {
      const normalized = Array.isArray(ids) ? ids.map(String) : []
      if (field === 'archivedSessionIds') {
        remoteArchivedSessionIds = new Set(
          mergeRemoteMutationIds([...remoteArchivedSessionIds], normalized, sessionId),
        )
        syncArchivedSessions(ctx)
      } else {
        remotePinnedSessionIds = new Set(
          mergeRemoteMutationIds([...remotePinnedSessionIds], normalized, sessionId),
        )
        syncPinnedSessions(ctx)
      }
    }
    /** Currently injected synthetic remote workspace ids, for diffing and teardown. */
    let injectedWorkspaceIds = new Set()
    /** Map of child subagent session id -> parent session id. */
    const sessionParents = new Map()
    /** Active pending interaction per sessionId. Map<sessionId, PendingRemoteInteraction> */
    const activeInteractions = new Map()
    /** Disposers for uiSession pending interaction registrations. Map<eventId, () => void> */
    const uiSessionDisposers = new Map()
    /** Reference to registerPendingPublisher if uiSession is present. */
    let registerPendingPublisher = null

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

    /** Intercept replaceBaseline and replaceArchived so remote workspaces and archived sessions persist. */
    function installWorkspaceGuardian(ctx) {
      const workspaces = ctx.workspaces && ctx.workspaces.list
      if (!workspaces) return () => {}
      const originalReplaceBaseline = workspaces.replaceBaseline
      const originalReplaceArchived = workspaces.replaceArchived
      const originalInstallPinned = workspaces.installPinned
      const originalReplacePinned = workspaces.replacePinned

      if (typeof originalReplaceBaseline === 'function') {
        workspaces.replaceBaseline = function (baseline) {
          const result = originalReplaceBaseline.call(this, baseline)
          if (!syncingArchived) {
            const ids = Array.isArray(this.archivedSessionIds) ? this.archivedSessionIds.map(String) : []
            localArchivedSessionIds = new Set(ids.filter((id) => !isRemoteStateId(id)))
          }
          if (!syncingPinned) {
            const ids = Array.isArray(this.pinnedSessionIds) ? this.pinnedSessionIds.map(String) : []
            localPinnedSessionIds = new Set(ids.filter((id) => !isRemoteStateId(id)))
          }
          try {
            reapplyRemoteWorkspaces(ctx)
            syncArchivedSessions(ctx)
            syncPinnedSessions(ctx)
          } catch {
            // Persistence hook must not crash baseline processing.
          }
          return result
        }
      }

      if (typeof originalReplaceArchived === 'function') {
        workspaces.replaceArchived = function (archivedSessionIds) {
          const result = originalReplaceArchived.call(this, archivedSessionIds)
          if (!syncingArchived) {
            const ids = Array.isArray(archivedSessionIds) ? archivedSessionIds.map(String) : []
            localArchivedSessionIds = new Set(ids.filter((id) => !isRemoteStateId(id)))
            syncArchivedSessions(ctx)
          }
          return result
        }
      }

      if (typeof originalReplacePinned === 'function') {
        workspaces.replacePinned = function (pinnedSessionIds) {
          const result = originalReplacePinned.call(this, pinnedSessionIds)
          if (!syncingPinned) {
            const ids = Array.isArray(pinnedSessionIds) ? pinnedSessionIds.map(String) : []
            localPinnedSessionIds = new Set(ids.filter((id) => !isRemoteStateId(id)))
            syncPinnedSessions(ctx)
          }
          return result
        }
      }

      if (typeof originalInstallPinned === 'function') {
        workspaces.installPinned = function (pinnedSessionIds) {
          const result = originalInstallPinned.call(this, pinnedSessionIds)
          if (!syncingPinned) {
            const ids = Array.isArray(pinnedSessionIds) ? pinnedSessionIds.map(String) : []
            localPinnedSessionIds = new Set(ids.filter((id) => !isRemoteStateId(id)))
            syncPinnedSessions(ctx)
          }
          return result
        }
      }

      return () => {
        if (originalReplaceBaseline) workspaces.replaceBaseline = originalReplaceBaseline
        if (originalReplaceArchived) workspaces.replaceArchived = originalReplaceArchived
        if (originalInstallPinned) workspaces.installPinned = originalInstallPinned
        if (originalReplacePinned) workspaces.replacePinned = originalReplacePinned
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
        // Remove remote archived and pinned session IDs from official registry
        if (workspaces && workspaces.archivedSessionIds) {
          const current = workspaces.archivedSessionIds
          const restored = current.filter((id) => !remoteArchivedSessionIds.has(id))
          syncingArchived = true
          try {
            if (typeof workspaces.installArchived === 'function') workspaces.installArchived(restored)
            else workspaces.archivedSessionIds = restored
          } finally {
            syncingArchived = false
          }
        }
        if (workspaces && workspaces.pinnedSessionIds) {
          const current = workspaces.pinnedSessionIds
          const restored = current.filter((id) => !remotePinnedSessionIds.has(id))
          syncingPinned = true
          try {
            if (typeof workspaces.installPinned === 'function') workspaces.installPinned(restored)
            else workspaces.pinnedSessionIds = restored
          } finally {
            syncingPinned = false
          }
        }
      } catch {
        // Teardown must not throw into the loader.
      }
      cachedWorkspaceViews = []
      remoteSessionIds.clear()
      remoteArchivedSessionIds.clear()
      remotePinnedSessionIds.clear()
      localArchivedSessionIds = null
      localPinnedSessionIds = null
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

      // Store remote archived and pinned sessions
      remoteArchivedSessionIds = new Set(
        Array.isArray(body.archivedSessionIds) ? body.archivedSessionIds.map(String) : []
      )
      remotePinnedSessionIds = new Set(
        Array.isArray(body.pinnedSessionIds) ? body.pinnedSessionIds.map(String) : []
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
        const workspaceId = ws.workspaceId || `remote:${ws.cwd}`
        let itemHost = displayHost
        if (typeof ws.workspaceId === 'string' && ws.workspaceId.startsWith('remote:')) {
          const parts = ws.workspaceId.split(':')
          if (parts.length >= 3) {
            itemHost = formatHostLabel(decodeURIComponent(parts[1]))
          }
        }
        const cleanName = ws.name ? ws.name.replace(/^\[[^\]]+\]\s*/, '') : ''
        // Format: <远程主机名> : <工作区文件夹名称> (no "远程" word)
        const title = `${itemHost} : ${cleanName}`
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

        // Synchronize pending interactions with remote session status
        if (s.pendingInteraction) {
          if (!activeInteractions.has(id)) {
            void fetch(`${SESSION_PENDING_INTERACTION_ROUTE}?sessionId=${encodeURIComponent(id)}`)
              .then((r) => r.json())
              .then((data) => {
                if (data && data.ok && data.value && data.value.pending) {
                  handleInteractionRequest(data.value.pending)
                }
              })
              .catch(() => {})
          }
        } else if (activeInteractions.has(id)) {
          const cur = activeInteractions.get(id)
          if (cur) handleInteractionCancel(cur.eventId, id)
        }
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
          if (typeof sessions.handleSessionStatus === 'function') {
            sessions.handleSessionStatus(s.sessionId, Boolean(s.running))
          }
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

      // Synchronize archived and pinned sessions into official workspace list
      syncArchivedSessions(ctx)
      syncPinnedSessions(ctx)
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

                    if (ctx.sessions) {
                      if (frame.type === 'assistant-stream' || (frame.type === 'event' && frame.event && frame.event.type === 'turn/start')) {
                        if (typeof ctx.sessions.handleSessionStatus === 'function') {
                          ctx.sessions.handleSessionStatus(id, true)
                        }
                      } else if (frame.type === 'event' && frame.event && frame.event.type === 'turn/end') {
                        if (typeof ctx.sessions.handleSessionStatus === 'function') {
                          ctx.sessions.handleSessionStatus(id, false)
                        }
                      }
                      if (frame.type === 'event' && frame.event && typeof frame.event.time === 'number') {
                        if (typeof ctx.sessions.handleSessionActivity === 'function') {
                          ctx.sessions.handleSessionActivity(id, frame.event.time)
                        }
                      }
                    }

                    if (frame.type === 'interaction/request') {
                      handleInteractionRequest(frame)
                    } else if (frame.type === 'interaction/cancel') {
                      handleInteractionCancel(frame.eventId, frame.sessionId || id)
                    }

                    yield frame
                  }
                }
              } finally {
                try { reader.releaseLock?.() } catch {}
                if (ctx.sessions && typeof ctx.sessions.handleSessionStatus === 'function') {
                  ctx.sessions.handleSessionStatus(id, false)
                }
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
            if (ctx.sessions && typeof ctx.sessions.handleSessionStatus === 'function') {
              ctx.sessions.handleSessionStatus(id, false)
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
            if (data && typeof data === 'object' && 'ok' in data) {
              if (data.ok && ctx.sessions && typeof ctx.sessions.handleSessionStatus === 'function') {
                ctx.sessions.handleSessionStatus(id, true)
              }
              return data
            }
            if (!res.ok) {
              return { ok: false, error: new Error((data && data.message) || `HTTP ${res.status}`) }
            }
            if (ctx.sessions && typeof ctx.sessions.handleSessionStatus === 'function') {
              ctx.sessions.handleSessionStatus(id, true)
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
            if (data && typeof data === 'object' && 'ok' in data) {
              if (data.ok && ctx.sessions && typeof ctx.sessions.handleSessionStatus === 'function') {
                ctx.sessions.handleSessionStatus(id, false)
              }
              return data
            }
            if (!res.ok) {
              return { ok: false, error: new Error((data && data.message) || `HTTP ${res.status}`) }
            }
            if (ctx.sessions && typeof ctx.sessions.handleSessionStatus === 'function') {
              ctx.sessions.handleSessionStatus(id, false)
            }
            return { ok: true, value: data ?? { accepted: true } }
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error : new Error(String(error)) }
          }
        },
        rename: async (...args) => {
          const { id } = sessionTargetOfRequest(args)
          if (!isRemote(id)) return originalCall('rename', args)
          const req = (args && typeof args[0] === 'object' && args[0] !== null) ? args[0] : {}
          const newTitle = typeof req.title === 'string' ? req.title : (typeof args[1] === 'string' ? args[1] : undefined)
          if (typeof newTitle !== 'string') {
            return { ok: false, error: new Error('title is required for rename') }
          }
          try {
            const res = await fetch(SESSION_RENAME_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify({ sessionId: id, title: newTitle }),
            })
            const data = await res.json().catch(() => null)
            if (data && data.ok) {
              if (ctx.sessions) {
                const listSnapshot = typeof ctx.sessions.list?.getSnapshot === 'function' ? ctx.sessions.list.getSnapshot() : undefined
                const target = ctx.sessions.byId?.[id] || listSnapshot?.byId?.[id]
                if (target) {
                  target.title = newTitle
                  target.displayTitle = newTitle
                }
              }
              return { ok: true, value: { title: newTitle, seq: data.value?.seq ?? 0 } }
            }
            return { ok: false, error: new Error(data?.error?.message || `HTTP ${res.status}`) }
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error : new Error(String(error)) }
          }
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

          const wsItem = workspaceId ? ctx.workspaces?.list?.items?.find((item) => item.workspaceId === workspaceId) : undefined
          const effectiveCwd = cwd || wsItem?.path

          try {
            const res = await fetch(SESSION_CREATE_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify({
                ...req,
                ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
              }),
            })
            const data = await res.json().catch(() => null)
            if (data && typeof data === 'object' && data.ok && data.value && data.value.sessionId) {
              const newSessionId = data.value.sessionId
              remoteSessionIds.add(newSessionId)
              if (workspaceId && ctx.workspaces && ctx.workspaces.list && typeof ctx.workspaces.list.upsertView === 'function') {
                if (wsItem) {
                  ctx.workspaces.list.upsertView({
                    ...wsItem,
                    sessionIds: [newSessionId, ...(wsItem.sessionIds || [])],
                  })
                }
              }
              if (ctx.sessions && typeof ctx.sessions.handleSessionAdded === 'function') {
                ctx.sessions.handleSessionAdded({
                  id: newSessionId,
                  sessionId: newSessionId,
                  cwd: effectiveCwd,
                  blank: true,
                  running: false,
                  updatedAt: Date.now(),
                  retainedBy: {},
                })
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
      let restoreWorkspaceNs = () => {}
      try {
        const wsNs = ctx.remote && ctx.remote.workspace
        if (wsNs) {
          const wsMethods = ['archiveSession', 'unarchiveSession', 'pinSession', 'unpinSession']
          const savedWs = new Map()
          for (const method of wsMethods) {
            const desc = Object.getOwnPropertyDescriptor(wsNs, method)
            if (desc) savedWs.set(method, desc)
          }
          const origWsCall = (method, args) => {
            const desc = savedWs.get(method)
            return desc ? desc.get.call(wsNs)(...args) : undefined
          }

          const wrapWs = {
            archiveSession: async (...args) => {
              const req = (args && typeof args[0] === 'object' && args[0] !== null) ? args[0] : {}
              const sid = String(req.sessionId || '')
              if (!isRemote(sid)) return origWsCall('archiveSession', args)
              try {
                const res = await fetch(SESSION_ARCHIVE_ROUTE, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json', accept: 'application/json' },
                  body: JSON.stringify(req),
                })
                const data = await res.json().catch(() => null)
                if (data && data.ok) {
                  const remoteArchived = Array.isArray(data.value?.archivedSessionIds)
                    ? data.value.archivedSessionIds.map(String)
                    : []
                  applyRemoteMutationIds(ctx, 'archivedSessionIds', remoteArchived, sid)
                  const mergedArchived = [...new Set([
                    ...(localArchivedSessionIds || []),
                    ...remoteArchivedSessionIds,
                  ])]
                  return { ok: true, value: { archivedSessionIds: mergedArchived } }
                }
                return { ok: false, error: new Error(data?.error?.message || `HTTP ${res.status}`) }
              } catch (error) {
                return { ok: false, error: error instanceof Error ? error : new Error(String(error)) }
              }
            },
            unarchiveSession: async (...args) => {
              const req = (args && typeof args[0] === 'object' && args[0] !== null) ? args[0] : {}
              const sid = String(req.sessionId || '')
              if (!isRemote(sid)) return origWsCall('unarchiveSession', args)
              try {
                const res = await fetch(SESSION_UNARCHIVE_ROUTE, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json', accept: 'application/json' },
                  body: JSON.stringify(req),
                })
                const data = await res.json().catch(() => null)
                if (data && data.ok) {
                  const remoteArchived = Array.isArray(data.value?.archivedSessionIds)
                    ? data.value.archivedSessionIds.map(String)
                    : []
                  applyRemoteMutationIds(ctx, 'archivedSessionIds', remoteArchived, sid)
                  const mergedArchived = [...new Set([
                    ...(localArchivedSessionIds || []),
                    ...remoteArchivedSessionIds,
                  ])]
                  return { ok: true, value: { archivedSessionIds: mergedArchived } }
                }
                return { ok: false, error: new Error(data?.error?.message || `HTTP ${res.status}`) }
              } catch (error) {
                return { ok: false, error: error instanceof Error ? error : new Error(String(error)) }
              }
            },
            pinSession: async (...args) => {
              const req = (args && typeof args[0] === 'object' && args[0] !== null) ? args[0] : {}
              const sid = String(req.sessionId || '')
              if (!isRemote(sid)) return origWsCall('pinSession', args)
              try {
                const res = await fetch(SESSION_PIN_ROUTE, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json', accept: 'application/json' },
                  body: JSON.stringify(req),
                })
                const data = await res.json().catch(() => null)
                if (data && data.ok) {
                  const remotePinned = Array.isArray(data.value?.pinnedSessionIds)
                    ? data.value.pinnedSessionIds.map(String)
                    : []
                  applyRemoteMutationIds(ctx, 'pinnedSessionIds', remotePinned, sid)
                  const mergedPinned = [...new Set([
                    ...(localPinnedSessionIds || []),
                    ...remotePinnedSessionIds,
                  ])]
                  return { ok: true, value: { pinnedSessionIds: mergedPinned } }
                }
                return { ok: false, error: new Error(data?.error?.message || `HTTP ${res.status}`) }
              } catch (error) {
                return { ok: false, error: error instanceof Error ? error : new Error(String(error)) }
              }
            },
            unpinSession: async (...args) => {
              const req = (args && typeof args[0] === 'object' && args[0] !== null) ? args[0] : {}
              const sid = String(req.sessionId || '')
              if (!isRemote(sid)) return origWsCall('unpinSession', args)
              try {
                const res = await fetch(SESSION_UNPIN_ROUTE, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json', accept: 'application/json' },
                  body: JSON.stringify(req),
                })
                const data = await res.json().catch(() => null)
                if (data && data.ok) {
                  const remotePinned = Array.isArray(data.value?.pinnedSessionIds)
                    ? data.value.pinnedSessionIds.map(String)
                    : []
                  applyRemoteMutationIds(ctx, 'pinnedSessionIds', remotePinned, sid)
                  const mergedPinned = [...new Set([
                    ...(localPinnedSessionIds || []),
                    ...remotePinnedSessionIds,
                  ])]
                  return { ok: true, value: { pinnedSessionIds: mergedPinned } }
                }
                return { ok: false, error: new Error(data?.error?.message || `HTTP ${res.status}`) }
              } catch (error) {
                return { ok: false, error: error instanceof Error ? error : new Error(String(error)) }
              }
            },
          }

          for (const method of Object.keys(wrapWs)) {
            if (!savedWs.has(method)) continue
            Object.defineProperty(wsNs, method, {
              configurable: true,
              enumerable: true,
              get: () => wrapWs[method],
            })
          }
          restoreWorkspaceNs = () => {
            for (const [method, desc] of savedWs) Object.defineProperty(wsNs, method, desc)
          }
        }
      } catch (_) {}

      return () => {
        for (const [method, desc] of saved) Object.defineProperty(ns, method, desc)
        restoreSubagents()
        restoreWorkspaceNs()
      }
    }

    function publishToUiSession(interaction) {
      if (!registerPendingPublisher) return
      if (uiSessionDisposers.has(interaction.eventId)) return
      const unregister = registerPendingPublisher({
        key: interaction.eventId,
        kind: 'question',
        sessionId: interaction.sessionId,
      }, () => {
        // delegated
      })
      uiSessionDisposers.set(interaction.eventId, unregister)
    }

    function unpublishFromUiSession(eventId) {
      const unregister = uiSessionDisposers.get(eventId)
      if (unregister) {
        uiSessionDisposers.delete(eventId)
        try { unregister() } catch {}
      }
    }

    function handleInteractionRequest(frame) {
      const interaction = {
        eventId: String(frame.eventId),
        sessionId: String(frame.sessionId),
        questions: Array.isArray(frame.questions) ? frame.questions : [],
        rawRequest: frame.rawRequest,
        createdAt: Date.now(),
      }
      activeInteractions.set(interaction.sessionId, interaction)
      publishToUiSession(interaction)
      renderQuestionCardIfActive(interaction.sessionId)
    }

    function handleInteractionCancel(eventId, sessionId) {
      unpublishFromUiSession(eventId)
      const existing = activeInteractions.get(sessionId)
      if (existing && existing.eventId === eventId) {
        activeInteractions.delete(sessionId)
        removeQuestionCard(sessionId)
      }
    }

    async function submitInteractionResponse(sessionId, eventId, outcome) {
      try {
        const res = await fetch(SESSION_INTERACTION_RESPOND_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ sessionId, eventId, outcome }),
        })
        const data = await res.json().catch(() => null)
        if (data && data.ok) {
          handleInteractionCancel(eventId, sessionId)
        }
        return data
      } catch (err) {
        console.warn('remote-ssh: failed to submit interaction response:', err)
        return { ok: false, error: err }
      }
    }

    function findComposerSeat(sessionId) {
      if (typeof document === 'undefined') return null
      if (sessionId) {
        const sessionContent = document.querySelector(
          `div[data-conversation-content][data-conversation-session="${sessionId}"]`
        )
        if (sessionContent) {
          const seat = sessionContent.querySelector('div[data-conversation-region="composer"]')
          if (seat) return seat
        }
      }
      const activeContent = document.querySelector('div[data-conversation-content][data-conversation-session]')
      if (activeContent) {
        const curId = activeContent.getAttribute('data-conversation-session')
        if (!sessionId || curId === sessionId) {
          return activeContent.querySelector('div[data-conversation-region="composer"]')
        }
      }
      return document.querySelector('div[data-conversation-region="composer"]')
    }

    function removeQuestionCard(sessionId) {
      if (typeof document === 'undefined') return
      const existing = document.querySelectorAll(
        sessionId
          ? `.dsh-remote-question-card[data-session-id="${sessionId}"]`
          : '.dsh-remote-question-card'
      )
      for (const el of existing) {
        const target = el.closest('.dsh-remote-question-frame') || el
        const parent = target.parentElement
        target.remove()
        if (parent) {
          const hiddenElements = parent.querySelectorAll('.dsh-hide-for-question')
          for (const h of hiddenElements) h.classList.remove('dsh-hide-for-question')
        }
      }
    }

    function renderQuestionCard(interaction) {
      if (typeof document === 'undefined' || !interaction) return
      const seat = findComposerSeat(interaction.sessionId)
      if (!seat) return

      const existingCard = seat.querySelector(`.dsh-remote-question-card[data-event-id="${interaction.eventId}"]`)
      if (existingCard) return

      removeQuestionCard(interaction.sessionId)

      for (const child of seat.children) {
        if (!child.classList.contains('dsh-remote-question-frame') && !child.classList.contains('dsh-remote-question-card')) {
          child.classList.add('dsh-hide-for-question')
        }
      }

      const questions = Array.isArray(interaction.questions) ? interaction.questions : []
      if (questions.length === 0) return

      const selectedAnswers = new Map()
      const customAnswers = new Map()
      let activeIndex = 0

      for (const q of questions) {
        selectedAnswers.set(q.id, [])
        customAnswers.set(q.id, '')
      }

      const frame = document.createElement('div')
      frame.className = 'dsh-remote-question-frame'
      frame.dataset.questionKey = interaction.eventId

      const card = document.createElement('section')
      card.className = 'dsh-remote-question-card'
      card.dataset.eventId = interaction.eventId
      card.dataset.sessionId = interaction.sessionId
      frame.appendChild(card)

      function renderView() {
        const q = questions[activeIndex] || questions[0]
        const isMulti = Boolean(q.multiSelect)
        const options = Array.isArray(q.options) ? q.options : []
        const currentSelected = selectedAnswers.get(q.id) || []
        const currentCustom = customAnswers.get(q.id) || ''
        const isLast = activeIndex === questions.length - 1

        let optionsHtml = ''
        for (let j = 0; j < options.length; j++) {
          const opt = options[j]
          const optLabel = typeof opt === 'string' ? opt : opt.label || ''
          const optDesc = typeof opt === 'object' && opt.description ? opt.description : ''
          const isRec = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i.test(optLabel)
          const cleanLabel = optLabel.replace(/\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i, '')
          const isSel = currentSelected.includes(optLabel)

          optionsHtml += `
            <div class="dsh-rq-option ${isSel ? 'dsh-rq-selected' : ''}" data-qid="${escapeHtml(q.id)}" data-value="${escapeHtml(optLabel)}" data-multi="${isMulti}" role="${isMulti ? 'checkbox' : 'radio'}" aria-checked="${isSel}">
              <input type="${isMulti ? 'checkbox' : 'radio'}" name="opt_${escapeHtml(q.id)}" class="dsh-rq-opt-input" ${isSel ? 'checked' : ''} style="display:none;" />
              ${isMulti
                ? `<span class="dsh-rq-checkbox ${isSel ? 'dsh-rq-checkbox-checked' : ''}">
                     <svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                   </span>`
                : `<span class="dsh-rq-number">${j + 1}</span>`
              }
              <div class="dsh-rq-opt-content">
                <div class="dsh-rq-opt-label-row">
                  <span class="dsh-rq-opt-label">${escapeHtml(cleanLabel)}</span>
                  ${isRec ? '<span class="dsh-rq-badge dsh-rq-rec-tag">推荐</span>' : ''}
                </div>
                ${optDesc ? `<div class="dsh-rq-opt-desc">${escapeHtml(optDesc)}</div>` : ''}
              </div>
            </div>
          `
        }

        const isCustomActive = currentCustom.trim() !== ''
        const customRowHtml = `
          <div class="dsh-rq-custom-row ${isCustomActive ? 'dsh-rq-custom-active' : ''}">
            ${isMulti
              ? `<span class="dsh-rq-checkbox ${isCustomActive ? 'dsh-rq-checkbox-checked' : ''}">
                   <svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                 </span>`
              : `<span class="dsh-rq-number dsh-rq-custom-icon">
                   <svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8.85596 2.69971H4.19971C3.37141 2.69971 2.69992 3.37146 2.69971 4.19971V11.8003C2.69992 12.6285 3.37141 13.3003 4.19971 13.3003H11.8003C12.6283 13.2999 13.3001 12.6283 13.3003 11.8003V7.89893H14.3003V11.8003C14.3001 13.1806 13.1806 14.2999 11.8003 14.3003H4.19971C2.81913 14.3003 1.69992 13.1808 1.69971 11.8003V4.19971C1.69992 2.81918 2.81913 1.69971 4.19971 1.69971H8.85596V2.69971Z" fill="currentColor"/><path d="M7.7849 8.23878L13.888 2.13574" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>
                 </span>`
            }
            <div class="dsh-rq-field-wrap">
              <textarea class="dsh-rq-custom-text" placeholder="输入你的答案" rows="1">${escapeHtml(currentCustom)}</textarea>
            </div>
          </div>
        `

        card.innerHTML = `
          <header class="dsh-rq-header">
            <div class="dsh-rq-heading-block">
              ${q.header ? `<div class="dsh-rq-eyebrow">${escapeHtml(q.header)}</div>` : ''}
              <h2 class="dsh-rq-title">${escapeHtml(q.question || '请选择或输入回答')}</h2>
            </div>
            <div class="dsh-rq-header-actions">
              <button type="button" class="dsh-rq-icon-button dsh-rq-btn-cancel" aria-label="关闭" title="放弃这组问题">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3.5 3.5L12.5 12.5M12.5 3.5L3.5 12.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
              </button>
            </div>
          </header>
          <div class="dsh-rq-body">
            ${q.detail ? `<div class="dsh-rq-detail">${escapeHtml(q.detail)}</div>` : ''}
            <div class="dsh-rq-options" role="${isMulti ? 'group' : 'radiogroup'}">
              ${optionsHtml}
              ${customRowHtml}
            </div>
          </div>
          <footer class="dsh-rq-footer">
            <div class="dsh-rq-pager" style="${questions.length <= 1 ? 'display: none;' : ''}">
              <button type="button" class="dsh-rq-icon-button dsh-rq-pager-prev" aria-label="上一题" ${activeIndex === 0 ? 'disabled' : ''}>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 3.5L5.5 8L10 12.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
              <span class="dsh-rq-progress">${activeIndex + 1} / ${questions.length}</span>
              <button type="button" class="dsh-rq-icon-button dsh-rq-pager-next" aria-label="下一题" ${isLast ? 'disabled' : ''}>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
            </div>
            <div class="dsh-rq-feedback" role="status"></div>
            <div class="dsh-rq-footer-actions">
              <button type="button" class="dsh-rq-btn dsh-rq-btn-outline dsh-rq-btn-cancel dsh-rq-btn-skip">跳过</button>
              <button type="button" class="dsh-rq-btn dsh-rq-btn-primary dsh-rq-btn-submit">${isLast ? '提交' : '下一题'}</button>
            </div>
          </footer>
        `

        // Bind Option clicks
        const optElements = card.querySelectorAll('.dsh-rq-option')
        for (const optEl of optElements) {
          optEl.addEventListener('click', (ev) => {
            const input = optEl.querySelector('input')
            const qid = optEl.dataset.qid
            const val = optEl.dataset.value
            const optIsMulti = optEl.dataset.multi === 'true'

            if (optIsMulti) {
              const cur = selectedAnswers.get(qid) || []
              const exists = cur.includes(val)
              const next = exists ? cur.filter((x) => x !== val) : [...cur, val]
              selectedAnswers.set(qid, next)
              optEl.classList.toggle('dsh-rq-selected', !exists)
              const chk = optEl.querySelector('.dsh-rq-checkbox')
              if (chk) chk.classList.toggle('dsh-rq-checkbox-checked', !exists)
              if (input) input.checked = !exists
            } else {
              const siblings = card.querySelectorAll(`.dsh-rq-option[data-qid="${qid}"]`)
              for (const sib of siblings) {
                sib.classList.remove('dsh-rq-selected')
                const sibInput = sib.querySelector('input')
                if (sibInput) sibInput.checked = false
              }
              optEl.classList.add('dsh-rq-selected')
              if (input) input.checked = true
              selectedAnswers.set(qid, [val])
            }
          })
        }

        // Bind Custom Textarea
        const ta = card.querySelector('.dsh-rq-custom-text')
        if (ta) {
          ta.addEventListener('input', () => {
            customAnswers.set(q.id, ta.value)
            const row = ta.closest('.dsh-rq-custom-row')
            if (row) {
              row.classList.toggle('dsh-rq-custom-active', ta.value.trim() !== '')
              const chk = row.querySelector('.dsh-rq-checkbox')
              if (chk) chk.classList.toggle('dsh-rq-checkbox-checked', ta.value.trim() !== '')
            }
          })
        }

        // Bind Pager
        const prevBtn = card.querySelector('.dsh-rq-pager-prev')
        if (prevBtn) {
          prevBtn.addEventListener('click', () => {
            if (activeIndex > 0) {
              activeIndex--
              renderView()
            }
          })
        }
        const nextBtn = card.querySelector('.dsh-rq-pager-next')
        if (nextBtn) {
          nextBtn.addEventListener('click', () => {
            if (activeIndex < questions.length - 1) {
              activeIndex++
              renderView()
            }
          })
        }

        // Bind Submit / Next button
        const submitBtn = card.querySelector('.dsh-rq-btn-submit')
        const cancelBtn = card.querySelector('.dsh-rq-icon-button.dsh-rq-btn-cancel')
        const skipBtn = card.querySelector('.dsh-rq-btn-skip')
        const feedbackEl = card.querySelector('.dsh-rq-feedback')

        submitBtn.addEventListener('click', async () => {
          if (!isLast) {
            activeIndex++
            renderView()
            return
          }

          submitBtn.disabled = true
          if (skipBtn) skipBtn.disabled = true
          if (cancelBtn) cancelBtn.disabled = true
          submitBtn.textContent = '提交中...'

          const answers = questions.map((item) => {
            const selected = selectedAnswers.get(item.id) || []
            const custom = (customAnswers.get(item.id) || '').trim()
            return {
              id: item.id,
              selected: custom === '' || item.multiSelect === true ? selected : [],
              ...(custom === '' ? {} : { custom }),
            }
          })

          const outcome = {
            kind: 'result',
            value: { answers },
          }

          const res = await submitInteractionResponse(interaction.sessionId, interaction.eventId, outcome)
          if (!res || !res.ok) {
            submitBtn.disabled = false
            if (skipBtn) skipBtn.disabled = false
            if (cancelBtn) cancelBtn.disabled = false
            submitBtn.textContent = '提交'
            if (feedbackEl) feedbackEl.textContent = res?.error?.message || '提交失败，请重试'
          }
        })

        // Cancel / Dismiss / Skip
        const doDismiss = async () => {
          submitBtn.disabled = true
          if (skipBtn) skipBtn.disabled = true
          if (cancelBtn) cancelBtn.disabled = true
          if (cancelBtn) cancelBtn.textContent = '已取消'
          if (skipBtn) skipBtn.textContent = '已跳过'

          const outcome = {
            kind: 'rejected',
            error: {
              name: 'UserQuestionError',
              message: 'the user cancelled ask_user_question',
              code: 'ASK_CANCELLED',
            },
          }
          await submitInteractionResponse(interaction.sessionId, interaction.eventId, outcome)
        }

        if (cancelBtn) cancelBtn.addEventListener('click', doDismiss)
        if (skipBtn) skipBtn.addEventListener('click', doDismiss)
      }

      renderView()
      seat.appendChild(frame)
    }

    function checkAndRenderActiveQuestion() {
      if (typeof document === 'undefined') return
      const activeContent = document.querySelector('div[data-conversation-content][data-conversation-session]')
      const activeSessionId = activeContent?.getAttribute('data-conversation-session')
      if (activeSessionId && activeInteractions.has(activeSessionId)) {
        renderQuestionCard(activeInteractions.get(activeSessionId))
      } else if (activeSessionId) {
        const card = document.querySelector('.dsh-remote-question-card')
        if (card && card.dataset.sessionId !== activeSessionId) {
          removeQuestionCard()
        }
      }
    }

    function renderQuestionCardIfActive(sessionId) {
      if (typeof document === 'undefined') return
      const activeContent = document.querySelector('div[data-conversation-content][data-conversation-session]')
      const activeSessionId = activeContent?.getAttribute('data-conversation-session')
      if (!activeSessionId || activeSessionId === sessionId) {
        const interaction = activeInteractions.get(sessionId)
        if (interaction) renderQuestionCard(interaction)
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
          /* Question composer container and card (1:1 with official QuestionComposer) */
          .dsh-remote-question-frame {
            display: flex;
            justify-content: center;
            padding: 0 var(--dsh-composer-side-clearance, 24px) 10px;
            width: 100%;
            box-sizing: border-box;
          }
          .dsh-remote-question-card {
            display: flex;
            flex-direction: column;
            width: 100%;
            max-width: var(--dsh-composer-card-max-width, 952px);
            max-height: min(60vh, 520px);
            padding: 0 0 10px;
            border: 0;
            border-radius: var(--dsw-radius-xl, 16px);
            background: var(--dsw-specific-input-major, #ffffff);
            box-shadow: var(--dsw-elevation-panel, 0 8px 32px rgba(0, 0, 0, 0.12));
            color: var(--dsw-alias-label-primary, #1e293b);
            overflow: hidden;
            box-sizing: border-box;
            font-family: inherit;
            user-select: none;
          }
          .dsh-remote-question-card * {
            box-sizing: border-box;
          }

          /* Header */
          .dsh-rq-header {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 16px;
            flex-shrink: 0;
            padding: 20px 16px 0 24px;
          }
          .dsh-rq-heading-block {
            min-width: 0;
            flex: 1;
          }
          .dsh-rq-eyebrow {
            margin-bottom: 5px;
            color: var(--dsw-alias-label-tertiary, #94a3b8);
            font-size: 11px;
            line-height: 16px;
          }
          .dsh-rq-title {
            margin: 0;
            font-size: 16px;
            line-height: 22px;
            font-weight: 500;
            color: var(--dsw-alias-label-primary, inherit);
          }
          .dsh-rq-header-actions {
            display: flex;
            align-items: center;
            gap: 4px;
            flex-shrink: 0;
          }
          .dsh-rq-icon-button {
            display: grid;
            place-items: center;
            width: 24px;
            height: 24px;
            padding: 0;
            border: none;
            border-radius: 999px;
            background: transparent;
            color: var(--dsw-alias-label-tertiary, #94a3b8);
            cursor: pointer;
            transition: background-color 120ms ease, color 120ms ease;
          }
          .dsh-rq-icon-button:hover:not(:disabled) {
            background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05));
            color: var(--dsw-alias-label-primary, inherit);
          }
          .dsh-rq-icon-button:disabled {
            opacity: 0.35;
            cursor: not-allowed;
          }

          /* Body */
          .dsh-rq-body {
            flex: 1 1 auto;
            display: flex;
            flex-direction: column;
            min-height: 0;
            overflow-y: auto;
            overscroll-behavior: contain;
            padding: 0;
          }
          .dsh-rq-detail {
            margin: 4px 24px 8px;
            color: var(--dsw-alias-label-secondary, #64748b);
            font-size: 13px;
            line-height: 20px;
          }
          .dsh-rq-options {
            display: flex;
            flex-direction: column;
            gap: 2px;
            margin: 8px 0 0;
            padding: 4px 12px;
          }

          /* Option row */
          .dsh-rq-option {
            display: flex;
            align-items: flex-start;
            gap: 8px;
            width: 100%;
            min-height: 40px;
            flex-shrink: 0;
            padding: 8px 12px 8px 8px;
            border: 1px solid transparent;
            border-radius: var(--dsw-radius-md, 8px);
            background: transparent;
            color: inherit;
            text-align: left;
            cursor: pointer;
            transition: background-color 120ms ease, border-color 120ms ease;
          }
          .dsh-rq-option:hover,
          .dsh-rq-option.dsh-rq-selected {
            background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.04));
          }
          .dsh-rq-option.dsh-rq-selected {
            border-color: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
          }

          /* Number badge (20x20) */
          .dsh-rq-number {
            display: grid;
            place-items: center;
            flex: 0 0 20px;
            width: 20px;
            height: 20px;
            margin-top: 2px;
            border-radius: var(--dsw-radius-xs, 4px);
            background: var(--dsw-alias-bg-overlay, rgba(0, 0, 0, 0.06));
            color: var(--dsw-alias-label-secondary, #64748b);
            font-size: 12px;
            font-weight: 500;
            line-height: 18px;
          }

          /* Checkbox (20x20 container with 14x14 box) */
          .dsh-rq-checkbox {
            display: grid;
            place-items: center;
            flex: 0 0 20px;
            width: 20px;
            height: 20px;
            margin-top: 2px;
            border: 0.5px solid var(--dsw-alias-border-l4, rgba(0, 0, 0, 0.2));
            border-radius: var(--dsw-radius-xs, 4px);
            background: transparent;
            color: transparent;
            transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
          }
          .dsh-rq-checkbox.dsh-rq-checkbox-checked {
            border-color: var(--dsw-alias-label-primary, #000000);
            background: var(--dsw-alias-label-primary, #000000);
            color: var(--dsw-alias-label-primary-foreground, #ffffff);
          }
          .dsh-rq-checkbox svg {
            display: block;
          }

          /* Option copy */
          .dsh-rq-opt-content {
            min-width: 0;
            flex: 1;
          }
          .dsh-rq-opt-label-row {
            display: flex;
            align-items: baseline;
            flex-wrap: wrap;
            gap: 2px 6px;
          }
          .dsh-rq-opt-label {
            font-size: 14px;
            line-height: 24px;
            font-weight: 500;
            color: var(--dsw-alias-label-primary, inherit);
          }
          .dsh-rq-badge {
            padding: 0 4px;
            border-radius: var(--dsw-radius-xs, 4px);
            background: var(--dsw-specific-sidebar-nav-item-active-accent, rgba(37, 99, 235, 0.12));
            color: var(--dsw-alias-button-info-fill, #2563eb);
            font-size: 11px;
            line-height: 18px;
            font-weight: 600;
          }
          .dsh-rq-opt-desc {
            color: var(--dsw-alias-label-tertiary, #94a3b8);
            font-size: 14px;
            line-height: 24px;
            font-weight: 400;
          }

          /* Custom row */
          .dsh-rq-custom-row {
            display: flex;
            align-items: flex-start;
            gap: 8px;
            width: 100%;
            min-height: 40px;
            flex-shrink: 0;
            padding: 8px 12px 8px 8px;
            border: 1px solid transparent;
            border-radius: var(--dsw-radius-md, 8px);
            transition: background-color 120ms ease, border-color 120ms ease;
          }
          .dsh-rq-custom-row:hover,
          .dsh-rq-custom-row:focus-within,
          .dsh-rq-custom-row.dsh-rq-custom-active {
            background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.04));
          }
          .dsh-rq-custom-row:focus-within,
          .dsh-rq-custom-row.dsh-rq-custom-active {
            border-color: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
          }
          .dsh-rq-field-wrap {
            flex: 1;
            min-width: 0;
          }
          .dsh-rq-custom-text {
            width: 100%;
            border: none;
            outline: none;
            background: transparent;
            resize: none;
            overflow-y: auto;
            font-family: inherit;
            font-size: 14px;
            line-height: 24px;
            color: var(--dsw-alias-label-primary, inherit);
            caret-color: var(--dsw-alias-state-business-primary, #2563eb);
          }
          .dsh-rq-custom-text::placeholder {
            color: var(--dsw-alias-label-caption, #94a3b8);
          }

          /* Footer */
          .dsh-rq-footer {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            flex-shrink: 0;
            margin-top: 12px;
            padding: 0 10px 0 18px;
          }
          .dsh-rq-pager {
            display: flex;
            align-items: center;
            gap: 6px;
            flex-shrink: 0;
          }
          .dsh-rq-progress {
            padding: 0 4px;
            color: var(--dsw-alias-label-secondary, #64748b);
            font-size: 14px;
            line-height: 24px;
            font-weight: 500;
            white-space: nowrap;
          }
          .dsh-rq-feedback {
            flex: 1;
            min-height: 16px;
            color: var(--dsw-alias-state-error-primary, #ef4444);
            font-size: 11px;
            line-height: 16px;
            text-align: right;
          }
          .dsh-rq-footer-actions {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-shrink: 0;
          }
          .dsh-rq-btn {
            box-sizing: border-box;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            height: 36px;
            padding: 0 14px;
            border-radius: var(--dsw-radius-md, 8px);
            cursor: pointer;
            font-family: inherit;
            font-size: 14px;
            line-height: 22px;
            transition: all 120ms ease;
          }
          .dsh-rq-btn:disabled {
            cursor: not-allowed;
            opacity: 0.4;
          }
          .dsh-rq-btn-outline {
            border: 0.5px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.15));
            background: transparent;
            color: var(--dsw-alias-label-primary, inherit);
          }
          .dsh-rq-btn-outline:hover:not(:disabled) {
            background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05));
          }
          .dsh-rq-btn-primary {
            border: none;
            background: var(--dsw-alias-button-primary-fill, #2563eb);
            color: var(--dsw-alias-label-primary-foreground, #ffffff);
            font-weight: 500;
          }
          .dsh-rq-btn-primary:hover:not(:disabled) {
            background: var(--dsw-alias-button-primary-hover, #1d4ed8);
          }
          .dsh-hide-for-question {
            display: none !important;
          }
          /* Remote SSH Settings Card */
          .dsh-remote-settings-card {
            box-sizing: border-box;
            width: 100%;
            margin-top: 16px;
            padding: 20px 24px;
            border-radius: var(--dsw-radius-lg, 12px);
            background: var(--dsw-alias-bg-layer-2, #ffffff);
            border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08));
            color: var(--dsw-alias-label-primary, #1e293b);
            font-family: inherit;
          }
          .dsh-sc-head {
            margin-bottom: 16px;
            padding-bottom: 12px;
            border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08));
          }
          .dsh-sc-title-row {
            display: flex;
            align-items: center;
            gap: 8px;
          }
          .dsh-sc-icon {
            color: var(--dsw-alias-button-primary-fill, #2563eb);
            flex-shrink: 0;
          }
          .dsh-sc-title {
            margin: 0;
            font-size: 15px;
            font-weight: 600;
            line-height: 22px;
          }
          .dsh-sc-desc {
            margin: 4px 0 0;
            color: var(--dsw-alias-label-secondary, #64748b);
            font-size: 12px;
            line-height: 18px;
          }
          .dsh-sc-section {
            margin-top: 14px;
          }
          .dsh-sc-section-title {
            font-size: 13px;
            font-weight: 500;
            margin-bottom: 6px;
            color: var(--dsw-alias-label-primary, inherit);
          }
          .dsh-sc-hint {
            margin: 0 0 8px;
            font-size: 12px;
            color: var(--dsw-alias-label-tertiary, #94a3b8);
          }
          .dsh-sc-hosts-list {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-bottom: 8px;
          }
          .dsh-sc-host-item {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 4px 10px;
            border-radius: 999px;
            background: var(--dsw-alias-bg-module-platform, rgba(0, 0, 0, 0.05));
            font-size: 12px;
          }
          .dsh-sc-dot {
            width: 7px;
            height: 7px;
            border-radius: 50%;
            background: #10b981;
          }
          .dsh-sc-badge {
            font-size: 10px;
            color: #10b981;
            font-weight: 500;
          }
          .dsh-sc-row {
            display: flex;
            align-items: center;
            gap: 10px;
          }
          .dsh-remote-host-select {
            flex: 1;
            height: 36px;
            padding: 0 12px;
            border-radius: var(--dsw-radius-md, 8px);
            border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.15));
            background: var(--dsw-alias-bg-layer-3, #ffffff);
            color: var(--dsw-alias-label-primary, inherit);
            font-family: inherit;
            font-size: 13px;
            outline: none;
            cursor: pointer;
          }
          .dsh-remote-host-select:focus {
            border-color: var(--dsw-alias-brand-primary, #2563eb);
          }
          .dsh-sc-feedback {
            margin-top: 8px;
            font-size: 12px;
            line-height: 18px;
          }
          .dsh-sc-feedback.dsh-sc-success {
            color: #10b981;
          }
          .dsh-sc-feedback.dsh-sc-error {
            color: #ef4444;
          }

          /* Workspace Header Add Remote Button — mirrors official .iconButton */
          .dsh-btn-add-remote-workspace {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 28px;
            height: 28px;
            padding: 0;
            border: none;
            border-radius: var(--dsw-radius-sm, 6px);
            background: transparent;
            color: var(--dsw-alias-label-secondary, #64748b);
            cursor: pointer;
            flex: none;
            transition: background 120ms ease, color 120ms ease;
          }
          .dsh-btn-add-remote-workspace:hover {
            background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05));
          }
          .dsh-btn-add-remote-workspace:focus-visible {
            outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #2563eb));
            outline-offset: -2px;
          }
          .dsh-add-remote-popover {
            position: fixed;
            z-index: 10000;
            box-sizing: border-box;
            width: 320px;
            max-width: 90vw;
            padding: 16px;
            border-radius: var(--dsw-radius-lg, 12px);
            border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
            background: var(--dsw-alias-bg-layer-2, #ffffff);
            color: var(--dsw-alias-label-primary, #1e293b);
            box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.15), 0 8px 10px -6px rgba(0, 0, 0, 0.1);
            font-family: inherit;
          }
          .dsh-popover-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 8px;
          }
          .dsh-popover-title-row {
            display: flex;
            align-items: center;
            gap: 6px;
            font-weight: 600;
            font-size: 13px;
          }
          .dsh-popover-close-btn {
            border: none;
            background: transparent;
            color: var(--dsw-alias-label-tertiary, #94a3b8);
            font-size: 16px;
            line-height: 1;
            padding: 2px 6px;
            cursor: pointer;
            border-radius: 4px;
          }
          .dsh-popover-close-btn:hover {
            background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05));
            color: var(--dsw-alias-label-primary, inherit);
          }
          .dsh-popover-hint {
            font-size: 11px;
            line-height: 16px;
            color: var(--dsw-alias-label-secondary, #64748b);
            margin-bottom: 12px;
          }
          .dsh-popover-body {
            max-height: 260px;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 2px;
          }
          .dsh-popover-section {
            display: flex;
            flex-direction: column;
            gap: 2px;
          }
          .dsh-popover-section-title {
            font-size: 11px;
            line-height: 16px;
            color: var(--dsw-alias-label-tertiary, #94a3b8);
            padding: 4px 2px 0;
          }
          .dsh-popover-section-list {
            display: flex;
            flex-direction: column;
            gap: 2px;
          }
          .dsh-remote-popover-item {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            padding: 4px 10px;
            border-radius: var(--dsw-radius-md, 8px);
            background: var(--dsw-alias-bg-module-platform, rgba(0, 0, 0, 0.04));
            transition: background 120ms ease;
          }
          .dsh-remote-popover-item:hover {
            background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.08));
          }
          .dsh-remote-popover-item-info {
            flex: 1;
            min-width: 0;
          }
          .dsh-remote-popover-item-name {
            font-size: 13px;
            font-weight: 500;
            color: var(--dsw-alias-label-primary, inherit);
          }
          .dsh-remote-popover-item-detail {
            font-size: 11px;
            color: var(--dsw-alias-label-tertiary, #94a3b8);
            margin-top: 2px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }
          /* Minimal icon-only add button inside the popover host rows */
          .dsh-remote-popover-item-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            width: 28px;
            height: 28px;
            padding: 0;
            border: none;
            border-radius: var(--dsw-radius-sm, 6px);
            background: transparent;
            color: var(--dsw-alias-label-secondary, #64748b);
            cursor: pointer;
            transition: background 120ms ease, color 120ms ease;
          }
          .dsh-remote-popover-item-btn:hover {
            background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05));
            color: var(--dsw-alias-label-primary, inherit);
          }
          .dsh-remote-popover-item-btn:focus-visible {
            outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #2563eb));
            outline-offset: -2px;
          }
          .dsh-remote-popover-item-btn:disabled {
            cursor: default;
            opacity: 0.75;
          }
          /* Disconnect action for already-connected hosts — active blue. */
          .dsh-remote-popover-item-btn--disconnect {
            color: var(--dsw-alias-state-business-primary, var(--dsw-alias-color-brand-default, #2563eb));
          }
          .dsh-remote-popover-item-btn--disconnect:hover {
            background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05));
            color: var(--dsw-alias-state-business-primary, var(--dsw-alias-color-brand-default, #2563eb));
          }
          /* Transient "connected" success state after a successful connect. */
          .dsh-remote-popover-item-btn--success {
            color: var(--dsw-alias-state-business-primary, var(--dsw-alias-color-brand-default, #2563eb));
          }
          .dsh-popover-empty {
            text-align: center;
            padding: 16px 8px;
            color: var(--dsw-alias-label-secondary, #64748b);
            font-size: 12px;
          }
          .dsh-popover-empty-desc {
            font-size: 11px;
            color: var(--dsw-alias-label-tertiary, #94a3b8);
            margin-top: 4px;
          }
          .dsh-popover-feedback {
            font-size: 11px;
            margin-top: 6px;
            line-height: 16px;
          }
          .dsh-popover-feedback.dsh-feedback-success {
            color: #10b981;
          }
          .dsh-popover-feedback.dsh-feedback-error {
            color: #ef4444;
          }

          /* Official-style Tooltip bubble (mirrors Tooltip.module.css tokens) */
          .dsh-remote-tooltip {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            position: fixed;
            z-index: 100;
            width: max-content;
            max-width: 50vw;
            padding: 3px 7px;
            border-radius: var(--dsw-radius-sm, 6px);
            background: var(--dsw-alias-tooltip-bg, #0f1115);
            color: var(--dsw-static-neutral-bluish-00, #f9fafb);
            font-size: 13px;
            line-height: 20px;
            white-space: pre-line;
            overflow-wrap: break-word;
            pointer-events: none;
            animation: dsh-remote-tooltip-in 150ms var(--ds-ease-in-out, ease);
          }
          .dsh-remote-tooltip[data-side='bottom'] {
            transform: translateX(-50%);
          }
          .dsh-remote-tooltip[data-side='top'] {
            transform: translate(-50%, -100%);
          }
          .dsh-remote-tooltip[data-side='right'] {
            transform: translateY(-50%);
          }
          .dsh-remote-tooltip-label {
            min-width: 0;
          }
          @keyframes dsh-remote-tooltip-in {
            from { opacity: 0; }
          }
          @media (prefers-reduced-motion: reduce) {
            .dsh-remote-tooltip {
              animation: none;
            }
          }

          /* Official-style success Toast (mirrors Toast.module.css tokens) */
          .dsh-remote-toast {
            position: fixed;
            top: 40px;
            left: 50%;
            z-index: 1100;
            pointer-events: none;
            display: flex;
            align-items: center;
            gap: 10px;
            width: max-content;
            max-width: min(640px, calc(100vw - 48px));
            padding: 12px 16px;
            border-radius: var(--dsw-radius-lg, 12px);
            background: var(--dsw-alias-toast-bg, #1f2937);
            color: var(--dsw-alias-toast-label, #f9fafb);
            font-size: 14px;
            line-height: 22px;
            box-shadow: var(--dsw-shadow-lv3, 0 10px 25px -5px rgba(0, 0, 0, 0.15));
            transform: translateX(-50%);
            animation:
              dsh-remote-toast-in 160ms ease-out,
              dsh-remote-toast-fade 1000ms ease var(--dsh-toast-hold, 3000ms) forwards;
          }
          .dsh-remote-toast-icon {
            display: grid;
            place-items: center;
            flex: none;
            color: var(--dsw-alias-state-warn-label, #f59e0b);
          }
          .dsh-remote-toast-icon--success {
            color: var(--dsw-alias-state-success-primary, #10b981);
          }
          .dsh-remote-toast-text {
            min-width: 0;
          }
          @keyframes dsh-remote-toast-in {
            from { opacity: 0; transform: translate(-50%, -6px); }
            to { opacity: 1; transform: translate(-50%, 0); }
          }
          @keyframes dsh-remote-toast-fade {
            to { opacity: 0; visibility: hidden; }
          }
          @media (prefers-reduced-motion: reduce) {
            .dsh-remote-toast {
              animation: dsh-remote-toast-fade 1000ms ease var(--dsh-toast-hold, 3000ms) forwards;
            }
          }

          /* Loading spinner used by the host add icon button while connecting */
          .dsh-remote-spinner {
            width: 16px;
            height: 16px;
            border-radius: 50%;
            border: 2px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
            border-top-color: var(--dsw-alias-label-secondary, #64748b);
            animation: dsh-remote-spin 0.8s linear infinite;
          }
          @keyframes dsh-remote-spin {
            to { transform: rotate(360deg); }
          }
        `
        document.head.appendChild(tag)
      }
      return () => {
        const el = (typeof document.getElementById === 'function' ? document.getElementById(STYLE_TAG_ID) : null) || document.querySelector?.(`#${STYLE_TAG_ID}`)
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

    function findSettingsContainer() {
      if (typeof document === 'undefined') return null
      return (
        document.querySelector('.VOzbGW_options') ||
        document.querySelector('[class*="VOzbGW_options"]') ||
        document.querySelector('.VOzbGW_panel') ||
        document.querySelector('[class*="VOzbGW_panel"]') ||
        document.querySelector('div[role="tabpanel"]')
      )
    }

    function removeSettingsCard() {
      if (typeof document === 'undefined') return
      const card = (typeof document.getElementById === 'function' ? document.getElementById('dsh-remote-settings-card') : null) || document.querySelector?.('#dsh-remote-settings-card')
      if (card) card.remove()
    }

    let isFetchingAvailableHosts = false

    async function refreshSettingsCard(card, ctx) {
      if (isFetchingAvailableHosts) return
      isFetchingAvailableHosts = true
      try {
        const res = await fetch(AVAILABLE_HOSTS_ROUTE)
        if (!res.ok) return
        const data = await parseJsonResponse(res)
        if (!data) return
        const currentHosts = Array.isArray(data.currentHosts) ? data.currentHosts : []
        const availableHosts = Array.isArray(data.availableHosts) ? data.availableHosts : []

        // 1. Update connected hosts list
        const hostsListEl = card.querySelector('.dsh-sc-hosts-list')
        if (hostsListEl) {
          hostsListEl.textContent = ''
          if (currentHosts.length === 0) {
            const emptySpan = document.createElement('span')
            emptySpan.className = 'dsh-sc-hint'
            emptySpan.textContent = '暂无已连接的主机'
            hostsListEl.appendChild(emptySpan)
          } else {
            for (const host of currentHosts) {
              const item = document.createElement('span')
              item.className = 'dsh-sc-host-item'
              const dot = document.createElement('span')
              dot.className = 'dsh-sc-dot'
              const nameSpan = document.createElement('span')
              nameSpan.textContent = host
              const badge = document.createElement('span')
              badge.className = 'dsh-sc-badge'
              badge.textContent = '已连接'
              item.appendChild(dot)
              item.appendChild(nameSpan)
              item.appendChild(badge)
              hostsListEl.appendChild(item)
            }
          }
        }

        // 2. Update select dropdown
        const select = card.querySelector('.dsh-remote-host-select')
        const addBtn = card.querySelector('.dsh-remote-btn-add-host')
        if (select) {
          select.textContent = ''
          if (availableHosts.length === 0) {
            const opt = document.createElement('option')
            opt.value = ''
            opt.textContent = '无未添加的可用主机 (请检查 ~/.ssh/config 密钥配置)'
            opt.disabled = true
            select.appendChild(opt)
            select.disabled = true
            if (addBtn) addBtn.disabled = true
          } else {
            select.disabled = false
            for (const h of availableHosts) {
              const opt = document.createElement('option')
              opt.value = h.host
              const detail = h.hostName ? ` (${h.hostName})` : ''
              opt.textContent = `${h.host}${detail}`
              select.appendChild(opt)
            }
            select.value = availableHosts[0]?.host || ''
            if (addBtn) addBtn.disabled = false
          }
        }
      } catch (_) {
      } finally {
        isFetchingAvailableHosts = false
      }
    }

    function checkAndRenderSettingsCard(ctx) {
      if (typeof document === 'undefined') return
      const container = findSettingsContainer()
      if (!container) return
      if (container.querySelector('#dsh-remote-settings-card')) return

      const card = document.createElement('section')
      card.id = 'dsh-remote-settings-card'
      card.className = 'dsh-remote-settings-card'

      const head = document.createElement('div')
      head.className = 'dsh-sc-head'
      const titleRow = document.createElement('div')
      titleRow.className = 'dsh-sc-title-row'
      const title = document.createElement('h3')
      title.className = 'dsh-sc-title'
      title.textContent = '远程主机聚合 (Remote SSH)'
      titleRow.appendChild(title)
      const desc = document.createElement('div')
      desc.className = 'dsh-sc-desc'
      desc.textContent = '从本机 ~/.ssh/config 密钥配置中选择并添加远程主机，会话与工作区自动同步。'
      head.appendChild(titleRow)
      head.appendChild(desc)
      card.appendChild(head)

      const connectedSec = document.createElement('div')
      connectedSec.className = 'dsh-sc-section'
      const secTitle1 = document.createElement('div')
      secTitle1.className = 'dsh-sc-section-title'
      secTitle1.textContent = '已连接主机'
      const hostsList = document.createElement('div')
      hostsList.className = 'dsh-sc-hosts-list'
      connectedSec.appendChild(secTitle1)
      connectedSec.appendChild(hostsList)
      card.appendChild(connectedSec)

      const addSec = document.createElement('div')
      addSec.className = 'dsh-sc-section'
      const secTitle2 = document.createElement('div')
      secTitle2.className = 'dsh-sc-section-title'
      secTitle2.textContent = '添加远程主机'
      const hint = document.createElement('div')
      hint.className = 'dsh-sc-hint'
      hint.textContent = '仅展示本地 ~/.ssh/config 中已配置密钥且尚未连接的主机。'
      const row = document.createElement('div')
      row.className = 'dsh-sc-row'
      const select = document.createElement('select')
      select.className = 'dsh-remote-host-select'
      const addBtn = document.createElement('button')
      addBtn.className = 'dsw-button dsw-button--primary dsh-remote-btn-add-host'
      addBtn.textContent = '添加主机'
      row.appendChild(select)
      row.appendChild(addBtn)
      const feedbackEl = document.createElement('div')
      feedbackEl.className = 'dsh-sc-feedback'
      addSec.appendChild(secTitle2)
      addSec.appendChild(hint)
      addSec.appendChild(row)
      addSec.appendChild(feedbackEl)
      card.appendChild(addSec)

      select.addEventListener('change', () => {
        if (addBtn) addBtn.disabled = !select.value
      })

      addBtn.addEventListener('click', async () => {
        const host = select.value
        if (!host) return
        addBtn.disabled = true
        select.disabled = true
        feedbackEl.className = 'dsh-sc-feedback'
        feedbackEl.textContent = `正在连接并添加主机 ${host}...`
        try {
          const res = await fetch(ADD_HOST_ROUTE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host }),
          })
          const body = await parseJsonResponse(res)
          if (res.ok && body && body.ok) {
            feedbackEl.className = 'dsh-sc-feedback dsh-sc-success'
            feedbackEl.textContent = `主机 ${host} 添加成功！`
            if (ctx) {
              void reconcileRemoteSource(ctx)
            }
            await refreshSettingsCard(card, ctx)
          } else {
            feedbackEl.className = 'dsh-sc-feedback dsh-sc-error'
            feedbackEl.textContent = body.error || '添加主机失败'
            addBtn.disabled = false
            select.disabled = false
          }
        } catch (err) {
          feedbackEl.className = 'dsh-sc-feedback dsh-sc-error'
          feedbackEl.textContent = String(err.message || err)
          addBtn.disabled = false
          select.disabled = false
        }
      })

      container.appendChild(card)
      void refreshSettingsCard(card, ctx)
    }

    function findWorkspaceSectionHeader() {
      if (typeof document === 'undefined') return null
      // Scope the search to the official workspace browser section header so
      // unrelated nodes elsewhere in the DOM (e.g. other "searchSlot"-ish
      // classes from other surfaces) can never hijack the button placement.
      return document.querySelector('[class*="sectionHeader"]') || null
    }

    function findWorkspaceSearchSlot() {
      if (typeof document === 'undefined') return null
      const header = findWorkspaceSectionHeader()
      if (header && typeof header.querySelector === 'function') {
        const slot = header.querySelector('[class*="searchSlot"]')
        if (slot) return slot
      }
      return document.querySelector('.WorkspaceBrowser_searchSlot') || null
    }

    function findWorkspaceHeaderActions() {
      if (typeof document === 'undefined') return null
      const header = findWorkspaceSectionHeader()
      if (!header || typeof header.querySelector !== 'function') return null
      return header.querySelector('[class*="headerActions"]') || null
    }

    /**
     * Pin the add-remote button to the expected slot: immediately left of the
     * search icon in the wide header, or as the leftmost action of the
     * right-aligned header actions group in the rail header. Repositions when
     * the official header re-renders (wide <-> rail toggles swap children).
     * @returns true when the button is (or gets) attached to the header.
     */
    function repositionWorkspaceAddButton(btn) {
      if (typeof document === 'undefined' || !btn) return false
      const searchSlot = findWorkspaceSearchSlot()
      const headerActions = findWorkspaceHeaderActions()
      const header = findWorkspaceSectionHeader()
      if (!header) return false
      if (searchSlot && searchSlot.parentElement && searchSlot.parentElement === header) {
        const children = Array.from(header.children)
        const slotIdx = children.indexOf(searchSlot)
        const btnIdx = children.indexOf(btn)
        if (slotIdx !== -1 && btnIdx !== slotIdx - 1) {
          header.insertBefore(btn, searchSlot)
        }
        return true
      }
      if (headerActions) {
        if (headerActions.children[0] !== btn) {
          headerActions.insertBefore(btn, headerActions.firstChild || null)
        }
        return true
      }
      if (header.children[header.children.length - 1] !== btn) header.appendChild(btn)
      return true
    }

    function removeWorkspaceAddButton() {
      if (typeof document === 'undefined') return
      const btn = (typeof document.getElementById === 'function' ? document.getElementById('dsh-add-remote-workspace-btn') : null) || document.querySelector?.('#dsh-add-remote-workspace-btn')
      if (btn) {
        if (typeof btn._dshTooltipDisposer === 'function') {
          try { btn._dshTooltipDisposer() } catch {}
        }
        btn.remove()
      }
    }

    function removeAddRemotePopover() {
      if (typeof document === 'undefined') return
      const popover = (typeof document.getElementById === 'function' ? document.getElementById('dsh-add-remote-popover') : null) || document.querySelector?.('#dsh-add-remote-popover')
      if (popover) popover.remove()
    }

    /** Connected state: the plug pins visibly enter the socket from the left. */
    const CONNECT_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M1 8h2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><rect x="3" y="4.5" width="3.5" height="7" rx="1.2" stroke="currentColor" stroke-width="1.3"/><path d="M6.5 6h2.5M6.5 10h2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><rect x="9" y="3.5" width="4" height="9" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M13 8h2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>'

    /** Disconnected state: the same horizontal plug is pulled clear of the socket; no slash. */
    const DISCONNECT_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M0.75 8h1.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><rect x="2.25" y="4.5" width="3" height="7" rx="1" stroke="currentColor" stroke-width="1.2"/><path d="M5.25 6h1.5M5.25 10h1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><rect x="10" y="3.5" width="3.5" height="9" rx="1.2" stroke="currentColor" stroke-width="1.2"/><path d="M13.5 8h1.75" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>'

    /** Official `IconCheckCircleOutlineRegular` artwork, used by the success toast. */
    const TOAST_SUCCESS_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M12.5303 6.53027L8.80273 10.2578C8.54967 10.5109 8.31796 10.7439 8.10645 10.9141C7.88375 11.0932 7.616 11.2602 7.27344 11.3145C7.09229 11.3431 6.90771 11.3431 6.72656 11.3145C6.384 11.2602 6.11625 11.0932 5.89355 10.9141C5.68204 10.7439 5.45033 10.5109 5.19727 10.2578L3.46973 8.53027L4.53027 7.46973L6.25781 9.19727C6.53457 9.47402 6.70036 9.63859 6.83398 9.74609C6.95637 9.84453 6.98241 9.83644 6.96094 9.83301C6.98679 9.83709 7.01321 9.83709 7.03906 9.83301C7.01759 9.83644 7.04363 9.84453 7.16602 9.74609C7.29964 9.63859 7.46543 9.47402 7.74219 9.19727L11.4697 5.46973L12.5303 6.53027Z" fill="currentColor"/><path d="M14.5996 8C14.5996 4.35492 11.6451 1.40039 8 1.40039C4.35492 1.40039 1.40039 4.35492 1.40039 8C1.40039 11.6451 4.35492 14.5996 8 14.5996C11.6451 14.5996 14.5996 11.6451 14.5996 8ZM15.9004 8C15.9004 12.363 12.363 15.9004 8 15.9004C3.63695 15.9004 0.0996094 12.363 0.0996094 8C0.0996094 3.63695 3.63695 0.0996094 8 0.0996094C12.363 0.0996094 15.9004 3.63695 15.9004 8Z" fill="currentColor"/></svg>'

    /**
     * Vanilla replica of the official Tooltip (side "bottom", hover delay 500ms):
     * a fixed-position bubble with `role="tooltip"` whose styling mirrors the
     * official Tooltip.module.css tokens, so the workspace header button tooltip
     * matches the official icon buttons (search / view options / add workspace).
     * @param anchor - the button element the tooltip attaches to.
     * @param label - tooltip text.
     * @param options - `side` (default "bottom"), `delayMs` (default 500), `gap` (default 8).
     * @returns disposer removing listeners and any open bubble.
     */
    function attachTooltip(anchor, label, options = {}) {
      if (typeof document === 'undefined' || !anchor || typeof anchor.addEventListener !== 'function') return () => {}
      const side = options.side || 'bottom'
      const delayMs = typeof options.delayMs === 'number' ? options.delayMs : TOOLTIP_DELAY_MS
      const gap = typeof options.gap === 'number' ? options.gap : TOOLTIP_GAP
      let bubble = null
      let timer = null

      const removeBubble = () => {
        if (bubble) {
          if (bubble.parentElement && typeof bubble.parentElement.removeChild === 'function') {
            bubble.parentElement.removeChild(bubble)
          }
          bubble = null
        }
      }
      const cancelTimer = () => {
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
      }

      const show = () => {
        // The anchor may be removed by an official re-render while the hover
        // delay is pending; never position a bubble for a detached anchor.
        if (typeof document === 'undefined' || typeof anchor.getBoundingClientRect !== 'function') return
        if (typeof anchor.isConnected === 'boolean' && !anchor.isConnected) return
        removeBubble()
        const rect = anchor.getBoundingClientRect()
        if (!rect || typeof rect.top !== 'number') return
        const win = typeof window !== 'undefined' ? window : { innerWidth: 0, innerHeight: 0 }
        bubble = document.createElement('div')
        bubble.className = 'dsh-remote-tooltip'
        bubble.setAttribute('role', 'tooltip')
        const labelEl = document.createElement('span')
        labelEl.className = 'dsh-remote-tooltip-label'
        labelEl.textContent = label
        bubble.appendChild(labelEl)
        document.body.appendChild(bubble)
        const width = bubble.offsetWidth || 0
        const height = bubble.offsetHeight || 0
        let placement = side === 'top' ? 'top' : 'bottom'
        const fitsBelow = rect.bottom + gap + height <= win.innerHeight - TOOLTIP_EDGE_MARGIN
        const fitsAbove = rect.top - gap - height >= TOOLTIP_EDGE_MARGIN
        if (side === 'bottom' && !fitsBelow && fitsAbove) placement = 'top'
        else if (side === 'top' && !fitsAbove && fitsBelow) placement = 'bottom'
        const offset = width / 2
        const left = Math.max(TOOLTIP_EDGE_MARGIN, Math.min(rect.left + rect.width / 2 - offset, win.innerWidth - TOOLTIP_EDGE_MARGIN - width))
        bubble.dataset.side = placement
        bubble.style.left = `${left + offset}px`
        bubble.style.top = `${placement === 'top' ? rect.top - gap : rect.bottom + gap}px`
      }

      const scheduleShow = () => {
        cancelTimer()
        timer = setTimeout(() => {
          timer = null
          show()
        }, delayMs)
      }
      const cancelAndHide = () => {
        cancelTimer()
        removeBubble()
      }

      anchor.addEventListener('mouseenter', scheduleShow)
      anchor.addEventListener('mouseleave', cancelAndHide)
      anchor.addEventListener('focus', scheduleShow)
      anchor.addEventListener('blur', cancelAndHide)
      anchor.addEventListener('click', cancelAndHide)

      return () => {
        cancelTimer()
        removeBubble()
        if (typeof anchor.removeEventListener === 'function') {
          anchor.removeEventListener('mouseenter', scheduleShow)
          anchor.removeEventListener('mouseleave', cancelAndHide)
          anchor.removeEventListener('focus', scheduleShow)
          anchor.removeEventListener('blur', cancelAndHide)
          anchor.removeEventListener('click', cancelAndHide)
        }
      }
    }

    /**
     * Parse a fetch response as JSON without ever throwing on an empty or
     * non-JSON body (e.g. the desktop static fallback answering an unknown
     * route with an empty body). Returns null when the body cannot be parsed.
     */
    async function parseJsonResponse(res) {
      if (!res) return null
      try {
        if (typeof res.text === 'function') {
          const text = await res.text()
          if (typeof text === 'string' && text.trim() !== '') return JSON.parse(text)
        }
      } catch {}
      try {
        if (typeof res.json === 'function') {
          const data = await res.json()
          if (data !== null && data !== undefined) return data
        }
      } catch {}
      return null
    }

    /** Toggle a host-action button between idle (icon) and connecting (spinner). */
    function setAddBusy(btn, busy, idleIconSvg = CONNECT_ICON_SVG) {
      if (!btn) return
      btn.disabled = busy
      if (typeof btn.setAttribute === 'function') {
        btn.setAttribute('aria-busy', busy ? 'true' : 'false')
      }
      if (typeof btn.textContent === 'string') btn.textContent = ''
      if (busy) {
        const spinner = document.createElement('span')
        spinner.className = 'dsh-remote-spinner'
        spinner.setAttribute('aria-hidden', 'true')
        btn.appendChild(spinner)
      } else {
        btn.innerHTML = idleIconSvg
      }
    }

    /**
     * Official-style success toast (role="alert", top-center, dark surface,
     * success check-circle, auto fade): mirrors the official Toast.module.css
     * look using the same design tokens and keyframe values.
     * @param text - the toast copy.
     */
    function showRemoteToast(text) {
      if (typeof document === 'undefined') return
      const existing = document.querySelectorAll('.dsh-remote-toast')
      const toast = document.createElement('div')
      toast.className = 'dsh-remote-toast'
      toast.setAttribute('role', 'alert')
      toast.style['--dsh-toast-hold'] = `${TOAST_HOLD_MS}ms`
      toast.style.top = `${TOAST_TOP_PX + existing.length * 8}px`
      const icon = document.createElement('span')
      icon.className = 'dsh-remote-toast-icon dsh-remote-toast-icon--success'
      icon.setAttribute('aria-hidden', 'true')
      icon.innerHTML = TOAST_SUCCESS_ICON_SVG
      const textEl = document.createElement('span')
      textEl.className = 'dsh-remote-toast-text'
      textEl.textContent = text
      toast.appendChild(icon)
      toast.appendChild(textEl)
      document.body.appendChild(toast)
      setTimeout(() => {
        if (toast.parentElement && typeof toast.parentElement.removeChild === 'function') {
          toast.parentElement.removeChild(toast)
        }
      }, TOAST_HOLD_MS + TOAST_FADE_MS)
    }

    async function toggleAddRemotePopover(btn, ctx) {
      if (typeof document === 'undefined') return
      const existing = (typeof document.getElementById === 'function' ? document.getElementById('dsh-add-remote-popover') : null) || document.querySelector?.('#dsh-add-remote-popover')
      if (existing) {
        existing.remove()
        return
      }

      const popover = document.createElement('div')
      popover.id = 'dsh-add-remote-popover'
      popover.className = 'dsh-add-remote-popover'

      if (typeof btn.getBoundingClientRect === 'function') {
        const rect = btn.getBoundingClientRect()
        popover.style.top = `${(rect.bottom || 0) + 6}px`
        const viewportWidth = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 640
        // Clamp both edges: 320px card + 10px viewport margin.
        popover.style.left = `${Math.max(10, Math.min((rect.left || 0) - 100, viewportWidth - 330))}px`
      }

      /** Removes the outside-click listener; wired into every close path. */
      let removeOutsideClickListener = () => {}

      const header = document.createElement('div')
      header.className = 'dsh-popover-header'
      const titleRow = document.createElement('div')
      titleRow.className = 'dsh-popover-title-row'
      const titleSpan = document.createElement('span')
      titleSpan.className = 'dsh-popover-title'
      titleSpan.textContent = '添加远程工作区'
      titleRow.appendChild(titleSpan)
      const closeBtn = document.createElement('button')
      closeBtn.className = 'dsh-popover-close-btn'
      closeBtn.type = 'button'
      closeBtn.textContent = '×'
      closeBtn.setAttribute('aria-label', '关闭')
      closeBtn.addEventListener('click', (ev) => {
        if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation()
        removeOutsideClickListener()
        popover.remove()
      })
      header.appendChild(titleRow)
      header.appendChild(closeBtn)

      const hint = document.createElement('div')
      hint.className = 'dsh-popover-hint'
      hint.textContent = '已连接的主机可断开；未连接的主机一键接入，若远端未启动将自动拉起 dsh web 服务。'

      const body = document.createElement('div')
      body.className = 'dsh-popover-body'
      const loading = document.createElement('div')
      loading.className = 'dsh-popover-empty'
      loading.textContent = '正在检测本机可用主机...'
      body.appendChild(loading)

      popover.appendChild(header)
      popover.appendChild(hint)
      popover.appendChild(body)
      document.body.appendChild(popover)

      const handleOutsideClick = (e) => {
        const isContains = typeof popover.contains === 'function' ? popover.contains(e.target) : false
        const isBtn = e.target === btn || (typeof btn.contains === 'function' && btn.contains(e.target))
        if (!isContains && !isBtn) {
          removeOutsideClickListener()
          popover.remove()
        }
      }
      removeOutsideClickListener = () => {
        if (typeof document.removeEventListener === 'function') {
          document.removeEventListener('pointerdown', handleOutsideClick)
        }
      }
      setTimeout(() => {
        if (typeof document.addEventListener === 'function') {
          document.addEventListener('pointerdown', handleOutsideClick)
        }
      }, 10)

      const buildRowShell = (item) => {
        const hostEl = document.createElement('div')
        hostEl.className = 'dsh-remote-popover-item'
        hostEl.dataset.host = item.host
        const infoEl = document.createElement('div')
        infoEl.className = 'dsh-remote-popover-item-info'
        const nameEl = document.createElement('div')
        nameEl.className = 'dsh-remote-popover-item-name'
        nameEl.textContent = item.host
        const detailEl = document.createElement('div')
        detailEl.className = 'dsh-remote-popover-item-detail'
        detailEl.textContent = `${item.hostName || ''}${item.port ? `:${item.port}` : ''}${item.user ? ` • ${item.user}` : ''}`
        infoEl.appendChild(nameEl)
        infoEl.appendChild(detailEl)
        hostEl.appendChild(infoEl)
        return hostEl
      }

      const wrapRow = (hostEl, feedbackEl) => {
        const wrapEl = document.createElement('div')
        wrapEl.style.display = 'flex'
        wrapEl.style.flexDirection = 'column'
        wrapEl.appendChild(hostEl)
        wrapEl.appendChild(feedbackEl)
        return wrapEl
      }

      const createSection = (title, kind) => {
        const sectionEl = document.createElement('div')
        sectionEl.className = `dsh-popover-section dsh-popover-section--${kind}`
        const titleEl = document.createElement('div')
        titleEl.className = 'dsh-popover-section-title'
        titleEl.textContent = title
        const listEl = document.createElement('div')
        listEl.className = 'dsh-popover-section-list'
        sectionEl.appendChild(titleEl)
        sectionEl.appendChild(listEl)
        return { sectionEl, listEl }
      }

      // Re-fetch the host lists and re-render both sections (used after a
      // disconnect so the host moves back to the "可添加" section).
      const refresh = async () => {
        const res = await fetch(AVAILABLE_HOSTS_ROUTE)
        if (!res.ok) return
        const next = await parseJsonResponse(res)
        if (!next) return
        render(next)
      }

      const render = (data) => {
        const connectedHosts = Array.isArray(data.connectedHosts)
          ? data.connectedHosts
          : (Array.isArray(data.currentHosts) ? data.currentHosts.map((name) => ({ host: name })) : [])
        const availableHosts = Array.isArray(data.availableHosts) ? data.availableHosts : []
        body.textContent = ''

        // --- Connected hosts: disconnect action ---------------------------
        const connectedSec = createSection('已连接主机', 'connected')
        if (connectedHosts.length === 0) {
          const empty = document.createElement('div')
          empty.className = 'dsh-popover-empty'
          empty.textContent = '暂无已连接主机'
          connectedSec.listEl.appendChild(empty)
        } else {
          for (const item of connectedHosts) {
            const hostEl = buildRowShell(item)
            const discBtn = document.createElement('button')
            discBtn.className = 'dsh-remote-popover-item-btn dsh-remote-popover-item-btn--disconnect'
            discBtn.type = 'button'
            discBtn.setAttribute('aria-label', `断开主机 ${item.host}`)
            discBtn.innerHTML = DISCONNECT_ICON_SVG
            const feedbackEl = document.createElement('div')
            feedbackEl.className = 'dsh-popover-feedback'
            discBtn.addEventListener('click', async (ev) => {
              if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation()
              setAddBusy(discBtn, true, DISCONNECT_ICON_SVG)
              feedbackEl.className = 'dsh-popover-feedback'
              feedbackEl.textContent = '正在断开连接...'
              try {
                const postRes = await fetch(REMOVE_HOST_ROUTE, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ host: item.host }),
                })
                const postData = await parseJsonResponse(postRes)
                if (postRes.ok && postData && postData.ok) {
                  if (ctx) {
                    void reconcileRemoteSource(ctx)
                  }
                  await refresh()
                } else {
                  setAddBusy(discBtn, false, DISCONNECT_ICON_SVG)
                  feedbackEl.className = 'dsh-popover-feedback dsh-feedback-error'
                  feedbackEl.textContent = postData?.error || postData?.message || '断开失败：服务端无响应，请重启桌面端后重试'
                }
              } catch (err) {
                setAddBusy(discBtn, false, DISCONNECT_ICON_SVG)
                feedbackEl.className = 'dsh-popover-feedback dsh-feedback-error'
                feedbackEl.textContent = String(err.message || err)
              }
            })
            hostEl.appendChild(discBtn)
            connectedSec.listEl.appendChild(wrapRow(hostEl, feedbackEl))
          }
        }
        body.appendChild(connectedSec.sectionEl)

        // --- Available hosts: connect action ------------------------------
        const availableSec = createSection('可添加主机', 'available')
        if (availableHosts.length === 0) {
          const empty = document.createElement('div')
          empty.className = 'dsh-popover-empty'
          empty.textContent = '暂无可添加的主机'
          const emptyDesc = document.createElement('div')
          emptyDesc.className = 'dsh-popover-empty-desc'
          emptyDesc.textContent = '本地 ~/.ssh/config 中未找到带 IdentityFile 的新主机'
          empty.appendChild(emptyDesc)
          availableSec.listEl.appendChild(empty)
        } else {
          for (const item of availableHosts) {
            const hostEl = buildRowShell(item)
            const addBtn = document.createElement('button')
            addBtn.className = 'dsh-remote-popover-item-btn'
            addBtn.type = 'button'
            addBtn.setAttribute('aria-label', `连接主机 ${item.host}`)
            addBtn.innerHTML = CONNECT_ICON_SVG
            const feedbackEl = document.createElement('div')
            feedbackEl.className = 'dsh-popover-feedback'

            const doAdd = async (ev) => {
              if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation()
              setAddBusy(addBtn, true)
              feedbackEl.className = 'dsh-popover-feedback'
              feedbackEl.textContent = '正在检测远端 dsh 服务并建立隧道...'
              try {
                const postRes = await fetch(ADD_HOST_ROUTE, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ host: item.host }),
                })
                const postData = await parseJsonResponse(postRes)
                if (postRes.ok && postData && postData.ok) {
                  // Success state: the icon flips to a blue success glyph and the
                  // button stays disabled until the popover closes (700ms), so the
                  // window cannot trigger a duplicate add + toast.
                  setAddBusy(addBtn, false)
                  addBtn.disabled = true
                  addBtn.className = 'dsh-remote-popover-item-btn dsh-remote-popover-item-btn--success'
                  addBtn.innerHTML = TOAST_SUCCESS_ICON_SVG
                  const hostName = typeof postData.host === 'string' && postData.host ? postData.host : item.host
                  const autoStarted = Boolean(postData.autoStarted)
                  showRemoteToast(`主机 ${hostName} 连接成功${autoStarted ? '，并已在远端自动启动 dsh 服务' : ''}`)
                  if (ctx) {
                    void reconcileRemoteSource(ctx)
                  }
                  setTimeout(() => {
                    removeOutsideClickListener()
                    popover.remove()
                  }, 700)
                } else {
                  setAddBusy(addBtn, false)
                  feedbackEl.className = 'dsh-popover-feedback dsh-feedback-error'
                  feedbackEl.textContent = (postData && (postData.error || postData.message)) ? `${postData.message || postData.error}` : '连接主机失败'
                }
              } catch (err) {
                setAddBusy(addBtn, false)
                feedbackEl.className = 'dsh-popover-feedback dsh-feedback-error'
                feedbackEl.textContent = String(err.message || err)
              }
            }

            addBtn.addEventListener('click', doAdd)
            hostEl.appendChild(addBtn)
            availableSec.listEl.appendChild(wrapRow(hostEl, feedbackEl))
          }
        }
        body.appendChild(availableSec.sectionEl)
      }

      try {
        const res = await fetch(AVAILABLE_HOSTS_ROUTE)
        if (!res.ok) {
          body.textContent = '获取可用主机失败'
          return
        }
        const data = await parseJsonResponse(res)
        if (!data) {
          body.textContent = '获取可用主机失败（响应为空）'
          return
        }
        render(data)
      } catch (err) {
        body.textContent = `加载失败: ${err.message || err}`
      }
    }

    function checkAndRenderWorkspaceAddButton(ctx) {
      if (typeof document === 'undefined') return
      const existingBtn = (typeof document.getElementById === 'function' ? document.getElementById('dsh-add-remote-workspace-btn') : null) || document.querySelector?.('#dsh-add-remote-workspace-btn')
      if (existingBtn) {
        // If the official React re-render already detached the button, drop the
        // stale node and re-create it below; otherwise only re-pin the position
        // when it drifted (wide <-> rail toggles) — never fight every mutation.
        if (typeof existingBtn.isConnected === 'boolean' && !existingBtn.isConnected) {
          try { existingBtn.remove() } catch {}
        } else {
          repositionWorkspaceAddButton(existingBtn)
          return
        }
      }

      const btn = document.createElement('button')
      btn.id = 'dsh-add-remote-workspace-btn'
      btn.className = 'dsh-btn-add-remote-workspace'
      btn.type = 'button'
      btn.setAttribute('aria-label', '添加远程工作区')

      btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="2" y="2" width="12" height="4.5" rx="1" stroke="currentColor" stroke-width="1.2"/><circle cx="4.5" cy="4.25" r="0.75" fill="currentColor"/><rect x="2" y="8" width="7" height="4.5" rx="1" stroke="currentColor" stroke-width="1.2"/><circle cx="4.5" cy="10.25" r="0.75" fill="currentColor"/><path d="M12.5 8.5V13.5M10 11H15" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`

      // Official-style tooltip (side "bottom", 500ms hover delay) instead of the
      // native `title` attribute, matching the search / view-options / add-workspace
      // icon buttons' tooltips.
      btn._dshTooltipDisposer = attachTooltip(btn, '添加远程工作区', { side: 'bottom', delayMs: TOOLTIP_DELAY_MS })

      btn.addEventListener('click', (ev) => {
        if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation()
        void toggleAddRemotePopover(btn, ctx)
      })

      if (!repositionWorkspaceAddButton(btn)) return
    }

    function installTitleDecorator(ctx) {
      if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
      decorateRemoteTitles()
      checkAndRenderActiveQuestion()
      checkAndRenderSettingsCard(ctx)
      checkAndRenderWorkspaceAddButton(ctx)
      const observer = new MutationObserver(() => {
        decorateRemoteTitles()
        checkAndRenderActiveQuestion()
        checkAndRenderSettingsCard(ctx)
        checkAndRenderWorkspaceAddButton(ctx)
      })
      observer.observe(document.body, { childList: true, subtree: true })
      return () => {
        observer.disconnect()
        const decorated = document.querySelectorAll('span[data-remote-decorated="true"]')
        for (const el of decorated) {
          el.textContent = el.textContent
          delete el.dataset.remoteDecorated
        }
        removeQuestionCard()
        removeSettingsCard()
        removeWorkspaceAddButton()
        removeAddRemotePopover()
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
      const restoreDecorator = installTitleDecorator(ctx)
      const timer = setInterval(() => { void reconcileRemoteSource(ctx) }, POLL_INTERVAL_MS)
      void reconcileRemoteSource(ctx)

      try {
        if (typeof ctx.inject === 'function') {
          ctx.inject(['uiSession'], (scoped) => {
            if (scoped.uiSession && typeof scoped.uiSession.registerPendingInteraction === 'function') {
              registerPendingPublisher = scoped.uiSession.registerPendingInteraction((pending) =>
                pending.kind === 'plan-review' ? 2 : 1
              )
              for (const interaction of activeInteractions.values()) {
                publishToUiSession(interaction)
              }
            }
          })
        }
      } catch (_) {}

      ctx.effect(() => () => {
        clearInterval(timer)
        restoreProxy()
        restoreGuardian()
        restoreStyles()
        restoreDecorator()
        removeRemoteSource(ctx)
        removeQuestionCard()
        removeSettingsCard()
        removeWorkspaceAddButton()
        removeAddRemotePopover()
        for (const unregister of uiSessionDisposers.values()) {
          try { unregister() } catch {}
        }
        uiSessionDisposers.clear()
        activeInteractions.clear()
      })
    }

    exports.apply = apply
    exports.inject = ['workspaces', 'sessions', 'remote', 'remote.session', 'remote.workspace']
    return module.exports
  },
})