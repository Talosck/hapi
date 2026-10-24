import { useMemo, useRef } from 'react'
import ReactDOM from 'react-dom/client'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '../src/index.css'
import type { ApiClient } from '../src/api/client'
import type {
    DecryptedMessage,
    MessagesAroundResponse,
    MessagesResponse,
    Session,
    SessionPrompt
} from '../src/types/api'
import { I18nProvider } from '../src/lib/i18n-context'
import { useMessages } from '../src/hooks/queries/useMessages'
import { useSessionPrompts } from '../src/hooks/queries/useSessionPrompts'
import { normalizeDecryptedMessage } from '../src/chat/normalize'
import { reduceChatBlocks } from '../src/chat/reducer'
import { reconcileChatBlocks } from '../src/chat/reconcile'
import { buildVisibleChatBlocks } from '../src/chat/toolGroups'
import { isQueuedForInvocation } from '../src/lib/messages'
import { useHappyRuntime } from '../src/lib/assistant-runtime'
import { HappyThread } from '../src/components/AssistantChat/HappyThread'
import { buildSessionConversationOutline } from '../src/chat/outline'
import type { ChatBlock } from '../src/chat/types'
import { getMessageWindowState, ingestIncomingMessages } from '../src/lib/message-window-store'

// Drives the real message-window store + chat pipeline + HappyThread + the
// conversation outline against a fake hub, so e2e tests can open a prompt
// that the loaded window does not hold.

const SESSION_ID = 'outline-jump-fixture'
const TOTAL_MESSAGES = 1200
const BASE_AT = 1_700_000_000_000

type Probe = {
    requests: { direction: string; messageId: string | null; limit: number | undefined }[]
    windowState: () => {
        messageCount: number
        oldestSeq: number | null
        newestSeq: number | null
        pinnedMessageId: string | null
    }
    pushIncoming: (seq: number) => void
}

declare global {
    interface Window {
        __probe: Probe
    }
}

window.__probe = {
    requests: [],
    windowState: () => {
        const state = getMessageWindowState(SESSION_ID)
        return {
            messageCount: state.messages.length,
            oldestSeq: state.oldestSeq,
            newestSeq: state.newestSeq,
            pinnedMessageId: state.pinnedMessageId
        }
    },
    pushIncoming: (seq: number) => {
        ingestIncomingMessages(SESSION_ID, [{
            id: `m-${seq}`,
            seq,
            localId: null,
            content: { role: 'user', content: { type: 'text', text: `Fixture message ${seq}` } },
            createdAt: BASE_AT + seq,
            invokedAt: BASE_AT + seq
        } as DecryptedMessage])
    }
}

const allMessages: DecryptedMessage[] = Array.from({ length: TOTAL_MESSAGES }, (_, index) => {
    const seq = index + 1
    return {
        id: `m-${seq}`,
        seq,
        localId: null,
        content: { role: 'user', content: { type: 'text', text: `Fixture message ${seq}` } },
        createdAt: BASE_AT + seq,
        invokedAt: BASE_AT + seq
    } as DecryptedMessage
})

const allPrompts: SessionPrompt[] = allMessages.map((message) => ({
    id: message.id,
    localId: message.localId,
    text: `Fixture message ${message.seq}`,
    createdAt: message.createdAt,
    sentFrom: 'webapp'
}))

function positionOf(message: DecryptedMessage): { at: number; seq: number } {
    return { at: message.invokedAt ?? message.createdAt, seq: message.seq ?? 0 }
}

function pageFrom(messages: DecryptedMessage[], overrides: Partial<MessagesResponse['page']>): MessagesResponse['page'] {
    const oldest = messages[0] ?? null
    const newest = messages[messages.length - 1] ?? null
    return {
        direction: 'latest',
        limit: 200,
        epoch: 1,
        reset: false,
        nextBeforeSeq: oldest?.seq ?? null,
        nextBeforeAt: oldest ? positionOf(oldest).at : null,
        nextAfterSeq: newest?.seq ?? null,
        nextAfterAt: newest ? positionOf(newest).at : null,
        snapshotHeadSeq: newest?.seq ?? null,
        snapshotHeadAt: newest ? positionOf(newest).at : null,
        hasMore: false,
        ...overrides
    }
}

