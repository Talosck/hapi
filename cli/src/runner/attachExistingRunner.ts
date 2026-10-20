/**
 * Supervisor support for `hapi runner start-sync`.
 *
 * `start-sync` is meant to be the foreground process of a supervisor (systemd
 * `Restart=always`, pm2, launchd). It becomes the runner when none is running,
 * but when a runner it did not start already owns the slot (manual
 * `hapi runner start`, or the child that takes over during the CLI-upgrade
 * self-restart) it used to print a line and `exit 0`.
 *
 * A clean exit is indistinguishable from a crash to `Restart=always`: systemd
 * re-execs the unit every `RestartSec`, the new process finds the same
 * untouched runner and exits again, forever. `KillMode=process` guarantees the
 * found runner survives each stop, so the loop can never converge — it was
 * observed spinning every 5s for 15 minutes (~1.2s CPU and three journal lines
 * per cycle) after a routine CLI upgrade.
 *
 * `attachToExistingRunner` is the fix: the supervisor's process stays alive,
 * following the runner it found (including generation handoffs), and reports
 * `runner-gone` once that runner dies so the supervisor starts one the unit
 * really owns. `shutdown` means the supervisor itself asked us to stop, which
 * must exit cleanly and must not trigger a restart.
 */

import { readRunnerState, type RunnerLocallyPersistedState } from '@/persistence'
import { logger } from '@/ui/logger'
import { isProcessAlive } from '@/utils/process'

export type AttachOutcome =
    /** The supervisor requested shutdown (SIGTERM/SIGINT). Exit 0. */
    | 'shutdown'
    /** No live runner remained. Exit non-zero so the supervisor restarts. */
    | 'runner-gone'

/**
 * Attachment is only meaningful when a supervisor will restart this process.
 * systemd marks service children with INVOCATION_ID; other supervisors opt in
 * with HAPI_RUNNER_SUPERVISED=1 (the same flag the web UI uses to delegate
 * restarts). An unsupervised invocation — `hapi runner start`'s detached
 * child, a shell one-liner, CI — must keep exiting instead: waiting there
 * would leave a process that nobody ever restarts.
 */
export function shouldAttachToExistingRunner(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.HAPI_RUNNER_SUPERVISED === '1' || Boolean(env.INVOCATION_ID)
}

export interface AttachToExistingRunnerOptions {
    /** PID from the runner state this process matched against. */
    initialPid: number
    /** Aborted when the supervisor asks this process to stop. */
    signal?: AbortSignal
    /** How often to re-read the runner state. Defaults to 2s. */
    pollIntervalMs?: number
    /**
     * Consecutive polls that must show no live runner before we conclude it is
     * gone. Absorbs the non-atomic state writes and the brief window during a
     * generation handoff where the old PID is dead and the new one is not yet
     * in the file. Defaults to 3 (~6s at the default interval).
     */
    missingPollsBeforeExit?: number
    readState?: () => Promise<RunnerLocallyPersistedState | null>
    isAlive?: (pid: number) => boolean
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
    log?: (message: string) => void
}

export async function attachToExistingRunner(
    options: AttachToExistingRunnerOptions
): Promise<AttachOutcome> {
    const pollIntervalMs = options.pollIntervalMs ?? 2_000
    const missingPollsBeforeExit = Math.max(1, options.missingPollsBeforeExit ?? 3)
    const readState = options.readState ?? readRunnerState
    const isAlive = options.isAlive ?? isProcessAlive
    const sleep = options.sleep ?? abortableSleep
    const log = options.log ?? ((message: string) => logger.debug(`[RUNNER ATTACH] ${message}`))

    let followedPid = options.initialPid
    let consecutiveMisses = 0

    while (true) {
        if (options.signal?.aborted) {
            log(`Supervisor requested shutdown while attached to runner ${followedPid}`)
            return 'shutdown'
        }

        let state: RunnerLocallyPersistedState | null = null
        try {
            state = await readState()
        } catch {
            // A torn read during a state write is not evidence the runner died.
            state = null
        }

        if (state && isAlive(state.pid)) {
            if (state.pid !== followedPid) {
                log(`Follower: runner generation changed ${followedPid} -> ${state.pid}`)
                followedPid = state.pid
            }
            consecutiveMisses = 0
        } else {
            consecutiveMisses += 1
            if (consecutiveMisses >= missingPollsBeforeExit) {
                log(`Attached runner ${followedPid} is gone after ${consecutiveMisses} polls`)
                return 'runner-gone'
            }
        }

        await sleep(pollIntervalMs, options.signal)
    }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
        return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
        const done = () => {
            clearTimeout(timer)
            signal?.removeEventListener('abort', done)
            resolve()
        }
        const timer = setTimeout(done, ms)
        signal?.addEventListener('abort', done, { once: true })
    })
}
