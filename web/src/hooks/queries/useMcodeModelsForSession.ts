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

/**
 * Whether the catalog is still being asked for.
 *
 * The catalog is asked for while it is empty, and again while it does not
 * name the model the session runs. The second case is a model switch in
 * flight: the hub records the new model as soon as the client asks for the
 * switch, which is before the agent has applied it, so the answer that
 * arrives first still names the old model - and the picker would offer the
 * effort levels of a model the session is not running.
 */
export function getMcodeModelsRefetchInterval(
    enabled: boolean,
    data: McodeModelsResponse | undefined,
    discoveryStartedAt: number,
    now: number,
    sessionModel?: string | null
): 1000 | false {
    if (!enabled) {
        return false
    }
    const hasModels = data?.success !== false && (data?.availableModels?.length ?? 0) > 0
    // A catalog that does not name the model the session runs is stale, but
    // only when both sides name one: an agent that has not reported its
    // current model yet answers with nothing, and that is not a model
    // switch - it would keep the picker asking for the rest of the budget.
    //
    // The model the agent runs also has to be one the catalog publishes. The
    // agent can move to a model on its own - the local TUI switches it, or a
    // session that shares the process does - and then the hub keeps naming
    // the old model. That is not a switch in flight either, and waiting for
    // the two to agree would ask for the rest of the budget for nothing.
    const currentModelIsPublished = (data?.availableModels ?? [])
        .some((model) => model.modelId === data?.currentModelId)
    const catalogIsStale = hasModels
        && !!sessionModel
        && !!data?.currentModelId
        && currentModelIsPublished
        && data.currentModelId !== sessionModel
    if (hasModels && !catalogIsStale) {
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
    /**
     * The model the session runs, as the hub knows it.
     *
     * The hub records the model as soon as the client asks for a switch, so
     * this can name a model the agent has not applied yet. The catalog is
     * asked for again while the two disagree, which is what makes the picker
     * catch up with a switch that is still in flight.
     */
    sessionModel?: string | null
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
                now,
                args.sessionModel
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
