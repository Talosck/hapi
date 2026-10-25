import { PiRpcTimeoutError } from './piRpcTimeout'

/**
 * Whether an error is a Pi RPC timeout.
 *
 * The type is the contract, not the message: a matcher built on the message
 * text misses the errors that carry no request id (the abort-lock path
 * constructs one with the id `-1`), and it breaks silently whenever the
 * message format changes. The error name is checked as well so that adapters
 * and test doubles that do not construct the real class are still recognized.
 */
export function isPiRpcTimeout(error: unknown): boolean {
    if (error instanceof PiRpcTimeoutError) return true
    return error instanceof Error && error.name === 'PiRpcTimeoutError'
}
