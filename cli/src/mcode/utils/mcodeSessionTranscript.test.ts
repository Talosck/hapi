import { describe, expect, it } from 'vitest';
import { parseMcodeTranscriptToolMessages } from './mcodeSessionTranscript';
import type { AgentMessage } from '@/agent/types';

/** The id of every message, for the ones that carry one. */
function idsOf(messages: AgentMessage[]): Array<string | undefined> {
    return messages.map((message) => ('id' in message ? message.id : undefined));
}

/**
 * The transcript is the agent's own file, so the reader is written against
 * what the agent actually writes: one JSON object per line, with the message
 * under `message`, tool calls as `toolCall` blocks of an assistant message
 * and tool results as messages of their own.
 */
function line(message: unknown): string {
    return JSON.stringify({ message_id: 'm1', turn_id: 't1', message });
}

describe('parseMcodeTranscriptToolMessages', () => {
    it('reads the tool calls of an assistant message', () => {
        const messages = parseMcodeTranscriptToolMessages([
            line({
                role: 'assistant',
                content: [
                    { type: 'text', text: 'Running it now.' },
                    {
                        type: 'toolCall',
                        id: 'call-1',
                        name: 'bash',
                        arguments: { command: 'npm run dev', run_in_background: true }
                    }
                ]
            })
        ].join('\n'));

        expect(messages).toEqual([
            {
                type: 'tool_call',
                id: 'call-1',
                name: 'bash',
                input: { command: 'npm run dev', run_in_background: true },
                status: 'completed'
            }
        ]);
    });

    it('reads every tool call of a message that runs several of them', () => {
        const messages = parseMcodeTranscriptToolMessages([
            line({
                role: 'assistant',
                content: [
                    { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'a' } },
                    { type: 'toolCall', id: 'call-2', name: 'read', arguments: { path: '/tmp/x' } }
                ]
            })
        ].join('\n'));

        expect(idsOf(messages)).toEqual(['call-1', 'call-2']);
    });

    it('keeps the raw output of a tool result', () => {
        const messages = parseMcodeTranscriptToolMessages([
            line({
                role: 'toolResult',
                toolCallId: 'call-1',
                toolName: 'bash',
                content: [{ type: 'text', text: '<bash_background task_id="bg_1">Started.</bash_background>' }],
                details: { task_id: 'bg_1', status: 'started' }
            })
        ].join('\n'));

        expect(messages).toEqual([
            {
                type: 'tool_result',
                id: 'call-1',
                output: {
                    content: [{ type: 'text', text: '<bash_background task_id="bg_1">Started.</bash_background>' }],
                    details: { task_id: 'bg_1', status: 'started' }
                },
                status: 'completed'
            }
        ]);
    });

    it('marks a failed tool result as failed', () => {
        const messages = parseMcodeTranscriptToolMessages([
            line({
                role: 'toolResult',
                toolCallId: 'call-1',
                toolName: 'bash',
                content: [{ type: 'text', text: 'boom' }],
                isError: true
            })
        ].join('\n'));

        expect(messages[0]).toMatchObject({ type: 'tool_result', status: 'failed' });
    });

    it('keeps the order of the calls and their results', () => {
        const messages = parseMcodeTranscriptToolMessages([
            line({
                role: 'assistant',
                content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: {} }]
            }),
            line({
                role: 'toolResult',
                toolCallId: 'call-1',
                toolName: 'bash',
                content: [{ type: 'text', text: 'done' }]
            })
        ].join('\n'));

        expect(messages.map((message) => message.type)).toEqual(['tool_call', 'tool_result']);
    });

    it('ignores the text of the conversation', () => {
        const messages = parseMcodeTranscriptToolMessages([
            line({ role: 'user', content: [{ type: 'text', text: 'hello' }] }),
            line({ role: 'assistant', content: [{ type: 'text', text: 'hi' }] })
        ].join('\n'));

        expect(messages).toEqual([]);
    });

    it('skips a line the agent has not finished writing', () => {
        const messages = parseMcodeTranscriptToolMessages([
            line({
                role: 'assistant',
                content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: {} }]
            }),
            '{"message_id":"m2","message":{"role":"assistant","content":[{"type":"toolC'
        ].join('\n'));

        expect(idsOf(messages)).toEqual(['call-1']);
    });

    it('skips a block it cannot understand instead of guessing', () => {
        const messages = parseMcodeTranscriptToolMessages([
            line({
                role: 'assistant',
                content: [
                    { type: 'toolCall', name: 'bash', arguments: {} },
                    { type: 'toolCall', id: 'call-2', arguments: {} },
                    { type: 'somethingNew', id: 'call-3', name: 'bash' }
                ]
            })
        ].join('\n'));

        expect(messages).toEqual([]);
    });

    it('reads nothing from an empty transcript', () => {
        expect(parseMcodeTranscriptToolMessages('')).toEqual([]);
    });
});
