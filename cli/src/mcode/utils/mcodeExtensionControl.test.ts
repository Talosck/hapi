import { describe, expect, it, vi } from 'vitest';
import { McodeExtensionControl } from './mcodeExtensionControl';
import { parseMcodeExtensionSupport } from './mcodeExtensions';

const FULL_SURFACE = {
    'minimax-code/extensions': {
        version: 1,
        methods: [
            'mcode/session/goal/get',
            'mcode/session/goal/create',
            'mcode/session/goal/patch',
            'mcode/session/goal/clear',
            'mcode/session/delegation/get',
            'mcode/session/delegation/stop'
        ],
        notifications: ['mcode/session/goal_update', 'mcode/session/delegation_update']
    }
};

const GOAL = {
    goalId: 'goal-1',
    sessionId: 'session-1',
    objective: 'Ship the feature',
    status: 'active',
    createdAt: 1_750_000_000_000,
    updatedAt: 1_750_000_060_000,
    tokensUsed: 1200,
    turnsUsed: 3,
    timeUsedSeconds: 42,
    tokenBudget: 10_000
};

function control(surface: unknown = FULL_SURFACE) {
    const sendExtensionRequest = vi.fn(async (method: string) => {
        if (method === 'mcode/session/goal/get') return { goal: GOAL };
        if (method === 'mcode/session/goal/create') return { goal: GOAL };
        if (method === 'mcode/session/goal/patch') return { goal: { ...GOAL, status: 'paused' } };
        if (method === 'mcode/session/goal/clear') return { cleared: true };
        if (method === 'mcode/session/delegation/stop') {
            return {
                receipt: {
                    schemaVersion: 1,
                    rootSessionId: 'session-1',
                    rootStopped: true,
                    stoppedSessionIds: ['child-1'],
                    activeSessionIds: [],
                    failedSessionIds: []
                }
            };
        }
        throw new Error(`unexpected method ${method}`);
    });
    const backend = { sendExtensionRequest } as unknown as ConstructorParameters<typeof McodeExtensionControl>[0];
    return {
        backend,
        sendExtensionRequest,
        instance: new McodeExtensionControl(backend, parseMcodeExtensionSupport(surface))
    };
}

describe('McodeExtensionControl', () => {
    it('projects the advertised surface onto the capability flags', () => {
        expect(control().instance.getCapabilities()).toEqual({
            goal: true,
            goalCreate: true,
            goalPatch: true,
            goalClear: true,
            delegation: true,
            delegationStop: true,
            // The advertised surface has no steer method.
            steer: false
        });
    });

    it('creates a goal with the objective and the budget', async () => {
        const harness = control();

        const response = await harness.instance.createGoal('session-1', '  Ship it  ', 5_000);

        expect(harness.sendExtensionRequest).toHaveBeenCalledWith(
            'mcode/session/goal/create',
            { sessionId: 'session-1', objective: 'Ship it', tokenBudget: 5_000 }
        );
        expect(response).toEqual({ success: true, goal: expect.objectContaining({ goalId: 'goal-1' }) });
    });

    it('creates a goal without a budget', async () => {
        const harness = control();

        await harness.instance.createGoal('session-1', 'Ship it');

        expect(harness.sendExtensionRequest).toHaveBeenCalledWith(
            'mcode/session/goal/create',
            { sessionId: 'session-1', objective: 'Ship it' }
        );
    });

    it('rejects a goal without an objective before calling the agent', async () => {
        const harness = control();

        const response = await harness.instance.createGoal('session-1', '   ');

        expect(response.success).toBe(false);
        expect(harness.sendExtensionRequest).not.toHaveBeenCalled();
    });

    it('patches a goal', async () => {
        const harness = control();

        const response = await harness.instance.patchGoal('session-1', { status: 'paused' });

        expect(harness.sendExtensionRequest).toHaveBeenCalledWith(
            'mcode/session/goal/patch',
            { sessionId: 'session-1', status: 'paused' }
        );
        expect(response).toEqual({ success: true, goal: expect.objectContaining({ status: 'paused' }) });
    });

    it('clears a goal', async () => {
        const harness = control();

        expect(await harness.instance.clearGoal('session-1')).toEqual({ success: true, cleared: true });
    });

    it('reads the goal of a resumed session', async () => {
        const harness = control();

        expect(await harness.instance.getGoal('session-1')).toEqual({
            success: true,
            goal: expect.objectContaining({ goalId: 'goal-1' })
        });
    });

    it('reports a session without a goal as an answer, not an error', async () => {
        const harness = control();
        harness.sendExtensionRequest.mockResolvedValueOnce({ goal: null } as never);

        expect(await harness.instance.getGoal('session-1')).toEqual({ success: true, goal: null });
    });

    it('reads the delegation tree of a resumed session', async () => {
        const harness = control();
        harness.sendExtensionRequest.mockResolvedValueOnce({
            snapshot: {
                schemaVersion: 1,
                rootSessionId: 'session-1',
                members: [{
                    sessionId: 'child-1',
                    parentSessionId: 'session-1',
                    status: 'running'
                }]
            }
        } as never);

        const snapshot = await harness.instance.getDelegationSnapshot('session-1');

        expect(snapshot?.members).toHaveLength(1);
        expect(snapshot?.members[0]?.sessionId).toBe('child-1');
    });

    it('reports no delegation tree when the agent does not advertise it', async () => {
        const harness = control({
            'minimax-code/extensions': {
                version: 1,
                methods: ['mcode/session/goal/create'],
                notifications: []
            }
        });

        expect(await harness.instance.getDelegationSnapshot('session-1')).toBeNull();
        expect(harness.sendExtensionRequest).not.toHaveBeenCalled();
    });

    it('stops the delegation tree', async () => {        const harness = control();

        const response = await harness.instance.stopDelegation('session-1');

        expect(response).toEqual({
            success: true,
            receipt: expect.objectContaining({ rootStopped: true, stoppedSessionIds: ['child-1'] })
        });
    });

    it('never calls a method the agent did not advertise', async () => {
        // The agent feature-gates its goal extension: with the extension off
        // the goal methods do not exist and calling them would fail with an
        // opaque JSON-RPC error.
        const harness = control({
            'minimax-code/extensions': {
                version: 1,
                methods: ['mcode/session/delegation/stop'],
                notifications: ['mcode/session/delegation_update']
            }
        });

        expect((await harness.instance.createGoal('session-1', 'Ship it')).success).toBe(false);
        expect((await harness.instance.patchGoal('session-1', { status: 'paused' })).success).toBe(false);
        expect((await harness.instance.clearGoal('session-1')).success).toBe(false);
        expect((await harness.instance.getGoal('session-1')).success).toBe(false);
        expect(harness.sendExtensionRequest).not.toHaveBeenCalled();
    });

    it('turns an agent failure into a readable error', async () => {
        const harness = control();
        harness.sendExtensionRequest.mockRejectedValueOnce(new Error('Goal not found for session: session-1'));

        const response = await harness.instance.createGoal('session-1', 'Ship it');

        expect(response).toEqual({
            success: false,
            error: 'Goal not found for session: session-1'
        });
    });
});
