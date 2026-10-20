import { isObject } from '@hapi/protocol';
import type { AgentMessage } from '@/agent/types';

/**
 * MiniMax Code feeds HAPI its native tool names (`read`, `bash`, `edit`, ...)
 * while the web/native clients key their richer cards on HAPI's canonical
 * names (`Read`, `Bash`, `Edit`, ...). Some payloads diverge in shape too:
 *
 * - `todowrite` carries the canonical TodoWrite list, but the tool name is
 *   lowercase and entries may be marked `cancelled`;
 * - `skill` names the skill under `name`, while the card reads `skill`.
 *
 * Normalising at the mcode boundary keeps every downstream consumer — hub
 * todo extraction, web cards, native clients — on one dialect. This mirrors
 * the existing `normalizeMcodeAskUserToolCall` shim and the Cursor
 * `cursor/update_todos` adapter.
 */

type TodoStatus = 'pending' | 'in_progress' | 'completed';
type TodoPriority = 'high' | 'medium' | 'low';

/** Canonical HAPI tool name, keyed by a separator/case-insensitive name. */
const CANONICAL_TOOL_NAMES: Record<string, string> = {
    read: 'Read',
    write: 'Write',
    edit: 'Edit',
    bash: 'Bash',
    glob: 'Glob',
    grep: 'Grep',
    webfetch: 'WebFetch',
    websearch: 'WebSearch',
    skill: 'Skill',
    task: 'Task',
    todowrite: 'TodoWrite'
};

function normalizedToolKey(name: string): string {
    return name.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

export function canonicalMcodeToolName(name: string): string | null {
    return CANONICAL_TOOL_NAMES[normalizedToolKey(name)] ?? null;
}

function normalizeTodoStatus(value: unknown): TodoStatus {
    const status = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (status === 'in_progress') return 'in_progress';
    if (status === 'completed' || status === 'cancelled' || status === 'canceled') return 'completed';
    return 'pending';
}

function normalizeTodoPriority(value: unknown): TodoPriority {
    const priority = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (priority === 'high' || priority === 'low') return priority;
    return 'medium';
}

function normalizeTodoEntry(entry: unknown): Record<string, unknown> | null {
    if (!isObject(entry)) return null;
    if (typeof entry.content !== 'string' || entry.content.trim().length === 0) return null;

    const normalized: Record<string, unknown> = {
        content: entry.content,
        status: normalizeTodoStatus(entry.status),
        priority: normalizeTodoPriority(entry.priority)
    };
    if (typeof entry.id === 'string' && entry.id.length > 0) {
        normalized.id = entry.id;
    }
    if (typeof entry.activeForm === 'string' && entry.activeForm.length > 0) {
        normalized.activeForm = entry.activeForm;
    }
    return normalized;
}

/**
 * Rewrites the todo tool input into the shape `TodosSchema` accepts. Unknown
 * fields on the envelope are preserved; malformed entries are dropped instead
 * of letting one bad row invalidate the whole list in the hub.
 */
export function normalizeTodoToolInput(input: unknown): unknown {
    if (!isObject(input) || !Array.isArray(input.todos)) return input;

    const todos = input.todos
        .map(normalizeTodoEntry)
        .filter((entry): entry is Record<string, unknown> => entry !== null);

    return { ...input, todos };
}

/**
 * mcode's `skill` payload uses `name`; HAPI's Skill card reads `skill`.
 * Keep the native field as well so the raw input stays inspectable.
 */
export function normalizeSkillToolInput(input: unknown): unknown {
    if (!isObject(input)) return input;
    if (typeof input.skill === 'string' && input.skill.length > 0) return input;
    if (typeof input.name !== 'string' || input.name.length === 0) return input;
    return { ...input, skill: input.name };
}

function normalizeToolInput(canonicalName: string, input: unknown): unknown {
    if (canonicalName === 'TodoWrite') return normalizeTodoToolInput(input);
    if (canonicalName === 'Skill') return normalizeSkillToolInput(input);
    return input;
}

export function normalizeMcodeToolCall(message: AgentMessage): AgentMessage {
    if (message.type !== 'tool_call') return message;

    const canonicalName = canonicalMcodeToolName(message.name);
    if (!canonicalName) return message;

    return {
        ...message,
        name: canonicalName,
        input: normalizeToolInput(canonicalName, message.input)
    };
}
