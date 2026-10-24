import { describe, it, expect, beforeEach } from 'vitest'
import {
    _resetMcodeTokenPlanQuotaCacheForTests,
    listMcodeTokenPlanQuota
} from './mcodeTokenPlanQuota'
import { parseFiveHourQuota } from '@/minimax/planQuota'

const BROKER = { endpoint: '/tmp/mcode-auth-lease-v1.sock', capabilityFile: '/tmp/mcode-auth-lease-v1.cap' }

/** The answer the platform gives for an account with a five hour window. */
const PAYLOAD = {
    model_remains: [{
        model_name: 'general',
        start_time: 1792702800000,
        end_time: 1792720800000,
        current_interval_status: 1,
        current_interval_remaining_percent: 98,
        current_weekly_status: 3,
        current_weekly_remaining_percent: 100,
        weekly_end_time: 1792944000000
    }],
    base_resp: { status_code: 0, status_msg: 'success' }
}

describe('parseFiveHourQuota', () => {
    it('reads the five hour window', () => {
        expect(parseFiveHourQuota(PAYLOAD)).toEqual({
            remainingPercent: 98,
            resetAtMs: 1792720800000,
            unlimited: false
        })
    })

    it('computes the share when the platform only reports counts', () => {
        const quota = parseFiveHourQuota({
            model_remains: [{
                model_name: 'general',
                end_time: 1792720800000,
                current_interval_status: 1,
                current_interval_total_count: 200,
                current_interval_usage_count: 50
            }]
        })

        expect(quota?.remainingPercent).toBe(25)
    })

    it('has no quota when the platform says nothing', () => {
        expect(parseFiveHourQuota({ model_remains: [], base_resp: { status_code: 0 } })).toBeNull()
        expect(parseFiveHourQuota({ base_resp: { status_code: 1004 } })).toBeNull()
        expect(parseFiveHourQuota(null)).toBeNull()
    })
})

describe('listMcodeTokenPlanQuota', () => {
    beforeEach(() => {
        _resetMcodeTokenPlanQuotaCacheForTests()
    })

    it('reads the quota through a lease of a running host', async () => {
        const leases: string[] = []
        const result = await listMcodeTokenPlanQuota({
            brokers: [BROKER],
            region: 'cn',
            requestLease: async (broker) => {
                leases.push(broker.endpoint)
                return 'lease-token'
            },
            fetchQuota: async (_token, base) => {
                expect(base).toBe('https://www.minimaxi.com')
                return PAYLOAD
            }
        })

        expect(leases).toEqual([BROKER.endpoint])
        expect(result.quota).toEqual({
            remainingPercent: 98,
            resetAtMs: 1792720800000,
            unlimited: false
        })
        expect(result.error).toBeUndefined()
    })

    it('never lets the token out of the module', async () => {
        const result = await listMcodeTokenPlanQuota({
            brokers: [BROKER],
            region: 'cn',
            requestLease: async () => 'lease-token',
            fetchQuota: async () => PAYLOAD
        })

        // The token is spent on one request and dropped: it may not end up in
        // a result that travels to the hub and into the browser.
        expect(JSON.stringify(result)).not.toContain('lease-token')
    })

    it('reports why the quota could not be read instead of a made up zero', async () => {
        const result = await listMcodeTokenPlanQuota({
            brokers: [BROKER],
            region: 'cn',
            requestLease: async () => {
                throw new Error('The broker refused to hand out a lease')
            },
            fetchQuota: async () => PAYLOAD
        })

        expect(result.quota).toBeNull()
        expect(result.error).toContain('refused')
    })

    it('says so when no host is running on the machine', async () => {
        const result = await listMcodeTokenPlanQuota({ brokers: [], storedCredentials: [] })

        expect(result.quota).toBeNull()
        expect(result.error).toContain('No MiniMax Code host')
    })

    it('reads the window of the install when no host is running', async () => {
        // The install keeps the credential of the account it is logged into,
        // so the window is there on a machine where nothing of MiniMax Code
        // runs - a Pi session on a machine without a host still shows it.
        const asked: { token: string; base: string }[] = []
        const result = await listMcodeTokenPlanQuota({
            brokers: [],
            storedCredentials: [{ region: 'cn', accessToken: 'stored-token', expiresAtMs: 1792724400000 }],
            fetchQuota: async (token, base) => {
                asked.push({ token, base })
                return PAYLOAD
            }
        })

        expect(asked).toEqual([{ token: 'stored-token', base: 'https://www.minimaxi.com' }])
        expect(result.quota).toEqual({
            remainingPercent: 98,
            resetAtMs: 1792720800000,
            unlimited: false
        })
        // The credential of the account is spent on one request and dropped:
        // it may not end up in a result that travels to the hub and into the
        // browser.
        expect(JSON.stringify(result)).not.toContain('stored-token')
    })

    it('asks the region of the account it reads', async () => {
        const bases: string[] = []
        await listMcodeTokenPlanQuota({
            brokers: [],
            storedCredentials: [{ region: 'en', accessToken: 'stored-token', expiresAtMs: 1792724400000 }],
            fetchQuota: async (_token, base) => {
                bases.push(base)
                return PAYLOAD
            }
        })

        expect(bases).toEqual(['https://platform.minimax.io'])
    })

    it('prefers the running host over the credential of the install', async () => {
        // The host knows the account that is in use right now, and it keeps
        // the token fresh - so it is asked first.
        const asked: string[] = []
        await listMcodeTokenPlanQuota({
            brokers: [BROKER],
            region: 'cn',
            requestLease: async () => 'lease-token',
            storedCredentials: [{ region: 'cn', accessToken: 'stored-token', expiresAtMs: 1792724400000 }],
            fetchQuota: async (token) => {
                asked.push(token)
                return PAYLOAD
            }
        })

        expect(asked).toEqual(['lease-token'])
    })

    it('has no window when the account of the install has no valid token', async () => {
        const result = await listMcodeTokenPlanQuota({
            brokers: [],
            storedCredentials: [],
            fetchQuota: async () => PAYLOAD
        })

        expect(result.quota).toBeNull()
        expect(result.error).toContain('No MiniMax Code host')
    })

    it('caches the answer so a polling client does not ask again', async () => {
        let leases = 0
        const requestLease = async () => {
            leases++
            return 'lease-token'
        }
        const options = {
            brokers: [BROKER],
            region: 'cn',
            requestLease,
            fetchQuota: async () => PAYLOAD
        }

        await listMcodeTokenPlanQuota(options)
        await listMcodeTokenPlanQuota(options)

        expect(leases).toBe(1)
    })

    it('caches a failure too, so a polling client does not ask again', async () => {
        // A client that watches the usage polls the quota. When the read
        // fails - the host is gone, the lease is refused - every poll would
        // look for the host of the machine again, and the machine is the
        // expensive part of the read.
        let leases = 0
        const requestLease = async () => {
            leases++
            throw new Error('The broker refused to hand out a lease')
        }
        const options = {
            brokers: [BROKER],
            region: 'cn',
            requestLease,
            fetchQuota: async () => PAYLOAD
        }

        const first = await listMcodeTokenPlanQuota(options)
        const second = await listMcodeTokenPlanQuota(options)

        expect(first.quota).toBeNull()
        expect(first.error).toContain('refused')
        expect(second.error).toBe(first.error)
        expect(leases).toBe(1)
    })
})
