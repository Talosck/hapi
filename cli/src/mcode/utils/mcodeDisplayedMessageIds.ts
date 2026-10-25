/**
 * The local ids of the messages the display has already shown.
 *
 * A message the agent refused goes back into the queue with the local id it
 * had, and the loop takes it out again on the next attempt. The display must
 * not show the message a second time: the user already read it, and a
 * repeated line says the message was sent twice.
 *
 * The ids are only needed between the moment a message is shown and the
 * moment it is handed over to the agent. A session that runs for hours would
 * otherwise hold one id per message for its whole life, so the ids of the
 * messages the agent has taken are dropped as soon as they are handed over.
 */
export class McodeDisplayedMessageIds {
    private readonly shown = new Set<string>();

    /**
     * Whether every one of the ids was already shown.
     *
     * An empty list is not "already shown": the caller has nothing to
     * de-duplicate, and a message without a local id has no id to remember.
     */
    public areAllShown(localIds: string[]): boolean {
        if (localIds.length === 0) return false;
        return localIds.every((localId) => this.shown.has(localId));
    }

    /** Remembers that the ids were shown. */
    public remember(localIds: string[]): void {
        for (const localId of localIds) {
            this.shown.add(localId);
        }
    }

    /**
     * Forgets the ids of the messages the agent has taken.
     *
     * The message is the agent's from here, so it is never shown again and
     * the id does not have to be remembered.
     */
    public forget(localIds: string[]): void {
        for (const localId of localIds) {
            this.shown.delete(localId);
        }
    }

    /** How many ids are remembered. Only the tests look at this. */
    public get size(): number {
        return this.shown.size;
    }
}
