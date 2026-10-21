import type {
    McodeDelegationStopResponse,
    McodeExtensionCapabilities,
    McodeGoalClearResponse,
    McodeGoalResponse
} from '@hapi/protocol';
import {
    MCODE_METHOD_DELEGATION_GET,
    MCODE_METHOD_DELEGATION_STOP,
    MCODE_METHOD_GOAL_CLEAR,
    MCODE_METHOD_GOAL_CREATE,
    MCODE_METHOD_GOAL_GET,
    MCODE_METHOD_GOAL_PATCH,
    parseMcodeDelegationStopReceipt,
    parseMcodeDelegationUpdate,
    parseMcodeGoalState,
    toMcodeExtensionCapabilities,
    type McodeDelegationSnapshot,
    type McodeExtensionSupport
} from './mcodeExtensions';

/**
 * The backend surface the control needs. `AcpSdkBackend` implements it; the
 * tests use a stub.
 */
export type McodeExtensionBackend = {
    sendExtensionRequest<T = unknown>(
        method: string,
        params: Record<string, unknown>,
        options?: { timeoutMs?: number }
    ): Promise<T>;
};

export type McodeGoalPatch = {
    status?: string;
    objective?: string;
    tokenBudget?: number | null;
};

/**
 * Drives MiniMax Code's ACP extension methods.
 *
 * Every call is gated on the extension surface the agent advertised in its
 * `initialize` response: the agent feature-gates its goal extension at
 * runtime, so a method that is not advertised must not be called. Calling one
 * anyway would fail with an opaque JSON-RPC error instead of the clear
 * "not supported" answer the web renders.
 */
export class McodeExtensionControl {
    private readonly support: McodeExtensionSupport;
    private readonly capabilities: McodeExtensionCapabilities;

    constructor(
        private readonly backend: McodeExtensionBackend,
        support: McodeExtensionSupport
    ) {
        this.support = support;
        this.capabilities = toMcodeExtensionCapabilities(support);
    }

    /** The capability flags the web renders against. */
    getCapabilities(): McodeExtensionCapabilities {
        return this.capabilities;
    }

    supportsMethod(method: string): boolean {
        return this.support.methods.has(method);
    }

    supportsNotification(notification: string): boolean {
        return this.support.notifications.has(notification);
    }

    /**
     * Reads the session's current goal.
     *
     * The goal notification is a one-way push: after a CLI restart the web
     * knows a goal exists only if something asks the agent. This is the
     * recovery path.
     */
    async getGoal(sessionId: string): Promise<McodeGoalResponse> {
        if (!this.supportsMethod(MCODE_METHOD_GOAL_GET)) {
            return { success: false, error: 'MiniMax Code did not advertise the goal extension' };
        }
        try {
            const response = await this.backend.sendExtensionRequest<unknown>(
                MCODE_METHOD_GOAL_GET,
                { sessionId }
            );
            const goal = parseGoalEnvelope(response);
            return { success: true, goal };
        } catch (error) {
            return { success: false, error: errorMessage(error, 'Failed to read the MiniMax Code goal') };
        }
    }

    /**
     * Creates the session's autonomous goal.
     *
     * The agent starts executing the objective as soon as the goal exists —
     * creating a goal is not a request the agent reviews later.
     */
    async createGoal(
        sessionId: string,
        objective: string,
        tokenBudget?: number | null
    ): Promise<McodeGoalResponse> {
        if (!this.supportsMethod(MCODE_METHOD_GOAL_CREATE)) {
            return { success: false, error: 'MiniMax Code did not advertise the goal extension' };
        }
        const trimmed = objective.trim();
        if (!trimmed) {
            return { success: false, error: 'A goal needs an objective' };
        }
        try {
            const response = await this.backend.sendExtensionRequest<unknown>(
                MCODE_METHOD_GOAL_CREATE,
                {
                    sessionId,
                    objective: trimmed,
                    ...(tokenBudget === undefined || tokenBudget === null
                        ? {}
                        : { tokenBudget })
                }
            );
            const goal = parseGoalEnvelope(response);
            return goal
                ? { success: true, goal }
                : { success: false, error: 'MiniMax Code returned an unreadable goal' };
        } catch (error) {
            return { success: false, error: errorMessage(error, 'Failed to create the MiniMax Code goal') };
        }
    }

