import { formatMcodeModelLabel } from '@hapi/protocol'
import type { McodeModelSummary } from '@/types/api'
import type { AgentType } from './types'

export function shouldEnableMcodeModelDiscovery(args: {
    agent: AgentType
    machineId: string | null
    cwd: string
    cwdExists: boolean | undefined
}): boolean {
    return args.agent === 'mcode'
        && Boolean(args.machineId)
        && args.cwd.length > 0
        && args.cwdExists === true
}

/**
 * Whether a MiniMax Code model selection has to fall back to the default.
 *
 * A model the agent does not publish cannot be selected, so the form falls
 * back to "Default". The catalog has to be known first: an empty catalog
 * means the agent published no model at all, not that the selection is
 * wrong.
 */
export function shouldResetMcodeModel(args: {
    agent: AgentType
    cwdExists: boolean | undefined
    isLoading: boolean
    error: string | null
    availableModels: McodeModelSummary[]
    model: string
}): boolean {
    return args.agent === 'mcode'
        && args.cwdExists === true
        && !args.isLoading
        && !args.error
        && args.availableModels.length > 0
        && args.model !== 'auto'
        && !args.availableModels.some((candidate) => candidate.modelId === args.model)
}

/**
 * MiniMax Code options for the create-session selector: Default plus one
 * entry per discovered model. `value` is the agent's ACP wire model id
 * (`m:...:v:` or `m:...:v:<variant>`), which is what
 * `session/set_config_option` expects; the label shows the human-readable
 * model name.
 *
 * The default is worth more than the label here: this picker sends the value
 * it holds, and the form sends `'auto'` for the agent's own default. That is
 * the form's sentinel, and the form turns it into `null` before it starts
 * the session.
 */
export function buildMcodeModelOptions(
    availableModels: McodeModelSummary[],
    defaultLabel: string = 'Default'
): Array<{ value: string; label: string }> {
    return [
        { value: 'auto', label: defaultLabel },
        ...availableModels.map((model) => ({
            value: model.modelId,
            // The name the agent publishes is the one the user knows. A model
            // without a name still gets a readable label - the wire id is
            // never shown as one.
            label: model.name ?? formatMcodeModelLabel(model.modelId) ?? model.modelId
        }))
    ]
}

/**
 * MiniMax Code options for the model picker of a running session.
 *
 * The list is the same, but the default is not: this picker sends the value
 * it holds, and the hub records `null` for a session that runs on the agent's
 * default model. The form's `'auto'` is a name the agent cannot resolve, and
 * a session that sends it would leave the agent without a model.
 */
export function buildMcodeSessionModelOptions(
    availableModels: McodeModelSummary[],
    defaultLabel: string = 'Default'
): Array<{ value: string | null; label: string }> {
    return [
        { value: null, label: defaultLabel },
        ...availableModels.map((model) => ({
            value: model.modelId,
            // The name the agent publishes is the one the user knows. A model
            // without a name still gets a readable label - the wire id is
            // never shown as one.
            label: model.name ?? formatMcodeModelLabel(model.modelId) ?? model.modelId
        }))
    ]
}
