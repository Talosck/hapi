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
 * MiniMax Code options for the create-session selector: Default plus one
 * entry per discovered model. `value` is the agent's ACP wire model id
 * (`m:<provider>:<model>:v:<variant>`), which is what `session/set_config_option`
 * expects; the label shows the human-readable model name.
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
