/**
 * Why MiniMax Code could not be started.
 *
 * The three reasons lead to three different actions, so the user has to be
 * told which one it is: install the agent, sign in, or look at the agent's own
 * output. Without the distinction the session just goes quiet, and the user
 * is left with a grey box.
 */
export type McodeConnectFailureReason = 'not_installed' | 'not_signed_in' | 'unknown'

export type McodeConnectFailure = {
    reason: McodeConnectFailureReason
    /** The message the user reads. */
    message: string
    /** The message the agent produced, kept for the log. */
    detail: string
}

const NOT_INSTALLED_PATTERN = /ENOENT|Failed to spawn|is not installed|not found on PATH|command not found/i

const NOT_SIGNED_IN_PATTERN = new RegExp([
    'unauthenticated',
    'unauthorized',
    'authentication',
    'not logged in',
    'not signed in',
    'sign in',
    'log in',
    'login required',
    'invalid[_ ]api[_ ]key',
    '\\b401\\b',
    '\\b403\\b'
].join('|'), 'i')

/** Everything the failure knows about itself. */
function failureText(error: unknown): string {
    if (!error) return ''
    if (typeof error === 'string') return error
    if (typeof error !== 'object') return String(error)

    const parts: string[] = []
    const record = error as { message?: unknown; stderr?: unknown; data?: unknown; cause?: unknown }
    if (typeof record.message === 'string') parts.push(record.message)
    if (typeof record.stderr === 'string') parts.push(record.stderr)
    if (record.data && typeof record.data === 'object') {
        const details = (record.data as { details?: unknown }).details
        if (typeof details === 'string') parts.push(details)
    }
    if (record.cause) parts.push(failureText(record.cause))
    return parts.join('\n')
}

/** A short form of the failure, for the log and the archive reason. */
function failureDetail(error: unknown): string {
    const text = failureText(error).trim()
    if (!text) return 'the agent gave no reason'
    const firstLine = text.split('\n').find((line) => line.trim().length > 0) ?? text
    return firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine
}

/**
 * Reads the reason out of a failure to start the agent.
 *
 * The agent itself says what is wrong on its standard error - it knows the
 * difference between "I am not installed" and "I am not signed in" - so the
 * failure is read instead of guessed from the exit code.
 */
export function classifyMcodeConnectFailure(error: unknown): McodeConnectFailure {
    const text = failureText(error)
    const detail = failureDetail(error)

    if (NOT_INSTALLED_PATTERN.test(text)) {
        return {
            reason: 'not_installed',
            message: 'MiniMax Code is not installed on this machine. Install it, make sure "mcode" is on PATH, and start the session again.',
            detail,
        }
    }

    if (NOT_SIGNED_IN_PATTERN.test(text)) {
        return {
            reason: 'not_signed_in',
            message: 'MiniMax Code is not signed in on this machine. Run "mcode login" there, and start the session again.',
            detail,
        }
    }

    return {
        reason: 'unknown',
        message: `MiniMax Code could not be started: ${detail}`,
        detail,
    }
}

/** The short form of a failure, for the archive reason of the session. */
export function mcodeConnectFailureArchiveReason(failure: McodeConnectFailure): string {
    switch (failure.reason) {
        case 'not_installed':
            return 'MiniMax Code is not installed'
        case 'not_signed_in':
            return 'MiniMax Code is not signed in'
        default:
            return 'MiniMax Code crashed'
    }
}
