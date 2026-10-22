import type { AgentFlavor } from '@hapi/protocol'

/**
 * How a user signs in to an agent, for the agents that have a login command.
 *
 * The ACP transport reads the standard error of every agent, so a message that
 * names one agent's login command would be wrong for all the others: a user
 * whose MiniMax Code session refused an authentication would be told to run
 * `gemini auth login`.
 */
export function authHintForFlavor(flavor?: AgentFlavor | null): string | null {
    switch (flavor) {
        case 'gemini':
            return 'run "gemini auth login"'
        case 'mcode':
            return 'run "mcode login" on the machine'
        default:
            return null
    }
}

/**
 * The message for a failed authentication.
 *
 * The hint names the command of the agent that failed, so the user is sent to
 * the right place.
 */
export function authenticationFailedMessage(flavor?: AgentFlavor | null): string {
    const hint = authHintForFlavor(flavor)
    return hint
        ? `Authentication failed. Please check your credentials or ${hint}.`
        : 'Authentication failed. Please check your credentials.'
}
