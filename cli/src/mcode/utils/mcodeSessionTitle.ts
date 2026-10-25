import type { ApiSessionClient } from '@/api/apiSession';
import type { Metadata } from '@/api/types';

type SessionTitleClient = Pick<ApiSessionClient, 'getMetadata' | 'updateMetadata'>;

/**
 * Longest title HAPI stores for a session.
 *
 * The hub's own title suggestion caps at the same length, so a title taken
 * from the user's first message is not allowed to be longer.
 */
const SESSION_TITLE_MAX_LENGTH = 80;

/**
 * The title of a session that has not been named yet: the text of the user's
 * first message.
 *
 * MiniMax Code names a session itself, at the end of the turn it derives the
 * name from. Until that arrives the chat would show no title at all - the
 * folder name of the project, which says nothing about the task. Asking the
 * model for a title through the `change_title` tool was the old answer, but
 * it spent a model round on a name the user already wrote: the first message
 * IS the title, and it is there before the agent has read anything.
 *
 * The title goes into the summary - the slot the title of the agent uses - so
 * that the title the agent publishes replaces it. A name the user picked by
 * hand stays in `name`, which the web prefers over the summary, so a manual
 * rename still wins over both.
 */
export function normalizeFirstMessageTitle(text: unknown): string | null {
    if (typeof text !== 'string') {
        return null;
    }
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) {
        return null;
    }
    return normalized.slice(0, SESSION_TITLE_MAX_LENGTH).trim() || null;
}

/**
 * Whether the session already carries a title, by hand or by the agent.
 */
function metadataHasTitle(metadata: Readonly<Metadata> | null | undefined): boolean {
    return Boolean(metadata?.name?.trim() || metadata?.summary?.text?.trim());
}

/**
 * Names a session after the text of the user's first message.
 *
 * Only the first message names the session: a later one is a follow-up, and
 * the title of the session is what the first request was about. A session
 * that already carries a title keeps it - the agent may have published its
 * own before the first message reached this process.
 */
export function applyFirstMessageTitle(
    client: SessionTitleClient,
    text: unknown
): { applied: boolean; reason?: 'empty' | 'titled' } {
    const normalized = normalizeFirstMessageTitle(text);
    if (!normalized) {
        return { applied: false, reason: 'empty' };
    }
    if (metadataHasTitle(client.getMetadata())) {
        return { applied: false, reason: 'titled' };
    }

    client.updateMetadata((metadata: Metadata) => {
        // The agent may have published its own title while the update waited
        // for the lock. That title is the real one, so it stays.
        if (metadataHasTitle(metadata)) {
            return metadata;
        }
        return {
            ...metadata,
            summary: {
                text: normalized,
                updatedAt: Date.now()
            }
        };
    });
    return { applied: true };
}

/**
 * Names a session after the text of its first message, once.
 *
 * The session is named by the first message it receives, so the caller can
 * hand every message to this and only the first one names the chat. A
 * message that arrives after the agent published a title of its own does not
 * rename it.
 */
export function createFirstMessageTitleSync(
    client: SessionTitleClient
): (text: unknown) => void {
    let named = false;

    return (text) => {
        if (named) {
            return;
        }
        const result = applyFirstMessageTitle(client, text);
        if (result.applied) {
            named = true;
        }
    };
}
