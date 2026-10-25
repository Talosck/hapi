import {
    getCodexCollaborationModeLabel,
    getCopilotAgentModeLabel,
    getPermissionModeTone,
    isPermissionModeAllowedForFlavor
} from '@hapi/protocol'
import type { PermissionModeTone } from '@hapi/protocol'
import * as Popover from '@radix-ui/react-popover'
import { useEffect, useMemo, useState } from 'react'
import type { AgentState, CodexCollaborationMode, MinimaxQuotaWindow, PermissionMode } from '@/types/api'
import type { ConversationStatus } from '@/realtime/types'
import { getContextBudgetTokens } from '@/chat/modelConfig'
import { permissionModeLabelForAgent } from '@/lib/permissionModeLabels'
import {
    formatReasoningLabel,
    formatCompactReasoningLabel,
    getReasoningEffortForFlavor,
    shouldShowReasoningStatusLabel
} from '@/lib/codexStatusLabels'
import { isFastServiceTier } from './codexFastMode'
import { useTranslation } from '@/lib/use-translation'
import { useSessionHeaderMetadata } from '@/hooks/useSessionHeaderMetadata'

// Vibing messages for thinking state
const VIBING_MESSAGES = [
    "Accomplishing", "Actioning", "Actualizing", "Baking", "Booping", "Brewing",
    "Calculating", "Cerebrating", "Channelling", "Churning", "Clauding", "Coalescing",
    "Cogitating", "Computing", "Combobulating", "Concocting", "Conjuring", "Considering",
    "Contemplating", "Cooking", "Crafting", "Creating", "Crunching", "Deciphering",
    "Deliberating", "Determining", "Discombobulating", "Divining", "Doing", "Effecting",
    "Elucidating", "Enchanting", "Envisioning", "Finagling", "Flibbertigibbeting",
    "Forging", "Forming", "Frolicking", "Generating", "Germinating", "Hatching",
    "Herding", "Honking", "Ideating", "Imagining", "Incubating", "Inferring",
    "Manifesting", "Marinating", "Meandering", "Moseying", "Mulling", "Mustering",
    "Musing", "Noodling", "Percolating", "Perusing", "Philosophising", "Pontificating",
    "Pondering", "Processing", "Puttering", "Puzzling", "Reticulating", "Ruminating",
    "Scheming", "Schlepping", "Shimmying", "Simmering", "Smooshing", "Spelunking",
    "Spinning", "Stewing", "Sussing", "Synthesizing", "Thinking", "Tinkering",
    "Transmuting", "Unfurling", "Unravelling", "Vibing", "Wandering", "Whirring",
    "Wibbling", "Wizarding", "Working", "Wrangling"
]

const PERMISSION_TONE_CLASSES: Record<PermissionModeTone, string> = {
    neutral: 'text-[var(--app-hint)]',
    info: 'text-blue-500',
    warning: 'text-amber-500',
    danger: 'text-red-500'
}

const CONTEXT_WARNING_THRESHOLD_PERCENT = 70
const CONTEXT_DANGER_THRESHOLD_PERCENT = 90

/**
 * The share of the account's five hour window that still counts as room.
 *
 * Below it the window is on its way out, so the label warns and the time to
 * the reset joins it.
 */
const QUOTA_WARNING_PERCENT = 40
const QUOTA_DANGER_PERCENT = 20

function getConnectionStatus(
    active: boolean,
    thinking: boolean,
    agentState: AgentState | null | undefined,
    voiceStatus: ConversationStatus | undefined,
    backgroundTaskCount: number,
    t: (key: string, params?: Record<string, string | number>) => string
): { text: string; color: string; dotColor: string; isPulsing: boolean } {
    const hasPermissions = agentState?.requests && Object.keys(agentState.requests).length > 0

    // Voice connecting takes priority
    if (voiceStatus === 'connecting') {
        return {
            text: t('voice.connecting'),
            color: 'text-[#007AFF]',
            dotColor: 'bg-[#007AFF]',
            isPulsing: true
        }
    }

    if (!active) {
        return {
            text: t('misc.offline'),
            color: 'text-[#999]',
            dotColor: 'bg-[#999]',
            isPulsing: false
        }
    }

    if (hasPermissions) {
        return {
            text: t('misc.permissionRequired'),
            color: 'text-[#FF9500]',
            dotColor: 'bg-[#FF9500]',
            isPulsing: true
        }
    }

    if (thinking) {
        const vibingMessage = VIBING_MESSAGES[Math.floor(Math.random() * VIBING_MESSAGES.length)].toLowerCase() + '…'
        return {
            text: vibingMessage,
            color: 'text-[#007AFF]',
            dotColor: 'bg-[#007AFF]',
            isPulsing: true
        }
    }

    if (backgroundTaskCount > 0) {
        return {
            text: t(
                backgroundTaskCount === 1
                    ? 'session.status.backgroundTasks.count.one'
                    : 'session.status.backgroundTasks.count.other',
                { count: backgroundTaskCount }
            ),
            color: 'text-[#007AFF]',
            dotColor: 'bg-[#007AFF]',
            isPulsing: true
        }
    }

    return {
        text: t('misc.online'),
        color: 'text-[#34C759]',
        dotColor: 'bg-[#34C759]',
        isPulsing: false
    }
}

