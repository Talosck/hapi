import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { ToolCallBlock } from '@/chat/types'
import { PlanDocumentView } from '@/components/ToolCard/views/PlanDocumentView'
import { getToolViewComponent } from '@/components/ToolCard/views/_all'
import { I18nProvider } from '@/lib/i18n-context'

function planBlock(input: unknown): ToolCallBlock {
    return {
        kind: 'tool-call',
        id: 'plan-document:plan-1',
        localId: null,
        createdAt: 1000,
        children: [],
        tool: {
            id: 'plan-document:plan-1',
            name: 'plan_document',
            state: 'completed',
            input,
            result: null,
            description: null,
            createdAt: 1000,
            startedAt: 1000,
            completedAt: 1500,
            execStartedAt: null,
            execCompletedAt: null
        }
    }
}

function renderPlan(input: unknown) {
    return render(
        <I18nProvider>
            <PlanDocumentView block={planBlock(input)} metadata={null} />
        </I18nProvider>
    )
}

describe('PlanDocumentView', () => {
    afterEach(() => {
        cleanup()
    })

    it('renders a markdown plan as markdown', async () => {
        const { container } = renderPlan({ plan: '# Plan\n\nShip the feature', format: 'markdown' })

        expect(container.querySelector('h1')?.textContent).toBe('Plan')
        expect(container.textContent).toContain('Ship the feature')

        // The markdown path pulls in the syntax highlighter, whose grammars
        // load in the background. Let those imports settle before the file
        // ends: a worker that is torn down mid-import can die, and the next
        // file it picks up is then lost with it.
        await new Promise((resolve) => setTimeout(resolve, 200))
    })

    it('renders a file plan as a path reference', () => {
        renderPlan({ plan: 'docs/plan.md', format: 'file' })

        expect(screen.getByText('docs/plan.md')).toBeInTheDocument()
    })

    it('renders nothing without a plan', () => {
        const { container } = renderPlan({ format: 'markdown' })

        expect(container.textContent).toBe('')
    })

    it('is registered as the tool view', () => {
        expect(getToolViewComponent('plan_document')).toBe(PlanDocumentView)
    })
})
