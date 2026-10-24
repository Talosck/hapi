import { join } from 'node:path';
import { logger } from '@/ui/logger';
import { getMcodeDataDir } from './mcodeSessionDirs';
import { MCODE_RUNTIME_INDEX_RELATIVE_PATH, openMcodeRuntimeIndex } from './mcodeRuntimeIndex';

/**
 * What the agent's runtime knows about one background task.
 *
 * The runtime keeps the record of every background task it ran, and it is the
 * only place that knows when a task ended: the completion is reported into the
 * owner session by a turn of the agent's own, and that turn is not streamed to
 * the client. A client that only reads the tool stream therefore sees a task
 * that ended between two turns as a task that still runs.
 *
 * The record lives in the runtime index, next to the turn lease HAPI already
 * reads from the same file.
 */
export type McodeBackgroundTaskState = {
    /** The id the agent gave the task (`bg_...`). */
    taskId: string;
    /** The status the runtime recorded: running, succeeded, failed, canceled, lost. */
    status: string;
    /** Epoch milliseconds: when the task ended. Null while it still runs. */
    endedAt: number | null;
};

const TASK_QUERY =
    'SELECT task_id, status, ended_at_ms, is_deleted FROM local_runtime_background_tasks WHERE owner_session_id = ?';

/** The part of a SQLite handle the task reader needs. */
export type McodeBackgroundTaskQuery = {
    query(sql: string): {
        all(...params: unknown[]): unknown[];
    };
};

function readTaskRow(row: unknown): McodeBackgroundTaskState | null {
    if (typeof row !== 'object' || row === null) return null;
    const record = row as Record<string, unknown>;
    const taskId = typeof record.task_id === 'string' ? record.task_id : null;
    if (!taskId) return null;
    const status = typeof record.status === 'string' ? record.status : null;
    if (!status) return null;
    const endedAt = typeof record.ended_at_ms === 'number' ? record.ended_at_ms : null;
    return { taskId, status: status.toLowerCase(), endedAt };
}

/**
 * Reads the background tasks the runtime recorded for a session.
 *
 * A row the runtime pruned (the runtime deletes the records of tasks it no
 * longer needs) is skipped: it is not evidence about a task that runs.
 *
 * An index that cannot be read - an agent that does not have the table, a
 * locked file - leaves the states empty. That is the safe direction: the
 * ledger keeps what it knows instead of losing a task that really runs.
 */
export function readMcodeBackgroundTaskStatesFromDatabase(
    database: McodeBackgroundTaskQuery,
    sessionId: string
): Map<string, McodeBackgroundTaskState> {
    const states = new Map<string, McodeBackgroundTaskState>();
    if (!sessionId) return states;

    try {
        const rows = database.query(TASK_QUERY).all(sessionId);
        for (const row of rows) {
            if (typeof row === 'object' && row !== null) {
                const record = row as Record<string, unknown>;
                if (record.is_deleted) continue;
            }
            const state = readTaskRow(row);
            if (state) states.set(state.taskId, state);
        }
    } catch (error) {
        logger.debug('[mcode-remote] background task states could not be read', error);
    }
    return states;
}

/**
 * Reads the background tasks the agent's runtime recorded for a native session.
 *
 * The session id is the agent's own session id (`mvs_...`), the same one the
 * runtime index is keyed by.
 */
export async function readMcodeBackgroundTaskStates(
    sessionId: string,
    dataDir: string = getMcodeDataDir()
): Promise<Map<string, McodeBackgroundTaskState>> {
    if (!sessionId) return new Map();

    const databasePath = join(dataDir, ...MCODE_RUNTIME_INDEX_RELATIVE_PATH);
    const database = await openMcodeRuntimeIndex(databasePath);
    if (!database) return new Map();

    return readMcodeBackgroundTaskStatesFromDatabase(
        database as unknown as McodeBackgroundTaskQuery,
        sessionId
    );
}
