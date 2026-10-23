import { useQuery } from '@tanstack/react-query'
import { useRef } from 'react'
import type { ApiClient } from '@/api/client'
import type { McodeModelSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import type { McodeModelsResponse } from '@hapi/protocol/apiTypes'

/**
 * How often the catalog is re-read while it is still empty.
 *
 * The agent publishes its catalog when it starts, so a session that is not
 * connected yet answers with an empty list. Polling lets the picker fill in
 * as soon as the agent is up, instead of waiting for an unrelated refresh.
 */
const MCODE_MODEL_DISCOVERY_POLL_MS = 1000
/**
 * How long the catalog is looked for before the discovery gives up.
 *
 * The budget is a span of time and not a number of polls: an agent that
 * starts slowly answers with an empty list many times in a row, and a budget
 * that counts those answers runs out before the agent is up. A picker that
 * gave up then stayed empty until something else invalidated the query.
 */
const MCODE_MODEL_DISCOVERY_BUDGET_MS = 60_000

/**
 * The lists of a session that has no catalog yet.
 *
 * They are the same list on every render: a list that is new each time
 * invalidates the memos that read it, so the model picker is rebuilt on every
 * render of the chat.
 */
const NO_MODELS: McodeModelSummary[] = []
const NO_EFFORT_OPTIONS: Array<{ value: string; name?: string }> = []

export function shouldRetryMcodeModelsQuery(failureCount: number): boolean {
    return failureCount < 3
}

export function getMcodeModelsRefetchInterval(
    enabled: boolean,
    data: McodeModelsResponse | undefined,
    discoveryStartedAt: number,
    now: number
): 1000 | false {
    if (!enabled) {
        return false
    }
    const hasModels = data?.success !== false && (data?.availableModels?.length ?? 0) > 0
    if (hasModels) {
        return false
    }
    if (now - discoveryStartedAt >= MCODE_MODEL_DISCOVERY_BUDGET_MS) {
        return false
    }
    return MCODE_MODEL_DISCOVERY_POLL_MS
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
    // When the discovery started, per session. The span of time is what the
    // budget is measured against, so it must not be a number of polls.
    const discovery = useRef<{ key: string; startedAt: number } | null>(null)
    const sessionKey = args.sessionId ?? ''

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
        // A session that was opened before its agent was up keeps an empty
        // catalog until something else invalidates the query. Coming back to
        // the tab asks again.
        refetchOnWindowFocus: true,
        refetchInterval: (query) => {
            const now = Date.now()
            if (!enabled) {
                // The catalog cannot be asked for yet, so the budget must not
                // start: it measures how long the catalog is looked for, and
                // a session that only becomes eligible minutes later has not
                // had its look yet. The stamp is cleared so that enabling
                // starts a fresh budget.
                discovery.current = null
                return false
            }
            if (discovery.current?.key !== sessionKey) {
                discovery.current = { key: sessionKey, startedAt: now }
            }
            return getMcodeModelsRefetchInterval(
                enabled,
                query.state.data as McodeModelsResponse | undefined,
                discovery.current.startedAt,
                now
            )
        },
    })

    return {
        availableModels: query.data?.availableModels ?? NO_MODELS,
        currentModelId: query.data?.currentModelId ?? null,
        effortOptions: query.data?.effortOptions ?? NO_EFFORT_OPTIONS,
        currentEffort: query.data?.currentEffort ?? null,
        isLoading: query.isLoading,
        error: query.data?.success === false
            ? (query.data.error ?? 'Failed to load MiniMax Code models')
            : query.error instanceof Error ? query.error.message : null,
    }
}
