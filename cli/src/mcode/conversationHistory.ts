import type { AcpSdkBackend } from '@/agent/backends/acp/AcpSdkBackend'
import type { Metadata } from '@/api/types'
import {
    MCODE_CONVERSATION_HISTORY_INITIAL,
    markSupported,
    markUnsupported,
    type ConversationHistoryCapabilityStates
} from '@hapi/protocol/conversationHistory'
import type { ForkConversationRpcResult } from '@hapi/protocol/apiTypes'

/**
 * MiniMax Code's conversation history controls.
 *
 * The agent forks the whole session: its `session/fork` takes the same
 * parameters as `session/load`, so there is no "fork at this message" and no
 * way to rewind to one. Both start out unsupported - the agent exposes no
 * such method - and only `forkCurrent` can ever be enabled.
 */
export class McodeConversationHistory {
    private states: ConversationHistoryCapabilityStates = { ...MCODE_CONVERSATION_HISTORY_INITIAL }
    private sessionId: string | null = null
    private cwd: string | null = null
    private busy = false
    private publishCapabilities: (() => Promise<void>) | null = null

    constructor(private readonly getBackend: () => AcpSdkBackend | null) {}

    setPublishCapabilities(fn: () => Promise<void>): void {
        this.publishCapabilities = fn
    }

    /**
     * Whether the agent is in the middle of a turn.
     *
     * MiniMax Code forks at the latest message boundary, and that boundary
     * only exists once a turn has ended - forking mid-turn fails inside the
     * agent. Refusing here keeps the failure a clear message instead of an
     * opaque protocol error.
     */
    setBusy(busy: boolean): void {
        this.busy = busy
    }

    setSession(sessionId: string | null, cwd: string | null): void {
        this.sessionId = sessionId
        this.cwd = cwd
    }

    getCapabilityStates(): ConversationHistoryCapabilityStates {
        return this.states
    }

    getCapabilitiesForMetadata(): Metadata['capabilities'] {
        // Explicit false flags, not just "nothing to say": a session that ran
        // an older agent build must not keep a stale "fork supported" in its
        // metadata, because the metadata merge never deletes keys.
        return {
            conversationHistory: {
                forkCurrent: this.states.forkCurrent === 'supported',
                forkAtMessage: false,
                rewindToMessage: false
            }
        };
    }

    /**
     * Drops the history controls.
     *
     * The controls belong to the agent process that just went away: the local
     * TUI cannot fork, so the web must not keep offering a Fork button that
     * can only fail. The state is dropped as well as published, so a later
     * publish does not resurrect the stale capability.
     */
    async disable(): Promise<void> {
        this.states = markUnsupported(this.states, 'forkCurrent');
        await this.publishCapabilities?.();
    }

    /**
     * Records what the agent can do, once the handshake has been answered.
     *
     * The agent lists `fork` in `agentCapabilities.sessionCapabilities`, so
     * the answer comes from the initialize response - probing by actually
     * forking would leave a stray session behind on every check.
     */
    async probeCapabilities(): Promise<void> {
        const backend = this.getBackend()
        if (!backend) return
        if (backend.supportsSessionFork()) {
            this.states = markSupported(this.states, 'forkCurrent')
        } else {
            this.states = markUnsupported(this.states, 'forkCurrent')
        }
        await this.publishCapabilities?.()
    }

    /**
     * Forks the session.
     *
     * The fork is the whole conversation: MiniMax Code offers no way to
     * branch at a specific message, so a message-local fork is refused
     * rather than silently answered with a fork of the current state.
     */
    async fork(messageLocalId?: string): Promise<ForkConversationRpcResult> {
        if (this.busy) {
            throw new Error('MiniMax Code is still working on a turn; fork it once the turn ends')
        }
        if (messageLocalId) {
            throw new Error('Historical fork is not supported for MiniMax Code')
        }
        // The agent did not advertise session/fork: do not call a method the
        // agent never claimed to have.
        if (this.states.forkCurrent === 'unsupported') {
            throw new Error('MiniMax Code does not support forking a session')
        }
        const backend = this.getBackend()
        const sessionId = this.sessionId
        const cwd = this.cwd
        if (!backend || !sessionId || !cwd) throw new Error('MiniMax Code session is not ready')

        let response: unknown
        try {
            response = await backend.sendExtensionRequest<unknown>('session/fork', {
                sessionId,
                cwd,
                mcpServers: []
            })
        } catch (error) {
            if (isMethodNotFound(error)) {
                this.states = markUnsupported(this.states, 'forkCurrent')
                await this.publishCapabilities?.()
            }
            throw describeForkError(error)
        }

        const nativeSessionId = asString(readRecord(response)?.sessionId)
        if (!nativeSessionId) {
            throw new Error('MiniMax Code session/fork did not return a session id')
        }
        this.states = markSupported(this.states, 'forkCurrent')
        await this.publishCapabilities?.()
        return { nativeSessionId }
    }
}

function isMethodNotFound(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error)
    return /method not found|-32601|unknown method/i.test(message)
}

/**
 * Turns the agent's boundary error into something a user can act on.
 *
 * The agent forks at the latest message boundary, which only exists at the
 * end of a finished turn. Its raw error (`boundary-not-found`, and the
 * `invalid-boundary` spellings around it) does not say that.
 */
function describeForkError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error)
    if (/boundary-not-found|boundary-invalid|invalid-boundary/i.test(message)) {
        return new Error('MiniMax Code can only fork at the end of a finished turn')
    }
    return error instanceof Error ? error : new Error(message)
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null
}

function readRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}