    /** Patches the goal's objective, status or token budget. */
    async patchGoal(sessionId: string, patch: McodeGoalPatch): Promise<McodeGoalResponse> {
        if (!this.supportsMethod(MCODE_METHOD_GOAL_PATCH)) {
            return { success: false, error: 'MiniMax Code did not advertise the goal extension' };
        }
        const params: Record<string, unknown> = { sessionId };
        if (patch.status !== undefined) params.status = patch.status;
        if (patch.objective !== undefined) params.objective = patch.objective;
        if (patch.tokenBudget !== undefined) params.tokenBudget = patch.tokenBudget;

        try {
            const response = await this.backend.sendExtensionRequest<unknown>(
                MCODE_METHOD_GOAL_PATCH,
                params
            );
            const goal = parseGoalEnvelope(response);
            return goal
                ? { success: true, goal }
                : { success: false, error: 'MiniMax Code returned an unreadable goal' };
        } catch (error) {
            return { success: false, error: errorMessage(error, 'Failed to update the MiniMax Code goal') };
        }
    }

    /** Clears the session's goal. */
    async clearGoal(sessionId: string): Promise<McodeGoalClearResponse> {
        if (!this.supportsMethod(MCODE_METHOD_GOAL_CLEAR)) {
            return { success: false, error: 'MiniMax Code did not advertise the goal extension' };
        }
        try {
            const response = await this.backend.sendExtensionRequest<unknown>(
                MCODE_METHOD_GOAL_CLEAR,
                { sessionId }
            );
            const cleared = readBoolean(response, 'cleared');
            return { success: true, cleared };
        } catch (error) {
            return { success: false, error: errorMessage(error, 'Failed to clear the MiniMax Code goal') };
        }
    }

    /**
     * Reads the session's delegation tree.
     *
     * Like the goal, the delegation tree is a one-way push: after a CLI
     * restart the web would show no subagents even though the agent is still
     * running them.
     */
    async getDelegationSnapshot(sessionId: string): Promise<McodeDelegationSnapshot | null> {
        if (!this.supportsMethod(MCODE_METHOD_DELEGATION_GET)) {
            return null;
        }
        try {
            const response = await this.backend.sendExtensionRequest<unknown>(
                MCODE_METHOD_DELEGATION_GET,
                { sessionId }
            );
            return parseMcodeDelegationUpdate({ snapshot: readRecord(response, 'snapshot') });
        } catch (error) {
            return null;
        }
    }

    /** Stops the session's delegated sessions (its subagents). */
    async stopDelegation(sessionId: string): Promise<McodeDelegationStopResponse> {        if (!this.supportsMethod(MCODE_METHOD_DELEGATION_STOP)) {
            return { success: false, error: 'MiniMax Code did not advertise the delegation extension' };
        }
        try {
            const response = await this.backend.sendExtensionRequest<unknown>(
                MCODE_METHOD_DELEGATION_STOP,
                { sessionId }
            );
            const receipt = parseMcodeDelegationStopReceipt(
                readRecord(response, 'receipt') ?? response
            );
            return receipt
                ? { success: true, receipt }
                : { success: false, error: 'MiniMax Code returned an unreadable delegation receipt' };
        } catch (error) {
            return {
                success: false,
                error: errorMessage(error, 'Failed to stop the MiniMax Code subagents')
            };
        }
    }
}

/**
 * Extracts the goal from a `{ goal }` envelope.
 *
 * `goal/get` answers with `goal: null` when the session has no goal — that
 * is a successful answer, not an error.
 */
function parseGoalEnvelope(response: unknown) {
    const envelope = readRecord(response, 'goal');
    if (!envelope) return null;
    return parseMcodeGoalState(envelope);
}

function readRecord(value: unknown, key: string): Record<string, unknown> | null | undefined {
    if (typeof value !== 'object' || value === null) return undefined;
    const entry = (value as Record<string, unknown>)[key];
    if (entry === null) return null;
    if (typeof entry !== 'object' || Array.isArray(entry)) return undefined;
    return entry as Record<string, unknown>;
}

function readBoolean(value: unknown, key: string): boolean {
    if (typeof value !== 'object' || value === null) return false;
    return (value as Record<string, unknown>)[key] === true;
}

function errorMessage(error: unknown, fallback: string): string {
    if (error instanceof Error && error.message) return error.message;
    return fallback;
}
