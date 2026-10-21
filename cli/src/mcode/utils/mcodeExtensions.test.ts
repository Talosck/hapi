import { describe, expect, it } from 'vitest';
import {
    MCODE_EXTENSION_CAPABILITY_META,
    MCODE_NOTIFICATION_DELEGATION_UPDATE,
    MCODE_NOTIFICATION_GOAL_UPDATE,
    goalLifecycleSignature,
    normalizeDelegationStatus,
    parseMcodeDelegationStopReceipt,
    parseMcodeDelegationUpdate,
    parseMcodeExtensionSupport,
    parseMcodeGoalState,
    parseMcodeGoalUpdate,
    toHapiThreadGoal,
    toMcodeExtensionCapabilities,
    toMcodeGoalPatchStatus,
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

describe('goalLifecycleSignature', () => {    it('changes with the objective, the status and the budget', () => {
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

describe('parseMcodeExtensionSupport', () => {
    it('reads the methods and notifications the agent advertised', () => {
        const support = parseMcodeExtensionSupport({
            'minimax-code/extensions': {
                version: 1,
                methods: ['mcode/session/goal/create', 'mcode/session/delegation/stop'],
                notifications: ['mcode/session/goal_update', 'mcode/session/delegation_update']
            }
        });

        expect(support.methods.has('mcode/session/goal/create')).toBe(true);
        expect(support.methods.has('mcode/session/delegation/stop')).toBe(true);
        expect(support.notifications.has('mcode/session/goal_update')).toBe(true);
        expect(support.notifications.has('mcode/session/delegation_update')).toBe(true);
    });

    it('advertises nothing when the agent published no extension block', () => {
        // An agent that feature-gates the goal extension publishes a block
        // without the goal methods — and an older agent publishes none at all.
        const support = parseMcodeExtensionSupport({});
        expect(support.methods.size).toBe(0);
        expect(support.notifications.size).toBe(0);
        expect(parseMcodeExtensionSupport(null).methods.size).toBe(0);
    });

    it('ignores a malformed method list', () => {
        const support = parseMcodeExtensionSupport({
            'minimax-code/extensions': { version: 1, methods: 'nope', notifications: [1, 'ok'] }
        });

        expect(support.methods.size).toBe(0);
        expect([...support.notifications]).toEqual(['ok']);
    });
});

describe('toMcodeExtensionCapabilities', () => {
    it('reports the goal features the agent advertised', () => {
        const capabilities = toMcodeExtensionCapabilities(parseMcodeExtensionSupport({
            'minimax-code/extensions': {
                version: 1,
                methods: [
                    'mcode/session/goal/get',
                    'mcode/session/goal/create',
                    'mcode/session/goal/patch',
                    'mcode/session/goal/clear',
                    'mcode/session/delegation/stop'
                ],
                notifications: ['mcode/session/goal_update', 'mcode/session/delegation_update']
            }
        }));

        expect(capabilities).toEqual({
            goal: true,
            goalCreate: true,
            goalPatch: true,
            goalClear: true,
            delegation: true,
            delegationStop: true
        });
    });

    it('reports no goal features when the agent disabled the goal extension', () => {
        // MiniMax Code removes every goal method and the goal notification
        // when the runtime disables goals — the web must not offer the
        // controls then.
        const capabilities = toMcodeExtensionCapabilities(parseMcodeExtensionSupport({
            'minimax-code/extensions': {
                version: 1,
                methods: ['mcode/session/delegation/stop'],
                notifications: ['mcode/session/delegation_update']
            }
        }));

        expect(capabilities.goal).toBe(false);
        expect(capabilities.goalCreate).toBe(false);
        expect(capabilities.goalPatch).toBe(false);
        expect(capabilities.goalClear).toBe(false);
        expect(capabilities.delegation).toBe(true);
        expect(capabilities.delegationStop).toBe(true);
    });
});

describe('parseMcodeGoalState', () => {
    it('parses a goal from a method response', () => {
        expect(parseMcodeGoalState(goal())).toEqual(goal());
    });

    it('rejects a goal without the required fields', () => {
        expect(parseMcodeGoalState({ goalId: 'goal-1' })).toBeNull();
        expect(parseMcodeGoalState(goal({ status: 'weird' as never }))).toBeNull();
    });
});

describe('toMcodeGoalPatchStatus', () => {
    it('maps HAPI status spellings onto the agent spellings', () => {
        expect(toMcodeGoalPatchStatus('active')).toBe('active');
        expect(toMcodeGoalPatchStatus('paused')).toBe('paused');
        expect(toMcodeGoalPatchStatus('blocked')).toBe('blocked');
        expect(toMcodeGoalPatchStatus('complete')).toBe('complete');
        expect(toMcodeGoalPatchStatus('budgetLimited')).toBe('budget_limited');
    });

    it('refuses a status the agent cannot be asked to enter', () => {
        // `usage_limited` is derived by the agent from its own counters.
        expect(toMcodeGoalPatchStatus('usageLimited')).toBeNull();
    });
});

describe('parseMcodeDelegationStopReceipt', () => {
    it('splits the stopped, active and failed sessions', () => {
        const receipt = parseMcodeDelegationStopReceipt({
            schemaVersion: 1,
            rootSessionId: 'session-1',
            rootStopped: true,
            stoppedSessionIds: ['child-1'],
            activeSessionIds: ['child-2'],
            failedSessionIds: []
        });

        expect(receipt).toEqual({
            schemaVersion: 1,
            rootSessionId: 'session-1',
            rootStopped: true,
            stoppedSessionIds: ['child-1'],
            activeSessionIds: ['child-2'],
            failedSessionIds: []
        });
    });

    it('rejects a receipt without a root session', () => {
        expect(parseMcodeDelegationStopReceipt({ schemaVersion: 1 })).toBeNull();
        expect(parseMcodeDelegationStopReceipt(null)).toBeNull();
    });
});
