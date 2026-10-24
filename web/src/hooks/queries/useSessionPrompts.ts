import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useRef } from 'react'
import type { ApiClient } from '@/api/client'
import type { SessionPrompt } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

/**
 * The prompt index of a session: every prompt the operator sent, oldest first.
 *
 * The transcript the web renders is a bounded window, so the outline cannot be
 * built from it — it would only ever show the prompts inside the loaded slice.
 * The hub serves the whole list from the message log instead, so the outline
 * covers the entire conversation no matter how much of it is on screen.
 *
 * `epoch` is the message epoch of the loaded window. A rewind rewrites the
 * history and bumps it, which makes the held index stale, so it is refetched
 * when the two disagree.
 */
export function useSessionPrompts(
    api: ApiClient | null,
    sessionId: string | null,
    epoch: number | null = null
): {
    prompts: SessionPrompt[]
    isLoading: boolean
    error: string | null
    refresh: () => void
} {
    const resolvedSessionId = sessionId ?? 'unknown'

    const query = useQuery({
        queryKey: queryKeys.sessionPrompts(resolvedSessionId),
        queryFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            return await api.getSessionPrompts(sessionId)
        },
        enabled: Boolean(api && sessionId),
        // The index only changes when the conversation is rewritten, which the
        // epoch check below detects. Polling it would re-read the whole
        // message log of the session every few seconds.
        staleTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        retry: false,
    })

    const fetchedEpochRef = useRef<number | null>(null)
    if (query.data) {
        fetchedEpochRef.current = query.data.epoch
    }

    useEffect(() => {
        if (epoch === null || fetchedEpochRef.current === null) {
            return
        }
        if (epoch === fetchedEpochRef.current) {
            return
        }
        // The window was rewritten (rewind / fork): the index we hold describes
        // prompts that no longer exist.
        void query.refetch()
    }, [epoch, query.refetch])

    const refresh = useCallback(() => {
        void query.refetch()
    }, [query.refetch])

    return {
        prompts: query.data?.prompts ?? [],
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load prompts' : null,
        refresh
    }
}
