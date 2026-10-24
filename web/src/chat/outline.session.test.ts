import { describe, expect, it } from 'vitest'
import { buildSessionConversationOutline } from '@/chat/outline'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { reconcileChatBlocks } from '@/chat/reconcile'
import { reduceChatBlocks } from '@/chat/reducer'
import { isQueuedForInvocation } from '@/lib/messages'
import {
    activateMessageWindow,
    clearMessageWindow,
    fetchOlderMessages,
    getMessageWindowState,
    syncTailMessages
} from '@/lib/message-window-store'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage, MessagesResponse, SessionPrompt } from '@/types/api'

const SESSION_ID = 'outline-session'
const BASE_AT = 1_700_000_000_000

type FakeHub = {
    messages: DecryptedMessage[]
    epoch: number
}

function userMessage(index: number): DecryptedMessage {
    const at = BASE_AT + index * 1000
    return {
        id: `user-${index}`,
        localId: `user-${index}`,
        seq: index + 1,
        content: {
            role: 'user',
            content: { type: 'text', text: `prompt ${index}` }
        },
        createdAt: at,
        invokedAt: at
    } as unknown as DecryptedMessage
}

function createFakeHub(count: number): FakeHub {
    return {
        epoch: 0,
        messages: Array.from({ length: count }, (_, index) => userMessage(index))
    }
}

function createApi(hub: FakeHub): ApiClient {
    const getMessages = async (
        _sessionId: string,
        options: {
            beforeAt?: number | null
            beforeSeq?: number | null
            afterAt?: number | null
            afterSeq?: number | null
            limit?: number
        } = {}
    ): Promise<MessagesResponse> => {
        const all = hub.messages
        const limit = options.limit ?? 200
        let page: DecryptedMessage[]
        let direction: 'latest' | 'before' | 'after'
        let hasMore = false
        let nextBeforeAt: number | null = null
        let nextBeforeSeq: number | null = null
        let nextAfterAt: number | null = null
        let nextAfterSeq: number | null = null

        if (options.beforeSeq != null) {
            direction = 'before'
            const end = all.findIndex((message) => message.seq === options.beforeSeq)
            const stop = end === -1 ? all.length : end
            const start = Math.max(0, stop - limit)
            page = all.slice(start, stop)
            hasMore = start > 0
            const oldest = page[0]
            nextBeforeAt = oldest?.invokedAt ?? oldest?.createdAt ?? null
            nextBeforeSeq = oldest?.seq ?? null
        } else if (options.afterSeq != null) {
            direction = 'after'
            const start = all.findIndex((message) => message.seq === options.afterSeq)
            const from = start === -1 ? all.length : start + 1
            page = all.slice(from, from + limit)
            hasMore = from + limit < all.length
            const newest = page.at(-1)
            nextAfterAt = newest?.invokedAt ?? newest?.createdAt ?? null
            nextAfterSeq = newest?.seq ?? null
        } else {
            direction = 'latest'
            const start = Math.max(0, all.length - limit)
            page = all.slice(start)
            hasMore = start > 0
            const oldest = page[0]
            nextBeforeAt = oldest?.invokedAt ?? oldest?.createdAt ?? null
            nextBeforeSeq = oldest?.seq ?? null
        }

        const newest = all.at(-1)
        return {
            messages: page,
            page: {
                direction,
                limit,
                epoch: hub.epoch,
                reset: false,
                nextBeforeAt,
                nextBeforeSeq,
                nextAfterAt,
                nextAfterSeq,
                snapshotHeadAt: newest?.invokedAt ?? newest?.createdAt ?? null,
                snapshotHeadSeq: newest?.seq ?? null,
                hasMore
            }
        }
    }

    return { getMessages } as unknown as ApiClient
}

/** The prompt index the hub serves for the session. */
function promptsFor(hub: FakeHub): SessionPrompt[] {
    return hub.messages
        .filter((message) => message.invokedAt !== null)
        .map((message) => ({
            id: message.id,
            localId: message.localId,
            text: `prompt ${message.id.replace('user-', '')}`,
            createdAt: message.createdAt,
            sentFrom: 'webapp'
        }))
}

/** The outline items the chat thread renders for the current message window. */
function outlineItemsFor(sessionId: string, hub: FakeHub): string[] {
    const messages = getMessageWindowState(sessionId).messages
    const visible = messages.filter((message) => !isQueuedForInvocation(message))
    const normalized = visible
        .map(normalizeDecryptedMessage)
        .filter((message): message is NonNullable<typeof message> => message !== null)
    const reduced = reduceChatBlocks(normalized, null)
    const reconciled = reconcileChatBlocks(reduced.blocks, new Map())
    return buildSessionConversationOutline({
        prompts: promptsFor(hub),
        blocks: reconciled.blocks
    }).map((item) => item.label)
}

describe('conversation outline coverage', () => {
    it('lists every prompt of the session, not only the loaded window', async () => {
        const hub = createFakeHub(300)
        const api = createApi(hub)
        activateMessageWindow(SESSION_ID)
        await syncTailMessages(api, SESSION_ID)

        const items = outlineItemsFor(SESSION_ID, hub)
        expect(items).toHaveLength(300)
        expect(items[0]).toBe('prompt 0')
        expect(items.at(-1)).toBe('prompt 299')

        clearMessageWindow(SESSION_ID)
    })

    it('keeps the prompts of the whole session when the tail advances', async () => {
        const hub = createFakeHub(1000)
        const api = createApi(hub)
        activateMessageWindow(SESSION_ID)
        await syncTailMessages(api, SESSION_ID)
        while (getMessageWindowState(SESSION_ID).hasMore) {
            const outcome = await fetchOlderMessages(api, SESSION_ID)
            if (outcome.kind !== 'applied') break
        }

        // The user sends another prompt while the operator reads history.
        hub.messages = [...hub.messages, userMessage(1000)]
        await syncTailMessages(api, SESSION_ID)

        const items = outlineItemsFor(SESSION_ID, hub)
        expect(items).toHaveLength(1001)
        expect(items).toContain('prompt 0')

        clearMessageWindow(SESSION_ID)
    })
})
