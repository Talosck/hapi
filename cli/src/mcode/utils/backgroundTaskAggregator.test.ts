import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@/agent/types';
import { BackgroundTaskAggregator } from './backgroundTaskAggregator';
import { normalizeMcodeToolCall } from './toolCallNormalizer';

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
    input?: Record<string, unknown>;
} = {}): void {
    const callId = overrides.callId ?? 'task-call';
    const taskId = overrides.taskId ?? 'bg_1';
    const name = overrides.name ?? 'Task';

    expect(aggregator.handle(toolCall({
        id: callId,
        name,
        input: overrides.input ?? (name === 'Bash'
            ? { command: 'npm run dev', run_in_background: true }
            : { description: 'Research the repo', prompt: 'Look around' })
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

        expect(aggregator.flushPromptEnd()).toEqual([held]);

        // Once the launch card is complete, later polls update its result
        // instead of emitting a running progress snapshot.
        aggregator.handle(taskOutputCall({ id: 'poll-late' }));
        const [update] = aggregator.handle(taskOutputResult('running', 'later output', { id: 'poll-late' }));
        expect(update).toMatchObject({ type: 'tool_result', id: 'task-call' });
    });

    it('does not complete a released task again when the session is aborted', () => {
        const aggregator = new BackgroundTaskAggregator();
        startBackgroundTask(aggregator);
        aggregator.flushPromptEnd();

        expect(aggregator.cancelAll('Session aborted')).toEqual([]);
    });

    it('keeps the first card when the same task id is launched twice', () => {
        const aggregator = new BackgroundTaskAggregator();
        startBackgroundTask(aggregator, { callId: 'call-a' });

        // The same task id again: the second launch is forwarded as a plain
        // result instead of orphaning the first card and counting a second
        // task.
        aggregator.handle(toolCall({ id: 'call-b', name: 'Task' }));
        const duplicate = toolResult({
            id: 'call-b',
            text: '<task_background task_id="bg_1">Started background task bg_1.</task_background>',
            details: { task_id: 'bg_1', status: 'started' }
        });
        expect(aggregator.handle(duplicate)).toEqual([duplicate]);
        expect(aggregator.snapshot().length).toBe(1);

        // The original card is still the one that completes.
        aggregator.handle(taskOutputCall({ id: 'poll-1' }));
        const [update] = aggregator.handle(taskOutputResult('succeeded', 'done'));
        expect(update).toMatchObject({ type: 'tool_result', id: 'call-a' });
        expect(aggregator.snapshot().length).toBe(0);
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
        expect(aggregator.snapshot().length).toBe(0);
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
        expect(aggregator.snapshot().length).toBe(0);
    });

    describe('the running ledger', () => {
        it('publishes the command and the directory of the task that is running', () => {
            const aggregator = new BackgroundTaskAggregator({ cwd: '/home/dev/project' });
            startBackgroundTask(aggregator, {
                name: 'Bash',
                taskId: 'bg_bash',
                input: { command: 'npm run dev', run_in_background: true }
            });

            expect(aggregator.snapshot()).toEqual([
                {
                    id: 'bg_bash',
                    command: 'npm run dev',
                    cwd: '/home/dev/project',
                    startedAt: expect.any(Number)
                }
            ]);
            expect(aggregator.snapshot().length).toBe(1);
        });

        it('takes the directory from the call when the agent names one', () => {
            const aggregator = new BackgroundTaskAggregator({ cwd: '/home/dev/project' });
            startBackgroundTask(aggregator, {
                name: 'Bash',
                taskId: 'bg_bash',
                input: { command: 'npm run dev', cwd: '/srv/app', run_in_background: true }
            });

            expect(aggregator.snapshot()[0]?.cwd).toBe('/srv/app');
        });

        it('drops the task once the agent reports a final status', () => {
            const aggregator = new BackgroundTaskAggregator();
            startBackgroundTask(aggregator);
            expect(aggregator.snapshot().length).toBe(1);

            aggregator.handle(taskOutputCall({ id: 'poll-done' }));
            aggregator.handle(taskOutputResult('succeeded', 'done', { id: 'poll-done' }));

            expect(aggregator.snapshot().length).toBe(0);
            expect(aggregator.snapshot()).toEqual([]);
        });

        it('keeps a task the agent is watching across turns', () => {
            const aggregator = new BackgroundTaskAggregator();
            startBackgroundTask(aggregator);
            aggregator.handle(taskOutputCall({ id: 'poll-live' }));
            aggregator.handle(taskOutputResult('running', 'working', { id: 'poll-live' }));

            expect(aggregator.flushPromptEnd()).toEqual([]);
            expect(aggregator.snapshot().length).toBe(1);

            // The agent asks about it again in the next turn: it is still
            // running, so it keeps counting.
            aggregator.handle(taskOutputCall({ id: 'poll-live-2' }));
            aggregator.handle(taskOutputResult('running', 'still working', { id: 'poll-live-2' }));
            expect(aggregator.flushPromptEnd()).toEqual([]);
            expect(aggregator.snapshot().length).toBe(1);
        });

        it('stops counting a task the agent stopped asking about', () => {
            const aggregator = new BackgroundTaskAggregator();
            startBackgroundTask(aggregator);
            aggregator.handle(taskOutputCall({ id: 'poll-live' }));
            aggregator.handle(taskOutputResult('running', 'working', { id: 'poll-live' }));

            // The turn the agent asked about it in does not count as unasked.
            aggregator.flushPromptEnd();
            expect(aggregator.snapshot().length).toBe(1);

            // One turn without the agent asking about it: a grace turn.
            aggregator.flushPromptEnd();
            expect(aggregator.snapshot().length).toBe(1);

            // Nothing in the stream proves it still runs, so it leaves the
            // count instead of keeping the session busy forever.
            aggregator.flushPromptEnd();
            expect(aggregator.snapshot().length).toBe(0);
        });

        it('counts a released task again when the agent turns out to still watch it', () => {
            const aggregator = new BackgroundTaskAggregator();
            startBackgroundTask(aggregator);
            aggregator.flushPromptEnd();
            aggregator.flushPromptEnd();
            aggregator.flushPromptEnd();
            expect(aggregator.snapshot().length).toBe(0);

            aggregator.handle(taskOutputCall({ id: 'poll-again' }));
            aggregator.handle(taskOutputResult('running', 'still working', { id: 'poll-again' }));
            expect(aggregator.snapshot().length).toBe(1);
        });

        it('stops counting a task whose stop was accepted', () => {
            const aggregator = new BackgroundTaskAggregator();
            startBackgroundTask(aggregator);
            aggregator.handle(taskOutputCall({ id: 'poll-stop' }));
            aggregator.handle(taskOutputResult('running', 'working', { id: 'poll-stop' }));

            aggregator.handle(toolCall({ id: 'stop-1', name: 'task_stop', input: { task_id: 'bg_1' } }));
            aggregator.handle(toolResult({
                id: 'stop-1',
                text: '<task_stop status="stopping">Stop requested.</task_stop>',
                details: { task_id: 'bg_1', status: 'stopping' }
            }));

            const released = aggregator.flushPromptEnd();
            expect(released).toHaveLength(1);
            expect(released[0]).toMatchObject({ type: 'tool_result', id: 'task-call' });
            expect(aggregator.snapshot().length).toBe(0);
        });

        it('counts every task the session has going', () => {
            const aggregator = new BackgroundTaskAggregator();
            startBackgroundTask(aggregator, { callId: 'call-a', taskId: 'bg_a' });
            startBackgroundTask(aggregator, { callId: 'call-b', taskId: 'bg_b' });

            expect(aggregator.snapshot().length).toBe(2);
            expect(aggregator.snapshot().map((task) => task.id)).toEqual(['bg_a', 'bg_b']);
        });
    });

    describe('the payloads MiniMax Code really sends', () => {
        it('reads the ledger out of a real background launch and its poll', () => {
            // Captured from `mcode acp`: the launch of a background command
            // and the poll the agent runs in the same turn.
            const aggregator = new BackgroundTaskAggregator({ cwd: '/home/talos/proj' });
            const feed = (message: AgentMessage) => aggregator.handle(normalizeMcodeToolCall(message));

            feed({
                type: 'tool_call',
                id: 'call_1',
                name: 'bash',
                input: {
                    command: 'sleep 4 && echo hello-from-background',
                    description: 'Run sleep 4 and echo hello-from-background',
                    run_in_background: true
                },
                status: 'pending'
            });
            feed({
                type: 'tool_result',
                id: 'call_1',
                output: {
                    content: [{ type: 'text', text: '<bash_background task_id="bg_62208582-734c-4936-854e-a1529eb5a1d0">\n...\n</bash_background>' }],
                    details: {
                        description: 'Run sleep 4 and echo hello-from-background',
                        timing: {},
                        envSanitized: [],
                        status: 'started',
                        task_id: 'bg_62208582-734c-4936-854e-a1529eb5a1d0'
                    }
                },
                status: 'completed'
            });

            expect(aggregator.snapshot()).toEqual([
                {
                    id: 'bg_62208582-734c-4936-854e-a1529eb5a1d0',
                    command: 'sleep 4 && echo hello-from-background',
                    cwd: '/home/talos/proj',
                    startedAt: expect.any(Number)
                }
            ]);

            feed({
                type: 'tool_call',
                id: 'poll_1',
                name: 'task_output',
                input: { task_id: 'bg_62208582-734c-4936-854e-a1529eb5a1d0', wait_ms: 10000 },
                status: 'completed'
            });
            feed({
                type: 'tool_result',
                id: 'poll_1',
                output: {
                    content: [{ type: 'text', text: '<task_output status="succeeded">\n<bash_status>Command exited with code 0</bash_status>\nhello-from-background\n\n</task_output>' }],
                    details: {
                        task_id: 'bg_62208582-734c-4936-854e-a1529eb5a1d0',
                        status: 'succeeded',
                        execution: { status: 'succeeded', reason: 'exited', exitCode: 0 },
                        output: {},
                        timing: {},
                        effective_wait_ms: 10000,
                        wait_ms_clamped: false,
                        timed_out: false,
                        next_offset: 22,
                        truncated: false
                    }
                },
                status: 'completed'
            });

            expect(aggregator.snapshot()).toEqual([]);
        });
    });

    describe('reconciling a replayed conversation', () => {
        it('settles a task the agent finished while HAPI was not watching', () => {
            const aggregator = new BackgroundTaskAggregator();

            // What the agent replays when the session is loaded: the launch,
            // then the turn in which the agent read the finished task.
            aggregator.reconcile([
                toolCall({
                    id: 'call-1',
                    name: 'Bash',
                    input: { command: 'npm run dev', run_in_background: true }
                }),
                toolResult({
                    id: 'call-1',
                    text: '<bash_background task_id="bg_1">Started.</bash_background>',
                    details: { task_id: 'bg_1', status: 'started' }
                }),
                toolCall({ id: 'poll-1', name: 'task_output', input: { task_id: 'bg_1' } }),
                toolResult({
                    id: 'poll-1',
                    text: '<task_output status="succeeded">done</task_output>',
                    details: { task_id: 'bg_1', status: 'succeeded' }
                })
            ]);

            expect(aggregator.snapshot().length).toBe(0);
        });

        it('keeps a task the agent never reported a final status for', () => {
            const aggregator = new BackgroundTaskAggregator();

            aggregator.reconcile([
                toolCall({
                    id: 'call-1',
                    name: 'Bash',
                    input: { command: 'npm run dev', run_in_background: true }
                }),
                toolResult({
                    id: 'call-1',
                    text: '<bash_background task_id="bg_1">Started.</bash_background>',
                    details: { task_id: 'bg_1', status: 'started' }
                })
            ]);

            expect(aggregator.snapshot().length).toBe(1);
            expect(aggregator.snapshot()[0]?.command).toBe('npm run dev');
        });

        it('stops counting a reconciled task the agent stopped asking about', () => {
            const aggregator = new BackgroundTaskAggregator();

            aggregator.reconcile([
                toolCall({
                    id: 'call-1',
                    name: 'Bash',
                    input: { command: 'npm run dev', run_in_background: true }
                }),
                toolResult({
                    id: 'call-1',
                    text: '<bash_background task_id="bg_1">Started.</bash_background>',
                    details: { task_id: 'bg_1', status: 'started' }
                })
            ]);
            expect(aggregator.snapshot().length).toBe(1);

            // Nobody asked about it since the replay, so it leaves the count
            // like any other task the agent stopped watching.
            aggregator.flushPromptEnd();
            expect(aggregator.snapshot().length).toBe(1);
            aggregator.flushPromptEnd();
            expect(aggregator.snapshot().length).toBe(0);
        });

        it('does not report the replayed messages as new cards', () => {
            const aggregator = new BackgroundTaskAggregator();

            aggregator.reconcile([
                toolCall({
                    id: 'call-1',
                    name: 'Bash',
                    input: { command: 'npm run dev', run_in_background: true }
                })
            ]);

            // The transcript already holds these messages; reconciling must
            // not add anything to it.
            expect(aggregator.handle(toolCall({ id: 'call-1', name: 'Bash' }))).toHaveLength(1);
        });
    });
});
