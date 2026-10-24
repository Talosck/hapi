import { describe, expect, it } from 'vitest';
import {
    readMcodeBackgroundTaskStatesFromDatabase,
    type McodeBackgroundTaskQuery
} from './mcodeBackgroundTaskState';

function databaseWith(rows: unknown[], throws = false): McodeBackgroundTaskQuery {
    return {
        query: () => ({
            all: () => {
                if (throws) throw new Error('no such table: local_runtime_background_tasks');
                return rows;
            }
        })
    };
}

describe('readMcodeBackgroundTaskStatesFromDatabase', () => {
    it('reads the tasks of the session with their status and end time', () => {
        const states = readMcodeBackgroundTaskStatesFromDatabase(
            databaseWith([
                {
                    task_id: 'bg_running',
                    status: 'running',
                    ended_at_ms: null,
                    is_deleted: 0
                },
                {
                    task_id: 'bg_done',
                    status: 'succeeded',
                    ended_at_ms: 1_792_831_484_711,
                    is_deleted: 0
                }
            ]),
            'mvs_1'
        );

        expect(states.get('bg_running')).toEqual({
            taskId: 'bg_running',
            status: 'running',
            endedAt: null
        });
        expect(states.get('bg_done')).toEqual({
            taskId: 'bg_done',
            status: 'succeeded',
            endedAt: 1_792_831_484_711
        });
    });

    it('skips a record the runtime pruned', () => {
        // A pruned record is not evidence about a task that runs.
        const states = readMcodeBackgroundTaskStatesFromDatabase(
            databaseWith([
                { task_id: 'bg_gone', status: 'running', ended_at_ms: null, is_deleted: 1 }
            ]),
            'mvs_1'
        );

        expect(states.size).toBe(0);
    });

    it('ignores a row it cannot read', () => {
        const states = readMcodeBackgroundTaskStatesFromDatabase(
            databaseWith([
                { task_id: null, status: 'running', ended_at_ms: null, is_deleted: 0 },
                { task_id: 'bg_no_status', status: null, ended_at_ms: null, is_deleted: 0 },
                null
            ]),
            'mvs_1'
        );

        expect(states.size).toBe(0);
    });

    it('leaves the states empty when the index cannot be read', () => {
        // An agent without the table must not make HAPI drop the work it
        // knows: an empty answer keeps the ledger as it is.
        const states = readMcodeBackgroundTaskStatesFromDatabase(databaseWith([], true), 'mvs_1');

        expect(states.size).toBe(0);
    });

    it('asks for the tasks of one session', () => {
        const queries: string[] = [];
        const database: McodeBackgroundTaskQuery = {
            query: (sql: string) => {
                queries.push(sql);
                return { all: () => [] };
            }
        };

        readMcodeBackgroundTaskStatesFromDatabase(database, 'mvs_1');

        expect(queries[0]).toContain('local_runtime_background_tasks');
        expect(queries[0]).toContain('owner_session_id');
    });
});
