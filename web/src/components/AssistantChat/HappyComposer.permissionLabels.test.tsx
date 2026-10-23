import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode, TextareaHTMLAttributes } from 'react'
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import type { ComposerSendIntent } from '@/lib/messageDelivery'
import type { ComposerToolbarLayout } from '@/hooks/useComposerToolbarLayout'
import { HappyComposer } from './HappyComposer'

/**
 * The permission sheet must name a mode the way the agent that runs it names
 * it.
 *
 * MiniMax Code calls its modes Ask, Auto and Full access. The shared catalog
 * says "Yolo" for `bypassPermissions` (the wording of another agent), and the
 * composer's sheet rendered that label straight from the catalog - so the
 * composer said "Yolo" while the status bar next to it said "Full access".
 */
type FakeAttachment = { id: string; status: { type: 'complete' } }
type MockComposerInputProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
    asChild?: boolean
    maxRows?: number
    submitOnEnter?: boolean
    cancelOnEscape?: boolean
}
type FakeRuntimeState = {
    composer: { text: string; attachments: FakeAttachment[] }
    thread: { isRunning: boolean; isDisabled: boolean }
}

const runtime = vi.hoisted(() => ({
    snapshot: {
        composer: { text: '', attachments: [] as FakeAttachment[] },
        thread: { isRunning: false, isDisabled: false },
    } as FakeRuntimeState,
    setSnapshot: null as null | ((updater: (current: FakeRuntimeState) => FakeRuntimeState) => void),
    pendingSendIntentRef: { current: 'default' },
    sentIntents: [] as ComposerSendIntent[],
    narrowViewport: false,
    toolbarLayout: null as ComposerToolbarLayout | null,
}))

vi.mock('@assistant-ui/react', async () => {
    const React = await import('react')
    return {
        useAui: () => ({
            composer: () => ({
                setText: (text: string) => {
                    runtime.setSnapshot!((current) => ({
                        ...current,
                        composer: { ...current.composer, text },
                    }))
                },
                send: () => {
                    const intent = runtime.pendingSendIntentRef?.current ?? 'default'
                    runtime.sentIntents.push(intent as ComposerSendIntent)
                    if (runtime.pendingSendIntentRef) runtime.pendingSendIntentRef.current = 'default'
                    runtime.setSnapshot!((current) => ({
                        ...current,
                        composer: { text: '', attachments: [] },
                    }))
                },
                addAttachment: async () => {},
            }),
            thread: () => ({ cancelRun: () => {} }),
        }),
        useAuiState: (selector: (state: typeof runtime.snapshot) => unknown) => selector(runtime.snapshot),
        ComposerPrimitive: {
            Root: ({ children, onSubmit }: { children: ReactNode; onSubmit?: () => void }) => (
                <form onSubmit={onSubmit}>{children}</form>
            ),
            AddAttachment: ({ children }: { children: ReactNode }) => <>{children}</>,
            Input: React.forwardRef<HTMLTextAreaElement, MockComposerInputProps>(
                (
                    {
                        asChild: _asChild,
                        onChange,
                        maxRows: _maxRows,
                        submitOnEnter: _submitOnEnter,
                        cancelOnEscape: _cancelOnEscape,
                        ...props
                    },
                    ref
                ) => (
                    <textarea
                        {...props}
                        ref={ref}
                        value={runtime.snapshot.composer.text}
                        onChange={(event) => {
                            runtime.setSnapshot!((current) => ({
                                ...current,
                                composer: { ...current.composer, text: event.target.value },
                            }))
                        }}
                    />
                )
            ),
        },
    }
})
vi.mock('@/hooks/useComposerToolbarLayout', async () => {
    const actual = await import('@/hooks/useComposerToolbarLayout')
    return {
        ...actual,
        useComposerToolbarLayout: () => ({ layout: runtime.toolbarLayout ?? actual.DEFAULT_COMPOSER_TOOLBAR_LAYOUT }),
    }
})
vi.mock('@/hooks/useNarrowViewport', () => ({
    useNarrowViewport: () => runtime.narrowViewport,
}))
vi.mock('@/hooks/useComposerDraft', () => ({
    useComposerDraft: () => ({ sessionId: undefined, complete: true, restoredAny: false, hasStoredAttachments: false }),
}))
vi.mock('@/hooks/useComposerEnterBehavior', () => ({ useComposerEnterBehavior: () => ({ composerEnterBehavior: 'send' }) }))
vi.mock('@/hooks/usePlatform', () => ({ usePlatform: () => ({ haptic: { impact: () => {}, notification: () => {} }, isTouch: false }) }))
vi.mock('@/hooks/usePWAInstall', () => ({ usePWAInstall: () => ({ isStandalone: false, isIOS: false }) }))
vi.mock('@/hooks/useActiveWord', () => ({ useActiveWord: () => null }))
vi.mock('@/hooks/useActiveSuggestions', () => ({ useActiveSuggestions: () => [[], -1, () => {}, () => {}, () => {}] }))
vi.mock('@/components/ChatInput/FloatingOverlay', () => ({ FloatingOverlay: ({ children }: { children: ReactNode }) => <>{children}</> }))
vi.mock('@/components/ChatInput/Autocomplete', () => ({ Autocomplete: () => null }))
vi.mock('@/components/AssistantChat/StatusBar', () => ({ StatusBar: () => null }))

function renderComposer(agentFlavor: string, overrides: Partial<Parameters<typeof HappyComposer>[0]> = {}) {
    render(
        <I18nProvider>
            <HappyComposer
                sessionId="composer-permission-test"
                disabled={false}
                agentFlavor={agentFlavor}
                model="m2.5"
                effort="high"
                permissionMode="default"
                onModelChange={vi.fn()}
                onEffortChange={vi.fn()}
                onPermissionModeChange={vi.fn()}
                availableModelOptions={[{ value: 'm2.5', label: 'M2.5' }]}
                pendingSendIntentRef={runtime.pendingSendIntentRef as { current: ComposerSendIntent }}
                {...overrides}
            />
        </I18nProvider>
    )
}

/** Opens the full settings sheet, where the permission modes live. */
function openSettingsSheet(): void {
    act(() => {
        fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    })
}

describe('HappyComposer permission mode labels', () => {
    afterEach(() => {
        cleanup()
        runtime.setSnapshot = null
        runtime.narrowViewport = false
        runtime.toolbarLayout = null
        runtime.snapshot.thread.isDisabled = false
        runtime.sentIntents = []
    })

    it('names the MiniMax Code modes the way the agent names them', () => {
        renderComposer('mcode')
        openSettingsSheet()
        expect(screen.getByText('Permission Mode')).toBeTruthy()
        // "Ask", "Auto" and "Full access" are MiniMax Code's own words.
        expect(screen.getByText('Full access')).toBeTruthy()
        expect(screen.queryByText('Yolo')).toBeNull()
    })

    it('keeps the shared wording for the other agents', () => {
        renderComposer('claude')
        openSettingsSheet()
        expect(screen.getByText('Permission Mode')).toBeTruthy()
        expect(screen.getByText('Yolo')).toBeTruthy()
    })
})
