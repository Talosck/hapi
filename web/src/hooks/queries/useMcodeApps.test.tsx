import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { PropsWithChildren } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { useMcodeApps } from './useMcodeApps'

function wrapper(queryClient: QueryClient) {
    return ({ children }: PropsWithChildren) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
}

function createQueryClient() {
    return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

describe('useMcodeApps', () => {
    afterEach(() => {
        vi.useRealTimers()
    })

    it('reads the connected apps of the machine', async () => {
        const getMachineMcodeApps = vi.fn(async () => ({
            success: true,
            apps: [{ provider: 'matrix', toolCount: 13, tools: [] }],
            auth: { status: 'authenticated', authMode: 'shared-broker', scope: null, expiresAt: null }
        }))
        const api = { getMachineMcodeApps } as unknown as ApiClient
        const queryClient = createQueryClient()

        const { result } = renderHook(() => useMcodeApps({
            api,
            machineId: 'machine-1',
            enabled: true
        }), { wrapper: wrapper(queryClient) })

        await waitFor(() => expect(result.current.apps).toHaveLength(1))
        expect(getMachineMcodeApps).toHaveBeenCalledWith('machine-1', { forceRefresh: false })
    })

    it('asks the machine for a fresh catalog after the first read', async () => {
        // The connected apps change outside HAPI. The user comes back to the
        // tab right after connecting one, so a later read asks the machine for
        // a fresh answer instead of the cached one.
        vi.useFakeTimers({ toFake: ['Date'] })
        const start = new Date('2026-01-01T00:00:00Z')
        vi.setSystemTime(start)

        const getMachineMcodeApps = vi.fn(async (
            _machineId: string,
            _options?: { forceRefresh?: boolean }
        ) => ({
            success: true,
            apps: [],
            auth: { status: 'authenticated', authMode: 'shared-broker', scope: null, expiresAt: null }
        }))
        const api = { getMachineMcodeApps } as unknown as ApiClient
        const queryClient = createQueryClient()

        const { result } = renderHook(() => useMcodeApps({
            api,
            machineId: 'machine-1',
            enabled: true
        }), { wrapper: wrapper(queryClient) })

        await waitFor(() => expect(getMachineMcodeApps).toHaveBeenCalledTimes(1))
        expect(getMachineMcodeApps.mock.calls[0][1]).toEqual({ forceRefresh: false })

        // Right after the first read the machine's answer is still good enough.
        vi.setSystemTime(new Date(start.getTime() + 2_000))
        await queryClient.refetchQueries()
        await waitFor(() => expect(getMachineMcodeApps).toHaveBeenCalledTimes(2))
        expect(getMachineMcodeApps.mock.calls[1][1]).toEqual({ forceRefresh: false })

        // Once the grace is over, the next read asks for a fresh answer.
        vi.setSystemTime(new Date(start.getTime() + 30_000))
        await queryClient.refetchQueries()
        await waitFor(() => expect(getMachineMcodeApps).toHaveBeenCalledTimes(3))
        expect(getMachineMcodeApps.mock.calls[2][1]).toEqual({ forceRefresh: true })
        expect(result.current.error).toBeNull()
    })

    it('does not read without a machine', () => {
        const getMachineMcodeApps = vi.fn()
        const api = { getMachineMcodeApps } as unknown as ApiClient
        const queryClient = createQueryClient()

        renderHook(() => useMcodeApps({
            api,
            machineId: null,
            enabled: true
        }), { wrapper: wrapper(queryClient) })

        expect(getMachineMcodeApps).not.toHaveBeenCalled()
    })
})