export function getContextWarning(contextSize: number, maxContextSize: number): { color: string } {
    const percentageUsed = (contextSize / maxContextSize) * 100

    if (percentageUsed >= CONTEXT_DANGER_THRESHOLD_PERCENT) {
        return { color: 'text-red-500' }
    } else if (percentageUsed >= CONTEXT_WARNING_THRESHOLD_PERCENT) {
        return { color: 'text-amber-500' }
    } else {
        return { color: 'text-[var(--app-hint)]' }
    }
}

function formatTokenCount(value: number): string {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
    if (value >= 1_000) return `${Math.round(value / 1_000)}k`
    return String(value)
}

function getContextPercentages(contextSize: number, maxContextSize: number): {
    usedPercentage: number
    remainingPercentage: number
} {
    const usedPercentage = Math.min(100, Math.max(0, Math.round((contextSize / maxContextSize) * 100)))
    return { usedPercentage, remainingPercentage: 100 - usedPercentage }
}

export function formatContextUsageLabel(contextSize: number, maxContextSize: number | null | undefined): string {
    if (!maxContextSize) return `${formatTokenCount(contextSize)} used`
    const { usedPercentage } = getContextPercentages(contextSize, maxContextSize)
    return `${usedPercentage}% · ${formatTokenCount(contextSize)} / ${formatTokenCount(maxContextSize)}`
}

export function formatCompactContextUsageLabel(contextSize: number, maxContextSize: number | null | undefined): string {
    if (!maxContextSize) return `ctx ${formatTokenCount(contextSize)}`
    const { remainingPercentage } = getContextPercentages(contextSize, maxContextSize)
    return `ctx ${formatTokenCount(maxContextSize)} (${remainingPercentage}% left)`
}

/**
 * The label of a session that has not run a turn yet.
 *
 * The window is the budget the first turn is measured against, so it is worth
 * showing before there is a usage number to put next to it.
 */
export function formatContextWindowLabel(maxContextSize: number | null | undefined): string | null {
    if (!maxContextSize) return null
    return `ctx ${formatTokenCount(maxContextSize)}`
}

export function getContextUsageDetails(
    contextSize: number,
    maxContextSize: number | null | undefined,
    contextCacheRead: number | null | undefined
): {
    cacheRead: string | null
    used: string
    usedPercentage: number | null
    remaining: string | null
    remainingPercentage: number | null
} {
    if (!maxContextSize) {
        return {
            cacheRead: contextCacheRead && contextCacheRead > 0 ? formatTokenCount(contextCacheRead) : null,
            used: formatTokenCount(contextSize),
            usedPercentage: null,
            remaining: null,
            remainingPercentage: null
        }
    }

    const { usedPercentage, remainingPercentage } = getContextPercentages(contextSize, maxContextSize)
    return {
        cacheRead: contextCacheRead && contextCacheRead > 0 ? formatTokenCount(contextCacheRead) : null,
        used: formatTokenCount(contextSize),
        usedPercentage,
        remaining: formatTokenCount(Math.max(0, maxContextSize - contextSize)),
        remainingPercentage
    }
}

export function shouldShowCodexFastBadge(
    agentFlavor: string | null | undefined,
    serviceTier: string | null | undefined
): boolean {
    return agentFlavor === 'codex' && isFastServiceTier(serviceTier)
}

