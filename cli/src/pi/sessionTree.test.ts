import { describe, expect, it } from 'vitest';
import { formatPiSessionTree } from './sessionTree';

describe('formatPiSessionTree', () => {
    it('renders an empty tree as an empty string', () => {
        expect(formatPiSessionTree({ tree: [] })).toBe('');
        expect(formatPiSessionTree({})).toBe('');
        expect(formatPiSessionTree(null)).toBe('');
    });

    it('renders nested entries as an indented tree', () => {
        const rendered = formatPiSessionTree({
            tree: [
                {
                    entry: { type: 'message', id: 'a1', message: { role: 'user', content: 'first question' } },
                    children: [
                        {
                            entry: { type: 'message', id: 'b2', message: { role: 'assistant', content: [{ type: 'text', text: 'the answer' }] } },
                            children: [],
                        },
                    ],
                },
            ],
            leafId: 'b2',
        });

        expect(rendered).toBe([
            'user: first question',
            '  └─ assistant: the answer ← current',
        ].join('\n'));
    });

    it('marks nothing when Pi reports no leaf', () => {
        const rendered = formatPiSessionTree({
            tree: [{ entry: { type: 'message', id: 'a1', message: { role: 'user', content: 'hi' } }, children: [] }],
        });
        expect(rendered).toBe('user: hi');
    });

    it('summarizes entries that carry no message', () => {
        expect(formatPiSessionTree({
            tree: [{ entry: { type: 'model_change', id: 'c1' }, children: [] }],
        })).toBe('model_change');
    });

    it('clips long entry text', () => {
        const rendered = formatPiSessionTree({
            tree: [{ entry: { type: 'message', id: 'a1', message: { role: 'user', content: 'x'.repeat(200) } }, children: [] }],
        });
        expect(rendered.length).toBeLessThan(120);
        expect(rendered.endsWith('…')).toBe(true);
    });

    it('collapses whitespace in the entry text', () => {
        expect(formatPiSessionTree({
            tree: [{ entry: { type: 'message', id: 'a1', message: { role: 'user', content: '  two\nlines  ' } }, children: [] }],
        })).toBe('user: two lines');
    });
});
