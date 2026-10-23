import { describe, expect, it, vi } from 'vitest'
import { createNativeSessionTitleMetadataSync, normalizeNativeSessionTitle } from './nativeSessionTitle'
import type { Metadata } from '@/api/types'

describe('normalizeNativeSessionTitle', () => {
    it('keeps a plain title', () => {
        expect(normalizeNativeSessionTitle('Fix the parser')).toBe('Fix the parser')
    })

    it('strips the markup an agent left around the title', () => {
        // A title came back as `Fix the parser</</title>`: the closing tag was
        // copied along with the title and the opening one had already been
        // stripped.
        expect(normalizeNativeSessionTitle('Fix the parser</</title>')).toBe('Fix the parser')
        expect(normalizeNativeSessionTitle('<title>Fix the parser</title>')).toBe('Fix the parser')
        expect(normalizeNativeSessionTitle('Fix the parser</title>')).toBe('Fix the parser')
    })

    it('caps the title at the length the hub stores', () => {
        const title = normalizeNativeSessionTitle('x'.repeat(200))
        expect(title).toHaveLength(80)
    })

    it('rejects the placeholder titles an agent starts with', () => {
        expect(normalizeNativeSessionTitle('Untitled')).toBeNull()
        expect(normalizeNativeSessionTitle('New Session')).toBeNull()
        expect(normalizeNativeSessionTitle('New session - 2026-01-02T03:04:05')).toBeNull()
    })
})

describe('createNativeSessionTitleMetadataSync', () => {
    it('writes summary without overwriting an intentional metadata.name', () => {
        let metadata: Metadata = {
            path: '/tmp',
            host: 'localhost',
            name: 'issue-triage-#54'
        }
        const client = {
            getMetadata: () => metadata,
            updateMetadata: vi.fn((handler: (current: Metadata) => Metadata) => {
                metadata = handler(metadata)
            })
        }

        const sync = createNativeSessionTitleMetadataSync(client)
        sync('Native generated title')

        expect(metadata.name).toBe('issue-triage-#54')
        expect(metadata.summary?.text).toBe('Native generated title')
    })

    it('stores the title without the markup the agent left in it', () => {
        let metadata: Metadata = {
            path: '/tmp',
            host: 'localhost'
        }
        const client = {
            getMetadata: () => metadata,
            updateMetadata: vi.fn((handler: (current: Metadata) => Metadata) => {
                metadata = handler(metadata)
            })
        }

        const sync = createNativeSessionTitleMetadataSync(client)
        sync('Fix the parser</</title>')

        expect(metadata.summary?.text).toBe('Fix the parser')
    })
})
