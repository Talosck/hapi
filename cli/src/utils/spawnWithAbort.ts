import type { SpawnOptions, StdioOptions } from 'node:child_process';
import spawn from 'cross-spawn';
import { logger } from '@/ui/logger';
import { killProcessByChildProcess } from '@/utils/process';

const DEFAULT_ABORT_EXIT_CODES = [130, 137, 143];
const DEFAULT_ABORT_SIGNALS: NodeJS.Signals[] = ['SIGTERM'];

const isAbortError = (error: unknown): boolean => {
    if (!error || typeof error !== 'object') {
        return false;
    }
    const maybeError = error as { name?: string; code?: string };
    return maybeError.name === 'AbortError' || maybeError.code === 'ABORT_ERR';
};

export type SpawnWithAbortOptions = {
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    signal: AbortSignal;
    logLabel: string;
    spawnName: string;
    installHint: string;
    abortKillTimeoutMs?: number;
    abortExitCodes?: number[];
    abortSignals?: NodeJS.Signals[];
    includeCause?: boolean;
    logExit?: boolean;
    shell?: SpawnOptions['shell'];
    stdio?: StdioOptions;
    windowsHide?: SpawnOptions['windowsHide'];
    /**
     * Keeps the agent's own error output and puts it into the failure.
     *
     * The agent says why it refused to start ("the session does not exist",
     * "you are not signed in"), and that sentence is the only thing the user
     * can act on. The output is still written to the terminal, so nothing is
     * hidden from the user.
     */
    captureStderr?: boolean;
};

/** How much of the agent's error output is kept. */
const MAX_CAPTURED_STDERR_BYTES = 8 * 1024;

export async function spawnWithAbort(options: SpawnWithAbortOptions): Promise<void> {
    const abortKillTimeoutMs = options.abortKillTimeoutMs ?? 5000;
    const abortExitCodes = options.abortExitCodes ?? DEFAULT_ABORT_EXIT_CODES;
    const abortSignals = options.abortSignals ?? DEFAULT_ABORT_SIGNALS;
    const stdio = options.stdio ?? (options.captureStderr
        ? ['inherit', 'inherit', 'pipe']
        : ['inherit', 'inherit', 'inherit']);
    const logPrefix = options.logLabel ? `[${options.logLabel}] ` : '';

    const logDebug = (message: string, ...args: unknown[]) => {
        logger.debug(`${logPrefix}${message}`, ...args);
    };

    /** The last thing the agent said before it gave up. */
    let capturedStderr = '';
    const captureStderrLine = (chunk: Buffer | string) => {
        const text = chunk.toString();
        // The user still sees everything the agent says.
        process.stderr.write(text);
        if (capturedStderr.length < MAX_CAPTURED_STDERR_BYTES) {
            capturedStderr = (capturedStderr + text).slice(0, MAX_CAPTURED_STDERR_BYTES);
        }
    };
    /** The agent's own words, on one line. */
    const stderrSummary = () => {
        const trimmed = capturedStderr.trim();
        if (!trimmed) return '';
        const lastLine = trimmed.split('\n').map((line) => line.trim()).filter(Boolean).pop() ?? '';
        return lastLine.length > 300 ? `${lastLine.slice(0, 300)}…` : lastLine;
    };

    await new Promise<void>((resolve, reject) => {
        // Note: We intentionally do NOT pass signal to spawn() because Node.js's
        // built-in abort handling only kills the direct child, not grandchildren.
        // Instead, we handle abort ourselves using killProcessByChildProcess which
        // kills the entire process tree to prevent orphan processes.
        const child = spawn(options.command, options.args, {
            stdio,
            cwd: options.cwd,
            env: options.env,
            shell: options.shell,
            windowsHide: options.windowsHide ?? process.platform === 'win32'
        });

        let abortKillTimeout: NodeJS.Timeout | null = null;

        if (options.captureStderr) {
            child.stderr?.on('data', captureStderrLine);
        }

        const abortHandler = () => {
            if (abortKillTimeout) {
                return;
            }
            // First, try graceful termination of entire process tree
            if (child.exitCode === null && !child.killed) {
                logDebug(`Abort signal received, killing process tree (pid=${child.pid}) with SIGTERM`);
                // Note: We don't await here because we're in a sync callback,
                // but killProcessByChildProcess now waits for processes to die internally
                void killProcessByChildProcess(child, false);
            }
            // Set timeout for forceful kill if graceful doesn't work
            abortKillTimeout = setTimeout(() => {
                if (child.exitCode === null && !child.killed) {
                    logDebug('Abort timeout reached, sending SIGKILL');
                    try {
                        void killProcessByChildProcess(child, true);
                    } catch (error) {
                        logDebug('Failed to send SIGKILL', error);
                    }
                }
            }, abortKillTimeoutMs);
        };

        if (options.signal.aborted) {
            abortHandler();
        } else {
            options.signal.addEventListener('abort', abortHandler);
        }

        const cleanupAbortHandler = () => {
            if (abortKillTimeout) {
                clearTimeout(abortKillTimeout);
                abortKillTimeout = null;
            }
            options.signal.removeEventListener('abort', abortHandler);
        };

        child.on('error', (error) => {
            cleanupAbortHandler();
            if (options.signal.aborted && isAbortError(error)) {
                logDebug('Spawn aborted while switching');
                if (!child.pid) {
                    resolve();
                }
                return;
            }
            if (options.signal.aborted) {
                resolve();
                return;
            }
            const message = error instanceof Error ? error.message : String(error);
            const errorMessage = `Failed to spawn ${options.spawnName}: ${message}. ` +
                `Is ${options.installHint} installed and on PATH?`;
            if (options.includeCause) {
                reject(new Error(errorMessage, { cause: error }));
            } else {
                reject(new Error(errorMessage));
            }
        });

        child.on('exit', (code, signal) => {
            cleanupAbortHandler();
            if (options.logExit) {
                logDebug(`Child exited (code=${code ?? 'null'}, signal=${signal ?? 'null'}, aborted=${options.signal.aborted})`);
            }
            if (options.signal.aborted && signal && abortSignals.includes(signal)) {
                resolve();
                return;
            }
            if (options.signal.aborted && typeof code === 'number' && abortExitCodes.includes(code)) {
                resolve();
                return;
            }
            // When abort was explicitly requested, treat any exit code as expected
            if (options.signal.aborted) {
                logDebug(`Process exited with code=${code ?? 'null'} after abort, treating as expected`);
                resolve();
                return;
            }
            if (signal) {
                reject(new Error(`Process terminated with signal: ${signal}`));
                return;
            }
            if (typeof code === 'number' && code !== 0) {
                const said = stderrSummary();
                reject(new Error(said
                    ? `Process exited with code: ${code}. ${said}`
                    : `Process exited with code: ${code}`));
                return;
            }
            resolve();
        });
    });
}

