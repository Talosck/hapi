import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { PropsWithChildren } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { getMcodeModelsRefetchInterval, useMcodeModelsForSession } from './useMcodeModelsForSession'

function wrapper(queryClient: QueryClient) {
    return ({ children }: PropsWithChildren) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
}

function createQueryClient() {
    return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

describe('getMcodeModelsRefetchInterval', () => {
    it('keeps looking for a catalog that is still empty', () => {
        // An agent that starts slowly answers with an empty list. The budget
        // is a span of time, so those answers must not end the discovery.
        expect(getMcodeModelsRefetchInterval(true, {
            success: true,
            availableModels: [],
            currentModelId: null
        }, 0, 30_000)).toBe(1000)
    })

    it('gives up after the discovery budget', () => {
        expect(getMcodeModelsRefetchInterval(true, {
            success: true,
            availableModels: [],
            currentModelId: null
        }, 0, 120_000)).toBe(false)
    })

    it('stops asking once the agent published its catalog', () => {
        expect(getMcodeModelsRefetchInterval(true, {
            success: true,
            availableModels: [{ modelId: 'm:good' }],
            currentModelId: 'm:good'
        }, 0, 1_000)).toBe(false)
    })

    it('does not ask for a session that is not there', () => {
        expect(getMcodeModelsRefetchInterval(false, undefined, 0, 1_000)).toBe(false)
    })
})

describe('useMcodeModelsForSession', () => {
    it('fills the picker in once the agent publishes its catalog', async () => {
        let calls = 0
        const getSessionMcodeModels = vi.fn(async () => {
            calls += 1
            return calls < 2
                ? { success: true, availableModels: [], currentModelId: null }
                : { success: true, availableModels: [{ modelId: 'm:good' }], currentModelId: 'm:good' }
        })
        const api = { getSessionMcodeModels } as unknown as ApiClient
        const queryClient = createQueryClient()

        const { result } = renderHook(() => useMcodeModelsForSession({
            api,
            sessionId: 'session-1',
            enabled: true
        }), { wrapper: wrapper(queryClient) })

        await waitFor(() => expect(result.current.availableModels).toHaveLength(1), { timeout: 10_000 })
        expect(result.current.currentModelId).toBe('m:good')
        expect(getSessionMcodeModels.mock.calls.length).toBeGreaterThanOrEqual(2)
    })

    it('does not probe without an active session', () => {
        const getSessionMcodeModels = vi.fn()
        const api = { getSessionMcodeModels } as unknown as ApiClient
        const queryClient = createQueryClient()

        const disabled = renderHook(() => useMcodeModelsForSession({
            api,
            sessionId: 'session-1',
            enabled: false
        }), { wrapper: wrapper(queryClient) })
        const withoutSession = renderHook(() => useMcodeModelsForSession({
            api,
            sessionId: null,
            enabled: true
        }), { wrapper: wrapper(queryClient) })

        expect(getSessionMcodeModels).not.toHaveBeenCalled()
        expect(disabled.result.current.availableModels).toEqual([])
        expect(withoutSession.result.current.availableModels).toEqual([])
    })

    it('surfaces a failed session probe as an error with no catalog', async () => {
        const getSessionMcodeModels = vi.fn(async () => ({
            success: false,
            error: 'MiniMax Code model discovery timed out'
        }))
        const api = { getSessionMcodeModels } as unknown as ApiClient
        const queryClient = createQueryClient()

        const { result } = renderHook(() => useMcodeModelsForSession({
            api,
            sessionId: 'session-1',
            enabled: true
        }), { wrapper: wrapper(queryClient) })

        await waitFor(() => expect(result.current.error).toBe('MiniMax Code model discovery timed out'))
        expect(result.current.availableModels).toEqual([])
    })

    it('starts the discovery budget when the session becomes eligible', async () => {
        // The budget measures how long the catalog is looked for. A session
        // that was not eligible yet - the agent is still starting, the session
        // is archived - must not spend the budget while it cannot ask.
        vi.useFakeTimers()
        try {
            const getSessionMcodeModels = vi.fn(async () => ({
                success: true,
                availableModels: [] as Array<{ modelId: string }>,
                currentModelId: null
            }))
            const api = { getSessionMcodeModels } as unknown as ApiClient
            const queryClient = createQueryClient()

            const { rerender } = renderHook(
                ({ enabled }: { enabled: boolean }) => useMcodeModelsForSession({
                    api,
                    sessionId: 'session-1',
                    enabled
                }),
                { wrapper: wrapper(queryClient), initialProps: { enabled: false } }
            )

            await act(async () => {
                await vi.advanceTimersByTimeAsync(90_000)
            })
            expect(getSessionMcodeModels).not.toHaveBeenCalled()

            // The session becomes eligible long after the budget would have
            // been spent. The discovery has to start here, not be over.
            rerender({ enabled: true })
            await act(async () => {
                await vi.advanceTimersByTimeAsync(1)
            })
            const afterEnable = getSessionMcodeModels.mock.calls.length
            expect(afterEnable).toBeGreaterThan(0)

            await act(async () => {
                await vi.advanceTimersByTimeAsync(5_000)
            })
            expect(getSessionMcodeModels.mock.calls.length).toBeGreaterThan(afterEnable)
        } finally {
            vi.useRealTimers()
        }
    })
})
