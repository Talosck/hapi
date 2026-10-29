import { isObject } from '@hapi/protocol'
import { BackgroundTaskRecordSchema } from '@hapi/protocol/schemas'
import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import type { BackgroundTask } from '@hapi/protocol/types'

/**
 * Read the running background tasks from Claude's
 * `system/background_tasks_changed` snapshot.
 *
 * Claude Code (SDK mode) emits it whenever the set of background tasks
 * changes, including an empty `tasks` list once the last one finishes. The
 * CLI forwards it as { role: 'agent', content: { type: 'output', data } }.
 * Being a full snapshot, it replaces the list instead of adjusting it.
 */
export function extractBackgroundTasks(messageContent: unknown): BackgroundTask[] | null {
    const record = unwrapRoleWrappedRecordEnvelope(messageContent)
    if (!record || record.role !== 'agent') return null
    if (!isObject(record.content) || record.content.type !== 'output') return null

    const data = isObject(record.content.data) ? record.content.data : null
    if (data?.type !== 'system' || data.subtype !== 'background_tasks_changed') return null
    if (!Array.isArray(data.tasks)) return null

    return data.tasks.filter(isObject).map((task) => ({
        id: typeof task.task_id === 'string' ? task.task_id : '',
        type: typeof task.task_type === 'string' ? task.task_type : '',
        description: typeof task.description === 'string' ? task.description : ''
    }))
}

/**
 * Reads the background work a session has going out of a message.
 *
 * The count of background work comes from one source only: the list the CLI
 * publishes (see `extractBackgroundTaskSnapshot`). The old
 * started-minus-completed counter is gone. A completion that nobody reported
 * - the agent finishing a task between two turns - left the count stuck for
 * the rest of the session, and the counter could also push the count up
 * after the last list arrived, with nothing left to correct it.
 *
 * The CLI publishes the whole list whenever it changes. The number of
 * entries is the number of running background tasks, so the hub stores an
 * absolute count instead of adding up starts and completions.
 */
export function extractBackgroundTaskSnapshot(messageContent: unknown): { running: number } | null {
    const record = unwrapRoleWrappedRecordEnvelope(messageContent)
    if (!record || record.role !== 'agent') return null
    if (!isObject(record.content) || record.content.type !== 'event') return null

    const data = isObject(record.content.data) ? record.content.data : null
    if (!data || data.type !== 'background-task-snapshot') return null

    const parsed = BackgroundTaskRecordSchema.array().safeParse(data.tasks)
    if (!parsed.success) return null

    return { running: parsed.data.length }
}
