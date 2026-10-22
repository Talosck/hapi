import { useEffect, useState, type ReactNode } from 'react'
import { formatDuration } from '@/chat/presentation'
import type { SessionStatusData, SessionStatusSubagent } from '@/chat/sessionStatus'
import { ChecklistList } from '@/components/ToolCard/checklist'
import { useTranslation } from '@/lib/use-translation'
import { ApiError, apiErrorMessage, type ApiClient } from '@/api/client'
import type {
    McodeConnectorApp,
    McodeConnectorAuth,
    McodeDelegationStopReceipt,
    McodeExtensionCapabilities,
    ThreadGoal
} from '@hapi/protocol'

function Section(props: { title: string; children: ReactNode }) {
    return (
        <section className="min-w-0">
            <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--app-hint)]">
                {props.title}
            </h3>
            {props.children}
        </section>
    )
}

function subagentTone(state: SessionStatusSubagent['state']): string {
    if (state === 'error') return 'text-red-600'
    if (state === 'waiting') return 'text-amber-600'
    return 'text-emerald-600'
}

function elapsedSince(startedAt: number | null, now: number): string | null {
    if (startedAt === null || startedAt <= 0) return null
    return formatDuration(Math.max(0, now - startedAt))
}

/**
 * The MiniMax Code controls the session's agent actually supports.
 *
 * The agent advertises its extension surface when it starts, and the goal
 * extension is optional, so the panel renders the controls only for the
 * features the running agent advertised.
 */
export type McodeGoalControls = {
    api: ApiClient | null
    sessionId: string
    capabilities: McodeExtensionCapabilities | null
}

function ControlButton(props: {
    label: string
    onClick?: () => void
    disabled?: boolean
    tone?: 'default' | 'danger'
    type?: 'button' | 'submit'
}) {
    const tone = props.tone === 'danger'
        ? 'border-red-300 text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40'
        : 'border-[var(--app-border)] text-[var(--app-fg)] hover:bg-[var(--app-hover-bg)]'
    return (
        <button
            type={props.type ?? 'button'}
            onClick={props.onClick}
            disabled={props.disabled}
            className={`rounded border px-1.5 py-0.5 text-[11px] disabled:opacity-50 ${tone}`}
        >
            {props.label}
        </button>
    )
}

/**
 * The goal lifecycle controls.
 *
 * Creating a goal makes the agent start working on the objective right away,
 * so the form says so instead of presenting it as a saved preference.
 */
