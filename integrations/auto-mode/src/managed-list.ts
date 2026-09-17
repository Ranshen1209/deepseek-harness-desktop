import { lstatSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import { inspectStructuredPath } from './file-boundary.js'
import { isCriticalPath, isProtectedProjectPath, sensitiveReadPath, type PolicyRoots } from './paths.js'

/** Validate a directory through its ancestors without following links or traversing it. */
export function inspectDirectory(input: string, roots: PolicyRoots): { path: string; identity: string } {
  const directory = inspectStructuredPath(input, roots, false, true, false, true)
  if (isProtectedProjectPath(directory.nativePath, roots) || sensitiveReadPath(directory.nativePath)) throw Error('Protected directory cannot be listed')
  return { path: directory.nativePath, identity: directory.identity }
}

/** Bounded workspace listing substitutes for commands and unrestricted recursive search. */
export function registerManagedList(ctx: Context, rootsFor: (exec: Readonly<ToolExecution>) => PolicyRoots): void {
  ctx.tools.register(defineTool({
    name: 'managed_list',
    description: 'List up to 200 entries in one ordinary directory, without running a command or following links. Protected metadata, credential paths, links and hard-linked files are omitted. Use returned subdirectories for bounded navigation and structured reads for content. Optional contains is a literal case-sensitive filename filter, never a pattern or script.',
    parameters: { directory: { type: 'string', required: true }, contains: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      directory: { type: 'string', required: true }, entries: { type: 'array', items: { type: 'string' }, required: true }, truncated: { type: 'boolean', required: true },
    } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args: { directory: string; contains?: string }, exec) {
      exec.signal.throwIfAborted()
      const roots = rootsFor(exec)
      const initial = inspectDirectory(args.directory, roots)
      const entries: string[] = []
      let truncated = false
      for (const name of readdirSync(initial.path)) {
        exec.signal.throwIfAborted()
        if (args.contains !== undefined && !name.includes(args.contains)) continue
        if (entries.length === 200) { truncated = true; break }
        const path = resolve(initial.path, name)
        if (isProtectedProjectPath(path, roots) || isCriticalPath(path, roots) || sensitiveReadPath(path)) continue
        try {
          const info = lstatSync(path)
          if (info.isSymbolicLink()) continue
          if (info.isDirectory()) { inspectDirectory(path, roots); entries.push(name + '/') }
          else if (info.isFile() && info.nlink === 1) entries.push(name)
        } catch { /* An unavailable, protected or linked child is not an authorized result. */ }
      }
      if (inspectDirectory(args.directory, roots).identity !== initial.identity) throw Error('Directory identity changed during listing')
      return { directory: initial.path, entries, truncated }
    },
  }))
}
