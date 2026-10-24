import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { PropsWithChildren } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { useMinimaxQuota } from './useMinimaxQuota'

function wrapper(queryClient: QueryClient) {
    return ({ children }: PropsWithChildren) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
}

function createQueryClient() {
    return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

const WINDOW = { remainingPercent: 42, resetAtMs: 1792720800000, unlimited: false }

describe('useMinimaxQuota', () => {
    it('reads the window of the account the session spends', async () => {
        const getSessionMinimaxQuota = vi.fn(async () => ({ success: true, quota: WINDOW }))
        const api = { getSessionMinimaxQuota } as unknown as ApiClient
        const queryClient = createQueryClient()

        const { result } = renderHook(() => useMinimaxQuota({
            api,
            sessionId: 'session-1',
            enabled: true
        }), { wrapper: wrapper(queryClient) })

        await waitFor(() => expect(result.current.quota).toEqual(WINDOW))
        expect(getSessionMinimaxQuota).toHaveBeenCalledWith('session-1')
    })

    it('does not ask the machine of the install', async () => {
        // The session decides which account is read: a Pi session reads the
        // account of the Pi install, so the machine of MiniMax Code is not
        // asked at all.
        const getSessionMinimaxQuota = vi.fn(async () => ({ success: true, quota: WINDOW }))
        const getMachineMinimaxQuota = vi.fn()
        const api = { getSessionMinimaxQuota, getMachineMinimaxQuota } as unknown as ApiClient
        const queryClient = createQueryClient()

        const { result } = renderHook(() => useMinimaxQuota({
            api,
            sessionId: 'session-1',
            enabled: true
        }), { wrapper: wrapper(queryClient) })

        await waitFor(() => expect(result.current.quota).toEqual(WINDOW))
        expect(getMachineMinimaxQuota).not.toHaveBeenCalled()
    })

    it('has no window when the account reports none', async () => {
        // An account without a five hour window is not spending one, so
        // there is nothing to show - and nothing failed either.
        const getSessionMinimaxQuota = vi.fn(async () => ({ success: true, quota: null }))
        const api = { getSessionMinimaxQuota } as unknown as ApiClient
        const queryClient = createQueryClient()

        const { result } = renderHook(() => useMinimaxQuota({
            api,
            sessionId: 'session-1',
            enabled: true
        }), { wrapper: wrapper(queryClient) })

        await waitFor(() => expect(result.current.error).toBeNull())
        expect(result.current.quota).toBeNull()
    })

    it('reports a window that could not be read instead of a made up zero', async () => {
        const getSessionMinimaxQuota = vi.fn(async () => ({
            success: false,
            error: 'Pi has no MiniMax account to read the usage from'
        }))
        const api = { getSessionMinimaxQuota } as unknown as ApiClient
        const queryClient = createQueryClient()

        const { result } = renderHook(() => useMinimaxQuota({
            api,
            sessionId: 'session-1',
            enabled: true
        }), { wrapper: wrapper(queryClient) })

        await waitFor(() => expect(result.current.error).toBe('Pi has no MiniMax account to read the usage from'))
        expect(result.current.quota).toBeNull()
    })

    it('does not read while the session does not spend the account', () => {
        const getSessionMinimaxQuota = vi.fn()
        const api = { getSessionMinimaxQuota } as unknown as ApiClient
        const queryClient = createQueryClient()

        renderHook(() => useMinimaxQuota({
            api,
            sessionId: 'session-1',
            enabled: false
        }), { wrapper: wrapper(queryClient) })

        expect(getSessionMinimaxQuota).not.toHaveBeenCalled()
    })
})
