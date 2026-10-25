import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { StatusBar } from './StatusBar'

function renderStatusBar(props: Partial<React.ComponentProps<typeof StatusBar>> = {}) {
    return render(
        <I18nProvider>
            <StatusBar
                active={true}
                thinking={false}
                agentState={null}
                agentFlavor="claude"
                {...props}
            />
        </I18nProvider>
    )
}

describe('the context usage of a Claude session', () => {
    it('shows the share of the context that a single request used', () => {
        // The local (transcript) path reports the context of one request, which
        // is what the context bar is about.
        renderStatusBar({ contextSize: 75_159, contextWindow: 1_000_000 })

        expect(screen.getByText(/8% · 75k \/ 1\.0M/)).toBeTruthy()
    })

    it('shows the window alone when the size is a whole turn', () => {
        // A turn's usage is the sum of every request it made, so putting it
        // next to the window would report a context larger than the window.
        renderStatusBar({
            contextSize: 1_185_530,
            contextWindow: 1_000_000,
            contextSizeIsTurnTotal: true
        })

        expect(screen.queryByText(/118%/)).toBeNull()
        // The bar carries a wide and a compact label, so the window shows up
        // in both.
        expect(screen.getAllByText(/ctx 1\.0M/).length).toBeGreaterThan(0)
    })

    it('keeps the window of a turn when no usage has been measured yet', () => {
        renderStatusBar({ contextWindow: 1_000_000 })

        expect(screen.queryByText(/%/)).toBeNull()
    })
})
