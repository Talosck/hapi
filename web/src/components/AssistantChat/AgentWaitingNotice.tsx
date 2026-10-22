import { useEffect, useState } from 'react'
import { useTranslation } from '@/lib/use-translation'

/**
 * Tells the operator that the agent is holding a turn and their message is
 * waiting for it.
 *
 * The agent can hold a turn HAPI never started - MiniMax Code opens one of
 * its own to deliver a finished background task - so from HAPI's side the
 * session is idle: the message is out of the queue, nothing is typing, and
 * the only hint is a line in the transcript. Without this notice the natural
 * reading is "my message was lost", and the operator sends it again - which
 * puts the same text in front of the agent twice.
 */
export function AgentWaitingNotice(props: {
    /** When the wait started (epoch milliseconds). */
    waitingSinceMs?: number | null
}) {
    const { t } = useTranslation()
    const [now, setNow] = useState(() => Date.now())

    useEffect(() => {
        if (props.waitingSinceMs == null) return
        const timer = window.setInterval(() => setNow(Date.now()), 1000)
        return () => window.clearInterval(timer)
    }, [props.waitingSinceMs])

    if (props.waitingSinceMs == null) return null

    const elapsedSeconds = Math.max(0, Math.round((now - props.waitingSinceMs) / 1000))

    return (
        <div
            role="status"
            aria-live="polite"
            className="mx-auto w-full max-w-content rounded-lg border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-2"
        >
            <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--app-fg)]">
                <span aria-hidden="true">⏳</span>
                <span>{t('agentWaiting.title')}</span>
            </div>
            <div className="mt-1 text-xs text-[var(--app-fg-muted)]">
                {t('agentWaiting.body')}
            </div>
            {elapsedSeconds > 0 ? (
                <div className="mt-1 text-xs text-[var(--app-hint)]">
                    {t('agentWaiting.elapsed', { seconds: elapsedSeconds })}
                </div>
            ) : null}
        </div>
    )
}
