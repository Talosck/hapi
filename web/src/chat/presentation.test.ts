import { describe, expect, it } from 'vitest'
import { getEventPresentation, formatDuration, formatMessageTimestamp, formatOutlineTimestamp, formatResetTime } from './presentation'
import { QUEUE_NOTICE_REASONS } from './types'
import en from '@/lib/locales/en'
import zhCN from '@/lib/locales/zh-CN'
import ru from '@/lib/locales/ru'

describe('formatDuration', () => {
    it('keeps sub-minute durations at one decimal place', () => {
        expect(formatDuration(59_900)).toBe('59.9s')
    })

    it('omits zero seconds for an exact minute', () => {
        expect(formatDuration(60_000)).toBe('1m')
    })

    it('keeps non-zero minute and second components', () => {
        expect(formatDuration(537_000)).toBe('8m 57s')
    })

    it('rounds fractional seconds across minute and hour boundaries', () => {
        expect(formatDuration(119_500)).toBe('2m')
        expect(formatDuration(3_599_500)).toBe('1h')
        expect(formatDuration(3_601_000)).toBe('1h 1s')
    })

    it('uses hours and omits zero trailing components', () => {
        expect(formatDuration(3_600_000)).toBe('1h')
        expect(formatDuration(3_661_000)).toBe('1h 1m 1s')
    })
})

describe('formatOutlineTimestamp', () => {
    it('shows only the time for same-day messages', () => {
        const date = new Date(2026, 6, 21, 9, 55)
        const now = new Date(2026, 6, 21, 12, 0)

        expect(formatOutlineTimestamp(date, 'en', now)).toBe(
            date.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        )
    })

    it('zero-pads Chinese dates within the current year', () => {
        const date = new Date(2026, 8, 9, 10, 31)
        const now = new Date(2026, 6, 21, 12, 0)

        expect(formatOutlineTimestamp(date, 'zh-CN', now)).toBe(
            `09月09日 ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`
        )
    })

    it('uses a zero-padded numeric date in English', () => {
        const date = new Date(2026, 9, 1, 10, 31)
        const now = new Date(2026, 6, 21, 12, 0)

        expect(formatOutlineTimestamp(date, 'en', now)).toBe(
            `10/01 ${date.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`
        )
    })

    it('includes the year for older years in both locales', () => {
        const date = new Date(2025, 8, 9, 10, 31)
        const now = new Date(2026, 6, 21, 12, 0)
        const zhTime = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        const enTime = date.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

        expect(formatOutlineTimestamp(date, 'zh-CN', now)).toBe(`2025年09月09日 ${zhTime}`)
        expect(formatOutlineTimestamp(date, 'en', now)).toBe(`2025/09/09 ${enTime}`)
    })
})

describe('getEventPresentation — agent errors', () => {
    it('formats error events with warning icon and message text', () => {
        const result = getEventPresentation({
            type: 'error',
            message: 'Cursor Agent failed: authentication required'
        })

        expect(result.icon).toBe('⚠️')
        expect(result.text).toBe('Cursor Agent failed: authentication required')
    })
})

