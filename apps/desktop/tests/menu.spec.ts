import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { resolveDesktopLocale } from '../src/locale.ts'
import { createDesktopMenuTemplate } from '../src/menu.ts'

describe('desktop native menu', () => {
  it.each(['zh-CN', 'en-US'])('shows complete Windows command labels in %s', async (locale) => {
    const template = createDesktopMenuTemplate({
      platform: 'win32',
      applicationName: 'DeepSeek Harness',
      messages: resolveDesktopLocale(locale).messages,
      pluginsEnabled: true,
      openPlugins: vi.fn(),
      checkUpdates: vi.fn(),
    })
    await expect(`${JSON.stringify(template, null, 2)}\n`).toMatchFileSnapshot(
      fileURLToPath(new URL(`./expected/menu-win32-${locale}.json`, import.meta.url)),
    )
  })

  it.each(['zh-CN', 'en-US'])('includes the macOS standard menu roles in %s', async (locale) => {
    const template = createDesktopMenuTemplate({
      platform: 'darwin',
      applicationName: 'DeepSeek Harness',
      messages: resolveDesktopLocale(locale).messages,
      pluginsEnabled: true,
      openPlugins: vi.fn(),
      checkUpdates: vi.fn(),
    })
    await expect(`${JSON.stringify(template, null, 2)}\n`).toMatchFileSnapshot(
      fileURLToPath(new URL(`./expected/menu-darwin-${locale}.json`, import.meta.url)),
    )
  })

  it('keeps native quit behavior, command handlers, and the plugin shortcut', () => {
    const openPlugins = vi.fn()
    const checkUpdates = vi.fn()
    const [application] = createDesktopMenuTemplate({
      platform: 'win32',
      applicationName: 'DeepSeek Harness',
      messages: resolveDesktopLocale('zh-CN').messages,
      pluginsEnabled: true,
      openPlugins,
      checkUpdates,
    })
    const submenu = application?.submenu
    expect(Array.isArray(submenu)).toBe(true)
    if (!Array.isArray(submenu)) throw new Error('Expected native menu entries')
    expect(submenu[0]).toMatchObject({ click: openPlugins, accelerator: 'CmdOrCtrl+,', enabled: true })
    expect(submenu[1]).toMatchObject({ click: checkUpdates })
    expect(submenu[3]).toMatchObject({ role: 'quit', label: '退出' })
  })

  it('preserves macOS native labels and disables plugin mutation during development', () => {
    const messages = resolveDesktopLocale('zh-CN').messages
    const template = createDesktopMenuTemplate({
      platform: 'darwin',
      applicationName: 'DeepSeek Harness',
      messages,
      pluginsEnabled: false,
      openPlugins: vi.fn(),
      checkUpdates: vi.fn(),
    })
    const [application, file, edit, window] = template
    expect(application?.label).toBe('DeepSeek Harness')
    const submenu = application?.submenu
    if (!Array.isArray(submenu)) throw new Error('Expected native menu entries')
    expect(submenu[0]).toMatchObject({ enabled: false, label: messages.pluginsMenuPackagedOnly })
    expect(submenu.slice(3)).toEqual([
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ])
    expect(file).toEqual({ role: 'fileMenu', label: messages.fileMenu })
    expect(edit).toEqual({ role: 'editMenu', label: messages.editMenu })
    expect(window).toEqual({ role: 'windowMenu', label: messages.windowMenu })
  })
})
