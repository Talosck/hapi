import type { McodeGoalStatus } from './apiTypes'
import type { ThreadGoalStatus } from './schemas'

/**
 * MiniMax Code's goal statuses, in the two spellings the two paths use.
 *
 * The agent spells its two runtime-derived states in snake_case
 * (`budget_limited`, `usage_limited`), and it uses that spelling on both
 * paths that reach the web: the ACP extension methods
 * (`mcode/session/goal/*`) and the results of its own goal tool. HAPI's own
 * goal contract spells the same states in camelCase (`budgetLimited`,
 * `usageLimited`).
 *
 * The map below is the single place that translates one into the other, so
 * the two paths cannot drift apart.
 */
export const MCODE_GOAL_STATUS_MAP: Record<McodeGoalStatus, ThreadGoalStatus> = {
    active: 'active',
    paused: 'paused',
    blocked: 'blocked',
    complete: 'complete',
    budget_limited: 'budgetLimited',
    usage_limited: 'usageLimited'
}

/**
 * Normalizes a goal status the agent reported into HAPI's spelling.
 *
 * A status this map does not know — a state a future agent build adds — is
 * passed through unchanged, so the caller can still show what it said.
 */
export function toHapiGoalStatus(status: string | null | undefined): string | null {
    if (typeof status !== 'string') return null
    const trimmed = status.trim()
    if (!trimmed) return null
    return MCODE_GOAL_STATUS_MAP[trimmed as McodeGoalStatus] ?? trimmed
}

/**
 * The goal statuses a client may ask the agent to enter, in HAPI's spelling.
 *
 * `usageLimited` is not in the list: the agent derives that state from its
 * own usage counters (provider quota, rate limit), so HAPI does not let a
 * client claim it. Moving a goal *out* of that state - `active` - stays
 * possible, and the agent itself accepts `usage_limited` in a patch; HAPI is
 * the one that refuses to fabricate it.
 *
 * This list is what the REST contract validates against, and what the
 * translation to the agent's spelling is built from, so the request schema
 * and the CLI cannot drift apart.
 */
export const MCODE_GOAL_PATCHABLE_STATUSES = [
    'active',
    'paused',
    'blocked',
    'complete',
    'budgetLimited'
] as const

export type McodeGoalPatchableStatus = (typeof MCODE_GOAL_PATCHABLE_STATUSES)[number]

/**
 * HAPI's spelling -> the agent's spelling, for the statuses a client may set.
 *
 * Typed against {@link MCODE_GOAL_PATCHABLE_STATUSES}, so a status a client
 * may set cannot go missing from this map without a type error.
 */
export const HAPI_TO_MCODE_GOAL_STATUS = {
    active: 'active',
    paused: 'paused',
    blocked: 'blocked',
    complete: 'complete',
    budgetLimited: 'budget_limited'
} as const satisfies Record<McodeGoalPatchableStatus, McodeGoalStatus>

/** The same map, keyed by every status a client can name. */
const PATCH_STATUS_BY_HAPI_STATUS: Partial<Record<ThreadGoalStatus, McodeGoalStatus>> = HAPI_TO_MCODE_GOAL_STATUS

/**
 * Maps HAPI's goal status onto the status the agent accepts in a patch.
 *
 * Returns null for a status a client may not set - `usageLimited` is derived
 * from the agent's own usage counters, so asking for it would be a lie about
 * the state of the run.
 */
export function toMcodeGoalPatchStatus(status: ThreadGoalStatus): McodeGoalStatus | null {
    return PATCH_STATUS_BY_HAPI_STATUS[status] ?? null
}
