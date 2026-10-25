import { describe, expect, it, vi } from 'vitest'
import { createFirstMessageTitleSync } from './mcodeSessionTitle'
import { registerAcpSessionTitleSync } from '@/agent/acpSessionTitle'
import type { Metadata } from '@/api/types'

/**
 * The whole title chain of an mcode session, from the first message the user
 * sends to the title the agent publishes at the end of the turn.
 *
 * The two halves live in different places: the first message is named in the
 * runner, and the title of the agent arrives over ACP and is written by the
 * session client. They share the summary slot - that is what makes the title
 * of the agent replace the one of the first message.
 */
function createSessionClient(initial: Metadata) {
    const state = { metadata: initial }
    return {
        state,
        getMetadata: vi.fn(() => state.metadata),
        updateMetadata: vi.fn((handler: (current: Metadata) => Metadata) => {
            state.metadata = handler(state.metadata)
        }),
        // The session client writes a summary message into the metadata - the
        // path an ACP title takes.
        sendClaudeSessionMessage: vi.fn((body: { type: string; summary?: string; leafUuid?: string }) => {
            if (body.type === 'summary' && typeof body.summary === 'string') {
                state.metadata = {
                    ...state.metadata,
                    summary: { text: body.summary, updatedAt: Date.now() }
                }
            }
        })
    }
}

describe('the title of an mcode session', () => {
    it('carries the first message until the agent publishes a title', () => {
        // The chat shows the request the user wrote while the agent works on
        // it, and the title the agent publishes replaces it afterwards.
        const client = createSessionClient({ path: '/tmp/project', host: 'localhost' })
        const syncFirstMessageTitle = createFirstMessageTitleSync(client)

        syncFirstMessageTitle('Fix the parser')

        expect(client.state.metadata.summary?.text).toBe('Fix the parser')

        // The agent publishes its own title at the end of the turn.
        const backend = { setSessionInfoUpdateListener: vi.fn() }
        registerAcpSessionTitleSync(backend as never, client as never)
        const listener = backend.setSessionInfoUpdateListener.mock.calls[0]?.[0] as
            ((update: { title?: string }) => void)
        listener({ title: 'Parser rewrite' })

        expect(client.state.metadata.summary?.text).toBe('Parser rewrite')
    })

    it('keeps a name the user picked over both titles', () => {
        // A manual rename lives in `name`, which the web prefers over the
        // summary - so neither the first message nor the agent can take it.
        const client = createSessionClient({
            path: '/tmp/project',
            host: 'localhost',
            name: 'Chosen by hand'
        })
        const syncFirstMessageTitle = createFirstMessageTitleSync(client)

        syncFirstMessageTitle('Fix the parser')

        expect(client.state.metadata.name).toBe('Chosen by hand')
        expect(client.state.metadata.summary).toBeUndefined()
    })

    it('does not rename the session on a later message', () => {
        const client = createSessionClient({ path: '/tmp/project', host: 'localhost' })
        const syncFirstMessageTitle = createFirstMessageTitleSync(client)

        syncFirstMessageTitle('Fix the parser')
        syncFirstMessageTitle('Also update the docs')

        expect(client.state.metadata.summary?.text).toBe('Fix the parser')
    })
})
