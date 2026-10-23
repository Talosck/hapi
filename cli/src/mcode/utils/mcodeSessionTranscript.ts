import { readFile } from 'node:fs/promises';
import { logger } from '@/ui/logger';
import type { AgentMessage } from '@/agent/types';

/**
 * MiniMax Code's conversation on disk.
 *
 * The agent writes every session as `<sessionDir>/messages.jsonl`, one JSON
 * object per line: `{ message_id, turn_id, message }`. The message carries the
 * role, its content blocks and - for a tool call - the raw arguments the model
 * asked for. A tool result is a message of its own that points back at the
 * call it answers.
 *
 * HAPI reads this file to rebuild what the agent did while nobody was
 * watching. The other way to get there is `session/load`, which makes the
 * agent replay the whole conversation over ACP - hundreds of kilobytes on a
 * long session, all of it parsed and then dropped, because the transcript
 * already holds those messages. The file says the same thing without the
 * round trip.
 *
 * The shapes below are the agent's, not HAPI's: an unknown block is skipped
 * instead of guessed at, so a format change costs a missing card rather than a
 * wrong one.
 */

/** The transcript file the agent writes inside a session directory. */
export const MCODE_TRANSCRIPT_FILE = 'messages.jsonl';

type TranscriptBlock = {
    type?: unknown;
    id?: unknown;
    name?: unknown;
    arguments?: unknown;
};

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The tool calls of one assistant message.
 *
 * An assistant message can hold several calls (parallel tool calls), and the
 * ACP adapter emits one update per call, so the file is read the same way.
 */
function readToolCalls(content: unknown): AgentMessage[] {
    if (!Array.isArray(content)) return [];
    const messages: AgentMessage[] = [];
    for (const block of content as TranscriptBlock[]) {
        if (!isObject(block) || block.type !== 'toolCall') continue;
        const id = readString(block.id);
        const name = readString(block.name);
        if (!id || !name) continue;
        messages.push({
            type: 'tool_call',
            id,
            name,
            input: block.arguments ?? null,
            status: 'completed'
        });
    }
    return messages;
}

/**
 * The result of one tool call.
 *
 * The agent's raw output is `{ content, details }` - the same object the ACP
 * adapter hands over as `rawOutput`, so the details a reader expects (the
 * task id, the execution status) are in the same place.
 */
function readToolResult(message: Record<string, unknown>): AgentMessage | null {
    const id = readString(message.toolCallId);
    if (!id) return null;
    const details = message.details;
    const output = {
        content: message.content ?? null,
        ...(details === undefined ? {} : { details })
    };
    return {
        type: 'tool_result',
        id,
        output,
        status: message.isError === true ? 'failed' : 'completed'
    };
}

/**
 * Reads the tool calls and tool results out of a transcript.
 *
 * Only the two kinds the background-task ledger needs are returned: the text
 * of the conversation is the hub's business, not this reader's.
 */
export function parseMcodeTranscriptToolMessages(text: string): AgentMessage[] {
    const messages: AgentMessage[] = [];
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: unknown;
        try {
            parsed = JSON.parse(trimmed);
        } catch {
            // The agent writes the transcript while it runs, so the last line
            // can be half-written. A line that does not parse is skipped.
            continue;
        }
        if (!isObject(parsed)) continue;
        const message = parsed.message;
        if (!isObject(message)) continue;

        const role = readString(message.role);
        if (role === 'assistant') {
            messages.push(...readToolCalls(message.content));
            continue;
        }
        if (role === 'toolResult') {
            const result = readToolResult(message);
            if (result) messages.push(result);
        }
    }
    return messages;
}

/**
 * Reads the tool calls of a session from the agent's own transcript.
 *
 * A transcript that is not there (or not readable yet) yields no messages:
 * the caller falls back to what it knows, which is an empty ledger rather
 * than a wrong one.
 */
export async function readMcodeTranscriptToolMessages(filePath: string): Promise<AgentMessage[]> {
    try {
        const text = await readFile(filePath, 'utf8');
        return parseMcodeTranscriptToolMessages(text);
    } catch (error) {
        logger.debug(`[mcode-transcript] No readable transcript at ${filePath}`, error);
        return [];
    }
}
