import { describe, expect, it } from 'bun:test';
import { extractBackgroundTaskSnapshot } from './backgroundTasks';

function agentEvent(data: unknown): unknown {
    return {
        role: 'agent',
        content: { id: 'evt-1', type: 'event', data }
    };
}

describe('extractBackgroundTaskSnapshot', () => {
    it('counts the tasks the session published', () => {
        const message = agentEvent({
            type: 'background-task-snapshot',
            tasks: [
                { id: 'bg_1', command: 'npm run dev', cwd: '/repo', startedAt: 1 },
                { id: 'bg_2', command: 'npm test', cwd: null, startedAt: 2 }
            ]
        });

        expect(extractBackgroundTaskSnapshot(message)).toEqual({ running: 2 });
    });

    it('reads an empty list as no background work', () => {
        expect(extractBackgroundTaskSnapshot(agentEvent({
            type: 'background-task-snapshot',
            tasks: []
        }))).toEqual({ running: 0 });
    });

    it('ignores a snapshot it cannot read', () => {
        expect(extractBackgroundTaskSnapshot(agentEvent({
            type: 'background-task-snapshot',
            tasks: [{ id: 'bg_1' }]
        }))).toBeNull();
    });

    it('ignores other events', () => {
        expect(extractBackgroundTaskSnapshot(agentEvent({ type: 'ready' }))).toBeNull();
        expect(extractBackgroundTaskSnapshot({
            role: 'user',
            content: { id: 'evt-1', type: 'event', data: { type: 'background-task-snapshot', tasks: [] } }
        })).toBeNull();
    });
});
