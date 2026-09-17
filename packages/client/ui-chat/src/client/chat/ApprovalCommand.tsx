/** Chat-owned approval detail showing the complete correlated Tool arguments. */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-approval/client'
import type { ChatNode } from '../contract/chat-nodes.ts'
import css from './ContextBody.module.css'

interface ApprovalToolCall {
  readonly callId: string
  readonly argsRaw: string
}

/**
 * Format every argument of the correlated Tool call without truncating values.
 * @param call - Tool call arguments, when a correlated call exists.
 * @returns complete JSON, the original unparseable text, or undefined for an absent call.
 */
export function argumentsOf(call: ApprovalToolCall | undefined): string | undefined {
  if (call === undefined) return undefined
  try {
    return JSON.stringify(JSON.parse(call.argsRaw), null, 2)
  } catch {
    return call.argsRaw
  }
}

/**
 * Render complete arguments of the running Chat Tool node correlated with an approval.
 * @param props - Approval identity and Session-standard Chat selector hook.
 * @returns plain, fully expanded argument text for the exact pending call.
 */
export function ApprovalCommand({ callId, useChat }: PropsRuntime<'conversation.approval.detail'>) {
  const argumentsText = useChat((snapshot) => {
    for (const node of snapshot.nodes.values()) {
      const root = node.kind === 'tool-call' ? (node as ChatNode<'tool-call'>).data.root : undefined
      if (root !== undefined && root.callId === callId && !('kind' in root)) return argumentsOf(root)
    }
    return undefined
  })
  return argumentsText === undefined ? null : <pre className={css.text}>{argumentsText}</pre>
}
