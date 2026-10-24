import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isObject } from '@hapi/protocol'

/**
 * The account the MiniMax Code install is logged into.
 *
 * The install keeps the credential of its account on disk: an OAuth record
 * with an access token, a refresh token and the moment the access token
 * stops being valid. A running host refreshes that record, so the account is
 * fresh as long as the install is used.
 *
 * This is the way to a usage window on a machine where no host runs: the
 * account is still there, and the window belongs to it. The record is only
 * read, never written - the install owns it.
 *
 * The access token is used while it is valid and not a moment longer. The
 * refresh token is not touched at all: refreshing an account is the job of
 * the host that owns it, and a refresh that rotates the token would take the
 * install's own copy with it.
 */

/** One account of the install. */
export type McodeStoredCredential = {
    /** The region the account lives in - it decides the backend to ask. */
    region: string
    /** The access token of the account. */
    accessToken: string
    /** When the token stops being valid, in epoch milliseconds. */
    expiresAtMs: number
}

/** Where the install keeps the credential of the account it is logged into. */
const AUTH_ROOT = ['.minimax', 'auth', 'prod']

/** The directory the account of the agent is filed under. */
const ACCOUNT_DIR = 'mcode-public'

/** The file the credential is written to. */
const AUTH_FILE = 'auth.json'

/** The regions an install may have an account in. */
const REGIONS = ['cn', 'en'] as const

/**
 * The accounts of the install whose access token is still valid.
 *
 * A token that has expired is left alone: the host that owns the account
 * refreshes it, and a stale token would only be refused by the platform.
 */
export function readMcodeStoredCredentials(options?: {
    /** The home of the user. Defaults to the home of the process. */
    home?: string
    /** The clock. Defaults to the wall clock. */
    now?: () => number
}): McodeStoredCredential[] {
    const home = options?.home ?? homedir()
    const now = options?.now?.() ?? Date.now()
    const root = join(home, ...AUTH_ROOT)
    const found: McodeStoredCredential[] = []

    for (const region of REGIONS) {
        const file = join(root, region, ACCOUNT_DIR, AUTH_FILE)
        if (!existsSync(file)) continue
        let parsed: unknown
        try {
            parsed = JSON.parse(readFileSync(file, 'utf8'))
        } catch {
            // A store that cannot be read is a store that has no account for
            // us: the next read may find it readable again.
            continue
        }
        if (!isObject(parsed)) continue
        const records = parsed.records
        if (!isObject(records)) continue

        for (const record of Object.values(records)) {
            if (!isObject(record)) continue
            const accessToken = typeof record.accessToken === 'string' ? record.accessToken : null
            const expiresAtMs = typeof record.expiresAtMs === 'number' ? record.expiresAtMs : null
            if (!accessToken || expiresAtMs === null) continue
            if (expiresAtMs <= now) continue
            found.push({ region, accessToken, expiresAtMs })
        }
    }

    return found
}
