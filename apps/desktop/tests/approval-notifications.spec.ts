/** Native notification lifecycle, tested without launching Electron or a desktop profile. */
import { describe, expect, it, vi } from 'vitest'
import { ApprovalNotifications } from '../src/approval-notifications.ts'
import { encodeDesktopApprovalNotice } from '../../desktop-host/src/wire.ts'
import { DesktopHostResponseDecoder } from '../src/host-protocol.ts'

const waiting = { state: 'waiting', requestId: 'request-1', sessionId: 'session-1', category: 'command' } as const

describe('approval notifications', () => {
  it('deduplicates, navigates only while pending, and revokes old clicks', () => {
    const events = new Map<string, () => void>()
    const native = { on: (event: string, listener: () => void) => events.set(event, listener), show: vi.fn(), close: vi.fn() }
    const navigate = vi.fn(), diagnostic = vi.fn()
    const notices = new ApprovalNotifications(() => native, navigate, diagnostic)
    notices.accept(waiting); notices.accept(waiting)
    expect(native.show).toHaveBeenCalledTimes(1)
    events.get('click')!()
    expect(navigate).toHaveBeenCalledWith(waiting)
    notices.accept({ ...waiting, state: 'ended' })
    events.get('click')!()
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(notices.isPending(waiting)).toBe(false)
    expect(native.close).toHaveBeenCalledTimes(1)
    expect(diagnostic).not.toHaveBeenCalled()
  })
  it('keeps in-app pending identity when native notifications are unavailable', () => {
    const diagnostic = vi.fn()
    const notices = new ApprovalNotifications(() => undefined, vi.fn(), diagnostic)
    notices.accept(waiting); notices.accept(waiting)
    expect(diagnostic).toHaveBeenCalledTimes(1)
    expect(notices.isPending(waiting)).toBe(true)
    notices.clear()
    expect(notices.isPending(waiting)).toBe(false)
  })
  it('does not recreate a request when ended arrives before waiting', () => {
    const create = vi.fn()
    const notices = new ApprovalNotifications(create, vi.fn(), vi.fn())
    notices.accept({ ...waiting, state: 'ended' }); notices.accept(waiting)
    expect(create).not.toHaveBeenCalled()
  })
  it('round-trips the Host-only typed notification frame', () => {
    expect(new DesktopHostResponseDecoder().push(encodeDesktopApprovalNotice(waiting))).toEqual([{ type: 'approval', streamId: 0, notice: waiting }])
  })
  it.each([{ state: ['waiting'] }, { category: ['command'] }, { extra: true }, { requestId: '../unsafe' }, { sessionId: '' }])('rejects malformed control frames %j', (extra) => {
    const frame = encodeDesktopApprovalNotice({ ...waiting, ...extra } as never)
    expect(() => new DesktopHostResponseDecoder().push(frame)).toThrow('invalid approval notice')
  })
})
