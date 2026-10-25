import { describe, expect, it } from 'vitest';
import { PiMessageAccumulator } from './piMessageAccumulator';

const event = (type: string, extra: Record<string, unknown> = {}) => ({ type, ...extra });

const textDelta = (delta: string) => event('message_update', {
    assistantMessageEvent: { type: 'text_delta', delta },
});

/**
 * The snapshot policy: a snapshot goes out when the text grew by
 * `snapshotStepChars` since the last one, or when `snapshotIntervalMs` elapsed
 * since the last one — whichever comes first.
 *
 * The step is the main path: every snapshot re-sends the whole text so far,
 * so the number of snapshots decides the total volume. The elapsed time is
 * only the safety net, so a slow stream still shows progress.
 */
describe('PiMessageAccumulator snapshot pacing', () => {
    it('holds the snapshot back until the text grew by the step size', () => {
        let now = 0;
        const accumulator = new PiMessageAccumulator({
            now: () => now,
            streamNonceFactory: () => 'nonce',
            snapshotStepChars: 100,
            snapshotIntervalMs: 1000,
        });
        accumulator.handleEvent(event('message_start'));

        // The first delta is the first snapshot of the message: there is
        // nothing to compare against yet, so it goes out immediately.
        expect(accumulator.handleEvent(textDelta('a'.repeat(10)))).toHaveLength(1);

        // Well below the step, and below the elapsed cap: nothing is sent.
        now = 100;
        expect(accumulator.handleEvent(textDelta('b'.repeat(10)))).toEqual([]);
        now = 200;
        expect(accumulator.handleEvent(textDelta('c'.repeat(10)))).toEqual([]);

        // The step size is reached: the snapshot goes out with the full text.
        now = 300;
        const snapshots = accumulator.handleEvent(textDelta('d'.repeat(80)));
        expect(snapshots).toHaveLength(1);
        expect(snapshots[0]).toMatchObject({ type: 'text', live: true });
        expect((snapshots[0] as { text: string }).text).toHaveLength(110);
    });

    it('sends a snapshot when the elapsed time cap is reached even below the step', () => {
        let now = 0;
        const accumulator = new PiMessageAccumulator({
            now: () => now,
            streamNonceFactory: () => 'nonce',
            snapshotStepChars: 100_000,
            snapshotIntervalMs: 1000,
        });
        accumulator.handleEvent(event('message_start'));
        expect(accumulator.handleEvent(textDelta('a'))).toHaveLength(1);

        // Below the step, but a second has passed: the user still sees progress.
        now = 1000;
        expect(accumulator.handleEvent(textDelta('b'))).toHaveLength(1);
    });

    it('does not send a snapshot when neither the step nor the time cap is reached', () => {
        let now = 0;
        const accumulator = new PiMessageAccumulator({
            now: () => now,
            streamNonceFactory: () => 'nonce',
            snapshotStepChars: 100,
            snapshotIntervalMs: 1000,
        });
        accumulator.handleEvent(event('message_start'));
        expect(accumulator.handleEvent(textDelta('a'.repeat(50)))).toHaveLength(1);

        now = 500;
        expect(accumulator.handleEvent(textDelta('b'.repeat(10)))).toEqual([]);
    });

    it('measures the step from the last snapshot, not from the start of the message', () => {
        let now = 0;
        const accumulator = new PiMessageAccumulator({
            now: () => now,
            streamNonceFactory: () => 'nonce',
            snapshotStepChars: 100,
            snapshotIntervalMs: 100_000,
        });
        accumulator.handleEvent(event('message_start'));

        // Two snapshots of 100 chars each: the second one is sent because it
        // grew by 100 since the first, not because it grew by 200 since the
        // start of the message.
        expect(accumulator.handleEvent(textDelta('a'.repeat(100)))).toHaveLength(1);
        now = 10;
        expect(accumulator.handleEvent(textDelta('b'.repeat(100)))).toHaveLength(1);
        // Only 50 chars since the last snapshot: held back.
        now = 20;
        expect(accumulator.handleEvent(textDelta('c'.repeat(50)))).toEqual([]);
    });

    it('keeps the final settled text intact after a paced snapshot', () => {
        let now = 0;
        const accumulator = new PiMessageAccumulator({
            now: () => now,
            streamNonceFactory: () => 'nonce',
            snapshotStepChars: 1000,
            snapshotIntervalMs: 1000,
        });
        accumulator.handleEvent(event('message_start'));
        accumulator.handleEvent(textDelta('hello'));

        now = 100;
        accumulator.handleEvent(textDelta(' world'));

        // The boundary always emits the full text, whether or not a live
        // snapshot was sent in between.
        const final = accumulator.handleEvent(event('message_end'));
        expect(final).toEqual([{
            type: 'text',
            text: 'hello world',
            id: 'pi-nonce-turn-0-message-1-text-0',
            streamSnapshot: true,
        }]);
    });

    it('emits the first snapshot of a message even when the step is not reached', () => {
        let now = 0;
        const accumulator = new PiMessageAccumulator({
            now: () => now,
            streamNonceFactory: () => 'nonce',
            snapshotStepChars: 100_000,
            snapshotIntervalMs: 100_000,
        });
        accumulator.handleEvent(event('message_start'));

        // Without this, a short answer would never appear until its boundary.
        const first = accumulator.handleEvent(textDelta('short'));
        expect(first).toHaveLength(1);
        expect(first[0]).toMatchObject({ type: 'text', text: 'short', live: true });
    });
});
