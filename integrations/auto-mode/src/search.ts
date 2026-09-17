import { lstatSync, opendirSync } from 'node:fs'
import { basename, relative, resolve } from 'node:path'
import picomatch from 'picomatch'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { ambiguousPathReason, inspectStructuredPath, readVerifiedFile } from './file-boundary.js'
import { inspectDirectory } from './managed-list.js'
import { isProtectedProjectPath, sensitiveReadPath, type PolicyRoots } from './paths.js'

/** Fixed-argv search batches plus validation before any output is released. */
export interface SearchPlan {
  readonly batches: readonly { argv: readonly string[]; stdin?: string }[]
  readonly project: (stdout: string) => string
  readonly beforeSpawn: () => void
  readonly validate: () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context { fileSearchAccessVersion: 1 }
  interface Events {
    /** Bound native search to inspected files without following links. @mode waterfall */
    'fs-search/plan'(exec: ToolExecution, argv: readonly string[], next: () => Promise<SearchPlan | undefined>): Promise<SearchPlan | undefined>
  }
}

/** Inspect an exact search root, accepting one regular file or directory. */
export function searchIdentity(input: string, roots: PolicyRoots): string {
  const reason = ambiguousPathReason(input)
  if (reason !== undefined) throw Error(reason)
  const path = resolve(roots.workspace, input)
  return lstatSync(path).isDirectory() ? inspectDirectory(path, roots).identity : inspectStructuredPath(path, roots, false, true).identity
}

/** Register a bounded native search plan only for Auto calls. */
export function installSearchPolicy(ctx: Context, rootsFor: (exec: ToolExecution) => PolicyRoots, active: (exec: ToolExecution) => boolean, validate: (exec: ToolExecution) => void): void {
  ctx.on('fs-search/plan', async (exec, _argv, next) => {
    if (!active(exec)) return next()
    validate(exec)
    const roots = rootsFor(exec)
    const args = exec.arguments as { path?: string; pattern: string; include?: string }
    const reason = ambiguousPathReason(args.path ?? '.')
    if (reason !== undefined) throw Error(reason)
    const root = resolve(roots.workspace, args.path ?? '.')
    const initial = searchIdentity(root, roots)
    const base = lstatSync(root).isDirectory() ? root : resolve(root, '..')
    const entries: Array<{ path: string; identity: string; modified: number }> = []
    const pattern = exec.name === 'glob' ? args.pattern : args.include
    const match = pattern === undefined ? undefined : picomatch(pattern, { dot: true, strictBrackets: true })
    const directories = [root]
    let inspected = 0
    let queued = 1
    let bytes = 0
    while (directories.length) {
      exec.signal.throwIfAborted()
      const path = directories.pop()!
      if (++inspected > 20_000) throw Error('Auto search exceeds 20000 entries; choose a narrower directory')
      if (isProtectedProjectPath(path, roots) || sensitiveReadPath(path)) continue
      const info = lstatSync(path)
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) {
        inspectDirectory(path, roots)
        const directory = opendirSync(path)
        try { for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
          if (++queued > 20_000) throw Error('Auto search exceeds 20000 entries; choose a narrower directory')
          const name = entry.name
          // Generated dependency trees can be searched explicitly, not swept by a broad project search.
          if (['node_modules', '.git', '.svn', '.hg', '.bzr', '.jj', '.sl', '.auto-recovery'].includes(name)) continue
          directories.push(resolve(path, name))
        } } finally { directory.closeSync() }
      } else if (info.isFile() && info.nlink === 1 && info.size <= 16 * 1024 * 1024) {
        const name = relative(base, path).replaceAll('\\', '/')
        if (match !== undefined && !match(pattern!.includes('/') ? name : basename(path))) continue
        let identity: string
        try { identity = inspectStructuredPath(path, roots, false, true).identity }
        catch { continue }
        bytes += info.size
        if (bytes > 128 * 1024 * 1024 || entries.length >= 10_000) throw Error('Auto search exceeds its file review limit; choose a narrower directory')
        entries.push({ path, identity, modified: info.mtimeMs })
      }
    }
    entries.sort((a, b) => a.modified - b.modified || a.path.localeCompare(b.path))
    const batches: Array<{ argv: string[]; stdin: string }> = []
    const spans: Array<{ start: number; end: number; path: string }> = []
    const content: string[] = []
    // Absolute-input anchors must keep each file as its own regex input.
    const perFile = /\\[AzZ]/.test(args.pattern)
    let line = 1
    for (const entry of entries) {
      if (exec.name === 'glob') continue
      const bytes = readVerifiedFile(entry.path, roots, entry.identity)
      if (bytes.includes(0)) continue
      let text: string
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
      catch { continue }
      if (!text) continue
      if (perFile) { batches.push({ argv: ['--json', `--regexp=${args.pattern}`, `--label=${entry.path}`, '--', '-'], stdin: text }); continue }
      if (!text.endsWith('\n')) text += '\n'
      const lines = text.split('\n').length - 1
      spans.push({ start: line, end: line + lines, path: entry.path })
      line += lines
      content.push(text)
    }
    if (content.length) batches.push({ argv: ['--json', `--regexp=${args.pattern}`, '--', '-'], stdin: content.join('') })
    const project = (stdout: string): string => {
      if (exec.name === 'glob') return entries.map(entry => entry.path).join('\n')
      if (perFile) return stdout
      return stdout.split('\n').filter(Boolean).flatMap(line => {
        const record = JSON.parse(line) as { type: string; data: { line_number: number; path: { text: string } } }
        if (record.type !== 'match') return []
        const span = spans.find(span => record.data.line_number >= span.start && record.data.line_number < span.end)
        if (span === undefined) throw Error('Search returned an unknown snapshot line')
        record.data.path = { text: span.path }
        record.data.line_number -= span.start - 1
        return [JSON.stringify(record)]
      }).join('\n')
    }
    return { batches, project, beforeSpawn: () => validate(exec), validate: () => {
      validate(exec)
      if (searchIdentity(root, roots) !== initial) throw Error('Search root changed during execution')
      for (const entry of entries) if (inspectStructuredPath(entry.path, roots, false, true).identity !== entry.identity) throw Error('Search file changed; results were withheld')
    } }
  }, { prepend: true })
}