function GoalControls(props: {
    api: ApiClient
    sessionId: string
    capabilities: McodeExtensionCapabilities
    goal: ThreadGoal | null
}) {
    const { t } = useTranslation()
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [objective, setObjective] = useState('')
    const [budget, setBudget] = useState('')
    const [showForm, setShowForm] = useState(false)

    const goal = props.goal
    const canCreate = props.capabilities.goalCreate === true
    const canPatch = props.capabilities.goalPatch === true
    const canClear = props.capabilities.goalClear === true

    const run = async (action: () => Promise<{ success: boolean; error?: string }>): Promise<boolean> => {
        setBusy(true)
        setError(null)
        try {
            const result = await action()
            if (!result.success) {
                setError(result.error ?? t('session.status.goal.actionFailed'))
                return false
            }
            return true
        } catch (e) {
            // The hub rejects goal changes on a session that is no longer
            // running. Its 409 carries a JSON body, which is not something to
            // show the user verbatim.
            setError(
                e instanceof ApiError && e.status === 409 && e.code === 'session_inactive'
                    ? t('chat.sendError.sessionInactive')
                    : apiErrorMessage(e, t('session.status.goal.actionFailed'))
            )
            return false
        } finally {
            setBusy(false)
        }
    }

    const submitCreate = async () => {
        const trimmed = objective.trim()
        if (!trimmed) return
        const parsedBudget = budget.trim() ? Number(budget.trim()) : null
        if (parsedBudget !== null && (!Number.isFinite(parsedBudget) || !Number.isInteger(parsedBudget) || parsedBudget <= 0)) {
            setError(t('session.status.goal.budgetInvalid'))
            return
        }
        // A rejected goal keeps the text the user wrote: throwing it away
        // makes a failed submit cost them the whole objective.
        const created = await run(() => props.api.createMcodeGoal(props.sessionId, trimmed, parsedBudget))
        if (!created) return
        setObjective('')
        setBudget('')
        setShowForm(false)
    }

    const patchStatus = (status: ThreadGoal['status']) => {
        void run(() => props.api.patchMcodeGoal(props.sessionId, { status }))
    }

    const clear = () => {
        void run(() => props.api.clearMcodeGoal(props.sessionId))
    }

    const controls: ReactNode[] = []

    if (goal && canPatch) {
        if (goal.status === 'active') {
            controls.push(
                <ControlButton
                    key="pause"
                    label={t('session.status.goal.pause')}
                    disabled={busy}
                    onClick={() => patchStatus('paused')}
                />
            )
        } else if (goal.status === 'paused' || goal.status === 'blocked') {
            controls.push(
                <ControlButton
                    key="resume"
                    label={t('session.status.goal.resume')}
                    disabled={busy}
                    onClick={() => patchStatus('active')}
                />
            )
        }
    }
    if (goal && canClear) {
        controls.push(
            <ControlButton
                key="clear"
                label={t('session.status.goal.clear')}
                tone="danger"
                disabled={busy}
                onClick={clear}
            />
        )
    }
    if (!goal && canCreate && !showForm) {
        controls.push(
            <ControlButton
                key="create"
                label={t('session.status.goal.create')}
                disabled={busy}
                onClick={() => setShowForm(true)}
            />
        )
    }

    return (
        <div className="mt-1.5 flex flex-col gap-1.5">
            {showForm ? (
                <form
                    className="flex flex-col gap-1.5"
                    // The browser's own validation answers in the browser's
                    // language and blocks the submit before the app can say
                    // anything: the messages below are the ones the user
                    // reads.
                    noValidate
                    onSubmit={(e) => {
                        e.preventDefault()
                        void submitCreate()
                    }}
                >
                    <input
                        type="text"
                        value={objective}
                        onChange={(e) => setObjective(e.target.value)}
                        placeholder={t('session.status.goal.objectivePlaceholder')}
                        aria-label={t('session.status.goal.objectivePlaceholder')}
                        className="w-full rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-xs text-[var(--app-fg)] outline-none focus:border-[var(--app-accent)]"
                    />
                    <input
                        type="number"
                        min={1}
                        step={1}
                        inputMode="numeric"
                        value={budget}
                        onChange={(e) => setBudget(e.target.value)}
                        placeholder={t('session.status.goal.budgetPlaceholder')}
                        aria-label={t('session.status.goal.budgetPlaceholder')}
                        className="w-full rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-xs text-[var(--app-fg)] outline-none focus:border-[var(--app-accent)]"
                    />
                    <div className="flex items-center gap-1.5">
                        <ControlButton
                            type="submit"
                            label={t('session.status.goal.start')}
                            disabled={busy || objective.trim().length === 0}
                        />
                        <ControlButton
                            label={t('session.status.goal.cancel')}
                            disabled={busy}
                            onClick={() => setShowForm(false)}
                        />
                    </div>
                    <div className="text-[11px] text-[var(--app-hint)]">
                        {t('session.status.goal.startsImmediately')}
                    </div>
                </form>
            ) : null}
            {controls.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5">{controls}</div>
            ) : null}
            {error ? <div role="alert" className="text-[11px] text-red-600">{error}</div> : null}
        </div>
    )
}

/**
 * The sign-in state of the connector broker.
 *
 * An app that is not signed in looks exactly like a working one until the
 * agent calls it and fails, so the state is part of the panel.
 */
function connectorAuthTone(status: string): 'ok' | 'warn' | 'error' {
    const normalized = status.trim().toLowerCase()
    if (normalized === 'authenticated') return 'ok'
    if (normalized.includes('expir')) return 'error'
    if (normalized.includes('unauth') || normalized.includes('missing')) return 'warn'
    return 'warn'
}

/**
 * The apps the agent can reach.
 *
 * MiniMax Code's connector tools are not part of the ACP surface - the agent
 * calls them through the `mcode-tools` CLI - so this list is the only place
 * a user learns which apps are wired up.
 */
function ConnectedApps(props: {
    apps: McodeConnectorApp[]
    auth: McodeConnectorAuth | null
    error: string | null
}) {
    const { t } = useTranslation()

    if (props.error) {
        return (
            <div className="flex flex-col gap-0.5">
                <div className="text-xs text-[var(--app-hint)]">{t('session.status.apps.unavailable')}</div>
                {/* The reason is the only thing that tells the user whether
                    the apps are missing or the probe could not run. */}
                <div className="break-words text-[11px] text-[var(--app-hint)] opacity-80">{props.error}</div>
            </div>
        )
    }

    const auth = props.auth
    const authTone = auth ? connectorAuthTone(auth.status) : null

    return (
        <div className="flex flex-col gap-1">
            {props.apps.length === 0 ? (
                <div className="text-xs text-[var(--app-hint)]">{t('session.status.apps.none')}</div>
            ) : (
                props.apps.map((app) => (
                    <div key={app.provider} className="flex min-w-0 items-baseline gap-1.5">
                        <span className="min-w-0 break-words text-sm text-[var(--app-fg)]">{app.provider}</span>
                        <span className="ml-auto shrink-0 text-xs text-[var(--app-hint)]">
                            {t('session.status.apps.toolCount', { count: app.toolCount })}
                        </span>
                    </div>
                ))
            )}
            {auth ? (
                <div
                    className={`text-[11px] ${authTone === 'ok'
                        ? 'text-emerald-600'
                        : authTone === 'error' ? 'text-red-600' : 'text-amber-600'}`}
                >
                    {authTone === 'ok'
                        ? t('session.status.apps.auth.ok')
                        : authTone === 'error'
                            ? t('session.status.apps.auth.expired')
                            : t('session.status.apps.auth.missing', { status: auth.status })}
                    {auth.expiresAt ? ` · ${t('session.status.apps.auth.expiresAt', {
                        date: new Date(auth.expiresAt).toLocaleString()
                    })}` : ''}
                </div>
            ) : null}
        </div>
    )
}

