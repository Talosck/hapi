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
            '```',
            'user: first question',
            '  └─ assistant: the answer ← current',
            '```',
        ].join('\n'));
    });

    it('marks nothing when Pi reports no leaf', () => {
        const rendered = formatPiSessionTree({
            tree: [{ entry: { type: 'message', id: 'a1', message: { role: 'user', content: 'hi' } }, children: [] }],
        });
        expect(rendered).toBe('```\nuser: hi\n```');
    });

    it('summarizes entries that carry no message', () => {
        expect(formatPiSessionTree({
            tree: [{ entry: { type: 'model_change', id: 'c1' }, children: [] }],
        })).toBe('```\nmodel_change\n```');
    });

    it('clips long entry text', () => {
        const rendered = formatPiSessionTree({
            tree: [{ entry: { type: 'message', id: 'a1', message: { role: 'user', content: 'x'.repeat(200) } }, children: [] }],
        });
        expect(rendered.length).toBeLessThan(120);
        expect(rendered).toContain('…');
    });

    it('collapses whitespace in the entry text', () => {
        expect(formatPiSessionTree({
            tree: [{ entry: { type: 'message', id: 'a1', message: { role: 'user', content: '  two\nlines  ' } }, children: [] }],
        })).toBe('```\nuser: two lines\n```');
    });

    it('does not split a surrogate pair when it clips', () => {
        const rendered = formatPiSessionTree({
            tree: [{ entry: { type: 'message', id: 'a1', message: { role: 'user', content: '🙂'.repeat(80) } }, children: [] }],
        });
        // A lone surrogate would reach the payload as an invalid code unit.
        const loneHigh = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(rendered);
        const loneLow = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(rendered);
        expect(loneHigh).toBe(false);
        expect(loneLow).toBe(false);
    });

    it('fences the tree so markdown in it cannot render', () => {
        const rendered = formatPiSessionTree({
            tree: [{ entry: { type: 'message', id: 'a1', message: { role: 'user', content: '![x](https://example.test/pixel.png)' } }, children: [] }],
        });
        // The web renders chat messages as markdown, and the tree carries the
        // user's own earlier messages — a remote image in one of them must
        // not become a live fetch.
        expect(rendered.startsWith('```\n')).toBe(true);
        expect(rendered.endsWith('\n```')).toBe(true);
    });

    it('survives a branch chain that is thousands of entries deep', () => {
        let node: { entry: { type: string; id: string }; children: unknown[] } = {
            entry: { type: 'message', id: 'leaf' },
            children: [],
        };
        for (let index = 0; index < 20_000; index++) {
            node = { entry: { type: 'message', id: `e${index}` }, children: [node] };
        }
        const rendered = formatPiSessionTree({ tree: [node], leafId: 'leaf' });
        expect(rendered.length).toBeGreaterThan(0);
    });

    it('caps the number of rendered entries', () => {
        const tree = Array.from({ length: 500 }, (_, index) => ({
            entry: { type: 'message', id: `e${index}`, message: { role: 'user', content: `m${index}` } },
            children: [],
        }));
        const rendered = formatPiSessionTree({ tree });
        expect(rendered).toContain('more were not rendered');
    });
});
