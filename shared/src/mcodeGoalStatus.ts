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
