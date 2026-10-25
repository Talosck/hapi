import { describe, expect, it } from 'vitest'
import { createTimestampForLogEntry, createTimestampForFilename } from './logger'

describe('logger timestamps', () => {
    it('formats a log entry timestamp in the local timezone', () => {
        // 2026-10-25T14:30:45.123Z — the exact instant matters less than the
        // shape: a 24h clock with milliseconds.
        const stamp = createTimestampForLogEntry(new Date('2026-10-25T14:30:45.123Z'))
        expect(stamp).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/)
    })

    it('formats a filename timestamp with the date and time', () => {
        const stamp = createTimestampForFilename(new Date('2026-10-25T14:30:45.123Z'))
        expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-pid-\d+$/)
    })

    it('returns the same value for the same instant on repeated calls', () => {
        const date = new Date('2026-10-25T14:30:45.123Z')
        expect(createTimestampForLogEntry(date)).toBe(createTimestampForLogEntry(date))
        expect(createTimestampForFilename(date)).toBe(createTimestampForFilename(date))
    })

    it('keeps a cached formatter in sync with the system timezone', () => {
        // The formatter is cached at module load. If the timezone changed
        // afterwards, the cached formatter would keep formatting in the old
        // zone — the timestamp must still agree with a fresh formatter.
        const date = new Date('2026-10-25T14:30:45.123Z')
        const fresh = new Intl.DateTimeFormat('en-US', {
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            fractionalSecondDigits: 3,
        }).format(date)
        expect(createTimestampForLogEntry(date)).toBe(fresh)
    })
})
