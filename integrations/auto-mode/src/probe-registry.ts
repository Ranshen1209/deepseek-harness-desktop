import { dirname, basename } from 'node:path'
import { lstatSync } from 'node:fs'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { inspectStructuredPath } from './file-boundary.js'
import { type PolicyRoots } from './paths.js'

interface ProbeRecord { readonly identity: string; readonly task: string }

/** Process-local evidence of a successfully created, unchanged text probe; never task authorization. */
export class ProbeRegistry {
  private readonly records = new WeakMap<object, Map<string, ProbeRecord>>()

  /** Only new text leaves directly under an actual configured temp directory can be probes. */
  eligible(path: string, roots: PolicyRoots): boolean {
    if (!/^dsh-probe-[a-z0-9-]{8,100}\.txt$/i.test(basename(path))) return false
    const parent = lstatSync(dirname(path), { bigint: true })
    return roots.tempRoots.some(root => {
      try { const info = lstatSync(root, { bigint: true }); return info.isDirectory() && !info.isSymbolicLink() && info.ino === parent.ino && info.dev === parent.dev }
      catch { return false }
    })
  }

  /** Record only after a create-if-absent commit succeeded. */
  remember(exec: ToolExecution, path: string, identity: string, task: string): void {
    if (!exec.agent) return
    const records = this.records.get(exec.agent) ?? new Map<string, ProbeRecord>()
    records.set(path, { identity, task })
    this.records.set(exec.agent, records)
  }

  /** Replaced files, changed tasks and different agents cannot reuse probe evidence. */
  matches(exec: Readonly<ToolExecution>, path: string, roots: PolicyRoots, task: string): boolean {
    if (!exec.agent) return false
    const record = this.records.get(exec.agent)?.get(path)
    if (!record || record.task !== task) return false
    try { return record.identity === inspectStructuredPath(path, roots, false, true).identity }
    catch { return false }
  }
}
