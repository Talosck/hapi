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
 * (`m:...:u` or `m:...:v:<variant>`), which is what
 * `session/set_config_option` expects; the label shows the human-readable
 * model name.
 */
export function buildMcodeModelOptions(
    availableModels: McodeModelSummary[]
): Array<{ value: string; label: string }> {
    return [
        { value: 'auto', label: 'Default' },
        ...availableModels.map((model) => ({
            value: model.modelId,
            label: model.name ?? model.modelId
        }))
    ]
}
