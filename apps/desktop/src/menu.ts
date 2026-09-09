/** Native Desktop menu labels and actions, shared by the shell and menu regression checks. */

import type { MenuItemConstructorOptions } from 'electron'
import type { DesktopMessages } from './locale.ts'

/**
 * Build the native application menu with locale-owned command labels.
 * @param options - Platform, application identity, translated labels, and command handlers.
 * @returns Electron menu entries; macOS retains its native application and quit labels.
 */
export function createDesktopMenuTemplate(options: {
  readonly platform: NodeJS.Platform
  readonly applicationName: string
  readonly messages: DesktopMessages
  readonly pluginsEnabled: boolean
  readonly openPlugins: () => void
  readonly checkUpdates: () => void
}): MenuItemConstructorOptions[] {
  const { platform, applicationName, messages, pluginsEnabled, openPlugins, checkUpdates } = options
  return [{
    label: platform === 'darwin' ? applicationName : messages.application,
    submenu: [
      {
        label: pluginsEnabled ? messages.pluginsMenu : messages.pluginsMenuPackagedOnly,
        accelerator: 'CmdOrCtrl+,',
        enabled: pluginsEnabled,
        click: openPlugins,
      },
      { label: messages.checkUpdatesMenu, click: checkUpdates },
      { type: 'separator' },
      { role: 'quit', ...(platform === 'darwin' ? {} : { label: messages.quitMenu }) },
    ],
  }]
}
