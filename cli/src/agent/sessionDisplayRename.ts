import type { ApiSessionClient } from '@/api/apiSession';
import type { Metadata } from '@/api/types';

type SessionDisplayRenameClient = Pick<ApiSessionClient, 'updateMetadata'>;

/** A client that can also be asked what the session looks like right now. */
type SessionTitleReaderClient = Pick<ApiSessionClient, 'updateMetadata' | 'getMetadata'>;

/**
 * Explicit agent/operator rename: set metadata.name (same field as web
 * renameSession / PATCH /sessions/:id). Distinct from native/generated
 * summaries, which must not overwrite an intentional name.
 */
export function normalizeSessionDisplayTitle(title: unknown): string | null {
    if (typeof title !== 'string') {
        return null;
    }
    const normalized = title.replace(/\s+/g, ' ').trim();
    return normalized.length > 0 ? normalized : null;
}

export function applySessionDisplayRename(
    client: SessionDisplayRenameClient,
    title: unknown
): boolean {
    const normalized = normalizeSessionDisplayTitle(title);
    if (!normalized) {
        return false;
    }

    client.updateMetadata((metadata: Metadata) => {
        if (metadata.name?.trim() === normalized) {
            return metadata;
        }
        return {
            ...metadata,
            name: normalized
        };
    });
    return true;
}

/** Whether the session already carries a title, by hand or by the agent. */
export function hasSessionTitle(metadata: Readonly<Metadata> | null | undefined): boolean {
    if (!metadata) {
        return false;
    }
    return Boolean(metadata.name?.trim() || metadata.summary?.text?.trim());
}

/**
 * A title the model offers while the title of the agent is still on its way.
 *
 * MiniMax Code publishes the title it derives from a turn at the end of that
 * turn, so a new chat needs a name before then. The placeholder goes into the
 * summary - the slot the agent's own title uses - so that title replaces it
 * instead of losing to it, while a name the user picked by hand still wins
 * over both.
 *
 * A session that already carries a title keeps it: this fills a gap, it does
 * not rename.
 */
export function applySessionPlaceholderTitle(
    client: SessionTitleReaderClient,
    title: unknown
): { applied: boolean; reason?: 'empty' | 'titled' } {
    const normalized = normalizeSessionDisplayTitle(title);
    if (!normalized) {
        return { applied: false, reason: 'empty' };
    }
    if (hasSessionTitle(client.getMetadata())) {
        return { applied: false, reason: 'titled' };
    }

    client.updateMetadata((metadata: Metadata) => {
        // The agent may have published its own title while the update waited
        // for the lock. That title is the real one, so it stays.
        if (hasSessionTitle(metadata)) {
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
