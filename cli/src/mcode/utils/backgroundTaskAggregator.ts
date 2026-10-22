import { isObject } from '@hapi/protocol';
import type { AgentMessage } from '@/agent/types';

/**
 * mcode runs background work out-of-band: the launch tool (`bash` with
 * `run_in_background`, or `task`) returns immediately with a task id, and the
 * agent reads the task back with `task_output` (plus `task_query` /
 * `task_append` / `task_stop`). The ACP adapter emits one `tool_call` snapshot
 * per poll, so a single background command can produce dozens of
 * near-identical cards.
 *
 * This aggregator folds that lifecycle into the originating `Bash` / `Task`
 * card:
 * - a background launch result is held, keeping the card in the running state;
 * - polls for that task update the launch card's result instead of creating
 *   their own cards;
 * - a terminal status completes the launch card;
 * - polls for unknown tasks fall through as a single card (latest call only).
 *
 * On top of the cards it keeps a **ledger** of the background work the session
 * still has going. The ledger is what the user is shown, so it only holds what
 * HAPI can actually back up:
 *
 * - a task enters the ledger when the agent launches it;
 * - a task leaves it when the agent reports a terminal status, or when the
 *   agent stops asking about it (nothing proves it still runs, so counting it
 *   would be a guess).
 *
 * The count of running background work is therefore the size of the ledger -
 * an absolute number that cannot drift the way a started-minus-completed
 * counter does. A completion HAPI never sees (the agent finishes a task
 * between two turns and reports it in a turn of its own) used to leave the
 * counter stuck for the rest of the session.
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
    'background_started',
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

/**
 * How many turns may pass without the agent asking about a task before HAPI
 * stops counting it as running.
 *
 * Two turns is long enough for an agent that looks at a slow job every other
 * turn, and short enough that a task the agent abandoned does not keep the
 * session busy forever. A terminal status settles it for good.
 */
const UNTRACKED_AFTER_TURNS = 2;

/**
 * One background task, as far as HAPI can tell.
 *
 * Only tasks HAPI believes are still running are in the ledger, so every
 * record here is a task the session has going.
 */
export type BackgroundTaskRecord = {
    id: string;
    /** The command the agent ran. */
    command: string;
    cwd: string | null;
    /** Epoch milliseconds: when HAPI first saw the task start. */
    startedAt: number;
};

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
    /**
     * True while the agent asked about this task in the current turn.
     *
     * A task the agent asks about every turn is one it is watching, and it
     * stays "running". A task it stopped asking about is not observed any
     * more, and after a turn or two it leaves the running count.
     */
    askedThisTurn: boolean;
    /** How many turns passed without the agent asking about this task. */
    turnsUnasked: number;
    /** True once the launch result was forwarded and the card is completed. */
    launchResultForwarded: boolean;
    /**
     * True once the task was counted as completed. The hub counter and the
     * card must agree, so a task that was already released (or already
     * finished) is never counted or completed a second time.
     */
    completed: boolean;
    /**
     * True once a stop was accepted for this task (`task_stop` answered
     * "stopping"). The task winds down and is not observed again, so it is
     * released at the end of the turn — otherwise the session would keep
     * counting a task that no longer runs.
     */
    stopRequested: boolean;
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

/** The command the agent ran. */
function readCommand(input: unknown): string | null {
    if (!isObject(input)) return null;
    const command = input.command;
    if (typeof command === 'string' && command.trim().length > 0) return command.trim();
    if (Array.isArray(command)) {
        const parts = command.filter((part): part is string => typeof part === 'string');
        if (parts.length > 0) return parts.join(' ').trim();
    }
    for (const key of ['description', 'summary', 'prompt']) {
        const value = input[key];
        if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    }
    return null;
}

function readCwd(input: unknown): string | null {
    if (!isObject(input)) return null;
    for (const key of ['cwd', 'workdir', 'path']) {
        const value = input[key];
        if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    }
    return null;
}

export class BackgroundTaskAggregator {
    private readonly toolCalls = new Map<string, ToolCallInfo>();
    private readonly tasks = new Map<string, TrackedTask>();
    private readonly bufferedCalls = new Map<string, ToolCallMessage>();
    private readonly heldLaunchResults = new Map<string, ToolResultMessage>();
    /** The background work the session still has going. */
    private readonly records = new Map<string, BackgroundTaskRecord>();

