import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@/agent/types';
import { BackgroundTaskAggregator } from './backgroundTaskAggregator';

type ToolCallMessage = Extract<AgentMessage, { type: 'tool_call' }>;
type ToolResultMessage = Extract<AgentMessage, { type: 'tool_result' }>;

function toolCall(overrides: Partial<ToolCallMessage> = {}): ToolCallMessage {
    return {
        type: 'tool_call',
        id: 'call-1',
        name: 'Task',
        input: { description: 'Research the repo', prompt: 'Look around' },
        status: 'in_progress',
        ...overrides
    };
}

function toolResult(overrides: Partial<ToolResultMessage> & { text?: string; details?: Record<string, unknown> } = {}): ToolResultMessage {
    const { text, details, ...rest } = overrides;
    return {
        type: 'tool_result',
        id: 'call-1',
        output: {
            content: [{ type: 'text', text: text ?? '' }],
            details: details ?? {}
        },
        status: 'completed',
        ...rest
    };
}

function taskOutputCall(overrides: Partial<ToolCallMessage> = {}): ToolCallMessage {
    return toolCall({
        id: 'poll-1',
        name: 'task_output',
        input: { task_id: 'bg_1' },
        status: 'completed',
        ...overrides
    });
}

function taskOutputResult(
    status: string,
    text: string,
    overrides: Partial<ToolResultMessage> & { details?: Record<string, unknown> } = {}
): ToolResultMessage {
    return toolResult({
        id: 'poll-1',
        text: `<task_output status="${status}">${text}</task_output>`,
        details: { task_id: 'bg_1', status },
        ...overrides
    });
}

function startBackgroundTask(aggregator: BackgroundTaskAggregator, overrides: {
    callId?: string;
    name?: string;
    taskId?: string;
} = {}): void {
    const callId = overrides.callId ?? 'task-call';
    const taskId = overrides.taskId ?? 'bg_1';
    const name = overrides.name ?? 'Task';

    expect(aggregator.handle(toolCall({
        id: callId,
        name,
        input: name === 'Bash'
            ? { command: 'npm run dev', run_in_background: true }
            : { description: 'Research the repo', prompt: 'Look around' }
    }))).toHaveLength(1);

    const launched = aggregator.handle(toolResult({
        id: callId,
        text: `<${name === 'Bash' ? 'bash' : 'task'}_background task_id="${taskId}">Started background task ${taskId}.</${name === 'Bash' ? 'bash' : 'task'}_background>`,
        details: { task_id: taskId, status: 'started' }
    }));
    expect(launched).toEqual([]);
}

