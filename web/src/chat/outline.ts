import type { ChatBlock, UserTextBlock } from '@/chat/types'
import { isCliOutputText } from '@/chat/reducerCliOutput'
import type { SessionPrompt } from '@/types/api'

export type ConversationOutlineItem = {
    id: string
    targetMessageId: string
    /**
     * The hub message id of the prompt.
     *
     * The transcript is a bounded window, so a prompt outside of it cannot be
     * scrolled to: it has to be opened first, and that needs the message id.
     */
    messageId: string
    kind: 'user'
    label: string
    createdAt: number
    /**
     * The full prompt text. The label is a short preview, but the outline
     * search has to reach into the whole prompt to find anything.
     */
    searchText: string
}

const MAX_OUTLINE_LABEL_LENGTH = 96

function collapseWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim()
}

export function truncateOutlineLabel(value: string, maxLength = MAX_OUTLINE_LABEL_LENGTH): string {
    const normalized = collapseWhitespace(value)
    if (normalized.length <= maxLength) {
        return normalized
    }
    return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`
}

function userBlockToOutlineItem(block: UserTextBlock): ConversationOutlineItem {
    const label = truncateOutlineLabel(block.text) || 'Empty message'
    return {
        id: `outline:user-text:${block.id}`,
        targetMessageId: `user-text:${block.id}`,
        messageId: block.id,
        kind: 'user',
        label,
        createdAt: block.createdAt,
        searchText: block.text
    }
}

function isLocatableOutlineBlock(block: ChatBlock): block is UserTextBlock {
    return block.kind === 'user-text'
        && !(block.invokedAt === null && block.status !== 'failed')
}

/**
 * The identity of a prompt across its two shapes: the optimistic bubble the
 * client renders before the hub echoes it, and the stored row the hub
 * returns. Both carry the client-side `localId`, so it identifies the prompt
 * even when the message ids differ.
 */
function promptKey(id: string, localId: string | null): string {
    return localId ?? id
}

function promptToOutlineItem(prompt: SessionPrompt): ConversationOutlineItem {
    const label = truncateOutlineLabel(prompt.text) || 'Empty message'
    return {
        id: `outline:user-text:${prompt.id}`,
        targetMessageId: `user-text:${prompt.id}`,
        messageId: prompt.id,
        kind: 'user',
        label,
        createdAt: prompt.createdAt,
        searchText: prompt.text
    }
}

/**
 * A prompt the CLI wrote into the transcript is not something the operator
 * typed in the chat: the thread renders it as CLI output, so it must not show
 * up as a prompt in the outline either.
 */
function isCliOutputPrompt(prompt: SessionPrompt): boolean {
    return isCliOutputText(prompt.text, { sentFrom: prompt.sentFrom })
}

/**
 * The outline of the whole conversation.
 *
 * `prompts` is the session-wide prompt index the hub serves; it is the only
 * source that covers the parts of the conversation the transcript window does
 * not hold. `blocks` is the loaded window, which is fresher than the index
 * (it holds the optimistic bubble of a prompt that was just sent) and knows
 * which rows are still queued work, so it wins wherever both know a prompt.
 */
export function buildSessionConversationOutline(options: {
    prompts?: readonly SessionPrompt[] | null
    blocks: readonly ChatBlock[]
}): ConversationOutlineItem[] {
    const byKey = new Map<string, { item: ConversationOutlineItem; order: number }>()
    let order = 0

    const prompts = options.prompts ?? []
    for (const prompt of prompts) {
        if (isCliOutputPrompt(prompt)) {
            continue
        }
        const key = promptKey(prompt.id, prompt.localId)
        byKey.set(key, { item: promptToOutlineItem(prompt), order: order++ })
    }

    for (const block of options.blocks) {
        if (!isLocatableOutlineBlock(block)) {
            continue
        }
        const key = promptKey(block.id, block.localId)
        const existing = byKey.get(key)
        byKey.set(key, {
            item: userBlockToOutlineItem(block),
            order: existing?.order ?? order++
        })
    }

    return [...byKey.values()]
        .sort((left, right) => {
            if (left.item.createdAt !== right.item.createdAt) {
                return left.item.createdAt - right.item.createdAt
            }
            return left.order - right.order
        })
        .map((entry) => entry.item)
}

export function getConversationMessageAnchorId(messageId: string): string {
    return `hapi-message-${messageId}`
}
