import { createHash } from 'node:crypto'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ExecutionFacts } from './upstream-review/index.js'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Facts inspected by the host and supplied to this call's risk review. */
    'approval/review-input': { callId: ToolCallId; facts: ExecutionFacts }
    /** Exact call authorization; replaying the record never grants execution. */
    'approval/call-authorized': { callId: ToolCallId; toolName: string; fingerprint: string; approvedBy: 'model' | 'human'; workdir: string; mode: string; provider: string }
    /** Verified committed file version; the digest grants no cleanup permission. */
    'approval/file-committed': { callId: ToolCallId; path: string; identityHash: string; source: 'created' | 'modified' }
  }
}

/** Persist verified commit facts without storing another copy of file content. */
export function recordFileCommit(exec: ToolExecution, path: string, identity: string, created: boolean): void {
  exec.agent?.session.append('approval/file-committed', { callId: exec.callId, path,
    identityHash: createHash('sha256').update(identity).digest('hex'), source: created ? 'created' : 'modified' })
}