const fakeApi = {
    getHubSettings: async () => ({ sessionSummaryInChat: false }),
    getMachines: async () => ({ machines: [] }),
    getSessionPrompts: async (): Promise<{ prompts: SessionPrompt[]; epoch: number }> => ({
        prompts: allPrompts,
        epoch: 1
    }),
    getMessages: async (_sessionId: string, query: {
        limit?: number
        beforeAt?: number | null
        beforeSeq?: number | null
        afterAt?: number | null
        afterSeq?: number | null
    }): Promise<MessagesResponse> => {
        let direction = 'latest'
        if (query.beforeSeq != null || query.beforeAt != null) direction = 'before'
        else if (query.afterSeq != null || query.afterSeq != null) direction = 'after'
        const limit = query.limit ?? 200
        window.__probe.requests.push({
            direction,
            messageId: null,
            limit: query.limit
        })
        await new Promise((resolve) => setTimeout(resolve, 50))

        if (direction === 'before') {
            const cursorAt = query.beforeAt ?? Number.POSITIVE_INFINITY
            const cursorSeq = query.beforeSeq ?? Number.POSITIVE_INFINITY
            const older = allMessages.filter((message) => {
                const position = positionOf(message)
                return position.at < cursorAt || (position.at === cursorAt && position.seq < cursorSeq)
            })
            const pageMessages = older.slice(-limit)
            const oldest = pageMessages[0] ?? null
            return {
                messages: pageMessages,
                page: pageFrom(pageMessages, {
                    direction: 'before',
                    limit,
                    hasMore: older.length > pageMessages.length,
                    nextBeforeSeq: oldest?.seq ?? null,
                    nextBeforeAt: oldest ? positionOf(oldest).at : null,
                    nextAfterSeq: null,
                    nextAfterAt: null,
                    snapshotHeadSeq: null,
                    snapshotHeadAt: null
                })
            }
        }

        if (direction === 'after') {
            const cursorAt = query.afterAt ?? Number.NEGATIVE_INFINITY
            const cursorSeq = query.afterSeq ?? Number.NEGATIVE_INFINITY
            const newer = allMessages.filter((message) => {
                const position = positionOf(message)
                return position.at > cursorAt || (position.at === cursorAt && position.seq > cursorSeq)
            })
            const pageMessages = newer.slice(0, limit)
            const newest = pageMessages[pageMessages.length - 1] ?? null
            return {
                messages: pageMessages,
                page: pageFrom(pageMessages, {
                    direction: 'after',
                    limit,
                    hasMore: newer.length > pageMessages.length,
                    nextBeforeSeq: null,
                    nextBeforeAt: null,
                    nextAfterSeq: newest?.seq ?? null,
                    nextAfterAt: newest ? positionOf(newest).at : null,
                    snapshotHeadSeq: null,
                    snapshotHeadAt: null
                })
            }
        }

        const pageMessages = allMessages.slice(-limit)
        return {
            messages: pageMessages,
            page: pageFrom(pageMessages, {
                direction: 'latest',
                limit,
                reset: true,
                hasMore: allMessages.length > pageMessages.length
            })
        }
    },
    getMessagesAround: async (
        _sessionId: string,
        messageId: string,
        options: { limit?: number } = {}
    ): Promise<MessagesAroundResponse> => {
        const limit = options.limit ?? 200
        window.__probe.requests.push({
            direction: 'around',
            messageId,
            limit: options.limit
        })
        await new Promise((resolve) => setTimeout(resolve, 50))

        const targetIndex = allMessages.findIndex((message) => message.id === messageId)
        if (targetIndex < 0) {
            throw new Error(`fixture: unknown message ${messageId}`)
        }
        const beforeCount = Math.floor((limit - 1) / 2)
        const start = Math.max(0, targetIndex - beforeCount)
        const end = Math.min(allMessages.length, targetIndex + (limit - beforeCount))
        const pageMessages = allMessages.slice(start, end)
        const oldest = pageMessages[0] ?? null
        const newest = pageMessages[pageMessages.length - 1] ?? null
        return {
            messages: pageMessages,
            page: {
                limit,
                epoch: 1,
                targetId: messageId,
                nextBeforeSeq: oldest?.seq ?? null,
                nextBeforeAt: oldest ? positionOf(oldest).at : null,
                nextAfterSeq: newest?.seq ?? null,
                nextAfterAt: newest ? positionOf(newest).at : null,
                snapshotHeadSeq: allMessages[allMessages.length - 1]?.seq ?? null,
                snapshotHeadAt: allMessages[allMessages.length - 1]
                    ? positionOf(allMessages[allMessages.length - 1]!).at
                    : null,
                hasMore: start > 0
            }
        }
    }
} as unknown as ApiClient

