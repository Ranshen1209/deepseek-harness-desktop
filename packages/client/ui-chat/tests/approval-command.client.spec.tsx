// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import type { ChatSnapshot, UseChat } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ApprovalCommand, argumentsOf } from '../src/client/chat/ApprovalCommand.tsx'
import { apply as nodeApply } from '../src/index.ts'

function props(
  nodes: readonly unknown[],
  callId = 'call-1',
): PropsRuntime<'conversation.approval.detail'> {
  const snapshot = {
    nodes: { values: () => nodes },
  } as unknown as ChatSnapshot
  const useChat = ((selector: (value: ChatSnapshot) => unknown) => selector(snapshot)) as UseChat
  return { callId, useChat } as PropsRuntime<'conversation.approval.detail'>
}

describe('argumentsOf', () => {
  it('preserves complete JSON arguments, including fields beside a command', () => {
    const args = { command: 'pnpm test', workdir: 'C:\\project', nested: { enabled: true } }
    expect(argumentsOf(undefined)).toBeUndefined()
    expect(argumentsOf({ callId: 'c1', argsRaw: '{}' })).toBe('{}')
    expect(argumentsOf({ callId: 'c1', argsRaw: JSON.stringify(args) })).toBe(JSON.stringify(args, null, 2))
  })

  it('shows the original text when arguments cannot be parsed', () => {
    expect(argumentsOf({ callId: 'c1', argsRaw: '{' })).toBe('{')
  })
})

describe('ApprovalCommand', () => {
  it('renders every argument of the running correlated Tool call', () => {
    const args = { operation: 'write', file_path: 'C:\\outside\\probe.txt', content: 'known probe content' }
    const { container } = render(<ApprovalCommand {...props([
      { kind: 'assistant-step', data: {} },
      { kind: 'tool-call', data: { root: { callId: 'other', argsRaw: '{"command":"wrong"}' } } },
      { kind: 'tool-call', data: { root: { callId: 'call-1', argsRaw: JSON.stringify(args) } } },
    ] as never)} />)

    expect(container.textContent).toBe(JSON.stringify(args, null, 2))
    expect(screen.queryByText('wrong')).toBeNull()
  })

  it('keeps long file content fully expanded and displays markup as plain text', () => {
    const args = {
      operation: 'write',
      file_path: 'C:\\outside\\probe.txt',
      content: `${'a'.repeat(25_000)}\n<script>untrusted()</script>\nfinal line`,
    }
    const { container } = render(<ApprovalCommand {...props([
      { kind: 'tool-call', data: { root: { callId: 'call-1', argsRaw: JSON.stringify(args) } } },
    ] as never)} />)

    expect(container.textContent).toBe(JSON.stringify(args, null, 2))
    expect(container.querySelector('script')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('changes displayed arguments only with the correlated call identity', () => {
    const nodes = [
      { kind: 'tool-call', data: { root: { callId: 'call-1', argsRaw: '{"file_path":"first.txt"}' } } },
      { kind: 'tool-call', data: { root: { callId: 'call-2', argsRaw: '{"file_path":"second.txt"}' } } },
    ]
    const { container, rerender } = render(<ApprovalCommand {...props(nodes)} />)
    expect(container.textContent).toBe(JSON.stringify({ file_path: 'first.txt' }, null, 2))

    rerender(<ApprovalCommand {...props(nodes, 'call-2')} />)
    expect(container.textContent).toBe(JSON.stringify({ file_path: 'second.txt' }, null, 2))

    rerender(<ApprovalCommand {...props(nodes, 'missing')} />)
    expect(container.textContent).toBe('')
  })

  it('omits absent, uncorrelated, and settled Tool calls', () => {
    const { container, rerender } = render(<ApprovalCommand {...props([
      { kind: 'assistant-step', data: {} },
      { kind: 'tool-call', data: { root: undefined } },
      { kind: 'tool-call', data: { root: { callId: 'other', argsRaw: '{}' } } },
      {
        kind: 'tool-call',
        data: { root: { kind: 'tool-result', callId: 'call-1', argsRaw: '{"command":"ignored"}' } },
      },
    ] as never)} />)
    expect(container.textContent).toBe('')

    rerender(<ApprovalCommand {...props([
      { kind: 'tool-call', data: { root: { callId: 'call-1', argsRaw: '{}' } } },
    ] as never)} />)
    expect(container.textContent).toBe('{}')
  })
})

describe('ui-chat package entries', () => {
  it('keeps the Host half optional', () => {
    const ctx = new Context()
    expect(() => { nodeApply(ctx) }).not.toThrow()
  })
})
