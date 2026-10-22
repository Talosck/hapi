import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { McodeModelSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import type { McodeModelsResponse } from '@hapi/protocol/apiTypes'

/**
 * How often the catalog is re-read while it is still empty.
 *
 * The agent publishes its catalog when it starts, so a session that is not
 * connected yet answers with an empty list. Polling for a short while lets
 * the picker fill in as soon as the agent is up, instead of waiting for an
 * unrelated refresh.
 */
const MCODE_MODEL_DISCOVERY_POLL_MS = 1000
const MAX_MCODE_MODEL_DISCOVERY_POLLS = 10

export function shouldRetryMcodeModelsQuery(failureCount: number): boolean {
    return failureCount < 3
}

export function getMcodeModelsRefetchInterval(
    enabled: boolean,
    data: McodeModelsResponse | undefined,
    pollCount: number
): 1000 | false {
    if (!enabled || pollCount >= MAX_MCODE_MODEL_DISCOVERY_POLLS) {
        return false
    }
    if (!data) {
        return MCODE_MODEL_DISCOVERY_POLL_MS
    }
    if (data.success === false) {
        return MCODE_MODEL_DISCOVERY_POLL_MS
    }
    return (data.availableModels?.length ?? 0) > 0 ? false : MCODE_MODEL_DISCOVERY_POLL_MS
}

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
        retry: (failureCount) => shouldRetryMcodeModelsQuery(failureCount),
        refetchInterval: (query) => getMcodeModelsRefetchInterval(
            enabled,
            query.state.data as McodeModelsResponse | undefined,
            query.state.dataUpdateCount + query.state.errorUpdateCount
        ),
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
