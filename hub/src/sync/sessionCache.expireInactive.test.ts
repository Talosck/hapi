import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import type { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'

function createPublisher(events: SyncEvent[]): EventPublisher {
    return {
        emit: (event: SyncEvent) => {
            events.push(event)
        }
    } as unknown as EventPublisher
}

// A session whose CLI died keeps the background task count it last reported:
// nothing will ever decrement it, so the web shows work that no longer runs
// (and the session never looks idle).
describe('SessionCache.expireInactive', () => {
    it('clears the background task count of an expired session', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const created = cache.getOrCreateSession(
            'expired-background-session',
            { path: '/tmp', host: 'h' },
            null,
            'default'
        )

        cache.applyBackgroundTaskDelta(created.id, { started: 2, completed: 0 })
        expect(cache.getSession(created.id)?.backgroundTaskCount).toBe(2)

        // The CLI was connected, then went away.
        cache.markSessionActive(created.id)
        cache.expireInactive(Date.now() + 60_000)

        expect(cache.getSession(created.id)?.backgroundTaskCount).toBe(0)
        expect(events.some((event) => (
            event.type === 'session-updated'
            && event.sessionId === created.id
            && (event.data as { backgroundTaskCount?: number }).backgroundTaskCount === 0
        ))).toBe(true)
    })
})
