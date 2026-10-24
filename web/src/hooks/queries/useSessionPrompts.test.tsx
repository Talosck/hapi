import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { PropsWithChildren } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { useSessionPrompts } from './useSessionPrompts'

function wrapper(queryClient: QueryClient) {
    return ({ children }: PropsWithChildren) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
}

function createQueryClient() {
    return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

const PROMPTS = [
    {
        id: 'row-1',
        localId: 'local-1',
        text: 'first prompt',
        createdAt: 1_000,
        sentFrom: 'webapp'
    },
    {
        id: 'row-2',
        localId: 'local-2',
        text: 'second prompt',
        createdAt: 2_000,
        sentFrom: 'webapp'
    }
]

describe('useSessionPrompts', () => {
    it('reads the prompt index of the session', async () => {
        const getSessionPrompts = vi.fn(async () => ({ prompts: PROMPTS, epoch: 3 }))
        const api = { getSessionPrompts } as unknown as ApiClient
        const queryClient = createQueryClient()

        const { result } = renderHook(() => useSessionPrompts(api, 'session-1', 3), {
            wrapper: wrapper(queryClient)
        })

        await waitFor(() => expect(result.current.prompts).toHaveLength(2))
        expect(getSessionPrompts).toHaveBeenCalledWith('session-1')
    })

    it('reads the index again when the history was rewritten', async () => {
        // A rewind bumps the message epoch, and the index we hold describes
        // prompts that no longer exist.
        const getSessionPrompts = vi.fn(async () => ({ prompts: PROMPTS, epoch: 3 }))
        const api = { getSessionPrompts } as unknown as ApiClient
        const queryClient = createQueryClient()

        const { result, rerender } = renderHook(
            ({ epoch }: { epoch: number | null }) => useSessionPrompts(api, 'session-1', epoch),
            { wrapper: wrapper(queryClient), initialProps: { epoch: 3 as number | null } }
        )

        await waitFor(() => expect(result.current.prompts).toHaveLength(2))
        expect(getSessionPrompts).toHaveBeenCalledTimes(1)

        rerender({ epoch: 4 })

        await waitFor(() => expect(getSessionPrompts).toHaveBeenCalledTimes(2))
    })

    it('does not read while the session is unknown', () => {
        const getSessionPrompts = vi.fn()
        const api = { getSessionPrompts } as unknown as ApiClient
        const queryClient = createQueryClient()

        renderHook(() => useSessionPrompts(api, null, null), { wrapper: wrapper(queryClient) })

        expect(getSessionPrompts).not.toHaveBeenCalled()
    })
})
