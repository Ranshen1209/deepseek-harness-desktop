/** Locale namespace owned by the Auto permission client. */
export const AUTO_MODE_LOCALE_NAMESPACE = 'dsh-auto-mode.permission'

/** Simplified Chinese copy for every plugin-owned permission surface. */
export const zh = {
  'preset.label': '自动审批',
  'preset.description': '逐次模型审查；文件、搜索和命令使用原生工作区沙箱，需要扩权时单次确认。',
  'dialog.title': '确认启用自动审批？',
  'dialog.description': 'Auto 使用当前模型逐次审查任务授权与风险，支持文件、搜索、Shell、依赖安装、构建和测试。普通已授权操作通过原生工作区写入沙箱执行；授权不明或退出该沙箱时，展示用途、授权依据、范围和后果并请求允许一次。模型拒绝时不弹窗。Windows 原生沙箱仅提供部分写入保护，不能隔离全部读取、联网或外部写入；模型审查不能保证文件绝对安全。结构化移除保留 .auto-recovery 恢复副本，脚本内部删除不享有这一保护。切换模式会撤销等待中的 Auto 调用；其他三档按原生规则运行。',
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
  'preset.description': 'Per-call model review for files, search and native workspace commands. Wider execution asks once.',
  'dialog.title': 'Enable Auto?',
  'dialog.description': 'Auto reviews task authorization and risk with the current model for each call. Files, search, Shell, dependency installation, builds and tests use the native workspace-write sandbox. Unclear authority or execution outside that sandbox asks once with purpose, authority, scope and consequences; a model denial does not prompt. The Windows native sandbox offers partial write protection, not complete read, network or external-write isolation. Model review cannot guarantee file safety. Structured trash keeps a recovery copy in .auto-recovery; deletion inside scripts does not. Switching modes cancels pending Auto calls. The other three modes follow native rules.',
  'dialog.acknowledge': 'I understand the risks and want to continue',
  'dialog.cancel': 'Cancel',
  'dialog.confirm': 'Enable Auto',
  'dialog.close': 'Close',
} satisfies Record<AutoModeLocaleKey, string>

/** Stable translation function passed from the official locale service. */
export type AutoModeTranslate = (key: AutoModeLocaleKey) => string

/** English fallback for direct use outside an assembled DSH client. */
export const translateEnglish: AutoModeTranslate = key => en[key]