    /**
     * The directory the session runs in.
     *
     * The agent's bash tool does not repeat it in every call, so it is the
     * fallback for the tasks that do not name one.
     */
    private defaultCwd: string | null;

    /**
     * @param options.cwd the directory the session runs in.
     */
    constructor(options: { cwd?: string | null } = {}) {
        this.defaultCwd = options.cwd ?? null;
    }

    /**
     * Sets the directory the session runs in.
     *
     * The launcher learns the path after it is constructed, so the fallback
     * cannot be a constructor argument.
     */
    setDefaultCwd(cwd: string | null): void {
        this.defaultCwd = cwd;
    }

    /**
     * The background work the session still has going, oldest first.
     *
     * This is what the user is shown, so it carries what the agent ran and
     * where it runs.
     */
    snapshot(): BackgroundTaskRecord[] {
        return [...this.records.values()];
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
     * Rebuilds the ledger from a replayed conversation history.
     *
     * When the agent process is replaced, HAPI asks it to load the session
     * again. The agent replays the conversation, and that replay contains the
     * tool calls of the turns HAPI never saw - including the turn in which the
     * agent read a finished background task. Without this, a task that
     * finished while HAPI was not looking would keep counting as running until
     * the session was closed.
     *
     * The replay is history, not a live turn: it updates the ledger but never
     * produces cards, because the transcript already holds them.
     */
    reconcile(messages: readonly AgentMessage[]): void {
        for (const message of messages) {
            if (message.type === 'tool_call') {
                this.replayToolCall(message);
                continue;
            }
            if (message.type === 'tool_result') {
                this.replayToolResult(message);
            }
        }
    }

    /**
     * Called when a prompt/turn ends.
     *
     * A task the agent asked about in this turn is one it is watching, so it
     * keeps running and keeps updating its card. A task the agent stopped
     * asking about is not observed any more - nothing in the stream proves it
     * still runs - so it leaves the running count after a turn or two instead
     * of keeping the session busy forever.
     *
     * A launch that was never polled cannot be observed any more, so its card
     * is released and it completes.
     */
    flushPromptEnd(): AgentMessage[] {
        const forwarded: AgentMessage[] = [];

        for (const task of this.tasks.values()) {
            if (task.completed) continue;

            if (task.askedThisTurn) {
                task.askedThisTurn = false;
                task.turnsUnasked = 0;
            } else {
                task.turnsUnasked += 1;
                if (task.turnsUnasked >= UNTRACKED_AFTER_TURNS) {
                    // Nothing proves the task still runs, so it stops counting.
                    // The task stays tracked: a later turn may still poll it,
                    // and that poll puts it back into the running count.
                    this.records.delete(task.taskId);
                }
            }

            // A task whose stop was accepted is not observed again, so it
            // leaves the count and its card completes.
            if (task.stopRequested) {
                this.records.delete(task.taskId);
                this.heldLaunchResults.delete(task.callId);
                task.completed = true;
                forwarded.push({
                    type: 'tool_result',
                    id: task.callId,
                    output: {
                        content: [{ type: 'text', text: `Background task ${task.taskId} stopped` }],
                        details: { task_id: task.taskId, status: 'stopped' }
                    },
                    status: 'completed'
                });
                continue;
            }

            if (task.polled) continue;

            const held = this.heldLaunchResults.get(task.callId);
            if (!held) continue;
            this.heldLaunchResults.delete(task.callId);
            task.launchResultForwarded = true;
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
            // A task that was already released has a complete card; completing
            // it again would duplicate the card.
            if (task.completed || task.launchResultForwarded) continue;
            forwarded.push({
                type: 'tool_result',
                id: task.callId,
                output: {
                    content: [{ type: 'text', text: `Background task ${task.taskId} canceled: ${reason}` }],
                    details: { task_id: task.taskId, status: 'canceled' }
                },
                status: 'completed'
            });
            task.completed = true;
            this.records.delete(task.taskId);
        }

        this.tasks.clear();
        this.heldLaunchResults.clear();
        this.bufferedCalls.clear();
        this.toolCalls.clear();
        this.records.clear();
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
                const existing = this.tasks.get(parsed.taskId);
                if (existing) {
                    // The same task id was launched twice. Tracking it again
                    // would orphan the first card (its held result would never
                    // be released) and count a second start, so the duplicate
                    // launch is forwarded as a plain result instead.
                    return [message];
                }
                this.tasks.set(parsed.taskId, {
                    taskId: parsed.taskId,
                    callId: message.id,
                    name: call.name,
                    input: call.input,
                    status: parsed.status,
                    polled: false,
                    askedThisTurn: false,
                    turnsUnasked: 0,
                    launchResultForwarded: false,
                    completed: false,
                    stopRequested: false
                });
                this.records.set(parsed.taskId, {
                    id: parsed.taskId,
                    command: readCommand(call.input) ?? parsed.taskId,
                    cwd: readCwd(call.input) ?? this.defaultCwd,
                    startedAt: Date.now()
                });
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
        task.askedThisTurn = true;
        task.turnsUnasked = 0;
        task.status = parsed.status ?? task.status;

        // A stop that was accepted ("stopping") means the task winds down and
        // is not observed again: it is released at the end of the turn.
        if (parsed.status === 'stopping') {
            task.stopRequested = true;
        }

        // A task that was released at the end of an earlier turn but turned
        // out to still run is running again.
        if (task.completed && !isTerminalStatus(parsed.status)) {
            task.completed = false;
            task.stopRequested = false;
        }
        // The agent asked about it, so it runs - unless it reported a final
        // status, which is handled below.
        if (!isTerminalStatus(parsed.status)) {
            this.markRunning(task);
        }

        // task_append can activate an idle child under a NEW task id. Re-key
        // the tracked task so later task_output calls still land on this card.
        if (call.name === 'task_append' && parsed.taskId && parsed.taskId !== task.taskId) {
            this.tasks.delete(task.taskId);
            const record = this.records.get(task.taskId);
            this.records.delete(task.taskId);
            task.taskId = parsed.taskId;
            this.tasks.set(task.taskId, task);
            if (record) {
                this.records.set(task.taskId, { ...record, id: task.taskId });
            }
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
            task.completed = true;
            this.records.delete(task.taskId);
        }

        return [update];
    }

    /**
     * Puts a task back into the running count.
     *
     * A task that was launched in an earlier turn - or before this process
     * started - has no record yet, so one is created from what the agent
     * reported about it.
     */
    private markRunning(task: TrackedTask): void {
        const existing = this.records.get(task.taskId);
        if (existing) return;
        this.records.set(task.taskId, {
            id: task.taskId,
            command: readCommand(task.input) ?? task.taskId,
            cwd: readCwd(task.input) ?? this.defaultCwd,
            startedAt: Date.now()
        });
    }

    private replayToolCall(message: ToolCallMessage): void {
        if (!BACKGROUND_LAUNCH_TOOLS.has(message.name) && !BACKGROUND_CONTROL_TOOLS.has(message.name)) {
            return;
        }
        this.toolCalls.set(message.id, { name: message.name, input: message.input });
    }

    private replayToolResult(message: ToolResultMessage): void {
        const call = this.toolCalls.get(message.id);
        if (!call) return;
        this.toolCalls.delete(message.id);

        const parsed = parseTaskResult(message.output);
        const taskId = readString(parsed.details, ['task_id', 'taskId'])
            ?? taskIdFromInput(call.input)
            ?? matchAttribute(parsed.text, 'task_id');
        if (!taskId) return;

        if (BACKGROUND_LAUNCH_TOOLS.has(call.name)) {
            if (!isBackgroundLaunch(parsed)) return;
            if (this.tasks.has(taskId)) return;
            this.tasks.set(taskId, {
                taskId,
                callId: message.id,
                name: call.name,
                input: call.input,
                status: parsed.status,
                polled: false,
                askedThisTurn: false,
                turnsUnasked: 0,
                // The transcript already holds the card of this launch, so the
                // replay must not produce one.
                launchResultForwarded: true,
                completed: false,
                stopRequested: false
            });
            this.records.set(taskId, {
                id: taskId,
                command: readCommand(call.input) ?? taskId,
                cwd: readCwd(call.input) ?? this.defaultCwd,
                startedAt: Date.now()
            });
            return;
        }

        // A poll: a terminal status settles the task for good, anything else
        // says it is still alive.
        if (isTerminalStatus(parsed.status)) {
            this.records.delete(taskId);
            this.tasks.delete(taskId);
            return;
        }

        const task = this.tasks.get(taskId);
        if (!task) return;
        task.polled = true;
        task.turnsUnasked = 0;
        if (this.records.has(taskId)) return;
        this.records.set(taskId, {
            id: taskId,
            command: readCommand(task.input) ?? taskId,
            cwd: readCwd(task.input) ?? this.defaultCwd,
            startedAt: Date.now()
        });
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
