import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@/agent/types';
import {
    canonicalMcodeToolName,
    normalizeMcodeToolCall,
    normalizeSkillToolInput,
    normalizeTodoToolInput
} from './toolCallNormalizer';

function toolCall(overrides: Partial<Extract<AgentMessage, { type: 'tool_call' }>> = {}): Extract<AgentMessage, { type: 'tool_call' }> {
    return {
        type: 'tool_call',
        id: 'call-1',
        name: 'todowrite',
        input: {
            todos: [
                { content: 'Implement the parser', status: 'in_progress', priority: 'high' },
                { content: 'Add regression coverage', status: 'pending', priority: 'medium' }
            ]
        },
        status: 'completed',
        ...overrides
    };
}

function normalizedToolCall(overrides: Partial<Extract<AgentMessage, { type: 'tool_call' }>> = {}): Extract<AgentMessage, { type: 'tool_call' }> {
    const normalized = normalizeMcodeToolCall(toolCall(overrides));
    if (normalized.type !== 'tool_call') throw new Error('expected a tool_call');
    return normalized;
}

describe('canonicalMcodeToolName', () => {
    it('maps mcode native names to HAPI canonical names', () => {
        const expected: Array<[string, string]> = [
            ['read', 'Read'],
            ['write', 'Write'],
            ['edit', 'Edit'],
            ['bash', 'Bash'],
            ['glob', 'Glob'],
            ['grep', 'Grep'],
            ['web_fetch', 'WebFetch'],
            ['web-search', 'WebSearch'],
            ['skill', 'Skill'],
            ['task', 'Task'],
            ['todowrite', 'TodoWrite'],
            ['TodoWrite', 'TodoWrite'],
            ['TODO-WRITE', 'TodoWrite']
        ];

        for (const [input, canonical] of expected) {
            expect(canonicalMcodeToolName(input)).toBe(canonical);
        }
    });

    it('does not prefix-match task lifecycle tools', () => {
        expect(canonicalMcodeToolName('task_output')).toBeNull();
        expect(canonicalMcodeToolName('task_stop')).toBeNull();
        expect(canonicalMcodeToolName('task_query')).toBeNull();
        expect(canonicalMcodeToolName('task_append')).toBeNull();
    });

    it('leaves unrelated tools alone', () => {
        expect(canonicalMcodeToolName('browser_screenshot')).toBeNull();
        expect(canonicalMcodeToolName('memory')).toBeNull();
        expect(canonicalMcodeToolName('mcp__server__tool')).toBeNull();
    });
});

