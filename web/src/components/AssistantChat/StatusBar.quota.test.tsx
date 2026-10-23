import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { StatusBar } from './StatusBar'

function renderWithProviders(ui: React.ReactElement) {
    return render(<I18nProvider>{ui}</I18nProvider>)
}

describe('StatusBar quota chip', () => {
    it('shows the five hour window next to the context usage', () => {
        renderWithProviders(
            <StatusBar
                active
                thinking={false}
                agentState={null}
                contextSize={90_000}
                contextWindow={258_000}
                quota={{
                    remainingPercent: 98,
                    resetAtMs: Date.now() + 2 * 60 * 60 * 1000,
                    unlimited: false
                }}
            />
        )
        expect(screen.getByText('5h 98%')).toBeInTheDocument()
        // The chip sits next to the context usage, not in a panel of its own.
        expect(screen.getByText('35% · 90k / 258k')).toBeInTheDocument()
    })

    it('shows no chip when the account has no usage to report', () => {
        renderWithProviders(
            <StatusBar
                active
                thinking={false}
                agentState={null}
                contextSize={90_000}
                contextWindow={258_000}
            />
        )
        expect(screen.queryByText(/5h/)).not.toBeInTheDocument()
    })
})
