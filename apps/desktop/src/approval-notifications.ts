/** Native approval reminders have no authority to approve or rerun an operation. */
import type { DesktopApprovalNotice } from './host-protocol.ts'

/** Small native notification face, injectable for tests without launching Electron. */
export interface ApprovalNotification {
  on(event: 'click' | 'failed', listener: () => void): unknown
  show(): void
  close(): void
}

/** Own request deduplication and revocation independently of window visibility. */
export class ApprovalNotifications {
  private readonly seen = new Set<string>()
  private readonly pending = new Map<string, { notice: DesktopApprovalNotice; notification?: ApprovalNotification }>()

  constructor(
    private readonly create: (category: DesktopApprovalNotice['category']) => ApprovalNotification | undefined,
    private readonly navigate: (notice: DesktopApprovalNotice) => void,
    private readonly diagnostic: () => void,
  ) {}

  /** Check a queued navigation again after the application page finishes loading. */
  isPending(notice: DesktopApprovalNotice): boolean {
    return this.pending.get(notice.requestId)?.notice.sessionId === notice.sessionId
  }

  /** Accept only notices from the current Host byte decoder. */
  accept(notice: DesktopApprovalNotice): void {
    if (notice.state === 'ended') {
      const entry = this.pending.get(notice.requestId)
      this.pending.delete(notice.requestId)
      entry?.notification?.close()
      this.seen.add(notice.requestId)
      return
    }
    if (this.seen.has(notice.requestId)) return
    this.seen.add(notice.requestId)
    const entry: { notice: DesktopApprovalNotice; notification?: ApprovalNotification } = { notice }
    this.pending.set(notice.requestId, entry)
    try {
      const notification = this.create(notice.category)
      if (notification === undefined) { this.diagnostic(); return }
      entry.notification = notification
      notification.on('click', () => {
        if (this.pending.get(notice.requestId) === entry) this.navigate(notice)
      })
      notification.on('failed', () => { this.diagnostic() })
      notification.show()
    } catch { this.diagnostic() }
  }

  /** Host replacement ends every reminder; old clicks cannot navigate an active request. */
  clear(): void {
    const entries = [...this.pending.values()]
    this.pending.clear()
    for (const entry of entries) entry.notification?.close()
  }
}
