import { describe, expect, it } from 'bun:test'
import { MCODE_GOAL_STATUS_MAP, toHapiGoalStatus } from './mcodeGoalStatus'

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
