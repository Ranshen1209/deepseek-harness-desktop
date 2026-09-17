import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { inspectStructuredPath } from './file-boundary.js'
import type { PolicyRoots } from './paths.js'

/** Successfully committed file versions, scoped to the actual Agent; never task authorization. */
export class FileRecordRegistry {
  private readonly records = new WeakMap<object, Map<string, { identity: string; created: boolean }>>()

  /** Record only after the provider commit and byte/version verification succeed. */
  remember(exec: ToolExecution, path: string, identity: string, created = false, previousIdentity?: string): void {
    if (!exec.agent) return
    const records = this.records.get(exec.agent) ?? new Map<string, { identity: string; created: boolean }>()
    const previous = records.get(path)
    records.set(path, { identity, created: created || (previous !== undefined && previous.identity === previousIdentity && previous.created) })
    this.records.set(exec.agent, records)
  }

  /** Edits must commit a new version; external replacements and other Agents cannot reuse it. */
  matches(exec: Readonly<ToolExecution>, path: string, roots: PolicyRoots): boolean {
    if (!exec.agent) return false
    const record = this.records.get(exec.agent)?.get(path)
    if (record === undefined) return false
    try { return record.identity === inspectStructuredPath(path, roots, false, true).identity }
    catch { return false }
  }
  /** Distinguish a new task file from a user file modified by this Agent. */
  created(exec: Readonly<ToolExecution>, path: string, roots: PolicyRoots): boolean {
    return this.matches(exec, path, roots) && this.records.get(exec.agent!)?.get(path)?.created === true
  }

}
