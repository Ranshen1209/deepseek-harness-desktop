/** Browser approval consumer over the existing scoped Remote Event waterfall. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PendingInteractionPublisher } from '@deepseek-ai/dsh-client-ui-session/client'
import type { TypertClientEventListener } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { ApprovalPanel } from './ApprovalPanel.tsx'
import { PendingApproval } from './contract/slots.ts'
import { en, zh } from './locales.ts'

export type {
  ApprovalComposerProps,
  ApprovalDecision,
  ApprovalDetailOwnerProps,
  ApprovalPresentationRequest,
  PendingApproval,
} from './contract/slots.ts'
export type { ApprovalKey } from './locales.ts'

/** Required services: Agent scopes, Remote Events, Session UI, Slot registry, and copy. */
export const inject = ['sessions', 'remote', 'uiSession', 'slots', 'locale']

const NS = 'approval'

type ApprovalListener = TypertClientEventListener<'approval/request'>
type ClientApprovalRequest = Parameters<ApprovalListener>[0]
type ClientApprovalNext = Parameters<ApprovalListener>[1]
type ClientApprovalOutcome = Awaited<ReturnType<ApprovalListener>>

/* jscpd:ignore-start -- Approval and Question intentionally mirror one Remote waterfall lifecycle. */
/** Present one request until the user answers or its lifetime ends. */
async function answerApproval(
  ctx: ClientContext,
  owner: ClientContext,
  request: ClientApprovalRequest,
  next: ClientApprovalNext,
  registerPendingInteraction: PendingInteractionPublisher<PendingApproval>,
  onPending: (pending: PendingApproval) => () => void,
): Promise<ClientApprovalOutcome> {
  const sessionId = ctx.sessions.scopeOf(owner)
  if (sessionId === undefined) return next()
  const pending = new PendingApproval(sessionId, {
    toolName: request.toolName,
    ...(request.id === undefined ? {} : { id: request.id }),
    ...(request.review === undefined ? {} : { review: request.review }),
    ...(request.callId === undefined
      ? {}
      : { callId: request.callId }),
    ...(request.reason === undefined ? {} : { reason: request.reason }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  })
  const completed = Promise.withResolvers<void>()
  const remove = registerPendingInteraction(pending, async () => {
    pending.delegate()
    await completed.promise
  })
  const removeNavigation = onPending(pending)
  try {
    try {
      return await pending.result
    } catch (error) {
      if (pending.isDelegation(error)) return await next()
      throw error
    }
  } finally {
    removeNavigation()
    remove()
    completed.resolve()
  }
}
/* jscpd:ignore-end */

/**
 * Install approval copy and the scoped waterfall consumer.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-approval: dictionaries')
  const registerPendingInteraction = ctx.uiSession.registerPendingInteraction<PendingApproval>(
    () => 0,
  )
  ctx.slots.inject('conversation.composer', () => ctx.slots.register({
    name: 'conversation.composer',
    priority: 1,
    select: ({ pendingInteraction }: ComposerChainProps): PendingApproval | null =>
      pendingInteraction instanceof PendingApproval ? pendingInteraction : null,
    locale: NS,
    children: {
      'conversation.approval.detail': { kind: 'single', scope: 'session' },
    },
  }, ApprovalPanel))
  const pending = new Map<string, PendingApproval>()
  let requested: { requestId: string; sessionId: string } | undefined
  const locate = (): void => {
    if (requested === undefined) return
    const current = pending.get(requested.requestId)
    if (current === undefined || current.sessionId !== requested.sessionId) return
    if (!ctx.uiSession.focusPendingInteraction(current.sessionId, current.key)) return
    ctx.sessions.open(current.sessionId as SessionId)
    requested = undefined
  }
  const onPending = (value: PendingApproval): (() => void) => {
    if (value.id !== undefined) pending.set(value.id, value)
    locate()
    return () => { if (value.id !== undefined) pending.delete(value.id) }
  }
  // The isolated preload exposes only a subscription; pages cannot create notifications or grant approval.
  const bridge = Reflect.get(globalThis, 'dshDesktop') as { onApprovalNavigation?: (listener: (target: { requestId: string; sessionId: string }) => void) => () => void } | undefined
  const subscribe = bridge?.onApprovalNavigation
  if (typeof subscribe === 'function') {
    ctx.effect(() => subscribe((target) => { requested = target; locate() }), 'ui-approval: desktop navigation')
  }
  ctx.remote.$on('approval/request', function (request, next) {
    return answerApproval(ctx, this, request, next, registerPendingInteraction, onPending)
  })
}
