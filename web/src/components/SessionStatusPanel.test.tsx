import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { SessionStatusPanel } from './SessionStatusPanel'
import type { SessionStatusData } from '@/chat/sessionStatus'

function renderWithProviders(ui: React.ReactElement) {
    return render(<I18nProvider>{ui}</I18nProvider>)
}

const emptyStatus: SessionStatusData = {
    goal: null,
    tasks: [],
    subagents: [],
    terminals: [],
    undiscoveredTerminalCount: 0,
    possibleTerminalCommands: []
}

describe('SessionStatusPanel', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        Object.defineProperty(window, 'localStorage', {
            value: {
                getItem: vi.fn(() => 'en'),
                setItem: vi.fn(),
                removeItem: vi.fn(),
                clear: vi.fn(),
                key: vi.fn(() => null),
                length: 0
            },
            configurable: true
        })
    })

    afterEach(() => {
        cleanup()
    })

    it('renders the session status summary', () => {
        renderWithProviders(<SessionStatusPanel data={emptyStatus} />)
        expect(screen.getByText('Session status')).toBeInTheDocument()
    })

    /**
     * The panel used to stretch across the whole chat pane, so on a wide
     * desktop screen the short "Session status" label floated in a very wide
     * box. It must line up with the conversation column instead.
     */
    it('keeps the panel at the chat column width instead of the full pane', () => {
        renderWithProviders(<SessionStatusPanel data={emptyStatus} />)
        const panel = screen.getByTestId('session-status-panel')
        expect(panel).toHaveClass('max-w-content')
        expect(panel).toHaveClass('mx-auto')
        expect(panel).toHaveClass('w-full')
    })

    it('pads the panel away from the pane edges', () => {
        renderWithProviders(<SessionStatusPanel data={emptyStatus} />)
        const panel = screen.getByTestId('session-status-panel')
        expect(panel.parentElement).toHaveClass('px-3')
    })
})
