import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { TeamPanel } from './TeamPanel'
import type { TeamState } from '@hapi/protocol/types'

const teamState: TeamState = {
    teamName: 'alpha',
    members: [{ name: 'worker-1', status: 'active' }],
    tasks: [{ id: 't1', title: 'Ship it', status: 'in_progress' }]
}

describe('TeamPanel', () => {
    afterEach(() => {
        cleanup()
    })

    it('renders the team name', () => {
        render(<TeamPanel teamState={teamState} />)
        expect(screen.getByText('Team: alpha')).toBeInTheDocument()
    })

    /**
     * The team bar used to stretch across the whole chat pane, so on a wide
     * desktop screen the short "Team: ..." label floated in a very wide box.
     * It must line up with the conversation column instead.
     */
    it('keeps the team bar at the chat column width instead of the full pane', () => {
        render(<TeamPanel teamState={teamState} />)
        const panel = screen.getByTestId('team-panel')
        const column = panel.firstElementChild
        expect(column).toHaveClass('max-w-content')
        expect(column).toHaveClass('mx-auto')
        expect(column).toHaveClass('w-full')
    })

    it('pads the team bar away from the pane edges', () => {
        render(<TeamPanel teamState={teamState} />)
        expect(screen.getByTestId('team-panel')).toHaveClass('px-3')
    })

    it('expands the details on click', () => {
        render(<TeamPanel teamState={teamState} />)
        expect(screen.queryByText('Members')).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button'))
        expect(screen.getByText('Members')).toBeInTheDocument()
        expect(screen.getByText('Ship it')).toBeInTheDocument()
    })
})
