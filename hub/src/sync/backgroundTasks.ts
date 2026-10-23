import { isObject } from '@hapi/protocol'
import { BackgroundTaskRecordSchema } from '@hapi/protocol/schemas'
import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'

/**
 * The count of background work comes from one source only: the list the CLI
 * publishes (see `extractBackgroundTaskSnapshot`).
 *
 * The old started-minus-completed counter is gone. A completion that nobody
 * reported - the agent finishing a task between two turns - left the count
 * stuck for the rest of the session, and the counter could also push the
 * count up after the last list arrived, with nothing left to correct it.
 */

/**
 * Reads the background work a session has going out of a message.
 *
 * The CLI publishes the whole list whenever it changes. The number of
 * entries is the number of running background tasks, so the hub stores an
 * absolute count instead of adding up starts and completions: a completion
 * that nobody reported cannot leave the count stuck for the rest of the
 * session.
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