describe('normalizeMcodeToolCall aliases', () => {
    it('rewrites core mcode tools to the names the cards understand', () => {
        const cases: Array<[string, unknown, string]> = [
            ['read', { path: '/tmp/a.ts', offset: 1, limit: 20 }, 'Read'],
            ['write', { path: '/tmp/a.ts', content: 'x' }, 'Write'],
            ['edit', { file_path: '/tmp/a.ts', old_string: 'a', new_string: 'b' }, 'Edit'],
            ['bash', { command: 'ls', description: 'List files' }, 'Bash'],
            ['glob', { pattern: '**/*.ts', path: '/tmp' }, 'Glob'],
            ['grep', { pattern: 'foo', path: '/tmp' }, 'Grep'],
            ['web_fetch', { url: 'https://example.com' }, 'WebFetch'],
            ['web_search', { query: 'hapi' }, 'WebSearch'],
            ['task', { description: 'Review', prompt: 'Review the diff', subagent_type: 'reviewer' }, 'Task']
        ];

        for (const [name, input, canonical] of cases) {
            const normalized = normalizedToolCall({ name, input });
            expect(normalized.name).toBe(canonical);
            expect(normalized.input).toEqual(input);
        }
    });

    it('adds the skill field the Skill card reads', () => {
        const normalized = normalizedToolCall({ name: 'skill', input: { name: 'pdf' } });

        expect(normalized.name).toBe('Skill');
        expect(normalized.input).toEqual({ name: 'pdf', skill: 'pdf' });
    });

    it('keeps an existing skill field untouched', () => {
        const input = { name: 'pdf', skill: 'pdf' };
        const normalized = normalizedToolCall({ name: 'skill', input });

        expect(normalized.input).toEqual(input);
    });

    it('canonicalizes the todo payload and its lowercase name', () => {
        const normalized = normalizedToolCall();

        expect(normalized.name).toBe('TodoWrite');
        expect(normalized.input).toEqual({
            todos: [
                { content: 'Implement the parser', status: 'in_progress', priority: 'high' },
                { content: 'Add regression coverage', status: 'pending', priority: 'medium' }
            ]
        });
    });

    it('canonicalizes the todo name even before the payload arrives', () => {
        const normalized = normalizedToolCall({ input: null, status: 'pending' });

        expect(normalized.name).toBe('TodoWrite');
        expect(normalized.input).toBeNull();
    });

    it('leaves tool results and unknown tools untouched', () => {
        const result: AgentMessage = { type: 'tool_result', id: 'call-1', output: { ok: true }, status: 'completed' };
        expect(normalizeMcodeToolCall(result)).toBe(result);

        const unknown = toolCall({ name: 'browser_screenshot', input: { url: 'https://example.com' } });
        expect(normalizeMcodeToolCall(unknown)).toBe(unknown);
    });
});

describe('normalizeTodoToolInput', () => {
    it('maps cancelled entries to completed and defaults a missing priority', () => {
        expect(normalizeTodoToolInput({
            todos: [
                { content: 'Retired approach', status: 'cancelled', priority: 'low' },
                { content: 'Canceled spelling', status: 'canceled' },
                { content: 'Still open', status: 'pending' }
            ]
        })).toEqual({
            todos: [
                { content: 'Retired approach', status: 'completed', priority: 'low' },
                { content: 'Canceled spelling', status: 'completed', priority: 'medium' },
                { content: 'Still open', status: 'pending', priority: 'medium' }
            ]
        });
    });

    it('preserves ids and active labels', () => {
        expect(normalizeTodoToolInput({
            todos: [{
                id: 'todo-7',
                content: 'Check the diff',
                activeForm: 'Checking the diff',
                status: 'in_progress',
                priority: 'high'
            }]
        })).toEqual({
            todos: [{
                id: 'todo-7',
                content: 'Check the diff',
                activeForm: 'Checking the diff',
                status: 'in_progress',
                priority: 'high'
            }]
        });
    });

    it('drops malformed todo entries instead of failing the whole list', () => {
        expect(normalizeTodoToolInput({
            todos: [
                null,
                'not-an-entry',
                { content: '  ', status: 'pending' },
                { content: 'Valid entry', status: 'pending', priority: 'high' }
            ]
        })).toEqual({
            todos: [{ content: 'Valid entry', status: 'pending', priority: 'high' }]
        });
    });

    it('leaves a payload without a todos array unchanged', () => {
        const input = { note: 'not a todo list' };

        expect(normalizeTodoToolInput(input)).toBe(input);
        expect(normalizeTodoToolInput(null)).toBeNull();
    });

    it('keeps envelope fields outside todos', () => {
        expect(normalizeTodoToolInput({
            summary: 'Plan update',
            todos: [{ content: 'Ship it', status: 'pending', priority: 'high' }]
        })).toEqual({
            summary: 'Plan update',
            todos: [{ content: 'Ship it', status: 'pending', priority: 'high' }]
        });
    });
});

describe('normalizeSkillToolInput', () => {
    it('leaves non-object and unnamed payloads alone', () => {
        const input = { other: true };

        expect(normalizeSkillToolInput(null)).toBeNull();
        expect(normalizeSkillToolInput(input)).toBe(input);
        expect(normalizeSkillToolInput({ skill: '' })).toEqual({ skill: '' });
    });
});