describe('getEventPresentation — api-error', () => {
    it('appends the reason to the retry wording rather than replacing it', () => {
        // An agent that retries without announcing a ceiling. The reason is
        // what tells a stuck-looking session apart from a rate-limited one,
        // but "Retrying" is what says the agent has not given up — so both
        // survive, and no producer has to encode the second one itself.
        const result = getEventPresentation({
            type: 'api-error',
            retryAttempt: 2,
            maxRetries: 0,
            error: { message: 'Rate limit exceeded: free-models-per-day. (attempt 2)' }
        })

        expect(result).toEqual({
            icon: '⏳',
            text: 'API error: Retrying... Rate limit exceeded: free-models-per-day. (attempt 2)'
        })
    })

    it('reads a reason attached as a bare string', () => {
        const result = getEventPresentation({
            type: 'api-error',
            retryAttempt: 1,
            maxRetries: 0,
            error: 'Overloaded.'
        })

        expect(result.text).toBe('API error: Retrying... Overloaded.')
    })

    // Claude sessions reach this same branch set and must render exactly as
    // they did before a reason was ever displayed here.
    it('keeps the retry wording for an api error carrying no reason', () => {
        expect(getEventPresentation({ type: 'api-error', retryAttempt: 1, maxRetries: 0, error: undefined }))
            .toEqual({ icon: '⏳', text: 'API error: Retrying...' })
    })

    it('keeps the retry wording when the reason is empty or unreadable', () => {
        expect(getEventPresentation({ type: 'api-error', retryAttempt: 1, maxRetries: 0, error: { message: '   ' } }).text)
            .toBe('API error: Retrying...')
        expect(getEventPresentation({ type: 'api-error', retryAttempt: 1, maxRetries: 0, error: { code: 429 } }).text)
            .toBe('API error: Retrying...')
    })

    it('keeps the counted, exhausted and bare renderings untouched', () => {
        const error = { message: 'Rate limit exceeded.' }
        expect(getEventPresentation({ type: 'api-error', retryAttempt: 2, maxRetries: 10, error }))
            .toEqual({ icon: '⏳', text: 'API error: Retrying (2/10)' })
        expect(getEventPresentation({ type: 'api-error', retryAttempt: 10, maxRetries: 10, error }))
            .toEqual({ icon: '⚠️', text: 'API error: Max retries reached' })
        expect(getEventPresentation({ type: 'api-error', retryAttempt: 0, maxRetries: 0, error }))
            .toEqual({ icon: '⚠️', text: 'API error' })
    })
})

