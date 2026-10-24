import { describe, expect, it } from 'vitest'
import type { AgentEvent, ChatBlock } from '@/chat/types'
import {
    buildSessionConversationOutline,
    truncateOutlineLabel
} from '@/chat/outline'
import type { SessionPrompt } from '@/types/api'

function userBlock(
    id: string,
    text: string,
    createdAt: number,
    overrides: Partial<Extract<ChatBlock, { kind: 'user-text' }>> = {}
): ChatBlock {
    return {
        kind: 'user-text',
        id,
        localId: null,
        createdAt,
        text,
        ...overrides
    }
}

function eventBlock(id: string, event: AgentEvent, createdAt: number): ChatBlock {
    return {
        kind: 'agent-event',
        id,
        createdAt,
        event,
    }
}

function prompt(
    id: string,
    text: string,
    createdAt: number,
    overrides: Partial<SessionPrompt> = {}
): SessionPrompt {
    return {
        id,
        localId: null,
        text,
        createdAt,
        sentFrom: 'webapp',
        ...overrides
    }
}

describe('conversation outline from the loaded blocks', () => {
    it('creates outline items from user messages', () => {
        expect(buildSessionConversationOutline({ prompts: null, blocks: [
            userBlock('m1', 'Implement the outline panel', 1000),
        ] })).toEqual([
            {
                id: 'outline:user-text:m1',
                targetMessageId: 'user-text:m1',
                messageId: 'm1',
                kind: 'user',
                label: 'Implement the outline panel',
                createdAt: 1000,
                searchText: 'Implement the outline panel'
            }
        ])
    })

    it('ignores title and summary events', () => {
        const items = buildSessionConversationOutline({ prompts: null, blocks: [
            eventBlock('e1', { type: 'title-changed', title: 'Add conversation outline' }, 1000),
            eventBlock('e2', { type: 'message', message: 'Context compacted into a summary.' }, 2000),
            eventBlock('e3', { type: 'ready' }, 3000),
        ] })

        expect(items).toEqual([])
    })

    it('handles empty and long labels', () => {
        expect(buildSessionConversationOutline({ prompts: null, blocks: [
            userBlock('empty', ' \n\t ', 1000),
        ] })[0]?.label).toBe('Empty message')

        expect(truncateOutlineLabel('a '.repeat(80), 20)).toBe('a a a a a a a a a...')
    })

    it('filters queued user messages that are not yet locatable in the thread', () => {
        const items = buildSessionConversationOutline({ prompts: null, blocks: [
            userBlock('queued', 'Queued prompt', 1000, { status: 'queued', invokedAt: null }),
            userBlock('sent', 'Visible prompt', 2000, { status: 'sent', invokedAt: 2500 }),
        ] })

        expect(items.map((item) => item.id)).toEqual([
            'outline:user-text:sent'
        ])
    })

    it('keeps block order stable', () => {
        const items = buildSessionConversationOutline({ prompts: null, blocks: [
            userBlock('first', 'First', 1000),
            eventBlock('summary', { type: 'message', message: 'Summary' }, 900),
            userBlock('second', 'Second', 1100),
        ] })

        expect(items.map((item) => item.id)).toEqual([
            'outline:user-text:first',
            'outline:user-text:second'
        ])
    })
})

describe('session conversation outline', () => {
    it('lists the prompts of the whole session, not only the loaded ones', () => {
        const items = buildSessionConversationOutline({
            prompts: [
                prompt('p1', 'First prompt', 1000),
                prompt('p2', 'Second prompt', 2000),
                prompt('p3', 'Third prompt', 3000),
            ],
            blocks: [userBlock('p3', 'Third prompt', 3000)]
        })

        expect(items.map((item) => item.id)).toEqual([
            'outline:user-text:p1',
            'outline:user-text:p2',
            'outline:user-text:p3'
        ])
        expect(items.map((item) => item.label)).toEqual([
            'First prompt',
            'Second prompt',
            'Third prompt'
        ])
    })

    it('prefers the loaded block over the stored prompt of the same message', () => {
        const items = buildSessionConversationOutline({
            prompts: [prompt('r1', 'Stored text', 1000, { localId: 'l1' })],
            blocks: [userBlock('l1', 'Local text', 1000, { localId: 'l1' })]
        })

        expect(items).toHaveLength(1)
        expect(items[0]?.label).toBe('Local text')
        expect(items[0]?.targetMessageId).toBe('user-text:l1')
    })

    it('adds a prompt that the hub has not stored yet', () => {
        const items = buildSessionConversationOutline({
            prompts: [prompt('r1', 'Stored text', 1000)],
            blocks: [userBlock('local-2', 'Just sent text', 2000, { localId: 'local-2' })]
        })

        expect(items.map((item) => item.label)).toEqual(['Stored text', 'Just sent text'])
    })

    it('keeps the whole prompt for the search, not only the label', () => {
        const long = `needle ${'padding '.repeat(40)}`
        const items = buildSessionConversationOutline({
            prompts: [prompt('p1', long, 1000)],
            blocks: []
        })

        expect(items[0]?.label.length).toBeLessThan(long.length)
        expect(items[0]?.searchText).toBe(long)
    })

    it('skips prompts the CLI wrote into the transcript', () => {
        const items = buildSessionConversationOutline({
            prompts: [
                prompt('cli-1', '<local-command-stdout>done</local-command-stdout>', 1000, { sentFrom: 'cli' }),
                prompt('p1', 'Real prompt', 2000),
            ],
            blocks: []
        })

        expect(items.map((item) => item.label)).toEqual(['Real prompt'])
    })

    it('falls back to the loaded blocks when no prompt index is available', () => {
        const items = buildSessionConversationOutline({
            prompts: null,
            blocks: [userBlock('m1', 'Loaded prompt', 1000)]
        })

        expect(items.map((item) => item.label)).toEqual(['Loaded prompt'])
    })
})
