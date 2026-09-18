/** Bind Desktop's shared package inventory to its immutable installation. */
import { readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ProfileResolutionGeneration } from '@deepseek-ai/dsh-app-boot'

/**
 * Lock only inventoried host packages; external plugin dependencies keep native precedence.
 * @param root - Current Desktop runtime directory.
 * @param generation - Computed installation and profile dependency table.
 * @returns Generation whose shared packages cannot be shadowed by profile leftovers.
 */
export function lockDesktopRuntimePackages(root: string, generation: ProfileResolutionGeneration): ProfileResolutionGeneration {
  const value: unknown = JSON.parse(readFileSync(join(root, 'desktop-runtime.json'), 'utf8'))
  if (typeof value !== 'object' || value === null || !('schemaVersion' in value) || value.schemaVersion !== 1
    || !('sharedPackages' in value) || !Array.isArray(value.sharedPackages) || value.sharedPackages.length === 0) {
    throw new Error('dsh desktop: missing shared package inventory')
  }
  const lockedPackageNames = value.sharedPackages.map((item: unknown) => {
    if (typeof item !== 'object' || item === null || !('name' in item) || typeof item.name !== 'string'
      || !/^@[a-z0-9._~-]+\/[a-z0-9._~-]+$/u.test(item.name)
      || !('version' in item) || typeof item.version !== 'string'
      || !('path' in item) || item.path !== `node_modules/${item.name}`) {
      throw new Error('dsh desktop: invalid shared package inventory entry')
    }
    const entry = generation.entries.find(entry => entry.name === item.name && entry.scope === 'installation')
    const expected = resolve(root, item.path)
    if (entry === undefined || entry.version !== item.version
      || realpathSync(entry.packageDir) !== realpathSync(expected)) {
      throw new Error(`dsh desktop: shared package ${item.name} does not match the current runtime`)
    }
    return item.name
  })
  if (new Set(lockedPackageNames).size !== lockedPackageNames.length) {
    throw new Error('dsh desktop: duplicate shared package inventory entry')
  }
  return { ...generation, lockedPackageNames }
}
