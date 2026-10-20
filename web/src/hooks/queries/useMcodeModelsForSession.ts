import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { McodeModelSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useMcodeModelsForSession(args: {
    api: ApiClient | null
    sessionId?: string | null
    enabled?: boolean
}): {
    availableModels: McodeModelSummary[]
    currentModelId: string | null
    effortOptions: Array<{ value: string; name?: string }>
    currentEffort: string | null
    isLoading: boolean
    error: string | null
} {
    const enabled = Boolean(args.enabled && args.api && args.sessionId)
    const query = useQuery({
        queryKey: args.sessionId
            ? queryKeys.sessionMcodeModels(args.sessionId)
            : ['session-mcode-models', 'unknown'] as const,
        queryFn: async () => {
            if (!args.api || !args.sessionId) throw new Error('MiniMax Code session unavailable')
            return await args.api.getSessionMcodeModels(args.sessionId)
        },
        enabled,
        staleTime: 30_000,
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
            : query.error instanceof Error ? query.error.message : null,
    }
}
