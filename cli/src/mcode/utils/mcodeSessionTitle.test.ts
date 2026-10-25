import { describe, expect, it, vi } from 'vitest'
import {
    applyFirstMessageTitle,
    createFirstMessageTitleSync,
    normalizeFirstMessageTitle
} from './mcodeSessionTitle'
import type { Metadata } from '@/api/types'

/**
 * A client that keeps the metadata the way the real one does.
 */
function createClient(initial: Metadata) {
    const state = { metadata: initial }
    return {
        state,
        getMetadata: vi.fn(() => state.metadata),
        updateMetadata: vi.fn((handler: (current: Metadata) => Metadata) => {
            state.metadata = handler(state.metadata)
        })
    }
}

describe('normalizeFirstMessageTitle', () => {
    it('keeps the text of the message and collapses its whitespace', () => {
        expect(normalizeFirstMessageTitle('  Fix the   parser  ')).toBe('Fix the parser')
    })

    it('rejects a message without text', () => {
        expect(normalizeFirstMessageTitle('')).toBeNull()
        expect(normalizeFirstMessageTitle('   \n  ')).toBeNull()
        expect(normalizeFirstMessageTitle(null)).toBeNull()
        expect(normalizeFirstMessageTitle(undefined)).toBeNull()
        expect(normalizeFirstMessageTitle(42)).toBeNull()
    })

    it('caps the title at the length the hub stores', () => {
        const title = normalizeFirstMessageTitle('a'.repeat(200))
        expect(title).toHaveLength(80)
    })
})

describe('applyFirstMessageTitle', () => {
    it('names the session after the text of the first message', () => {
        // The title goes into the summary - the slot the title of the agent
        // uses - so the agent's own title replaces it when it arrives.
        const client = createClient({ path: '/tmp/project', host: 'localhost' })

        expect(applyFirstMessageTitle(client, 'Fix the parser')).toEqual({ applied: true })
        expect(client.state.metadata.summary?.text).toBe('Fix the parser')
        expect(client.state.metadata.name).toBeUndefined()
    })

    it('keeps a title the session already carries', () => {
        // The agent may have published its own title before the first message
        // reached this process. That title is the real one.
        const client = createClient({
            path: '/tmp/project',
            host: 'localhost',
            summary: { text: 'The agent title', updatedAt: 1 }
        })

        expect(applyFirstMessageTitle(client, 'Fix the parser')).toEqual({ applied: false, reason: 'titled' })
        expect(client.state.metadata.summary?.text).toBe('The agent title')
        expect(client.updateMetadata).not.toHaveBeenCalled()
    })

    it('keeps a name the user picked', () => {
        const client = createClient({
            path: '/tmp/project',
            host: 'localhost',
            name: 'Chosen by hand'
        })

        expect(applyFirstMessageTitle(client, 'Fix the parser')).toEqual({ applied: false, reason: 'titled' })
        expect(client.state.metadata.name).toBe('Chosen by hand')
        expect(client.updateMetadata).not.toHaveBeenCalled()
    })

    it('rejects a message without text without writing', () => {
        const client = createClient({ path: '/tmp/project', host: 'localhost' })

        expect(applyFirstMessageTitle(client, '   ')).toEqual({ applied: false, reason: 'empty' })
        expect(client.updateMetadata).not.toHaveBeenCalled()
    })

    it('leaves the agent title alone when it arrives while the update waits', () => {
        const client = createClient({ path: '/tmp/project', host: 'localhost' })
        // The agent publishes its title between the check and the write.
        client.updateMetadata.mockImplementation((handler: (current: Metadata) => Metadata) => {
            const raced = { ...client.state.metadata, summary: { text: 'The agent title', updatedAt: 2 } }
            client.state.metadata = handler(raced)
        })

        expect(applyFirstMessageTitle(client, 'Fix the parser')).toEqual({ applied: true })
        expect(client.state.metadata.summary?.text).toBe('The agent title')
    })
})

describe('createFirstMessageTitleSync', () => {
    it('names the session after the first message only', () => {
        const client = createClient({ path: '/tmp/project', host: 'localhost' })
        const sync = createFirstMessageTitleSync(client)

        sync('Fix the parser')
        sync('And now something else')

        expect(client.state.metadata.summary?.text).toBe('Fix the parser')
        expect(client.updateMetadata).toHaveBeenCalledTimes(1)
    })

    it('names the session with the first message that carries text', () => {
        // A message without text names nothing, so the next one that does is
        // still the first message of the session.
        const client = createClient({ path: '/tmp/project', host: 'localhost' })
        const sync = createFirstMessageTitleSync(client)

        sync('   ')
        sync('Fix the parser')

        expect(client.state.metadata.summary?.text).toBe('Fix the parser')
    })

    it('leaves a session that already carries a title alone', () => {
        const client = createClient({
            path: '/tmp/project',
            host: 'localhost',
            summary: { text: 'The agent title', updatedAt: 1 }
        })
        const sync = createFirstMessageTitleSync(client)

        sync('Fix the parser')

        expect(client.state.metadata.summary?.text).toBe('The agent title')
        expect(client.updateMetadata).not.toHaveBeenCalled()
    })
})
