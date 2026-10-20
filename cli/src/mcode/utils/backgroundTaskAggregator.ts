import { isObject } from '@hapi/protocol';
import type { AgentMessage } from '@/agent/types';

/**
 * mcode runs subagents and background bash commands out-of-band: the launch
 * tool (`task` / `bash`) returns immediately with a task id, and the agent
 * polls the task with `task_output` (plus `task_query` / `task_append` /
 * `task_stop`). The ACP adapter emits one `tool_call` snapshot per poll, so a
 * single background command can produce dozens of near-identical cards.
 *
 * This aggregator folds that lifecycle into the originating `Task` / `Bash`
 * card:
 * - a background launch result is held, keeping the card in the running state;
 * - polls for that task update the launch card's result instead of creating
 *   their own cards;
 * - a terminal status completes the launch card;
 * - polls for unknown tasks fall through as a single card (latest call only).
 *
 * mcode does not stream child tool calls over ACP, so this is the maximum
 * fidelity HAPI can borrow from its own subagent cards: one card per task with
 * live output, not a nested child trace.
 */

type ToolCallMessage = Extract<AgentMessage, { type: 'tool_call' }>;
type ToolResultMessage = Extract<AgentMessage, { type: 'tool_result' }>;

const BACKGROUND_LAUNCH_TOOLS = new Set(['Task', 'Bash']);
const BACKGROUND_CONTROL_TOOLS = new Set(['task_output', 'task_query', 'task_stop', 'task_append']);

const RUNNING_TASK_STATUSES = new Set([
    'started',
    'running',
    'in_progress',
    'pending',
    'queued',
    'accepted',
    'auto_promoted',
    'stopping'
]);

const TERMINAL_TASK_STATUSES = new Set([
    'completed',
    'complete',
    'succeeded',
    'success',
    'failed',
    'error',
    'canceled',
    'cancelled',
    'lost',
    'stopped',
    'killed'
]);

const FAILED_TASK_STATUSES = new Set(['failed', 'error']);

type ToolCallInfo = {
    name: string;
    input: unknown;
};

type TrackedTask = {
    taskId: string;
    callId: string;
    name: string;
    input: unknown;
    status: string | null;
    /** True once a task_* poll has been folded into the launch card. */
    polled: boolean;
    /** True once the launch result was forwarded and the card is completed. */
    launchResultForwarded: boolean;
};

type ParsedTaskResult = {
    taskId: string | null;
    status: string | null;
    text: string | null;
    details: Record<string, unknown> | null;
};

function readString(record: Record<string, unknown> | null, keys: readonly string[]): string | null {
    if (!record) return null;
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.trim().length > 0) {
            return value.trim();
        }
    }
    return null;
}