describe('BackgroundTaskAggregator', () => {
    it('forwards unrelated messages unchanged', () => {
        const aggregator = new BackgroundTaskAggregator();
        const text: AgentMessage = { type: 'text', text: 'hello' };

        expect(aggregator.handle(text)).toEqual([text]);
    });

    it('holds a background task launch and folds a running poll into the launch card', () => {
        const aggregator = new BackgroundTaskAggregator();
        startBackgroundTask(aggregator);

        expect(aggregator.handle(taskOutputCall({ input: null }))).toEqual([]);
        expect(aggregator.handle(taskOutputCall())).toEqual([]);

        const [update] = aggregator.handle(taskOutputResult('running', 'halfway there'));
        expect(update).toMatchObject({
            type: 'tool_call',
            id: 'task-call',
            name: 'Task',
            status: 'in_progress',
            progress: {
                content: [{
                    type: 'text',
                    text: expect.stringContaining('halfway there')
                }]
            }
        });
        expect(JSON.stringify(update)).toContain('bg_1');
        expect(JSON.stringify(update)).toContain('running');
    });

    it('completes the launch card when the task reaches a terminal status', () => {
        const aggregator = new BackgroundTaskAggregator();
        startBackgroundTask(aggregator);

        aggregator.handle(taskOutputResult('running', 'still going'));

        aggregator.handle(taskOutputCall({ id: 'poll-done' }));
        const [done] = aggregator.handle(taskOutputResult('succeeded', 'all done', { id: 'poll-done' }));
        expect(done).toMatchObject({
            type: 'tool_result',
            id: 'task-call',
            status: 'completed'
        });
        expect(JSON.stringify(done)).toContain('all done');
    });

    it('marks a failed task as an error on the launch card', () => {
        const aggregator = new BackgroundTaskAggregator();
        startBackgroundTask(aggregator);

        aggregator.handle(taskOutputCall({ id: 'poll-failed' }));
        const [done] = aggregator.handle(taskOutputResult('failed', 'build broke', { id: 'poll-failed' }));
        expect(done).toMatchObject({
            type: 'tool_result',
            id: 'task-call',
            status: 'failed'
        });
    });

    it('forwards a foreground task result without holding it', () => {
        const aggregator = new BackgroundTaskAggregator();

        aggregator.handle(toolCall({ id: 'fg', name: 'Task' }));
        const result = toolResult({
            id: 'fg',
            text: 'The answer is 42.',
            details: { status: 'completed', final_text: 'The answer is 42.' }
        });

        expect(aggregator.handle(result)).toEqual([result]);
    });

    it('aggregates background bash launches too', () => {
        const aggregator = new BackgroundTaskAggregator();
        startBackgroundTask(aggregator, { callId: 'bash-call', name: 'Bash', taskId: 'bg_bash' });

        aggregator.handle(taskOutputCall({ id: 'poll-bash', input: { task_id: 'bg_bash' } }));
        const [update] = aggregator.handle(taskOutputResult('running', 'listening on :3000', {
            id: 'poll-bash',
            details: { task_id: 'bg_bash', status: 'running' }
        }));
        expect(update).toMatchObject({
            type: 'tool_call',
            id: 'bash-call',
            name: 'Bash'
        });
    });

    it('folds task_stop into the launch card and completes on cancellation', () => {
        const aggregator = new BackgroundTaskAggregator();
        startBackgroundTask(aggregator);

        expect(aggregator.handle(toolCall({
            id: 'stop-1',
            name: 'task_stop',
            input: { task_id: 'bg_1', reason: 'done' }
        }))).toEqual([]);

        const [update] = aggregator.handle(toolResult({
            id: 'stop-1',
            text: '<task_stop status="stopping">Stop requested for bg_1.</task_stop>',
            details: { task_id: 'bg_1', status: 'stopping' }
        }));
        expect(update).toMatchObject({ type: 'tool_call', id: 'task-call' });

        aggregator.handle(taskOutputCall({ id: 'poll-2' }));
        const [done] = aggregator.handle(taskOutputResult('canceled', 'canceled', {
            id: 'poll-2'
        }));
        expect(done).toMatchObject({ type: 'tool_result', id: 'task-call' });
    });

    it('folds task_append into the launch card', () => {
        const aggregator = new BackgroundTaskAggregator();
        startBackgroundTask(aggregator);

        aggregator.handle(toolCall({
            id: 'append-1',
            name: 'task_append',
            input: { task_id: 'bg_1', content: 'continue' }
        }));

        const [update] = aggregator.handle(toolResult({
            id: 'append-1',
            text: '<task_append task_id="bg_1" mode="steered" accepted="true" />',
            details: { task_id: 'bg_1', mode: 'steered', accepted: true }
        }));

        expect(update).toMatchObject({ type: 'tool_call', id: 'task-call' });
        expect(JSON.stringify(update)).toContain('Follow-up sent');
    });

    it('re-keys a task when task_append activates it under a new id', () => {
        const aggregator = new BackgroundTaskAggregator();
        startBackgroundTask(aggregator);

        aggregator.handle(toolCall({
            id: 'append-new',
            name: 'task_append',
            input: { task_id: 'bg_1', content: 'continue' }
        }));
        const [appendUpdate] = aggregator.handle(toolResult({
            id: 'append-new',
            text: '<task_append task_id="bg_2" mode="activated" accepted="true" />',
            details: { task_id: 'bg_2', mode: 'activated', accepted: true }
        }));
        expect(appendUpdate).toMatchObject({ type: 'tool_call', id: 'task-call' });
        expect(JSON.stringify(appendUpdate)).toContain('bg_2');
        expect(JSON.stringify(appendUpdate)).toContain('Follow-up sent (activated)');

        aggregator.handle(taskOutputCall({ id: 'poll-new', input: { task_id: 'bg_2' } }));
        const [progress] = aggregator.handle(taskOutputResult('running', 'continuing', {
            id: 'poll-new',
            details: { task_id: 'bg_2', status: 'running' }
        }));
        expect(progress).toMatchObject({ type: 'tool_call', id: 'task-call' });
        expect(JSON.stringify(progress)).toContain('continuing');
    });

    it('releases a never-polled launch at the end of the turn', () => {
        const aggregator = new BackgroundTaskAggregator();
        const call = toolCall({ id: 'task-call' });
        aggregator.handle(call);

        const held = toolResult({
            id: 'task-call',
            text: '<task_background task_id="bg_1">Started background task bg_1.</task_background>',
            details: { task_id: 'bg_1', status: 'started' }
        });
        expect(aggregator.handle(held)).toEqual([]);
        expect(aggregator.takeBackgroundTaskDelta()).toEqual({ started: 1, completed: 0 });

        expect(aggregator.flushPromptEnd()).toEqual([held]);
        // The task can no longer be observed, so the hub counter is released
        // together with the card instead of staying "running" forever.
        expect(aggregator.takeBackgroundTaskDelta()).toEqual({ started: 0, completed: 1 });

        // Once the launch card is complete, later polls update its result
        // instead of emitting a running progress snapshot.
        aggregator.handle(taskOutputCall({ id: 'poll-late' }));
        const [update] = aggregator.handle(taskOutputResult('running', 'later output', { id: 'poll-late' }));
        expect(update).toMatchObject({ type: 'tool_result', id: 'task-call' });
    });

    it('counts a task once when it is released at the end of a turn and polled in the next', () => {
        const aggregator = new BackgroundTaskAggregator();
        startBackgroundTask(aggregator);
        expect(aggregator.takeBackgroundTaskDelta()).toEqual({ started: 1, completed: 0 });

        // The turn ends without a poll: the card is released and the counter
        // is settled.
        aggregator.flushPromptEnd();
        expect(aggregator.takeBackgroundTaskDelta()).toEqual({ started: 0, completed: 1 });

        // The next turn polls the same task and it finishes. The completion
        // was already counted, so the counter must not be settled twice: the
        // hub clamps at zero, which would hide a still running task.
        aggregator.handle(taskOutputCall({ id: 'poll-late' }));
        aggregator.handle(taskOutputResult('succeeded', 'done', { id: 'poll-late' }));

        expect(aggregator.takeBackgroundTaskDelta()).toBeNull();
    });

    it('does not complete a released task again when the session is aborted', () => {
        const aggregator = new BackgroundTaskAggregator();
        startBackgroundTask(aggregator);
        aggregator.flushPromptEnd();
        expect(aggregator.takeBackgroundTaskDelta()).toEqual({ started: 1, completed: 1 });

        expect(aggregator.cancelAll('Session aborted')).toEqual([]);
        expect(aggregator.takeBackgroundTaskDelta()).toBeNull();
    });

    it('keeps the first card when the same task id is launched twice', () => {
        const aggregator = new BackgroundTaskAggregator();
        startBackgroundTask(aggregator, { callId: 'call-a' });
        expect(aggregator.takeBackgroundTaskDelta()).toEqual({ started: 1, completed: 0 });

        // The same task id again: the second launch is forwarded as a plain
        // result instead of orphaning the first card and counting a second
        // start.
        aggregator.handle(toolCall({ id: 'call-b', name: 'Task' }));
        const duplicate = toolResult({
            id: 'call-b',
            text: '<task_background task_id="bg_1">Started background task bg_1.</task_background>',
            details: { task_id: 'bg_1', status: 'started' }
        });
        expect(aggregator.handle(duplicate)).toEqual([duplicate]);
        expect(aggregator.takeBackgroundTaskDelta()).toBeNull();

        // The original card is still the one that completes.
        aggregator.handle(taskOutputCall({ id: 'poll-1' }));
        const [update] = aggregator.handle(taskOutputResult('succeeded', 'done'));
        expect(update).toMatchObject({ type: 'tool_result', id: 'call-a' });
        expect(aggregator.takeBackgroundTaskDelta()).toEqual({ started: 0, completed: 1 });
    });

    it('completes tracked tasks when the session is aborted', () => {
        const aggregator = new BackgroundTaskAggregator();
        startBackgroundTask(aggregator);

        const [done] = aggregator.cancelAll('Session aborted');
        expect(done).toMatchObject({
            type: 'tool_result',
            id: 'task-call',
            status: 'completed'
        });
        expect(JSON.stringify(done)).toContain('canceled');
    });

    it('falls through unknown task polls as a single card', () => {
        const aggregator = new BackgroundTaskAggregator();

        expect(aggregator.handle(taskOutputCall({ input: null }))).toEqual([]);
        expect(aggregator.handle(taskOutputCall())).toEqual([]);

        const result = taskOutputResult('running', 'someone else');
        const forwarded = aggregator.handle(result);

        expect(forwarded).toHaveLength(2);
        expect(forwarded[0]).toMatchObject({
            type: 'tool_call',
            id: 'poll-1',
            name: 'task_output',
            input: { task_id: 'bg_1' }
        });
        expect(forwarded[1]).toBe(result);
    });

    it('ignores malformed launch results instead of holding them', () => {
        const aggregator = new BackgroundTaskAggregator();

        aggregator.handle(toolCall({ id: 'bad-task', name: 'Task' }));
        const malformed = toolResult({ id: 'bad-task', text: 'no task id here', details: {} });

        expect(aggregator.handle(malformed)).toEqual([malformed]);
    });

    it('reports start and completion deltas for the hub counter', () => {
        const aggregator = new BackgroundTaskAggregator();
        startBackgroundTask(aggregator);

        expect(aggregator.takeBackgroundTaskDelta()).toEqual({ started: 1, completed: 0 });
        expect(aggregator.takeBackgroundTaskDelta()).toBeNull();

        aggregator.handle(taskOutputCall({ id: 'poll-delta' }));
        aggregator.handle(taskOutputResult('succeeded', 'done', { id: 'poll-delta' }));

        expect(aggregator.takeBackgroundTaskDelta()).toEqual({ started: 0, completed: 1 });
    });

    it('reports completions for tasks canceled with the session', () => {
        const aggregator = new BackgroundTaskAggregator();
        startBackgroundTask(aggregator);

        expect(aggregator.takeBackgroundTaskDelta()).toEqual({ started: 1, completed: 0 });

        aggregator.cancelAll('Session aborted');

        expect(aggregator.takeBackgroundTaskDelta()).toEqual({ started: 0, completed: 1 });
    });

    it('releases a task whose stop was accepted when the turn ends', () => {
        // A polled task stays alive across turns: the agent polls it again
        // later. A task whose stop was accepted ("stopping") is not observed
        // again, so the hub counter must not keep it.
        const aggregator = new BackgroundTaskAggregator();
        startBackgroundTask(aggregator);
        expect(aggregator.takeBackgroundTaskDelta()).toEqual({ started: 1, completed: 0 });

        aggregator.handle(taskOutputCall({ id: 'poll-stop' }));
        aggregator.handle(taskOutputResult('running', 'working', { id: 'poll-stop' }));

        aggregator.handle(toolCall({ id: 'stop-1', name: 'task_stop', input: { task_id: 'bg_1' } }));
        aggregator.handle(toolResult({
            id: 'stop-1',
            text: '<task_stop status="stopping">Stop requested.</task_stop>',
            details: { task_id: 'bg_1', status: 'stopping' }
        }));

        // The turn ends: the task is released, so the counter drops.
        const released = aggregator.flushPromptEnd();
        expect(released).toHaveLength(1);
        expect(released[0]).toMatchObject({ type: 'tool_result', id: 'task-call' });
        expect(aggregator.takeBackgroundTaskDelta()).toEqual({ started: 0, completed: 1 });
    });

    it('keeps a polled task alive across turns while it still runs', () => {
        const aggregator = new BackgroundTaskAggregator();
        startBackgroundTask(aggregator);
        aggregator.takeBackgroundTaskDelta();
        aggregator.handle(taskOutputCall({ id: 'poll-live' }));
        aggregator.handle(taskOutputResult('running', 'working', { id: 'poll-live' }));

        expect(aggregator.flushPromptEnd()).toEqual([]);
        expect(aggregator.takeBackgroundTaskDelta()).toBeNull();
    });

    it('counts a released task again when it turns out to still run', () => {
        const aggregator = new BackgroundTaskAggregator();
        startBackgroundTask(aggregator);
        aggregator.takeBackgroundTaskDelta();
        aggregator.handle(taskOutputCall({ id: 'poll-stop' }));
        aggregator.handle(taskOutputResult('running', 'working', { id: 'poll-stop' }));
        aggregator.handle(toolCall({ id: 'stop-1', name: 'task_stop', input: { task_id: 'bg_1' } }));
        aggregator.handle(toolResult({
            id: 'stop-1',
            text: '<task_stop status="stopping">Stop requested.</task_stop>',
            details: { task_id: 'bg_1', status: 'stopping' }
        }));
        aggregator.flushPromptEnd();
        expect(aggregator.takeBackgroundTaskDelta()).toEqual({ started: 0, completed: 1 });

        // The stop did not take effect: the task runs on and is counted again.
        aggregator.handle(taskOutputCall({ id: 'poll-again' }));
        aggregator.handle(taskOutputResult('running', 'still working', { id: 'poll-again' }));

        expect(aggregator.takeBackgroundTaskDelta()).toEqual({ started: 1, completed: 0 });
    });
});
