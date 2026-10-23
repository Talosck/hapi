import { describe, expect, it } from 'vitest';
import { renderMcodeDeliverables, splitMcodeDeliverables } from './mcodeDeliverables';

/**
 * The block a MiniMax Code agent writes when it hands files over. The
 * MiniMax Code apps render it; HAPI's clients do not know it.
 */
const BLOCK = [
    '<deliver-assets>',
    '  <media type="text" src="/home/talos/coding/hapi/report.md" title="report.md" />',
    '  <media type="image" src="/home/talos/coding/hapi/chart.png" />',
    '</deliver-assets>'
].join('\n');

describe('splitMcodeDeliverables', () => {
    it('takes the delivery block out of the answer', () => {
        const split = splitMcodeDeliverables(`Here is the report.\n\n${BLOCK}`);

        expect(split.text.trim()).toBe('Here is the report.');
        expect(split.deliverables).toEqual([
            { path: '/home/talos/coding/hapi/report.md', title: 'report.md', kind: 'text' },
            { path: '/home/talos/coding/hapi/chart.png', title: null, kind: 'image' }
        ]);
    });

    it('leaves an answer without a delivery block alone', () => {
        const text = 'Nothing to deliver here.';

        expect(splitMcodeDeliverables(text)).toEqual({ text, deliverables: [] });
    });

    it('keeps a block that names no file, because the agent was talking about it', () => {
        // The agent may explain the markup to a user who asks about it.
        const text = `The tag <deliver-assets></deliver-assets> means a delivery.`;

        expect(splitMcodeDeliverables(text).text).toBe(text);
        expect(splitMcodeDeliverables(text).deliverables).toEqual([]);
    });

    it('keeps a block that is never closed', () => {
        const text = 'Broken <deliver-assets> <media type="text" src="/tmp/a.md" />';

        expect(splitMcodeDeliverables(text).text).toBe(text);
        expect(splitMcodeDeliverables(text).deliverables).toEqual([]);
    });

    it('reads a path in either quoting style', () => {
        const split = splitMcodeDeliverables(
            `<deliver-assets><media type='text' src='/tmp/b.md' title='b.md' /></deliver-assets>`
        );

        expect(split.deliverables).toEqual([
            { path: '/tmp/b.md', title: 'b.md', kind: 'text' }
        ]);
    });

    it('skips an entry without a path', () => {
        const split = splitMcodeDeliverables(
            '<deliver-assets><media type="text" title="no path" /><media type="text" src="/tmp/c.md" /></deliver-assets>'
        );

        expect(split.deliverables.map((deliverable) => deliverable.path)).toEqual(['/tmp/c.md']);
    });

    it('keeps the text that follows the block', () => {
        const split = splitMcodeDeliverables(`Before.\n${BLOCK}\nAfter.`);

        expect(split.text).toContain('Before.');
        expect(split.text).toContain('After.');
        expect(split.text).not.toContain('deliver-assets');
    });
});

describe('renderMcodeDeliverables', () => {
    it('gives the path the way the clients expect a file citation', () => {
        // The web app and the native apps link a path that is relative to the
        // session's working directory; an absolute path is not linked.
        expect(renderMcodeDeliverables([
            { path: '/home/talos/coding/hapi/report.md', title: 'report.md', kind: 'text' }
        ], '/home/talos/coding/hapi')).toBe('Delivered: `report.md`');
    });

    it('keeps the path of a file in a subdirectory', () => {
        expect(renderMcodeDeliverables([
            { path: '/home/talos/coding/hapi/docs/report.md', title: null, kind: 'text' }
        ], '/home/talos/coding/hapi')).toBe('Delivered: `docs/report.md`');
    });

    it('lists several files', () => {
        expect(renderMcodeDeliverables([
            { path: '/home/talos/coding/hapi/a.md', title: null, kind: 'text' },
            { path: '/home/talos/coding/hapi/b.png', title: null, kind: 'image' }
        ], '/home/talos/coding/hapi')).toBe('Delivered: `a.md`, `b.png`');
    });

    it('leaves a file outside the working directory as its path', () => {
        // The viewer cannot open it, so a link would only be a dead one.
        expect(renderMcodeDeliverables([
            { path: '/etc/hosts', title: null, kind: 'text' }
        ], '/home/talos/coding/hapi')).toBe('Delivered: `/etc/hosts`');
    });
});
