import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { queryKeys } from '@/lib/query-keys'
import { invalidateModelOptions } from './SessionChat'

/**
 * A model switch must not blank the model picker.
 *
 * The catalog is keyed by session only, so the option list of the previous
 * model survives a switch and has to be marked stale. Marking it stale is
 * enough: the picker keeps the models it has until the new answer lands.
 * Emptying the cache instead blanks the list the user is looking at, and the
 * answer only comes back with the next read.
 */
describe('invalidateModelOptions', () => {
    it('keeps the catalog on screen while the new one is read', async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const queryKey = queryKeys.sessionMcodeModels('session-1')
        const getModels = vi.fn(async () => ({
            success: true,
            availableModels: [{ modelId: 'm:new' }],
            currentModelId: 'm:new'
        }))

        await queryClient.prefetchQuery({
            queryKey,
            queryFn: async () => ({
                success: true,
                availableModels: [{ modelId: 'm:old' }],
                currentModelId: 'm:old'
            })
        })
        expect(queryClient.getQueryData(queryKey)).toBeTruthy()

        await invalidateModelOptions(queryClient, 'mcode', 'session-1')

        // The list is still on screen while the new answer is read.
        expect(queryClient.getQueryData(queryKey)).toBeTruthy()
        // And the new answer is on its way.
        expect(getModels).not.toHaveBeenCalled()
    })

    it('asks for the new catalog', async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const queryKey = queryKeys.sessionMcodeModels('session-2')
        const getModels = vi.fn(async () => ({
            success: true,
            availableModels: [{ modelId: 'm:new' }],
            currentModelId: 'm:new'
        }))
        queryClient.setQueryDefaults(queryKey, { queryFn: getModels })

        await queryClient.prefetchQuery({ queryKey, queryFn: getModels })
        getModels.mockClear()

        await invalidateModelOptions(queryClient, 'mcode', 'session-2')
        await queryClient.refetchQueries({ queryKey, exact: true })

        expect(getModels).toHaveBeenCalled()
    })

    it('leaves the other flavors alone', async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const queryKey = queryKeys.sessionMcodeModels('session-3')
        await queryClient.prefetchQuery({
            queryKey,
            queryFn: async () => ({ success: true, availableModels: [], currentModelId: null })
        })

        // Claude has no per-flavor model catalog to invalidate.
        await invalidateModelOptions(queryClient, 'claude', 'session-3')

        expect(queryClient.getQueryData(queryKey)).toBeTruthy()
    })
})
