import { describe, expect, it, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { StatusBar } from './StatusBar'

function renderWithProviders(ui: React.ReactElement) {
    return render(<I18nProvider>{ui}</I18nProvider>)
}

describe('StatusBar quota chip', () => {
    beforeEach(() => {
        localStorage.clear()
    })

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

    it('keeps the chip in English and speaks the reader language in the popover', async () => {
        localStorage.setItem('hapi-lang', 'zh-CN')
        renderWithProviders(
            <StatusBar
                active
                thinking={false}
                agentState={null}
                quota={{
                    remainingPercent: 98,
                    resetAtMs: Date.now() + 2 * 60 * 60 * 1000,
                    unlimited: false
                }}
            />
        )

        // The status bar chip stays English, the popover is localized.
        expect(screen.getByText('5h 98%')).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: '5 小时用量详情' }))

        expect(await screen.findByText('剩余 98%')).toBeInTheDocument()
        expect(screen.getByText(/距离重置还有/)).toBeInTheDocument()
    })

    it('shows the english popover for an english reader', async () => {
        localStorage.setItem('hapi-lang', 'en')
        renderWithProviders(
            <StatusBar
                active
                thinking={false}
                agentState={null}
                quota={{
                    remainingPercent: 98,
                    resetAtMs: Date.now() + 2 * 60 * 60 * 1000,
                    unlimited: false
                }}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: '5-hour usage details' }))

        expect(await screen.findByText('98% left')).toBeInTheDocument()
        expect(screen.getByText(/^Resets in/)).toBeInTheDocument()
    })

    it('localizes the unlimited window state', async () => {
        localStorage.setItem('hapi-lang', 'zh-CN')
        renderWithProviders(
            <StatusBar
                active
                thinking={false}
                agentState={null}
                quota={{ remainingPercent: null, resetAtMs: null, unlimited: true }}
            />
        )

        expect(screen.getByText('5h ∞')).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: '5 小时用量详情' }))
        expect(await screen.findByText('不限量')).toBeInTheDocument()
    })

    it('localizes the unknown window state', async () => {
        localStorage.setItem('hapi-lang', 'zh-CN')
        renderWithProviders(
            <StatusBar
                active
                thinking={false}
                agentState={null}
                quota={{ remainingPercent: null, resetAtMs: null, unlimited: false }}
            />
        )

        expect(screen.getByText('5h —')).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: '5 小时用量详情' }))
        expect(await screen.findByText('用量未知')).toBeInTheDocument()
    })
})
