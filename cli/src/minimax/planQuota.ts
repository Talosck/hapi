import { isObject } from '@hapi/protocol'

/**
 * The usage window of a MiniMax account.
 *
 * The account's coding models share a five hour window, and that is the one
 * worth showing - the weekly and the video windows are not interesting enough
 * to put in front of the user.
 *
 * The window belongs to the account, not to an agent: MiniMax Code and Pi
 * spend the same kind of account, and each of them reaches it with the
 * credential it owns. This module holds the part that is the same for both -
 * the answer of the platform and what is read out of it.
 */

/** One window of the account's usage. */
export type MinimaxQuotaWindow = {
    /** How much of the window is left, in percent. `null` when the account does not say. */
    remainingPercent: number | null
    /** When the window resets, in epoch milliseconds. */
    resetAtMs: number | null
    /** Whether the window has no limit at all. */
    unlimited: boolean
}

export type MinimaxPlanQuotaResult = {
    quota: MinimaxQuotaWindow | null
    error?: string
}

/** Where the account's quota lives. One backend per region. */
const QUOTA_PATH = '/v1/api/openplatform/coding_plan/remains'

/** The backend of each region. */
export const QUOTA_BASES: Record<string, string> = {
    cn: 'https://www.minimaxi.com',
    en: 'https://platform.minimax.io'
}

/** How long the request to the platform may take. */
export const QUOTA_TIMEOUT_MS = 10_000

/**
 * The five hour window of the platform's answer.
 *
 * A window whose status is 3 has no limit at all, and then the platform's
 * percentage means nothing.
 */
function parseFiveHourWindow(entry: Record<string, unknown>): MinimaxQuotaWindow {
    const unlimited = readNumber(entry.current_interval_status) === 3
    const percent = readNumber(entry.current_interval_remaining_percent)
        ?? shareFromCounts(entry, 'current_interval')
    const resetAtMs = readNumber(entry.end_time)
    return {
        remainingPercent: unlimited || percent === null
            ? null
            : Math.round(Math.min(100, Math.max(0, percent))),
        resetAtMs: resetAtMs !== null && resetAtMs > 0 ? resetAtMs : null,
        unlimited
    }
}

/**
 * The five hour window of the account.
 *
 * The platform answers with one entry per model, and the first one carries
 * the coding models - the ones that share the window.
 */
export function parseFiveHourQuota(payload: unknown): MinimaxQuotaWindow | null {
    if (!isObject(payload)) return null
    const baseResp = isObject(payload.base_resp) ? payload.base_resp : null
    const statusCode = baseResp ? readNumber(baseResp.status_code) : null
    if (statusCode !== null && statusCode !== 0) return null

    const entries = Array.isArray(payload.model_remains)
        ? payload.model_remains.filter((entry): entry is Record<string, unknown> => isObject(entry))
        : []
    const general = entries[0]
    if (!general) return null

    const window = parseFiveHourWindow(general)
    // A window that says neither how much is left nor when it resets tells
    // the user nothing.
    return window.remainingPercent === null && window.resetAtMs === null ? null : window
}

/** How the account's quota is asked for. */
export type MinimaxPlanFetch = (
    accessToken: string,
    base: string
) => Promise<unknown>

/**
 * Asks the platform how much of the account's plan is left.
 *
 * The token is only ever a header of this one request - it is never written
 * down, never logged and never leaves this function.
 */
export const fetchMinimaxPlan: MinimaxPlanFetch = async (accessToken, base) => {
    const response = await fetch(`${base}${QUOTA_PATH}`, {
        method: 'GET',
        headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${accessToken}`
        },
        signal: AbortSignal.timeout(QUOTA_TIMEOUT_MS)
    })
    if (!response.ok) {
        throw new Error(`The quota request failed with HTTP ${response.status}`)
    }
    return await response.json()
}

/**
 * The share of a window that is left.
 *
 * The platform reports it as a percentage. When it does not, it is computed
 * from the counts the platform does report - there the count is what is left
 * of the window, not what was spent.
 */
function shareFromCounts(entry: Record<string, unknown>, prefix: string): number | null {
    const total = readNumber(entry[`${prefix}_total_count`])
    const left = readNumber(entry[`${prefix}_usage_count`])
    if (total === null || total <= 0 || left === null) return null
    return left / total * 100
}

/** Reads a number out of an answer that may not have one. */
function readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}
