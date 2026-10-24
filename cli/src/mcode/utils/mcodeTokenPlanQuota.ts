import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { isObject } from '@hapi/protocol'
import { logger } from '@/ui/logger'
import {
    findMcodeRegion,
    type McodeConnectorBroker,
    preferredMcodeConnectorBrokers
} from './mcodeConnectorTools'
import { readMcodeStoredCredentials, type McodeStoredCredential } from './mcodeStoredCredential'
import {
    fetchMinimaxPlan,
    parseFiveHourQuota,
    QUOTA_BASES,
    type MinimaxPlanFetch,
    type MinimaxQuotaWindow
} from '@/minimax/planQuota'

/**
 * The usage the MiniMax Code account has left.
 *
 * The account's coding models share a five hour window, and that is the one
 * worth showing - the weekly and the video windows are not interesting enough
 * to put in front of the user.
 *
 * The account token stays where it is: a running host hands out a short lease
 * over its broker socket, and only the numbers of the quota are reported from
 * here. The lease is spent on a single request and dropped.
 *
 * When no host runs, the credential the install keeps for the account it is
 * logged into is read instead - still read only, never refreshed and never
 * written back - so a machine without a running host still knows how much of
 * the window is left.
 */

export type McodeTokenPlanQuotaResult = {
    quota: MinimaxQuotaWindow | null
    error?: string
}

/** The version of the lease protocol the host speaks. */
const LEASE_PROTOCOL_VERSION = 1

/** A frame is a four byte length prefix and the JSON that follows it. */
const FRAME_PREFIX_BYTES = 4
const MAX_FRAME_BYTES = 64 * 1024

/**
 * How long the lease has to be valid for.
 *
 * One request is enough, so a minute is plenty - and a short lease cannot be
 * replayed for long.
 */
const LEASE_MIN_VALIDITY_MS = 60_000

const LEASE_TIMEOUT_MS = 5_000

/**
 * The quota moves slowly and the reset moment is absolute, so the answer is
 * worth keeping for a minute: a browser tab that polls does not keep the
 * account's API busy.
 */
const QUOTA_TTL_MS = 60_000

/**
 * How long a failed read is remembered.
 *
 * A client that watches the usage polls the quota, and a poll that fails
 * would look for the host of the machine again - the machine is the
 * expensive part of the read. The failure is remembered for a shorter time
 * than a success, so a host that comes back is noticed soon.
 */
const QUOTA_FAILURE_TTL_MS = 15_000


let cachedQuota: { expiresAtMs: number; result: McodeTokenPlanQuotaResult } | null = null

/** Encodes one frame of the lease protocol. */
function encodeLeaseFrame(value: unknown): Uint8Array {
    const payload = new TextEncoder().encode(JSON.stringify(value))
    if (payload.length === 0 || payload.length > MAX_FRAME_BYTES) {
        throw new Error('The lease request does not fit into a frame')
    }
    const frame = new Uint8Array(FRAME_PREFIX_BYTES + payload.length)
    frame[0] = (payload.length >>> 24) & 0xff
    frame[1] = (payload.length >>> 16) & 0xff
    frame[2] = (payload.length >>> 8) & 0xff
    frame[3] = payload.length & 0xff
    frame.set(payload, FRAME_PREFIX_BYTES)
    return frame
}

/** Joins the bytes that are still coming with the ones that are. */
function concatBytes(first: Uint8Array, second: Uint8Array): Uint8Array {
    const joined = new Uint8Array(first.length + second.length)
    joined.set(first, 0)
    joined.set(second, first.length)
    return joined
}

/** Reads the length prefix of a frame. */
function readUint32BE(bytes: Uint8Array, offset: number): number {
    return ((bytes[offset] << 24) >>> 0)
        + (bytes[offset + 1] << 16)
        + (bytes[offset + 2] << 8)
        + bytes[offset + 3]
}

