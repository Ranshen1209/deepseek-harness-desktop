/** Run under the final Electron executable, including its real ASAR and native ABI. */
import { readDesktopRuntime } from '../../src/runtime-tree.ts'
import { smokeDesktopRuntime } from '../../scripts/smoke-runtime.ts'

const [root, fixture] = process.argv.slice(2)
if (root === undefined || fixture === undefined) throw new Error('Packaged smoke requires runtime and fixture paths')
await smokeDesktopRuntime(root, process.execPath, readDesktopRuntime(root), { fixture, resolution: 'runtime' })
