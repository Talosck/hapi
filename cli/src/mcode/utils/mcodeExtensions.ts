import type { SubagentSnapshotMember, ThreadGoal } from '@hapi/protocol';

/**
 * MiniMax Code's ACP extensions.
 *
 * The agent publishes two extension notifications, both gated on the
 * `minimax-code/extensions` client capability:
 *
 * - `mcode/session/delegation_update`: the live tree of delegated sessions
 *   (its subagents). MiniMax Code does not stream the subagents' own tool
 *   calls, so this tree is the only view of them.
 * - `mcode/session/goal_update`: the goal of an autonomous run.
 */
export const MCODE_EXTENSION_CAPABILITY_META = {
    'minimax-code/extensions': { version: 1, notifications: true }
} as const;

export const MCODE_NOTIFICATION_DELEGATION_UPDATE = 'mcode/session/delegation_update';
export const MCODE_NOTIFICATION_GOAL_UPDATE = 'mcode/session/goal_update';

/** Lifecycle state of a delegated session, normalized to HAPI's vocabulary. */
export type McodeDelegationStatus =
    | 'queued'
    | 'running'
    | 'completed'
    | 'failed'
    | 'stopped'
    | 'unknown';

export type McodeDelegationMember = {
    sessionId: string;
    parentSessionId: string;
    agentName?: string;
    task?: string;
    status: McodeDelegationStatus;
    backgroundTaskId?: string;
    /** Epoch milliseconds. */
    createdAtMs?: number;
    /** Epoch milliseconds. */
    updatedAtMs?: number;
    errorMessage?: string;
};

export type McodeDelegationSnapshot = {
    schemaVersion: number;
    rootSessionId: string;
    members: McodeDelegationMember[];
};

export type McodeGoalStatus =
    | 'active'
    | 'paused'
    | 'blocked'
    | 'complete'
    | 'budget_limited'
    | 'usage_limited';

export type McodeGoal = {
    goalId: string;
    sessionId: string;
    objective: string;
    status: McodeGoalStatus;
    /** Epoch milliseconds. */
    createdAt: number;
    /** Epoch milliseconds. */
    updatedAt: number;
    tokensUsed: number;
    turnsUsed: number;
    timeUsedSeconds: number;
    tokenBudget: number | null;
    statusReason?: string;
    hasKickoffAttachments: boolean;
};

export type McodeGoalUpdate =
    | { kind: 'goal'; goal: McodeGoal }
    | { kind: 'cleared'; goalId: string | null };

/** Delegation members that already reached a final state. */
const TERMINAL_DELEGATION_STATUSES = new Set<McodeDelegationStatus>([
    'completed',
    'failed',
    'stopped'
]);

const GOAL_STATUS_MAP: Record<McodeGoalStatus, ThreadGoal['status']> = {
    active: 'active',
    paused: 'paused',
    blocked: 'blocked',
    complete: 'complete',
    budget_limited: 'budgetLimited',
    usage_limited: 'usageLimited'
};

function readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalizes the many status spellings MiniMax Code uses for a delegated
 * session into the six states HAPI renders.
 */
export function normalizeDelegationStatus(value: unknown): McodeDelegationStatus {
    const raw = readString(value)?.trim().toLowerCase().replaceAll('-', '_');
    if (!raw) return 'unknown';
    if (raw === 'queued' || raw === 'pending' || raw === 'created') return 'queued';
    if (raw === 'running' || raw === 'started' || raw === 'active' || raw === 'busy'
        || raw === 'processing' || raw === 'in_progress') {
        return 'running';
    }
    if (raw === 'finished' || raw === 'completed' || raw === 'succeeded' || raw === 'success'
        || raw === 'idle') {
        return 'completed';
    }
    if (raw === 'error' || raw === 'failed' || raw === 'lost') return 'failed';
    if (raw === 'aborted' || raw === 'interrupted' || raw === 'cancelled' || raw === 'canceled'
        || raw === 'stopped') {
        return 'stopped';
    }
    return 'unknown';
}

function normalizeGoalStatus(value: unknown): McodeGoalStatus | null {
    const raw = readString(value)?.trim().toLowerCase().replaceAll('-', '_');
    if (!raw) return null;
    if (raw === 'active' || raw === 'paused' || raw === 'blocked' || raw === 'complete'
        || raw === 'budget_limited' || raw === 'usage_limited') {
        return raw;
    }
    return null;
}

function parseDelegationMember(value: unknown): McodeDelegationMember | null {
    if (!isObject(value)) return null;
    const sessionId = readString(value.sessionId);
    if (!sessionId) return null;
    const member: McodeDelegationMember = {
        sessionId,
        parentSessionId: readString(value.parentSessionId) ?? '',
        status: normalizeDelegationStatus(value.status)
    };
    const agentName = readString(value.agentName);
    if (agentName) member.agentName = agentName;
    const task = readString(value.task);
    if (task) member.task = task;
    const backgroundTaskId = readString(value.backgroundTaskId);
    if (backgroundTaskId) member.backgroundTaskId = backgroundTaskId;
    const createdAtMs = readNumber(value.createdAtMs);
    if (createdAtMs !== undefined) member.createdAtMs = createdAtMs;
    const updatedAtMs = readNumber(value.updatedAtMs);
    if (updatedAtMs !== undefined) member.updatedAtMs = updatedAtMs;
    const errorMessage = readString(value.errorMessage);
    if (errorMessage) member.errorMessage = errorMessage;
    return member;
}

/**
 * Parses a `mcode/session/delegation_update` payload.
 *
 * Returns null for a malformed payload: the agent may extend the shape over
 * time, and a snapshot that cannot be understood is better dropped than
 * rendered as a broken tree.
 */
