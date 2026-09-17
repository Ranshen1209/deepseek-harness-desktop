/**
 * Wire-safe approval identifiers and outcome vocabulary, free of
 * cordis/service imports so browser type chains can
 * consume them without loading this package's Context augmentation.
 * @module @deepseek-ai/dsh-user-approval/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent/types'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'

/**
 * Pairs one `approval/asked` audit event with its `approval/decided`.
 * Service-issued (one fresh id per {@link ApprovalService.request} call).
 */
export type ApprovalRequestId = Branded<'ApprovalRequestId'>

/**
 * Brand a string as an {@link ApprovalRequestId}.
 * @param id - the raw id string to brand.
 * @returns the same string carrying the brand.
 */
export function ApprovalRequestId(id: string): ApprovalRequestId {
  return id as ApprovalRequestId
}

/**
 * Closed approval outcomes: a one-shot grant, explicit rejection, withdrawn
 * request, or unavailable answerer. Callers fail closed on `unavailable`.
 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** Durable facts supplied to a model reviewer, never human authorization. */
export interface ReviewExecutionFacts {
  readonly file?: {
    readonly path: string
    readonly exists: boolean
    readonly withinWorkspace: boolean
    readonly recordedVersion: boolean
    readonly createdBySession: boolean
  }
  readonly execution?: {
    readonly provider: string
    readonly workdir: string
    readonly mode: string
    readonly confinement: string
    readonly entryFiles: readonly { path: string; content: string }[]
  }
  readonly probeDirectories?: readonly string[]
  readonly newTextProbe?: boolean
  readonly unchangedTaskProbe?: boolean
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Exact inspected facts sent to the reviewer; history and pending call are already logged. */
    'approval/review-input': { callId: ToolCallId; facts: ReviewExecutionFacts }
    /** One execution grant; reload never turns this audit record into a reusable permission. */
    'approval/call-authorized': { callId: ToolCallId; toolName: string; fingerprint: string; approvedBy: 'model' | 'human'; workdir: string; mode: string; provider: string }
    /** Successfully committed structured file version; separate from task authorization. */
    'approval/file-committed': { callId: ToolCallId; path: string; identityHash: string; source: 'created' | 'modified' }
  }
}

/** Complete model explanation attached only to Auto's suggested execution. */
export interface ApprovalReview {
  readonly recommendation: 'execute'
  readonly purpose: string
  readonly authorization: string
  readonly scope: string
  readonly consequences: string
}

/** Same-process execution identity; never transmitted to an answerer or persisted. */
export interface ApprovalExecution {
  readonly token: symbol
  readonly parameters: unknown
  readonly provider: object
  readonly workdir: string
  readonly requestedMode: string
}

/** The executor asks whether an existing per-call authorization covers its exact request. */
export interface ExecutionApprovalRequest {
  readonly agent: Agent
  readonly toolName: string
  readonly callId: ToolCallId
  readonly execution: ApprovalExecution
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * An approval question was put to the answerer chain — log-only audit
     * (like `hook/*`; NOT a surface event, carries no `surfaceOp`). `id` pairs
     * it with the `approval/decided` that always follows; `toolName` is the
     * tool the question is about, `callId` the exact tool call when the asker
     * had one, `reason` the asker's human-readable explanation (e.g. a hook's
     * permission-decision reason).
     */
    'approval/asked': {
      id: ApprovalRequestId
      toolName: string
      callId?: ToolCallId
      reason?: string
      review?: ApprovalReview
    }
    /**
     * The outcome of a prior `approval/asked` (same `id`) — log-only audit.
     * Exactly one per ask, appended when the outcome is known: a decision, a
     * cancellation, or the fail-closed `'unavailable'`.
     */
    'approval/decided': {
      id: ApprovalRequestId
      outcome: ApprovalOutcome
    }
  }
}

/** Client-safe payload declared for the approval answerer waterfall. */
export interface ApprovalRequestEvent {
  /** Service-issued request identity, present on dispatched requests. */
  readonly id?: ApprovalRequestId
  /** Agent identity projected to the corresponding Client Context in transit. */
  readonly agent: Agent
  /** Tool whose operation requires a decision. */
  readonly toolName: string
  /** Exact tool call being decided, when available. */
  readonly callId?: ToolCallId
  /** Human-readable reason supplied by the asker. */
  readonly reason?: string
  /** Model execution recommendation, only supplied by Auto. */
  readonly review?: ApprovalReview
  /** Cancellation lifetime of the pending request. */
  readonly signal?: AbortSignal
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Consume an exact execution grant before creating a second approval question.
     * Undefined delegates to normal approval; every other outcome is final.
     * @param req - same-process execution identity supplied by the executor.
     * @mode waterfall
     */
    'approval/consume-execution'(req: ExecutionApprovalRequest, next: () => Promise<ApprovalOutcome | undefined>): Promise<ApprovalOutcome | undefined>

    /**
     * Ask composed answerers for one decision. Return an outcome to claim the
     * request or call `next()` to delegate. Scope-filtered dispatch
     * (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @param req - pending approval request.
     * @mode waterfall
     */
    'approval/request'(
      this: Scoped<Agent>,
      req: ApprovalRequestEvent,
      next: () => Promise<ApprovalOutcome>,
    ): Promise<ApprovalOutcome>
  }
}
