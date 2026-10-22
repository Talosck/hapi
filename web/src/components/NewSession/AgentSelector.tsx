import { getFlavorLabel } from '@hapi/protocol'
import type { AgentAvailabilityReason } from '@hapi/protocol'
import type { AgentType } from './types'
import { AgentFlavorIcon } from '@/components/AgentFlavorIcon'
import { useTranslation } from '@/lib/use-translation'

export type UnavailableAgent = {
    agent: AgentType
    reason?: AgentAvailabilityReason
}

export function AgentSelector(props: {
    agent: AgentType
    agents: readonly AgentType[]
    /** The agents that are on the machine but cannot be used, and why. */
    unavailableAgents?: readonly UnavailableAgent[]
    isDisabled: boolean
    onAgentChange: (value: AgentType) => void
}) {
    const { t } = useTranslation()

    return (
        <div className="flex flex-col gap-1.5 px-3 py-3">
            <label className="text-xs font-medium text-[var(--app-hint)]">
                {t('newSession.agent')}
            </label>
            <div className="flex flex-wrap gap-x-3 gap-y-2">
                {props.agents.map((agentType) => (
                    <label
                        key={agentType}
                        className="flex items-center gap-1.5 cursor-pointer"
                    >
                        <input
                            type="radio"
                            name="agent"
                            value={agentType}
                            checked={props.agent === agentType}
                            onChange={() => props.onAgentChange(agentType)}
                            disabled={props.isDisabled}
                            className="accent-[var(--app-link)]"
                        />
                        <AgentFlavorIcon flavor={agentType} className="h-4 w-4 shrink-0" />
                        <span className="text-sm">{getFlavorLabel(agentType)}</span>
                    </label>
                ))}
            </div>
            {props.unavailableAgents && props.unavailableAgents.length > 0 ? (
                // An agent that is missing is the reason a user cannot pick it.
                // Without the reason, the list just looks short.
                <div className="flex flex-col gap-0.5 text-xs text-[var(--app-hint)]">
                    {props.unavailableAgents.map((entry) => (
                        <div key={entry.agent} className="flex items-center gap-1.5">
                            <AgentFlavorIcon flavor={entry.agent} className="h-3.5 w-3.5 shrink-0 opacity-50" />
                            <span>
                                {getFlavorLabel(entry.agent)}: {unavailableReasonLabel(entry.reason, t)}
                            </span>
                        </div>
                    ))}
                </div>
            ) : null}
        </div>
    )
}

/** The reason an agent cannot be used, in the language of the client. */
export function unavailableReasonLabel(
    reason: AgentAvailabilityReason | undefined,
    t: (key: string) => string,
): string {
    if (reason === 'not_signed_in') return t('newSession.agentUnavailable.notSignedIn')
    if (reason === 'invalid_configuration') return t('newSession.agentUnavailable.invalidConfiguration')
    return t('newSession.agentUnavailable.notFound')
}