const fakeSession = {
    id: SESSION_ID,
    active: true,
    thinking: false,
    agentState: null,
    metadata: { path: '/tmp/fixture', host: 'fixture' }
} as unknown as Session

const noopSend = () => {}
const noopAbort = async () => {}

function FixtureThread() {
    const {
        messages,
        warning,
        isSyncingTail,
        isLoadingMore,
        hasMore,
        messagesVersion,
        historyVersion,
        loadMore,
        cancelLoadMore,
        setViewMode
    } = useMessages(fakeApi, SESSION_ID)

    const { prompts } = useSessionPrompts(fakeApi, SESSION_ID)

    const blocksByIdRef = useRef<Map<string, ChatBlock>>(new Map())

    const normalizedMessages = useMemo(() => {
        const normalized = []
        for (const message of messages) {
            if (isQueuedForInvocation(message)) continue
            const next = normalizeDecryptedMessage(message)
            if (next) normalized.push(next)
        }
        return normalized
    }, [messages])

    const reduced = useMemo(() => reduceChatBlocks(normalizedMessages, null, {}), [normalizedMessages])
    const reconciled = useMemo(
        () => reconcileChatBlocks(reduced.blocks, blocksByIdRef.current),
        [reduced.blocks]
    )
    blocksByIdRef.current = reconciled.byId
    const visibleBlocks = useMemo(
        () => buildVisibleChatBlocks(reconciled.blocks, { hasMoreMessages: hasMore }),
        [reconciled.blocks, hasMore]
    )

    const outlineItems = useMemo(
        () => buildSessionConversationOutline({ prompts, blocks: reconciled.blocks }),
        [prompts, reconciled.blocks]
    )

    const runtime = useHappyRuntime({
        session: fakeSession,
        blocks: visibleBlocks,
        messagesVersion,
        historyVersion,
        isSending: false,
        onSendMessage: noopSend,
        onAbort: noopAbort
    })

    return (
        <AssistantRuntimeProvider runtime={runtime}>
            <div className="flex h-screen min-h-0 flex-col">
                <HappyThread
                    api={fakeApi}
                    session={fakeSession}
                    sessionId={SESSION_ID}
                    metadata={null}
                    disabled={false}
                    onRefresh={() => {}}
                    onViewModeChange={setViewMode}
                    isSyncingTail={isSyncingTail}
                    messagesWarning={warning}
                    hasMoreMessages={hasMore}
                    isLoadingMoreMessages={isLoadingMore}
                    onLoadMore={loadMore}
                    onCancelLoadMore={cancelLoadMore}
                    unseenCount={0}
                    rawMessagesCount={messages.length}
                    normalizedMessagesCount={normalizedMessages.length}
                    messagesVersion={messagesVersion}
                    historyVersion={historyVersion}
                    forceScrollToken={0}
                    outlineOpen={true}
                    outlineItems={outlineItems}
                    onOutlineOpenChange={() => {}}
                />
            </div>
        </AssistantRuntimeProvider>
    )
}

const queryClient = new QueryClient({
    defaultOptions: {
        queries: { retry: false }
    }
})

ReactDOM.createRoot(document.getElementById('root')!).render(
    <QueryClientProvider client={queryClient}>
        <I18nProvider>
            <FixtureThread />
        </I18nProvider>
    </QueryClientProvider>
)
