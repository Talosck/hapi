import { describe, expect, it, vi } from 'vitest'
import {
    applySessionDisplayRename,
    applySessionPlaceholderTitle,
    hasSessionTitle,
    normalizeSessionDisplayTitle
} from './sessionDisplayRename'
import type { Metadata } from '@/api/types'

describe('sessionDisplayRename', () => {
    it('normalizes whitespace and rejects empty titles', () => {
        expect(normalizeSessionDisplayTitle('  Fix login   bug  ')).toBe('Fix login bug')
        expect(normalizeSessionDisplayTitle('')).toBeNull()
        expect(normalizeSessionDisplayTitle('   ')).toBeNull()
        expect(normalizeSessionDisplayTitle(null)).toBeNull()
    })

    it('sets metadata.name even when a spawn name already exists', () => {
        let metadata: Metadata = {
            path: '/tmp/project',
            host: 'localhost',
            name: 'issue-triage-#54',
            summary: { text: 'Old summary', updatedAt: 1 }
        }
        const client = {
            updateMetadata: vi.fn((handler: (current: Metadata) => Metadata) => {
                metadata = handler(metadata)
            })
        }

        expect(applySessionDisplayRename(client, '  Renamed triage peer  ')).toBe(true)
        expect(metadata.name).toBe('Renamed triage peer')
        expect(metadata.summary?.text).toBe('Old summary')
        expect(client.updateMetadata).toHaveBeenCalledTimes(1)
    })

    it('sets metadata.name when only a summary exists', () => {
        let metadata: Metadata = {
            path: '/tmp/project',
            host: 'localhost',
            summary: { text: 'Generated summary', updatedAt: 1 }
        }
        const client = {
            updateMetadata: vi.fn((handler: (current: Metadata) => Metadata) => {
                metadata = handler(metadata)
            })
        }

        expect(applySessionDisplayRename(client, 'Explicit rename')).toBe(true)
        expect(metadata.name).toBe('Explicit rename')
        expect(metadata.summary?.text).toBe('Generated summary')
    })

    it('returns false without writing when the title is empty', () => {
        const client = { updateMetadata: vi.fn() }
        expect(applySessionDisplayRename(client, '   ')).toBe(false)
        expect(client.updateMetadata).not.toHaveBeenCalled()
    })

    it('knows a session that carries a title', () => {
        expect(hasSessionTitle(null)).toBe(false)
        expect(hasSessionTitle({ path: '/tmp/p', host: 'h' })).toBe(false)
        expect(hasSessionTitle({ path: '/tmp/p', host: 'h', name: 'Named' })).toBe(true)
        expect(hasSessionTitle({ path: '/tmp/p', host: 'h', summary: { text: 'Summary', updatedAt: 1 } })).toBe(true)
    })
})

describe('applySessionPlaceholderTitle', () => {
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

    it('fills the summary of an untitled session', () => {
        // The title the agent publishes replaces the placeholder, so it goes
        // into the slot the agent's own title uses.
        const client = createClient({ path: '/tmp/project', host: 'localhost' })

        expect(applySessionPlaceholderTitle(client, '  Debug the broker  ')).toEqual({ applied: true })
        expect(client.state.metadata.summary?.text).toBe('Debug the broker')
        expect(client.state.metadata.name).toBeUndefined()
    })

    it('keeps a title the session already carries', () => {
        // The tool fills a gap, it does not rename: a title the agent
        // published - or a name the user picked - stays.
        const client = createClient({
            path: '/tmp/project',
            host: 'localhost',
            summary: { text: 'The agent title', updatedAt: 1 }
        })

        expect(applySessionPlaceholderTitle(client, 'Another title')).toEqual({ applied: false, reason: 'titled' })
        expect(client.state.metadata.summary?.text).toBe('The agent title')
        expect(client.updateMetadata).not.toHaveBeenCalled()
    })

    it('keeps a name the user picked', () => {
        const client = createClient({
            path: '/tmp/project',
            host: 'localhost',
            name: 'Chosen by hand'
        })

        expect(applySessionPlaceholderTitle(client, 'Another title')).toEqual({ applied: false, reason: 'titled' })
        expect(client.state.metadata.name).toBe('Chosen by hand')
        expect(client.updateMetadata).not.toHaveBeenCalled()
    })

    it('rejects an empty title without writing', () => {
        const client = createClient({ path: '/tmp/project', host: 'localhost' })

        expect(applySessionPlaceholderTitle(client, '   ')).toEqual({ applied: false, reason: 'empty' })
        expect(client.updateMetadata).not.toHaveBeenCalled()
    })

    it('leaves the agent title alone when it arrives while the update waits', () => {
        const client = createClient({ path: '/tmp/project', host: 'localhost' })
        // The agent publishes its title between the check and the write.
        client.updateMetadata.mockImplementation((handler: (current: Metadata) => Metadata) => {
            const raced = { ...client.state.metadata, summary: { text: 'The agent title', updatedAt: 2 } }
            client.state.metadata = handler(raced)
        })

        expect(applySessionPlaceholderTitle(client, 'Placeholder')).toEqual({ applied: true })
        expect(client.state.metadata.summary?.text).toBe('The agent title')
    })
})