/** Splits the frames the broker sent out of the bytes that are still coming. */
function decodeLeaseFrames(buffer: Uint8Array): { frames: unknown[]; rest: Uint8Array } {
    const frames: unknown[] = []
    let rest = buffer
    while (rest.length >= FRAME_PREFIX_BYTES) {
        const payloadLength = readUint32BE(rest, 0)
        if (payloadLength === 0 || payloadLength > MAX_FRAME_BYTES) {
            throw new Error('The broker sent a frame that does not fit')
        }
        const frameLength = FRAME_PREFIX_BYTES + payloadLength
        if (rest.length < frameLength) break
        const payload = rest.subarray(FRAME_PREFIX_BYTES, frameLength)
        frames.push(JSON.parse(new TextDecoder().decode(payload)))
        rest = rest.subarray(frameLength)
    }
    return { frames, rest }
}

/**
 * The capability the broker guards its socket with.
 *
 * It is useless without the socket, and the broker only hands it to the
 * processes of the same user - so reading it here is what the host's own
 * tools do.
 */
async function readCapability(capabilityFile: string): Promise<string> {
    const secret = (await readFile(capabilityFile, 'utf8')).trim()
    if (!/^[A-Za-z0-9_-]{43}$/u.test(secret)) {
        throw new Error('The broker capability is not readable')
    }
    return secret
}

/** The answer of the broker to a lease request. */
type LeaseResponse = {
    requestId: string
    ok: boolean
    accessToken: string | null
}

function asLeaseResponse(value: unknown): LeaseResponse | null {
    if (!isObject(value)) return null
    const requestId = typeof value.requestId === 'string' ? value.requestId : null
    if (!requestId) return null
    const result = isObject(value.result) ? value.result : null
    const accessToken = result && typeof result.accessToken === 'string' ? result.accessToken : null
    return { requestId, ok: value.ok === true, accessToken }
}

/**
 * Asks the broker of a running host for a short lease.
 *
 * The lease is the only way to reach the account's API from outside the host:
 * the account token stays in the host, and what comes back is a token the host
 * vouches for. The caller spends it and drops it.
 */
export async function requestMcodeAuthLease(
    broker: McodeConnectorBroker,
    options: { timeoutMs?: number } = {}
): Promise<string> {
    const timeoutMs = options.timeoutMs ?? LEASE_TIMEOUT_MS
    const capability = await readCapability(broker.capabilityFile)
    const requestId = randomUUID()
    const frame = encodeLeaseFrame({
        version: LEASE_PROTOCOL_VERSION,
        requestId,
        capability,
        method: 'lease',
        minValidityMs: LEASE_MIN_VALIDITY_MS
    })

    return await new Promise<string>((resolve, reject) => {
        const socket = connect(broker.endpoint)
        let buffer: Uint8Array = new Uint8Array(0)
        let settled = false

        const finish = (error: Error | null, token?: string): void => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            socket.destroy()
            if (error) reject(error)
            else resolve(token as string)
        }

        const timer = setTimeout(() => finish(new Error('The broker did not answer in time')), timeoutMs)

        socket.on('error', (error) => finish(error))
        socket.on('connect', () => socket.write(frame))
        socket.on('data', (chunk) => {
            try {
                // The broker answers in bytes, but a socket may hand a string
                // out when it was given an encoding.
                const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk
                buffer = concatBytes(buffer, bytes)
                const { frames, rest } = decodeLeaseFrames(buffer)
                buffer = rest
                for (const raw of frames) {
                    const response = asLeaseResponse(raw)
                    if (!response || response.requestId !== requestId) continue
                    if (response.ok && response.accessToken) {
                        finish(null, response.accessToken)
                        return
                    }
                    finish(new Error('The broker refused to hand out a lease'))
                    return
                }
            } catch (error) {
                finish(error instanceof Error ? error : new Error(String(error)))
            }
        })
    })
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/**
 * The usage the account has left.
 *
 * The lease comes from the host that is running on this machine, and the
 * account's API is asked with it. A host that is gone, a refused lease and an
 * unreachable backend all end in an error the caller can report - never in a
 * made up zero.
 *
 * When no host runs, the account of the install is asked instead: the install
 * keeps the credential of the account it is logged into, so the window is
 * there even on a machine where nothing of MiniMax Code is running. That
 * path only reads the credential - it never refreshes it, and never writes to
 * the store of the install.
 */
