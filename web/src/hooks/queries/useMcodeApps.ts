import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { McodeConnectorApp, McodeConnectorAuth } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

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
    isLoading: boolean
    error: string | null
} {
    const { api, machineId } = args
    const enabled = Boolean(args.enabled && api && machineId)

    const query = useQuery({
        queryKey: machineId
            ? queryKeys.machineMcodeApps(machineId)
            : ['machine-mcode-apps', 'unknown'] as const,
        queryFn: async () => {
            if (!api || !machineId) throw new Error('MiniMax Code apps target unavailable')
            return await api.getMachineMcodeApps(machineId)
        },
        enabled,
        // The connected apps change when the user connects one, which happens
        // outside HAPI - a short stale time keeps the list honest without
        // re-running a subprocess on every render.
        staleTime: 60_000,
        retry: false,
    })

    return {
        apps: query.data?.apps ?? [],
        auth: query.data?.auth ?? null,
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