/**
 * The label of the account's five hour window.
 *
 * Short on purpose: it sits next to the context usage, which is short too.
 * The agent words it the same way.
 *
 * A window that is running low is the moment the time to the reset matters:
 * the share says how much is left, the countdown says when there is more. A
 * window with room to spare keeps the short label.
 */
export function formatQuotaLabel(quota: MinimaxQuotaWindow, now: number = Date.now()): string {
    if (quota.unlimited) return '5h ∞'
    if (quota.remainingPercent === null) return '5h —'
    const label = `5h ${quota.remainingPercent}%`
    if (quota.remainingPercent > QUOTA_WARNING_PERCENT) return label
    const left = quota.resetAtMs === null ? null : quota.resetAtMs - now
    if (left === null || left <= 0) return label
    return `${label} · ${formatQuotaCountdown(left)}`
}

/**
 * The time left until the window resets.
 *
 * The agent counts the same way: minutes below an hour, then hours and
 * minutes, then days and hours. The seconds are left out on purpose - the
 * countdown is read at a glance, and a ticking second is noise there.
 */
export function formatQuotaCountdown(ms: number): string {
    const minutes = Math.ceil(ms / 60_000)
    if (minutes < 60) return `${minutes}m`
    if (minutes < 1440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
    return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`
}

/**
 * The color of the quota label.
 *
 * The window is the one that runs out: a low share has to be visible at a
 * glance, the same way a full context window is.
 */
export function getQuotaWarning(remainingPercent: number | null): { color: string } {
    if (remainingPercent === null) return { color: 'text-[var(--app-hint)]' }
    if (remainingPercent <= QUOTA_DANGER_PERCENT) return { color: 'text-red-500' }
    if (remainingPercent <= QUOTA_WARNING_PERCENT) return { color: 'text-amber-500' }
    return { color: 'text-[var(--app-hint)]' }
}

/**
 * The details of the five hour window.
 *
 * The countdown only has to move while this is open - the label next to the
 * context usage carries the share, not the time.
 *
 * The chip itself stays English (`5h 42%`), but the popover speaks the
 * reader's language, the same way the context popover does.
 */
function QuotaDetails(props: { quota: MinimaxQuotaWindow; now: number }) {
    const { t } = useTranslation()

    const left = props.quota.resetAtMs === null ? null : props.quota.resetAtMs - props.now

    return (
        <div className="flex max-w-[min(22rem,calc(100vw-1rem))] flex-col gap-1 text-xs leading-tight text-[var(--app-fg)]">
            <span className="break-words">
                {props.quota.unlimited
                    ? t('misc.quotaUnlimited')
                    : props.quota.remainingPercent !== null
                        ? t('misc.quotaRemaining', { percent: props.quota.remainingPercent })
                        : t('misc.quotaUnknown')}
            </span>
            {left !== null ? (
                <span className="break-words">
                    {left <= 0
                        ? t('misc.quotaResetPending')
                        : t('misc.quotaResetsIn', { duration: formatQuotaCountdown(left) })}
                </span>
            ) : null}
        </div>
    )
}

export function StatusBar(props: {
    active: boolean
    thinking: boolean
    agentState: AgentState | null | undefined
    backgroundTaskCount?: number
    contextSize?: number
    contextCacheRead?: number
    contextWindow?: number | null
    /**
     * Whether the size was measured from a whole turn rather than from a
     * single request.
     *
     * A turn's usage is the sum of every request it made, so it grows with
     * the number of requests and can exceed the window even when the context
     * never came close to it. It is a processing volume, not a context size,
     * so the status bar shows the window alone for it.
     */
    contextSizeIsTurnTotal?: boolean
    /**
     * Model to use for the context-window fallback heuristic when
     * contextWindow is absent. Falls back to `model`. Callers pass the
     * usage-bearing message's own model here so local Claude sessions (whose
     * session.model is often null) still resolve a plausible window.
     */
    contextModel?: string | null
    model?: string | null
    modelReasoningEffort?: string | null
    effort?: string | null
    serviceTier?: string | null
    permissionMode?: PermissionMode
    collaborationMode?: CodexCollaborationMode
    copilotAgentMode?: import('@hapi/protocol').CopilotAgentMode
    agentFlavor?: string | null
    voiceStatus?: ConversationStatus
    /**
     * What is left of the account's five hour window.
     *
     * Shown next to the context usage: both are "how much room is left", and
     * the agent shows its own the same way.
     */
    quota?: MinimaxQuotaWindow | null
}) {
    const { t } = useTranslation()
    const { preferences: headerMetadata } = useSessionHeaderMetadata()
    const connectionStatus = useMemo(
        () => getConnectionStatus(props.active, props.thinking, props.agentState, props.voiceStatus, props.backgroundTaskCount ?? 0, t),
        [props.active, props.thinking, props.agentState, props.voiceStatus, props.backgroundTaskCount, t]
    )

    /**
     * The clock the countdowns are read against.
     *
     * The window resets at a moment, so the time left to it moves on its own.
     * The clock only ticks while there is a reset to count down to.
     */
    const [now, setNow] = useState(() => Date.now())
    const quotaResetAtMs = props.quota?.resetAtMs ?? null
    useEffect(() => {
        if (quotaResetAtMs === null) return
        // The window usually arrives long after the bar was mounted, so the
        // clock is read again as soon as there is a reset to count down to.
        setNow(Date.now())
        const timer = window.setInterval(() => setNow(Date.now()), 30_000)
        return () => window.clearInterval(timer)
    }, [quotaResetAtMs])

    const contextHeuristicModel = props.contextModel ?? props.model
    // The window the session is measured against. The agent reports it once a
    // turn has run; until then the budget of the flavor stands in.
    const contextMaxSize = useMemo(
        () => props.contextWindow ?? getContextBudgetTokens(contextHeuristicModel, props.agentFlavor),
        [props.contextWindow, contextHeuristicModel, props.agentFlavor]
    )
    /**
     * Whether the window is shown before the session has run a turn.
     *
     * MiniMax Code publishes its context window at the end of a turn, so the
     * budget of the flavor stands in until the agent reports its own. The
     * other flavors keep their window hidden until there is a usage to put
     * next to it.
     */
    const showsWindowWithoutUsage = props.agentFlavor === 'mcode'
    /**
     * Whether the measured size can be shown as a context size at all.
     *
     * A turn's usage is the sum of every request the turn made, so putting
     * it next to the window would report a context larger than the window
     * for a session that is barely using it. The window alone is the honest
     * thing to show.
     */
    const contextSizeIsContext = props.contextSize !== undefined && props.contextSizeIsTurnTotal !== true
    const contextWindowOnly = showsWindowWithoutUsage && props.contextSize === undefined && contextMaxSize !== null
    const contextWarning = useMemo(() => {
        if (!contextSizeIsContext) return null
        if (!contextMaxSize) return null
        return getContextWarning(props.contextSize!, contextMaxSize)
    }, [contextSizeIsContext, props.contextSize, contextMaxSize])
    const contextUsageLabel = useMemo(() => {
        if (!contextSizeIsContext) {
            return showsWindowWithoutUsage || props.contextSizeIsTurnTotal === true
                ? formatContextWindowLabel(contextMaxSize)
                : null
        }
        return formatContextUsageLabel(props.contextSize!, contextMaxSize)
    }, [contextSizeIsContext, props.contextSize, props.contextSizeIsTurnTotal, contextMaxSize, showsWindowWithoutUsage])
    const compactContextUsageLabel = useMemo(() => {
        if (!contextSizeIsContext) {
            return showsWindowWithoutUsage || props.contextSizeIsTurnTotal === true
                ? formatContextWindowLabel(contextMaxSize)
                : null
        }
        return formatCompactContextUsageLabel(props.contextSize!, contextMaxSize)
    }, [contextSizeIsContext, props.contextSize, props.contextSizeIsTurnTotal, contextMaxSize, showsWindowWithoutUsage])
    const contextUsageDetails = useMemo(() => {
        if (!contextSizeIsContext) {
            // Nothing has been measured yet, or the measurement is a turn's
            // processing volume rather than a context size: the window is all
            // there is to say.
            if (!showsWindowWithoutUsage && props.contextSizeIsTurnTotal !== true) return null
            if (!contextMaxSize) return null
            return {
                cacheRead: null,
                used: '0',
                usedPercentage: null,
                remaining: formatTokenCount(contextMaxSize),
                remainingPercentage: 100
            }
        }
        return getContextUsageDetails(props.contextSize!, contextMaxSize, props.contextCacheRead)
    }, [contextSizeIsContext, props.contextSize, props.contextCacheRead, props.contextSizeIsTurnTotal, contextMaxSize, showsWindowWithoutUsage])
    const contextUsedPercentage = contextUsageDetails?.usedPercentage ?? null

    const permissionMode = props.permissionMode
    // Copilot always shows permission (including Default) so model=auto sessions
    // still surface the bottom-right mode chip. Other flavors keep Codex-style
    // "hide default" parity.
    const displayPermissionMode = permissionMode
        && isPermissionModeAllowedForFlavor(permissionMode, props.agentFlavor)
        && (permissionMode !== 'default' || props.agentFlavor === 'copilot')
        ? permissionMode
        : null

    const permissionModeLabel = displayPermissionMode
        ? permissionModeLabelForAgent({ mode: displayPermissionMode, agent: props.agentFlavor, t })
        : null
    const permissionModeTone = displayPermissionMode ? getPermissionModeTone(displayPermissionMode) : null
    const permissionModeColor = permissionModeTone ? PERMISSION_TONE_CLASSES[permissionModeTone] : 'text-[var(--app-hint)]'
    const displayCollaborationMode = props.agentFlavor === 'codex' && props.collaborationMode === 'plan'
        ? props.collaborationMode
        : null
    const collaborationModeLabel = displayCollaborationMode
        ? getCodexCollaborationModeLabel(displayCollaborationMode)
        : null
    const displayCopilotAgentMode = props.agentFlavor === 'copilot'
        && props.copilotAgentMode
        && props.copilotAgentMode !== 'interactive'
        ? props.copilotAgentMode
        : null
    const copilotAgentModeLabel = displayCopilotAgentMode
        ? getCopilotAgentModeLabel(displayCopilotAgentMode)
        : null
    const reasoningEffort = getReasoningEffortForFlavor(
        props.agentFlavor,
        props.modelReasoningEffort,
        props.effort
    )
    const displaysReasoning = shouldShowReasoningStatusLabel(props.agentFlavor, reasoningEffort)
    const reasoningLabel = displaysReasoning
        ? formatReasoningLabel(reasoningEffort, headerMetadata.showLabels)
        : null
    const compactReasoningLabel = displaysReasoning
        ? formatCompactReasoningLabel(reasoningEffort)
        : null
    const codexFastMode = shouldShowCodexFastBadge(props.agentFlavor, props.serviceTier)
    const quotaLabel = props.quota ? formatQuotaLabel(props.quota, now) : null
    const quotaColor = props.quota ? getQuotaWarning(props.quota.remainingPercent).color : null
    /**
     * The window in a sentence, for the pointer that hovers the chip.
     *
     * The chip itself stays short - it shares the row with the context usage
     * - so the numbers that do not fit in it are one hover away.
     */
    const quotaDescription = useMemo(() => {
        if (!props.quota) return null
        const share = props.quota.unlimited
            ? t('misc.quotaUnlimited')
            : props.quota.remainingPercent !== null
                ? t('misc.quotaRemaining', { percent: props.quota.remainingPercent })
                : t('misc.quotaUnknown')
        if (props.quota.resetAtMs === null) return share
        const left = props.quota.resetAtMs - now
        const reset = left <= 0
            ? t('misc.quotaResetPending')
            : t('misc.quotaResetsIn', { duration: formatQuotaCountdown(left) })
        return `${share} · ${reset}`
    }, [props.quota, now, t])

    return (
        <div className="flex min-w-0 items-baseline justify-between gap-2 px-2 pb-1">
            <div className="flex min-w-0 items-baseline gap-2">
                <div className="relative top-px sm:top-0.5 flex shrink-0 items-center gap-1.5">
                    <span
                        className={`h-2 w-2 rounded-full ${connectionStatus.dotColor} ${connectionStatus.isPulsing ? 'animate-pulse' : ''}`}
                    />
                    <span className={`whitespace-nowrap text-xs ${connectionStatus.color}`}>
                        {connectionStatus.text}
                    </span>
                </div>
                {contextUsageLabel ? (
                    <Popover.Root>
                        <Popover.Trigger asChild>
                            <button
                                type="button"
                                aria-label={t('misc.contextDetails')}
                                className={`min-w-0 cursor-pointer whitespace-nowrap rounded-sm bg-transparent p-0 text-[10px] leading-4 outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-link)] ${contextWarning?.color ?? 'text-[var(--app-hint)]'}`}
                            >
                                <span className="sm:hidden">{compactContextUsageLabel}</span>
                                <span className="hidden items-center gap-2 sm:inline-flex">
                                    {contextUsedPercentage !== null ? (
                                        <span
                                            aria-hidden="true"
                                            className="h-1 w-12 shrink-0 overflow-hidden rounded-full bg-[var(--app-link-muted)]"
                                        >
                                            <span
                                                className="block h-full rounded-full bg-current"
                                                style={{ width: `${contextUsedPercentage}%` }}
                                            />
                                        </span>
                                    ) : null}
                                    <span>{contextUsageLabel}</span>
                                </span>
                            </button>
                        </Popover.Trigger>
                        <Popover.Portal>
                            <Popover.Content
                                side="top"
                                align="start"
                                sideOffset={6}
                                collisionPadding={8}
                                className="z-50 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 shadow-lg"
                            >
                                <div className="flex max-w-[min(22rem,calc(100vw-1rem))] flex-col gap-1 text-xs leading-tight text-[var(--app-fg)]">
                                    {contextWindowOnly ? (
                                        // The session has not run a turn yet, so
                                        // there is no usage to report - the
                                        // window it will be measured against is
                                        // what there is to say.
                                        <span className="break-words">
                                            {t('misc.contextWindow', {
                                                value: contextUsageDetails?.remaining ?? ''
                                            })}
                                        </span>
                                    ) : (
                                        <>
                                            {contextUsageDetails?.cacheRead ? (
                                                <span className="break-words">
                                                    {t('misc.contextCache', { value: contextUsageDetails.cacheRead })}
                                                </span>
                                            ) : null}
                                            <span className="break-words">
                                                {contextUsageDetails?.usedPercentage === null
                                                    ? t('misc.contextUsedTokens', { value: contextUsageDetails.used })
                                                    : t('misc.contextUsed', {
                                                        value: contextUsageDetails?.used ?? '',
                                                        percent: contextUsageDetails?.usedPercentage ?? 0
                                                    })}
                                            </span>
                                            {contextUsageDetails?.remaining && contextUsageDetails.remainingPercentage !== null ? (
                                                <span className="break-words">
                                                    {t('misc.contextRemaining', {
                                                        value: contextUsageDetails.remaining,
                                                        percent: contextUsageDetails.remainingPercentage
                                                    })}
                                                </span>
                                            ) : null}
                                        </>
                                    )}
                                </div>
                            </Popover.Content>
                        </Popover.Portal>
                    </Popover.Root>
                ) : null}
                {props.quota ? (
                    <Popover.Root>
                        <Popover.Trigger asChild>
                            <button
                                type="button"
                                aria-label={t('misc.quotaDetails')}
                                title={quotaDescription ?? undefined}
                                className={`min-w-0 cursor-pointer whitespace-nowrap rounded-sm bg-transparent p-0 text-[10px] leading-4 outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-link)] ${quotaColor}`}
                            >
                                {quotaLabel}
                            </button>
                        </Popover.Trigger>
                        <Popover.Portal>
                            <Popover.Content
                                side="top"
                                align="start"
                                sideOffset={6}
                                collisionPadding={8}
                                className="z-50 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 shadow-lg"
                            >
                                <QuotaDetails quota={props.quota} now={now} />
                            </Popover.Content>
                        </Popover.Portal>
                    </Popover.Root>
                ) : null}
            </div>

            <div className="flex min-w-0 shrink-0 items-baseline gap-2">
                {reasoningLabel ? (
                    <span className="whitespace-nowrap text-xs text-[var(--app-hint)]">
                        <span className="sm:hidden">{compactReasoningLabel}</span>
                        <span className="hidden sm:inline">{reasoningLabel}</span>
                    </span>
                ) : null}
                {codexFastMode ? (
                    <span className="whitespace-nowrap text-xs text-[#34C759]">
                        fast
                    </span>
                ) : null}
                {collaborationModeLabel ? (
                    <span className="whitespace-nowrap text-xs text-blue-500">
                        {collaborationModeLabel}
                    </span>
                ) : null}
                {copilotAgentModeLabel ? (
                    <span className="whitespace-nowrap text-xs text-blue-500">
                        {copilotAgentModeLabel}
                    </span>
                ) : null}
                {displayPermissionMode ? (
                    <span className={`whitespace-nowrap text-xs ${permissionModeColor}`}>
                        {permissionModeLabel}
                    </span>
                ) : null}
            </div>
        </div>
    )
}
