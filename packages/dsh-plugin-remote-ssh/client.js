/**
 * Browser half of dsh-plugin-remote-ssh, shipped in the DSH client
 * closure-factory format: `window.__ModuleLoader__.load({ id, factory })`.
 *
 * Surface: one global panel — a `sidebar.panellist` icon plus the `main` keyed
 * panel it opens — listing the remote DSH's sessions grouped into a workspace
 * tree on the left, with the selected session's conversation messages and
 * execution details rendered in the main area on the right.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-remote-ssh',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')

    const PANEL_ID = 'remote'
    const SESSIONS_ROUTE = '/remote-ssh/sessions'
    const SESSION_DETAIL_ROUTE = '/remote-ssh/session'

    const RUNNING_COLOR = '#10b981'
    const IDLE_COLOR = 'rgba(128,128,128,0.55)'

    function relativeTime(timestamp) {
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return ''
      const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
      if (seconds < 60) return `${seconds}s`
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return `${minutes}m`
      const hours = Math.round(minutes / 60)
      if (hours < 24) return `${hours}h`
      return `${Math.round(hours / 24)}d`
    }

    function RemotePanelIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 16
      const active = props?.active === true
      return react.createElement(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: active ? 1.6 : 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        react.createElement('rect', { x: 2.2, y: 3.2, width: 11.6, height: 4.4, rx: 1.2 }),
        react.createElement('rect', { x: 2.2, y: 9.4, width: 11.6, height: 3.4, rx: 1.2 }),
        react.createElement('circle', { cx: 4.7, cy: 5.4, r: 0.85, fill: 'currentColor', stroke: 'none' }),
        react.createElement('circle', { cx: 4.7, cy: 11.1, r: 0.85, fill: 'currentColor', stroke: 'none' }),
      )
    }

    function SessionRow(props) {
      const session = props.session
      const selected = props.selected
      const onSelect = props.onSelect

      return react.createElement(
        'div',
        {
          onClick: onSelect,
          title: `${session.title || session.sessionId}\n${session.sessionId}\n${session.cwd}`,
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '6px 12px 6px 30px',
            fontSize: '12px',
            cursor: 'pointer',
            borderRadius: '6px',
            margin: '1px 6px',
            backgroundColor: selected ? 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.14))' : 'transparent',
            color: selected ? 'var(--dsw-alias-label-primary, inherit)' : 'var(--dsw-alias-label-secondary, inherit)',
            fontWeight: selected ? 500 : 400,
          },
        },
        react.createElement('span', {
          style: {
            display: 'inline-block',
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            flexShrink: 0,
            backgroundColor: session.running ? RUNNING_COLOR : IDLE_COLOR,
          },
        }),
        react.createElement(
          'span',
          { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 } },
          session.title || session.sessionId,
        ),
        react.createElement(
          'span',
          { style: { marginLeft: 'auto', opacity: 0.6, fontSize: '11px', flexShrink: 0 } },
          relativeTime(session.updatedAt),
        ),
      )
    }

    function WorkspaceSection(props) {
      const group = props.group
      const expanded = props.expanded
      const onToggle = props.onToggle
      const selectedSessionId = props.selectedSessionId
      const onSelectSession = props.onSelectSession

      return react.createElement(
        'div',
        { style: { marginBottom: '4px' } },
        react.createElement(
          'button',
          {
            type: 'button',
            onClick: onToggle,
            title: group.cwd,
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              width: '100%',
              padding: '6px 10px',
              background: 'transparent',
              border: 'none',
              color: 'var(--dsw-alias-label-primary, inherit)',
              cursor: 'pointer',
              textAlign: 'left',
              fontSize: '12px',
              fontWeight: 600,
            },
          },
          react.createElement('span', { style: { width: '12px', opacity: 0.6, flexShrink: 0 } }, expanded ? '▾' : '▸'),
          react.createElement('span', { style: { opacity: 0.75 } }, '📁'),
          react.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 } }, group.name),
          react.createElement('span', { style: { opacity: 0.5, fontWeight: 400, fontSize: '11px' } }, String(group.total)),
        ),
        expanded
          ? react.createElement(
            'div',
            null,
            group.sessions.map((session) => react.createElement(SessionRow, {
              key: session.sessionId,
              session,
              selected: selectedSessionId === session.sessionId,
              onSelect: () => onSelectSession(session),
            })),
            group.total > group.sessions.length
              ? react.createElement('div', {
                style: { padding: '3px 12px 5px 30px', opacity: 0.5, fontSize: '11px' },
              }, `… 余下 ${group.total - group.sessions.length} 个会话`)
              : null,
          )
          : null,
      )
    }

    function MessageCard(props) {
      const msg = props.msg
      const isUser = msg.role === 'user'

      return react.createElement(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            marginBottom: '16px',
            maxWidth: isUser ? '85%' : '96%',
            alignSelf: isUser ? 'flex-end' : 'flex-start',
          },
        },
        react.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', opacity: 0.6 } },
          react.createElement('span', { style: { fontWeight: 600 } }, isUser ? 'User' : 'Assistant'),
          msg.time ? react.createElement('span', null, relativeTime(msg.time)) : null,
        ),
        react.createElement(
          'div',
          {
            style: {
              padding: '12px 16px',
              borderRadius: isUser ? '12px 12px 2px 12px' : '4px 12px 12px 12px',
              backgroundColor: isUser
                ? 'var(--dsw-alias-brand-primary, #10b981)'
                : 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.08))',
              color: isUser ? '#ffffff' : 'var(--dsw-alias-label-primary, inherit)',
              border: isUser ? 'none' : '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.15))',
              fontSize: '13px',
              lineHeight: '1.55',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            },
          },
          msg.text,
        ),
        msg.toolCalls && msg.toolCalls.length > 0
          ? react.createElement(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '2px' } },
            msg.toolCalls.map((tc, idx) => react.createElement(
              'span',
              {
                key: idx,
                title: tc.args || '',
                style: {
                  fontSize: '11px',
                  padding: '2px 8px',
                  borderRadius: '4px',
                  backgroundColor: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.12))',
                  border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.18))',
                  opacity: 0.85,
                },
              },
              `🔧 ${tc.name}`,
            )),
          )
          : null,
      )
    }

    function ConversationPane(props) {
      const session = props.session
      const [detail, setDetail] = react.useState(null)
      const [loading, setLoading] = react.useState(false)
      const [error, setError] = react.useState(null)

      react.useEffect(() => {
        if (!session) {
          setDetail(null)
          return
        }
        let alive = true
        setLoading(true)
        setError(null)
        fetch(`${SESSION_DETAIL_ROUTE}?id=${encodeURIComponent(session.sessionId)}`)
          .then((res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            return res.json()
          })
          .then((data) => {
            if (alive) {
              setDetail(data)
              setLoading(false)
            }
          })
          .catch((err) => {
            if (alive) {
              setError(err && err.message ? err.message : String(err))
              setLoading(false)
            }
          })
        return () => { alive = false }
      }, [session?.sessionId])

      if (!session) {
        return react.createElement(
          'div',
          {
            style: {
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '12px',
              padding: '32px',
              opacity: 0.6,
              color: 'var(--dsw-alias-label-secondary, inherit)',
            },
          },
          react.createElement('div', { style: { fontSize: '28px' } }, '💬'),
          react.createElement('div', { style: { fontSize: '13px', fontWeight: 500 } }, '从左侧远程工作区列表中选择一个会话以查看详细对话记录'),
        )
      }

      return react.createElement(
        'div',
        {
          style: {
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            minWidth: 0,
            backgroundColor: 'var(--dsw-alias-bg-base, transparent)',
          },
        },
        react.createElement(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 20px',
              borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.18))',
              backgroundColor: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.03))',
              gap: '12px',
            },
          },
          react.createElement(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 } },
            react.createElement(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
              react.createElement('span', {
                style: {
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  backgroundColor: session.running ? RUNNING_COLOR : IDLE_COLOR,
                  flexShrink: 0,
                },
              }),
              react.createElement('span', {
                style: {
                  fontWeight: 600,
                  fontSize: '14px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
              }, detail?.title || session.title || session.sessionId),
            ),
            react.createElement(
              'span',
              { style: { fontSize: '11px', opacity: 0.65, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              `dev:${session.cwd}`,
            ),
          ),
          detail?.stats
            ? react.createElement(
              'span',
              {
                style: {
                  fontSize: '11px',
                  opacity: 0.75,
                  padding: '3px 8px',
                  borderRadius: '4px',
                  border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.18))',
                  flexShrink: 0,
                },
              },
              `${detail.stats.turns} turns · ${detail.stats.steps} steps`,
            )
            : null,
        ),
        detail?.goal
          ? react.createElement(
            'div',
            {
              style: {
                margin: '12px 20px 0 20px',
                padding: '10px 14px',
                borderRadius: '6px',
                backgroundColor: 'var(--dsw-alias-bg-layer-2, rgba(16,185,129,0.08))',
                border: '1px solid var(--dsw-alias-brand-primary, rgba(16,185,129,0.3))',
                fontSize: '12px',
              },
            },
            react.createElement('div', { style: { fontWeight: 600, marginBottom: '2px', opacity: 0.85 } }, '🎯 当前目标'),
            react.createElement('div', { style: { opacity: 0.9, lineHeight: 1.4 } }, detail.goal.objective),
          )
          : null,
        react.createElement(
          'div',
          {
            style: {
              flex: 1,
              overflowY: 'auto',
              padding: '20px',
              display: 'flex',
              flexDirection: 'column',
            },
          },
          loading
            ? react.createElement('div', { style: { opacity: 0.6, fontSize: '12px', padding: '12px' } }, '正在读取会话历史记录…')
            : error
              ? react.createElement('div', { style: { color: 'var(--dsw-alias-state-error-primary, #ef4444)', fontSize: '12px' } }, `加载会话失败: ${error}`)
              : detail && detail.messages && detail.messages.length > 0
                ? detail.messages.map((m) => react.createElement(MessageCard, { key: m.id, msg: m }))
                : react.createElement('div', { style: { opacity: 0.5, fontSize: '12px' } }, '该远程会话暂无历史消息记录。'),
        ),
      )
    }

    function RemotePanel() {
      const [state, setState] = react.useState({ status: 'loading' })
      const [expanded, setExpanded] = react.useState(null)
      const [selectedSession, setSelectedSession] = react.useState(null)
      const [filter, setFilter] = react.useState('')
      const [nonce, setNonce] = react.useState(0)

      react.useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const response = await fetch(SESSIONS_ROUTE, { headers: { accept: 'application/json' } })
            const body = await response.json().catch(() => null)
            if (!alive) return
            if (!response.ok || body === null || !Array.isArray(body.workspaces)) {
              setState({
                status: 'error',
                message: (body && (body.message || body.error)) || `HTTP ${response.status}`,
              })
              return
            }
            setState({ status: 'ready', host: body.host, total: body.total, workspaces: body.workspaces })
            setExpanded((current) => current ?? body.workspaces[0]?.cwd ?? null)
          } catch (error) {
            if (alive) setState({ status: 'error', message: (error && error.message) || String(error) })
          }
        }
        void load()
        return () => { alive = false }
      }, [nonce])

      const workspaces = state.workspaces || []
      const filteredWorkspaces = react.useMemo(() => {
        const q = filter.trim().toLowerCase()
        if (!q) return workspaces
        return workspaces
          .map((ws) => {
            const nameMatch = ws.name.toLowerCase().includes(q) || ws.cwd.toLowerCase().includes(q)
            const matchedSessions = ws.sessions.filter((s) =>
              (s.title && s.title.toLowerCase().includes(q)) || s.sessionId.toLowerCase().includes(q))
            if (nameMatch) return ws
            if (matchedSessions.length > 0) return { ...ws, sessions: matchedSessions }
            return null
          })
          .filter(Boolean)
      }, [workspaces, filter])

      const sidebarTree = react.createElement(
        'div',
        {
          style: {
            width: '280px',
            minWidth: '240px',
            maxWidth: '360px',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            borderRight: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.18))',
            backgroundColor: 'var(--dsw-specific-sidebar-fill, rgba(0,0,0,0.02))',
          },
        },
        react.createElement(
          'div',
          {
            style: {
              padding: '12px 14px',
              borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.18))',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            },
          },
          react.createElement(
            'span',
            { style: { fontWeight: 600, fontSize: '13px' } },
            state.status === 'ready' ? `远程工作区: ${state.host}` : '远程工作区',
          ),
          react.createElement(
            'button',
            {
              type: 'button',
              onClick: () => setNonce((v) => v + 1),
              title: '刷新远程工作区与会话',
              style: {
                background: 'transparent',
                border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.18))',
                borderRadius: '4px',
                padding: '3px 8px',
                fontSize: '11px',
                cursor: 'pointer',
                color: 'inherit',
              },
            },
            '刷新',
          ),
        ),
        react.createElement(
          'div',
          { style: { padding: '8px 12px', borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.18))' } },
          react.createElement('input', {
            type: 'text',
            value: filter,
            placeholder: '搜索远程会话或目录…',
            onChange: (e) => setFilter(e.target.value),
            style: {
              width: '100%',
              boxSizing: 'border-box',
              padding: '5px 8px',
              fontSize: '12px',
              borderRadius: '5px',
              border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2))',
              backgroundColor: 'var(--dsw-alias-bg-layer-1, transparent)',
              color: 'inherit',
              outline: 'none',
            },
          }),
        ),
        react.createElement(
          'div',
          { style: { flex: 1, overflowY: 'auto', padding: '6px 0' } },
          state.status === 'loading'
            ? react.createElement('div', { style: { padding: '16px', opacity: 0.6, fontSize: '12px' } }, '正在读取远端会话…')
            : state.status === 'error'
              ? react.createElement('div', { style: { padding: '16px', color: 'var(--dsw-alias-state-error-primary, #ef4444)', fontSize: '12px' } }, `读取失败: ${state.message}`)
              : filteredWorkspaces.length === 0
                ? react.createElement('div', { style: { padding: '16px', opacity: 0.5, fontSize: '12px' } }, '未找到匹配的远程会话')
                : filteredWorkspaces.map((group) => react.createElement(WorkspaceSection, {
                  key: group.cwd,
                  group,
                  expanded: expanded === group.cwd || filter.trim().length > 0,
                  onToggle: () => setExpanded(expanded === group.cwd ? null : group.cwd),
                  selectedSessionId: selectedSession?.sessionId,
                  onSelectSession: (s) => setSelectedSession(s),
                })),
        ),
      )

      return react.createElement(
        'div',
        {
          style: {
            display: 'flex',
            height: '100%',
            width: '100%',
            minHeight: 0,
            color: 'var(--dsw-alias-label-primary, inherit)',
          },
        },
        sidebarTree,
        react.createElement(ConversationPane, { session: selectedSession }),
      )
    }

    function apply(ctx) {
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
      }, RemotePanel))
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 100,
        label: '远程工作区',
      }, RemotePanelIcon))
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
