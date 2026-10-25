import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The sign-in state of the MiniMax Code account on this machine.
 *
 * MiniMax Code keeps the state of its account in a small status file next to
 * the account itself - `~/.minimax/auth/prod/<region>/mcode-public/auth-state.json`.
 * The file holds no secret: it says whether the agent is signed in, in which
 * region the account lives and when the session expires.
 *
 * HAPI reads it to tell the difference between an agent that is missing and an
 * agent that is there but has no account: the first one cannot be used at all,
 * the second one works as soon as the user runs `mcode login`.
 */
export type McodeAuthStatus = 'authenticated' | 'unauthenticated' | 'expired' | 'unknown'

export type McodeAuthState = {
    /** What the agent itself wrote about the account. */
    status: McodeAuthStatus
    /** The region the account lives in (`cn`, `en`, ...). */
    region: string | null
    /** When the account session expires. */
    expiresAtMs: number | null
}

const UNKNOWN_STATE: McodeAuthState = { status: 'unknown', region: null, expiresAtMs: null }

/** Where the agent keeps the state of its accounts. */
function authStateRoots(home: string): string[] {
    return [join(home, '.minimax', 'auth', 'prod')]
}

/** The client the account of the agent belongs to. */
const ACCOUNT_CLIENT = 'mcode-public'

/** The status the agent writes when it is signed out. */
const SIGNED_OUT_STATUSES = new Set(['unauthenticated', 'signed_out', 'logged_out', 'anonymous'])

function readJson(path: string): Record<string, unknown> | null {
    try {
        if (!existsSync(path)) return null
        const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
        return parsed as Record<string, unknown>
    } catch {
        return null
    }
}

/**
 * The state files of the accounts on this machine.
 *
 * The account of the agent lives under its client id, but the layout is not
 * worth depending on: every `auth-state.json` below the roots is read, and the
 * one of the agent's client wins.
 */
function findAuthStateFiles(home: string): { region: string | null; path: string }[] {
    const found: { region: string | null; path: string }[] = []
    for (const root of authStateRoots(home)) {
        let regions: string[]
        try {
            regions = readdirSync(root)
        } catch {
            continue
        }
        for (const region of regions) {
            const regionDir = join(root, region)
            let clients: string[]
            try {
                clients = readdirSync(regionDir)
            } catch {
                continue
            }
            for (const client of clients) {
                const path = join(regionDir, client, 'auth-state.json')
                if (existsSync(path)) found.push({ region, path })
            }
        }
    }
    return found
}

/**
 * Whether the account of the agent can be used.
 *
 * An account whose access token ran out is still an account: the agent holds
 * a refresh token and renews the access token when it starts, so an expired
 * token is not a signed-out account.
 *
 * A state that cannot be read is not a signed-out account either: the agent
 * may keep the account somewhere else (a keychain, a different store), and
 * reporting "not signed in" for that would keep a working agent out of reach.
 */
export function isMcodeSignedIn(state: McodeAuthState): boolean {
    return state.status === 'authenticated' || state.status === 'expired'
}

/**
 * Reads the sign-in state of the MiniMax Code account on this machine.
 *
 * The state is read from the file the agent writes. A file that is missing or
 * unreadable leaves the state unknown - the caller then has to assume the
 * agent is usable and let it speak for itself.
 */
export function readMcodeAuthState(options?: {
    /** The home directory of the user. */
    home?: string | null
    /** The regions to look at. Exposed for tests. */
    regions?: readonly string[]
}): McodeAuthState {
    const home = options?.home ?? process.env.HOME ?? process.env.USERPROFILE ?? null
    if (!home) return UNKNOWN_STATE

    const files = options?.regions
        ? options.regions.map((region) => ({
              region,
              path: join(home, '.minimax', 'auth', 'prod', region, ACCOUNT_CLIENT, 'auth-state.json')
          }))
        : findAuthStateFiles(home)

    let fallback: McodeAuthState = UNKNOWN_STATE
    let agentState: McodeAuthState | null = null
    for (const file of files) {
        const raw = readJson(file.path)
        if (!raw) continue

        const region = typeof raw.region === 'string' && raw.region.length > 0
            ? raw.region
            : file.region
        const expiresAtMs = typeof raw.expiresAtMs === 'number' && Number.isFinite(raw.expiresAtMs)
            ? raw.expiresAtMs
            : null
        const rawStatus = typeof raw.status === 'string' ? raw.status.toLowerCase() : ''

        let status: McodeAuthStatus = 'unknown'
        if (rawStatus === 'authenticated') status = 'authenticated'
        else if (rawStatus === 'expired') status = 'expired'
        else if (SIGNED_OUT_STATUSES.has(rawStatus)) status = 'unauthenticated'

        const state: McodeAuthState = { status, region, expiresAtMs }
        // The account of the agent wins over the accounts of other clients: a
        // signed-in account of another client must not hide an agent that has
        // been signed out.
        if (file.path.includes(ACCOUNT_CLIENT)) {
            if (!agentState) agentState = state
            continue
        }
        if (status === 'authenticated' && fallback.status !== 'authenticated') {
            fallback = state
            continue
        }
        if (fallback.status === 'unknown') fallback = state
    }

    return agentState ?? fallback
}
