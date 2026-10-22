import type { HTMLAttributes } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { HappySystemMessage } from './SystemMessage'

const { message } = vi.hoisted(() => ({
    message: {
        role: 'system', id: 'status-example',
        content: [] as { type: string; text: string }[],
        metadata: { custom: {} as Record<string, unknown> }
    }
}))
vi.mock('@assistant-ui/react', () => ({
    useAuiState: (selector: (state: { message: typeof message }) => unknown) => selector({ message }),
    MessagePrimitive: { Root: (props: HTMLAttributes<HTMLDivElement>) => <div {...props} /> }
}))
vi.mock('./MessageTimestamp', () => ({ MessageTimestamp: () => <span>12:00</span> }))

const goal = {
    threadId: 'thread-example-1', objective: 'Compare the options and validate the chosen approach.',
    status: 'active', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0,
    createdAt: 1704067200, updatedAt: 1704067200
}
function show(text: string, eventType = 'message', kind = 'event') {
    message.content = [{ type: 'text', text }]
    message.metadata.custom = { kind, event: { type: eventType, message: text } }
    return render(<I18nProvider><HappySystemMessage /></I18nProvider>)
}

beforeEach(() => { message.role = 'system'; localStorage.clear() })

describe('slash-command goal status messages', () => {
    it('renders the actual event/message response as a goal snapshot card', () => {
        const raw = JSON.stringify({ goal })
        const { container } = show(raw)
        expect(screen.getByText('Goal')).toBeInTheDocument()
        expect(screen.getByText(goal.objective)).toBeInTheDocument()
        expect(screen.getByText('Active')).toBeInTheDocument()
        expect(screen.getByText('0 tokens')).toBeInTheDocument()
        expect(screen.getByText('No limit')).toBeInTheDocument()
        expect(screen.getByText('0.0s')).toBeInTheDocument()
        expect(container.querySelector('[data-goal-status="active"]')).not.toBeNull()
        const details = screen.getByText('Raw JSON').closest('details')!
        expect(details.open).toBe(false)
        fireEvent.click(screen.getByText('Raw JSON'))
        expect(details.open).toBe(true)
        expect(details.textContent).toContain('thread-example-1')
        expect(details.textContent).toContain(raw)
    })

    it('shows an explicitly empty goal', () => {
        show('{"goal":null}')
        expect(screen.getByText('No goal set')).toBeInTheDocument()
    })

    it.each(['Goal cleared', '{broken', '{"objective":"ordinary data"}', JSON.stringify({ goal, error: 'denied' })])
        ('preserves ordinary and malformed status text', (text) => {
            const { container } = show(text)
            expect(screen.getByText(text)).toBeInTheDocument()
            expect(container.querySelector('[data-goal-status]')).toBeNull()
        })

    it.each([['error', 'event'], ['message', 'other']])('only formats confirmed message events', (eventType, kind) => {
        const raw = JSON.stringify({ goal })
        const { container } = show(raw, eventType, kind)
        expect(screen.getByText(raw)).toBeInTheDocument()
        expect(container.querySelector('[data-goal-status]')).toBeNull()
    })

    it('does not format ordinary assistant content', () => {
        message.role = 'assistant'
        const { container } = show(JSON.stringify({ goal }))
        expect(container).toBeEmptyDOMElement()
    })
})

describe('queue notices', () => {
    function showQueueNotice(reason = 'paused') {
        const cliText = 'The MiniMax Code message queue is paused, so your message was not taken.'
        message.content = [{ type: 'text', text: cliText }]
        message.metadata.custom = {
            kind: 'event',
            event: {
                type: 'queue-notice',
                reason,
                message: cliText,
                waitingSeconds: 12
            }
        }
    }

    it('says the notice in the user\'s language, not in the CLI\'s', () => {
        localStorage.setItem('hapi-lang', 'zh-CN')
        showQueueNotice()
        render(<I18nProvider><HappySystemMessage /></I18nProvider>)
        expect(screen.getByText(/消息队列被暂停了/)).toBeInTheDocument()
        expect(screen.getByText(/已等待 12 秒/)).toBeInTheDocument()
        expect(screen.queryByText(/MiniMax Code message queue is paused/)).toBeNull()
    })

    it('keeps the CLI wording for a reason the client does not know', () => {
        localStorage.setItem('hapi-lang', 'zh-CN')
        const cliText = 'MiniMax Code refused the message for a reason it did not explain.'
        message.content = [{ type: 'text', text: cliText }]
        message.metadata.custom = {
            kind: 'event',
            event: { type: 'queue-notice', reason: 'brand-new-reason', message: cliText }
        }
        render(<I18nProvider><HappySystemMessage /></I18nProvider>)
        expect(screen.getByText(cliText)).toBeInTheDocument()
    })
})
