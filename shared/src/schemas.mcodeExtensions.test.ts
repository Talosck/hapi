import { describe, expect, it } from 'vitest'
import { MetadataSchema } from './schemas'
import {
    McodeGoalCreateRequestSchema,
    McodeGoalPatchRequestSchema
} from './apiTypes'

describe('MetadataSchema mcode extension capabilities', () => {
    it('accepts the advertised extension surface', () => {
        const result = MetadataSchema.safeParse({
            path: '/tmp/work',
            host: 'localhost',
            capabilities: {
                terminal: true,
                mcodeExtensions: {
                    goal: true,
                    goalCreate: true,
                    goalPatch: true,
                    goalClear: true,
                    delegation: true,
                    delegationStop: true
                }
            }
        })

        expect(result.success).toBe(true)
        expect(result.data?.capabilities?.mcodeExtensions?.goalCreate).toBe(true)
    })

    it('keeps a session without the extension surface valid', () => {
        const result = MetadataSchema.safeParse({
            path: '/tmp/work',
            host: 'localhost',
            capabilities: { terminal: true }
        })

        expect(result.success).toBe(true)
        expect(result.data?.capabilities?.mcodeExtensions).toBeUndefined()
    })
})

describe('McodeGoalCreateRequestSchema', () => {
    it('requires an objective', () => {
        expect(McodeGoalCreateRequestSchema.safeParse({ objective: 'Ship it' }).success).toBe(true)
        expect(McodeGoalCreateRequestSchema.safeParse({ objective: '' }).success).toBe(false)
        expect(McodeGoalCreateRequestSchema.safeParse({}).success).toBe(false)
    })

    it('accepts an unlimited or a positive budget', () => {
        expect(McodeGoalCreateRequestSchema.safeParse({ objective: 'Ship it', tokenBudget: null }).success).toBe(true)
        expect(McodeGoalCreateRequestSchema.safeParse({ objective: 'Ship it', tokenBudget: 5_000 }).success).toBe(true)
        expect(McodeGoalCreateRequestSchema.safeParse({ objective: 'Ship it', tokenBudget: 0 }).success).toBe(false)
        expect(McodeGoalCreateRequestSchema.safeParse({ objective: 'Ship it', tokenBudget: -1 }).success).toBe(false)
    })
})

describe('McodeGoalPatchRequestSchema', () => {
    it('accepts HAPI goal status spellings', () => {
        expect(McodeGoalPatchRequestSchema.safeParse({ status: 'budgetLimited' }).success).toBe(true)
        expect(McodeGoalPatchRequestSchema.safeParse({ status: 'active' }).success).toBe(true)
        expect(McodeGoalPatchRequestSchema.safeParse({ status: 'budget_limited' }).success).toBe(false)
    })

    it('rejects a status a client may not set', () => {
        // `usageLimited` is a runtime-derived state - the agent computes it
        // from its own usage counters. HAPI refuses to let a client claim it,
        // so accepting it here would turn a 400 into a 200 with
        // success:false.
        expect(McodeGoalPatchRequestSchema.safeParse({ status: 'usageLimited' }).success).toBe(false)
    })

    it('rejects an update with nothing to change', () => {
        expect(McodeGoalPatchRequestSchema.safeParse({}).success).toBe(false)
    })

    it('accepts a single field on its own', () => {
        expect(McodeGoalPatchRequestSchema.safeParse({ objective: 'Ship it' }).success).toBe(true)
        expect(McodeGoalPatchRequestSchema.safeParse({ tokenBudget: null }).success).toBe(true)
        expect(McodeGoalPatchRequestSchema.safeParse({ tokenBudget: 5_000 }).success).toBe(true)
    })
})
