import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { SessionStatusPanel } from './SessionStatusPanel'
import type { SessionStatusData, SessionStatusSubagent } from '@/chat/sessionStatus'
import type { ApiClient } from '@/api/client'

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

const GOAL = {
    threadId: 'thread-1',
    objective: 'Ship the feature',
    status: 'active' as const,
    tokensUsed: 1200,
    timeUsedSeconds: 42,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_060
}

const SUBAGENT: SessionStatusSubagent = {
    id: 'child-1',
    title: 'Explore the API',
    detail: null,
    state: 'running',
    startedAt: 5,
    endedAt: null,
    depth: 0
}

function createApi() {
    return {
        patchMcodeGoal: vi.fn(async () => ({ success: true })),
        clearMcodeGoal: vi.fn(async () => ({ success: true })),
        createMcodeGoal: vi.fn(async () => ({ success: true })),
        stopMcodeDelegation: vi.fn(async () => ({ success: true }))
    } as unknown as ApiClient
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

    /**
     * MiniMax Code's goal extension is optional in the agent, so the panel
     * must render the goal controls only for the features the running agent
     * advertised.
     */
    it('offers no goal controls when the session advertises no extension', () => {
        renderWithProviders(
            <SessionStatusPanel
                data={emptyStatus}
                goalControls={{ api: createApi(), sessionId: 's1', capabilities: null }}
            />
        )
        expect(screen.queryByText('Set goal')).not.toBeInTheDocument()
    })

    it('offers the goal control when the agent advertises goal/create', () => {
        renderWithProviders(
            <SessionStatusPanel
                data={emptyStatus}
                goalControls={{
                    api: createApi(),
                    sessionId: 's1',
                    capabilities: { goal: true, goalCreate: true }
                }}
            />
        )
        expect(screen.getByText('Set goal')).toBeInTheDocument()
    })

    it('offers no goal control when the agent disabled the goal extension', () => {
        renderWithProviders(
            <SessionStatusPanel
                data={emptyStatus}
                goalControls={{
                    api: createApi(),
                    sessionId: 's1',
                    capabilities: { goal: false, goalCreate: false }
                }}
            />
        )
        expect(screen.queryByText('Set goal')).not.toBeInTheDocument()
    })

    it('pauses and clears an existing goal', () => {
        const api = createApi()
        renderWithProviders(
            <SessionStatusPanel
                data={{ ...emptyStatus, goal: GOAL }}
                goalControls={{
                    api,
                    sessionId: 's1',
                    capabilities: { goal: true, goalPatch: true, goalClear: true }
                }}
            />
        )

        expect(screen.getByText('Pause')).toBeInTheDocument()
        expect(screen.getByText('Clear goal')).toBeInTheDocument()

        fireEvent.click(screen.getByText('Pause'))
        expect(api.patchMcodeGoal).toHaveBeenCalledWith('s1', { status: 'paused' })
    })

    it('stops the subagents when the agent advertises delegation/stop', () => {
        const api = createApi()
        renderWithProviders(
            <SessionStatusPanel
                data={{ ...emptyStatus, subagents: [SUBAGENT] }}
                goalControls={{
                    api,
                    sessionId: 's1',
                    capabilities: { delegation: true, delegationStop: true }
                }}
            />
        )

        fireEvent.click(screen.getByText('Stop subagents'))
        expect(api.stopMcodeDelegation).toHaveBeenCalledWith('s1')
    })

    it('offers no subagent control when the agent cannot stop them', () => {
        renderWithProviders(
            <SessionStatusPanel
                data={{ ...emptyStatus, subagents: [SUBAGENT] }}
                goalControls={{
                    api: createApi(),
                    sessionId: 's1',
                    capabilities: { delegation: true, delegationStop: false }
                }}
            />
        )
        expect(screen.queryByText('Stop subagents')).not.toBeInTheDocument()
    })

    /**
     * The connector tools are not part of the ACP surface, so this list is
     * the only trace of the apps the agent can reach.
     */
    it('lists the connected apps', () => {
        renderWithProviders(
            <SessionStatusPanel
                data={emptyStatus}
                apps={{
                    apps: [{
                        provider: 'matrix',
                        toolCount: 13,
                        tools: []
                    }],
                    auth: { status: 'authenticated', authMode: 'shared-broker', scope: null, expiresAt: null },
                    error: null
                }}
            />
        )
        expect(screen.getByText('Connected apps')).toBeInTheDocument()
        expect(screen.getByText('matrix')).toBeInTheDocument()
        expect(screen.getByText('13 tools')).toBeInTheDocument()
    })

    it('says so when no apps are connected', () => {
        renderWithProviders(
            <SessionStatusPanel
                data={emptyStatus}
                apps={{
                    apps: [],
                    auth: { status: 'authenticated', authMode: 'shared-broker', scope: null, expiresAt: null },
                    error: null
                }}
            />
        )
        expect(screen.getByText('No apps connected')).toBeInTheDocument()
    })

    it('does not claim there are no apps when the list could not be read', () => {
        renderWithProviders(
            <SessionStatusPanel
                data={emptyStatus}
                apps={{
                    apps: [],
                    auth: null,
                    error: 'spawn mcode-tools ENOENT'
                }}
            />
        )
        expect(screen.getByText('The connected apps could not be read')).toBeInTheDocument()
        expect(screen.queryByText('No apps connected')).not.toBeInTheDocument()
    })

    it('shows no apps section for a session without one', () => {
        renderWithProviders(<SessionStatusPanel data={emptyStatus} />)
        expect(screen.queryByText('Connected apps')).not.toBeInTheDocument()
    })
})
