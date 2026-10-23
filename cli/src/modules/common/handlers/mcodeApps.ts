import { logger } from '@/ui/logger'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { McodeAppsResponse } from '@hapi/protocol/apiTypes'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { getAgentLaunchCommand } from '@/agent/agentLaunchCommand'
import { listMcodeConnectorApps } from '@/mcode/utils/mcodeConnectorTools'
import { listMcodeTokenPlanQuota } from '@/mcode/utils/mcodeTokenPlanQuota'
import { getErrorMessage, rpcError } from '../rpcResponses'

/**
 * Registers the handler that lists the apps connected to this machine's
 * MiniMax Code installation.
 *
 * The connector tools are not part of the ACP surface, so this is the only
 * way an external client learns which apps the agent can reach.
 */
export function registerMcodeAppHandlers(rpcHandlerManager: RpcHandlerManager): void {
    rpcHandlerManager.registerHandler<Record<string, never>, McodeAppsResponse>(
        RPC_METHODS.ListMcodeApps,
        async () => {
            try {
                const catalog = await listMcodeConnectorApps({
                    mcodeCommand: getAgentLaunchCommand('mcode')
                })
                // The usage of the account is read on its own: a host that
                // cannot hand out a lease must not cost the user the list of
                // the apps. A usage that could not be read is simply missing
                // - the reason is in the log.
                const usage = await listMcodeTokenPlanQuota()
                if (catalog.error) {
                    return { success: false, auth: catalog.auth, apps: [], error: catalog.error }
                }
                return { success: true, auth: catalog.auth, apps: catalog.apps, quota: usage.quota }
            } catch (error) {
                logger.debug('Failed to list the MiniMax Code apps:', error)
                return rpcError(getErrorMessage(error, 'Failed to list the MiniMax Code apps'))
            }
        }
    )
}
