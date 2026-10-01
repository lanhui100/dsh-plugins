/**
 * Browser half of dsh-plugin-remote-ssh, shipped in the DSH client
 * closure-factory format: `window.__ModuleLoader__.load({ id, factory })`.
 *
 * This artifact is maintained by hand. The official pipeline emits the same
 * shape with tsdown's `clientBundle` preset from `src/client/index.ts`; that
 * preset needs the deepseek-harness monorepo toolchain, so this repository
 * ships the equivalent bytes directly and keeps `src/client/index.ts` as the
 * typed source of truth. Keep both in step when behavior changes.
 *
 * Format contract (verified against a shipped bundle):
 * - the registration call only REGISTERS the factory; all work happens inside it;
 * - `require` resolves the platform module table, whose baseline already
 *   carries `react`, `react/jsx-runtime`, `react-dom`, `@deepseek-ai/cordis`,
 *   `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-slots`,
 *   `@deepseek-ai/dsh-client-ui-primitives`, and `@deepseek-ai/dsh-client-ui-dockkit`;
 * - `exports.apply` is the plugin entry and `exports.inject` its Cordis service edges.
 *
 * Surface: one global panel — a `sidebar.panellist` icon plus the `main` keyed
 * panel it opens — listing the remote DSH's sessions grouped into remote
 * workspaces. The Host serves that tree at `/remote-ssh/sessions`, same origin.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-remote-ssh',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')

    /** Panel id shared by the sidebar entry and the main panel it opens. */
    const PANEL_ID = 'remote'
    const ROUTE = '/remote-ssh/sessions'

    const INK = 'inherit'
    const MUTED = 'rgba(127,127,127,0.95)'
    const HAIRLINE = '1px solid rgba(128,128,128,0.18)'
    const RUNNING = '#10b981'
    const IDLE = 'rgba(128,128,128,0.55)'
    const ERROR = '#ef4444'

    /**
     * Coarse relative age of a millisecond timestamp.
     * @param timestamp - session `updatedAt`.
     * @returns compact age such as `12s`, `7m`, `3h`, `2d`.
     */
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

    /**
     * The sidebar's Remote entry glyph.
     * @param props - sidebar icon share: requested edge and selection state.
     */
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

    /**
     * One collapsible remote-workspace row with its sessions.
     * @param props - group, expansion state, and the toggle callback.
     */
    function WorkspaceGroup(props) {
      const group = props.group
      const expanded = props.expanded === true
      const rows = group.sessions.map((session) => react.createElement(
        'div',
        {
          key: session.sessionId,
          title: `${session.sessionId}\n${session.cwd}`,
          style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 12px 4px 34px', fontSize: '12px' },
        },
        react.createElement('span', {
          style: {
            display: 'inline-block',
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            flexShrink: 0,
            backgroundColor: session.running ? RUNNING : IDLE,
          },
        }),
        react.createElement('span', {
          style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        }, session.title || session.sessionId),
        react.createElement('span', {
          style: { marginLeft: 'auto', color: MUTED, fontSize: '11px', flexShrink: 0 },
        }, relativeTime(session.updatedAt)),
      ))

      return react.createElement(
        'div',
        { style: { borderTop: '1px solid rgba(128,128,128,0.14)' } },
        react.createElement(
          'button',
          {
            type: 'button',
            onClick: props.onToggle,
            title: group.cwd,
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              width: '100%',
              padding: '7px 12px',
              background: 'transparent',
              border: 'none',
              color: INK,
              cursor: 'pointer',
              textAlign: 'left',
              fontSize: '12.5px',
              fontWeight: 600,
            },
          },
          react.createElement('span', { style: { width: '10px', color: MUTED, flexShrink: 0 } }, expanded ? '▾' : '▸'),
          react.createElement('span', {
            style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          }, group.name),
          react.createElement('span', {
            style: { marginLeft: 'auto', color: MUTED, fontWeight: 400, flexShrink: 0 },
          }, String(group.total)),
        ),
        react.createElement('div', {
          style: {
            padding: '0 12px 4px 30px',
            color: MUTED,
            fontSize: '11px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          },
        }, group.cwd),
        expanded
          ? react.createElement(
            'div',
            { style: { paddingBottom: '6px' } },
            rows,
            group.total > group.sessions.length
              ? react.createElement('div', {
                style: { padding: '2px 12px 6px 34px', color: MUTED, fontSize: '11px' },
              }, `… ${group.total - group.sessions.length} more in this workspace`)
              : null,
          )
          : null,
      )
    }

    /** The Remote workspaces page: one fetch, a grouped tree, manual refresh. */
    function RemotePanel() {
      const [state, setState] = react.useState({ status: 'loading' })
      const [expanded, setExpanded] = react.useState(null)
      const [nonce, setNonce] = react.useState(0)

      react.useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const response = await fetch(ROUTE, { headers: { accept: 'application/json' } })
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

      const header = react.createElement(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '12px 14px',
            borderBottom: HAIRLINE,
            flexShrink: 0,
          },
        },
        react.createElement('span', { style: { fontWeight: 600, fontSize: '13px' } },
          state.status === 'ready' ? `远程工作区: ${state.host}` : '远程工作区'),
        state.status === 'ready'
          ? react.createElement('span', { style: { color: MUTED, fontSize: '12px' } },
            `${state.total} sessions · ${state.workspaces.length} workspaces`)
          : null,
        react.createElement('button', {
          type: 'button',
          onClick: () => setNonce((value) => value + 1),
          style: {
            marginLeft: 'auto',
            padding: '4px 10px',
            fontSize: '12px',
            background: 'transparent',
            border: HAIRLINE,
            borderRadius: '6px',
            color: INK,
            cursor: 'pointer',
          },
        }, '刷新'),
      )

      let body
      if (state.status === 'loading') {
        body = react.createElement('div', { style: { padding: '16px 14px', color: MUTED, fontSize: '12px' } },
          '正在读取远端会话…')
      } else if (state.status === 'error') {
        body = react.createElement('div', { style: { padding: '16px 14px', fontSize: '12px' } },
          react.createElement('div', { style: { color: ERROR, marginBottom: '6px' } }, '无法读取远端会话'),
          react.createElement('div', { style: { color: MUTED } }, String(state.message)))
      } else if (state.workspaces.length === 0) {
        body = react.createElement('div', { style: { padding: '16px 14px', color: MUTED, fontSize: '12px' } },
          '远端暂无会话。')
      } else {
        body = react.createElement(
          'div',
          { style: { overflowY: 'auto', flex: 1, minHeight: 0 } },
          state.workspaces.map((group) => react.createElement(WorkspaceGroup, {
            key: group.cwd,
            group,
            expanded: expanded === group.cwd,
            onToggle: () => setExpanded(expanded === group.cwd ? null : group.cwd),
          })),
        )
      }

      return react.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, color: INK } },
        header,
        body,
      )
    }

    /**
     * Contribute the Remote workspaces panel and its sidebar entry.
     * @param ctx - client plugin context carrying the slot registry.
     */
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
