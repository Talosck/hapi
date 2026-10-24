import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { MinimaxQuotaWindow } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

/**
 * How often the usage window is re-read.
 *
 * The window is a share of five hours, so it moves slowly - but it is the
 * number a user watches while they work, so it is read more often than the
 * catalog of connected apps. The machine keeps the answer for a minute, so a
 * faster read would only ask for the answer it already has.
 */
const QUOTA_REFRESH_MS = 2 * 60_000

/**
 * The usage the MiniMax account of the session has left.
 *
 * The window belongs to the account, so it is read on its own: the catalog of
 * connected apps is not involved, so a failed probe does not take the usage
 * with it, and a client that watches the usage does not pay for the probe.
 *
 * The session decides which account is read: a Pi session reads the account
 * of the Pi install and needs nothing of MiniMax Code, a MiniMax Code
 * session reads the account of its own install.
 */
export function useMinimaxQuota(args: {
    api: ApiClient | null
    sessionId: string | null
    enabled?: boolean
}): {
    quota: MinimaxQuotaWindow | null
    isLoading: boolean
    error: string | null
} {
    const { api, sessionId } = args
    const enabled = Boolean(args.enabled && api && sessionId)

    const query = useQuery({
        queryKey: queryKeys.sessionMinimaxQuota(sessionId as string),
        queryFn: async () => {
            if (!api) throw new Error('The MiniMax usage target is unavailable')
            return await api.getSessionMinimaxQuota(sessionId as string)
        },
        enabled,
        // The window is watched, not fetched: the answer of a moment ago is
        // good enough, and the machine caches it anyway.
        staleTime: QUOTA_REFRESH_MS,
        // The user comes back to the tab and wants to know where the window
        // stands now.
        refetchOnWindowFocus: true,
        refetchInterval: QUOTA_REFRESH_MS,
        retry: false
    })

    return {
        quota: query.data?.quota ?? null,
        isLoading: query.isLoading,
        error: query.data?.success === false
            ? (query.data.error ?? 'Failed to read the MiniMax usage window')
            : query.error instanceof Error
                ? query.error.message
                : query.error
                    ? 'Failed to read the MiniMax usage window'
                    : null
    }
}
