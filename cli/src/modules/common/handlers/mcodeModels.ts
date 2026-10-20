import { logger } from '@/ui/logger'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { ListMcodeModelsResponse } from '@hapi/protocol/apiTypes'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import {
    listMcodeModelsForCwd,
    type ListMcodeModelsForCwdRequest,
    type ListMcodeModelsForCwdResponse
} from '../mcodeModels'
import { getErrorMessage, rpcError } from '../rpcResponses'

export function registerMcodeModelHandlers(rpcHandlerManager: RpcHandlerManager): void {
    rpcHandlerManager.registerHandler<ListMcodeModelsForCwdRequest, ListMcodeModelsForCwdResponse>(
        RPC_METHODS.ListMcodeModelsForCwd,
        async (data) => {
            try {
                return await listMcodeModelsForCwd(typeof data?.cwd === 'string' ? data.cwd : '')
            } catch (error) {
                logger.debug('Failed to list MiniMax Code models:', error)
                return rpcError(getErrorMessage(error, 'Failed to list MiniMax Code models'))
            }
        }
    )
}

/**
 * Session-scoped discovery for a running MiniMax Code session. The probe cwd
 * is the session's own metadata, never an RPC argument, so this cannot be
 * pointed at an arbitrary directory.
 */
export function registerMcodeSessionModelHandlers(
    rpcHandlerManager: RpcHandlerManager,
    getCwd: () => string
): void {
    rpcHandlerManager.registerHandler<unknown, ListMcodeModelsResponse>(
        RPC_METHODS.ListMcodeModels,
        async () => {
            try {
                return await listMcodeModelsForCwd(getCwd())
            } catch (error) {
                logger.debug('Failed to list MiniMax Code models:', error)
                return rpcError(getErrorMessage(error, 'Failed to list MiniMax Code models'))
            }
        }
    )
}
