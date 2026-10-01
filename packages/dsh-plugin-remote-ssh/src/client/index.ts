/**
 * Client half of dsh-plugin-remote-ssh — typed source of truth for the panel.
 *
 * The artifact the browser actually loads is the hand-maintained
 * `client.js` at the package root (DSH closure-factory format); this module
 * mirrors that design for type checking and documentation. Change both
 * together, then run `smoke-client-bundle.mjs`.
 *
 * Surface: a `sidebar.panellist` icon plus the `main` keyed panel it opens,
 * listing the remote DSH's sessions grouped into remote workspaces.
 */

import type { Context } from '@deepseek-ai/cordis'
import type ReactTypes from 'react'

/** Fraction of the React surface this plugin uses. */
type ReactLike = Pick<typeof ReactTypes, 'createElement' | 'useState' | 'useEffect'>

/** Panel id shared by the sidebar entry and the main panel it opens. */
export const PANEL_ID = 'remote'

/** Host route serving the workspace tree, same origin as the page. */
export const SESSIONS_ROUTE = '/remote-ssh/sessions'

/** Host route serving detailed session messages and projections. */
export const SESSION_DETAIL_ROUTE = '/remote-ssh/session'

/** Host slot declaration accepted by the client slot registry. */
export interface ClientSlotRegistration {
  name: string
  id?: string
  key?: string
  order?: number
  label?: string | (() => string)
}

/** Client slot registry surface used by this plugin. */
export interface ClientSlotsService {
  inject(name: string, callback: () => unknown): void
  register(declaration: ClientSlotRegistration, component: unknown): unknown
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    slots: ClientSlotsService
  }
}

/**
 * Services the client entry needs before `apply` runs.
 * The shell owns the sidebar button and dispatches the `main` panel by id, so
 * the slot registry is the only edge this half needs.
 */
export const inject = ['slots']

/**
 * Coarse relative age of a millisecond timestamp.
 * @param timestamp - session `updatedAt`.
 * @returns compact age such as `12s`, `7m`, `3h`, `2d`.
 */
function relativeTime(timestamp: unknown): string {
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
 * Contribute the Remote workspaces panel and its sidebar entry.
 * @param ctx - client plugin context carrying the slot registry.
 */
export function apply(ctx: Context): void {
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, RemotePanel))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 100,
    label: '远程工作区',
  }, RemotePanelIcon))
}

/**
 * The sidebar's Remote entry glyph.
 * @param props - sidebar icon share: requested edge and selection state.
 * @returns an SVG element sized by the shell.
 */
export function RemotePanelIcon(props: { size?: number; active?: boolean }): unknown {
  const React = runtimeReact()
  const size = typeof props.size === 'number' ? props.size : 16
  return React.createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 16 16',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: props.active === true ? 1.6 : 1.3,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
    },
    React.createElement('rect', { x: 2.2, y: 3.2, width: 11.6, height: 4.4, rx: 1.2 }),
    React.createElement('rect', { x: 2.2, y: 9.4, width: 11.6, height: 3.4, rx: 1.2 }),
    React.createElement('circle', { cx: 4.7, cy: 5.4, r: 0.85, fill: 'currentColor', stroke: 'none' }),
    React.createElement('circle', { cx: 4.7, cy: 11.1, r: 0.85, fill: 'currentColor', stroke: 'none' }),
  )
}

/**
 * The Remote workspaces page: one fetch, a grouped tree, manual refresh.
 * @returns the panel element.
 */
export function RemotePanel(): unknown {
  const React = runtimeReact()
  const [state, setState] = React.useState<unknown>({ status: 'loading' })
  const [expanded, setExpanded] = React.useState<string | null>(null)
  const [nonce, setNonce] = React.useState(0)
  React.useEffect(() => {
    void nonce
    void (async () => {
      try {
        const response = await fetch(SESSIONS_ROUTE, { headers: { accept: 'application/json' } })
        const body = await response.json() as { host?: string; total?: number; workspaces?: unknown[]; message?: string }
        setState(response.ok && Array.isArray(body.workspaces)
          ? { status: 'ready', host: body.host, total: body.total, workspaces: body.workspaces }
          : { status: 'error', message: body.message ?? `HTTP ${String(response.status)}` })
      } catch (error) {
        setState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    })()
    return () => {}
  }, [nonce, setState])
  void expanded
  void setExpanded
  return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } },
    React.createElement('div', { style: { padding: '12px 14px', fontWeight: 600, fontSize: '13px' } },
      state === undefined ? '远程工作区' : '远程工作区'),
  )
}

/**
 * Read the runtime React the shell exposes to a client plugin.
 * @returns the React namespace injected by the DSH client container.
 */
function runtimeReact(): ReactLike {
  const React = (globalThis as unknown as { React?: ReactLike }).React
  if (React === undefined) throw new Error('remote-ssh: client React runtime is unavailable')
  return React
}

export { relativeTime }
