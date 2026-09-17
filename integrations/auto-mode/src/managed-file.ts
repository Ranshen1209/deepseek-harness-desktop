import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type { FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import { inspectStructuredPath, readVerifiedFile, sameFileAncestors } from './file-boundary.js'
import { normalizePath, type PolicyRoots } from './paths.js'
import { preservedMove } from './preserved-move.js'

interface ManagedFileArgs {
  operation: 'read' | 'write' | 'edit' | 'trash' | 'stat' | 'verify_recovery'
  file_path: string
  content?: string
  old_string?: string
  new_string?: string
  create_only?: boolean
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
  recordCreation: (exec: ToolExecution, path: string, identity: string, created: boolean, previousIdentity: string) => void,
): void {
  const recoveries = new WeakMap<object, Map<string, { path: string; identity: string; sha256: string }>>()
  ctx.tools.register(defineTool({
    name: 'managed_file',
    description: 'Read, stat, create, edit or reversibly trash one exact regular file, including outside the workspace. Supply an absolute file_path. stat works for absent files. write with create_only:true refuses existing files. For a user-authorized write/delete test choose a new independent file at a reasonable location and use create_only:true; the user may delegate its filename. After trash, verify_recovery with the ORIGINAL path checks this session\'s preserved bytes without accessing arbitrary recovery data. Each operation needs task/model authorization; ambiguous effects ask once. No directories, permanent deletion or shell execution.',
    parameters: {
      operation: { type: 'string', enum: ['read', 'write', 'edit', 'trash', 'stat', 'verify_recovery'], required: true },
      file_path: { type: 'string', required: true },
      content: { type: 'string', description: 'Complete new content, required for write.' },
      old_string: { type: 'string', description: 'Nonempty literal text matching exactly once, required for edit.' },
      new_string: { type: 'string', description: 'Literal replacement, required for edit.' },
      create_only: { type: 'boolean', description: 'write only: exclusively create a new file; an existing target is refused.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        path: { type: 'string', required: true }, operation: { type: 'string', required: true },
        content: { type: 'string' }, recovery_path: { type: 'string' },
        exists: { type: 'boolean' }, bytes: { type: 'number' }, sha256: { type: 'string' }, recovered: { type: 'boolean' },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: ManagedFileArgs, exec) {
      const roots = rootsFor(exec)
      const mutation = ['write', 'edit', 'trash'].includes(args.operation)
      const allowAbsent = ['stat', 'verify_recovery'].includes(args.operation)
      const inspected = inspectStructuredPath(args.file_path, roots, mutation, true, allowAbsent)
      const path = inspected.nativePath
      let before: Buffer | undefined
      try { before = readVerifiedFile(path, roots, inspected.identity) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || (!allowAbsent && args.operation !== 'write')) throw error }
      if (args.create_only === true && (args.operation !== 'write' || before !== undefined)) throw Error('create_only requires an absent file')
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
        if (inspectStructuredPath(args.file_path, roots, mutation, true, allowAbsent).identity !== inspected.identity) throw Error('file identity changed before the operation')
      }
      assertCurrent()
      if (args.operation === 'stat') return { path, operation: args.operation, exists: before !== undefined,
        ...(before === undefined ? {} : { bytes: before.length, sha256: createHash('sha256').update(before).digest('hex') }) }
      if (args.operation === 'verify_recovery') {
        const receipt = exec.agent && recoveries.get(exec.agent)?.get(path)
        if (!receipt) throw Error('No completed trash receipt for this file in this session')
        if (before !== undefined || inspectStructuredPath(receipt.path, roots, false, true).identity !== receipt.identity) throw Error('Original or recovery file changed since trash')
        const bytes = readFileSync(receipt.path)
        assertCurrent()
        if (createHash('sha256').update(bytes).digest('hex') !== receipt.sha256) throw Error('Recovered content changed')
        return { path, operation: args.operation, exists: false, recovered: true, bytes: bytes.length, sha256: receipt.sha256 }
      }
      if (args.operation === 'read') {
        if (authorized.version === undefined) throw Error('read requires the reviewed file version')
        const content = new TextDecoder('utf-8', { fatal: true }).decode(before!)
        ctx.emit('fs/observed', authorized.target, { kind: 'present', version: authorized.version }, exec)
        return { path, operation: args.operation, content }
      }
      if (args.operation !== 'trash') {
        const intent = await ctx.waterfall('fs/write-intent', authorized.target, exec, () => undefined)
        if (intent === undefined) throw Error('exact write intent is missing')
        if (args.create_only === true && intent.kind !== 'createIfAbsent') throw Error('create_only requires exclusive creation')
        assertCurrent()
        // This call grants the reviewed file leaf; the official provider retains
        // its standard temporary roots. Session workspace and mode are unchanged.
        const outcome = await authorized.fs.writeText(authorized.target, content!, intent, signal, { mode: 'workspace-write', workspaceRoot: path })
        if (content !== undefined) {
          const committed = inspectStructuredPath(path, roots, false, true)
          const info = await authorized.fs.stat(authorized.target, signal)
          if (info?.version !== outcome.version || !sameFileAncestors(inspected.identity, committed.identity) || inspectStructuredPath(path, roots, false, true).identity !== committed.identity
            || !readFileSync(path).equals(Buffer.from(content!))) throw Error('File changed before committed-version recording')
          recordCreation(exec, path, committed.identity, before === undefined, inspected.identity)
        }
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
        preservedMove(path, recovery, () => { assertCurrent(); checkDirectory(area); checkDirectory(entry) }, () => {
          if (exec.agent) {
            const receipts = recoveries.get(exec.agent) ?? new Map()
            receipts.set(path, { path: recovery!, identity: inspectStructuredPath(recovery!, roots, false, true).identity, sha256: createHash('sha256').update(before).digest('hex') })
            recoveries.set(exec.agent, receipts)
          }
        })
        ctx.emit('fs/observed', authorized.target, { kind: 'absent' }, exec)
        return { path, operation: args.operation, recovery_path: recovery }
      }
      throw Error('trash requires an existing regular file')
    },
  }))
}