describe('getEventPresentation — limit-warning', () => {
    it('formats five_hour warning', () => {
        const result = getEventPresentation({
            type: 'limit-warning',
            utilization: 0.9,
            endsAt: 1774278000,
            limitType: 'five_hour',
        })

        expect(result.icon).toBe('⚠️')
        expect(result.text).toMatch(/Usage limit 90% \(5-hour\)/)
        expect(result.text).toMatch(/resets/)
    })

    it('formats seven_day warning', () => {
        const result = getEventPresentation({
            type: 'limit-warning',
            utilization: 0.85,
            endsAt: 1774850400,
            limitType: 'seven_day',
        })

        expect(result.text).toMatch(/Usage limit 85% \(7-day\)/)
    })

    it('omits type label when limitType is empty', () => {
        const result = getEventPresentation({
            type: 'limit-warning',
            utilization: 1,
            endsAt: 1774278000,
            limitType: '',
        })

        expect(result.text).toMatch(/^Usage limit 100% · resets/)
        expect(result.text).not.toMatch(/\(/)
    })

    it('formats unknown limitType with underscore replacement', () => {
        const result = getEventPresentation({
            type: 'limit-warning',
            utilization: 0.5,
            endsAt: 1774278000,
            limitType: 'thirty_day',
        })

        expect(result.text).toMatch(/\(thirty day\)/)
    })
})

describe('getEventPresentation — limit-reached', () => {
    it('shows limitType when present', () => {
        const result = getEventPresentation({
            type: 'limit-reached',
            endsAt: 1774278000,
            limitType: 'five_hour',
        })

        expect(result.icon).toBe('⏳')
        expect(result.text).toMatch(/^Usage limit reached \(5-hour\) until/)
    })

    it('omits limitType when empty', () => {
        const result = getEventPresentation({
            type: 'limit-reached',
            endsAt: 1774278000,
            limitType: '',
        })

        expect(result.icon).toBe('⏳')
        expect(result.text).toMatch(/^Usage limit reached until/)
        expect(result.text).not.toMatch(/\(/)
    })
})

describe('getEventPresentation — token-count', () => {
    it('formats Codex token-count as compact context usage', () => {
        const result = getEventPresentation({
            type: 'token-count',
            info: {
                total: {
                    totalTokens: 23745,
                    inputTokens: 23631,
                    cachedInputTokens: 18176,
                    outputTokens: 114,
                    reasoningOutputTokens: 0
                },
                modelContextWindow: 258400
            }
        })

        expect(result.icon).toBe('◷')
        expect(result.text).toBe('Context 23.6k / 258.4k (9%) · out 114 · cached 18.2k')
    })
})

describe('getEventPresentation — agent error', () => {
    it('formats agent error events with a warning icon', () => {
        const result = getEventPresentation({
            type: 'error',
            message: 'Error: T: [canceled] http/2 stream closed with error code CANCEL (0x8)'
        })

        expect(result.icon).toBe('⚠️')
        expect(result.text).toContain('http/2 stream closed')
    })
})

describe('getEventPresentation — thread goals', () => {
    it('formats goal status updates', () => {
        const result = getEventPresentation({
            type: 'thread-goal-updated',
            goal: {
                threadId: 'thread-1',
                objective: 'ship goal support',
                status: 'budgetLimited',
                tokenBudget: 5000,
                tokensUsed: 4100,
                timeUsedSeconds: 0,
                createdAt: 1,
                updatedAt: 2
            }
        })

        expect(result.text).toBe('Goal limited by budget · 4k / 5k')
    })

    it.each([
        ['blocked', 'Goal blocked'],
        ['usageLimited', 'Goal limited by usage']
    ] as const)('formats %s goal status', (status, expected) => {
        const result = getEventPresentation({
            type: 'thread-goal-updated',
            goal: {
                threadId: 'thread-1',
                objective: 'ship goal support',
                status,
                tokenBudget: null,
                tokensUsed: 0,
                timeUsedSeconds: 0,
                createdAt: 1,
                updatedAt: 2
            }
        })

        expect(result.text).toBe(expected)
    })

    it('formats goal clear events', () => {
        const result = getEventPresentation({ type: 'thread-goal-cleared', threadId: 'thread-1' })

        expect(result.text).toBe('Goal cleared')
    })

    it.each([
        ['en', en],
        ['zh-CN', zhCN],
        ['ru', ru]
    ] as const)('names the goal status the way the status panel does (%s)', (_locale, dict) => {
        // The status panel shows the goal with
        // t('session.status.goal.<status>'). The transcript line has to name
        // the same status with the same word, or the two surfaces of a goal
        // disagree about what it says.
        const t = (key: string) => (dict as Record<string, string>)[key] ?? key
        const panelWord = dict['session.status.goal.budgetLimited']

        const result = getEventPresentation({
            type: 'thread-goal-updated',
            goal: {
                threadId: 'thread-1',
                objective: 'ship goal support',
                status: 'budgetLimited',
                tokenBudget: null,
                tokensUsed: 0,
                timeUsedSeconds: 0,
                createdAt: 1,
                updatedAt: 2
            }
        }, t)

        expect(result.text.toLowerCase()).toContain(panelWord.toLowerCase())
    })
})

describe('getEventPresentation — recap (away_summary)', () => {
    it('formats the recap with a recap: prefix', () => {
        const result = getEventPresentation({
            type: 'recap',
            text: 'Building the login flow, next: wire up the submit handler.'
        })

        expect(result.icon).toBe('💭')
        expect(result.text).toBe('recap: Building the login flow, next: wire up the submit handler.')
    })
})

describe('getEventPresentation — compact-summary', () => {
    it('keeps the label short (the chat renders the full summary as a block)', () => {
        const result = getEventPresentation({
            type: 'compact-summary',
            summary: '## Goal\nLong summary content',
            tokensBefore: 1000,
            estimatedTokensAfter: 120
        })

        expect(result.icon).toBe('📦')
        expect(result.text).toBe('Context compacted')
    })
})

describe('formatResetTime', () => {
    it('formats a unix timestamp to a non-empty string', () => {
        const result = formatResetTime(1774278000)
        expect(result).toBeTruthy()
        expect(typeof result).toBe('string')
    })

    it('handles millisecond timestamps', () => {
        const result = formatResetTime(1774278000000)
        expect(result).toBeTruthy()
    })

    it('returns raw value for invalid timestamps', () => {
        const result = formatResetTime(NaN)
        expect(result).toBeTruthy()
    })
})

describe('formatMessageTimestamp', () => {
    it('formats today without requiring a date prefix', () => {
        const now = new Date(2026, 4, 22, 14, 30)
        const date = new Date(2026, 4, 22, 9, 5)
        const result = formatMessageTimestamp(date, now)
        expect(result).toBe(date.toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23'
        }))
        expect(result).not.toContain('2026')
    })

    it('includes a year for messages outside the current year', () => {
        const now = new Date(2026, 4, 22, 14, 30)
        const result = formatMessageTimestamp(new Date(2025, 11, 31, 23, 59), now)
        expect(result).toContain('2025')
    })
})

