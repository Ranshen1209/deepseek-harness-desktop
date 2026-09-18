/** Retired permission selections require an explicit choice before another tool runs. */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-permission-presets'

/** Install only upgrade admission checks; the official Auto plugin owns its execution policy. */
export function installLegacyPermissionGate(ctx: Context): void {
  ctx.inject(['tools', 'permissionPresets'], (scope) => {
    const guard = (exec: Readonly<ToolExecution>): string | undefined => {
      if (exec.agent === undefined) return undefined
      const mode = scope.permissionPresets.current(exec.agent.session)
      return mode === 'custom' || mode === 'preservation'
        ? 'Saved permissions require reselection. Choose Read only, Workspace write, Full access, or official Auto review before continuing.'
        : undefined
    }
    scope.tools.guard(guard)
    scope.tools.guard(guard, 'dispatch')
  })
}
