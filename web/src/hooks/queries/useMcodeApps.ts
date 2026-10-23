import { useQuery } from '@tanstack/react-query'
import { useRef } from 'react'
import type { ApiClient } from '@/api/client'
import type { McodeConnectorApp, McodeConnectorAuth, McodeQuotaWindow } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

/**
 * How often the connected apps are re-read.
 *
 * The machine caches the catalog for the same span, so a faster poll would
 * only ask for the answer it already has.
 */
const APPS_REFRESH_MS = 5 * 60_000

/**
 * How long a read counts as "just now" for the forced refresh.
 *
 * The machine caches the catalog for minutes, because reading it costs two
 * subprocess spawns. A user who connects an app comes back to the tab right
 * after, so a later read asks for a fresh answer - but not when the last
 * read was a moment ago, or every tab switch would spawn them.
 */
const APPS_FORCE_REFRESH_GRACE_MS = 15_000

/**
 * The apps connected to a machine's MiniMax Code installation.
 *
 * The connector tools are not part of the ACP surface: the agent reaches them
 * through the `mcode-tools` CLI. This query is the only way the web learns
 * what the agent can actually reach, which is otherwise invisible.
 */
export function useMcodeApps(args: {
    api: ApiClient | null
    machineId?: string | null
    enabled?: boolean
}): {
    apps: McodeConnectorApp[]
    auth: McodeConnectorAuth | null
    quota: McodeQuotaWindow | null
    isLoading: boolean
    error: string | null
} {
    const { api, machineId } = args
    const enabled = Boolean(args.enabled && api && machineId)
    const lastReadAt = useRef(0)

    const query = useQuery({
        queryKey: machineId
            ? queryKeys.machineMcodeApps(machineId)
            : ['machine-mcode-apps', 'unknown'] as const,
        queryFn: async () => {
            if (!api || !machineId) throw new Error('MiniMax Code apps target unavailable')
            const now = Date.now()
            // The first read may use the machine's cache. A later read is the
            // user coming back to the tab after connecting an app, so it asks
            // for a fresh answer.
            const forceRefresh = lastReadAt.current > 0
                && now - lastReadAt.current > APPS_FORCE_REFRESH_GRACE_MS
            const result = await api.getMachineMcodeApps(machineId, { forceRefresh })
            lastReadAt.current = Date.now()
            return result
        },
        enabled,
        // The connected apps change when the user connects one, which happens
        // outside HAPI - a short stale time keeps the list honest without
        // re-running a subprocess on every render.
        staleTime: 60_000,
        // The user comes back to the tab right after connecting an app, and
        // the global query defaults do not re-read on focus.
        refetchOnWindowFocus: true,
        // The machine caches the catalog for the same span, so polling faster
        // than that would only ask the machine for the answer it already has.
        refetchInterval: APPS_REFRESH_MS,
        retry: false,
    })

    return {
        apps: query.data?.apps ?? [],
        auth: query.data?.auth ?? null,
        quota: query.data?.quota ?? null,
        isLoading: query.isLoading,
        error: query.data?.success === false
            ? (query.data.error ?? 'Failed to load the MiniMax Code apps')
            : query.error instanceof Error
                ? query.error.message
                : query.error
                    ? 'Failed to load the MiniMax Code apps'
                    : null,
    }
}
