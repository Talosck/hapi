import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Metadata } from '@/api/types'

const harness = vi.hoisted(() => ({
    metadata: { path: '/tmp/project', host: 'localhost' } as Metadata,
    /** Delivers a user message to the runner, the way the hub does. */
    deliverUserMessage: null as ((text: string) => void) | null,
    /** The client the runner was handed. */
    client: null as {
        state: { metadata: Metadata }
        getMetadata: () => Metadata
        updateMetadata: (handler: (current: Metadata) => Metadata) => void
    } | null
}))

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() }
}))

// The runner exits the process when it is done - the test must not go with it.
vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

vi.mock('./loop', () => ({
    mcodeLoop: vi.fn(async () => {})
}))

vi.mock('@/agent/sessionFactory', () => ({
    bootstrapSession: vi.fn(async () => ({
        api: {},
        session: createSessionClient(),
        sessionInfo: { id: 'session-1' },
        metadata: harness.metadata
    })),
    bootstrapExistingSession: vi.fn(async () => ({
        api: {},
        session: createSessionClient(),
        sessionInfo: { id: 'session-1' },
        metadata: harness.metadata
    }))
}))

/**
 * A session client that keeps the metadata the way the real one does, and
 * that hands the user messages to the runner.
 */
function createSessionClient() {
    const state = { metadata: harness.metadata }
    let userMessageHandler: ((message: { content: { text: string } }, localId?: string) => void) | null = null
    const client = {
        state,
        getMetadata: vi.fn(() => state.metadata),
        updateMetadata: vi.fn((handler: (current: Metadata) => Metadata) => {
            state.metadata = handler(state.metadata)
        }),
        updateAgentState: vi.fn(),
        keepAlive: vi.fn(),
        rpcHandlerManager: { registerHandler: vi.fn() },
        onUserMessage: vi.fn((handler: typeof userMessageHandler) => {
            userMessageHandler = handler
        }),
        onCancelQueuedMessage: vi.fn(),
        sendUserMessage: vi.fn(),
        sendAgentMessage: vi.fn(),
        sendSessionEvent: vi.fn(),
        sendSessionDeath: vi.fn(),
        // The cleanup confirms the archive through the flush: it has to
        // report that the session was archived, or the runner exits with an
        // error instead of finishing.
        flush: vi.fn(async () => true),
        close: vi.fn(async () => {})
    }
    harness.deliverUserMessage = (text: string) => {
        userMessageHandler?.({ content: { text } })
    }
    harness.client = client
    return client
}

import { runMcode } from './runMcode'

describe('runMcode names the session after the first message', () => {
    beforeEach(() => {
        harness.metadata = { path: '/tmp/project', host: 'localhost' }
        harness.deliverUserMessage = null
        harness.client = null
    })

    afterEach(() => {
        vi.clearAllMocks()
    })

    it('writes the text of the first message into the summary', async () => {
        // The chat shows the request the user wrote while the agent works on
        // it. The summary is the slot the title of the agent uses, so that
        // title replaces this one when it arrives.
        await runMcode({ workingDirectory: '/tmp/project' })

        harness.deliverUserMessage?.('Fix the parser')

        expect(harness.client?.state.metadata.summary?.text).toBe('Fix the parser')
    })
})
