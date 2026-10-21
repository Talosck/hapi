import { describe, expect, it } from 'vitest';
import {
    MCODE_EXTENSION_CAPABILITY_META,
    MCODE_NOTIFICATION_DELEGATION_UPDATE,
    MCODE_NOTIFICATION_GOAL_UPDATE,
    goalLifecycleSignature,
    normalizeDelegationStatus,
    parseMcodeDelegationUpdate,
    parseMcodeGoalUpdate,
    toHapiThreadGoal,
    toSubagentSnapshotMembers,
    type McodeGoal
} from './mcodeExtensions';

function goal(overrides: Partial<McodeGoal> = {}): McodeGoal {
    return {
        goalId: 'goal-1',
        sessionId: 'session-1',
        objective: 'Ship the feature',
        status: 'active',
        createdAt: 1_750_000_000_000,
        updatedAt: 1_750_000_060_000,
        tokensUsed: 1200,
        turnsUsed: 3,
        timeUsedSeconds: 42,
        tokenBudget: 10_000,
        hasKickoffAttachments: false,
        ...overrides
    };
}

describe('MCODE_EXTENSION_CAPABILITY_META', () => {
    it('advertises the extension notifications the agent gates on', () => {
        expect(MCODE_EXTENSION_CAPABILITY_META).toEqual({
            'minimax-code/extensions': { version: 1, notifications: true }
        });
    });

    it('names the two extension notifications', () => {
        expect(MCODE_NOTIFICATION_DELEGATION_UPDATE).toBe('mcode/session/delegation_update');
        expect(MCODE_NOTIFICATION_GOAL_UPDATE).toBe('mcode/session/goal_update');
    });
});

describe('normalizeDelegationStatus', () => {
    it.each([
        ['queued', 'queued'],
        ['pending', 'queued'],
        ['running', 'running'],
        ['in_progress', 'running'],
        ['in-progress', 'running'],
        ['succeeded', 'completed'],
        ['failed', 'failed'],
        ['cancelled', 'stopped'],
        ['stopped', 'stopped'],
        ['something-else', 'unknown'],
        [undefined, 'unknown']
    ])('normalizes %j to %j', (input, expected) => {
        expect(normalizeDelegationStatus(input)).toBe(expected);
    });
});

describe('parseMcodeDelegationUpdate', () => {
    it('parses a snapshot with its members', () => {
        const snapshot = parseMcodeDelegationUpdate({
            sessionId: 'session-1',
            snapshot: {
                schemaVersion: 1,
                rootSessionId: 'session-1',
                members: [
                    {
                        sessionId: 'child-1',
                        parentSessionId: 'session-1',
                        agentName: 'explore',
                        task: 'Explore the API',
                        status: 'running',
                        createdAtMs: 5,
                        updatedAtMs: 9
                    }
                ]
            }
        });

        expect(snapshot).toEqual({
            schemaVersion: 1,
            rootSessionId: 'session-1',
            members: [{
                sessionId: 'child-1',
                parentSessionId: 'session-1',
                agentName: 'explore',
                task: 'Explore the API',
                status: 'running',
                createdAtMs: 5,
                updatedAtMs: 9
            }]
        });
    });

    it('rejects a malformed snapshot', () => {
        expect(parseMcodeDelegationUpdate({ snapshot: { members: [] } })).toBeNull();
        expect(parseMcodeDelegationUpdate({ snapshot: { rootSessionId: 's', members: 'nope' } })).toBeNull();
        expect(parseMcodeDelegationUpdate(null)).toBeNull();
    });
});

describe('toSubagentSnapshotMembers', () => {
    it('maps the members and computes the nesting depth', () => {
        const members = toSubagentSnapshotMembers({
            schemaVersion: 1,
            rootSessionId: 'session-1',
            members: [
                { sessionId: 'child-1', parentSessionId: 'session-1', agentName: 'explore', task: 'Explore', status: 'running', createdAtMs: 5 },
                { sessionId: 'child-2', parentSessionId: 'child-1', agentName: 'nested', status: 'queued', createdAtMs: 6 }
            ]
        });

        expect(members).toEqual([
            {
                id: 'child-1',
                parentId: 'session-1',
                title: 'Explore',
                detail: 'explore',
                status: 'running',
                startedAt: 5,
                endedAt: null,
                depth: 0
            },
            {
                id: 'child-2',
                parentId: 'child-1',
                title: 'nested',
                detail: 'nested',
                status: 'queued',
                startedAt: 6,
                endedAt: null,
                depth: 1
            }
        ]);
    });

    it('marks a finished member with its end time', () => {
        const [member] = toSubagentSnapshotMembers({
            schemaVersion: 1,
            rootSessionId: 'session-1',
            members: [
                { sessionId: 'child-1', parentSessionId: 'session-1', status: 'completed', createdAtMs: 5, updatedAtMs: 9 }
            ]
        });

        expect(member.endedAt).toBe(9);
    });
});

