import { describe, expect, it } from 'vitest';
import { McodeDisplayedMessageIds } from './mcodeDisplayedMessageIds';

describe('McodeDisplayedMessageIds', () => {
    it('does not call a message shown before', () => {
        const ids = new McodeDisplayedMessageIds();
        expect(ids.areAllShown(['local-1'])).toBe(false);
        ids.remember(['local-1']);
        expect(ids.areAllShown(['local-1'])).toBe(true);
    });

    it('treats a message without a local id as nothing to de-duplicate', () => {
        // The caller has nothing to remember, so an empty list must not be
        // read as "already shown" - that would hide the message.
        const ids = new McodeDisplayedMessageIds();
        expect(ids.areAllShown([])).toBe(false);
    });

    it('shows a batch again when only some of its messages were shown', () => {
        const ids = new McodeDisplayedMessageIds();
        ids.remember(['local-1']);
        expect(ids.areAllShown(['local-1', 'local-2'])).toBe(false);
    });

    it('forgets the ids of the messages the agent has taken', () => {
        // The message is the agent's from here: it is never shown again, so
        // the id does not have to be remembered for the rest of the session.
        const ids = new McodeDisplayedMessageIds();
        ids.remember(['local-1', 'local-2']);
        ids.forget(['local-1']);
        expect(ids.areAllShown(['local-1'])).toBe(false);
        expect(ids.areAllShown(['local-2'])).toBe(true);
    });

    it('does not grow without bound as the session runs', () => {
        // Every message the agent took is forgotten, so a session that runs
        // for hours holds no id of a message that is already delivered.
        const ids = new McodeDisplayedMessageIds();
        for (let index = 0; index < 1000; index += 1) {
            const localId = `local-${index}`;
            ids.remember([localId]);
            ids.forget([localId]);
        }
        expect(ids.size).toBe(0);
    });

    it('keeps the ids of a message that is still waiting to be delivered', () => {
        // A message the agent refused goes back into the queue with the same
        // id. It must still be remembered, or the retry would show it twice.
        const ids = new McodeDisplayedMessageIds();
        ids.remember(['local-1']);
        expect(ids.areAllShown(['local-1'])).toBe(true);
        expect(ids.size).toBe(1);
    });
});
