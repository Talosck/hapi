import { describe, expect, it } from 'vitest'
import {
    PiLifecycleEventSchema,
    isPiLifecycleEventType,
    PI_LIFECYCLE_EVENT_TYPES,
} from './schemas'

describe('isPiLifecycleEventType', () => {
    it('accepts every event type the lifecycle union can match', () => {
        // The union is the source of truth. Every event it can parse must be
        // recognized by the cheap type check, or the short-circuit would skip
        // lifecycle events the union would have matched.
        const lifecycleEvents = [
            { type: 'compaction_start', reason: 'manual' },
            { type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: false },
            { type: 'auto_compaction_start' },
            { type: 'auto_compaction_end' },
            { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 100, errorMessage: 'boom' },
            { type: 'auto_retry_end', success: true, attempt: 1 },
            { type: 'summarization_retry_scheduled', attempt: 1, maxAttempts: 3, delayMs: 100, errorMessage: 'boom' },
            { type: 'summarization_retry_attempt_start', source: 'compaction' },
            { type: 'summarization_retry_finished' },
        ]

        for (const event of lifecycleEvents) {
            expect(PiLifecycleEventSchema.safeParse(event).success).toBe(true)
            expect(isPiLifecycleEventType(event.type)).toBe(true)
        }
    })

    it('rejects the event types the lifecycle union cannot match', () => {
        const otherEvents = [
            'message_start',
            'message_update',
            'message_end',
            'turn_start',
            'turn_end',
            'agent_start',
            'agent_end',
            'agent_settled',
            'keep_alive',
            'response',
            'extension_ui_request',
            'bash_execution_update',
            'session_info_changed',
            'tool_execution_start',
            'tool_execution_update',
            'tool_execution_end',
        ]

        for (const type of otherEvents) {
            expect(PiLifecycleEventSchema.safeParse({ type }).success).toBe(false)
            expect(isPiLifecycleEventType(type)).toBe(false)
        }
    })

    it('rejects a type that is not a string', () => {
        expect(isPiLifecycleEventType(undefined)).toBe(false)
        expect(isPiLifecycleEventType(null)).toBe(false)
        expect(isPiLifecycleEventType(42)).toBe(false)
        expect(isPiLifecycleEventType({})).toBe(false)
    })

    it('agrees with the union on every type it knows', () => {
        // A type the set claims but the union cannot parse would make the
        // short-circuit send an unmatched event into the union anyway — the
        // check must never widen what the union accepts.
        //
        // Several lifecycle types carry required payload beyond `type`, so the
        // bare `{ type }` probe only matches the ones whose payload is
        // optional. The union's members that need more are covered with a
        // full payload in the first test.
        const optionalPayloadTypes = [
            'auto_compaction_start',
            'auto_compaction_end',
            'summarization_retry_finished',
        ]

        for (const type of PI_LIFECYCLE_EVENT_TYPES) {
            if (!optionalPayloadTypes.includes(type)) continue
            const matched = PiLifecycleEventSchema.safeParse({ type }).success
            expect(matched).toBe(true)
        }
    })
})