describe('parseMcodeGoalUpdate', () => {
    it('parses a goal', () => {
        const update = parseMcodeGoalUpdate({ sessionId: 'session-1', goal: goal() });

        expect(update).toEqual({ kind: 'goal', goal: goal() });
    });

    it('parses a cleared goal', () => {
        expect(parseMcodeGoalUpdate({ sessionId: 'session-1', goal: null, goalId: 'goal-1' }))
            .toEqual({ kind: 'cleared', goalId: 'goal-1' });
    });

    it('rejects a goal without the required fields', () => {
        expect(parseMcodeGoalUpdate({ sessionId: 'session-1', goal: { goalId: 'goal-1' } })).toBeNull();
        expect(parseMcodeGoalUpdate({ sessionId: 'session-1', goal: goal({ status: 'weird' as never }) })).toBeNull();
    });

    it('rejects a payload without a goal field instead of clearing the goal', () => {
        // A payload this code does not understand must not erase the goal the
        // user is watching: only an explicit `goal: null` clears it.
        expect(parseMcodeGoalUpdate({ sessionId: 'session-1' })).toBeNull();
    });

    it('accepts the hyphenated status spelling', () => {
        const update = parseMcodeGoalUpdate({
            sessionId: 'session-1',
            goal: goal({ status: 'budget-limited' as never })
        });
        expect(update).toMatchObject({ kind: 'goal', goal: { status: 'budget_limited' } });
    });
});

describe('toHapiThreadGoal', () => {
    it('converts the millisecond timestamps into seconds', () => {
        const converted = toHapiThreadGoal(goal(), 'session-1');

        expect(converted).toEqual({
            threadId: 'session-1',
            objective: 'Ship the feature',
            status: 'active',
            tokenBudget: 10_000,
            tokensUsed: 1200,
            timeUsedSeconds: 42,
            createdAt: 1_750_000_000,
            updatedAt: 1_750_000_060
        });
    });

    it('maps the budget-limited status onto HAPI spelling', () => {
        expect(toHapiThreadGoal(goal({ status: 'budget_limited' }), 'session-1').status).toBe('budgetLimited');
        expect(toHapiThreadGoal(goal({ status: 'usage_limited' }), 'session-1').status).toBe('usageLimited');
    });

    it('leaves an unlimited budget undefined', () => {
        expect(toHapiThreadGoal(goal({ tokenBudget: null }), 'session-1').tokenBudget).toBeUndefined();
    });
});

describe('goalLifecycleSignature', () => {
    it('changes with the objective, the status and the budget', () => {
        const base = toHapiThreadGoal(goal(), 'session-1');

        expect(goalLifecycleSignature(base)).toBe(goalLifecycleSignature({ ...base }));
        expect(goalLifecycleSignature({ ...base, status: 'complete' })).not.toBe(goalLifecycleSignature(base));
        expect(goalLifecycleSignature({ ...base, objective: 'Other' })).not.toBe(goalLifecycleSignature(base));
        expect(goalLifecycleSignature({ ...base, tokenBudget: 1 })).not.toBe(goalLifecycleSignature(base));
    });

    it('changes with the goal id', () => {
        const base = toHapiThreadGoal(goal(), 'session-1');

        // Two goals with the same objective, status and budget are still two
        // goals: the second one has to be announced in the chat.
        expect(goalLifecycleSignature(base, 'goal-1')).not.toBe(goalLifecycleSignature(base, 'goal-2'));
        expect(goalLifecycleSignature(base, 'goal-1')).toBe(goalLifecycleSignature(base, 'goal-1'));
    });
});
