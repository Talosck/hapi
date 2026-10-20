import { describe, expect, it } from 'vitest'
import { attachToExistingRunner, shouldAttachToExistingRunner, type AttachToExistingRunnerOptions } from './attachExistingRunner'
import type { RunnerLocallyPersistedState } from '@/persistence'

function state(pid: number): RunnerLocallyPersistedState {
    return {
        pid,
        httpPort: 1,
        startTime: '2026-10-20T00:00:00.000Z',
        startedWithCliVersion: '0.30.7',
    }
}

/**
 * Replays a scripted sequence of "what the state file says on each poll".
 * A null entry means the state file was missing/torn; a number means it named
 * that PID and that PID was alive.
 */
function scripted(
    polls: Array<number | null>,
    overrides: Partial<AttachToExistingRunnerOptions> = {}
) {
    let cursor = 0
    const logs: string[] = []
    const options: AttachToExistingRunnerOptions = {
        initialPid: polls[0] ?? 0,
        pollIntervalMs: 1,
        readState: async () => {
            const entry = polls[Math.min(cursor, polls.length - 1)]
            return entry === null ? null : state(entry)
        },
        isAlive: (pid: number) => {
            const entry = polls[Math.min(cursor, polls.length - 1)]
            return entry !== null && entry === pid
        },
        sleep: async () => {
            cursor += 1
        },
        log: (message: string) => logs.push(message),
        ...overrides,
    }
    return { options, logs }
}

describe('attachToExistingRunner', () => {
    it('stays attached while the runner it matched is alive', async () => {
        const { options } = scripted([100, 100, 100, 100, null, null, null])
        await expect(attachToExistingRunner(options)).resolves.toBe('runner-gone')
    })

    it('follows a generation handoff instead of exiting', async () => {
        // Old runner 100 hands off to 200 (CLI upgrade). The follower must
        // track 200, not conclude that "its" runner died.
        const { options, logs } = scripted([100, 100, 200, 200, 200, null, null, null])
        await expect(attachToExistingRunner(options)).resolves.toBe('runner-gone')
        expect(logs.some((line) => line.includes('100 -> 200'))).toBe(true)
    })

    it('absorbs a torn/missing state read without exiting', async () => {
        // A non-atomic write can make one poll look like "no runner".
        const { options, logs } = scripted([100, null, 100, 100, null, null, null])
        await expect(attachToExistingRunner(options)).resolves.toBe('runner-gone')
        expect(logs.filter((line) => line.includes('is gone'))).toHaveLength(1)
    })

    it('requires consecutive misses before reporting the runner gone', async () => {
        // Two misses followed by a live poll must not end the attachment: if
        // the threshold were two, this would resolve 'runner-gone' at poll 3
        // instead of waiting for the shutdown below.
        const controller = new AbortController()
        let polls = 0
        const { options } = scripted([100, null, null, 100, 100], {
            signal: controller.signal,
            sleep: async () => {
                polls += 1
                if (polls === 4) controller.abort()
            },
        })
        await expect(attachToExistingRunner(options)).resolves.toBe('shutdown')
    })

    it('returns shutdown (exit 0) when the supervisor asks it to stop', async () => {
        const controller = new AbortController()
        let polls = 0
        const { options, logs } = scripted([100, 100, 100, 100], {
            signal: controller.signal,
            sleep: async () => {
                polls += 1
                if (polls === 2) controller.abort()
            },
        })
        await expect(attachToExistingRunner(options)).resolves.toBe('shutdown')
        expect(logs.some((line) => line.includes('requested shutdown'))).toBe(true)
    })

    it('reports runner-gone immediately when every poll shows no runner', async () => {
        const { options } = scripted([null])
        await expect(attachToExistingRunner(options)).resolves.toBe('runner-gone')
    })
})

describe('shouldAttachToExistingRunner', () => {
    it('attaches under systemd, which marks service children with INVOCATION_ID', () => {
        expect(shouldAttachToExistingRunner({ INVOCATION_ID: 'c781900929b14375a53ce883a58b0e06' })).toBe(true)
    })

    it('attaches when the supervisor opts in explicitly', () => {
        expect(shouldAttachToExistingRunner({ HAPI_RUNNER_SUPERVISED: '1' })).toBe(true)
    })

    it('exits for an unsupervised invocation (detached `runner start` child, shell, CI)', () => {
        expect(shouldAttachToExistingRunner({})).toBe(false)
        expect(shouldAttachToExistingRunner({ HAPI_RUNNER_SUPERVISED: '0' })).toBe(false)
    })
})
