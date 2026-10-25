import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isMcodeSignedIn, readMcodeAuthState } from './mcodeAuthState'

const tempHomes: string[] = []

/** A home directory that holds the account state of an agent. */
function makeHome(files: { region: string; client?: string; state: Record<string, unknown> }[]): string {
    const home = mkdtempSync(join(tmpdir(), 'hapi-mcode-auth-test-'))
    tempHomes.push(home)
    for (const file of files) {
        const dir = join(home, '.minimax', 'auth', 'prod', file.region, file.client ?? 'mcode-public')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'auth-state.json'), JSON.stringify(file.state))
    }
    return home
}

afterEach(() => {
    while (tempHomes.length > 0) {
        const home = tempHomes.pop()
        if (home) rmSync(home, { recursive: true, force: true })
    }
})

describe('readMcodeAuthState', () => {
    it('reads a signed-in account', () => {
        const home = makeHome([
            { region: 'cn', state: { status: 'authenticated', region: 'cn', expiresAtMs: 4102444800000 } },
        ])

        const state = readMcodeAuthState({ home })

        expect(state.status).toBe('authenticated')
        expect(state.region).toBe('cn')
        expect(state.expiresAtMs).toBe(4102444800000)
        expect(isMcodeSignedIn(state)).toBe(true)
    })

    it('reports a signed-out account', () => {
        const home = makeHome([
            { region: 'cn', state: { status: 'unauthenticated', region: 'cn' } },
        ])

        const state = readMcodeAuthState({ home })

        expect(state.status).toBe('unauthenticated')
        expect(isMcodeSignedIn(state)).toBe(false)
    })

    it('keeps an account with an expired access token signed in', () => {
        // The expiry describes the access token, not the account: the account
        // still holds a refresh token and the agent renews the access token
        // when it starts. Reporting a signed-out account here would send the
        // user to `mcode login` for an account that is still there.
        const home = makeHome([
            { region: 'cn', state: { status: 'authenticated', region: 'cn', expiresAtMs: 1_600_000_000_000 } },
        ])

        const state = readMcodeAuthState({ home })

        expect(state.status).toBe('authenticated')
        expect(isMcodeSignedIn(state)).toBe(true)
    })

    it('keeps the state unknown when there is no account on the machine', () => {
        const home = makeHome([])

        const state = readMcodeAuthState({ home })

        expect(state.status).toBe('unknown')
        // An unknown state must not lock a working agent out: the agent may keep
        // the account somewhere else than a file.
        expect(isMcodeSignedIn(state)).toBe(false)
    })

    it('keeps the state unknown when the account file cannot be read', () => {
        const home = makeHome([])
        const dir = join(home, '.minimax', 'auth', 'prod', 'cn', 'mcode-public')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'auth-state.json'), '{not json')

        const state = readMcodeAuthState({ home })

        expect(state.status).toBe('unknown')
    })

    it('prefers the account of the agent over the one of another client', () => {
        const home = makeHome([
            { region: 'cn', client: 'other-client', state: { status: 'unauthenticated', region: 'cn' } },
            { region: 'cn', client: 'mcode-public', state: { status: 'authenticated', region: 'cn' } },
        ])

        const state = readMcodeAuthState({ home })

        expect(state.status).toBe('authenticated')
    })

    it('keeps a signed-out agent account signed out when another client is signed in', () => {
        // The account of another client must not hide the agent that has been
        // signed out - the user has to run `mcode login`.
        const home = makeHome([
            { region: 'cn', client: 'other-client', state: { status: 'authenticated', region: 'cn' } },
            { region: 'cn', client: 'mcode-public', state: { status: 'unauthenticated', region: 'cn' } },
        ])

        const state = readMcodeAuthState({ home })

        expect(state.status).toBe('unauthenticated')
    })
})