describe('getEventPresentation — queue-notice', () => {
    it('marks the notice as a wait, not as something the agent said', () => {
        const result = getEventPresentation({
            type: 'queue-notice',
            reason: 'busy',
            message: 'MiniMax Code is busy and refused your message.',
            waitingSeconds: 12
        })
        expect(result.icon).toBe('⏳')
        expect(result.text).toContain('MiniMax Code is busy and refused your message.')
        expect(result.text).toContain('12s')
    })

    it('omits the elapsed time when the notice carries none', () => {
        const result = getEventPresentation({
            type: 'queue-notice',
            reason: 'busy',
            message: 'Your message is waiting.'
        })
        expect(result.icon).toBe('⏳')
        expect(result.text).toBe('Your message is waiting.')
    })

    it('says the notice in the user\'s language when a translator is given', () => {
        const result = getEventPresentation({
            type: 'queue-notice',
            reason: 'paused',
            message: 'The MiniMax Code message queue is paused, so your message was not taken.',
            waitingSeconds: 12
        }, (key, params) => {
            if (key === 'queueNotice.paused') return '消息队列被暂停了，你的消息没有被取走。'
            if (key === 'queueNotice.waitingSuffix') return `（已等待 ${params?.seconds} 秒）`
            return key
        })
        expect(result.text).toBe('消息队列被暂停了，你的消息没有被取走。（已等待 12 秒）')
    })

    it('falls back to the CLI wording when the reason has no translation', () => {
        const result = getEventPresentation({
            type: 'queue-notice',
            reason: 'a-reason-nobody-translated',
            message: 'MiniMax Code refused your message.',
            waitingSeconds: 3
        }, (key) => key)
        expect(result.text).toBe('MiniMax Code refused your message. (3s)')
    })

    it('falls back to the CLI wording when there is no translator at all', () => {
        const result = getEventPresentation({
            type: 'queue-notice',
            reason: 'paused',
            message: 'The MiniMax Code message queue is paused, so your message was not taken.'
        })
        expect(result.text).toBe('The MiniMax Code message queue is paused, so your message was not taken.')
    })
})

describe('queue notice translations', () => {
    it('has a wording for every reason the agent can refuse with, in every language', () => {
        for (const reason of QUEUE_NOTICE_REASONS) {
            for (const [name, locale] of Object.entries({ en, 'zh-CN': zhCN, ru })) {
                expect(locale[`queueNotice.${reason}`], `${name} is missing queueNotice.${reason}`).toBeTruthy()
            }
        }
    })

    it('keeps the english wording the CLI sends, so both sides say the same thing', () => {
        // The CLI's own wording is the fallback for a reason the client does
        // not know. It must not drift away from the english locale.
        const cliWordings: Record<string, string> = {
            busy: 'MiniMax Code is busy with another turn on this session - a task it is running, or another MiniMax Code window attached to it.',
            compacting: 'MiniMax Code is compacting this conversation and refused your message.',
            mutating: 'MiniMax Code is changing this conversation and refused your message.',
            queued: 'MiniMax Code still has an earlier queued message to deliver and refused yours.',
            paused: 'The MiniMax Code message queue is paused, so your message was not taken.',
            conflict: 'MiniMax Code refused your message because another turn is starting at the same time.',
            waiting: 'MiniMax Code is waiting for an answer to something it asked, and refused your message until then.',
            unavailable: 'MiniMax Code just finished a turn and could not take your message yet.',
            plan: 'MiniMax Code is still working through a plan review and refused your message until that is done.',
            duplicate: 'MiniMax Code had already accepted this turn.',
            unknown: 'MiniMax Code refused the message for a reason it did not explain, and will be asked again.'
        }
        for (const reason of QUEUE_NOTICE_REASONS) {
            expect(en[`queueNotice.${reason}`]).toBe(cliWordings[reason])
        }
    })
})
