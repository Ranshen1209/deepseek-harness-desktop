/** `approval` namespace dictionaries. */

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  waiting: '等待审批',
  'review.recommendation': '模型建议',
  'review.execute': '建议执行，等待你允许这一次操作',
  'review.purpose': '操作用途',
  'review.authorization': '授权依据',
  'review.scope': '文件、工作目录与权限范围',
  'review.consequences': '可能出现的意外后果',
  'detail.aria': '审批详情',
  escalation: '工具 {toolName} 的操作需要确认',
  reject: '拒绝',
  allowOnce: '允许一次',
} satisfies Record<string, string>

/** Approval dictionary key union. */
export type ApprovalKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  waiting: 'Waiting for approval',
  'review.recommendation': 'Model recommendation',
  'review.execute': 'Execute after your one-time approval',
  'review.purpose': 'Purpose',
  'review.authorization': 'Authorization basis',
  'review.scope': 'Files, working directory and access',
  'review.consequences': 'Possible unintended consequences',
  'detail.aria': 'Approval details',
  escalation: 'Tool {toolName} requires confirmation',
  reject: 'Reject',
  allowOnce: 'Allow once',
} satisfies Record<ApprovalKey, string>