export async function listMcodeTokenPlanQuota(options?: {
    /** The brokers to ask. Exposed for tests. */
    brokers?: McodeConnectorBroker[]
    /** The region of the account. */
    region?: string | null
    env?: NodeJS.ProcessEnv
    /** How the lease is obtained. Exposed for tests. */
    requestLease?: (broker: McodeConnectorBroker) => Promise<string>
    /** How the platform is asked. Exposed for tests. */
    fetchQuota?: MinimaxPlanFetch
    now?: () => number
    /** Skip the cache. Exposed for tests. */
    forceRefresh?: boolean
    /** The accounts of the install. Exposed for tests. */
    storedCredentials?: McodeStoredCredential[]
}): Promise<McodeTokenPlanQuotaResult> {
    const now = options?.now ?? Date.now
    if (!options?.forceRefresh && cachedQuota && cachedQuota.expiresAtMs > now()) {
        return cachedQuota.result
    }

    const remember = (result: McodeTokenPlanQuotaResult): McodeTokenPlanQuotaResult => {
        const ttl = result.quota ? QUOTA_TTL_MS : QUOTA_FAILURE_TTL_MS
        cachedQuota = { expiresAtMs: now() + ttl, result }
        return result
    }

    const brokers = options?.brokers ?? preferredMcodeConnectorBrokers()
    const requestLease = options?.requestLease ?? ((broker: McodeConnectorBroker) => requestMcodeAuthLease(broker))
    const fetchQuota = options?.fetchQuota ?? fetchMinimaxPlan
    const region = options?.region ?? findMcodeRegion(options?.env ?? process.env)
    // Two regions mean two accounts, and then only the backend knows which one
    // this token belongs to.
    const bases = region && QUOTA_BASES[region] ? [QUOTA_BASES[region]] : Object.values(QUOTA_BASES)
    let lastError = brokers.length === 0
        ? 'No MiniMax Code host is running on this machine'
        : 'The MiniMax Code broker did not hand out a lease'

    for (const broker of brokers) {
        let accessToken: string
        try {
            accessToken = await requestLease(broker)
        } catch (error) {
            lastError = messageOf(error)
            logger.debug('Failed to get an auth lease from a MiniMax Code broker:', error)
            continue
        }

        for (const base of bases) {
            try {
                const quota = parseFiveHourQuota(await fetchQuota(accessToken, base))
                if (!quota) {
                    lastError = 'The account reported no usage quota'
                    continue
                }
                const result: McodeTokenPlanQuotaResult = { quota }
                return remember(result)
            } catch (error) {
                lastError = messageOf(error)
                logger.debug('Failed to read the MiniMax Code usage quota:', error)
            }
        }
    }

    // The account of the install, for a machine where no host runs. The store
    // is only read when the caller did not bring its own fetcher: a caller
    // that injects one (a test) must not reach the real account.
    const stored = options?.storedCredentials
        ?? (options?.fetchQuota ? [] : readMcodeStoredCredentials({ now }))
    for (const credential of stored) {
        const base = QUOTA_BASES[credential.region]
        if (!base) continue
        try {
            const quota = parseFiveHourQuota(await fetchQuota(credential.accessToken, base))
            if (!quota) {
                lastError = 'The account reported no usage quota'
                continue
            }
            const result: McodeTokenPlanQuotaResult = { quota }
            return remember(result)
        } catch (error) {
            lastError = messageOf(error)
            logger.debug('Failed to read the MiniMax Code usage quota:', error)
        }
    }

    // Nothing answered: say what was tried, so the log tells the next reader
    // whether the host was missing or the account had no valid token left.
    if (brokers.length === 0 && stored.length === 0) {
        lastError = 'No MiniMax Code host is running on this machine and the install has no account credential that is still valid'
    }

    // The reason is not part of the answer the clients get - a missing quota
    // is enough for them - so it goes to the log.
    logger.debug('Could not read the MiniMax Code usage quota:', lastError)
    return remember({ quota: null, error: lastError })
}

/** Drops the cached answer. Exposed for tests. */
export function _resetMcodeTokenPlanQuotaCacheForTests(): void {
    cachedQuota = null
}
