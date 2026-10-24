import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
    _resetPiTokenPlanQuotaCacheForTests,
    listPiTokenPlanQuota
} from './piTokenPlanQuota'

/** The answer the platform gives for an account with a five hour window. */
const PAYLOAD = {
    model_remains: [{
        model_name: 'general',
        start_time: 1792702800000,
        end_time: 1792720800000,
        current_interval_status: 1,
        current_interval_remaining_percent: 98,
        current_weekly_status: 3,
        current_weekly_remaining_percent: 100
    }],
    base_resp: { status_code: 0, status_msg: 'success' }
}

describe('listPiTokenPlanQuota', () => {
    beforeEach(() => {
        _resetPiTokenPlanQuotaCacheForTests()
    })

    it('reads the window with the account of the Pi install', async () => {
        // Pi hands out the key of its own account, so a Pi session needs
        // nothing of MiniMax Code.
        const asked: { provider: string; base: string }[] = []
        const result = await listPiTokenPlanQuota({
            readKey: async (provider) => {
                asked.push({ provider, base: '' })
                return provider === 'minimax-cn' ? 'pi-key' : null
            },
            fetchQuota: async (token, base) => {
                expect(token).toBe('pi-key')
                asked[asked.length - 1].base = base
                return PAYLOAD
            }
        })

        expect(result.quota).toEqual({
            remainingPercent: 98,
            resetAtMs: 1792720800000,
            unlimited: false
        })
        expect(result.error).toBeUndefined()
        expect(asked[0].provider).toBe('minimax-cn')
        expect(asked[0].base).toBe('https://www.minimaxi.com')
    })

    it('never lets the key out of the module', async () => {
        const result = await listPiTokenPlanQuota({
            readKey: async () => 'pi-key',
            fetchQuota: async () => PAYLOAD
        })

        // The key is spent on one request and dropped: it may not end up in
        // a result that travels to the hub and into the browser.
        expect(JSON.stringify(result)).not.toContain('pi-key')
    })

    it('tries the other region when the first account refuses', async () => {
        const providers: string[] = []
        const result = await listPiTokenPlanQuota({
            readKey: async (provider) => {
                providers.push(provider)
                return provider === 'minimax' ? 'intl-key' : 'cn-key'
            },
            fetchQuota: async (_token, base) => {
                if (base === 'https://www.minimaxi.com') {
                    throw new Error('The account reported no usage quota')
                }
                return PAYLOAD
            }
        })

        expect(providers).toEqual(['minimax-cn', 'minimax'])
        expect(result.quota?.remainingPercent).toBe(98)
    })

    it('has no window when Pi has no MiniMax account', async () => {
        const result = await listPiTokenPlanQuota({
            readKey: async () => null,
            fetchQuota: async () => PAYLOAD
        })

        expect(result.quota).toBeNull()
        expect(result.error).toContain('Pi has no MiniMax account')
    })

    it('caches the answer so a polling client does not ask again', async () => {
        let reads = 0
        const options = {
            readKey: async () => {
                reads++
                return 'pi-key'
            },
            fetchQuota: async () => PAYLOAD
        }

        await listPiTokenPlanQuota(options)
        await listPiTokenPlanQuota(options)

        expect(reads).toBe(1)
    })

    it('caches a failure too, so a polling client does not ask again', async () => {
        // A client that watches the usage polls the quota. When the read
        // fails, every poll would ask Pi for its key again - so the failure
        // is remembered for a moment.
        let reads = 0
        const options = {
            readKey: async () => {
                reads++
                return null
            },
            fetchQuota: async () => PAYLOAD
        }

        const first = await listPiTokenPlanQuota(options)
        const second = await listPiTokenPlanQuota(options)

        expect(first.quota).toBeNull()
        expect(second.error).toBe(first.error)
        // One read per provider of the region, and only once for the two.
        expect(reads).toBe(2)
    })
})
