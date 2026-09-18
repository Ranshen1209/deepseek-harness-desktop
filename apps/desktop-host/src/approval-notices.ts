/** Forward actual human-wait lifecycles over the Host-owned byte pipe. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-user-approval'
import { encodeDesktopApprovalNotice, type DesktopApprovalNotice } from './wire.ts'

/** Install once per Host; neither model review nor denied requests enter this listener. */
export function installApprovalNotices(ctx: Context, write: (frame: Buffer) => Promise<void>): void {
  const send = async (notice: DesktopApprovalNotice): Promise<void> => {
    try { await write(encodeDesktopApprovalNotice(notice)) }
    catch { ctx.logger.warn('desktop: approval notification transport unavailable; application approval remains pending') }
  }
  ctx.on('approval/request', async (request, next) => {
    if (request.id === undefined || request.signal?.aborted) return next()
    const identity: Omit<DesktopApprovalNotice, 'state'> = { requestId: String(request.id), sessionId: String(request.agent.session.header.id),
      category: ['pwsh', 'bash'].includes(request.toolName) ? 'command'
        : ['read', 'write', 'edit', 'str_replace_editor'].includes(request.toolName) ? 'file' : 'tool' }
    let ended = false
    const end = (): void => {
      if (ended) return
      ended = true
      void send({ ...identity, state: 'ended' })
    }
    request.signal?.addEventListener('abort', end, { once: true })
    try {
      await send({ ...identity, state: 'waiting' })
      return await next()
    } finally {
      request.signal?.removeEventListener('abort', end)
      end()
    }
  }, { prepend: true })
}
