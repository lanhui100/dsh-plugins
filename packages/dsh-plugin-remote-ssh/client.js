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
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-remote-ssh',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')

    const LABEL = '远程: dev (3080)'
    const TITLE = '远程 DSH 服务（SSH 隧道 dev → 127.0.0.1:3080）\n'
      + '点击查看连接详情；在输入框执行 /remote-ssh 可列出远端全部会话。'
    const DETAIL = '【远程 DSH 实例已连接】\n'
      + '• 远程主机：dev (devserver.taildb165c.ts.net:2022)\n'
      + '• 隧道状态：活跃（转发至 127.0.0.1:3080）\n\n'
      + '提示：在当前对话输入框输入 /remote-ssh 即可拉取远端最新会话清单。'

    /** Status dot: the connected indicator beside the label. */
    const dotStyle = {
      display: 'inline-block',
      width: '8px',
      height: '8px',
      borderRadius: '50%',
      backgroundColor: '#10b981',
      flexShrink: 0,
      boxShadow: '0 0 6px rgba(16, 185, 129, 0.6)',
    }

    /**
     * Sidebar footer action occupant.
     * @param props - owner share; `wide` distinguishes the full column from the rail.
     */
    function RemoteSshFooterAction(props) {
      const wide = props !== null && props !== undefined && props.wide === true
      return react.createElement(
        'button',
        {
          type: 'button',
          title: TITLE,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: wide ? 'flex-start' : 'center',
            gap: '8px',
            padding: wide ? '5px 8px' : '5px',
            background: 'rgba(128, 128, 128, 0.08)',
            border: '1px solid rgba(128, 128, 128, 0.18)',
            borderRadius: '6px',
            color: 'inherit',
            cursor: 'pointer',
            fontSize: '12px',
            width: wide ? '100%' : '32px',
            height: '32px',
            boxSizing: 'border-box',
          },
          onClick: () => {
            if (typeof window !== 'undefined' && typeof window.alert === 'function') window.alert(DETAIL)
          },
        },
        react.createElement('span', { style: dotStyle }),
        wide
          ? react.createElement(
            'span',
            { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500 } },
            LABEL,
          )
          : null,
      )
    }

    /**
     * Register the sidebar footer action; the slot owner declares the seat.
     * @param ctx - client plugin context carrying the slot registry.
     */
    function apply(ctx) {
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'remote-ssh-status',
        order: 300,
        label: LABEL,
      }, RemoteSshFooterAction))
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
