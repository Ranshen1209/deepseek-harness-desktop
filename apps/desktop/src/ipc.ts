/** Typed preload operations exposed only by the Electron shell. */

import type { DesktopPluginRecord, DesktopReleaseProgressPhase } from './project-manager.ts'
import type { DesktopLocale } from './locale.ts'

/** IPC channel names kept private to the desktop application bundle. */
export const DESKTOP_IPC = {
  localeGet: 'dsh-desktop:locale-get',
  setupGet: 'dsh-desktop:setup-get',
  setupState: 'dsh-desktop:setup-state',
  pluginsList: 'dsh-desktop:plugins-list',
  pluginsAdd: 'dsh-desktop:plugins-add',
  pluginsRemove: 'dsh-desktop:plugins-remove',
  pluginsUpdate: 'dsh-desktop:plugins-update',
  updatesCheck: 'dsh-desktop:updates-check',
  updatesInstall: 'dsh-desktop:updates-install',
  updatesState: 'dsh-desktop:updates-state',
} as const

/** First-run and upgrade progress rendered by the Desktop-owned setup page. */
export type DesktopSetupPhase = DesktopReleaseProgressPhase | 'starting'

/** Desktop first-run setup state rendered by desktop-owned UI. */
export interface DesktopSetupState {
  readonly phase: DesktopSetupPhase
}

/** Desktop release update state rendered by desktop-owned UI. */
export interface DesktopUpdateState {
  readonly phase: 'idle' | 'checking' | 'available' | 'installing' | 'ready' | 'error'
  readonly version?: string
  readonly message?: string
}

/** Narrow bridge exposed through context isolation. */
export interface DshDesktopApi {
  readonly protocolVersion: 1
  locale(): Promise<DesktopLocale>
  readonly setup: {
    current(): Promise<DesktopSetupState>
    subscribe(listener: (state: DesktopSetupState) => void): () => void
  }
  readonly plugins: {
    list(): Promise<readonly DesktopPluginRecord[]>
    add(spec: string): Promise<void>
    remove(name: string): Promise<void>
    update(name: string, version: string): Promise<void>
  }
  readonly updates: {
    check(): Promise<DesktopUpdateState>
    install(): Promise<void>
    subscribe(listener: (state: DesktopUpdateState) => void): () => void
  }
}
