import { createHash } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { hardDestructiveTargetReason, normalizePath, resolveNativePath, workspaceRootReason, type PolicyRoots } from './paths.js'

/** Reject ambiguous names before normalization can erase their meaning. */
export function ambiguousPathReason(input: string, windows = process.platform === 'win32'): string | undefined {
  if (!input || input.length > 4096 || /[\x00-\x1f\x7f*?]/.test(input)) return 'empty, oversized, control-character or wildcard path'
  if (input.startsWith('~')) return 'home expansion is not a literal path'
  if (input.replaceAll('\\', '/').split('/').includes('..')) return 'parent traversal'
  if (!windows) return input.includes('\\') ? 'foreign path separator' : undefined
  const path = input.replaceAll('/', '\\')
  if (path.startsWith('\\')) return 'UNC, rooted or device namespace path'
  if (/^[a-z]:(?!\\)/i.test(path)) return 'drive-relative path'
  const tail = path.replace(/^[a-z]:\\/i, '')
  if (/[:<>"|]/.test(tail)) return 'alternate data stream or invalid path character'
  for (const part of tail.split('\\')) {
    if (part === '..') return 'parent traversal'
    if (part === '.') continue
    if (/[ .]$/.test(part) || /~\d/i.test(part)) return 'trailing-dot/space or short-name alias'
    if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)) return 'reserved Windows device'
  }
  return undefined
}

export interface FileBoundary { readonly path: string; readonly nativePath: string; readonly identity: string; readonly withinWorkspace: boolean }

/** File commits may replace a leaf, never the directories that were approved. */
export function sameFileAncestors(before: string, after: string): boolean {
  return JSON.stringify((JSON.parse(before) as unknown[]).slice(0, -1)) === JSON.stringify((JSON.parse(after) as unknown[]).slice(0, -1))
}

/** Bound memory even when another process expands an inspected file. */
function readHandle(handle: number, size: number): Buffer {
  if (size > 16 * 1024 * 1024) throw Error('File exceeds the exact-review limit')
  const bytes = Buffer.alloc(size + 1)
  let count = 0
  while (count < bytes.length) {
    const length = readSync(handle, bytes, count, bytes.length - count, count)
    if (!length) break
    count += length
  }
  if (count !== size) throw Error('File size changed while reading')
  return bytes.subarray(0, size)
}

/** Hash only the inspected regular file version. */
function fileHash(path: string, expected: BigIntStats): string {
  const handle = openSync(path, 'r')
  try {
    const before = fstatSync(handle, { bigint: true })
    const same = (info: typeof before) => info.dev === expected.dev && info.ino === expected.ino && info.size === expected.size
      && info.ctimeNs === expected.ctimeNs && info.mtimeNs === expected.mtimeNs && info.nlink === 1n
    if (!same(before)) throw Error('File changed before hashing')
    const bytes = readHandle(handle, Number(before.size))
    if (!same(fstatSync(handle, { bigint: true }))) throw Error('File changed during hashing')
    return createHash('sha256').update(bytes).digest('hex')
  } finally { closeSync(handle) }
}

/** Read an inspected file through one handle; never release bytes from a replaced path. */
export function readVerifiedFile(path: string, roots: PolicyRoots, expected: string): Buffer {
  const handle = openSync(path, 'r')
  try {
    const before = fstatSync(handle, { bigint: true })
    const signature = (info: typeof before) => [String(info.dev), String(info.ino), String(info.mode), String(info.ctimeNs), String(info.mtimeNs), String(info.size)]
    const leaf = (JSON.parse(expected) as string[][]).at(-1)!
    if (!before.isFile() || before.nlink !== 1n || JSON.stringify(signature(before)) !== JSON.stringify(leaf.slice(1, 7))) throw Error('File handle differs from the inspected target')
    const bytes = readHandle(handle, Number(before.size))
    if (JSON.stringify(signature(fstatSync(handle, { bigint: true }))) !== JSON.stringify(signature(before))
      || createHash('sha256').update(bytes).digest('hex') !== leaf[7]
      || inspectStructuredPath(path, roots, false, true).identity !== expected) throw Error('File changed while reading its snapshot')
    return bytes
  } finally { closeSync(handle) }
}

/**
 * Inspect the actual local file and every ancestor. No links are followed for
 * authorization. This is a last-moment check, not an atomic OS file capability.
 * Trusted host/filesystem code must still prevent a concurrent replacement
 * between the tool guard and its own open/write operation.
 */
export function inspectStructuredPath(input: string, roots: PolicyRoots, mutation: boolean, allowOutside = false, allowAbsent = false, directory = false): FileBoundary {
  const ambiguous = ambiguousPathReason(input) ?? ambiguousPathReason(roots.workspace)
  if (ambiguous) throw Error(ambiguous)
  const workspace = resolveNativePath(roots.workspace, roots.workspace)
  if (!isAbsolute(workspace)) throw Error('workspace root must be absolute')
  const rootReason = workspaceRootReason(workspace, roots)
  if (rootReason !== undefined) throw Error(`unsafe workspace root: ${rootReason}`)
  const workspaceInfo = lstatSync(workspace, { bigint: true })
  if (!workspaceInfo.isDirectory() || workspaceInfo.isSymbolicLink() || workspaceInfo.ino === 0n) throw Error('unverifiable workspace directory')
  const target = resolve(workspace, input)
  if (!directory && normalizePath(target, workspace) === normalizePath(workspace, workspace)) throw Error('target must be an exact file, not the workspace root')
  if (hardDestructiveTargetReason(target, roots) && !(directory && !mutation && target === roots.home)) throw Error('protected file target')
  const parts: string[] = []
  let current = target
  while (true) {
    parts.unshift(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  const identity: unknown[] = [['workspace', workspace, String(workspaceInfo.dev), String(workspaceInfo.ino)]]
  let withinWorkspace = false
  for (const part of parts) {
    let info
    try { info = lstatSync(part, { bigint: true }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && part === target && (mutation || allowAbsent)) {
        identity.push([part, 'absent'])
        continue
      }
      throw Error('file or ancestor is unavailable')
    }
    if (info.isSymbolicLink()) throw Error('symbolic links and junctions are not authorized')
    // Detect realpath aliases that lstat alone might not identify.
    if (normalizePath(realpathSync.native(part), workspace) !== normalizePath(part, workspace)) throw Error('filesystem alias is not authorized')
    if (part !== target || directory) {
      if (!info.isDirectory()) throw Error('ancestor is not a directory')
      if (info.dev === workspaceInfo.dev && info.ino === workspaceInfo.ino) withinWorkspace = true
      identity.push([part, String(info.dev), String(info.ino), String(info.mode)])
    } else {
      if (!info.isFile() || info.nlink !== 1n) throw Error('target must be a regular file with exactly one link')
      if (info.size > 16n * 1024n * 1024n) throw Error('file exceeds the 16 MiB exact-review limit')
      identity.push([part, String(info.dev), String(info.ino), String(info.mode), String(info.ctimeNs), String(info.mtimeNs), String(info.size),
        fileHash(part, info)])
    }
  }
  if (!allowOutside && !withinWorkspace) throw Error('target is outside the actual workspace directory')
  return { path: normalizePath(target, workspace), nativePath: target, identity: JSON.stringify(identity), withinWorkspace }
}
