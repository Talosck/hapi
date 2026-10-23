import { describe, expect, it, vi } from 'vitest'

/**
 * How often the machine is scanned for the socket owners.
 *
 * The broker of a MiniMax Code host carries no pid in its name, so the
 * kernel is the only one that can say which host a broker belongs to. That
 * answer comes from a walk over every unix socket of the machine, and the
 * walk is synchronous: it blocks the runner that also carries the ACP
 * transport.
 *
 * A read of the connected apps has to walk the sockets once. Walking them
 * again for every known agent turns one read into a dozen.
 */
const procReads = vi.hoisted(() => ({ unix: 0 }))

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>()
    return {
        ...actual,
        readFileSync: ((path: string, ...rest: unknown[]) => {
            if (path === '/proc/net/unix') procReads.unix += 1
            return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest)
        }) as typeof actual.readFileSync,
    }
})

import {
    _resetMcodeConnectorCacheForTests,
    listMcodeConnectorApps,
    rememberMcodeAgentHostPid,
} from './mcodeConnectorTools'

/** Pids that no host can be named after, so every lookup has to ask the kernel. */
const FAKE_AGENT_PIDS = [900_001, 900_002, 900_003, 900_004]

describe('reading the connected apps', () => {
    it('scans the sockets of the machine once', async () => {
        _resetMcodeConnectorCacheForTests()
        for (const pid of FAKE_AGENT_PIDS) {
            rememberMcodeAgentHostPid(pid)
        }
        procReads.unix = 0

        await listMcodeConnectorApps({
            mcodeCommand: 'mcode',
            runTools: async () => {
                throw new Error('no MiniMax Code host on this machine')
            }
        })

        expect(procReads.unix).toBe(1)
    })
})
