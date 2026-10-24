import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'

const { listMcodeTokenPlanQuotaMock, listPiTokenPlanQuotaMock } = vi.hoisted(() => ({
    listMcodeTokenPlanQuotaMock: vi.fn(),
    listPiTokenPlanQuotaMock: vi.fn()
}))

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() }
}))
vi.mock('@/mcode/utils/mcodeTokenPlanQuota', () => ({
    listMcodeTokenPlanQuota: listMcodeTokenPlanQuotaMock
}))
vi.mock('@/pi/piTokenPlanQuota', () => ({
    listPiTokenPlanQuota: listPiTokenPlanQuotaMock
}))

import { registerMinimaxQuotaHandler } from './minimaxQuota'

const WINDOW = { remainingPercent: 42, resetAtMs: 1792720800000, unlimited: false }

function registerHandler(): (params: unknown) => Promise<unknown> {
    const handlers = new Map<string, (params: unknown) => Promise<unknown>>()
    const rpcHandlerManager = {
        registerHandler: (method: string, handler: (params: unknown) => Promise<unknown>) => {
            handlers.set(method, handler)
        }
    } as unknown as RpcHandlerManager

    registerMinimaxQuotaHandler(rpcHandlerManager)
    const handler = handlers.get(RPC_METHODS.ListMinimaxQuota)
    if (!handler) {
        throw new Error(`the handler ${RPC_METHODS.ListMinimaxQuota} was not registered`)
    }
    return handler
}

beforeEach(() => {
    listMcodeTokenPlanQuotaMock.mockReset()
    listPiTokenPlanQuotaMock.mockReset()
})

describe('the MiniMax usage handler', () => {
    it('reads the account of the MiniMax Code install', async () => {
        listMcodeTokenPlanQuotaMock.mockResolvedValue({ quota: WINDOW })
        const handler = registerHandler()

        const response = await handler({ source: 'mcode' }) as { success: boolean; quota: typeof WINDOW }

        expect(response).toEqual({ success: true, quota: WINDOW })
        expect(listMcodeTokenPlanQuotaMock).toHaveBeenCalled()
        expect(listPiTokenPlanQuotaMock).not.toHaveBeenCalled()
    })

    it('reads the account of the Pi install for a Pi session', async () => {
        // A Pi session reads the account of Pi: the MiniMax Code install is
        // not asked at all.
        listPiTokenPlanQuotaMock.mockResolvedValue({ quota: WINDOW })
        const handler = registerHandler()

        const response = await handler({ source: 'pi' }) as { success: boolean; quota: typeof WINDOW }

        expect(response).toEqual({ success: true, quota: WINDOW })
        expect(listPiTokenPlanQuotaMock).toHaveBeenCalled()
        expect(listMcodeTokenPlanQuotaMock).not.toHaveBeenCalled()
    })

    it('answers without a window when the account has none', async () => {
        // A window that could not be read is a missing window, not a made up
        // zero: the client shows nothing rather than a share the account
        // never reported.
        listPiTokenPlanQuotaMock.mockResolvedValue({
            quota: null,
            error: 'Pi has no MiniMax account to read the usage from'
        })
        const handler = registerHandler()

        const response = await handler({ source: 'pi' }) as { success: boolean; quota: unknown }

        expect(response).toEqual({ success: true, quota: null })
    })
})
