/** Native one-call escalation must reach the same JSON projection as the GUI. */
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import { projectRemoteEventRequest } from '../../../packages/api/gateway/src/stream-protocol.ts'

it('keeps the native execution identity in the Host and forwards one answerable GUI request', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(ApprovalService)
    const session = ctx.sessions.create(SessionId('native-rpc-escalation'))
    session.append('turn/start', { turn: 1 })
    const agent = { session } as unknown as Agent
    const signal = new AbortController().signal
    const execution = { token: Symbol('native-call'), parameters: { command: 'echo fixture' }, provider: { run: () => {} }, workdir: 'synthetic', requestedMode: 'danger-full-access' }
    let forwarded: ApprovalRequestEvent | undefined
    let consumed = 0
    ctx.on('approval/consume-execution', async (request, next) => {
      expect(request.execution).toBe(execution)
      consumed++
      return next()
    })
    ctx.on('approval/request', async (request) => {
      forwarded = request
      const wire = projectRemoteEventRequest(request, agent)
      expect(wire.request).toMatchObject({ toolName: 'pwsh', callId: 'native-call', reason: 'Run this exact wider command' })
      expect(wire.request).not.toHaveProperty('execution')
      expect(wire.signal).toBe(signal)
      expect(wire.request.id).toEqual(expect.any(String))
      return 'allowed-once'
    })
    await expect(ctx.approval.request({ agent, toolName: 'pwsh', callId: ToolCallId('native-call'), reason: 'Run this exact wider command', signal, execution })).resolves.toBe('allowed-once')
    expect(consumed).toBe(1)
    expect(forwarded).toBeDefined()
    expect(session.snapshotEvents().filter(event => event.type === 'approval/decided').map(event => event.data.outcome)).toEqual(['allowed-once'])
  } finally {
    await ctx.fiber.dispose()
  }
})
