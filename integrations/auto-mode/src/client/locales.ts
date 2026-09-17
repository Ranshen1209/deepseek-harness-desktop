/** Locale namespace owned by the Auto permission client. */
export const AUTO_MODE_LOCALE_NAMESPACE = 'dsh-auto-mode.permission'

/** Simplified Chinese copy for every plugin-owned permission surface. */
export const zh = {
  'preset.label': '自动审批',
  'preset.description': '逐次模型审查风险与授权；普通文件修改自动执行，授权不明时确认。支持精确外部文件和可恢复移除。',
  'dialog.title': '确认启用自动审批？',
  'dialog.description': 'Auto 每次调用当前模型审查风险与授权；普通文件修改通过后自动执行，授权不明时单次确认。明确指令中的精确绝对文件路径可用于自动执行必要的外部文件操作或可恢复移除；移除的原文件保存在 .auto-recovery。永久删除、目录删除、Shell、脚本、安装、构建、未知工具和权限提升仍被阻止。链接、路径别名和敏感配置受到额外限制。该插件只约束启用 Auto 时经过 Harness 工具链的调用，不能替代独立操作系统隔离，也不能防御被篡改的宿主或插件。切换其他模式后这些限制不再适用。',
  'dialog.acknowledge': '我已了解风险，并愿意继续',
  'dialog.cancel': '取消',
  'dialog.confirm': '启用自动审批',
  'dialog.close': '关闭',
} satisfies Record<string, string>

/** Locale keys consumed by the compatibility layer. */
export type AutoModeLocaleKey = keyof typeof zh

/** English copy, checked against the Chinese source key set. */
export const en = {
  'preset.label': 'Auto',
  'preset.description': 'Fresh model review automates task file changes; unclear authority asks once. Supports exact external files and reversible trash.',
  'dialog.title': 'Enable Auto?',
  'dialog.description': 'Auto reviews each admissible call with the current model. Approved task file changes run automatically; unclear authority asks once. An exact absolute file path in a direct human instruction can authorize external file operations or reversible trash. Trash retains the original in .auto-recovery. Permanent deletion, directories, shells, scripts, installs, builds, unknown tools and privilege widening remain blocked. Links, ambiguous paths and sensitive configuration are restricted. This policy covers only Harness tool calls while Auto is active; it cannot replace independent OS isolation or defend against a compromised host or plugin. Other permission modes are outside this protection.',
  'dialog.acknowledge': 'I understand the risks and want to continue',
  'dialog.cancel': 'Cancel',
  'dialog.confirm': 'Enable Auto',
  'dialog.close': 'Close',
} satisfies Record<AutoModeLocaleKey, string>

/** Stable translation function passed from the official locale service. */
export type AutoModeTranslate = (key: AutoModeLocaleKey) => string

/** English fallback for direct use outside an assembled DSH client. */
export const translateEnglish: AutoModeTranslate = key => en[key]
