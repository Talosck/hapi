import { logger } from '@/ui/logger'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { MinimaxQuotaRequest, MinimaxQuotaResponse } from '@hapi/protocol/apiTypes'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { listMcodeTokenPlanQuota } from '@/mcode/utils/mcodeTokenPlanQuota'
import { listPiTokenPlanQuota } from '@/pi/piTokenPlanQuota'
import { getErrorMessage, rpcError } from '../rpcResponses'

/**
 * Registers the handler that reads the usage window of a MiniMax account.
 *
 * The window is the account's, not the catalog of connected apps' - so it is
 * read on its own. A client that watches the usage does not have to wait for
 * a probe of the apps, and a probe that fails does not take the usage with
 * it.
 *
 * The request names the credential the window is read with. A Pi session
 * reads the account of the Pi install and needs nothing of MiniMax Code;
 * a MiniMax Code session reads the account of its own install.
 */
export function registerMinimaxQuotaHandler(rpcHandlerManager: RpcHandlerManager): void {
    rpcHandlerManager.registerHandler<MinimaxQuotaRequest, MinimaxQuotaResponse>(
        RPC_METHODS.ListMinimaxQuota,
        async (payload) => {
            try {
                const usage = payload?.source === 'pi'
                    ? await listPiTokenPlanQuota()
                    : await listMcodeTokenPlanQuota()
                // A window that could not be read is a missing window, not a
                // made up zero: the client shows nothing rather than a share
                // the account never reported.
                return { success: true, quota: usage.quota }
            } catch (error) {
                logger.debug('Failed to read the MiniMax usage window:', error)
                return rpcError(getErrorMessage(error, 'Failed to read the MiniMax usage window'))
            }
        }
    )
}
