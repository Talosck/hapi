import { AcpSdkBackend } from '@/agent/backends/acp';
import { getAgentLaunchCommand } from '@/agent/agentLaunchCommand';

/** Config option id MiniMax Code uses for its tool permission policy. */
export const MCODE_PERMISSION_CONFIG_ID = 'permissionMode';

/** Category the MiniMax Code permission config option is published under. */
export const MCODE_PERMISSION_CONFIG_CATEGORY = '_permission';

/** ACP session mode ids MiniMax Code advertises on `session/new`. */
export const MCODE_SESSION_MODE_DEFAULT = 'default';
export const MCODE_SESSION_MODE_PLAN = 'plan';

function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (value !== undefined) {
            result[key] = value;
        }
    }
    return result;
}

/**
 * Creates the ACP backend for `mcode acp`.
 *
 * MiniMax Code publishes its model catalog and permission policy as ACP
 * *config options* rather than through `session/set_model` (which the agent
 * does not implement), so the launcher drives them through
 * `session/set_config_option`.
 */
export function createMcodeBackend(): AcpSdkBackend {
    return new AcpSdkBackend({
        command: getAgentLaunchCommand('mcode'),
        args: ['acp'],
        env: filterEnv(process.env),
        // MiniMax Code emits true `agent_message_chunk` deltas. The default
        // overlap dedupe drops a chunk that happens to be a suffix of the
        // text buffered so far, which would silently truncate the answer.
        textChunkMode: 'delta',
        flavor: 'mcode',
        // MiniMax Code routes its `ask_user` tool through an ACP
        // `elicitation/create` form request only when the client advertises
        // form elicitation. Without it the questionnaire is dismissed silently
        // because the one-shot permission fallback cannot represent multi-step
        // questions or "Other" input.
        elicitation: { form: true },
    });
}
