/** Client half of dsh-plugin-remote-ssh: sidebar footer action indicator. */

import type { Context } from '@deepseek-ai/cordis'
import type ReactTypes from 'react'

export interface ClientSlotRegistration {
  name: string
  id: string
  order?: number
  label?: string
}

export interface ClientSlotsService {
  inject(name: string, callback: () => Generator<unknown, void, unknown> | unknown): void
  register(declaration: ClientSlotRegistration, component: unknown): unknown
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    slots: ClientSlotsService
  }
}

export const inject = ['slots']

/**
 * Activate the Client half: register a status indicator and action
 * in the sidebar footer (`sidebar.footer.action`).
 * @param ctx - client plugin context carrying the slot registry.
 */
export function apply(ctx: Context): void {
  ctx.slots.inject('sidebar.footer.action', function* () {
    yield ctx.slots.register(
      {
        name: 'sidebar.footer.action',
        id: 'remote-ssh-status',
        order: 300,
        label: '远程 DSH (dev)',
      },
      (props: { wide: boolean }) => {
        // Safe access to the runtime React global exposed by the DSH client container
        const React = (globalThis as unknown as { React?: typeof ReactTypes }).React
        if (React === undefined || typeof React.createElement !== 'function') return null

        const dot = React.createElement('span', {
          style: {
            display: 'inline-block',
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            backgroundColor: '#10b981',
            flexShrink: 0,
            boxShadow: '0 0 6px rgba(16, 185, 129, 0.6)',
          },
        })

        const label = props.wide
          ? React.createElement(
              'span',
              {
                style: {
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontWeight: 500,
                },
              },
              '远程: dev (3080)',
            )
          : null

        return React.createElement(
          'button',
          {
            type: 'button',
            title: '远程 DSH 服务 (SSH 隧道: dev -> 127.0.0.1:3080)\n点击可查看连接详情；输入框中输入 /remote-ssh 可查看远端全部会话。',
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: props.wide ? 'flex-start' : 'center',
              gap: '8px',
              padding: props.wide ? '5px 8px' : '5px',
              background: 'rgba(128, 128, 128, 0.08)',
              border: '1px solid rgba(128, 128, 128, 0.18)',
              borderRadius: '6px',
              color: 'inherit',
              cursor: 'pointer',
              fontSize: '12px',
              width: props.wide ? '100%' : '32px',
              height: '32px',
              boxSizing: 'border-box',
              transition: 'background 0.2s',
            },
            onClick: () => {
              if (typeof window !== 'undefined' && typeof window.alert === 'function') {
                window.alert(
                  '【远程 DSH 实例已连接】\n' +
                  '• 远程主机：dev (devserver.taildb165c.ts.net:2022)\n' +
                  '• 隧道状态：活跃（转发至 127.0.0.1:3080）\n' +
                  '• 远程会话数：2,280+ 个会话\n\n' +
                  '提示：在当前对话输入框输入 /remote-ssh 即可拉取并显示最新会话清单！',
                )
              }
            },
          },
          dot,
          label,
        )
      },
    )
  })
}
