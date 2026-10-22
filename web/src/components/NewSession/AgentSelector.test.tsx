import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { CREATABLE_AGENT_FLAVORS } from '@hapi/protocol'

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}))

import { AgentSelector } from './AgentSelector'
import type { AgentType } from './types'

function renderedAgentValues(agents: readonly AgentType[] = CREATABLE_AGENT_FLAVORS): string[] {
    const { container } = render(
        <AgentSelector
            agent={'claude' as AgentType}
            agents={agents}
            isDisabled={false}
            onAgentChange={() => {}}
        />
    )
    return Array.from(container.querySelectorAll('input[type="radio"]'))
        .map((el) => (el as HTMLInputElement).value)
}

describe('AgentSelector', () => {
    it('does not offer the sunset Gemini CLI as a new-session agent', () => {
        expect(renderedAgentValues()).not.toContain('gemini')
    })

    it('offers exactly the creatable agent flavors', () => {
        expect(renderedAgentValues()).toEqual([...CREATABLE_AGENT_FLAVORS])
    })

    it('renders only Agents reported available by the machine', () => {
        expect(renderedAgentValues(['claude', 'codex'])).toEqual(['claude', 'codex'])
    })

    it('tells the user why an Agent is missing instead of dropping it silently', () => {
        const { container } = render(
            <AgentSelector
                agent={'claude' as AgentType}
                agents={['claude']}
                unavailableAgents={[{ agent: 'mcode' as AgentType, reason: 'not_signed_in' }]}
                isDisabled={false}
                onAgentChange={() => {}}
            />
        )

        // The missing agent is not offered as a choice...
        const values = Array.from(container.querySelectorAll('input[type="radio"]'))
            .map((el) => (el as HTMLInputElement).value)
        expect(values).toEqual(['claude'])
        // ...but the reason is on screen, because it is what the user acts on.
        expect(container.textContent).toContain('newSession.agentUnavailable.notSignedIn')
    })

    it('names the reason an Agent is unavailable', () => {
        const { container } = render(
            <AgentSelector
                agent={'claude' as AgentType}
                agents={['claude']}
                unavailableAgents={[
                    { agent: 'mcode' as AgentType, reason: 'not_found' },
                    { agent: 'codex' as AgentType, reason: 'invalid_configuration' },
                ]}
                isDisabled={false}
                onAgentChange={() => {}}
            />
        )

        expect(container.textContent).toContain('newSession.agentUnavailable.notFound')
        expect(container.textContent).toContain('newSession.agentUnavailable.invalidConfiguration')
    })
})
