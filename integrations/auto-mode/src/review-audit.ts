import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizePath } from './paths.js'

/** Persist model authorization separately from human approval events, without raw file contents. */
export function beginReviewAudit(dshHome: string, record: Record<string, unknown>): (outcome: 'success' | 'error') => void {
  const directory = join(dshHome, 'auto-review')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const check = () => {
    const info = lstatSync(directory)
    if (!info.isDirectory() || info.isSymbolicLink() || normalizePath(realpathSync.native(directory), directory) !== normalizePath(directory, directory)) throw Error('Auto review audit directory must not be an alias')
  }
  check()
  const id = randomUUID()
  writeFileSync(join(directory, `${id}.json`), JSON.stringify({ ...record, timestamp: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 })
  return outcome => {
    check()
    writeFileSync(join(directory, `${id}.result.json`), JSON.stringify({ outcome, timestamp: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 })
  }
}
