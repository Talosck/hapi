import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { McodeModelSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useMcodeModelsForCwd(args: {
    api: ApiClient | null
    machineId?: string | null
    cwd?: string | null
    enabled?: boolean
}): {
    availableModels: McodeModelSummary[]
    currentModelId: string | null
    effortOptions: Array<{ value: string; name?: string }>
    currentEffort: string | null
    isLoading: boolean
    error: string | null
    /** Asks the machine again - a failed probe is worth another try. */
    refetch: () => void
} {
    const { api, machineId, cwd } = args
    const trimmedCwd = typeof cwd === 'string' ? cwd.trim() : ''
    const enabled = Boolean(args.enabled && api && machineId && trimmedCwd)

    const query = useQuery({
        // The catalog comes from the provider configuration of the machine,
        // not from the workspace: every directory on a machine shares one
        // answer, so the query is keyed by the machine alone. Keying it by
        // the directory asked the machine again for every path the user
        // typed.
        queryKey: machineId
            ? queryKeys.machineMcodeModels(machineId)
            : ['machine-mcode-models', 'unknown'] as const,
        queryFn: async () => {
            if (!api || !machineId || !trimmedCwd) {
                throw new Error('MiniMax Code models target unavailable')
            }
            return await api.getMachineMcodeModelsForCwd(machineId, trimmedCwd)
        },
        enabled,
        staleTime: 60_000,
        retry: false,
    })

    return {
        availableModels: query.data?.availableModels ?? [],
        currentModelId: query.data?.currentModelId ?? null,
        effortOptions: query.data?.effortOptions ?? [],
        currentEffort: query.data?.currentEffort ?? null,
        isLoading: query.isLoading,
        error: query.data?.success === false
            ? (query.data.error ?? 'Failed to load MiniMax Code models')
            : query.error instanceof Error
                ? query.error.message
                : query.error
                    ? 'Failed to load MiniMax Code models'
                    : null,
        refetch: () => {
            void query.refetch()
        },
    }
}
