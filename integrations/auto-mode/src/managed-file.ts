import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type { FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import { inspectStructuredPath } from './file-boundary.js'
import { normalizePath, type PolicyRoots } from './paths.js'

interface ManagedFileArgs {
  operation: 'read' | 'write' | 'edit' | 'trash'
  file_path: string
  content?: string
  old_string?: string
  new_string?: string
}

/** A file identity captured and checked by the policy for one registered call. */
export interface ManagedFileAuthorization {
  readonly fs: Context['fs']
  readonly target: FsTarget
  readonly version: FsVersion | undefined
  readonly revalidate: () => void
  readonly consume: () => void
}

/** Register exact-file operations; trash preserves the source and writes retain provider ACL/version checks. */
export function registerManagedFile(
  ctx: Context,
  rootsFor: (exec: Readonly<ToolExecution>) => PolicyRoots,
  authorize: (exec: ToolExecution) => Promise<ManagedFileAuthorization>,
  policySignal: AbortSignal,
): void {
  ctx.tools.register(defineTool({
    name: 'managed_file',
    description: 'Read, create, edit or remove one exact regular file. Use for necessary work outside the workspace or reversible deletion. Trash moves the original into .auto-recovery; no permanent deletion or directory operations. Supply an absolute file_path. Model review is required; outside targets and trash are automatic only when a direct human instruction names the complete path in quotes, backticks or on its own line, otherwise confirmation is requested. Never use this to bypass a denial.',
    parameters: {
      operation: { type: 'string', enum: ['read', 'write', 'edit', 'trash'], required: true },
      file_path: { type: 'string', required: true },
      content: { type: 'string', description: 'Complete new content, required for write.' },
      old_string: { type: 'string', description: 'Nonempty literal text matching exactly once, required for edit.' },
      new_string: { type: 'string', description: 'Literal replacement, required for edit.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        path: { type: 'string', required: true }, operation: { type: 'string', required: true },
        content: { type: 'string' }, recovery_path: { type: 'string' },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: ManagedFileArgs, exec) {
      const roots = rootsFor(exec)
      const mutation = args.operation !== 'read'
      const inspected = inspectStructuredPath(args.file_path, roots, mutation, true)
      const path = inspected.nativePath
      let before: Buffer | undefined
      try { before = readFileSync(path) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || args.operation !== 'write') throw error }
      let content: string | undefined
      if (args.operation === 'write') {
        if (typeof args.content !== 'string') throw Error('write requires complete content')
        content = args.content
      } else if (args.operation === 'edit') {
        if (!before || typeof args.old_string !== 'string' || !args.old_string || typeof args.new_string !== 'string') throw Error('edit requires an existing text file, nonempty old_string and new_string')
        const text = new TextDecoder('utf-8', { fatal: true }).decode(before)
        if (text.split(args.old_string).length !== 2) throw Error('old_string must match exactly once')
        content = text.replace(args.old_string, () => args.new_string!)
      }
      if (content !== undefined && Buffer.byteLength(content) > 1_000_000) throw Error('split content larger than the exact-call limit')
      if (args.operation === 'read' && before!.length > 1_000_000) throw Error('read exceeds the complete-result limit')
      const authorized = await authorize(exec)
      const signal = AbortSignal.any([exec.signal, policySignal])
      const assertCurrent = () => {
        signal.throwIfAborted()
        authorized.revalidate()
        if (inspectStructuredPath(args.file_path, roots, mutation, true).identity !== inspected.identity) throw Error('file identity changed before the operation')
      }
      assertCurrent()
      if (args.operation === 'read') {
        if (authorized.version === undefined) throw Error('read requires the reviewed file version')
        const content = new TextDecoder('utf-8', { fatal: true }).decode(before!)
        ctx.emit('fs/observed', authorized.target, { kind: 'present', version: authorized.version }, exec)
        return { path, operation: args.operation, content }
      }
      if (args.operation !== 'trash') {
        const intent = await ctx.waterfall('fs/write-intent', authorized.target, exec, () => undefined)
        if (intent === undefined) throw Error('exact write intent is missing')
        assertCurrent()
        // This call grants the reviewed file leaf; the official provider retains
        // its standard temporary roots. Session workspace and mode are unchanged.
        const outcome = await authorized.fs.writeText(authorized.target, content!, intent, signal, { mode: 'workspace-write', workspaceRoot: path })
        ctx.emit('fs/observed', authorized.target, { kind: 'present', version: outcome.version }, exec)
        return { path, operation: args.operation }
      }

      let recovery: string | undefined
      if (before !== undefined) {
        const area = join(dirname(path), '.auto-recovery')
        try { mkdirSync(area, { mode: 0o700 }) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
        const checkDirectory = (directory: string) => {
          const info = lstatSync(directory)
          if (!info.isDirectory() || info.isSymbolicLink() || normalizePath(realpathSync.native(directory), roots.workspace) !== normalizePath(directory, roots.workspace)) throw Error('recovery directory must not be an alias')
        }
        checkDirectory(area)
        const entry = mkdtempSync(join(area, 'file-'))
        checkDirectory(entry)
        recovery = join(entry, 'data')
        // The receipt is created before the move; a failed move never destroys the source.
        writeFileSync(join(entry, 'receipt.json'), JSON.stringify({ original_path: path, recovery_path: recovery, created_at: new Date().toISOString(), sha256: createHash('sha256').update(before).digest('hex') }) + '\n', { flag: 'wx', mode: 0o600 })
        assertCurrent()
        checkDirectory(area)
        checkDirectory(entry)
        authorized.consume()
        assertCurrent()
        renameSync(path, recovery)
        ctx.emit('fs/observed', authorized.target, { kind: 'absent' }, exec)
        return { path, operation: args.operation, recovery_path: recovery }
      }
      throw Error('trash requires an existing regular file')
    },
  }))
}
