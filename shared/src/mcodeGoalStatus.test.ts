import { describe, expect, it } from 'bun:test'
import {
    HAPI_TO_MCODE_GOAL_STATUS,
    MCODE_GOAL_PATCHABLE_STATUSES,
    MCODE_GOAL_STATUS_MAP,
    toHapiGoalStatus,
    toMcodeGoalPatchStatus
} from './mcodeGoalStatus'

describe('mcode goal status', () => {
    it('maps the agent spelling onto HAPI spelling', () => {
        expect(toHapiGoalStatus('budget_limited')).toBe('budgetLimited')
        expect(toHapiGoalStatus('usage_limited')).toBe('usageLimited')
        expect(toHapiGoalStatus('active')).toBe('active')
        expect(toHapiGoalStatus('paused')).toBe('paused')
        expect(toHapiGoalStatus('blocked')).toBe('blocked')
        expect(toHapiGoalStatus('complete')).toBe('complete')
    })

    it('passes an unknown status through instead of dropping it', () => {
        expect(toHapiGoalStatus('something_new')).toBe('something_new')
        expect(toHapiGoalStatus('  budget_limited  ')).toBe('budgetLimited')
    })

    it('rejects a missing status', () => {
        expect(toHapiGoalStatus(null)).toBeNull()
        expect(toHapiGoalStatus(undefined)).toBeNull()
        expect(toHapiGoalStatus('  ')).toBeNull()
    })

    it('covers every status the agent reports', () => {
        expect(Object.keys(MCODE_GOAL_STATUS_MAP).sort()).toEqual([
            'active',
            'blocked',
            'budget_limited',
            'complete',
            'paused',
            'usage_limited',
        ])
    })
})

describe('mcode goal patch statuses', () => {
    it('maps HAPI status spellings onto the agent spellings', () => {
        expect(toMcodeGoalPatchStatus('active')).toBe('active')
        expect(toMcodeGoalPatchStatus('paused')).toBe('paused')
        expect(toMcodeGoalPatchStatus('blocked')).toBe('blocked')
        expect(toMcodeGoalPatchStatus('complete')).toBe('complete')
        expect(toMcodeGoalPatchStatus('budgetLimited')).toBe('budget_limited')
    })

    it('refuses a status a client may not set', () => {
        // `usage_limited` is derived by the agent from its own counters. The
        // agent would accept it in a patch; HAPI refuses to fabricate it.
        expect(toMcodeGoalPatchStatus('usageLimited')).toBeNull()
    })

    it('keeps the patchable set and the map in step', () => {
        expect(Object.keys(HAPI_TO_MCODE_GOAL_STATUS).sort()).toEqual([...MCODE_GOAL_PATCHABLE_STATUSES].sort())
    })
})
