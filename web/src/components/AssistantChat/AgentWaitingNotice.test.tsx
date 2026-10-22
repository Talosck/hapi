import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AgentWaitingNotice } from './AgentWaitingNotice'

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string, params?: Record<string, unknown>) => (
        params ? `${key}:${Object.values(params).join(',')}` : key
    ) }),
}))

describe('AgentWaitingNotice', () => {
    it('renders nothing while the agent is not waiting', () => {
        const { container } = render(<AgentWaitingNotice waitingSinceMs={null} />)
        expect(container.firstChild).toBeNull()
    })

    it('says the agent is busy and that the message is kept', () => {
        render(<AgentWaitingNotice waitingSinceMs={Date.now() - 5_000} />)
        expect(screen.getByRole('status')).toBeInTheDocument()
        expect(screen.getByText('agentWaiting.title')).toBeInTheDocument()
        expect(screen.getByText('agentWaiting.body')).toBeInTheDocument()
    })

    it('shows how long the wait has been running', () => {
        render(<AgentWaitingNotice waitingSinceMs={Date.now() - 5_000} />)
        expect(screen.getByText(/agentWaiting\.elapsed/)).toBeInTheDocument()
    })
})