export function SessionStatusPanel(props: {
    data: SessionStatusData
    goalControls?: McodeGoalControls | null
    apps?: {
        apps: McodeConnectorApp[]
        auth: McodeConnectorAuth | null
        error: string | null
    } | null
    /**
     * Whether the session is still running.
     *
     * A session that ended leaves its subagents without an end time, so the
     * elapsed clock would keep counting for a session nobody can act on any
     * more.
     */
    active?: boolean
}) {
    const { data } = props
    const { t } = useTranslation()
    const completedTasks = data.tasks.filter((task) => task.status === 'completed').length
    const hasLiveElapsed = props.active !== false && (data.terminals.length > 0
        || data.subagents.some((subagent) => subagent.endedAt === null && subagent.startedAt !== null))
    const [now, setNow] = useState(() => Date.now())
    const [stopping, setStopping] = useState(false)
    const [stopError, setStopError] = useState<string | null>(null)
    const [stopReceipt, setStopReceipt] = useState<McodeDelegationStopReceipt | null>(null)

    useEffect(() => {
        if (!hasLiveElapsed) return
        const timer = window.setInterval(() => setNow(Date.now()), 1000)
        return () => window.clearInterval(timer)
    }, [hasLiveElapsed])

    const controls = props.goalControls
    const canStopDelegation = controls?.capabilities?.delegationStop === true
    const hasRunningSubagent = data.subagents.some((subagent) => subagent.state === 'running')

    const stopDelegation = async () => {
        if (!controls?.api) return
        setStopping(true)
        setStopError(null)
        setStopReceipt(null)
        try {
            const result = await controls.api.stopMcodeDelegation(controls.sessionId)
            if (!result.success) {
                setStopError(result.error ?? t('session.status.subagents.stopFailed'))
                return
            }
            // The receipt says which delegated sessions really stopped: a
            // partial stop is not a success, and the user has to see the
            // difference.
            setStopReceipt(result.receipt ?? null)
        } catch (e) {
            setStopError(apiErrorMessage(e, t('session.status.subagents.stopFailed')))
        } finally {
            setStopping(false)
        }
    }

    return (
        // Match the chat column width (`max-w-content`) so the panel lines up
        // with the conversation below instead of stretching across the whole
        // pane on wide desktop screens.
        <div className="px-3 pt-3">
            <details
                data-testid="session-status-panel"
                className="group mx-auto w-full max-w-content rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)]"
            >
                <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-semibold text-[var(--app-fg)] [&::-webkit-details-marker]:hidden">
                    {t('session.status.title')}
                    <span className="ml-auto text-[10px] text-[var(--app-hint)] transition-transform group-open:rotate-180" aria-hidden="true">▼</span>
                </summary>
                <div className="grid max-h-[min(50dvh,24rem)] gap-3 overflow-y-auto border-t border-[var(--app-border)] px-3 py-2.5 sm:grid-cols-2">
                    {data.goal ? (
                        <Section title={t('session.status.goal')}>
                            <div className="break-words text-sm text-[var(--app-fg)]">{data.goal.objective}</div>
                            <div className="mt-0.5 text-xs text-[var(--app-hint)]">
                                {t(`session.status.goal.${data.goal.status}`)}
                                {data.goal.timeUsedSeconds > 0 ? ` · ${formatDuration(data.goal.timeUsedSeconds * 1000)}` : ''}
                            </div>
                            {controls?.api ? (
                                <GoalControls
                                    api={controls.api}
                                    sessionId={controls.sessionId}
                                    capabilities={controls.capabilities ?? {}}
                                    goal={data.goal}
                                />
                            ) : null}
                        </Section>
                    ) : controls?.api && controls.capabilities?.goalCreate ? (
                        <Section title={t('session.status.goal')}>
                            <GoalControls
                                api={controls.api}
                                sessionId={controls.sessionId}
                                capabilities={controls.capabilities ?? {}}
                                goal={null}
                            />
                        </Section>
                    ) : null}

                    {data.tasks.length > 0 ? (
                        <Section title={`${t('session.status.tasks')} · ${completedTasks}/${data.tasks.length}`}>
                            <ChecklistList items={data.tasks.map((task) => ({
                                id: task.id || undefined,
                                text: task.content,
                                status: task.status
                            }))} />
                        </Section>
                    ) : null}

                    {data.subagents.length > 0 ? (
                        <Section title={t('session.status.subagents')}>
                            <div className="flex flex-col gap-1.5">
                                {data.subagents.map((subagent) => {
                                    const elapsed = elapsedSince(subagent.startedAt, subagent.endedAt ?? now)
                                    // Delegated subagents nest; the indent shows the
                                    // tree the agent reported.
                                    const indent = Math.min(subagent.depth ?? 0, 3) * 12
                                    return (
                                        <div
                                            key={subagent.id}
                                            className="min-w-0 text-sm"
                                            style={indent > 0 ? { paddingLeft: indent } : undefined}
                                        >
                                            <div className="flex min-w-0 items-baseline gap-1.5">
                                                <span className={`shrink-0 text-xs ${subagentTone(subagent.state)}`}>●</span>
                                                <span className="min-w-0 break-words text-[var(--app-fg)]">{subagent.title}</span>
                                                <span className={`ml-auto shrink-0 text-xs ${subagentTone(subagent.state)}`}>
                                                    {t(`session.status.subagent.${subagent.state}`)}
                                                    {elapsed ? ` · ${elapsed}` : ''}
                                                </span>
                                            </div>
                                            {subagent.detail ? (
                                                <div className="ml-3.5 break-words text-xs text-[var(--app-hint)]">{subagent.detail}</div>
                                            ) : null}
                                        </div>
                                    )
                                })}
                            </div>
                            {canStopDelegation && hasRunningSubagent ? (
                                <div className="mt-1.5 flex flex-col gap-1">
                                    <ControlButton
                                        label={t('session.status.subagents.stop')}
                                        tone="danger"
                                        disabled={stopping}
                                        onClick={() => void stopDelegation()}
                                    />
                                    {stopError ? (
                                        <div role="alert" className="text-[11px] text-red-600">{stopError}</div>
                                    ) : null}
                                    {stopReceipt ? (
                                        <div className="text-[11px] text-[var(--app-hint)]">
                                            {t('session.status.subagents.stopped', { count: stopReceipt.stoppedSessionIds.length })}
                                            {stopReceipt.activeSessionIds.length > 0 ? ` · ${t('session.status.subagents.stillActive', {
                                                count: stopReceipt.activeSessionIds.length
                                            })}` : ''}
                                            {stopReceipt.failedSessionIds.length > 0 ? ` · ${t('session.status.subagents.stopFailedCount', {
                                                count: stopReceipt.failedSessionIds.length
                                            })}` : ''}
                                        </div>
                                    ) : null}
                                </div>
                            ) : null}
                        </Section>
                    ) : null}

                    {props.apps ? (
                        <Section title={t('session.status.apps')}>
                            <ConnectedApps
                                apps={props.apps.apps}
                                auth={props.apps.auth}
                                error={props.apps.error}
                            />
                        </Section>
                    ) : null}

                    {data.terminals.length > 0 || data.undiscoveredTerminalCount > 0 ? (
                        <Section title={t('session.status.terminals')}>
                            <div className="flex flex-col gap-1.5">
                                {data.terminals.map((terminal) => {
                                    const elapsed = elapsedSince(terminal.startedAt, now)
                                    return (
                                        <div key={terminal.id} className="min-w-0">
                                            <code className="block overflow-hidden text-ellipsis whitespace-nowrap text-xs text-[var(--app-fg)]" title={terminal.command}>
                                                {terminal.command}
                                            </code>
                                            {(terminal.cwd || elapsed) ? (
                                                <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-[var(--app-hint)]">
                                                    {[terminal.cwd, elapsed].filter(Boolean).join(' · ')}
                                                </div>
                                            ) : null}
                                        </div>
                                    )
                                })}
                                {data.undiscoveredTerminalCount > 0 ? (
                                    <>
                                        <div className="text-xs text-[var(--app-hint)]">
                                            {t('session.status.terminalsUnavailable', { count: data.undiscoveredTerminalCount })}
                                        </div>
                                        {data.possibleTerminalCommands.length > 0 ? (
                                            <div className="text-[11px] text-[var(--app-hint)]">
                                                {t('session.status.terminalsPossible')}
                                                {data.possibleTerminalCommands.map((command, index) => (
                                                    <code key={`${command}:${index}`} className="block overflow-hidden text-ellipsis whitespace-nowrap" title={command}>{command}</code>
                                                ))}
                                            </div>
                                        ) : null}
                                    </>
                                ) : null}
                            </div>
                        </Section>
                    ) : null}
                </div>
            </details>
        </div>
    )
}
