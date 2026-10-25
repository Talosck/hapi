/**
 * The error a Pi RPC raises when the agent did not answer in time.
 *
 * It lives in its own module so that every consumer can recognize it without
 * importing the transport loop: `loop.ts` raises it, and the conversation
 * history has to tell a timeout apart from an ordinary rejection.
 */
export class PiRpcTimeoutError extends Error {
    readonly command: string;
    readonly requestId: number;
    readonly timeoutMs: number;

    constructor(command: string, requestId: number, timeoutMs: number) {
        super(`Pi RPC ${command} (id=${requestId}) timed out after ${timeoutMs}ms`);
        this.name = 'PiRpcTimeoutError';
        this.command = command;
        this.requestId = requestId;
        this.timeoutMs = timeoutMs;
    }
}
