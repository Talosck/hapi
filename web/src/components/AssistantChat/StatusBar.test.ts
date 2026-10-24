import { describe, expect, it } from 'vitest'
import {
    formatCompactContextUsageLabel,
    formatContextUsageLabel,
    formatContextWindowLabel,
    formatQuotaCountdown,
    formatQuotaLabel,
    getContextWarning,
    getContextUsageDetails,
    getQuotaWarning,
    shouldShowCodexFastBadge
} from './StatusBar'

describe('quota label', () => {
    it('names the window and the share that is left', () => {
        expect(formatQuotaLabel({ remainingPercent: 98, resetAtMs: 1792720800000, unlimited: false }))
            .toBe('5h 98%')
    })

    it('says that a window without a limit has no share', () => {
        expect(formatQuotaLabel({ remainingPercent: null, resetAtMs: 1792720800000, unlimited: true }))
            .toBe('5h ∞')
    })

    it('has a placeholder for a window the account does not report', () => {
        expect(formatQuotaLabel({ remainingPercent: null, resetAtMs: null, unlimited: false }))
            .toBe('5h —')
    })

    it('keeps the short label while the window has room to spare', () => {
        // The chip shares the row with the context usage, so a window that is
        // not running low stays a number and nothing more.
        const now = 1792710000000
        expect(formatQuotaLabel(
            { remainingPercent: 98, resetAtMs: now + 3 * 3_600_000, unlimited: false },
            now
        )).toBe('5h 98%')
    })

    it('counts down to the reset while the window runs low', () => {
        // A window that is running out is the moment the time to the reset
        // matters: the share says how much is left, the countdown says when
        // there is more.
        const now = 1792710000000
        expect(formatQuotaLabel(
            { remainingPercent: 12, resetAtMs: now + 26 * 60_000, unlimited: false },
            now
        )).toBe('5h 12% · 26m')
    })

    it('has no countdown when the window does not say when it resets', () => {
        const now = 1792710000000
        expect(formatQuotaLabel(
            { remainingPercent: 12, resetAtMs: null, unlimited: false },
            now
        )).toBe('5h 12%')
    })

    it('has no countdown once the reset has passed', () => {
        const now = 1792710000000
        expect(formatQuotaLabel(
            { remainingPercent: 12, resetAtMs: now - 1, unlimited: false },
            now
        )).toBe('5h 12%')
    })
})

describe('quota countdown', () => {
    it('counts in minutes below an hour, then in hours and days', () => {
        // The agent counts the same way, and leaves the seconds out: the
        // countdown is read at a glance.
        expect(formatQuotaCountdown(30_000)).toBe('1m')
        expect(formatQuotaCountdown(26 * 60_000)).toBe('26m')
        expect(formatQuotaCountdown(3 * 3_600_000 + 12 * 60_000)).toBe('3h 12m')
        expect(formatQuotaCountdown(2 * 86_400_000 + 3 * 3_600_000)).toBe('2d 3h')
    })
})

describe('quota warning colors', () => {
    it('keeps a window with room left muted', () => {
        expect(getQuotaWarning(98).color).toBe('text-[var(--app-hint)]')
        expect(getQuotaWarning(41).color).toBe('text-[var(--app-hint)]')
    })

    it('warns when the window runs low', () => {
        expect(getQuotaWarning(40).color).toBe('text-amber-500')
        expect(getQuotaWarning(21).color).toBe('text-amber-500')
    })

    it('shows danger when the window is nearly gone', () => {
        expect(getQuotaWarning(20).color).toBe('text-red-500')
        expect(getQuotaWarning(1).color).toBe('text-red-500')
    })

    it('stays muted when the account does not report a share', () => {
        expect(getQuotaWarning(null).color).toBe('text-[var(--app-hint)]')
    })
})

describe('context warning colors', () => {
    it('keeps usage below 70% muted', () => {
        expect(getContextWarning(69, 100).color).toBe('text-[var(--app-hint)]')
    })

    it('shows a warning from 70% through below 90%', () => {
        expect(getContextWarning(70, 100).color).toBe('text-amber-500')
        expect(getContextWarning(89, 100).color).toBe('text-amber-500')
    })

    it('shows danger at 90% and above', () => {
        expect(getContextWarning(90, 100).color).toBe('text-red-500')
        expect(getContextWarning(95, 100).color).toBe('text-red-500')
    })
})

describe('context usage labels', () => {
    it('keeps the desktop label compact and expresses used capacity', () => {
        expect(formatContextUsageLabel(90_000, 258_000)).toBe('35% · 90k / 258k')
    })

    it('uses the compact parenthesized mobile label with a fixed English suffix', () => {
        expect(formatCompactContextUsageLabel(186_000, 262_000)).toBe('ctx 262k (29% left)')
    })

    it('orders cache, used, and remaining metrics for the desktop details', () => {
        expect(getContextUsageDetails(90_000, 258_000, 86_000)).toEqual({
            cacheRead: '86k',
            used: '90k',
            usedPercentage: 35,
            remaining: '168k',
            remainingPercentage: 65
        })
    })

    it('keeps external and detailed percentages complementary at rounding midpoints', () => {
        expect(formatContextUsageLabel(69, 200)).toBe('35% · 69 / 200')
        expect(formatCompactContextUsageLabel(69, 200)).toBe('ctx 200 (65% left)')
        expect(getContextUsageDetails(69, 200, 0)).toMatchObject({
            usedPercentage: 35,
            remainingPercentage: 65
        })
    })

    it('names the window of a session that has not run a turn yet', () => {
        // The window is the budget the first turn is measured against, so it
        // is shown before there is a usage number next to it.
        expect(formatContextWindowLabel(502_000)).toBe('ctx 502k')
    })

    it('has no window label without a window', () => {
        expect(formatContextWindowLabel(null)).toBeNull()
        expect(formatContextWindowLabel(undefined)).toBeNull()
        expect(formatContextWindowLabel(0)).toBeNull()
    })
})

describe('shouldShowCodexFastBadge', () => {
    it('uses only the effective service tier', () => {
        expect(shouldShowCodexFastBadge('codex', undefined)).toBe(false)
        expect(shouldShowCodexFastBadge('codex', 'standard')).toBe(false)
        expect(shouldShowCodexFastBadge('codex', 'fast')).toBe(true)
        expect(shouldShowCodexFastBadge('codex', 'priority')).toBe(true)
        expect(shouldShowCodexFastBadge('claude', 'fast')).toBe(false)
    })
})
