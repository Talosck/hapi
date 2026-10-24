import { spawn } from 'node:child_process'
import { logger } from '@/ui/logger'
import { getAgentLaunchCommand } from '@/agent/agentLaunchCommand'
import { resolveProbeCwd } from '@/modules/common/piModels'
import {
    fetchMinimaxPlan,
    parseFiveHourQuota,
    QUOTA_BASES,
    type MinimaxPlanFetch,
    type MinimaxQuotaWindow
} from '@/minimax/planQuota'

/**
 * The usage of the MiniMax account that Pi spends.
 *
 * Pi keeps the credential of the account it is logged into and hands it out
 * itself: `pi auth print-api-key` prints the key of a provider. The window is
 * then asked for with that key.
 *
 * This is what makes a Pi session independent of MiniMax Code: nothing of the
 * mcode binary, of its install or of its credential is involved - Pi is asked
 * for its own account, and the answer of the platform is the same window the
 * account has.
 *
 * The key is spent on one request and dropped: it is never written down, never
 * logged, and never part of an answer that travels to the hub.
 */

/** The MiniMax providers of Pi, with the backend of their region. */
const PI_MINIMAX_ACCOUNTS: { provider: string; base: string }[] = [
    { provider: 'minimax-cn', base: QUOTA_BASES.cn },
    { provider: 'minimax', base: QUOTA_BASES.en }
]

/** How long the auth command may take. */
const AUTH_TIMEOUT_MS = 10_000

/**
 * The quota moves slowly and the reset moment is absolute, so the answer is
 * worth keeping for a minute: a browser tab that polls does not keep the
 * account's API busy.
 */
const QUOTA_TTL_MS = 60_000

/** How long a failed read is remembered. */
const QUOTA_FAILURE_TTL_MS = 15_000

export type PiTokenPlanQuotaResult = {
    quota: MinimaxQuotaWindow | null
    error?: string
}

let cachedQuota: { expiresAtMs: number; result: PiTokenPlanQuotaResult } | null = null

/**
 * The key Pi keeps for one of its providers.
 *
 * Pi prints the key and nothing else. A provider that is not logged in makes
 * the command fail, which is not an error here - the next provider is tried.
 */
export function readPiProviderKey(provider: string, options?: {
    command?: string
    timeoutMs?: number
}): Promise<string | null> {
    const command = options?.command ?? getAgentLaunchCommand('pi')
    const timeoutMs = options?.timeoutMs ?? AUTH_TIMEOUT_MS

    return new Promise((resolve) => {
        let stdout = ''
        let settled = false
        const finish = (key: string | null) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            resolve(key)
        }

        let child: ReturnType<typeof spawn>
        try {
            child = spawn(command, ['auth', 'print-api-key', '--provider', provider], {
                env: process.env,
                // The same place the model probe reads from: a project may
                // contribute its own providers.
                cwd: resolveProbeCwd(),
                stdio: ['pipe', 'pipe', 'pipe'],
                shell: process.platform === 'win32',
                windowsHide: process.platform === 'win32'
            })
        } catch (error) {
            logger.debug(`Failed to start pi auth for the provider ${provider}:`, error)
            finish(null)
            return
        }

        const timeout = setTimeout(() => {
            logger.debug(`pi auth for the provider ${provider} timed out`)
            try {
                child.kill()
            } catch {
                // The process is already gone.
            }
            finish(null)
        }, timeoutMs)

        child.stdout?.on('data', (chunk) => {
            stdout += chunk.toString()
        })
        child.on('error', (error) => {
            logger.debug(`Failed to run pi auth for the provider ${provider}:`, error)
            finish(null)
        })
        child.on('close', (code) => {
            if (code !== 0) {
                finish(null)
                return
            }
            const key = stdout.trim()
            finish(key.length > 0 ? key : null)
        })
    })
}

/**
 * The five hour window of the account Pi spends.
 *
 * Every MiniMax provider of Pi is tried in turn: the key of a provider that
 * is not logged in is refused by the platform, and the account of the other
 * region answers.
 */
export async function listPiTokenPlanQuota(options?: {
    /** The key of a provider. Exposed for tests. */
    readKey?: (provider: string) => Promise<string | null>
    /** How the platform is asked. Exposed for tests. */
    fetchQuota?: MinimaxPlanFetch
    now?: () => number
    /** Skip the cache. Exposed for tests. */
    forceRefresh?: boolean
}): Promise<PiTokenPlanQuotaResult> {
    const now = options?.now ?? Date.now
    if (!options?.forceRefresh && cachedQuota && cachedQuota.expiresAtMs > now()) {
        return cachedQuota.result
    }

    const remember = (result: PiTokenPlanQuotaResult): PiTokenPlanQuotaResult => {
        const ttl = result.quota ? QUOTA_TTL_MS : QUOTA_FAILURE_TTL_MS
        cachedQuota = { expiresAtMs: now() + ttl, result }
        return result
    }

    const readKey = options?.readKey ?? ((provider: string) => readPiProviderKey(provider))
    const fetchQuota = options?.fetchQuota ?? fetchMinimaxPlan
    let lastError = 'Pi has no MiniMax account to read the usage from'

    for (const account of PI_MINIMAX_ACCOUNTS) {
        let key: string | null
        try {
            key = await readKey(account.provider)
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error)
            continue
        }
        if (!key) continue

        try {
            const quota = parseFiveHourQuota(await fetchQuota(key, account.base))
            if (!quota) {
                lastError = 'The account reported no usage quota'
                continue
            }
            return remember({ quota })
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error)
            logger.debug('Failed to read the usage of the Pi MiniMax account:', error)
        }
    }

    logger.debug('Could not read the usage of the Pi MiniMax account:', lastError)
    return remember({ quota: null, error: lastError })
}

/** Drops the cached answer. Exposed for tests. */
export function _resetPiTokenPlanQuotaCacheForTests(): void {
    cachedQuota = null
}