function outputRecord(output: unknown): Record<string, unknown> | null {
    if (isObject(output)) return output;
    if (typeof output !== 'string') return null;
    const trimmed = output.trim();
    if (!trimmed.startsWith('{')) return null;
    try {
        const parsed: unknown = JSON.parse(trimmed);
        return isObject(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function outputDetails(output: unknown): Record<string, unknown> | null {
    const record = outputRecord(output);
    if (!record) return null;
    if (isObject(record.details)) return record.details;
    if (isObject(record.task)) return record.task;
    if (isObject(record.output) && isObject(record.output.details)) return record.output.details;
    return null;
}

function blockText(block: unknown): string | null {
    if (typeof block === 'string') return block;
    if (!isObject(block)) return null;
    return typeof block.text === 'string' ? block.text : null;
}

function outputText(output: unknown): string | null {
    if (typeof output === 'string') return output;
    const record = outputRecord(output);
    if (!record) return null;

    if (typeof record.text === 'string') return record.text;
    if (typeof record.content === 'string') return record.content;

    if (Array.isArray(record.content)) {
        const parts = record.content
            .map(blockText)
            .filter((part): part is string => typeof part === 'string' && part.length > 0);
        if (parts.length > 0) return parts.join('\n');
    }

    if (typeof record.output === 'string') return record.output;
    if (isObject(record.output) && typeof record.output.content === 'string') {
        return record.output.content;
    }
    return null;
}

function matchAttribute(text: string | null, name: string): string | null {
    if (!text) return null;
    const match = text.match(new RegExp(`${name}="([^"]+)"`));
    return match?.[1]?.trim() || null;
}

function parseTaskResult(output: unknown): ParsedTaskResult {
    const text = outputText(output);
    const details = outputDetails(output);
    const taskId = readString(details, ['task_id', 'taskId']) ?? matchAttribute(text, 'task_id');
    const rawStatus = readString(details, ['status', 'state']) ?? matchAttribute(text, 'status');
    return {
        taskId,
        status: rawStatus ? rawStatus.toLowerCase() : null,
        text,
        details
    };
}

function cleanTaskText(text: string | null): string {
    if (!text) return '';
    return text
        .replace(/<task_append[^>]*\/>/g, '')
        .replace(/<task_output_cursor[^>]*\/>/g, '')
        .replace(
            /<\/?(?:task_output|bash_background|task_background|task_stop|task_query|task_append|bash_error|task_error)(?:\s[^>]*)?>/g,
            ''
        )
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function formatUpdateText(taskId: string, status: string | null, text: string | null, fallback: string): string {
    const body = cleanTaskText(text) || fallback;
    const header = status ? `Background task ${taskId} · ${status}` : `Background task ${taskId}`;
    return body ? `${header}\n${body}` : header;
}

function isBackgroundLaunch(parsed: ParsedTaskResult): boolean {
    if (!parsed.taskId) return false;
    if (parsed.status) return RUNNING_TASK_STATUSES.has(parsed.status);
    // Some mcode builds omit `details.status` but still wrap the result in a
    // background tag; treat that as a live task rather than completing the card.
    return /<(?:task|bash)_background\b/.test(parsed.text ?? '');
}

function isTerminalStatus(status: string | null): boolean {
    return status !== null && TERMINAL_TASK_STATUSES.has(status);
}

function isFailedStatus(status: string | null): boolean {
    return status !== null && FAILED_TASK_STATUSES.has(status);
}

function taskIdFromInput(input: unknown): string | null {
    return isObject(input) ? readString(input, ['task_id', 'taskId']) : null;
}

export class BackgroundTaskAggregator {
    private readonly toolCalls = new Map<string, ToolCallInfo>();
    private readonly tasks = new Map<string, TrackedTask>();
    private readonly bufferedCalls = new Map<string, ToolCallMessage>();
    private readonly heldLaunchResults = new Map<string, ToolResultMessage>();
    private startedCount = 0;
    private completedCount = 0;

    /**
     * Drains the lifecycle counters accumulated since the last call. The
     * launcher forwards them to the hub so `backgroundTaskCount` — and the
     * session idle/status logic built on it — matches the cards.
     */
    takeBackgroundTaskDelta(): { started: number; completed: number } | null {
        if (this.startedCount === 0 && this.completedCount === 0) return null;
        const delta = { started: this.startedCount, completed: this.completedCount };
        this.startedCount = 0;
        this.completedCount = 0;
        return delta;
    }

    /**
     * Returns the messages the launcher should forward. An empty array means
     * the message was folded into an existing card (or buffered for a poll).
     */
    handle(message: AgentMessage): AgentMessage[] {
        if (message.type === 'tool_call') {
            return this.handleToolCall(message);
        }
        if (message.type === 'tool_result') {
            return this.handleToolResult(message);
        }
        return [message];
    }

    /**
     * Called when a prompt/turn ends. A background task that was never polled
     * cannot be tracked reliably, so release its admission result and let the
     * card finish; polled tasks stay running and keep updating the card.
     */
    flushPromptEnd(): AgentMessage[] {
        const forwarded: AgentMessage[] = [];

        for (const task of this.tasks.values()) {
            if (task.polled || task.launchResultForwarded) continue;
            const held = this.heldLaunchResults.get(task.callId);
            if (!held) continue;
            this.heldLaunchResults.delete(task.callId);
            task.launchResultForwarded = true;
            // We can no longer observe this task, so release both the card and
            // the hub counter instead of leaving a permanently "running" entry.
            this.completedCount += 1;
            forwarded.push(held);
        }

        // An in-flight poll without a result belongs to an ended turn; dropping
        // it avoids leaving a permanently spinning control card. No tool call
        // can span turns, so the bookkeeping map is safe to clear as well.
        this.bufferedCalls.clear();
        this.toolCalls.clear();
        return forwarded;
    }

    /**
     * Completes every tracked task, e.g. when the user aborts the session.
     * Buffered, unresulted polls are discarded for the same reason as above.
     */
    cancelAll(reason: string): AgentMessage[] {
        const forwarded: AgentMessage[] = [];

        for (const task of this.tasks.values()) {
            forwarded.push({
                type: 'tool_result',
                id: task.callId,
                output: {
                    content: [{ type: 'text', text: `Background task ${task.taskId} canceled: ${reason}` }],
                    details: { task_id: task.taskId, status: 'canceled' }
                },
                status: 'completed'
            });
            this.completedCount += 1;
        }

        this.tasks.clear();
        this.heldLaunchResults.clear();
        this.bufferedCalls.clear();
        this.toolCalls.clear();
        return forwarded;
    }

    private handleToolCall(message: ToolCallMessage): AgentMessage[] {
        const tracked = BACKGROUND_LAUNCH_TOOLS.has(message.name) || BACKGROUND_CONTROL_TOOLS.has(message.name);
        if (tracked) {
            this.toolCalls.set(message.id, { name: message.name, input: message.input });
        }

        if (BACKGROUND_CONTROL_TOOLS.has(message.name)) {
            // mcode emits a run of empty "pending" snapshots before the real
            // arguments arrive; keep only the latest so an unknown-task poll
            // can still fall through as one card.
            this.bufferedCalls.set(message.id, message);
            return [];
        }

        return [message];
    }

    private handleToolResult(message: ToolResultMessage): AgentMessage[] {
        const call = this.toolCalls.get(message.id);
        if (!call) return [message];
        this.toolCalls.delete(message.id);

        if (BACKGROUND_LAUNCH_TOOLS.has(call.name)) {
            const parsed = parseTaskResult(message.output);
            if (isBackgroundLaunch(parsed) && parsed.taskId) {
                this.tasks.set(parsed.taskId, {
                    taskId: parsed.taskId,
                    callId: message.id,
                    name: call.name,
                    input: call.input,
                    status: parsed.status,
                    polled: false,
                    launchResultForwarded: false
                });
                this.startedCount += 1;
                this.heldLaunchResults.set(message.id, message);
                return [];
            }
            return [message];
        }

        if (BACKGROUND_CONTROL_TOOLS.has(call.name)) {
            return this.handleControlResult(call, message);
        }

        return [message];
    }

    private handleControlResult(call: ToolCallInfo, message: ToolResultMessage): AgentMessage[] {
        const buffered = this.bufferedCalls.get(message.id);
        this.bufferedCalls.delete(message.id);

        const parsed = parseTaskResult(message.output);
        const taskId = taskIdFromInput(buffered?.input ?? call.input) ?? parsed.taskId;
        const task = taskId ? this.tasks.get(taskId) : undefined;

        if (!task) {
            // Unknown task (e.g. a query for a task launched before this
            // process started): forward the latest call plus its result.
            return buffered ? [buffered, message] : [message];
        }

        task.polled = true;
        task.status = parsed.status ?? task.status;

        // task_append can activate an idle child under a NEW task id. Re-key
        // the tracked task so later task_output calls still land on this card.
        if (call.name === 'task_append' && parsed.taskId && parsed.taskId !== task.taskId) {
            this.tasks.delete(task.taskId);
            task.taskId = parsed.taskId;
            this.tasks.set(task.taskId, task);
        }

        const terminal = isTerminalStatus(parsed.status);
        const appendMode = readString(parsed.details, ['mode']);
        const fallback = call.name === 'task_append'
            ? (appendMode ? `Follow-up sent (${appendMode})` : 'Follow-up sent')
            : call.name === 'task_stop'
                ? 'Stop requested'
                : 'No output yet';
        const text = formatUpdateText(task.taskId, parsed.status, parsed.text, fallback);
        const update = this.buildUpdate(task, text, parsed.status, terminal);

        if (terminal) {
            this.tasks.delete(task.taskId);
            this.heldLaunchResults.delete(task.callId);
            this.completedCount += 1;
        }

        return [update];
    }

    private buildUpdate(
        task: TrackedTask,
        text: string,
        status: string | null,
        terminal: boolean
    ): AgentMessage {
        const output = {
            content: [{ type: 'text' as const, text }],
            details: {
                task_id: task.taskId,
                ...(status ? { status } : {})
            }
        };

        if (terminal || task.launchResultForwarded) {
            return {
                type: 'tool_result',
                id: task.callId,
                output,
                status: isFailedStatus(status) ? 'failed' : 'completed'
            };
        }

        return {
            type: 'tool_call',
            id: task.callId,
            name: task.name,
            input: task.input,
            status: 'in_progress',
            progress: output
        };
    }
}