export function parseMcodeDelegationUpdate(params: unknown): McodeDelegationSnapshot | null {
    if (!isObject(params)) return null;
    const snapshot = params.snapshot;
    if (!isObject(snapshot)) return null;
    if (!Array.isArray(snapshot.members)) return null;
    const rootSessionId = readString(snapshot.rootSessionId);
    if (!rootSessionId) return null;
    return {
        schemaVersion: readNumber(snapshot.schemaVersion) ?? 1,
        rootSessionId,
        members: snapshot.members
            .map(parseDelegationMember)
            .filter((member): member is McodeDelegationMember => member !== null)
    };
}

/**
 * Computes the nesting depth of every member by walking the parent chain.
 * A member whose parent is unknown counts as a root.
 */
function computeDepths(members: McodeDelegationMember[]): Map<string, number> {
    const byId = new Map(members.map((member) => [member.sessionId, member]));
    const depths = new Map<string, number>();
    for (const member of members) {
        let depth = 0;
        let current: McodeDelegationMember | undefined = member;
        const seen = new Set<string>();
        while (current && !seen.has(current.sessionId)) {
            seen.add(current.sessionId);
            const parent: McodeDelegationMember | undefined = current.parentSessionId
                ? byId.get(current.parentSessionId)
                : undefined;
            if (!parent) break;
            depth += 1;
            current = parent;
        }
        depths.set(member.sessionId, depth);
    }
    return depths;
}

/**
 * Converts a delegation snapshot into the subagent members the web renders.
 *
 * The members are the delegated sessions below the root; the root session
 * itself is the session HAPI already shows, so it is not listed twice.
 */
export function toSubagentSnapshotMembers(snapshot: McodeDelegationSnapshot): SubagentSnapshotMember[] {
    const depths = computeDepths(snapshot.members);
    return snapshot.members.map((member) => {
        const depth = depths.get(member.sessionId) ?? 0;
        const startedAt = member.createdAtMs ?? null;
        const endedAt = TERMINAL_DELEGATION_STATUSES.has(member.status)
            ? (member.updatedAtMs ?? member.createdAtMs ?? null)
            : null;
        return {
            id: member.sessionId,
            parentId: member.parentSessionId || null,
            title: member.task ?? member.agentName ?? member.sessionId,
            detail: member.agentName ?? null,
            status: member.status,
            startedAt,
            endedAt,
            depth
        } satisfies SubagentSnapshotMember;
    });
}

/**
 * Parses a `mcode/session/goal_update` payload. A cleared goal arrives as
 * `{ goal: null, goalId }`.
 *
 * A payload without a `goal` field is malformed, not a cleared goal: treating
 * it as "cleared" would erase the goal the user is watching because of a
 * payload this code does not understand.
 */
export function parseMcodeGoalUpdate(params: unknown): McodeGoalUpdate | null {
    if (!isObject(params)) return null;
    if (!('goal' in params)) return null;
    const goal = params.goal;
    if (goal === null) {
        return { kind: 'cleared', goalId: readString(params.goalId) ?? null };
    }
    if (!isObject(goal)) return null;

    const goalId = readString(goal.goalId);
    const sessionId = readString(goal.sessionId);
    const objective = readString(goal.objective);
    const status = normalizeGoalStatus(goal.status);
    const createdAt = readNumber(goal.createdAt);
    const updatedAt = readNumber(goal.updatedAt);
    const tokensUsed = readNumber(goal.tokensUsed);
    const timeUsedSeconds = readNumber(goal.timeUsedSeconds);
    if (!goalId || !sessionId || !objective || !status || createdAt === undefined
        || updatedAt === undefined || tokensUsed === undefined || timeUsedSeconds === undefined) {
        return null;
    }
    const tokenBudget = goal.tokenBudget === null ? null : readNumber(goal.tokenBudget) ?? null;
    const parsed: McodeGoal = {
        goalId,
        sessionId,
        objective,
        status,
        createdAt,
        updatedAt,
        tokensUsed,
        turnsUsed: readNumber(goal.turnsUsed) ?? 0,
        timeUsedSeconds,
        tokenBudget,
        hasKickoffAttachments: goal.hasKickoffAttachments === true
    };
    const statusReason = readString(goal.statusReason);
    if (statusReason) parsed.statusReason = statusReason;
    return { kind: 'goal', goal: parsed };
}

/**
 * Converts MiniMax Code's goal into HAPI's thread-goal contract.
 *
 * The two contracts disagree on two points: MiniMax Code counts in epoch
 * milliseconds while HAPI counts in epoch seconds, and it spells the budget
 * status `budget_limited` where HAPI spells it `budgetLimited`.
 */
export function toHapiThreadGoal(goal: McodeGoal, threadId: string): ThreadGoal {
    return {
        threadId,
        objective: goal.objective,
        status: GOAL_STATUS_MAP[goal.status],
        tokenBudget: goal.tokenBudget ?? undefined,
        tokensUsed: goal.tokensUsed,
        timeUsedSeconds: goal.timeUsedSeconds,
        createdAt: Math.floor(goal.createdAt / 1000),
        updatedAt: Math.floor(goal.updatedAt / 1000)
    };
}

/**
 * A signature of the goal's lifecycle: the fields that decide whether a new
 * goal card belongs in the chat. Token accounting updates do not change it,
 * so a running goal produces one card instead of one per accounting update.
 *
 * The goal id is part of the signature: two goals with the same objective,
 * status and budget are still two goals, and the second one has to be
 * announced.
 */
export function goalLifecycleSignature(goal: ThreadGoal, goalId?: string | null): string {
    return [goalId ?? '', goal.objective, goal.status, goal.tokenBudget ?? 'unlimited'].join('|');
}
